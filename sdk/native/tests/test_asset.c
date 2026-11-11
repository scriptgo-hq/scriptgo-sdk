/*
 * The asset-escrow tests of libscriptgo (docs/spec/assets.md, "Asset escrow"), through the public C
 * ABI, against the shared library, with the vector packages/escrow/tools/gen-asset-vectors.ts writes
 * (asset_vector.h: the same values as packages/escrow/test/vectors/asset-vectors.json).
 *
 *   sg_asset_tests <case>   one case; exit 0 = pass, 1 = fail
 *   sg_asset_tests          every case
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scriptgo/escrow.h"
#include "asset_vector.h"

static int failures;

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            fprintf(stderr, "  FAILED %s:%d: %s\n", __FILE__, __LINE__, #condition); \
            failures++; \
            return 1; \
        } \
    } while (0)

#define CHECK_RC(expression, expected) \
    do { \
        int rc_ = (expression); \
        if (rc_ != (expected)) { \
            fprintf(stderr, "  FAILED %s:%d: %s = %d (%s), expected %d (%s)\n", __FILE__, __LINE__, #expression, rc_, \
                    sg_strerror(rc_), (expected), sg_strerror(expected)); \
            failures++; \
            return 1; \
        } \
    } while (0)

/* ------------------------------------------------------------------------------------------ helpers */

/* The vector's content key, as the licensed server gets it: unwrapped from the API's server wrap. */
static int server_key(sg_asset_key** out)
{
    sg_identity* server = NULL;
    int rc = sg_identity_import(AVEC_SERVER_PRIVATE, &server);
    if (rc != SG_OK) return rc;
    rc = sg_asset_key_unwrap(server, SG_ASSET_WRAP_SERVER, AVEC_SERVER_EPK, AVEC_SERVER_NONCE, AVEC_SERVER_WRAPPED,
                             AVEC_SERVER_WRAPPED_len, (const uint8_t*)AVEC_SERVER_AAD, strlen(AVEC_SERVER_AAD), out);
    sg_identity_free(server);
    return rc;
}

static int sha_equals(const uint8_t* data, size_t len, const unsigned char* expected)
{
    uint8_t digest[SG_SHA256_BYTES];
    if (sg_sha256(data, len, digest) != SG_OK) return 0;
    return memcmp(digest, expected, SG_SHA256_BYTES) == 0;
}

/* Reads a whole file through a reader into a fresh malloc'd buffer. */
static int read_all(sg_asset_reader* reader, const char* path, uint64_t size, uint8_t** out)
{
    size_t got = 0;
    uint8_t* buf = (uint8_t*)malloc(size > 0 ? (size_t)size : 1);
    int rc;
    if (buf == NULL) return SG_ERR_NO_MEMORY;
    rc = sg_asset_reader_read(reader, path, 0, buf, (size_t)size, &got);
    if (rc == SG_OK && got != size) rc = SG_ERR_BAD_CONTAINER;
    if (rc != SG_OK) {
        free(buf);
        return rc;
    }
    *out = buf;
    return SG_OK;
}

static uint8_t* copy_of(const unsigned char* data, size_t len)
{
    uint8_t* b = (uint8_t*)malloc(len);
    if (b != NULL) memcpy(b, data, len);
    return b;
}

/* ------------------------------------------------------------------------------------------- cases */

static int keys_unwrap_and_rewrap(void)
{
    sg_asset_key* key = NULL;
    sg_asset_key* on_client = NULL;
    sg_identity* session = NULL;
    sg_identity* server = NULL;
    uint8_t session_public[SG_PUBLIC_KEY_BYTES], epk[SG_PUBLIC_KEY_BYTES], nonce[SG_NONCE_BYTES], wrapped[SG_WRAPPED_KEY_BYTES];
    char id[SG_ASSET_KEY_ID_CHARS + 1], id2[SG_ASSET_KEY_ID_CHARS + 1];

    CHECK_RC(server_key(&key), SG_OK);
    CHECK_RC(sg_asset_key_id(key, id, sizeof id), SG_OK);
    CHECK(strcmp(id, AVEC_KEY_ID) == 0);
    CHECK_RC(sg_asset_key_id(key, id, SG_ASSET_KEY_ID_CHARS), SG_ERR_BUFFER_TOO_SMALL);

    /* The server re-wraps it to a session the client made for this connection. */
    CHECK_RC(sg_identity_generate(&session), SG_OK);
    CHECK_RC(sg_identity_public_key(session, session_public), SG_OK);
    CHECK_RC(sg_asset_key_wrap(key, session_public, (const uint8_t*)AVEC_CLIENT_AAD, strlen(AVEC_CLIENT_AAD), epk, nonce, wrapped), SG_OK);
    CHECK_RC(sg_asset_key_unwrap(session, SG_ASSET_WRAP_CLIENT, epk, nonce, wrapped, sizeof wrapped, (const uint8_t*)AVEC_CLIENT_AAD,
                                 strlen(AVEC_CLIENT_AAD), &on_client), SG_OK);
    CHECK_RC(sg_asset_key_id(on_client, id2, sizeof id2), SG_OK);
    CHECK(strcmp(id, id2) == 0);
    sg_asset_key_free(on_client);
    on_client = NULL;

    /* The same wrap is refused under the other kind's label, another aad or another identity. */
    CHECK_RC(sg_asset_key_unwrap(session, SG_ASSET_WRAP_SERVER, epk, nonce, wrapped, sizeof wrapped, (const uint8_t*)AVEC_CLIENT_AAD,
                                 strlen(AVEC_CLIENT_AAD), &on_client), SG_ERR_UNWRAP);
    CHECK_RC(sg_asset_key_unwrap(session, SG_ASSET_WRAP_CLIENT, epk, nonce, wrapped, sizeof wrapped, (const uint8_t*)AVEC_SERVER_AAD,
                                 strlen(AVEC_SERVER_AAD), &on_client), SG_ERR_UNWRAP);
    CHECK_RC(sg_identity_import(AVEC_SERVER_PRIVATE, &server), SG_OK);
    CHECK_RC(sg_asset_key_unwrap(server, SG_ASSET_WRAP_CLIENT, epk, nonce, wrapped, sizeof wrapped, (const uint8_t*)AVEC_CLIENT_AAD,
                                 strlen(AVEC_CLIENT_AAD), &on_client), SG_ERR_UNWRAP);
    CHECK(on_client == NULL);
    /* The server wrap under the client label is refused too. */
    CHECK_RC(sg_asset_key_unwrap(server, SG_ASSET_WRAP_CLIENT, AVEC_SERVER_EPK, AVEC_SERVER_NONCE, AVEC_SERVER_WRAPPED,
                                 AVEC_SERVER_WRAPPED_len, (const uint8_t*)AVEC_SERVER_AAD, strlen(AVEC_SERVER_AAD), &on_client), SG_ERR_UNWRAP);
    /* A small-order public key gives no wrap. */
    memset(session_public, 0, sizeof session_public);
    CHECK_RC(sg_asset_key_wrap(key, session_public, NULL, 0, epk, nonce, wrapped), SG_ERR_INVALID_ARGUMENT);

    sg_identity_free(server);
    sg_identity_free(session);
    sg_asset_key_free(key);
    return 0;
}

static int client_vector_unwrap(void)
{
    sg_identity* client = NULL;
    sg_asset_key* key = NULL;
    char id[SG_ASSET_KEY_ID_CHARS + 1];
    CHECK_RC(sg_identity_import(AVEC_CLIENT_PRIVATE, &client), SG_OK);
    CHECK_RC(sg_asset_key_unwrap(client, SG_ASSET_WRAP_CLIENT, AVEC_CLIENT_EPK, AVEC_CLIENT_NONCE, AVEC_CLIENT_WRAPPED,
                                 AVEC_CLIENT_WRAPPED_len, (const uint8_t*)AVEC_CLIENT_AAD, strlen(AVEC_CLIENT_AAD), &key), SG_OK);
    CHECK_RC(sg_asset_key_id(key, id, sizeof id), SG_OK);
    CHECK(strcmp(id, AVEC_KEY_ID) == 0);
    sg_asset_key_free(key);
    sg_identity_free(client);
    return 0;
}

static int container_good_path(void)
{
    sg_asset_container* c = NULL;
    sg_asset_reader* r = NULL;
    sg_asset_key* key = NULL;
    const char* value = NULL;
    size_t count = 0, i;

    CHECK_RC(sg_asset_container_open(AVEC_CONTAINER, AVEC_CONTAINER_len, AVEC_SIGNER, &c), SG_OK);
    CHECK_RC(sg_asset_container_field(c, "package", &value), SG_OK);
    CHECK(strcmp(value, "kestrel//night-market") == 0);
    CHECK_RC(sg_asset_container_field(c, "deployment", &value), SG_OK);
    CHECK(strcmp(value, "dep_7") == 0);
    CHECK_RC(sg_asset_container_field(c, "keyId", &value), SG_OK);
    CHECK(strcmp(value, AVEC_KEY_ID) == 0);
    CHECK_RC(sg_asset_container_field(c, "fingerprint", &value), SG_OK);
    CHECK_RC(sg_asset_container_field(c, "nope", &value), SG_ERR_NOT_FOUND);
    CHECK_RC(sg_asset_container_file_count(c, &count), SG_OK);
    CHECK(count == AVEC_FILE_COUNT);
    /* No reader before a key. */
    CHECK_RC(sg_asset_reader_new(c, &r), SG_ERR_INVALID_ARGUMENT);

    CHECK_RC(server_key(&key), SG_OK);
    CHECK_RC(sg_asset_container_bind(c, key), SG_OK);
    CHECK_RC(sg_asset_container_bind(c, key), SG_ERR_INVALID_ARGUMENT); /* once */
    sg_asset_key_free(key); /* the container keeps its own copy */
    CHECK_RC(sg_asset_reader_new(c, &r), SG_OK);

    for (i = 0; i < count; i++) {
        const char* path = NULL;
        uint64_t size = 0;
        uint8_t* all = NULL;
        CHECK_RC(sg_asset_container_file_at(c, i, &path, &size), SG_OK);
        CHECK(strcmp(path, AVEC_FILE_PATHS[i]) == 0);
        CHECK(size == AVEC_FILE_BYTES[i]);
        CHECK_RC(read_all(r, path, size, &all), SG_OK);
        CHECK(sha_equals(all, (size_t)size, AVEC_FILE_SHA256[i]));
        /* Ranges across chunk boundaries equal the same slice of the whole file. */
        if (size > 5000) {
            static const uint64_t offsets[] = { 0, 1, 4095, 4096, 4097, 8000, 9003 };
            size_t k;
            for (k = 0; k < sizeof offsets / sizeof offsets[0]; k++) {
                uint8_t part[300];
                size_t got = 0;
                uint64_t want = size - offsets[k] < sizeof part ? size - offsets[k] : sizeof part;
                CHECK_RC(sg_asset_reader_read(r, path, offsets[k], part, sizeof part, &got), SG_OK);
                CHECK(got == want);
                CHECK(memcmp(part, all + offsets[k], got) == 0);
            }
            {
                uint8_t part[8];
                size_t got = 99;
                CHECK_RC(sg_asset_reader_read(r, path, size, part, sizeof part, &got), SG_OK); /* at the end */
                CHECK(got == 0);
            }
        }
        free(all);
    }
    {
        uint8_t b[4];
        size_t got = 0;
        CHECK_RC(sg_asset_reader_read(r, "textures/missing.png", 0, b, sizeof b, &got), SG_ERR_NOT_FOUND);
    }
    sg_asset_reader_free(r);
    sg_asset_container_free(c);
    return 0;
}

static int container_refuses_other_key(void)
{
    sg_identity* client = NULL;
    sg_asset_key* other = NULL;
    sg_asset_container* c = NULL;
    CHECK_RC(sg_identity_import(AVEC_CLIENT_PRIVATE, &client), SG_OK);
    /* Another deployment's key unwraps (it was wrapped to this session) but is not this container's. */
    CHECK_RC(sg_asset_key_unwrap(client, SG_ASSET_WRAP_CLIENT, AVEC_OTHER_EPK, AVEC_OTHER_NONCE, AVEC_OTHER_WRAPPED,
                                 AVEC_OTHER_WRAPPED_len, (const uint8_t*)AVEC_CLIENT_AAD, strlen(AVEC_CLIENT_AAD), &other), SG_OK);
    CHECK_RC(sg_asset_container_open(AVEC_CONTAINER, AVEC_CONTAINER_len, NULL, &c), SG_OK);
    CHECK_RC(sg_asset_container_bind(c, other), SG_ERR_KEY_MISMATCH);
    sg_asset_container_free(c);
    sg_asset_key_free(other);
    sg_identity_free(client);
    return 0;
}

static int container_refuses_tampering(void)
{
    sg_asset_container* c = NULL;
    uint8_t* b = copy_of(AVEC_CONTAINER, AVEC_CONTAINER_len);
    uint8_t other_signer[SG_PUBLIC_KEY_BYTES];
    uint32_t header_len;
    CHECK(b != NULL);
    header_len = (uint32_t)b[8] | ((uint32_t)b[9] << 8) | ((uint32_t)b[10] << 16) | ((uint32_t)b[11] << 24);

    /* A ciphertext byte: the file's signed hash no longer matches. */
    b[AVEC_CONTAINER_len - 1] ^= 1;
    CHECK_RC(sg_asset_container_open(b, AVEC_CONTAINER_len, NULL, &c), SG_ERR_PAYLOAD_HASH);
    b[AVEC_CONTAINER_len - 1] ^= 1;

    /* A header byte inside a string value: the signature no longer verifies. */
    {
        const char* at = strstr((const char*)b + 12, "\"release\":\"rel_01\"");
        CHECK(at != NULL);
        b[(size_t)(at - (const char*)b) + 12] = 'X'; /* rel_01 -> rXl_01 */
        CHECK_RC(sg_asset_container_open(b, AVEC_CONTAINER_len, NULL, &c), SG_ERR_BAD_SIGNATURE);
        b[(size_t)(at - (const char*)b) + 12] = 'e';
    }

    /* Another pinned signer. */
    memcpy(other_signer, AVEC_SIGNER, sizeof other_signer);
    other_signer[0] ^= 1;
    CHECK_RC(sg_asset_container_open(b, AVEC_CONTAINER_len, other_signer, &c), SG_ERR_UNTRUSTED_SIGNER);

    /* Preamble, version, reserved bytes, header length, truncation. */
    b[0] = 'X';
    CHECK_RC(sg_asset_container_open(b, AVEC_CONTAINER_len, NULL, &c), SG_ERR_BAD_CONTAINER);
    b[0] = 'S';
    b[4] = 2;
    CHECK_RC(sg_asset_container_open(b, AVEC_CONTAINER_len, NULL, &c), SG_ERR_BAD_CONTAINER);
    b[4] = 1;
    b[6] = 1;
    CHECK_RC(sg_asset_container_open(b, AVEC_CONTAINER_len, NULL, &c), SG_ERR_BAD_CONTAINER);
    b[6] = 0;
    CHECK_RC(sg_asset_container_open(b, AVEC_CONTAINER_len - 1, NULL, &c), SG_ERR_BAD_CONTAINER);
    CHECK_RC(sg_asset_container_open(b, 12 + header_len - 1, NULL, &c), SG_ERR_BAD_CONTAINER);

    /* Non-canonical JSON: the first key's opening brace followed by a space (length unchanged by
     * overwriting the brace's neighbour would break the JSON anyway): both refused before the signature. */
    {
        uint8_t saved = b[12 + 1];
        b[12 + 1] = ' ';
        CHECK_RC(sg_asset_container_open(b, AVEC_CONTAINER_len, NULL, &c), SG_ERR_BAD_CONTAINER);
        b[12 + 1] = saved;
    }
    CHECK_RC(sg_asset_container_open(b, AVEC_CONTAINER_len, NULL, &c), SG_OK);
    sg_asset_container_free(c);
    free(b);
    return 0;
}

/* The container borrows its bytes: a chunk changed after open fails authentication on read, and no
 * byte of the range is handed out. */
static int reader_refuses_changed_chunk(void)
{
    sg_asset_container* c = NULL;
    sg_asset_reader* r = NULL;
    sg_asset_key* key = NULL;
    uint8_t* b = copy_of(AVEC_CONTAINER, AVEC_CONTAINER_len);
    uint8_t out[64];
    size_t got = 7;
    CHECK(b != NULL);
    CHECK_RC(sg_asset_container_open(b, AVEC_CONTAINER_len, AVEC_SIGNER, &c), SG_OK);
    CHECK_RC(server_key(&key), SG_OK);
    CHECK_RC(sg_asset_container_bind(c, key), SG_OK);
    CHECK_RC(sg_asset_reader_new(c, &r), SG_OK);
    CHECK_RC(sg_asset_reader_read(r, AVEC_FILE_PATHS[0], 0, out, sizeof out, &got), SG_OK);
    CHECK(got == sizeof out);
    /* The first file's second chunk starts at body + 4096 + 16; flip a byte in it. */
    {
        uint32_t header_len = (uint32_t)b[8] | ((uint32_t)b[9] << 8) | ((uint32_t)b[10] << 16) | ((uint32_t)b[11] << 24);
        b[12 + header_len + 4096 + 16 + 10] ^= 0x80;
    }
    memset(out, 0xee, sizeof out);
    CHECK_RC(sg_asset_reader_read(r, AVEC_FILE_PATHS[0], 4090, out, sizeof out, &got), SG_ERR_DECRYPT);
    CHECK(got == 0);
    {
        size_t i;
        for (i = 0; i < sizeof out; i++) CHECK(out[i] == 0 || out[i] == 0xee); /* nothing decrypted handed out */
    }
    sg_asset_reader_free(r);
    sg_asset_key_free(key);
    sg_asset_container_free(c);
    free(b);
    return 0;
}

static int escrowed_preload_vector(void)
{
    sg_asset_container* c = NULL;
    sg_asset_reader* r = NULL;
    sg_asset_key* key = NULL;
    size_t count = 0, i;
    CHECK_RC(sg_asset_container_open(AVEC_PRELOAD_CONTAINER, AVEC_PRELOAD_CONTAINER_len, AVEC_PRELOAD_SIGNER, &c), SG_OK);
    CHECK_RC(sg_asset_container_file_count(c, &count), SG_OK);
    CHECK(count == AVEC_PRELOAD_FILE_COUNT);
    CHECK_RC(server_key(&key), SG_OK); /* the same release and deployment: the same key */
    CHECK_RC(sg_asset_container_bind(c, key), SG_OK);
    CHECK_RC(sg_asset_reader_new(c, &r), SG_OK);
    for (i = 0; i < count; i++) {
        const char* path = NULL;
        uint64_t size = 0;
        uint8_t* all = NULL;
        CHECK_RC(sg_asset_container_file_at(c, i, &path, &size), SG_OK);
        CHECK(strcmp(path, AVEC_PRELOAD_PATHS[i]) == 0);
        CHECK_RC(read_all(r, path, size, &all), SG_OK);
        CHECK(sha_equals(all, (size_t)size, AVEC_PRELOAD_SHA256[i]));
        free(all);
    }
    sg_asset_reader_free(r);
    sg_asset_key_free(key);
    sg_asset_container_free(c);
    return 0;
}

/* Random damage to the container: never a crash, and anything that still opens is unchanged. */
static int container_survives_mutations(void)
{
    uint8_t* b = copy_of(AVEC_CONTAINER, AVEC_CONTAINER_len);
    uint32_t seed = 0x5eed1234u;
    unsigned i, opened = 0;
    CHECK(b != NULL);
    for (i = 0; i < 20000; i++) {
        sg_asset_container* c = NULL;
        size_t pos, len = AVEC_CONTAINER_len;
        uint8_t old;
        seed = seed * 1664525u + 1013904223u;
        /* Mostly the preamble and the header, where the parser is. */
        pos = (seed >> 8) % (i % 4 == 0 ? AVEC_CONTAINER_len : 1100u);
        old = b[pos];
        b[pos] = (uint8_t)(seed >> 3);
        if (i % 7 == 0) len = pos + 1;
        if (sg_asset_container_open(b, len, NULL, &c) == SG_OK) {
            opened++;
            sg_asset_container_free(c);
            CHECK(len == AVEC_CONTAINER_len && b[pos] == old); /* only a no-op change may still open */
        }
        b[pos] = old;
    }
    printf("  %u of 20000 damaged copies opened (unchanged bytes)\n", opened);
    free(b);
    return 0;
}

static int handles_reject_misuse(void)
{
    sg_asset_container* c = NULL;
    sg_asset_key* key = NULL;
    sg_asset_reader* r = NULL;
    uint8_t buf[4];
    size_t got = 0;
    const char* v = NULL;
    CHECK_RC(sg_asset_container_open(NULL, 0, NULL, &c), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_asset_container_open(AVEC_CONTAINER, AVEC_CONTAINER_len, NULL, NULL), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_asset_container_field(NULL, "package", &v), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_asset_container_bind(NULL, NULL), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_asset_reader_new(NULL, &r), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_asset_reader_read(NULL, "x", 0, buf, sizeof buf, &got), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_asset_key_unwrap(NULL, SG_ASSET_WRAP_CLIENT, AVEC_CLIENT_EPK, AVEC_CLIENT_NONCE, AVEC_CLIENT_WRAPPED,
                                 AVEC_CLIENT_WRAPPED_len, NULL, 0, &key), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(server_key(&key), SG_OK);
    CHECK_RC(sg_asset_key_wrap(key, NULL, NULL, 0, buf, buf, buf), SG_ERR_INVALID_ARGUMENT);
    {
        sg_identity* id = NULL;
        CHECK_RC(sg_identity_generate(&id), SG_OK);
        CHECK_RC(sg_asset_key_unwrap(id, 3, AVEC_CLIENT_EPK, AVEC_CLIENT_NONCE, AVEC_CLIENT_WRAPPED, AVEC_CLIENT_WRAPPED_len, NULL, 0, &key),
                 SG_ERR_INVALID_ARGUMENT);
        sg_identity_free(id);
    }
    sg_asset_key_free(key);
    sg_asset_key_free(NULL);
    sg_asset_container_free(NULL);
    sg_asset_reader_free(NULL);
    return 0;
}

/* ------------------------------------------------------------------------------------------- driver */

typedef struct test_case {
    const char* name;
    int (*run)(void);
} test_case;

static const test_case CASES[] = {
    { "asset_keys_unwrap_and_rewrap", keys_unwrap_and_rewrap },
    { "asset_client_vector_unwrap", client_vector_unwrap },
    { "asset_container_good_path", container_good_path },
    { "asset_container_refuses_other_key", container_refuses_other_key },
    { "asset_container_refuses_tampering", container_refuses_tampering },
    { "asset_reader_refuses_changed_chunk", reader_refuses_changed_chunk },
    { "asset_escrowed_preload_vector", escrowed_preload_vector },
    { "asset_container_survives_mutations", container_survives_mutations },
    { "asset_handles_reject_misuse", handles_reject_misuse },
};

int main(int argc, char** argv)
{
    size_t i;
    int ran = 0;
    if (sg_init() != SG_OK) {
        fprintf(stderr, "sg_init failed (no hardware AES?)\n");
        return 77;
    }
    for (i = 0; i < sizeof CASES / sizeof CASES[0]; i++) {
        if (argc > 1 && strcmp(argv[1], CASES[i].name) != 0) continue;
        printf("%s\n", CASES[i].name);
        CASES[i].run();
        ran++;
    }
    if (ran == 0) {
        fprintf(stderr, "no case named %s\n", argc > 1 ? argv[1] : "?");
        return 1;
    }
    return failures == 0 ? 0 : 1;
}
