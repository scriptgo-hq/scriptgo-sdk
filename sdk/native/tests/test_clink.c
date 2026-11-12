/*
 * The client-code-escrow tests of libscriptgo (docs/spec/client-escrow.md), through the public C ABI,
 * against the shared library, with the vector packages/escrow/tools/gen-client-vectors.ts writes
 * (client_vector.h: the same values as packages/escrow/test/vectors/client-vectors.json).
 *
 *   sg_clink_tests <case>   one case; exit 0 = pass, 1 = fail, 77 = skipped
 *   sg_clink_tests          every case
 *
 * The Lua cases load a Lua 5.4 shared library named by SG_TEST_LUA_LIBRARY (as test_escrow.c does)
 * and run the vector's bytecode in it: the bytecode was compiled by the SDK's Lua 5.4.8 compiler,
 * and Lua 5.4.x share the dump format, so any 5.4 library loads it.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#else
#  include <dlfcn.h>
#endif

#include "scriptgo/escrow.h"
#include "client_vector.h"

#define SKIPPED 77

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

static int session_key(const unsigned char* epk, const unsigned char* nonce, const unsigned char* wrapped, sg_asset_key** out)
{
    sg_identity* session = NULL;
    int rc = sg_identity_import(CVEC_SESSION_PRIVATE, &session);
    if (rc != SG_OK) return rc;
    rc = sg_asset_key_unwrap(session, SG_CLIENT_WRAP_SESSION, epk, nonce, wrapped, CVEC_SESSION_WRAPPED_len,
                             (const uint8_t*)CVEC_SESSION_AAD, strlen(CVEC_SESSION_AAD), out);
    sg_identity_free(session);
    return rc;
}

static int open_bound(const unsigned char* data, size_t len, sg_clink** out)
{
    sg_asset_key* key = NULL;
    int rc = sg_clink_container_open(data, len, CVEC_SIGNER, out);
    if (rc != SG_OK) return rc;
    rc = session_key(CVEC_SESSION_EPK, CVEC_SESSION_NONCE, CVEC_SESSION_WRAPPED, &key);
    if (rc == SG_OK) rc = sg_clink_container_bind(*out, key);
    sg_asset_key_free(key);
    return rc;
}

static uint8_t* copy_of(const unsigned char* data, size_t len)
{
    uint8_t* b = (uint8_t*)malloc(len);
    if (b != NULL) memcpy(b, data, len);
    return b;
}

/* The bytes of the first chunk's ciphertext start after the header. */
static size_t body_offset(const unsigned char* container)
{
    return 12u + ((size_t)container[8] | ((size_t)container[9] << 8) | ((size_t)container[10] << 16) | ((size_t)container[11] << 24));
}

static int noop_loadbufferx(void* L, const char* buffer, size_t size, const char* name, const char* mode)
{
    (void)L; (void)buffer; (void)size; (void)name; (void)mode;
    return 0;
}

/* ------------------------------------------------------------------------------------------- cases */

static int clink_keys_unwrap_and_rewrap(void)
{
    sg_identity* server = NULL;
    sg_identity* session = NULL;
    sg_asset_key* key = NULL;
    sg_asset_key* asset_kind = NULL;
    sg_asset_key* again = NULL;
    char id[SG_ASSET_KEY_ID_CHARS + 1];
    uint8_t pub[SG_PUBLIC_KEY_BYTES], epk[SG_PUBLIC_KEY_BYTES], nonce[SG_NONCE_BYTES], wrapped[SG_WRAPPED_KEY_BYTES];

    CHECK_RC(sg_identity_import(CVEC_SERVER_PRIVATE, &server), SG_OK);
    /* The API's server wrap, kind "client": the client-code key and its id. */
    CHECK_RC(sg_asset_key_unwrap(server, SG_CLIENT_WRAP_SERVER, CVEC_SERVER_EPK, CVEC_SERVER_NONCE, CVEC_SERVER_WRAPPED,
                                 CVEC_SERVER_WRAPPED_len, (const uint8_t*)CVEC_SERVER_AAD, strlen(CVEC_SERVER_AAD), &key), SG_OK);
    CHECK_RC(sg_asset_key_id(key, id, sizeof id), SG_OK);
    CHECK(strcmp(id, CVEC_KEY_ID) == 0);
    /* The same wrap read as an asset key: same 32 bytes, another id, so it opens no client container. */
    CHECK_RC(sg_asset_key_unwrap(server, SG_ASSET_WRAP_SERVER, CVEC_SERVER_EPK, CVEC_SERVER_NONCE, CVEC_SERVER_WRAPPED,
                                 CVEC_SERVER_WRAPPED_len, (const uint8_t*)CVEC_SERVER_AAD, strlen(CVEC_SERVER_AAD), &asset_kind), SG_OK);
    CHECK_RC(sg_asset_key_id(asset_kind, id, sizeof id), SG_OK);
    CHECK(strcmp(id, CVEC_KEY_ID) != 0);
    /* Server -> session: the re-wrap uses the client-code session label, so only that kind opens it. */
    CHECK_RC(sg_identity_generate(&session), SG_OK);
    CHECK_RC(sg_identity_public_key(session, pub), SG_OK);
    CHECK_RC(sg_asset_key_wrap(key, pub, (const uint8_t*)CVEC_SESSION_AAD, strlen(CVEC_SESSION_AAD), epk, nonce, wrapped), SG_OK);
    CHECK_RC(sg_asset_key_unwrap(session, SG_ASSET_WRAP_CLIENT, epk, nonce, wrapped, sizeof wrapped,
                                 (const uint8_t*)CVEC_SESSION_AAD, strlen(CVEC_SESSION_AAD), &again), SG_ERR_UNWRAP);
    CHECK_RC(sg_asset_key_unwrap(session, SG_CLIENT_WRAP_SESSION, epk, nonce, wrapped, sizeof wrapped,
                                 (const uint8_t*)CVEC_SESSION_AAD, strlen(CVEC_SESSION_AAD), &again), SG_OK);
    CHECK_RC(sg_asset_key_id(again, id, sizeof id), SG_OK);
    CHECK(strcmp(id, CVEC_KEY_ID) == 0);
    /* A wrong aad or kind is refused. */
    sg_asset_key_free(again);
    again = NULL;
    CHECK_RC(sg_asset_key_unwrap(session, SG_CLIENT_WRAP_SESSION, epk, nonce, wrapped, sizeof wrapped,
                                 (const uint8_t*)"x", 1, &again), SG_ERR_UNWRAP);
    CHECK_RC(sg_asset_key_unwrap(session, 9, epk, nonce, wrapped, sizeof wrapped, NULL, 0, &again), SG_ERR_INVALID_ARGUMENT);
    sg_asset_key_free(key);
    sg_asset_key_free(asset_kind);
    sg_identity_free(server);
    sg_identity_free(session);
    return 0;
}

static int clink_container_good_path(void)
{
    sg_clink* c = NULL;
    const char* value = NULL;
    const char* path = NULL;
    size_t count = 0, size = 0, i;
    int status = -1;
    CHECK_RC(open_bound(CVEC_CONTAINER, CVEC_CONTAINER_len, &c), SG_OK);
    CHECK_RC(sg_clink_container_field(c, "keyId", &value), SG_OK);
    CHECK(strcmp(value, CVEC_KEY_ID) == 0);
    CHECK_RC(sg_clink_container_field(c, "strip", &value), SG_OK);
    CHECK(strcmp(value, "full") == 0);
    CHECK_RC(sg_clink_container_field(c, "lua", &value), SG_OK);
    CHECK(strcmp(value, "5.4.8") == 0);
    CHECK_RC(sg_clink_container_field(c, "package", &value), SG_OK);
    CHECK(strcmp(value, "kestrel//night-market") == 0);
    CHECK_RC(sg_clink_container_field(c, "nope", &value), SG_ERR_NOT_FOUND);
    CHECK_RC(sg_clink_chunk_count(c, &count), SG_OK);
    CHECK(count == CVEC_CHUNK_COUNT);
    for (i = 0; i < count; i++) {
        CHECK_RC(sg_clink_chunk_at(c, i, &path, &size), SG_OK);
        CHECK(strcmp(path, CVEC_CHUNK_PATHS[i]) == 0 && size == CVEC_CHUNK_BYTES[i]);
    }
    /* Loading before the target is checked is refused: never feed an unchecked VM. */
    CHECK_RC(sg_clink_lua_load(c, "client/main.lua", (void*)1, noop_loadbufferx, &status), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_clink_target_check(c, CVEC_LUAC_HEADER, CVEC_LUAC_HEADER_len), SG_OK);
    CHECK_RC(sg_clink_lua_load(c, "client/main.lua", (void*)1, noop_loadbufferx, &status), SG_OK);
    CHECK_RC(sg_clink_lua_load(c, "client/none.lua", (void*)1, noop_loadbufferx, &status), SG_ERR_NOT_FOUND);
    sg_clink_container_free(c);
    return 0;
}

static int clink_refuses_other_keys(void)
{
    sg_clink* c = NULL;
    sg_asset_key* other = NULL;
    sg_asset_key* asset = NULL;
    CHECK_RC(sg_clink_container_open(CVEC_CONTAINER, CVEC_CONTAINER_len, CVEC_SIGNER, &c), SG_OK);
    /* Another deployment's key unwraps (the session wrap is genuine) but is not this container's. */
    CHECK_RC(session_key(CVEC_OTHER_EPK, CVEC_OTHER_NONCE, CVEC_OTHER_WRAPPED, &other), SG_OK);
    CHECK_RC(sg_clink_container_bind(c, other), SG_ERR_KEY_MISMATCH);
    /* The deployment's asset key, handed over as a client-code key, does not open client code. */
    CHECK_RC(session_key(CVEC_ASSETKEY_EPK, CVEC_ASSETKEY_NONCE, CVEC_ASSETKEY_WRAPPED, &asset), SG_OK);
    CHECK_RC(sg_clink_container_bind(c, asset), SG_ERR_KEY_MISMATCH);
    sg_asset_key_free(other);
    sg_asset_key_free(asset);
    sg_clink_container_free(c);
    return 0;
}

static int clink_refuses_tampering(void)
{
    sg_clink* c = NULL;
    uint8_t* bad;
    uint8_t wrong_signer[SG_PUBLIC_KEY_BYTES];
    size_t body = body_offset(CVEC_CONTAINER);
    int status;

    /* A flipped ciphertext byte: opens (the table is signed, not the body), never loads. */
    bad = copy_of(CVEC_CONTAINER, CVEC_CONTAINER_len);
    CHECK(bad != NULL);
    bad[body + 40] ^= 1;
    CHECK_RC(open_bound(bad, CVEC_CONTAINER_len, &c), SG_OK);
    CHECK_RC(sg_clink_target_check(c, CVEC_LUAC_HEADER, CVEC_LUAC_HEADER_len), SG_OK);
    CHECK_RC(sg_clink_lua_load(c, CVEC_CHUNK_PATHS[0], (void*)1, noop_loadbufferx, &status), SG_ERR_DECRYPT);
    sg_clink_container_free(c);
    c = NULL;
    free(bad);

    /* A header byte changed: the signature (or the canonical form) refuses it. */
    bad = copy_of(CVEC_CONTAINER, CVEC_CONTAINER_len);
    CHECK(bad != NULL);
    {
        static const char needle[] = "\"release\":\"rel_01\"";
        size_t k, n = sizeof needle - 1, found = 0;
        for (k = 12; k + n <= body; k++) {
            if (memcmp(bad + k, needle, n) == 0) { found = k; break; }
        }
        CHECK(found != 0);
        bad[found + 16] = '2'; /* "rel_01" -> "rel_02": still a valid header, no longer what was signed */
    }
    CHECK_RC(sg_clink_container_open(bad, CVEC_CONTAINER_len, NULL, &c), SG_ERR_BAD_SIGNATURE);
    CHECK(c == NULL);
    free(bad);

    /* A truncated body, an unpinned signer. */
    CHECK_RC(sg_clink_container_open(CVEC_CONTAINER, CVEC_CONTAINER_len - 1, NULL, &c), SG_ERR_BAD_CONTAINER);
    memset(wrong_signer, 7, sizeof wrong_signer);
    CHECK_RC(sg_clink_container_open(CVEC_CONTAINER, CVEC_CONTAINER_len, wrong_signer, &c), SG_ERR_UNTRUSTED_SIGNER);
    /* An asset container is not a client container. */
    bad = copy_of(CVEC_CONTAINER, CVEC_CONTAINER_len);
    CHECK(bad != NULL);
    memcpy(bad, "SGAE", 4);
    CHECK_RC(sg_clink_container_open(bad, CVEC_CONTAINER_len, NULL, &c), SG_ERR_BAD_CONTAINER);
    free(bad);
    return 0;
}

static int clink_refuses_other_targets(void)
{
    sg_clink* c = NULL;
    uint8_t other[SG_CLINK_LUAC_HEADER_BYTES];
    int status;

    /* The host's VM is not the container's target. */
    CHECK_RC(open_bound(CVEC_CONTAINER, CVEC_CONTAINER_len, &c), SG_OK);
    memcpy(other, CVEC_LUAC_HEADER, sizeof other);
    other[4] = 0x53; /* Lua 5.3 */
    CHECK_RC(sg_clink_target_check(c, other, sizeof other), SG_ERR_TARGET_MISMATCH);
    CHECK_RC(sg_clink_lua_load(c, CVEC_CHUNK_PATHS[0], (void*)1, noop_loadbufferx, &status), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_clink_target_check(c, other, 4), SG_ERR_INVALID_ARGUMENT);
    sg_clink_container_free(c);
    c = NULL;

    /* A container compiled for another VM. */
    CHECK_RC(open_bound(CVEC_FOREIGN_TARGET, CVEC_FOREIGN_TARGET_len, &c), SG_OK);
    CHECK_RC(sg_clink_target_check(c, CVEC_LUAC_HEADER, CVEC_LUAC_HEADER_len), SG_ERR_TARGET_MISMATCH);
    sg_clink_container_free(c);
    c = NULL;

    /* A container that declares this VM over bytes that are not its bytecode: refused after decryption. */
    CHECK_RC(open_bound(CVEC_LYING, CVEC_LYING_len, &c), SG_OK);
    CHECK_RC(sg_clink_target_check(c, CVEC_LUAC_HEADER, CVEC_LUAC_HEADER_len), SG_OK);
    CHECK_RC(sg_clink_lua_load(c, CVEC_CHUNK_PATHS[0], (void*)1, noop_loadbufferx, &status), SG_ERR_TARGET_MISMATCH);
    sg_clink_container_free(c);
    c = NULL;

    /* An opcode-permutation generation this reader does not support. */
    CHECK_RC(sg_clink_container_open(CVEC_PERMUTED, CVEC_PERMUTED_len, CVEC_SIGNER, &c), SG_ERR_BAD_CONTAINER);
    return 0;
}

static int clink_container_survives_mutations(void)
{
    /* Every single-byte change of the header must be refused or still parse to a consistent container. */
    size_t header_end = body_offset(CVEC_CONTAINER), i;
    uint8_t* bad = copy_of(CVEC_CONTAINER, CVEC_CONTAINER_len);
    CHECK(bad != NULL);
    for (i = 0; i < header_end; i++) {
        sg_clink* c = NULL;
        uint8_t saved = bad[i];
        bad[i] = (uint8_t)(saved ^ 0x5a);
        if (sg_clink_container_open(bad, CVEC_CONTAINER_len, NULL, &c) == SG_OK) {
            /* Only a change the signature does not cover (none in the header) could pass. */
            sg_clink_container_free(c);
            free(bad);
            CHECK(!"a mutated header was accepted");
        }
        bad[i] = saved;
    }
    free(bad);
    return 0;
}

/* -------------------------------------------------------------------------------- through real Lua */

typedef void* (SG_CALL *luaL_newstate_fn)(void);
typedef void (SG_CALL *lua_close_fn)(void*);
typedef int (SG_CALL *lua_pcallk_fn)(void*, int, int, int, intptr_t, void*);
typedef const char* (SG_CALL *lua_tolstring_fn)(void*, int, size_t*);
typedef long long (SG_CALL *lua_tointegerx_fn)(void*, int, int*);
typedef int (SG_CALL *lua_getfield_fn)(void*, int, const char*);
typedef int (SG_CALL *lua_getglobal_fn)(void*, const char*);
typedef int (SG_CALL *lua_gettop_fn)(void*);
typedef void (SG_CALL *lua_settop_fn)(void*, int);
typedef int (SG_CALL *lua_type_fn)(void*, int);
typedef int (SG_CALL *lua_writer_fn)(void*, const void*, size_t, void*);
typedef int (SG_CALL *lua_dump_fn)(void*, lua_writer_fn, void*, int);
typedef int (SG_CALL *luaL_loadstring_fn)(void*, const char*);
typedef void (SG_CALL *lua_createtable_fn)(void*, int, int);

static void* lua_symbol(void* library, const char* name)
{
#if defined(_WIN32)
    return (void*)(uintptr_t)GetProcAddress((HMODULE)library, name);
#else
    return dlsym(library, name);
#endif
}

typedef struct dump_buf {
    uint8_t data[SG_CLINK_LUAC_HEADER_BYTES];
    size_t len;
} dump_buf;

static int SG_CALL header_writer(void* L, const void* p, size_t sz, void* ud)
{
    dump_buf* b = (dump_buf*)ud;
    size_t take = sz;
    (void)L;
    if (b->len >= sizeof b->data) return 0;
    if (take > sizeof b->data - b->len) take = sizeof b->data - b->len;
    memcpy(b->data + b->len, p, take);
    b->len += take;
    return 0;
}

static int clink_lua_load_through_real_lua(void)
{
    const char* library_path = getenv("SG_TEST_LUA_LIBRARY");
    void* library;
    void* L;
    luaL_newstate_fn newstate;
    lua_close_fn close_state;
    sg_lua_loadbufferx_fn loadbufferx;
    lua_pcallk_fn pcallk;
    lua_tolstring_fn tolstring;
    lua_tointegerx_fn tointegerx;
    lua_getfield_fn getfield;
    lua_getglobal_fn getglobal;
    lua_gettop_fn gettop;
    lua_settop_fn settop;
    lua_type_fn type;
    lua_dump_fn dump;
    luaL_loadstring_fn loadstring;
    lua_createtable_fn createtable;
    sg_clink* c = NULL;
    dump_buf header;
    const char* message;
    int status = -1, is_number = 0;

    if (library_path == NULL || library_path[0] == '\0') {
        printf("  skipped: set SG_TEST_LUA_LIBRARY to a Lua 5.4 shared library\n");
        return SKIPPED;
    }
#if defined(_WIN32)
    library = (void*)LoadLibraryA(library_path);
#else
    library = dlopen(library_path, RTLD_NOW | RTLD_LOCAL);
#endif
    CHECK(library != NULL);
    newstate = (luaL_newstate_fn)(uintptr_t)lua_symbol(library, "luaL_newstate");
    close_state = (lua_close_fn)(uintptr_t)lua_symbol(library, "lua_close");
    loadbufferx = (sg_lua_loadbufferx_fn)(uintptr_t)lua_symbol(library, "luaL_loadbufferx");
    pcallk = (lua_pcallk_fn)(uintptr_t)lua_symbol(library, "lua_pcallk");
    tolstring = (lua_tolstring_fn)(uintptr_t)lua_symbol(library, "lua_tolstring");
    tointegerx = (lua_tointegerx_fn)(uintptr_t)lua_symbol(library, "lua_tointegerx");
    getfield = (lua_getfield_fn)(uintptr_t)lua_symbol(library, "lua_getfield");
    getglobal = (lua_getglobal_fn)(uintptr_t)lua_symbol(library, "lua_getglobal");
    gettop = (lua_gettop_fn)(uintptr_t)lua_symbol(library, "lua_gettop");
    settop = (lua_settop_fn)(uintptr_t)lua_symbol(library, "lua_settop");
    type = (lua_type_fn)(uintptr_t)lua_symbol(library, "lua_type");
    dump = (lua_dump_fn)(uintptr_t)lua_symbol(library, "lua_dump");
    loadstring = (luaL_loadstring_fn)(uintptr_t)lua_symbol(library, "luaL_loadstring");
    createtable = (lua_createtable_fn)(uintptr_t)lua_symbol(library, "lua_createtable");
    CHECK(newstate && close_state && loadbufferx && pcallk && tolstring && tointegerx && getfield && getglobal && gettop && settop
          && type && dump && loadstring && createtable);

    L = newstate();
    CHECK(L != NULL);
    /* The host VM's own LUAC header, the way a host learns it: dump a function and keep 31 bytes. */
    CHECK(loadstring(L, "return 0") == 0);
    memset(&header, 0, sizeof header);
    CHECK(dump(L, header_writer, &header, 1) == 0 && header.len == SG_CLINK_LUAC_HEADER_BYTES);
    CHECK(memcmp(header.data, CVEC_LUAC_HEADER, SG_CLINK_LUAC_HEADER_BYTES) == 0);
    settop(L, 0);

    CHECK_RC(open_bound(CVEC_CONTAINER, CVEC_CONTAINER_len, &c), SG_OK);
    CHECK_RC(sg_clink_target_check(c, header.data, header.len), SG_OK);

    /* The entry chunk: compiled from native memory, run, its global and its table observed. */
    CHECK_RC(sg_clink_lua_load(c, "client/main.lua", L, loadbufferx, &status), SG_OK);
    CHECK(status == 0 && gettop(L) == 1 && type(L, -1) == 6 /* LUA_TFUNCTION */);
    CHECK(pcallk(L, 0, 1, 0, 0, NULL) == 0);
    CHECK(type(L, -1) == 5 /* LUA_TTABLE */);
    getfield(L, -1, "answer");
    CHECK(tointegerx(L, -1, &is_number) == 42 && is_number);
    settop(L, 1);
    getfield(L, -1, "tag");
    message = tolstring(L, -1, NULL);
    CHECK(message != NULL && strcmp(message, "sgce-vector-constant") == 0);
    settop(L, 0);
    getglobal(L, "SGCE_LOADED");
    CHECK(tointegerx(L, -1, &is_number) == 1 && is_number);
    settop(L, 0);

    /* A runtime error names the chunk and a position the creator's line map resolves (no source line). */
    CHECK_RC(sg_clink_lua_load(c, "client/fail.lua", L, loadbufferx, &status), SG_OK);
    CHECK(pcallk(L, 0, 1, 0, 0, NULL) == 0 && type(L, -1) == 6);
    createtable(L, 0, 0);
    CHECK(pcallk(L, 1, 0, 0, 0, NULL) == 2 /* LUA_ERRRUN */);
    message = tolstring(L, -1, NULL);
    CHECK(message != NULL && strstr(message, "night-market@2.0.0/client/fail.lua:pos:") != NULL && strstr(message, "missing") != NULL);
    printf("  runtime error as the client sees it: %s\n", message);
    settop(L, 0);

    /* No other path, no partial load. */
    CHECK_RC(sg_clink_lua_load(c, "client/none.lua", L, loadbufferx, &status), SG_ERR_NOT_FOUND);
    CHECK(gettop(L) == 0);
    sg_clink_container_free(c);
    close_state(L);
    return 0;
}

static int clink_handles_reject_misuse(void)
{
    sg_clink* c = NULL;
    const char* value;
    size_t count;
    int status;
    CHECK_RC(sg_clink_container_open(NULL, 0, NULL, &c), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_clink_container_open(CVEC_CONTAINER, CVEC_CONTAINER_len, NULL, NULL), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_clink_container_field(NULL, "keyId", &value), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_clink_chunk_count(NULL, &count), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_clink_container_bind(NULL, NULL), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_clink_lua_load(NULL, "x", (void*)1, noop_loadbufferx, &status), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_clink_target_check(NULL, CVEC_LUAC_HEADER, CVEC_LUAC_HEADER_len), SG_ERR_INVALID_ARGUMENT);
    /* Not bound yet: no load, even with the target checked. */
    CHECK_RC(sg_clink_container_open(CVEC_CONTAINER, CVEC_CONTAINER_len, NULL, &c), SG_OK);
    CHECK_RC(sg_clink_target_check(c, CVEC_LUAC_HEADER, CVEC_LUAC_HEADER_len), SG_OK);
    CHECK_RC(sg_clink_lua_load(c, CVEC_CHUNK_PATHS[0], (void*)1, noop_loadbufferx, &status), SG_ERR_INVALID_ARGUMENT);
    CHECK_RC(sg_clink_lua_load(c, CVEC_CHUNK_PATHS[0], (void*)1, NULL, &status), SG_ERR_INVALID_ARGUMENT);
    sg_clink_container_free(c);
    sg_clink_container_free(NULL);
    return 0;
}

/* -------------------------------------------------------------------------------------------- main */

typedef struct test_case {
    const char* name;
    int (*run)(void);
} test_case;

static const test_case CASES[] = {
    { "clink_keys_unwrap_and_rewrap", clink_keys_unwrap_and_rewrap },
    { "clink_container_good_path", clink_container_good_path },
    { "clink_refuses_other_keys", clink_refuses_other_keys },
    { "clink_refuses_tampering", clink_refuses_tampering },
    { "clink_refuses_other_targets", clink_refuses_other_targets },
    { "clink_container_survives_mutations", clink_container_survives_mutations },
    { "clink_lua_load_through_real_lua", clink_lua_load_through_real_lua },
    { "clink_handles_reject_misuse", clink_handles_reject_misuse },
};

int main(int argc, char** argv)
{
    size_t i, ran = 0, skipped = 0;
    int last = 0;
    for (i = 0; i < sizeof CASES / sizeof CASES[0]; i++) {
        if (argc > 1 && strcmp(argv[1], CASES[i].name) != 0) continue;
        printf("%s\n", CASES[i].name);
        last = CASES[i].run();
        ran++;
        if (last == SKIPPED) skipped++;
        printf("  %s\n", last == 0 ? "ok" : last == SKIPPED ? "skipped" : "FAILED");
    }
    if (ran == 0) {
        fprintf(stderr, "unknown test case: %s\n", argc > 1 ? argv[1] : "(none)");
        return 2;
    }
    if (failures > 0) return 1;
    if (argc > 1 && last == SKIPPED) return SKIPPED;
    printf("%u case(s), %u skipped, 0 failed\n", (unsigned)ran, (unsigned)skipped);
    return 0;
}
