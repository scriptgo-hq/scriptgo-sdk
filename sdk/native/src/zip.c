/*
 * A small, strict zip reader for escrow bundles: central directory, stored and deflate entries,
 * CRC-32 on every file. It reads a whole archive that is already in memory and never touches the
 * file system, so "zip slip" here means refusing an entry whose path a host could later join onto
 * a directory and escape it.
 *
 * Refused outright: zip64, multi-disk archives, encrypted entries, unknown compression methods,
 * duplicate paths, a local header that disagrees with the central directory, sizes over the limits
 * in escrow.h.
 *
 * Inflate is miniz's tinfl (third_party/miniz, MIT). In secure mode the decompressed bytes and the
 * inflater's own state live in libsodium guarded memory and are wiped when released.
 */
#include <stdlib.h>
#include <string.h>

#include <sodium.h>

#include "internal.h"
#include "miniz.h"

#define EOCD_SIGNATURE 0x06054b50u
#define CENTRAL_SIGNATURE 0x02014b50u
#define LOCAL_SIGNATURE 0x04034b50u
#define EOCD_BYTES 22u
#define CENTRAL_BYTES 46u
#define LOCAL_BYTES 30u
#define METHOD_STORED 0u
#define METHOD_DEFLATE 8u
#define FLAG_ENCRYPTED 0x0001u

static uint16_t le16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }

static uint32_t le32(const uint8_t* p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

int sg_path_is_safe(const char* path, size_t n)
{
    size_t i, segment_start = 0;
    if (path == NULL || n == 0 || n > SG_MAX_PATH_BYTES) return 0;
    if (path[0] == '/') return 0;
    for (i = 0; i <= n; i++) {
        if (i == n || path[i] == '/') {
            size_t segment = i - segment_start;
            if (segment == 0) return 0;
            if (segment == 1 && path[segment_start] == '.') return 0;
            if (segment == 2 && path[segment_start] == '.' && path[segment_start + 1] == '.') return 0;
            segment_start = i + 1;
            continue;
        }
        {
            unsigned char c = (unsigned char)path[i];
            /* Control characters, a backslash (a separator on Windows) and a colon (a drive letter
             * or an alternate data stream) have no place in a portable resource path. */
            if (c < 0x20 || c == 0x7f || c == '\\' || c == ':') return 0;
        }
    }
    return 1;
}

static int compare_entries(const void* a, const void* b)
{
    return strcmp(((const sg_zip_entry*)a)->path, ((const sg_zip_entry*)b)->path);
}

void sg_zip_release(sg_zip_index* index)
{
    size_t i;
    if (index == NULL) return;
    if (index->entries != NULL) {
        for (i = 0; i < index->count; i++) free(index->entries[i].path);
        free(index->entries);
    }
    if (index->data != NULL) {
        if (index->secure) {
            sodium_free(index->data); /* wipes, then unmaps */
        } else {
            free(index->data);
        }
    }
    memset(index, 0, sizeof *index);
}

const sg_zip_entry* sg_zip_find(const sg_zip_index* index, const char* path)
{
    size_t lo = 0, hi;
    if (index == NULL || path == NULL) return NULL;
    hi = index->count;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        int c = strcmp(index->entries[mid].path, path);
        if (c == 0) return &index->entries[mid];
        if (c < 0) lo = mid + 1; else hi = mid;
    }
    return NULL;
}

/* Finds the end-of-central-directory record: the last 22 bytes plus an optional comment. */
static int find_eocd(const uint8_t* zip, size_t zip_len, size_t* out_offset)
{
    size_t offset, lowest;
    if (zip_len < EOCD_BYTES) return SG_ERR_BAD_ARCHIVE;
    offset = zip_len - EOCD_BYTES;
    lowest = offset > 0xFFFFu ? offset - 0xFFFFu : 0;
    for (;;) {
        if (le32(zip + offset) == EOCD_SIGNATURE && (size_t)le16(zip + offset + 20) == zip_len - offset - EOCD_BYTES) {
            *out_offset = offset;
            return SG_OK;
        }
        if (offset == lowest) return SG_ERR_BAD_ARCHIVE;
        offset--;
    }
}

typedef struct pending_entry {
    size_t name_offset; /* into the zip */
    size_t name_len;
    size_t data_offset; /* compressed bytes, into the zip */
    size_t compressed;
    size_t size;
    uint32_t crc;
    uint16_t method;
} pending_entry;

int sg_zip_read(const uint8_t* zip, size_t zip_len, int secure, sg_zip_index* out)
{
    size_t eocd = 0, cd_offset, cd_size, cursor, total_entries, i, files = 0, total_bytes = 0, write_offset = 0;
    pending_entry* pending = NULL;
    tinfl_decompressor* inflater = NULL;
    int rc;

    if (out == NULL) return SG_ERR_INVALID_ARGUMENT;
    memset(out, 0, sizeof *out);
    out->secure = secure;
    if (zip == NULL) return SG_ERR_INVALID_ARGUMENT;

    rc = find_eocd(zip, zip_len, &eocd);
    if (rc != SG_OK) return rc;
    if (le16(zip + eocd + 4) != 0 || le16(zip + eocd + 6) != 0) return SG_ERR_UNSUPPORTED; /* multi-disk */
    total_entries = le16(zip + eocd + 10);
    if (le16(zip + eocd + 8) != total_entries) return SG_ERR_UNSUPPORTED;
    cd_size = le32(zip + eocd + 12);
    cd_offset = le32(zip + eocd + 16);
    if (total_entries == 0xFFFFu || cd_size == 0xFFFFFFFFu || cd_offset == 0xFFFFFFFFu) return SG_ERR_UNSUPPORTED; /* zip64 */
    if (total_entries > SG_MAX_ENTRIES) return SG_ERR_TOO_LARGE;
    if (cd_offset > eocd || cd_size > eocd - cd_offset) return SG_ERR_BAD_ARCHIVE;

    if (total_entries > 0) {
        pending = (pending_entry*)calloc(total_entries, sizeof *pending);
        if (pending == NULL) return SG_ERR_NO_MEMORY;
    }

    /* Pass 1: walk the central directory, validate everything, size the arena. */
    cursor = cd_offset;
    for (i = 0; i < total_entries; i++) {
        const uint8_t* h;
        size_t name_len, extra_len, comment_len, local_offset, local_name_len, local_extra_len, data_offset;
        uint32_t compressed, size;
        uint16_t flags, method;
        const char* name;

        if (cursor > eocd || eocd - cursor < CENTRAL_BYTES) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }
        h = zip + cursor;
        if (le32(h) != CENTRAL_SIGNATURE) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }
        flags = le16(h + 8);
        method = le16(h + 10);
        compressed = le32(h + 20);
        size = le32(h + 24);
        name_len = le16(h + 28);
        extra_len = le16(h + 30);
        comment_len = le16(h + 32);
        local_offset = le32(h + 42);
        if (eocd - cursor - CENTRAL_BYTES < name_len + extra_len + comment_len) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }
        name = (const char*)(h + CENTRAL_BYTES);
        cursor += CENTRAL_BYTES + name_len + extra_len + comment_len;

        if (le16(h + 34) != 0) { rc = SG_ERR_UNSUPPORTED; goto fail; } /* starts on another disk */
        if (compressed == 0xFFFFFFFFu || size == 0xFFFFFFFFu || local_offset == 0xFFFFFFFFu) { rc = SG_ERR_UNSUPPORTED; goto fail; }
        if (flags & FLAG_ENCRYPTED) { rc = SG_ERR_UNSUPPORTED; goto fail; }
        if (name_len == 0) { rc = SG_ERR_UNSAFE_PATH; goto fail; }

        if (name[name_len - 1] == '/') {
            /* A directory entry carries no data; its name still has to be a safe path. */
            if (size != 0 || !sg_path_is_safe(name, name_len - 1)) { rc = SG_ERR_UNSAFE_PATH; goto fail; }
            continue;
        }
        if (!sg_path_is_safe(name, name_len)) { rc = SG_ERR_UNSAFE_PATH; goto fail; }
        if (method != METHOD_STORED && method != METHOD_DEFLATE) { rc = SG_ERR_UNSUPPORTED; goto fail; }
        if (size > SG_MAX_ENTRY_BYTES) { rc = SG_ERR_TOO_LARGE; goto fail; }
        if (method == METHOD_STORED && compressed != size) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }
        total_bytes += size;
        if (total_bytes > SG_MAX_TOTAL_BYTES) { rc = SG_ERR_TOO_LARGE; goto fail; }

        /* The local header must sit before the central directory and name the same file. */
        if (local_offset > cd_offset || cd_offset - local_offset < LOCAL_BYTES) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }
        if (le32(zip + local_offset) != LOCAL_SIGNATURE) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }
        local_name_len = le16(zip + local_offset + 26);
        local_extra_len = le16(zip + local_offset + 28);
        if (local_name_len != name_len || cd_offset - local_offset - LOCAL_BYTES < local_name_len + local_extra_len) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }
        if (memcmp(zip + local_offset + LOCAL_BYTES, name, name_len) != 0) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }
        data_offset = local_offset + LOCAL_BYTES + local_name_len + local_extra_len;
        if (cd_offset - data_offset < compressed) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }

        pending[files].name_offset = (size_t)(h + CENTRAL_BYTES - zip);
        pending[files].name_len = name_len;
        pending[files].data_offset = data_offset;
        pending[files].compressed = compressed;
        pending[files].size = size;
        pending[files].crc = le32(h + 16);
        pending[files].method = method;
        files++;
    }

    if (files > 0) {
        out->entries = (sg_zip_entry*)calloc(files, sizeof *out->entries);
        if (out->entries == NULL) { rc = SG_ERR_NO_MEMORY; goto fail; }
    }
    if (total_bytes > 0) {
        out->data = secure ? (uint8_t*)sodium_malloc(total_bytes) : (uint8_t*)malloc(total_bytes);
        if (out->data == NULL) { rc = SG_ERR_NO_MEMORY; goto fail; }
        out->data_size = total_bytes;
        /* sodium_malloc already tried to lock the pages; ask again to learn whether it worked. */
        if (secure) out->locked = sodium_mlock(out->data, total_bytes) == 0;
    }
    inflater = secure ? (tinfl_decompressor*)sodium_malloc(sizeof *inflater) : (tinfl_decompressor*)malloc(sizeof *inflater);
    if (inflater == NULL) { rc = SG_ERR_NO_MEMORY; goto fail; }

    /* Pass 2: decompress every file into the arena and check its CRC. */
    for (i = 0; i < files; i++) {
        const pending_entry* p = &pending[i];
        /* A zero-length file still needs a valid pointer for the inflater and for callers. */
        static uint8_t empty[1];
        uint8_t* target = p->size > 0 ? out->data + write_offset : empty;
        char* path = (char*)malloc(p->name_len + 1);
        if (path == NULL) { rc = SG_ERR_NO_MEMORY; goto fail; }
        memcpy(path, zip + p->name_offset, p->name_len);
        path[p->name_len] = '\0';
        out->entries[out->count].path = path;
        out->entries[out->count].offset = write_offset;
        out->entries[out->count].size = p->size;
        out->count++;

        if (p->method == METHOD_STORED) {
            if (p->size > 0) memcpy(target, zip + p->data_offset, p->size);
        } else {
            size_t in_len = p->compressed, out_len = p->size;
            tinfl_status status;
            tinfl_init(inflater);
            status = tinfl_decompress(inflater, zip + p->data_offset, &in_len, target, target, &out_len,
                                      TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
            if (status != TINFL_STATUS_DONE || out_len != p->size) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }
        }
        if ((uint32_t)mz_crc32(MZ_CRC32_INIT, target, p->size) != p->crc) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }
        write_offset += p->size;
    }

    if (out->count > 1) {
        qsort(out->entries, out->count, sizeof *out->entries, compare_entries);
        for (i = 1; i < out->count; i++) {
            if (strcmp(out->entries[i - 1].path, out->entries[i].path) == 0) { rc = SG_ERR_BAD_ARCHIVE; goto fail; }
        }
    }
    /* From here on nobody writes to the plaintext, this library included. */
    if (secure && out->data != NULL) sodium_mprotect_readonly(out->data);

    if (secure) sodium_free(inflater); else free(inflater);
    free(pending);
    return SG_OK;

fail:
    if (inflater != NULL) { if (secure) sodium_free(inflater); else free(inflater); }
    free(pending);
    sg_zip_release(out);
    return rc;
}
