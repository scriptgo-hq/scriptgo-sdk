/* libscriptgo internals. Not installed; the public surface is include/scriptgo/escrow.h. */
#ifndef SCRIPTGO_INTERNAL_H
#define SCRIPTGO_INTERNAL_H

#include <stddef.h>
#include <stdint.h>

#include "scriptgo/escrow.h"

/* ------------------------------------------------------------------------------------- zip reader */

typedef struct sg_zip_entry {
    char* path;    /* NUL-terminated, validated; ordinary heap (paths are public: escrow.json lists them) */
    size_t offset; /* into sg_zip_index.data */
    size_t size;
} sg_zip_entry;

typedef struct sg_zip_index {
    sg_zip_entry* entries; /* sorted by path, byte order */
    size_t count;
    uint8_t* data;         /* every file, decompressed, back to back; NULL when data_size is 0 */
    size_t data_size;
    int secure;            /* data comes from sodium_malloc (guarded, wiped on free, read-only) */
    int locked;            /* the OS agreed to lock data in RAM */
} sg_zip_index;

/* Reads a whole zip into an index. With `secure` the decompressed bytes and the inflater state live
 * in sodium_malloc memory. On failure nothing is left allocated and *out is zeroed. */
int sg_zip_read(const uint8_t* zip, size_t zip_len, int secure, sg_zip_index* out);
void sg_zip_release(sg_zip_index* index);
const sg_zip_entry* sg_zip_find(const sg_zip_index* index, const char* path);

/* 1 when `path` (length n, no NUL needed) is a safe resource-relative path: no absolute path, no
 * drive or stream separator, no backslash, no control character, no empty, "." or ".." segment. */
int sg_path_is_safe(const char* path, size_t n);

/* ---------------------------------------------------------------------------------------- identity */

#define SG_IDENTITY_MAGIC 0x53474944u /* "SGID" */

struct sg_identity {
    uint32_t magic;
    uint8_t* private_key; /* sodium_malloc(32), read-only once set */
    uint8_t public_key[SG_PUBLIC_KEY_BYTES];
};

/* Takes a private key that already sits in a sodium_malloc(32) buffer and owns it from then on
 * (frees it on failure). */
int sg_identity_adopt(uint8_t* guarded_private_key, sg_identity** out_identity);

/* Platform seal for the identity file (identity_win.c / identity_posix.c).
 * sg_seal_write stores `private_key` at `path`; sg_seal_read fills a 32-byte guarded buffer. */
int sg_seal_write(const char* path, const uint8_t public_key[SG_PUBLIC_KEY_BYTES],
                  const uint8_t private_key[SG_PRIVATE_KEY_BYTES], int replace);
int sg_seal_read(const char* path, uint8_t public_key[SG_PUBLIC_KEY_BYTES],
                 uint8_t private_key_out[SG_PRIVATE_KEY_BYTES]);

/* The identity file: "SGIDENT1", one protection byte, the public key, a little-endian u32 length,
 * then the protected private key. */
#define SG_IDENTITY_FILE_MAGIC "SGIDENT1"
#define SG_IDENTITY_FILE_MAGIC_BYTES 8u
#define SG_IDENTITY_PROTECTION_DPAPI 1u    /* Windows: CryptProtectData, current user */
#define SG_IDENTITY_PROTECTION_FILEMODE 2u /* POSIX: raw key in a 0600 file */
#define SG_IDENTITY_FILE_HEADER_BYTES (SG_IDENTITY_FILE_MAGIC_BYTES + 1u + SG_PUBLIC_KEY_BYTES + 4u)
#define SG_IDENTITY_FILE_MAX_BYTES 4096u

#endif /* SCRIPTGO_INTERNAL_H */
