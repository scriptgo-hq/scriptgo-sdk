# libscriptgo: the native escrow loader

A small C library (`scriptgo.dll`, `libscriptgo.so`, `libscriptgo.dylib`) with a plain C ABI. It
holds a server's identity, unwraps a release's content key, decrypts an escrow payload and keeps
the plaintext in native memory. A Lua chunk is compiled into a `lua_State` straight from that
memory. The wire format is `docs/spec/escrow.md`; the public header is
[`include/scriptgo/escrow.h`](include/scriptgo/escrow.h), and it documents every function.

Use it from C or C++ directly, or through FFI from any language. .NET hosts get it inside the
`ScriptGo.Escrow` NuGet package (`sdk/dotnet/ScriptGo.Escrow`) and do not call it by hand.

## What it is for, and what it is not

Escrow is **deterrence, traceability and revocation**. This library moves the content key, the
unwrap, the decryption and the plaintext out of a managed heap (easy to dump, easy to decompile
around) into native memory that is guarded, locked when the OS allows it, read-only after
decryption and wiped on free. That raises the cost of copying a paid resource off a server.

It does not stop the operator of the machine. Someone who controls the host can attach a debugger
to their own server, patch the Lua library, or dump the process while the resource runs. We do not
claim otherwise, and neither should a product built on this. The protections that hold against
that operator are the ones that do not depend on hiding anything from them: the key is released
only to a licensed, bound server, it stops being released on revocation, and a leaked copy is
attributable. See `docs/plan/CREATOR-PROTECTION.md`, section 1.

## What is inside

| Piece | Source |
|---|---|
| AES-256-GCM, X25519, HKDF-SHA256, ed25519, SHA-256, guarded memory | libsodium 1.0.22, **statically linked** |
| Inflate and CRC-32 for the inner zip | miniz 3.1.0 (`tinfl`), vendored in `third_party/miniz` |
| Zip reader, identity file, C ABI | this directory (`src/`) |

No cryptography is written here: every primitive is a libsodium call. libsodium is linked
statically so that a `libsodium.dll` placed next to the host cannot stand between the library and
its keys. AES-256-GCM in libsodium needs hardware AES (AES-NI and PCLMUL on x86-64, the crypto
extensions on ARM64): on a CPU without it `sg_init` and `sg_bundle_open` return `SG_ERR_NO_AES`
and the library opens nothing. There is no software fallback, on purpose.

## Build

### Windows x64 (built and tested)

```powershell
pwsh -ExecutionPolicy Bypass -File sdk/native/build.ps1
```

The script needs Visual Studio 2022 with the MSVC v143 toolset and its CMake component. It:

1. downloads the official `libsodium-1.0.22-msvc.zip` from the libsodium GitHub release into
   `.deps/` and refuses it unless its SHA-256 is
   `3e03a726fac4bc09cb61d8f29d658ef7a5eca0811de59082130414f7ca2e4279` (the digest GitHub publishes
   for the asset);
2. builds Release with the static C runtime (`/MT`), `/sdl`, `/GS`, `/guard:cf`, `/DYNAMICBASE`,
   `/HIGHENTROPYVA`, `/NXCOMPAT`, `/CETCOMPAT`, and no debug information;
3. runs the CTest suite (18 cases);
4. checks that the DLL exports only `sg_*`, carries the ASLR, DEP and CFG flags, and imports
   nothing but `KERNEL32`, `ADVAPI32` and `CRYPT32`;
5. writes `dist/win-x64/` (`scriptgo.dll`, `scriptgo.lib`, `include/scriptgo/escrow.h`,
   `THIRD-PARTY-NOTICES.txt`) and prints the DLL's size and SHA-256.

`.deps/`, `build/` and `dist/` are gitignored. From a non-interactive shell pass `-AgentShell`.

### Linux and macOS (written, **not built or tested here**)

```sh
cmake -S sdk/native -B sdk/native/build/release -DCMAKE_BUILD_TYPE=Release \
      -DSG_TEST_LUA_LIBRARY=/path/to/liblua5.4.so
cmake --build sdk/native/build/release
ctest --test-dir sdk/native/build/release --output-on-failure
```

Needs `pkg-config` and libsodium 1.0.19 or newer **with its static archive** (`libsodium.a`). The
build stops when only the shared library is present; `-DSG_ALLOW_SHARED_SODIUM=ON` accepts a
dynamic link and prints a warning, because a replaced `libsodium.so` could then observe keys.
Exports are limited to `sg_*` by `src/exports.map` (GNU ld) and `src/exports.macos.txt` (ld64).

This path was written with care and never compiled: the only machine available was Windows x64.
`src/identity_posix.c`, the non-MSVC branches of `CMakeLists.txt` and the two export lists are
unverified until the suite has run on the target. Treat the first Linux or macOS build as a port
to finish, not as a supported platform.

## Using it from C

```c
#include <scriptgo/escrow.h>

if (sg_abi_version() != SG_ABI_VERSION) return fail("libscriptgo ABI mismatch");
int rc = sg_init();                       /* SG_ERR_NO_AES on a CPU without hardware AES */
if (rc != SG_OK) return fail(sg_strerror(rc));

sg_identity* identity = NULL;             /* created on first run, sealed to this user/machine */
rc = sg_identity_load_or_create("/var/lib/acme/scriptgo.identity", &identity, NULL);

uint8_t server_public_key[SG_PUBLIC_KEY_BYTES];
sg_identity_public_key(identity, server_public_key);
/* 1. read the bundle: sg_archive_open(...) gives escrow.json, payload.enc and the clear files;
 * 2. verify escrow.json: build its canonical JSON and call sg_verify_manifest with the signer
 *    key you trust; check each clear file against its sha256 (sg_sha256);
 * 3. POST /v1/licenses/key with your deployment token and base64url(server_public_key);
 * 4. on { valid: true }, base64url-decode wrappedKey.{epk,nonce,wrapped} and open: */
sg_bundle* bundle = NULL;
rc = sg_bundle_open(identity, payload, payload_len, payload_nonce, aad, aad_len,
                    epk, wrap_nonce, wrapped, SG_WRAPPED_KEY_BYTES, payload_sha256, &bundle);
if (rc == SG_ERR_UNWRAP) return fail("this server is not the one the key was released to");

/* 5. compile a script into your own Lua state, straight from native memory: */
rc = sg_bundle_lua_load(bundle, "server/main.lua", L, luaL_loadbufferx, "@demo/server/main.lua", NULL);
if (rc == SG_OK) lua_pcall(L, 0, 0, 0);

/* 6. on revocation (see the guide): close the resource's lua_State, then */
sg_bundle_free(bundle);                   /* wipes the plaintext */
sg_identity_free(identity);
```

The library does not parse JSON, decode base64 or speak HTTP: those are the host's, in whatever
libraries it already uses. The canonical JSON the signature covers is defined in
`docs/spec/escrow.md`; `sdk/dotnet/ScriptGo.Host.Tests/Fixtures/escrow-vector.json` carries a
`canonicalManifest` field to test a canonicaliser against. The complete call sequence, the renewal
loop and what a host must do at the end of offline grace are in
`docs/guides/bring-escrow-to-your-platform.md`.

## The C ABI (`SG_ABI_VERSION` 1)

```
sg_abi_version      sg_version_string       sg_init                 sg_strerror        sg_sha256
sg_identity_generate  sg_identity_import    sg_identity_load_or_create
sg_identity_load      sg_identity_save      sg_identity_public_key  sg_identity_free
sg_verify_manifest
sg_archive_open     sg_archive_entry_count  sg_archive_entry_at     sg_archive_read    sg_archive_free
sg_bundle_open      sg_bundle_entry_count   sg_bundle_entry_at      sg_bundle_entry_size
sg_bundle_read      sg_bundle_copy          sg_bundle_set_marker    sg_bundle_memory_locked
sg_bundle_lua_load  sg_bundle_free
```

Every function returns `SG_OK` or a negative `SG_ERR_*` code with a fixed number and meaning;
`sg_strerror` gives the text. `sg_bundle_copy` is the one call through which plaintext leaves
native memory, and the header says so where it is declared.

## Memory, honestly

- Secrets and plaintext come from `sodium_malloc`: a guard page on each side, a canary, wiped by
  `sodium_free`. The decompressed files are made read-only once written.
- Locking in RAM (`VirtualLock`, `mlock`) is **best effort**. Windows caps it by the process's
  working-set quota (a few hundred kilobytes by default), Linux by `RLIMIT_MEMLOCK`.
  `sg_bundle_memory_locked` tells what happened. A host that wants large bundles locked raises its
  own quota (`SetProcessWorkingSetSize`, `ulimit -l`); a library should not change process-wide
  limits behind its host's back, so this one does not.
- The content key exists from the unwrap to the end of the payload decryption, inside one call,
  in guarded memory, and is wiped before the archive is read.
- Once a chunk is compiled, the Lua VM holds its bytecode and constants in the VM's own heap. That
  is outside this library: closing the `lua_State` is what releases it.

## Tests

`tests/test_escrow.c` runs through the public ABI against the shared library, with the same
cross-language vector as the .NET tests (`tests/escrow_vector.h`, generated by
`packages/escrow/tools/gen-vectors.ts`: regenerate both fixtures together, never one). Cases: the
good path, a tampered payload, a wrong payload hash, a wrong identity (an unbound server), a wrong
release (`aad`), a bad signature, a corrupt inner zip, five path-traversal shapes, the copy door and
the delivery marker, identity persistence and damaged identity files, and a chunk loaded and run
through a real Lua 5.4 (`lua54.dll` from the KeraLua NuGet package).
