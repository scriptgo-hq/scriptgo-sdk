/*
 * libscriptgo: identity, signature check, payload decryption and the bundle accessors.
 *
 * Every secret (the private key, the X25519 shared secret, the HKDF output, the content key, the
 * decrypted inner zip and the decompressed files) lives in memory from sodium_malloc: guard pages
 * on both sides, locked when the OS allows it, wiped by sodium_free. The content key exists only
 * between the unwrap and the end of the payload decryption inside sg_bundle_open.
 *
 * This raises the cost of reading keys and plaintext out of the process. It does not stop the
 * operator of the machine, who can attach a debugger to their own server. See escrow.h.
 */
#include <stdlib.h>
#include <string.h>

#include <sodium.h>

#include "internal.h"

#define SG_VERSION_STRING "0.1.0"
#define SG_BUNDLE_MAGIC 0x5347424eu  /* "SGBN" */
#define SG_ARCHIVE_MAGIC 0x53474152u /* "SGAR" */

static const char WRAP_INFO[] = "scriptgo.escrow.keywrap.v1";
static const uint8_t EMPTY[1] = { 0 };

struct sg_bundle {
    uint32_t magic;
    sg_zip_index index;
    uint8_t* marker; /* sodium_malloc; the per-delivery marker, or NULL */
    size_t marker_size;
};

struct sg_archive {
    uint32_t magic;
    sg_zip_index index;
};

/* ------------------------------------------------------------------------------------------ general */

uint32_t SG_CALL sg_abi_version(void) { return SG_ABI_VERSION; }

const char* SG_CALL sg_version_string(void) { return SG_VERSION_STRING; }

/* sodium_init is thread-safe and idempotent (0 the first time, 1 afterwards, -1 on failure). */
static int ensure_init(void)
{
    return sodium_init() < 0 ? SG_ERR_INIT : SG_OK;
}

int SG_CALL sg_init(void)
{
    int rc = ensure_init();
    if (rc != SG_OK) return rc;
    return crypto_aead_aes256gcm_is_available() ? SG_OK : SG_ERR_NO_AES;
}

const char* SG_CALL sg_strerror(int code)
{
    switch (code) {
    case SG_OK: return "ok";
    case SG_ERR_INVALID_ARGUMENT: return "invalid argument";
    case SG_ERR_INIT: return "the crypto library could not initialise";
    case SG_ERR_NO_AES: return "this CPU has no hardware AES-256-GCM (AES-NI and PCLMUL, or the ARM crypto extensions, are required)";
    case SG_ERR_NO_MEMORY: return "out of memory";
    case SG_ERR_BAD_SIGNATURE: return "the release signature does not verify";
    case SG_ERR_PAYLOAD_HASH: return "the payload does not match the hash in the manifest";
    case SG_ERR_UNWRAP: return "the content key is not wrapped to this server identity and release";
    case SG_ERR_DECRYPT: return "the payload does not authenticate under the content key";
    case SG_ERR_BAD_ARCHIVE: return "the archive is malformed";
    case SG_ERR_UNSAFE_PATH: return "the archive holds an unsafe path";
    case SG_ERR_TOO_LARGE: return "the archive or one of its files is over the size limit";
    case SG_ERR_NOT_FOUND: return "not found";
    case SG_ERR_BUFFER_TOO_SMALL: return "the buffer is too small";
    case SG_ERR_IO: return "the file could not be read or written";
    case SG_ERR_IDENTITY_FORMAT: return "the identity file is damaged or is not an identity file";
    case SG_ERR_PROTECT: return "the operating system refused to unseal the identity (another user or machine?)";
    case SG_ERR_LUA_LOAD: return "the Lua chunk did not compile";
    case SG_ERR_UNSUPPORTED: return "the archive uses an unsupported zip feature";
    case SG_ERR_INSECURE_PERMISSIONS: return "the identity file is readable by other users";
    case SG_ERR_EXISTS: return "the file already exists";
    case SG_ERR_BAD_CONTAINER: return "the container is malformed";
    case SG_ERR_KEY_MISMATCH: return "the key is not this container's key";
    case SG_ERR_UNTRUSTED_SIGNER: return "the container is signed by another key than the pinned one";
    case SG_ERR_TARGET_MISMATCH: return "the client code was compiled for another Lua VM";
    default: return "unknown error";
    }
}

int SG_CALL sg_sha256(const uint8_t* data, size_t len, uint8_t out_digest[SG_SHA256_BYTES])
{
    int rc;
    if (out_digest == NULL || (data == NULL && len > 0)) return SG_ERR_INVALID_ARGUMENT;
    rc = ensure_init();
    if (rc != SG_OK) return rc;
    crypto_hash_sha256(out_digest, data != NULL ? data : EMPTY, len);
    return SG_OK;
}

/* ----------------------------------------------------------------------------------------- identity */

int sg_identity_adopt(uint8_t* guarded_private_key, sg_identity** out_identity)
{
    sg_identity* identity = (sg_identity*)calloc(1, sizeof *identity);
    if (identity == NULL) {
        sodium_free(guarded_private_key);
        return SG_ERR_NO_MEMORY;
    }
    /* crypto_scalarmult_base clamps the scalar itself, as every X25519 implementation does. */
    crypto_scalarmult_base(identity->public_key, guarded_private_key);
    sodium_mprotect_readonly(guarded_private_key);
    identity->private_key = guarded_private_key;
    identity->magic = SG_IDENTITY_MAGIC;
    *out_identity = identity;
    return SG_OK;
}

static int identity_ok(const sg_identity* identity)
{
    return identity != NULL && identity->magic == SG_IDENTITY_MAGIC && identity->private_key != NULL;
}

int SG_CALL sg_identity_generate(sg_identity** out_identity)
{
    uint8_t* key;
    int rc;
    if (out_identity == NULL) return SG_ERR_INVALID_ARGUMENT;
    *out_identity = NULL;
    rc = ensure_init();
    if (rc != SG_OK) return rc;
    key = (uint8_t*)sodium_malloc(SG_PRIVATE_KEY_BYTES);
    if (key == NULL) return SG_ERR_NO_MEMORY;
    randombytes_buf(key, SG_PRIVATE_KEY_BYTES);
    return sg_identity_adopt(key, out_identity);
}

int SG_CALL sg_identity_import(const uint8_t private_key[SG_PRIVATE_KEY_BYTES], sg_identity** out_identity)
{
    uint8_t* key;
    int rc;
    if (out_identity == NULL) return SG_ERR_INVALID_ARGUMENT;
    *out_identity = NULL;
    if (private_key == NULL) return SG_ERR_INVALID_ARGUMENT;
    rc = ensure_init();
    if (rc != SG_OK) return rc;
    key = (uint8_t*)sodium_malloc(SG_PRIVATE_KEY_BYTES);
    if (key == NULL) return SG_ERR_NO_MEMORY;
    memcpy(key, private_key, SG_PRIVATE_KEY_BYTES);
    return sg_identity_adopt(key, out_identity);
}

int SG_CALL sg_identity_load(const char* path, sg_identity** out_identity)
{
    uint8_t stored_public[SG_PUBLIC_KEY_BYTES];
    uint8_t* key;
    int rc;
    if (out_identity == NULL) return SG_ERR_INVALID_ARGUMENT;
    *out_identity = NULL;
    if (path == NULL || path[0] == '\0') return SG_ERR_INVALID_ARGUMENT;
    rc = ensure_init();
    if (rc != SG_OK) return rc;
    key = (uint8_t*)sodium_malloc(SG_PRIVATE_KEY_BYTES);
    if (key == NULL) return SG_ERR_NO_MEMORY;
    rc = sg_seal_read(path, stored_public, key);
    if (rc != SG_OK) {
        sodium_free(key);
        return rc;
    }
    rc = sg_identity_adopt(key, out_identity);
    if (rc != SG_OK) return rc;
    /* The public key in the header must be the one this private key yields. */
    if (sodium_memcmp(stored_public, (*out_identity)->public_key, SG_PUBLIC_KEY_BYTES) != 0) {
        sg_identity_free(*out_identity);
        *out_identity = NULL;
        return SG_ERR_IDENTITY_FORMAT;
    }
    return SG_OK;
}

int SG_CALL sg_identity_save(const sg_identity* identity, const char* path, int replace)
{
    if (!identity_ok(identity) || path == NULL || path[0] == '\0') return SG_ERR_INVALID_ARGUMENT;
    return sg_seal_write(path, identity->public_key, identity->private_key, replace);
}

int SG_CALL sg_identity_load_or_create(const char* path, sg_identity** out_identity, int* out_created)
{
    int rc;
    if (out_created != NULL) *out_created = 0;
    if (out_identity == NULL) return SG_ERR_INVALID_ARGUMENT;
    rc = sg_identity_load(path, out_identity);
    if (rc != SG_ERR_NOT_FOUND) return rc; /* loaded, or a real error: never replace an identity */

    rc = sg_identity_generate(out_identity);
    if (rc != SG_OK) return rc;
    rc = sg_identity_save(*out_identity, path, 0);
    if (rc == SG_OK) {
        if (out_created != NULL) *out_created = 1;
        return SG_OK;
    }
    sg_identity_free(*out_identity);
    *out_identity = NULL;
    /* Another process created the file between our load and our save: use theirs. */
    if (rc == SG_ERR_EXISTS) return sg_identity_load(path, out_identity);
    return rc;
}

int SG_CALL sg_identity_public_key(const sg_identity* identity, uint8_t out_public_key[SG_PUBLIC_KEY_BYTES])
{
    if (!identity_ok(identity) || out_public_key == NULL) return SG_ERR_INVALID_ARGUMENT;
    memcpy(out_public_key, identity->public_key, SG_PUBLIC_KEY_BYTES);
    return SG_OK;
}

void SG_CALL sg_identity_free(sg_identity* identity)
{
    if (identity == NULL || identity->magic != SG_IDENTITY_MAGIC) return;
    if (identity->private_key != NULL) sodium_free(identity->private_key); /* wipes, then unmaps */
    sodium_memzero(identity, sizeof *identity);
    free(identity);
}

/* ---------------------------------------------------------------------------------------- signature */

int SG_CALL sg_verify_manifest(const uint8_t* canonical_json, size_t canonical_json_len,
                               const uint8_t signature[SG_SIGNATURE_BYTES],
                               const uint8_t signer_public_key[SG_PUBLIC_KEY_BYTES])
{
    int rc;
    if (canonical_json == NULL || canonical_json_len == 0 || signature == NULL || signer_public_key == NULL)
        return SG_ERR_INVALID_ARGUMENT;
    rc = ensure_init();
    if (rc != SG_OK) return rc;
    return crypto_sign_verify_detached(signature, canonical_json, canonical_json_len, signer_public_key) == 0
        ? SG_OK : SG_ERR_BAD_SIGNATURE;
}

/* ------------------------------------------------------------------------------------ clear archive */

static int archive_ok(const sg_archive* archive)
{
    return archive != NULL && archive->magic == SG_ARCHIVE_MAGIC;
}

int SG_CALL sg_archive_open(const uint8_t* zip, size_t zip_len, sg_archive** out_archive)
{
    sg_archive* archive;
    int rc;
    if (out_archive == NULL) return SG_ERR_INVALID_ARGUMENT;
    *out_archive = NULL;
    if (zip == NULL || zip_len == 0) return SG_ERR_INVALID_ARGUMENT;
    if (zip_len > SG_MAX_TOTAL_BYTES) return SG_ERR_TOO_LARGE;
    archive = (sg_archive*)calloc(1, sizeof *archive);
    if (archive == NULL) return SG_ERR_NO_MEMORY;
    rc = sg_zip_read(zip, zip_len, 0, &archive->index);
    if (rc != SG_OK) {
        free(archive);
        return rc;
    }
    archive->magic = SG_ARCHIVE_MAGIC;
    *out_archive = archive;
    return SG_OK;
}

int SG_CALL sg_archive_entry_count(const sg_archive* archive, size_t* out_count)
{
    if (!archive_ok(archive) || out_count == NULL) return SG_ERR_INVALID_ARGUMENT;
    *out_count = archive->index.count;
    return SG_OK;
}

int SG_CALL sg_archive_entry_at(const sg_archive* archive, size_t index, const char** out_path, size_t* out_size)
{
    if (!archive_ok(archive)) return SG_ERR_INVALID_ARGUMENT;
    if (index >= archive->index.count) return SG_ERR_NOT_FOUND;
    if (out_path != NULL) *out_path = archive->index.entries[index].path;
    if (out_size != NULL) *out_size = archive->index.entries[index].size;
    return SG_OK;
}

int SG_CALL sg_archive_read(const sg_archive* archive, const char* path, const uint8_t** out_data, size_t* out_len)
{
    const sg_zip_entry* entry;
    if (!archive_ok(archive) || path == NULL || out_data == NULL || out_len == NULL) return SG_ERR_INVALID_ARGUMENT;
    entry = sg_zip_find(&archive->index, path);
    if (entry == NULL) return SG_ERR_NOT_FOUND;
    *out_data = entry->size > 0 ? archive->index.data + entry->offset : EMPTY;
    *out_len = entry->size;
    return SG_OK;
}

void SG_CALL sg_archive_free(sg_archive* archive)
{
    if (!archive_ok(archive)) return;
    sg_zip_release(&archive->index);
    archive->magic = 0;
    free(archive);
}

/* ------------------------------------------------------------------------------------------- bundle */

static int bundle_ok(const sg_bundle* bundle)
{
    return bundle != NULL && bundle->magic == SG_BUNDLE_MAGIC;
}

/* The secrets of one sg_bundle_open call, in a single guarded allocation so one sodium_free wipes
 * them all. */
typedef struct open_secrets {
    uint8_t shared[crypto_scalarmult_BYTES];
    uint8_t prk[crypto_kdf_hkdf_sha256_KEYBYTES];
    uint8_t kek[crypto_aead_aes256gcm_KEYBYTES];
    uint8_t content_key[crypto_aead_aes256gcm_KEYBYTES];
} open_secrets;

int SG_CALL sg_bundle_open(const sg_identity* identity,
                           const uint8_t* payload, size_t payload_len,
                           const uint8_t payload_nonce[SG_NONCE_BYTES],
                           const uint8_t* aad, size_t aad_len,
                           const uint8_t epk[SG_PUBLIC_KEY_BYTES],
                           const uint8_t wrap_nonce[SG_NONCE_BYTES],
                           const uint8_t* wrapped, size_t wrapped_len,
                           const uint8_t expected_payload_sha256[SG_SHA256_BYTES],
                           sg_bundle** out_bundle)
{
    uint8_t digest[crypto_hash_sha256_BYTES];
    uint8_t salt[SG_PUBLIC_KEY_BYTES * 2];
    open_secrets* secrets = NULL;
    uint8_t* inner = NULL;
    sg_bundle* bundle = NULL;
    unsigned long long key_len = 0, inner_len = 0;
    int rc;

    if (out_bundle == NULL) return SG_ERR_INVALID_ARGUMENT;
    *out_bundle = NULL;
    if (!identity_ok(identity) || payload == NULL || payload_nonce == NULL || epk == NULL || wrap_nonce == NULL
        || wrapped == NULL || expected_payload_sha256 == NULL || (aad == NULL && aad_len > 0))
        return SG_ERR_INVALID_ARGUMENT;
    if (wrapped_len != SG_WRAPPED_KEY_BYTES || payload_len < SG_TAG_BYTES) return SG_ERR_INVALID_ARGUMENT;
    if (payload_len > SG_MAX_PAYLOAD_BYTES) return SG_ERR_TOO_LARGE;
    rc = sg_init();
    if (rc != SG_OK) return rc; /* includes SG_ERR_NO_AES */
    if (aad == NULL) aad = EMPTY;

    /* 1. The payload is the one the signed manifest names. */
    crypto_hash_sha256(digest, payload, payload_len);
    if (sodium_memcmp(digest, expected_payload_sha256, sizeof digest) != 0) return SG_ERR_PAYLOAD_HASH;

    secrets = (open_secrets*)sodium_malloc(sizeof *secrets);
    if (secrets == NULL) return SG_ERR_NO_MEMORY;

    /* 2. Unwrap the content key (ECIES: X25519, HKDF-SHA256, AES-256-GCM). crypto_scalarmult
     * refuses a shared secret of all zeroes (a small-order ephemeral key). */
    if (crypto_scalarmult(secrets->shared, identity->private_key, epk) != 0) { rc = SG_ERR_UNWRAP; goto done; }
    memcpy(salt, epk, SG_PUBLIC_KEY_BYTES);
    memcpy(salt + SG_PUBLIC_KEY_BYTES, identity->public_key, SG_PUBLIC_KEY_BYTES);
    crypto_kdf_hkdf_sha256_extract(secrets->prk, salt, sizeof salt, secrets->shared, sizeof secrets->shared);
    if (crypto_kdf_hkdf_sha256_expand(secrets->kek, sizeof secrets->kek, WRAP_INFO, sizeof WRAP_INFO - 1, secrets->prk) != 0) {
        rc = SG_ERR_UNWRAP;
        goto done;
    }
    if (crypto_aead_aes256gcm_decrypt(secrets->content_key, &key_len, NULL, wrapped, wrapped_len, aad, aad_len,
                                      wrap_nonce, secrets->kek) != 0
        || key_len != sizeof secrets->content_key) {
        rc = SG_ERR_UNWRAP;
        goto done;
    }

    /* 3. Decrypt the payload into guarded memory. */
    inner = (uint8_t*)sodium_malloc(payload_len - SG_TAG_BYTES + 1);
    if (inner == NULL) { rc = SG_ERR_NO_MEMORY; goto done; }
    if (crypto_aead_aes256gcm_decrypt(inner, &inner_len, NULL, payload, payload_len, aad, aad_len,
                                      payload_nonce, secrets->content_key) != 0) {
        rc = SG_ERR_DECRYPT;
        goto done;
    }

    /* 4. The keys are no longer needed: wipe them before touching the archive. */
    sodium_free(secrets);
    secrets = NULL;

    /* 5. Index and decompress the inner zip into its own guarded, read-only arena. */
    bundle = (sg_bundle*)calloc(1, sizeof *bundle);
    if (bundle == NULL) { rc = SG_ERR_NO_MEMORY; goto done; }
    rc = sg_zip_read(inner, (size_t)inner_len, 1, &bundle->index);
    if (rc != SG_OK) goto done;
    bundle->magic = SG_BUNDLE_MAGIC;
    *out_bundle = bundle;
    bundle = NULL;
    rc = SG_OK;

done:
    if (secrets != NULL) sodium_free(secrets);
    if (inner != NULL) sodium_free(inner);
    free(bundle);
    return rc;
}

int SG_CALL sg_bundle_entry_count(const sg_bundle* bundle, size_t* out_count)
{
    if (!bundle_ok(bundle) || out_count == NULL) return SG_ERR_INVALID_ARGUMENT;
    *out_count = bundle->index.count;
    return SG_OK;
}

int SG_CALL sg_bundle_entry_at(const sg_bundle* bundle, size_t index, const char** out_path, size_t* out_size)
{
    if (!bundle_ok(bundle)) return SG_ERR_INVALID_ARGUMENT;
    if (index >= bundle->index.count) return SG_ERR_NOT_FOUND;
    if (out_path != NULL) *out_path = bundle->index.entries[index].path;
    if (out_size != NULL) *out_size = bundle->index.entries[index].size;
    return SG_OK;
}

/* Resolves a path to bytes in native memory: an archive entry, or the delivery marker. */
static int bundle_lookup(const sg_bundle* bundle, const char* path, const uint8_t** out_data, size_t* out_len)
{
    const sg_zip_entry* entry = sg_zip_find(&bundle->index, path);
    if (entry != NULL) {
        *out_data = entry->size > 0 ? bundle->index.data + entry->offset : EMPTY;
        *out_len = entry->size;
        return SG_OK;
    }
    if (bundle->marker != NULL && strcmp(path, SG_DELIVERY_MARKER_PATH) == 0) {
        *out_data = bundle->marker;
        *out_len = bundle->marker_size;
        return SG_OK;
    }
    return SG_ERR_NOT_FOUND;
}

int SG_CALL sg_bundle_entry_size(const sg_bundle* bundle, const char* path, size_t* out_size)
{
    const uint8_t* data;
    if (!bundle_ok(bundle) || path == NULL || out_size == NULL) return SG_ERR_INVALID_ARGUMENT;
    return bundle_lookup(bundle, path, &data, out_size);
}

int SG_CALL sg_bundle_read(const sg_bundle* bundle, const char* path, const uint8_t** out_data, size_t* out_len)
{
    if (!bundle_ok(bundle) || path == NULL || out_data == NULL || out_len == NULL) return SG_ERR_INVALID_ARGUMENT;
    return bundle_lookup(bundle, path, out_data, out_len);
}

int SG_CALL sg_bundle_copy(const sg_bundle* bundle, const char* path, uint8_t* buffer, size_t capacity, size_t* out_len)
{
    const uint8_t* data;
    size_t len = 0;
    int rc;
    if (!bundle_ok(bundle) || path == NULL || out_len == NULL || (buffer == NULL && capacity > 0)) return SG_ERR_INVALID_ARGUMENT;
    rc = bundle_lookup(bundle, path, &data, &len);
    if (rc != SG_OK) return rc;
    *out_len = len;
    if (capacity < len) return SG_ERR_BUFFER_TOO_SMALL;
    if (len > 0) memcpy(buffer, data, len);
    return SG_OK;
}

int SG_CALL sg_bundle_set_marker(sg_bundle* bundle, const uint8_t* marker, size_t marker_len)
{
    uint8_t* copy = NULL;
    if (!bundle_ok(bundle) || (marker == NULL && marker_len > 0)) return SG_ERR_INVALID_ARGUMENT;
    if (marker_len > SG_MAX_ENTRY_BYTES) return SG_ERR_TOO_LARGE;
    /* An archive entry of that name wins in bundle_lookup; refuse rather than shadow silently. */
    if (sg_zip_find(&bundle->index, SG_DELIVERY_MARKER_PATH) != NULL) return SG_ERR_EXISTS;
    if (marker_len > 0) {
        copy = (uint8_t*)sodium_malloc(marker_len);
        if (copy == NULL) return SG_ERR_NO_MEMORY;
        memcpy(copy, marker, marker_len);
        sodium_mprotect_readonly(copy);
    }
    if (bundle->marker != NULL) sodium_free(bundle->marker);
    bundle->marker = copy;
    bundle->marker_size = marker_len;
    return SG_OK;
}

int SG_CALL sg_bundle_memory_locked(const sg_bundle* bundle)
{
    return bundle_ok(bundle) && bundle->index.locked ? 1 : 0;
}

int SG_CALL sg_bundle_lua_load(const sg_bundle* bundle, const char* path, void* lua_state,
                               sg_lua_loadbufferx_fn loadbufferx, const char* chunk_name, int* out_lua_status)
{
    const uint8_t* data;
    size_t len = 0;
    int rc, status;
    if (out_lua_status != NULL) *out_lua_status = 0;
    if (!bundle_ok(bundle) || path == NULL || lua_state == NULL || loadbufferx == NULL || chunk_name == NULL)
        return SG_ERR_INVALID_ARGUMENT;
    rc = bundle_lookup(bundle, path, &data, &len);
    if (rc != SG_OK) return rc;
    /* Text only: Lua itself refuses a precompiled chunk, which could otherwise carry bytecode the
     * Lua verifier never sees. */
    status = loadbufferx(lua_state, (const char*)data, len, chunk_name, "t");
    if (out_lua_status != NULL) *out_lua_status = status;
    return status == 0 ? SG_OK : SG_ERR_LUA_LOAD;
}

void SG_CALL sg_bundle_free(sg_bundle* bundle)
{
    if (!bundle_ok(bundle)) return;
    sg_zip_release(&bundle->index); /* sodium_free wipes the plaintext before unmapping it */
    if (bundle->marker != NULL) sodium_free(bundle->marker);
    sodium_memzero(bundle, sizeof *bundle);
    free(bundle);
}
