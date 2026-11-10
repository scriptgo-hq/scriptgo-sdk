/*
 * libscriptgo: the SCRIPT//GO escrow loader, C ABI.
 *
 * What it does: holds a server's X25519 identity, unwraps a release's content key, decrypts the
 * escrow payload and keeps the plaintext in native memory that is guarded, locked when the OS
 * allows it, read-only after decryption and zeroed on free. A Lua chunk is compiled into a
 * lua_State straight from that memory, so the plaintext never has to become a managed string or a
 * host-language byte array.
 *
 * What it does not do: stop the operator of the machine. A host that decrypts and runs code can be
 * inspected by whoever controls that host (a debugger, a memory dump, a patched Lua library).
 * Escrow is deterrence, traceability and revocation; this library raises the cost of copying a
 * resource and keeps keys and plaintext out of the easiest places to read them. It is not a
 * guarantee of secrecy. See docs/spec/escrow.md and docs/plan/CREATOR-PROTECTION.md, section 1.
 *
 * Cryptography: libsodium only, statically linked (AES-256-GCM, X25519, HKDF-SHA256, ed25519,
 * SHA-256). Nothing is hand-rolled. The wire format is docs/spec/escrow.md.
 *
 * Conventions:
 *  - every function returns SG_OK (0) or a negative SG_ERR_* code, unless stated otherwise;
 *  - strings are UTF-8, NUL-terminated; paths inside a bundle use '/' and are case-sensitive;
 *  - handles (sg_identity, sg_bundle, sg_archive) are opaque and owned by the caller, who frees them;
 *  - pointers returned by sg_bundle_read / sg_bundle_entry_at / sg_archive_* stay valid until the
 *    owning handle is freed; never write through them (bundle memory is read-only).
 *
 * Thread safety: sg_init is safe to call from any thread. A handle is immutable once created, so
 * any number of threads may read from the same sg_identity, sg_bundle or sg_archive at once. Two
 * calls are exceptions and need exclusive access to their handle: sg_bundle_set_marker and the
 * *_free functions. sg_bundle_lua_load is only as thread-safe as the lua_State it is given (a
 * lua_State belongs to one thread at a time).
 */
#ifndef SCRIPTGO_ESCROW_H
#define SCRIPTGO_ESCROW_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#  define SG_CALL __cdecl
#  if defined(SG_BUILD_SHARED)
#    define SG_API __declspec(dllexport)
#  elif defined(SG_STATIC)
#    define SG_API
#  else
#    define SG_API __declspec(dllimport)
#  endif
#else
#  define SG_CALL
#  if defined(SG_BUILD_SHARED)
#    define SG_API __attribute__((visibility("default")))
#  else
#    define SG_API
#  endif
#endif

/* ABI version. It changes only when an existing function changes shape or meaning; new functions
 * do not change it. A host checks sg_abi_version() == SG_ABI_VERSION before any other call. */
#define SG_ABI_VERSION 1u

#define SG_PUBLIC_KEY_BYTES 32u   /* X25519 public key, ed25519 public key */
#define SG_PRIVATE_KEY_BYTES 32u  /* X25519 private key */
#define SG_NONCE_BYTES 12u        /* AES-256-GCM nonce */
#define SG_TAG_BYTES 16u          /* AES-256-GCM tag, appended to every ciphertext */
#define SG_SIGNATURE_BYTES 64u    /* ed25519 signature */
#define SG_SHA256_BYTES 32u
#define SG_WRAPPED_KEY_BYTES 48u  /* 32-byte content key + 16-byte tag */

/* Limits. A bundle that exceeds one is refused with SG_ERR_TOO_LARGE. */
#define SG_MAX_PAYLOAD_BYTES (256u * 1024u * 1024u) /* payload.enc */
#define SG_MAX_ENTRY_BYTES (64u * 1024u * 1024u)    /* one decompressed file */
#define SG_MAX_TOTAL_BYTES (512u * 1024u * 1024u)   /* all decompressed files of one archive */
#define SG_MAX_ENTRIES 16384u
#define SG_MAX_PATH_BYTES 1024u

/* The per-delivery marker entry a loader adds to a decrypted resource (traceability only). */
#define SG_DELIVERY_MARKER_PATH ".scriptgo-escrow"

/* Error codes. Stable: a code keeps its number and its meaning. */
#define SG_OK 0
#define SG_ERR_INVALID_ARGUMENT (-1)     /* a NULL pointer, a bad length or a freed/foreign handle */
#define SG_ERR_INIT (-2)                 /* the crypto library could not initialise */
#define SG_ERR_NO_AES (-3)               /* this CPU has no hardware AES (AES-NI + PCLMUL, or ARM crypto) */
#define SG_ERR_NO_MEMORY (-4)
#define SG_ERR_BAD_SIGNATURE (-5)        /* the ed25519 signature does not verify */
#define SG_ERR_PAYLOAD_HASH (-6)         /* payload.enc does not match the SHA-256 in the manifest */
#define SG_ERR_UNWRAP (-7)               /* the content key is not wrapped to this identity and release */
#define SG_ERR_DECRYPT (-8)              /* the payload does not authenticate under the content key */
#define SG_ERR_BAD_ARCHIVE (-9)          /* malformed zip, CRC mismatch or duplicate entry */
#define SG_ERR_UNSAFE_PATH (-10)         /* an entry path is absolute, escapes the root or is not portable */
#define SG_ERR_TOO_LARGE (-11)
#define SG_ERR_NOT_FOUND (-12)
#define SG_ERR_BUFFER_TOO_SMALL (-13)
#define SG_ERR_IO (-14)                  /* a file could not be read or written */
#define SG_ERR_IDENTITY_FORMAT (-15)     /* the identity file is damaged or not an identity file */
#define SG_ERR_PROTECT (-16)             /* the OS key protection refused (another user or machine) */
#define SG_ERR_LUA_LOAD (-17)            /* luaL_loadbufferx failed; its message is on the Lua stack */
#define SG_ERR_UNSUPPORTED (-18)         /* zip64, multi-disk, an encrypted entry or an unknown method */
#define SG_ERR_INSECURE_PERMISSIONS (-19)/* the identity file is readable by other users (POSIX) */
#define SG_ERR_EXISTS (-20)              /* the file already exists and was not replaced */

/* ------------------------------------------------------------------------------------------ general */

/* Returns SG_ABI_VERSION as compiled into the library. Never fails; needs no sg_init. */
SG_API uint32_t SG_CALL sg_abi_version(void);

/* The library version, "major.minor.patch". Static storage. */
SG_API const char* SG_CALL sg_version_string(void);

/* Initialises the crypto library. Optional (every function calls it), cheap and idempotent.
 * Returns SG_OK, SG_ERR_INIT, or SG_ERR_NO_AES when this CPU cannot run AES-256-GCM in hardware:
 * in that case no bundle can be opened by this library and the host must say so. */
SG_API int SG_CALL sg_init(void);

/* A short English description of an error code. Static storage; never NULL. */
SG_API const char* SG_CALL sg_strerror(int code);

/* SHA-256 of a buffer (for the clear-file hashes of escrow.json). */
SG_API int SG_CALL sg_sha256(const uint8_t* data, size_t len, uint8_t out_digest[SG_SHA256_BYTES]);

/* ----------------------------------------------------------------------------------------- identity */
/* A server identity is an X25519 key pair. The master wraps a release's content key to the public
 * key; the private key stays inside this library, in guarded memory, and is never returned. */

typedef struct sg_identity sg_identity;

/* A fresh identity that lives only in memory (tests, or a host with its own key storage). */
SG_API int SG_CALL sg_identity_generate(sg_identity** out_identity);

/* An identity from a raw 32-byte private key the caller already holds. This is the one door through
 * which a private key enters from outside; prefer sg_identity_load_or_create, which never exposes it.
 * The caller should wipe its own copy afterwards. */
SG_API int SG_CALL sg_identity_import(const uint8_t private_key[SG_PRIVATE_KEY_BYTES], sg_identity** out_identity);

/* Loads the identity stored at `path`, or creates one there when the file does not exist.
 * `out_created` (optional) receives 1 when a new identity was written, else 0.
 * Storage: on Windows the private key is sealed with DPAPI (CryptProtectData) for the current user,
 * so the file is useless to another account or another machine; the file's ACL is left alone.
 * Elsewhere the file is created with mode 0600 and refused when group or others can read it.
 * A file that exists but cannot be opened is an error: an identity is never silently replaced,
 * because that would unbind the server. */
SG_API int SG_CALL sg_identity_load_or_create(const char* path, sg_identity** out_identity, int* out_created);

/* Loads an identity file. SG_ERR_NOT_FOUND when there is none. */
SG_API int SG_CALL sg_identity_load(const char* path, sg_identity** out_identity);

/* Writes an identity file. With `replace` 0 an existing file is kept and SG_ERR_EXISTS returned. */
SG_API int SG_CALL sg_identity_save(const sg_identity* identity, const char* path, int replace);

/* The raw 32-byte X25519 public key (what the server registers with its deployment). */
SG_API int SG_CALL sg_identity_public_key(const sg_identity* identity, uint8_t out_public_key[SG_PUBLIC_KEY_BYTES]);

/* Wipes and frees. NULL is accepted. */
SG_API void SG_CALL sg_identity_free(sg_identity* identity);

/* ---------------------------------------------------------------------------------------- signature */

/* Verifies the ed25519 release signature. `canonical_json` is the manifest serialised as
 * docs/spec/escrow.md describes (keys sorted at every level, no whitespace, `signature` set to "").
 * Returns SG_OK or SG_ERR_BAD_SIGNATURE. Pin `signer_public_key` to the key you trust: a signature
 * that verifies under the key the bundle itself names proves integrity, not provenance. */
SG_API int SG_CALL sg_verify_manifest(const uint8_t* canonical_json, size_t canonical_json_len,
                                      const uint8_t signature[SG_SIGNATURE_BYTES],
                                      const uint8_t signer_public_key[SG_PUBLIC_KEY_BYTES]);

/* ------------------------------------------------------------------------------------ clear archive */
/* A reader for the outer bundle (escrow.json, payload.enc and the clear files). Nothing in it is
 * secret, so it lives in ordinary memory. It applies the same checks as the encrypted archive:
 * CRC, size limits, no path that escapes the root. Hosts with their own zip reader can skip it. */

typedef struct sg_archive sg_archive;

SG_API int SG_CALL sg_archive_open(const uint8_t* zip, size_t zip_len, sg_archive** out_archive);
SG_API int SG_CALL sg_archive_entry_count(const sg_archive* archive, size_t* out_count);
/* Entries are sorted by path (byte order). */
SG_API int SG_CALL sg_archive_entry_at(const sg_archive* archive, size_t index, const char** out_path, size_t* out_size);
SG_API int SG_CALL sg_archive_read(const sg_archive* archive, const char* path, const uint8_t** out_data, size_t* out_len);
SG_API void SG_CALL sg_archive_free(sg_archive* archive);

/* ------------------------------------------------------------------------------------------- bundle */
/* A bundle is the decrypted content of one escrow release, held in native memory. */

typedef struct sg_bundle sg_bundle;

/* Opens an escrow payload:
 *   1. checks SHA-256(payload) against `expected_payload_sha256` (escrow.json payload.sha256);
 *   2. unwraps the content key: shared = X25519(identity, epk);
 *      kek = HKDF-SHA256(ikm = shared, salt = epk || identity public key,
 *      info = "scriptgo.escrow.keywrap.v1"); content key = AES-256-GCM-open(kek, wrap_nonce,
 *      wrapped, aad);
 *   3. decrypts the payload (AES-256-GCM, ciphertext with the tag appended) into guarded memory;
 *   4. wipes the content key and every intermediate secret;
 *   5. reads the inner zip (stored and deflate entries, CRC checked, unsafe paths refused),
 *      then wipes the inner zip and makes the decompressed files read-only.
 * `payload` is escrow.json's payload.enc; `aad` is its `aad` string as UTF-8 bytes; `epk`,
 * `wrap_nonce` and `wrapped` are the three fields of the wrappedKey the key endpoint returned.
 * `wrapped_len` must be SG_WRAPPED_KEY_BYTES.
 * Errors worth telling apart: SG_ERR_UNWRAP (this server is not the one the key was released to,
 * or the key is for another release), SG_ERR_PAYLOAD_HASH and SG_ERR_DECRYPT (tampered or wrong
 * payload), SG_ERR_BAD_ARCHIVE / SG_ERR_UNSAFE_PATH (a release that must not be loaded). */
SG_API int SG_CALL sg_bundle_open(const sg_identity* identity,
                                  const uint8_t* payload, size_t payload_len,
                                  const uint8_t payload_nonce[SG_NONCE_BYTES],
                                  const uint8_t* aad, size_t aad_len,
                                  const uint8_t epk[SG_PUBLIC_KEY_BYTES],
                                  const uint8_t wrap_nonce[SG_NONCE_BYTES],
                                  const uint8_t* wrapped, size_t wrapped_len,
                                  const uint8_t expected_payload_sha256[SG_SHA256_BYTES],
                                  sg_bundle** out_bundle);

SG_API int SG_CALL sg_bundle_entry_count(const sg_bundle* bundle, size_t* out_count);

/* Entry `index` in path order: its path (owned by the bundle) and its size in bytes. The marker
 * set with sg_bundle_set_marker is not listed here. */
SG_API int SG_CALL sg_bundle_entry_at(const sg_bundle* bundle, size_t index, const char** out_path, size_t* out_size);

/* The size of one entry, or SG_ERR_NOT_FOUND. */
SG_API int SG_CALL sg_bundle_entry_size(const sg_bundle* bundle, const char* path, size_t* out_size);

/* A pointer into native memory, for a native host that consumes the plaintext in place (compiles
 * it, parses it). The memory is read-only and valid until sg_bundle_free. Do not copy it into a
 * garbage-collected heap: that is what sg_bundle_copy is for, and it is the weaker door. */
SG_API int SG_CALL sg_bundle_read(const sg_bundle* bundle, const char* path, const uint8_t** out_data, size_t* out_len);

/* Copies one entry into a caller buffer. THIS IS THE DOOR THROUGH WHICH PLAINTEXT LEAVES NATIVE
 * MEMORY: once it is in the caller's buffer this library can neither wipe it nor keep it out of a
 * heap dump. Use it only where there is no other way (a script engine that takes managed source,
 * a data file the resource reads). `out_len` always receives the entry size, so a first call with
 * capacity 0 answers SG_ERR_BUFFER_TOO_SMALL and tells how much to allocate. */
SG_API int SG_CALL sg_bundle_copy(const sg_bundle* bundle, const char* path, uint8_t* buffer, size_t capacity, size_t* out_len);

/* Attaches the per-delivery marker (the deliveryWatermark of the key answer) to the bundle as the
 * entry SG_DELIVERY_MARKER_PATH. It attributes a later leak to a license and a deployment; it is
 * traceability, not prevention. Readable through sg_bundle_read / sg_bundle_copy under that path.
 * Replaces a previous marker; len 0 removes it. Needs exclusive access to the bundle. */
SG_API int SG_CALL sg_bundle_set_marker(sg_bundle* bundle, const uint8_t* marker, size_t marker_len);

/* 1 when the OS agreed to lock the plaintext in RAM (no swap, no core dump where supported), else 0.
 * Locking is best effort: Windows caps it by the working-set quota, Linux by RLIMIT_MEMLOCK. The
 * guard pages, the read-only protection and the wipe on free do not depend on it. */
SG_API int SG_CALL sg_bundle_memory_locked(const sg_bundle* bundle);

/* luaL_loadbufferx, as exported by the host's own Lua 5.3/5.4 library:
 *   int luaL_loadbufferx(lua_State* L, const char* buff, size_t size, const char* name, const char* mode) */
typedef int (SG_CALL *sg_lua_loadbufferx_fn)(void* lua_state, const char* buffer, size_t size, const char* chunk_name, const char* mode);

/* Compiles one entry as a Lua chunk into `lua_state`, straight from native memory, by calling the
 * host's own luaL_loadbufferx (this library does not link Lua). The mode is always "t": text only,
 * so precompiled bytecode inside a bundle is refused by Lua itself.
 * On SG_OK the compiled function is on top of the Lua stack. On SG_ERR_LUA_LOAD the Lua error
 * message is on top of the stack and `out_lua_status` (optional) holds Lua's status code. On any
 * other error nothing was pushed. `chunk_name` follows Lua's rules ("@file" or "=name").
 * Call it where a Lua error cannot unwind through frames that do not expect it; the load itself
 * runs protected inside Lua and reports failures through the status code. */
SG_API int SG_CALL sg_bundle_lua_load(const sg_bundle* bundle, const char* path, void* lua_state,
                                      sg_lua_loadbufferx_fn loadbufferx, const char* chunk_name,
                                      int* out_lua_status);

/* Wipes the plaintext, then frees it. NULL is accepted. After this call every pointer obtained
 * from the bundle is invalid. Lua functions already compiled from it keep running: stopping the
 * resource (closing its lua_State) is the host's job. */
SG_API void SG_CALL sg_bundle_free(sg_bundle* bundle);

#ifdef __cplusplus
}
#endif

#endif /* SCRIPTGO_ESCROW_H */
