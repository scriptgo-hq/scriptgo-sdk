# ScriptGo.Escrow

Run **escrowed** SCRIPT//GO script releases on your own .NET host, with your own Lua VM and your
own sandbox. An escrowed release ships encrypted; its key is released by the SCRIPT//GO master only
to a licensed server, wrapped to that server's own key. This package verifies the release, obtains
the key, decrypts in native memory and hands compiled Lua chunks to your VM.

It has no dependency on the SCRIPT//GO sandbox (`ScriptGo.Host`): bring whatever host you have.

## What you get, honestly

Escrow is **deterrence, traceability and revocation**:

- a copied release does not open on a server it was not released to (per-server key binding);
- a refund, a dispute or the end of a subscription stops the next key release, and the resource
  stops at the end of a bounded offline grace;
- a modified release is refused (ed25519 signature, AES-256-GCM);
- a leaked copy carries a watermark that names the license and deployment it came from.

It is **not** a guarantee that code stays secret. The operator of a machine that decrypts and runs
a resource can recover it from their own process with enough effort. This package raises that
effort (the key and the plaintext stay out of the managed heap) and never claims more. The logic
you cannot afford to lose belongs on a server you control, not in a shipped file.

## 60-second quick start (your own Lua VM)

```csharp
using ScriptGo.Escrow;

// 1. This server's identity. Created on first run; the private key never enters managed memory.
//    Register identity.PublicKeyBase64Url with your deployment (the first key request does it).
using var identity = EscrowIdentity.LoadOrCreate("data/scriptgo.identity");

// 2. Where keys come from: the SCRIPT//GO master, with this server's deployment token.
using var http = new HttpClient { BaseAddress = new Uri("https://<the master's API>") };
var keys = new HttpEscrowKeyService(http,
    new("sg_dep_...", Package: "creator//name", Environment: "your-engine", AdapterVersion: "your-engine/1.0"));

// 3. Open the release. Throws EscrowException with a reason: "refused:revoked", "unwrap_failed:...".
using var content = await EscrowSession.OpenAsync(
    File.ReadAllBytes("name-1.0.0.escrow.zip"), identity, keys,
    trustedSignerPublicKey: "<the release-signing key you trust, base64url>");

// 4. Load chunks into YOUR Lua state, straight from native memory. Here with KeraLua:
var loader = LuaChunkLoader.FromLibraryName("lua54", typeof(KeraLua.Lua).Assembly);   // once
using var lua = new KeraLua.Lua();
var chunk = content.LoadLuaChunk(lua.Handle, "server/main.lua", "@name/server/main.lua", loader);
if (chunk.Ok) lua.PCall(0, 0, 0);                    // the compiled function is on the stack
else Console.Error.WriteLine(lua.ToString(-1));      // LuaError: Lua's message is on the stack

// 5. Keep the license honest: renew in the background, stop the resource when it ends.
content.Revoked += (_, e) => QueueStopOnYourMainThread("name", e.Reason);   // then lua.Close()
content.StartRenewal();
```

That is the whole integration. `content.ClearFiles` holds the release's clear files (its manifest,
README, creator-named config); `content.EncryptedEntries` lists the encrypted files by path and
size, so you know which scripts exist (including the ones meant for clients) without reading them.

## What your host must do

| Duty | Why |
|---|---|
| Keep the identity file where only the server's account reads it, and back it up with the server | It is what binds the server. Lose it and the deployment must be re-bound; leak it and the binding is worth less |
| Pin `trustedSignerPublicKey` | Without it a signature only proves "not modified since signing", by anyone |
| Call `StartRenewal()` (or `RenewAsync()` on your own schedule) | The key answer expires (`ExpiresAt`); revocation reaches a server through the next request |
| Handle `Revoked`: stop the resource, close its VM | The package wipes its decrypted files; bytecode already inside your VM is yours to release |
| Never log file contents, the deployment token or anything from `CopyTo` / `ReadAllBytes` | Logs get shared |
| Treat client-side files as public | Whatever you send to players leaves the server. Escrow protects server-side code |

## The two doors

- `LoadLuaChunk(luaState, path, chunkName, loader)`: plaintext goes from libscriptgo's guarded
  memory into the Lua VM inside one native call. Text mode only: bytecode in a release is refused.
- `CopyTo(path, span)` / `ReadAllBytes(path)`: **the weaker door.** The plaintext becomes a managed
  array. Needed for engines that take managed source (JavaScript on Jint) and for data files.
  `content.ManagedCopies` counts its uses, so you can assert in your own tests that it stays at zero.

`EscrowDiskFallback.WriteTo(content, directory)` writes a decrypted release to a folder, for hosts
that can only load from disk. That is license-only grade: the plaintext is on the operator's disk
and there is no code-secrecy claim left, only binding, signing, the watermark and revocation of
future key releases.

## Backends

| | Private key | Content key and plaintext | When |
|---|---|---|---|
| `EscrowBackend.Native` (default) | inside libscriptgo, sealed on disk (DPAPI on Windows, 0600 file elsewhere) | native, guarded memory, wiped on dispose | whenever the native library exists for the platform |
| `EscrowBackend.Managed` | a pinned managed array | managed arrays | **explicit fallback**: weaker against memory inspection |

The default is native and **fails closed**: when `scriptgo.dll` / `libscriptgo.so` is missing,
`EscrowIdentity.LoadOrCreate(path)` throws and says what is missing. Managed decryption happens only
when you pass `EscrowBackend.Managed`, or `allowManagedFallback: true`; `identity.Backend` and
`content.Backend` report what was used. Both backends read the same identity file and refuse the
same bundles.

The native library ships in this package under `runtimes/<rid>/native/`. **Today that is
`win-x64` only**; the Linux and macOS builds are written and not yet built or tested
(`sdk/native/README.md`). It is located by absolute path next to `ScriptGo.Escrow.dll`
(`runtimes/<rid>/native/`, then the assembly's own folder), never through `PATH`;
`EscrowNativeLibrary.UseLibraryAt(path)` overrides the search, and
`EscrowNativeLibrary.LoadedFrom` tells where it came from. It needs a CPU with hardware AES
(AES-NI on x86-64): without it the native backend reports itself unavailable.

## Reasons you will see

`EscrowException.Reason` starts with a stable token:

| Token | Meaning | Retry? |
|---|---|---|
| `invalid_bundle:` | not an escrow bundle, a malformed archive, an unsafe path | no |
| `signature:` | bad signature, or not signed by the trusted key | no |
| `refused:<reason>` | the license says no: `revoked`, `expired`, `refunded`, `deactivated`, `environment_not_covered`, `deployment_limit`, `unknown_key`, `unbound`, `not_escrowed` | after fixing the license |
| `key_service_unreachable:` | network error or 4xx/5xx; **not** a refusal (`IsTransient`) | yes |
| `unwrap_failed:` | the key was wrapped to another server or another release | no: re-bind the deployment |
| `decrypt_failed:` | the payload or a clear file was modified | no |
| `native_library_unavailable:` | libscriptgo missing, wrong ABI, or no hardware AES | install it, or opt in to managed |
| `revoked:` | the content was revoked or disposed | open again once licensed |

## More

- The wire format, for any language: `docs/spec/escrow.md`.
- The native library and its C ABI, for C/C++ and FFI hosts: `sdk/native/`.
- The full guide, with the call sequence and a checklist: `docs/guides/bring-escrow-to-your-platform.md`.
- A complete third-party host in about 300 lines: `sdk/examples/custom-adapter-dotnet/`.

Third-party notices for the native library (libsodium, ISC; miniz, MIT) are in
`THIRD-PARTY-NOTICES.txt` in this package.
