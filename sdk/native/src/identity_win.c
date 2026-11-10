/*
 * Identity file on Windows: the private key is sealed with DPAPI (CryptProtectData) for the current
 * user. The file can be copied, but it only opens for that Windows account on that machine, which
 * is the property a per-server binding needs. The file's ACL is left as the directory gives it.
 *
 * DPAPI protects the key at rest against other accounts and against a copied disk. It does not
 * protect it against code running as the same user: that is the operating system's model, and we
 * do not claim more.
 */
#if defined(_WIN32)

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <sodium.h>

#include "internal.h"

/* Not a secret: a domain separator, so another DPAPI consumer's blob can never be read as ours. */
static const char ENTROPY[] = "scriptgo.escrow.identity.v1";

static wchar_t* widen(const char* utf8, const wchar_t* suffix)
{
    size_t suffix_len = suffix != NULL ? wcslen(suffix) : 0;
    int needed = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, -1, NULL, 0);
    wchar_t* wide;
    if (needed <= 0) return NULL;
    wide = (wchar_t*)calloc((size_t)needed + suffix_len, sizeof *wide);
    if (wide == NULL) return NULL;
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, -1, wide, needed) <= 0) {
        free(wide);
        return NULL;
    }
    if (suffix != NULL) memcpy(wide + needed - 1, suffix, (suffix_len + 1) * sizeof *wide);
    return wide;
}

int sg_seal_read(const char* path, uint8_t public_key[SG_PUBLIC_KEY_BYTES], uint8_t private_key_out[SG_PRIVATE_KEY_BYTES])
{
    uint8_t file[SG_IDENTITY_FILE_MAX_BYTES];
    DATA_BLOB sealed, entropy, opened;
    DWORD read = 0, error;
    LARGE_INTEGER size;
    uint32_t blob_len;
    HANDLE handle;
    wchar_t* wide = widen(path, NULL);
    int rc;

    if (wide == NULL) return SG_ERR_INVALID_ARGUMENT;
    handle = CreateFileW(wide, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    error = GetLastError();
    free(wide);
    if (handle == INVALID_HANDLE_VALUE)
        return (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) ? SG_ERR_NOT_FOUND : SG_ERR_IO;
    if (!GetFileSizeEx(handle, &size)) { CloseHandle(handle); return SG_ERR_IO; }
    if (size.QuadPart < (LONGLONG)SG_IDENTITY_FILE_HEADER_BYTES || size.QuadPart > (LONGLONG)sizeof file) {
        CloseHandle(handle);
        return SG_ERR_IDENTITY_FORMAT;
    }
    if (!ReadFile(handle, file, (DWORD)size.QuadPart, &read, NULL) || read != (DWORD)size.QuadPart) {
        CloseHandle(handle);
        return SG_ERR_IO;
    }
    CloseHandle(handle);

    if (memcmp(file, SG_IDENTITY_FILE_MAGIC, SG_IDENTITY_FILE_MAGIC_BYTES) != 0) return SG_ERR_IDENTITY_FORMAT;
    /* A file sealed on another platform (a raw key in a 0600 file) is not accepted here. */
    if (file[SG_IDENTITY_FILE_MAGIC_BYTES] != SG_IDENTITY_PROTECTION_DPAPI) return SG_ERR_IDENTITY_FORMAT;
    memcpy(public_key, file + SG_IDENTITY_FILE_MAGIC_BYTES + 1, SG_PUBLIC_KEY_BYTES);
    {
        const uint8_t* p = file + SG_IDENTITY_FILE_MAGIC_BYTES + 1 + SG_PUBLIC_KEY_BYTES;
        blob_len = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    }
    if (blob_len == 0 || blob_len != read - SG_IDENTITY_FILE_HEADER_BYTES) return SG_ERR_IDENTITY_FORMAT;

    sealed.pbData = file + SG_IDENTITY_FILE_HEADER_BYTES;
    sealed.cbData = blob_len;
    entropy.pbData = (BYTE*)ENTROPY;
    entropy.cbData = (DWORD)(sizeof ENTROPY - 1);
    opened.pbData = NULL;
    opened.cbData = 0;
    if (!CryptUnprotectData(&sealed, NULL, &entropy, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &opened)) return SG_ERR_PROTECT;
    if (opened.cbData == SG_PRIVATE_KEY_BYTES) {
        memcpy(private_key_out, opened.pbData, SG_PRIVATE_KEY_BYTES);
        rc = SG_OK;
    } else {
        rc = SG_ERR_IDENTITY_FORMAT;
    }
    /* DPAPI hands the key back in ordinary heap memory: wipe it before it is released. */
    sodium_memzero(opened.pbData, opened.cbData);
    LocalFree(opened.pbData);
    return rc;
}

int sg_seal_write(const char* path, const uint8_t public_key[SG_PUBLIC_KEY_BYTES],
                  const uint8_t private_key[SG_PRIVATE_KEY_BYTES], int replace)
{
    uint8_t header[SG_IDENTITY_FILE_HEADER_BYTES];
    wchar_t suffix[40];
    DATA_BLOB clear, entropy, sealed;
    wchar_t* wide = NULL;
    wchar_t* temp = NULL;
    HANDLE handle = INVALID_HANDLE_VALUE;
    DWORD written = 0;
    int rc = SG_ERR_IO;

    clear.pbData = (BYTE*)private_key;
    clear.cbData = SG_PRIVATE_KEY_BYTES;
    entropy.pbData = (BYTE*)ENTROPY;
    entropy.cbData = (DWORD)(sizeof ENTROPY - 1);
    sealed.pbData = NULL;
    sealed.cbData = 0;
    if (!CryptProtectData(&clear, L"SCRIPT//GO escrow server identity", &entropy, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &sealed))
        return SG_ERR_PROTECT;
    if (sealed.cbData > SG_IDENTITY_FILE_MAX_BYTES - SG_IDENTITY_FILE_HEADER_BYTES) { rc = SG_ERR_PROTECT; goto done; }

    memcpy(header, SG_IDENTITY_FILE_MAGIC, SG_IDENTITY_FILE_MAGIC_BYTES);
    header[SG_IDENTITY_FILE_MAGIC_BYTES] = SG_IDENTITY_PROTECTION_DPAPI;
    memcpy(header + SG_IDENTITY_FILE_MAGIC_BYTES + 1, public_key, SG_PUBLIC_KEY_BYTES);
    {
        uint8_t* p = header + SG_IDENTITY_FILE_MAGIC_BYTES + 1 + SG_PUBLIC_KEY_BYTES;
        p[0] = (uint8_t)(sealed.cbData & 0xFF);
        p[1] = (uint8_t)((sealed.cbData >> 8) & 0xFF);
        p[2] = (uint8_t)((sealed.cbData >> 16) & 0xFF);
        p[3] = (uint8_t)((sealed.cbData >> 24) & 0xFF);
    }

    /* Write next to the target, then move into place, so a crash never leaves half an identity. */
    _snwprintf_s(suffix, sizeof suffix / sizeof suffix[0], _TRUNCATE, L".tmp.%lu", (unsigned long)GetCurrentProcessId());
    wide = widen(path, NULL);
    temp = widen(path, suffix);
    if (wide == NULL || temp == NULL) { rc = SG_ERR_INVALID_ARGUMENT; goto done; }
    handle = CreateFileW(temp, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (handle == INVALID_HANDLE_VALUE) goto done;
    if (!WriteFile(handle, header, (DWORD)sizeof header, &written, NULL) || written != sizeof header) goto done;
    if (!WriteFile(handle, sealed.pbData, sealed.cbData, &written, NULL) || written != sealed.cbData) goto done;
    if (!FlushFileBuffers(handle)) goto done;
    CloseHandle(handle);
    handle = INVALID_HANDLE_VALUE;
    if (!MoveFileExW(temp, wide, MOVEFILE_WRITE_THROUGH | (replace ? MOVEFILE_REPLACE_EXISTING : 0))) {
        DWORD error = GetLastError();
        rc = (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS) ? SG_ERR_EXISTS : SG_ERR_IO;
        goto done;
    }
    rc = SG_OK;

done:
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    if (rc != SG_OK && temp != NULL) DeleteFileW(temp);
    free(wide);
    free(temp);
    if (sealed.pbData != NULL) LocalFree(sealed.pbData);
    return rc;
}

#else
typedef int sg_identity_win_is_empty_on_this_platform;
#endif
