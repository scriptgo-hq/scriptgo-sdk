/*
 * Identity file on Linux and macOS: the raw private key in a file only its owner can read (0600),
 * the same contract as an SSH private key. A file that group or others can read is refused.
 *
 * NOT BUILT OR TESTED in the environment this library was written in (Windows x64 only). The code
 * follows POSIX.1-2008; treat it as unverified until the CTest suite has run on the target.
 *
 * A 0600 file protects the key against other accounts. It does not protect it against root or
 * against code running as the same user, and we do not claim more.
 */
#if !defined(_WIN32)

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <sodium.h>

#include "internal.h"

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

static int read_all(int fd, uint8_t* buffer, size_t wanted)
{
    size_t done = 0;
    while (done < wanted) {
        ssize_t n = read(fd, buffer + done, wanted - done);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        done += (size_t)n;
    }
    return 0;
}

static int write_all(int fd, const uint8_t* buffer, size_t wanted)
{
    size_t done = 0;
    while (done < wanted) {
        ssize_t n = write(fd, buffer + done, wanted - done);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        done += (size_t)n;
    }
    return 0;
}

int sg_seal_read(const char* path, uint8_t public_key[SG_PUBLIC_KEY_BYTES], uint8_t private_key_out[SG_PRIVATE_KEY_BYTES])
{
    uint8_t file[SG_IDENTITY_FILE_HEADER_BYTES + SG_PRIVATE_KEY_BYTES];
    struct stat st;
    const uint8_t* p;
    uint32_t blob_len;
    int rc = SG_OK;
    int fd = open(path, O_RDONLY | O_CLOEXEC);

    if (fd < 0) return (errno == ENOENT || errno == ENOTDIR) ? SG_ERR_NOT_FOUND : SG_ERR_IO;
    if (fstat(fd, &st) != 0) { close(fd); return SG_ERR_IO; }
    if (!S_ISREG(st.st_mode)) { close(fd); return SG_ERR_IDENTITY_FORMAT; }
    if ((st.st_mode & (S_IRWXG | S_IRWXO)) != 0) { close(fd); return SG_ERR_INSECURE_PERMISSIONS; }
    if (st.st_size != (off_t)sizeof file) { close(fd); return SG_ERR_IDENTITY_FORMAT; }
    if (read_all(fd, file, sizeof file) != 0) rc = SG_ERR_IO;
    close(fd);

    if (rc == SG_OK && memcmp(file, SG_IDENTITY_FILE_MAGIC, SG_IDENTITY_FILE_MAGIC_BYTES) != 0) rc = SG_ERR_IDENTITY_FORMAT;
    /* A DPAPI-sealed file from Windows cannot be opened here. */
    if (rc == SG_OK && file[SG_IDENTITY_FILE_MAGIC_BYTES] != SG_IDENTITY_PROTECTION_FILEMODE) rc = SG_ERR_IDENTITY_FORMAT;
    if (rc == SG_OK) {
        p = file + SG_IDENTITY_FILE_MAGIC_BYTES + 1 + SG_PUBLIC_KEY_BYTES;
        blob_len = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
        if (blob_len != SG_PRIVATE_KEY_BYTES) rc = SG_ERR_IDENTITY_FORMAT;
    }
    if (rc == SG_OK) {
        memcpy(public_key, file + SG_IDENTITY_FILE_MAGIC_BYTES + 1, SG_PUBLIC_KEY_BYTES);
        memcpy(private_key_out, file + SG_IDENTITY_FILE_HEADER_BYTES, SG_PRIVATE_KEY_BYTES);
    }
    sodium_memzero(file, sizeof file); /* the stack copy held the private key */
    return rc;
}

int sg_seal_write(const char* path, const uint8_t public_key[SG_PUBLIC_KEY_BYTES],
                  const uint8_t private_key[SG_PRIVATE_KEY_BYTES], int replace)
{
    uint8_t file[SG_IDENTITY_FILE_HEADER_BYTES + SG_PRIVATE_KEY_BYTES];
    size_t path_len = strlen(path);
    char* temp = (char*)malloc(path_len + 32);
    int fd, rc = SG_ERR_IO;

    if (temp == NULL) return SG_ERR_NO_MEMORY;
    snprintf(temp, path_len + 32, "%s.tmp.%ld", path, (long)getpid());

    memcpy(file, SG_IDENTITY_FILE_MAGIC, SG_IDENTITY_FILE_MAGIC_BYTES);
    file[SG_IDENTITY_FILE_MAGIC_BYTES] = SG_IDENTITY_PROTECTION_FILEMODE;
    memcpy(file + SG_IDENTITY_FILE_MAGIC_BYTES + 1, public_key, SG_PUBLIC_KEY_BYTES);
    file[SG_IDENTITY_FILE_MAGIC_BYTES + 1 + SG_PUBLIC_KEY_BYTES + 0] = (uint8_t)SG_PRIVATE_KEY_BYTES;
    file[SG_IDENTITY_FILE_MAGIC_BYTES + 1 + SG_PUBLIC_KEY_BYTES + 1] = 0;
    file[SG_IDENTITY_FILE_MAGIC_BYTES + 1 + SG_PUBLIC_KEY_BYTES + 2] = 0;
    file[SG_IDENTITY_FILE_MAGIC_BYTES + 1 + SG_PUBLIC_KEY_BYTES + 3] = 0;
    memcpy(file + SG_IDENTITY_FILE_HEADER_BYTES, private_key, SG_PRIVATE_KEY_BYTES);

    /* Created 0600 from the first byte (O_EXCL: never follow a file somebody planted), then moved
     * into place so a crash never leaves half an identity. */
    (void)unlink(temp);
    fd = open(temp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, S_IRUSR | S_IWUSR);
    if (fd < 0) goto done;
    if (fchmod(fd, S_IRUSR | S_IWUSR) != 0 || write_all(fd, file, sizeof file) != 0 || fsync(fd) != 0) {
        close(fd);
        (void)unlink(temp);
        goto done;
    }
    close(fd);

    if (replace) {
        rc = rename(temp, path) == 0 ? SG_OK : SG_ERR_IO;
    } else if (link(temp, path) == 0) {
        rc = SG_OK; /* link fails with EEXIST when the target exists: an atomic "create new" */
    } else if (errno == EEXIST) {
        rc = SG_ERR_EXISTS;
    } else {
        /* A file system without hard links: fall back to check-then-rename (a small race). */
        struct stat st;
        if (stat(path, &st) == 0) rc = SG_ERR_EXISTS;
        else rc = rename(temp, path) == 0 ? SG_OK : SG_ERR_IO;
    }
    (void)unlink(temp); /* gone already after a rename; harmless */

done:
    sodium_memzero(file, sizeof file);
    free(temp);
    return rc;
}

#else
typedef int sg_identity_posix_is_empty_on_this_platform;
#endif
