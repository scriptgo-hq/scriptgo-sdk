/*
 * libscriptgo: asset escrow, `scriptgo-asset-escrow/1` (docs/spec/assets.md, "Asset escrow").
 *
 * The container reader every client hook needs (the checks before a key, then random-access reads
 * that decrypt only the chunks a range covers) and the two key steps around it (unwrap, and the
 * licensed server's re-wrap to a player's session). The reference implementation is
 * packages/escrow/src/asset-escrow.ts; tests/test_asset.c holds both to the same vector.
 *
 * Cryptography is libsodium only: crypto_aead_aes256gcm, crypto_scalarmult (X25519),
 * crypto_kdf_hkdf_sha256, crypto_sign_verify_detached (ed25519), crypto_hash_sha256. What is
 * written here is parsing (the header is canonical JSON) and bookkeeping.
 *
 * Every secret (the content key, the X25519 shared secret, HKDF output, a decrypted chunk) lives in
 * sodium_malloc memory, wiped on free. A decrypted range leaves this library in the caller's buffer:
 * that is what a client hook is for, and escrow.h says so where the call is declared.
 */
#include <stdlib.h>
#include <string.h>

#include <sodium.h>

#include "internal.h"

#define SG_ASSET_KEY_MAGIC 0x5347414bu       /* "SGAK" */
#define SG_ASSET_CONTAINER_MAGIC 0x53474143u /* "SGAC" */
#define SG_ASSET_READER_MAGIC 0x53474152u    /* "SGAR" */
#define PREAMBLE_BYTES 12u
#define NONCE_PREFIX_BYTES 8u
#define KEY_ID_RAW_BYTES 16u
#define MAX_DEPTH 8

static const char FORMAT[] = "scriptgo-asset-escrow/1";
static const char CIPHER[] = "AES-256-GCM-STREAM";
static const char KDF[] = "HKDF-SHA256+X25519";
static const char SERVER_WRAP_INFO[] = "scriptgo.escrow.keywrap.v1";
static const char CLIENT_WRAP_INFO[] = "scriptgo.asset-escrow.client-keywrap.v1";
static const char KEY_ID_LABEL[] = "scriptgo.asset-escrow.keyid.v1";
static const uint8_t EMPTY_AAD[1] = { 0 };

struct sg_asset_key {
    uint32_t magic;
    uint8_t* key; /* sodium_malloc(32), read-only */
    char id[SG_ASSET_KEY_ID_CHARS + 1];
};

typedef struct asset_file {
    char* path;
    uint64_t bytes;
    uint64_t chunks;
    uint64_t offset; /* relative to the body */
    uint64_t length;
    uint8_t nonce_prefix[NONCE_PREFIX_BYTES];
    uint8_t sha256[crypto_hash_sha256_BYTES];
} asset_file;

enum { F_PACKAGE, F_VERSION, F_RELEASE, F_DEPLOYMENT, F_KEY_ID, F_SIGNER, F_FINGERPRINT, F_COUNT };
static const char* const FIELD_NAMES[F_COUNT] = { "package", "version", "release", "deployment", "keyId", "signerPublicKey", "fingerprint" };

struct sg_asset_container {
    uint32_t magic;
    const uint8_t* body;
    size_t body_len;
    uint64_t chunk_bytes;
    char* fields[F_COUNT]; /* fingerprint may be NULL (JSON null) */
    asset_file* files;     /* header order (path order) */
    size_t count;
    size_t* by_path;       /* indices sorted by strcmp, for lookup */
    uint8_t* key;          /* sodium_malloc(32), NULL until bound */
};

struct sg_asset_reader {
    uint32_t magic;
    const sg_asset_container* container;
    uint8_t* plain;        /* sodium_malloc(chunk_bytes): the cached decrypted chunk */
    const asset_file* cached_file;
    uint64_t cached_index;
    size_t cached_len;
    int has_cache;
};

/* ------------------------------------------------------------------------------------------ helpers */

static int ensure_ready(void)
{
    return sg_init(); /* includes SG_ERR_NO_AES */
}

static void key_id_of(const uint8_t key[SG_ASSET_KEY_BYTES], char out[SG_ASSET_KEY_ID_CHARS + 1])
{
    crypto_hash_sha256_state st;
    uint8_t digest[crypto_hash_sha256_BYTES];
    crypto_hash_sha256_init(&st);
    crypto_hash_sha256_update(&st, (const uint8_t*)KEY_ID_LABEL, sizeof KEY_ID_LABEL - 1);
    crypto_hash_sha256_update(&st, key, SG_ASSET_KEY_BYTES);
    crypto_hash_sha256_final(&st, digest);
    sodium_bin2base64(out, SG_ASSET_KEY_ID_CHARS + 1, digest, KEY_ID_RAW_BYTES, sodium_base64_VARIANT_URLSAFE_NO_PADDING);
    sodium_memzero(&st, sizeof st);
    sodium_memzero(digest, sizeof digest);
}

/* base64url without padding, exact decoded length required. */
static int b64url_exact(const char* text, uint8_t* out, size_t expected)
{
    size_t got = 0;
    const char* end = NULL;
    if (text == NULL) return 0;
    if (sodium_base642bin(out, expected, text, strlen(text), NULL, &got, &end, sodium_base64_VARIANT_URLSAFE_NO_PADDING) != 0) return 0;
    return got == expected && end != NULL && *end == '\0';
}

static int hex_exact(const char* text, uint8_t* out, size_t expected)
{
    size_t got = 0;
    const char* end = NULL;
    size_t i;
    if (text == NULL || strlen(text) != expected * 2) return 0;
    for (i = 0; text[i] != '\0'; i++) {
        char c = text[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0; /* lower case, as the sealer writes it */
    }
    if (sodium_hex2bin(out, expected, text, expected * 2, NULL, &got, &end) != 0) return 0;
    return got == expected;
}

/* ------------------------------------------------------------------------------- canonical JSON */
/*
 * The header must be exactly what canonicalJson (JSON.stringify of the value with keys sorted at
 * every level) writes: no whitespace, keys in strictly increasing order, strings with only the
 * escapes JSON.stringify produces, integers without sign, fraction or exponent. Accepting nothing
 * else means the bytes the signature covers are the bytes that were parsed, and the signed message
 * is the header with the top-level "signature" value emptied, byte for byte.
 */

typedef struct jp {
    const uint8_t* s;
    size_t n;
    size_t i;
} jp;

static int jp_peek(const jp* p) { return p->i < p->n ? p->s[p->i] : -1; }

static int jp_lit(jp* p, const char* lit)
{
    size_t k = strlen(lit);
    if (p->n - p->i < k || memcmp(p->s + p->i, lit, k) != 0) return 0;
    p->i += k;
    return 1;
}

/* One well-formed UTF-8 sequence starting at p->i (not ASCII). */
static int jp_utf8(jp* p)
{
    const uint8_t* s = p->s + p->i;
    size_t left = p->n - p->i;
    uint32_t c;
    size_t need, k;
    if (s[0] >= 0xc2 && s[0] <= 0xdf) { need = 1; c = s[0] & 0x1f; }
    else if (s[0] >= 0xe0 && s[0] <= 0xef) { need = 2; c = s[0] & 0x0f; }
    else if (s[0] >= 0xf0 && s[0] <= 0xf4) { need = 3; c = s[0] & 0x07; }
    else return 0;
    if (left < need + 1) return 0;
    for (k = 1; k <= need; k++) {
        if ((s[k] & 0xc0) != 0x80) return 0;
        c = (c << 6) | (s[k] & 0x3f);
    }
    if ((need == 2 && c < 0x800) || (need == 3 && (c < 0x10000 || c > 0x10ffff)) || (c >= 0xd800 && c <= 0xdfff)) return 0;
    p->i += need + 1;
    return 1;
}

static int hexval(uint8_t c) { return c >= '0' && c <= '9' ? c - '0' : (c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1); }

/*
 * A canonical string. `out` (optional) receives the decoded UTF-8 text, malloc'd, NUL-terminated;
 * a string holding a NUL is refused when it is decoded (no header field may hold one).
 * [*value_start, *value_end) is the content between the quotes.
 */
static int jp_string(jp* p, char** out, size_t* value_start, size_t* value_end)
{
    size_t start, len = 0, cap;
    char* buf = NULL;
    if (jp_peek(p) != '"') return 0;
    p->i++;
    start = p->i;
    cap = 0;
    if (out != NULL) {
        /* The decoded text is never longer than the encoded text. */
        size_t j = p->i;
        while (j < p->n && p->s[j] != '"') j += (p->s[j] == '\\') ? 2 : 1;
        cap = (j > p->i ? j - p->i : 0) + 1;
        buf = (char*)malloc(cap);
        if (buf == NULL) return 0;
    }
    for (;;) {
        int c = jp_peek(p);
        if (c < 0) goto bad;
        if (c == '"') break;
        if (c < 0x20) goto bad;
        if (c == '\\') {
            int e;
            p->i++;
            e = jp_peek(p);
            if (e < 0) goto bad;
            p->i++;
            switch (e) {
            case '"': if (buf) buf[len++] = '"'; break;
            case '\\': if (buf) buf[len++] = '\\'; break;
            case 'b': if (buf) buf[len++] = '\b'; break;
            case 'f': if (buf) buf[len++] = '\f'; break;
            case 'n': if (buf) buf[len++] = '\n'; break;
            case 'r': if (buf) buf[len++] = '\r'; break;
            case 't': if (buf) buf[len++] = '\t'; break;
            case 'u': {
                /* JSON.stringify writes \u00XX (lower-case hex) for the other control characters only. */
                int h0, h1;
                if (p->n - p->i < 4 || p->s[p->i] != '0' || p->s[p->i + 1] != '0') goto bad;
                h0 = hexval(p->s[p->i + 2]);
                h1 = hexval(p->s[p->i + 3]);
                if (h0 < 0 || h1 < 0) goto bad;
                c = h0 * 16 + h1;
                if (c >= 0x20 || c == '\b' || c == '\f' || c == '\n' || c == '\r' || c == '\t' || (c == 0 && buf)) goto bad;
                if (buf) buf[len++] = (char)c;
                p->i += 4;
                break;
            }
            default: goto bad; /* \/ and every other escape are not what JSON.stringify writes */
            }
            continue;
        }
        if (c < 0x80) {
            if (buf) buf[len++] = (char)c;
            p->i++;
            continue;
        }
        {
            size_t before = p->i;
            if (!jp_utf8(p)) goto bad;
            if (buf) {
                memcpy(buf + len, p->s + before, p->i - before);
                len += p->i - before;
            }
        }
    }
    if (value_start) *value_start = start;
    if (value_end) *value_end = p->i;
    p->i++; /* closing quote */
    if (buf) {
        buf[len] = '\0';
        *out = buf;
    }
    return 1;
bad:
    free(buf);
    return 0;
}

/* A canonical non-negative integer below 2^53 (the integers JSON.stringify writes exactly). */
static int jp_uint(jp* p, uint64_t* out)
{
    uint64_t v = 0;
    size_t digits = 0;
    if (jp_peek(p) == '0') {
        p->i++;
        if (jp_peek(p) >= '0' && jp_peek(p) <= '9') return 0;
        *out = 0;
        return 1;
    }
    while (jp_peek(p) >= '0' && jp_peek(p) <= '9') {
        v = v * 10 + (uint64_t)(p->s[p->i] - '0');
        p->i++;
        if (++digits > 16 || v > 9007199254740991ull) return 0;
    }
    if (digits == 0) return 0;
    if (jp_peek(p) == '.' || jp_peek(p) == 'e' || jp_peek(p) == 'E') return 0;
    *out = v;
    return 1;
}

static int jp_skip_value(jp* p, int depth);

/* An object whose keys are ASCII, strictly increasing; calls `on_key` for each, or skips values. */
typedef int (*jp_key_fn)(jp* p, const char* key, void* ctx);

static int jp_object(jp* p, int depth, jp_key_fn on_key, void* ctx)
{
    char* prev = NULL;
    if (depth > MAX_DEPTH || jp_peek(p) != '{') return 0;
    p->i++;
    if (jp_peek(p) == '}') {
        p->i++;
        return 1;
    }
    for (;;) {
        char* key = NULL;
        size_t k;
        int ok;
        if (!jp_string(p, &key, NULL, NULL)) goto bad;
        for (k = 0; key[k] != '\0'; k++) {
            if ((unsigned char)key[k] >= 0x80) { free(key); goto bad; } /* byte order = UTF-16 order */
        }
        if (prev != NULL && strcmp(prev, key) >= 0) { free(key); goto bad; }
        free(prev);
        prev = key;
        if (jp_peek(p) != ':') goto bad;
        p->i++;
        ok = on_key != NULL ? on_key(p, key, ctx) : jp_skip_value(p, depth + 1);
        if (!ok) goto bad;
        if (jp_peek(p) == ',') { p->i++; continue; }
        if (jp_peek(p) == '}') { p->i++; break; }
        goto bad;
    }
    free(prev);
    return 1;
bad:
    free(prev);
    return 0;
}

static int jp_skip_value(jp* p, int depth)
{
    int c = jp_peek(p);
    uint64_t ignored;
    if (depth > MAX_DEPTH) return 0;
    if (c == '"') return jp_string(p, NULL, NULL, NULL);
    if (c == '{') return jp_object(p, depth, NULL, NULL);
    if (c == '[') {
        p->i++;
        if (jp_peek(p) == ']') { p->i++; return 1; }
        for (;;) {
            if (!jp_skip_value(p, depth + 1)) return 0;
            if (jp_peek(p) == ',') { p->i++; continue; }
            if (jp_peek(p) == ']') { p->i++; return 1; }
            return 0;
        }
    }
    if (c == '-') { p->i++; return jp_uint(p, &ignored) && ignored != 0; }
    if (c >= '0' && c <= '9') return jp_uint(p, &ignored);
    return jp_lit(p, "null") || jp_lit(p, "true") || jp_lit(p, "false");
}

/* ------------------------------------------------------------------------------------------ header */

typedef struct header_ctx {
    sg_asset_container* c;
    char* format;
    char* cipher;
    char* kdf;
    char* signature;
    int have_chunk;
    int have_files;
    int have_fields[F_COUNT];
    size_t sig_start, sig_end; /* the signature's value, between its quotes */
    size_t files_cap;
} header_ctx;

typedef struct file_ctx {
    asset_file* f;
    char* nonce;
    char* sha;
    unsigned seen;
} file_ctx;

static int on_file_key(jp* p, const char* key, void* raw)
{
    file_ctx* fc = (file_ctx*)raw;
    if (strcmp(key, "bytes") == 0) { fc->seen |= 1u; return jp_uint(p, &fc->f->bytes); }
    if (strcmp(key, "chunks") == 0) { fc->seen |= 2u; return jp_uint(p, &fc->f->chunks); }
    if (strcmp(key, "length") == 0) { fc->seen |= 4u; return jp_uint(p, &fc->f->length); }
    if (strcmp(key, "noncePrefix") == 0) { fc->seen |= 8u; return jp_string(p, &fc->nonce, NULL, NULL); }
    if (strcmp(key, "offset") == 0) { fc->seen |= 16u; return jp_uint(p, &fc->f->offset); }
    if (strcmp(key, "path") == 0) { fc->seen |= 32u; return jp_string(p, &fc->f->path, NULL, NULL); }
    if (strcmp(key, "sha256") == 0) { fc->seen |= 64u; return jp_string(p, &fc->sha, NULL, NULL); }
    return 0; /* a file entry has exactly these keys */
}

static int parse_files(jp* p, header_ctx* h)
{
    sg_asset_container* c = h->c;
    if (jp_peek(p) != '[') return 0;
    p->i++;
    if (jp_peek(p) == ']') { p->i++; return 1; }
    for (;;) {
        file_ctx fc;
        int ok;
        if (c->count == SG_ASSET_MAX_FILES) return 0;
        if (c->count == h->files_cap) {
            size_t cap = h->files_cap ? h->files_cap * 2 : 16;
            asset_file* grown = (asset_file*)realloc(c->files, cap * sizeof *grown);
            if (grown == NULL) return 0;
            c->files = grown;
            h->files_cap = cap;
        }
        memset(&c->files[c->count], 0, sizeof c->files[0]);
        memset(&fc, 0, sizeof fc);
        fc.f = &c->files[c->count];
        c->count++; /* counted now so a failure frees its path */
        ok = jp_object(p, 2, on_file_key, &fc) && fc.seen == 127u
             && b64url_exact(fc.nonce, fc.f->nonce_prefix, NONCE_PREFIX_BYTES)
             && hex_exact(fc.sha, fc.f->sha256, sizeof fc.f->sha256);
        free(fc.nonce);
        free(fc.sha);
        if (!ok) return 0;
        if (jp_peek(p) == ',') { p->i++; continue; }
        if (jp_peek(p) == ']') { p->i++; return 1; }
        return 0;
    }
}

static int string_field(jp* p, header_ctx* h, int field)
{
    h->have_fields[field] = 1;
    return jp_string(p, &h->c->fields[field], NULL, NULL);
}

static int on_header_key(jp* p, const char* key, void* raw)
{
    header_ctx* h = (header_ctx*)raw;
    if (strcmp(key, "chunkBytes") == 0) { h->have_chunk = 1; return jp_uint(p, &h->c->chunk_bytes); }
    if (strcmp(key, "cipher") == 0) return jp_string(p, &h->cipher, NULL, NULL);
    if (strcmp(key, "deployment") == 0) return string_field(p, h, F_DEPLOYMENT);
    if (strcmp(key, "files") == 0) { h->have_files = 1; return parse_files(p, h); }
    if (strcmp(key, "fingerprint") == 0) {
        h->have_fields[F_FINGERPRINT] = 1;
        if (jp_lit(p, "null")) return 1;
        return jp_string(p, &h->c->fields[F_FINGERPRINT], NULL, NULL);
    }
    if (strcmp(key, "format") == 0) return jp_string(p, &h->format, NULL, NULL);
    if (strcmp(key, "kdf") == 0) return jp_string(p, &h->kdf, NULL, NULL);
    if (strcmp(key, "keyId") == 0) return string_field(p, h, F_KEY_ID);
    if (strcmp(key, "package") == 0) return string_field(p, h, F_PACKAGE);
    if (strcmp(key, "release") == 0) return string_field(p, h, F_RELEASE);
    if (strcmp(key, "signature") == 0) return jp_string(p, &h->signature, &h->sig_start, &h->sig_end);
    if (strcmp(key, "signerPublicKey") == 0) return string_field(p, h, F_SIGNER);
    if (strcmp(key, "version") == 0) return string_field(p, h, F_VERSION);
    return jp_skip_value(p, 1); /* signed, so harmless; kept for a later minor addition */
}

static const asset_file* find_file(const sg_asset_container* c, const char* path)
{
    size_t lo = 0, hi = c->count;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        const asset_file* f = &c->files[c->by_path[mid]];
        int d = strcmp(path, f->path);
        if (d == 0) return f;
        if (d < 0) hi = mid; else lo = mid + 1;
    }
    return NULL;
}

/* Insertion order by strcmp (paths are few; qsort_r is not portable). Also finds duplicates. */
static int index_paths(sg_asset_container* c)
{
    size_t i;
    c->by_path = (size_t*)malloc((c->count ? c->count : 1) * sizeof *c->by_path);
    if (c->by_path == NULL) return SG_ERR_NO_MEMORY;
    for (i = 0; i < c->count; i++) {
        size_t lo = 0, hi = i;
        while (lo < hi) {
            size_t mid = lo + (hi - lo) / 2;
            int d = strcmp(c->files[i].path, c->files[c->by_path[mid]].path);
            if (d == 0) return SG_ERR_BAD_CONTAINER; /* listed twice */
            if (d < 0) hi = mid; else lo = mid + 1;
        }
        memmove(c->by_path + lo + 1, c->by_path + lo, (i - lo) * sizeof *c->by_path);
        c->by_path[lo] = i;
    }
    return SG_OK;
}

static int container_ok(const sg_asset_container* c) { return c != NULL && c->magic == SG_ASSET_CONTAINER_MAGIC; }

static void container_release(sg_asset_container* c)
{
    size_t i;
    for (i = 0; i < F_COUNT; i++) free(c->fields[i]);
    for (i = 0; i < c->count; i++) free(c->files[i].path);
    free(c->files);
    free(c->by_path);
    if (c->key != NULL) sodium_free(c->key);
    sodium_memzero(c, sizeof *c);
    free(c);
}

int SG_CALL sg_asset_container_open(const uint8_t* data, size_t len, const uint8_t* trusted_signer, sg_asset_container** out_container)
{
    sg_asset_container* c = NULL;
    header_ctx h;
    jp p;
    uint32_t header_len;
    uint8_t signer[SG_PUBLIC_KEY_BYTES];
    uint8_t signature[SG_SIGNATURE_BYTES];
    uint64_t expected = 0;
    size_t i;
    int rc;

    if (out_container == NULL) return SG_ERR_INVALID_ARGUMENT;
    *out_container = NULL;
    if (data == NULL) return SG_ERR_INVALID_ARGUMENT;
    rc = ensure_ready();
    if (rc != SG_OK) return rc;
    memset(&h, 0, sizeof h);

    /* Preamble: "SGAE" | version 1 | three zero bytes | header length (u32 LE). */
    if (len < PREAMBLE_BYTES || memcmp(data, "SGAE", 4) != 0 || data[4] != 1 || data[5] != 0 || data[6] != 0 || data[7] != 0)
        return SG_ERR_BAD_CONTAINER;
    header_len = (uint32_t)data[8] | ((uint32_t)data[9] << 8) | ((uint32_t)data[10] << 16) | ((uint32_t)data[11] << 24);
    if (header_len == 0 || header_len > SG_ASSET_MAX_HEADER_BYTES || header_len > len - PREAMBLE_BYTES) return SG_ERR_BAD_CONTAINER;

    c = (sg_asset_container*)calloc(1, sizeof *c);
    if (c == NULL) return SG_ERR_NO_MEMORY;
    h.c = c;
    p.s = data + PREAMBLE_BYTES;
    p.n = header_len;
    p.i = 0;

    /* Header: canonical JSON, the format this reader knows. */
    rc = SG_ERR_BAD_CONTAINER;
    if (!jp_object(&p, 0, on_header_key, &h) || p.i != p.n) goto done;
    if (h.format == NULL || strcmp(h.format, FORMAT) != 0 || h.cipher == NULL || strcmp(h.cipher, CIPHER) != 0
        || h.kdf == NULL || strcmp(h.kdf, KDF) != 0)
        goto done;
    for (i = 0; i < F_COUNT; i++) if (!h.have_fields[i]) goto done;
    if (!h.have_chunk || !h.have_files || h.signature == NULL) goto done;
    if (c->chunk_bytes < SG_ASSET_MIN_CHUNK_BYTES || c->chunk_bytes > SG_ASSET_MAX_CHUNK_BYTES) goto done;
    if (strlen(c->fields[F_KEY_ID]) != SG_ASSET_KEY_ID_CHARS) goto done;

    /* Signer and signature, over the header with its signature emptied. */
    if (!b64url_exact(c->fields[F_SIGNER], signer, sizeof signer) || !b64url_exact(h.signature, signature, sizeof signature)) goto done;
    if (trusted_signer != NULL && sodium_memcmp(trusted_signer, signer, sizeof signer) != 0) { rc = SG_ERR_UNTRUSTED_SIGNER; goto done; }
    {
        size_t signed_len = header_len - (h.sig_end - h.sig_start);
        uint8_t* message = (uint8_t*)malloc(signed_len);
        int verified;
        if (message == NULL) { rc = SG_ERR_NO_MEMORY; goto done; }
        memcpy(message, p.s, h.sig_start);
        memcpy(message + h.sig_start, p.s + h.sig_end, header_len - h.sig_end);
        verified = crypto_sign_verify_detached(signature, message, signed_len, signer) == 0;
        free(message);
        if (!verified) { rc = SG_ERR_BAD_SIGNATURE; goto done; }
    }

    /* The file table: safe unique paths, sizes, chunk counts and contiguous ranges. */
    for (i = 0; i < c->count; i++) {
        asset_file* f = &c->files[i];
        uint64_t chunks;
        if (!sg_path_is_safe(f->path, strlen(f->path))) { rc = SG_ERR_UNSAFE_PATH; goto done; }
        if (f->bytes > SG_MAX_TOTAL_BYTES) goto done;
        chunks = f->bytes == 0 ? 1 : (f->bytes + c->chunk_bytes - 1) / c->chunk_bytes;
        if (f->chunks != chunks || f->offset != expected || f->length != f->bytes + chunks * SG_TAG_BYTES) goto done;
        expected += f->length;
    }
    rc = index_paths(c);
    if (rc != SG_OK) goto done;
    rc = SG_ERR_BAD_CONTAINER;
    if (expected != (uint64_t)(len - PREAMBLE_BYTES - header_len)) goto done;
    c->body = data + PREAMBLE_BYTES + header_len;
    c->body_len = (size_t)expected;

    /* Each file's ciphertext, against its signed hash: integrity before any key is asked for. */
    for (i = 0; i < c->count; i++) {
        uint8_t digest[crypto_hash_sha256_BYTES];
        crypto_hash_sha256(digest, c->body + c->files[i].offset, (unsigned long long)c->files[i].length);
        if (sodium_memcmp(digest, c->files[i].sha256, sizeof digest) != 0) { rc = SG_ERR_PAYLOAD_HASH; goto done; }
    }

    c->magic = SG_ASSET_CONTAINER_MAGIC;
    *out_container = c;
    c = NULL;
    rc = SG_OK;
done:
    free(h.format);
    free(h.cipher);
    free(h.kdf);
    free(h.signature);
    if (c != NULL) container_release(c);
    return rc;
}

int SG_CALL sg_asset_container_field(const sg_asset_container* c, const char* name, const char** out_value)
{
    size_t i;
    if (!container_ok(c) || name == NULL || out_value == NULL) return SG_ERR_INVALID_ARGUMENT;
    for (i = 0; i < F_COUNT; i++) {
        if (strcmp(name, FIELD_NAMES[i]) == 0) {
            if (c->fields[i] == NULL) return SG_ERR_NOT_FOUND;
            *out_value = c->fields[i];
            return SG_OK;
        }
    }
    return SG_ERR_NOT_FOUND;
}

int SG_CALL sg_asset_container_file_count(const sg_asset_container* c, size_t* out_count)
{
    if (!container_ok(c) || out_count == NULL) return SG_ERR_INVALID_ARGUMENT;
    *out_count = c->count;
    return SG_OK;
}

int SG_CALL sg_asset_container_file_at(const sg_asset_container* c, size_t index, const char** out_path, uint64_t* out_size)
{
    if (!container_ok(c)) return SG_ERR_INVALID_ARGUMENT;
    if (index >= c->count) return SG_ERR_NOT_FOUND;
    if (out_path != NULL) *out_path = c->files[index].path;
    if (out_size != NULL) *out_size = c->files[index].bytes;
    return SG_OK;
}

static int key_ok(const sg_asset_key* k) { return k != NULL && k->magic == SG_ASSET_KEY_MAGIC && k->key != NULL; }

int SG_CALL sg_asset_container_bind(sg_asset_container* c, const sg_asset_key* key)
{
    uint8_t* copy;
    if (!container_ok(c) || !key_ok(key) || c->key != NULL) return SG_ERR_INVALID_ARGUMENT;
    if (sodium_memcmp(key->id, c->fields[F_KEY_ID], SG_ASSET_KEY_ID_CHARS) != 0) return SG_ERR_KEY_MISMATCH;
    copy = (uint8_t*)sodium_malloc(SG_ASSET_KEY_BYTES);
    if (copy == NULL) return SG_ERR_NO_MEMORY;
    memcpy(copy, key->key, SG_ASSET_KEY_BYTES);
    sodium_mprotect_readonly(copy);
    c->key = copy;
    return SG_OK;
}

void SG_CALL sg_asset_container_free(sg_asset_container* c)
{
    if (!container_ok(c)) return;
    container_release(c);
}

/* ------------------------------------------------------------------------------------------ reader */

int SG_CALL sg_asset_reader_new(const sg_asset_container* c, sg_asset_reader** out_reader)
{
    sg_asset_reader* r;
    if (out_reader == NULL) return SG_ERR_INVALID_ARGUMENT;
    *out_reader = NULL;
    if (!container_ok(c) || c->key == NULL) return SG_ERR_INVALID_ARGUMENT;
    r = (sg_asset_reader*)calloc(1, sizeof *r);
    if (r == NULL) return SG_ERR_NO_MEMORY;
    r->plain = (uint8_t*)sodium_malloc((size_t)c->chunk_bytes);
    if (r->plain == NULL) {
        free(r);
        return SG_ERR_NO_MEMORY;
    }
    r->container = c;
    r->magic = SG_ASSET_READER_MAGIC;
    *out_reader = r;
    return SG_OK;
}

/* aad = "scriptgo-asset-escrow/1\n" package "@" version "\n" path "\n" || u32 BE index || u8 final */
static int chunk_aad(const sg_asset_container* c, const asset_file* f, uint64_t index, int final, uint8_t** out, size_t* out_len)
{
    size_t a = strlen(FORMAT), pk = strlen(c->fields[F_PACKAGE]), v = strlen(c->fields[F_VERSION]), pa = strlen(f->path);
    size_t n = a + 1 + pk + 1 + v + 1 + pa + 1 + 5, o = 0;
    uint8_t* b = (uint8_t*)malloc(n);
    if (b == NULL) return SG_ERR_NO_MEMORY;
    memcpy(b + o, FORMAT, a); o += a; b[o++] = '\n';
    memcpy(b + o, c->fields[F_PACKAGE], pk); o += pk; b[o++] = '@';
    memcpy(b + o, c->fields[F_VERSION], v); o += v; b[o++] = '\n';
    memcpy(b + o, f->path, pa); o += pa; b[o++] = '\n';
    b[o++] = (uint8_t)(index >> 24); b[o++] = (uint8_t)(index >> 16); b[o++] = (uint8_t)(index >> 8); b[o++] = (uint8_t)index;
    b[o++] = final ? 1 : 0;
    *out = b;
    *out_len = o;
    return SG_OK;
}

static int load_chunk(sg_asset_reader* r, const asset_file* f, uint64_t index)
{
    const sg_asset_container* c = r->container;
    uint64_t plain_len = index == f->chunks - 1 ? f->bytes - index * c->chunk_bytes : c->chunk_bytes;
    const uint8_t* ct = c->body + f->offset + index * (c->chunk_bytes + SG_TAG_BYTES);
    uint8_t nonce[SG_NONCE_BYTES];
    uint8_t* aad = NULL;
    size_t aad_len = 0;
    unsigned long long got = 0;
    int rc, ok;
    if (r->has_cache && r->cached_file == f && r->cached_index == index) return SG_OK;
    r->has_cache = 0;
    memcpy(nonce, f->nonce_prefix, NONCE_PREFIX_BYTES);
    nonce[8] = (uint8_t)(index >> 24); nonce[9] = (uint8_t)(index >> 16); nonce[10] = (uint8_t)(index >> 8); nonce[11] = (uint8_t)index;
    rc = chunk_aad(c, f, index, index == f->chunks - 1, &aad, &aad_len);
    if (rc != SG_OK) return rc;
    ok = crypto_aead_aes256gcm_decrypt(r->plain, &got, NULL, ct, plain_len + SG_TAG_BYTES, aad, aad_len, nonce, c->key) == 0
         && got == plain_len;
    free(aad);
    if (!ok) {
        sodium_memzero(r->plain, (size_t)c->chunk_bytes);
        return SG_ERR_DECRYPT;
    }
    r->cached_file = f;
    r->cached_index = index;
    r->cached_len = (size_t)plain_len;
    r->has_cache = 1;
    return SG_OK;
}

int SG_CALL sg_asset_reader_read(sg_asset_reader* r, const char* path, uint64_t offset, uint8_t* buffer, size_t length, size_t* out_read)
{
    const sg_asset_container* c;
    const asset_file* f;
    uint64_t end, pos;
    size_t written = 0;
    if (out_read != NULL) *out_read = 0;
    if (r == NULL || r->magic != SG_ASSET_READER_MAGIC || path == NULL || out_read == NULL || (buffer == NULL && length > 0))
        return SG_ERR_INVALID_ARGUMENT;
    c = r->container;
    if (!container_ok(c) || c->key == NULL) return SG_ERR_INVALID_ARGUMENT;
    f = find_file(c, path);
    if (f == NULL) return SG_ERR_NOT_FOUND;
    if (offset >= f->bytes || length == 0) return SG_OK;
    end = f->bytes - offset < (uint64_t)length ? f->bytes : offset + length;
    /* Authenticate every chunk of the range before copying any of it: no partial result. */
    for (pos = offset; pos < end;) {
        uint64_t index = pos / c->chunk_bytes;
        int rc = load_chunk(r, f, index);
        if (rc != SG_OK) {
            sodium_memzero(buffer, written);
            return rc;
        }
        {
            uint64_t in_chunk = pos - index * c->chunk_bytes;
            uint64_t take = r->cached_len - in_chunk;
            if (take > end - pos) take = end - pos;
            memcpy(buffer + written, r->plain + in_chunk, (size_t)take);
            written += (size_t)take;
            pos += take;
        }
    }
    *out_read = written;
    return SG_OK;
}

void SG_CALL sg_asset_reader_free(sg_asset_reader* r)
{
    if (r == NULL || r->magic != SG_ASSET_READER_MAGIC) return;
    if (r->plain != NULL) sodium_free(r->plain);
    sodium_memzero(r, sizeof *r);
    free(r);
}

/* --------------------------------------------------------------------------------------------- keys */

typedef struct wrap_secrets {
    uint8_t shared[crypto_scalarmult_BYTES];
    uint8_t prk[crypto_kdf_hkdf_sha256_KEYBYTES];
    uint8_t kek[crypto_aead_aes256gcm_KEYBYTES];
    uint8_t ephemeral[crypto_scalarmult_SCALARBYTES];
} wrap_secrets;

static int derive_kek(wrap_secrets* s, int kind, const uint8_t epk[SG_PUBLIC_KEY_BYTES], const uint8_t recipient_public[SG_PUBLIC_KEY_BYTES])
{
    uint8_t salt[SG_PUBLIC_KEY_BYTES * 2];
    const char* info = kind == SG_ASSET_WRAP_SERVER ? SERVER_WRAP_INFO : CLIENT_WRAP_INFO;
    size_t info_len = kind == SG_ASSET_WRAP_SERVER ? sizeof SERVER_WRAP_INFO - 1 : sizeof CLIENT_WRAP_INFO - 1;
    memcpy(salt, epk, SG_PUBLIC_KEY_BYTES);
    memcpy(salt + SG_PUBLIC_KEY_BYTES, recipient_public, SG_PUBLIC_KEY_BYTES);
    crypto_kdf_hkdf_sha256_extract(s->prk, salt, sizeof salt, s->shared, sizeof s->shared);
    return crypto_kdf_hkdf_sha256_expand(s->kek, sizeof s->kek, info, info_len, s->prk) == 0 ? SG_OK : SG_ERR_UNWRAP;
}

int SG_CALL sg_asset_key_unwrap(const sg_identity* identity, int kind,
                                const uint8_t epk[SG_PUBLIC_KEY_BYTES], const uint8_t wrap_nonce[SG_NONCE_BYTES],
                                const uint8_t* wrapped, size_t wrapped_len, const uint8_t* aad, size_t aad_len,
                                sg_asset_key** out_key)
{
    wrap_secrets* s = NULL;
    uint8_t* key = NULL;
    sg_asset_key* k = NULL;
    unsigned long long got = 0;
    int rc;
    if (out_key == NULL) return SG_ERR_INVALID_ARGUMENT;
    *out_key = NULL;
    if (identity == NULL || identity->magic != SG_IDENTITY_MAGIC || identity->private_key == NULL || epk == NULL || wrap_nonce == NULL
        || wrapped == NULL || wrapped_len != SG_WRAPPED_KEY_BYTES || (aad == NULL && aad_len > 0)
        || (kind != SG_ASSET_WRAP_SERVER && kind != SG_ASSET_WRAP_CLIENT))
        return SG_ERR_INVALID_ARGUMENT;
    rc = ensure_ready();
    if (rc != SG_OK) return rc;
    if (aad == NULL) aad = EMPTY_AAD;
    s = (wrap_secrets*)sodium_malloc(sizeof *s);
    key = (uint8_t*)sodium_malloc(SG_ASSET_KEY_BYTES);
    k = (sg_asset_key*)calloc(1, sizeof *k);
    if (s == NULL || key == NULL || k == NULL) { rc = SG_ERR_NO_MEMORY; goto done; }
    rc = SG_ERR_UNWRAP;
    if (crypto_scalarmult(s->shared, identity->private_key, epk) != 0) goto done;
    if (derive_kek(s, kind, epk, identity->public_key) != SG_OK) goto done;
    if (crypto_aead_aes256gcm_decrypt(key, &got, NULL, wrapped, wrapped_len, aad, aad_len, wrap_nonce, s->kek) != 0
        || got != SG_ASSET_KEY_BYTES)
        goto done;
    key_id_of(key, k->id);
    sodium_mprotect_readonly(key);
    k->key = key;
    k->magic = SG_ASSET_KEY_MAGIC;
    key = NULL;
    *out_key = k;
    k = NULL;
    rc = SG_OK;
done:
    if (s != NULL) sodium_free(s);
    if (key != NULL) sodium_free(key);
    free(k);
    return rc;
}

int SG_CALL sg_asset_key_wrap(const sg_asset_key* key, const uint8_t client_public_key[SG_PUBLIC_KEY_BYTES],
                              const uint8_t* aad, size_t aad_len, uint8_t out_epk[SG_PUBLIC_KEY_BYTES],
                              uint8_t out_wrap_nonce[SG_NONCE_BYTES], uint8_t out_wrapped[SG_WRAPPED_KEY_BYTES])
{
    wrap_secrets* s;
    unsigned long long out_len = 0;
    int rc;
    if (!key_ok(key) || client_public_key == NULL || (aad == NULL && aad_len > 0) || out_epk == NULL || out_wrap_nonce == NULL || out_wrapped == NULL)
        return SG_ERR_INVALID_ARGUMENT;
    rc = ensure_ready();
    if (rc != SG_OK) return rc;
    if (aad == NULL) aad = EMPTY_AAD;
    s = (wrap_secrets*)sodium_malloc(sizeof *s);
    if (s == NULL) return SG_ERR_NO_MEMORY;
    rc = SG_ERR_INVALID_ARGUMENT;
    randombytes_buf(s->ephemeral, sizeof s->ephemeral);
    crypto_scalarmult_base(out_epk, s->ephemeral);
    /* A small-order client key gives an all-zero secret, which crypto_scalarmult refuses. */
    if (crypto_scalarmult(s->shared, s->ephemeral, client_public_key) != 0) goto done;
    if (derive_kek(s, SG_ASSET_WRAP_CLIENT, out_epk, client_public_key) != SG_OK) goto done;
    randombytes_buf(out_wrap_nonce, SG_NONCE_BYTES);
    crypto_aead_aes256gcm_encrypt(out_wrapped, &out_len, key->key, SG_ASSET_KEY_BYTES, aad, aad_len, NULL, out_wrap_nonce, s->kek);
    rc = out_len == SG_WRAPPED_KEY_BYTES ? SG_OK : SG_ERR_INIT;
done:
    sodium_free(s);
    return rc;
}

int SG_CALL sg_asset_key_id(const sg_asset_key* key, char* out, size_t capacity)
{
    if (!key_ok(key) || out == NULL) return SG_ERR_INVALID_ARGUMENT;
    if (capacity < SG_ASSET_KEY_ID_CHARS + 1) return SG_ERR_BUFFER_TOO_SMALL;
    memcpy(out, key->id, SG_ASSET_KEY_ID_CHARS + 1);
    return SG_OK;
}

void SG_CALL sg_asset_key_free(sg_asset_key* key)
{
    if (key == NULL || key->magic != SG_ASSET_KEY_MAGIC) return;
    if (key->key != NULL) sodium_free(key->key);
    sodium_memzero(key, sizeof *key);
    free(key);
}
