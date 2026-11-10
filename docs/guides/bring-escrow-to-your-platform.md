# Bring SCRIPT//GO escrow to your platform

This guide is for someone who runs a game server platform, an engine or a modding framework and
wants paid scripts on it to ship **escrowed**: encrypted, and runnable only on a server that holds
a valid license. You keep your own sandbox, your own script API and your own Lua VM. SCRIPT//GO
supplies the format, the key release and a loader.

Read the ceiling first. It decides whether escrow is worth integrating on your platform at all.

## 1. What escrow does, and where it stops

Escrow gives a creator four things:

1. **A copied release does not run elsewhere.** The content key is released by the SCRIPT//GO master
   only to a licensed server, wrapped to that server's own public key. A folder copied to another
   machine has the ciphertext and nothing to open it with.
2. **Revocation.** After a refund, a dispute or the end of a subscription the next key request is
   refused. The resource keeps running for a bounded offline grace, then stops.
3. **Tamper evidence.** The release is signed (ed25519) and the payload is authenticated
   (AES-256-GCM). A modified release is refused before any key is asked for.
4. **Traceability.** Every key release carries a watermark tied to the license and the deployment.
   A leaked copy can be attributed.

It does **not** make code secret from the operator of the server that runs it. That operator
controls the machine: they can attach a debugger to their own process, patch the Lua library, or
dump memory while the resource runs. Escrow raises the cost of copying a resource off a server,
leaves traces, and lets a license be withdrawn. That is deterrence, traceability and revocation.
Please describe it to your users in those words, and do not promise more: a promise the first
determined operator can break costs more trust than it earns.

Two consequences follow, and both shape the integration:

- **The loader must live in compiled code.** A decryptor written in the scripting language it
  protects is readable by anyone who can read a script. That is why the key handling is in a native
  library, and why the table below exists.
- **The logic nobody may copy should never be shipped.** Pricing, economy rules, anti-cheat and
  secret algorithms belong on a server the creator controls, behind events or an API. Escrow
  protects what has to ship; it is not a substitute for keeping the important part at home.

## 2. Who can hold a key

What you can honestly offer depends on what kind of host you are.

| Your host | Examples | What escrow gives there | What you may claim |
|---|---|---|---|
| **Native or compiled host that embeds the loader and loads scripts from memory** | a C/C++ engine with Lua embedded, a .NET game server, a Rust or Go server calling the C library | Real escrow: the key and the plaintext stay in native memory and go straight into the VM | Encrypted at rest and in transit, bound to one server, revocable, signed, watermarked. Costly to copy, not impossible |
| **Compiled host that can only load scripts from disk** | a server whose resource loader reads folders and has no in-memory hook | **License-only grade.** The loader has to write the decrypted files to the operator's disk | Binding, revocation of future key releases, signing, watermark. **No code-secrecy claim** |
| **Pure-script host** | a platform whose extensions are Lua only, with no native module and no FFI | **Licence and signing only.** A loader written in Lua can be read, and so can its key | Who may run it, revocation, tamper evidence. **No code-secrecy claim, no encryption claim** |
| **Client-side files, on any host** | UI scripts, client logic, assets sent to players | Nothing. Whatever is sent to a player's machine has left the server | Nothing. Keep valuable logic server-side |

If you are in the first row, the rest of this guide applies in full. If you are in the second, use
the disk fallback (section 6) and say "license-only" in your documentation. If you are in the
third, integrate licence verification and signing and stop there: shipping encryption on a host
that cannot hold a key would be theatre, and SCRIPT//GO does not sell it as protection.

## 3. Three ways to integrate

Pick the highest layer your host can use. All three implement the same contract.

| Layer | For | You get | You write |
|---|---|---|---|
| **1. The wire contract** (`docs/spec/escrow.md`) | Any language, any host | The bundle layout, the manifest, the key-wrap construction, the key endpoint | Everything: zip, JSON, the crypto calls, memory handling |
| **2. `libscriptgo`** (`sdk/native`, header `scriptgo/escrow.h`) | C, C++, and any language with FFI | Identity storage, signature check, unwrap, decryption, the inner archive, guarded memory, and loading a Lua chunk into a `lua_State` | The outer zip (a helper is included), JSON, base64url, the HTTP call, the renewal timer |
| **3. `ScriptGo.Escrow`** (NuGet, `sdk/dotnet/ScriptGo.Escrow`) | .NET hosts | All of layer 2 plus the bundle parser, the HTTP key client and the renewal loop | The glue to your own sandbox: under 400 lines in the example, sandbox included |

There is also a fourth option that is not an integration: `ScriptGo.Host`, the complete SCRIPT//GO
sandbox for .NET. If you do not have a sandbox yet, that is the shorter road, and it uses
`ScriptGo.Escrow` underneath (`sdk/examples/host-escrow-dotnet`).

Status, plainly: `libscriptgo` is built and tested on **Windows x64 only**. The Linux and macOS
builds are written and have not been compiled (`sdk/native/README.md`). Until they are, a .NET host
on those systems can run the managed fallback backend, which decrypts in managed memory and is
weaker against memory inspection; the package makes you opt in to it by name.

## 4. The call sequence

The same seven steps at every layer. Names on the right are the `ScriptGo.Escrow` calls; the C
functions are in `sdk/native/README.md`.

```
 your server                                   SCRIPT//GO master
 -----------                                   -----------------
 1. load or create the server identity         (X25519 key pair; private key stays local)
 2. read the bundle, verify its signature      (ed25519 over the canonical manifest;
    and the hashes of its clear files           pin the signer key you trust)
 3. POST /v1/licenses/key  ------------------>  license valid? deployment bound to this key?
       deploymentToken, package, version,       release escrowed?
       environment, serverPublicKey
    <-----------------------------------------  { valid:true, wrappedKey{epk,nonce,wrapped},
                                                  deliveryWatermark, expiresAt, offlineGraceUntil }
                                                or { valid:false, reason }
 4. unwrap the content key with the identity,  (X25519 + HKDF-SHA256 + AES-256-GCM;
    decrypt the payload, read the inner zip     inside the native library)
 5. compile each script into your Lua state    (luaL_loadbufferx, text mode, from native memory)
 6. before expiresAt: step 3 again  --------->  still licensed?
 7. when the answer stays "no" past
    offlineGraceUntil: stop the resource,
    close its VM, free the content
```

| Step | `ScriptGo.Escrow` |
|---|---|
| 1 | `EscrowIdentity.LoadOrCreate(path)` |
| 2, 3, 4 | `EscrowSession.OpenAsync(bundle, identity, keyService, trustedSignerPublicKey)` |
| 3 (transport) | `HttpEscrowKeyService` (or your own `IEscrowKeyService`) |
| 5 | `content.LoadLuaChunk(luaState, path, chunkName, loader)` |
| 6 | `content.StartRenewal()` or `content.RenewAsync()` |
| 7 | the `content.Revoked` event, then `content.Dispose()` |

Details that matter:

- **Order.** Verify before asking for the key. A bundle that fails the signature or a clear-file
  hash must never cause a key request, so nothing is ever released for it. `OpenAsync` enforces this.
- **The first key request binds the server.** The master registers the public key it sees first
  for a deployment and refuses a different one afterwards (`unbound`). That is the copy protection.
  Moving a server therefore means moving its identity file, or re-binding the deployment.
- **Refused is not unreachable.** `{ valid:false, reason }` with HTTP 200 is a definitive answer.
  A network error or a 4xx/5xx means the master could not answer: retry, and let offline grace
  cover the gap. Treating an outage as a refusal punishes paying servers.
- **After `LoadLuaChunk` the function is on the Lua stack** with the state's globals as its
  environment, exactly as `luaL_loadbufferx` leaves it. To run it in your sandbox table, push the
  table and call `lua_setupvalue(L, -2, 1)` before `lua_pcall` (`_ENV` is upvalue 1 of a chunk).
- **Chunks are loaded in text mode.** Precompiled bytecode inside a release is refused by Lua.
- **Which files are client-side** is in the resource's manifest, a clear file. The encrypted file
  list (`content.EncryptedEntries`) gives every path and size without reading anything.

## 5. What your host must do

These are yours. The loader cannot do them for you.

**Store the identity properly.** The identity file is what binds a server. `LoadOrCreate` seals it
for the current user on Windows (DPAPI) and writes it with mode 0600 elsewhere, and it never
replaces an existing file, because a silently regenerated identity would unbind the server. Keep
it out of the resources folder, out of backups other people can read, and out of support bundles.

**Renew.** A key answer is valid until `expiresAt` (15 minutes by default on the master). Ask again
before then. Revocation only reaches a server through that request.

**Stop at the end of grace.** When the license is refused or the master is unreachable, the
resource keeps running until `offlineGraceUntil`. After that you stop it: unload the resource,
close its `lua_State`, and free the content, which wipes the decrypted files. The package raises
`Revoked` at that moment and will not hand out another chunk afterwards, but only your host can
close the VM that already holds the compiled code. A host that ignores `Revoked` has not
integrated escrow.

**Never log plaintext or secrets.** No script source, no file contents, no deployment token, no key
material in logs, crash reports or telemetry. Log paths, sizes, reasons and states.

**Keep the weaker door shut where you can.** `CopyTo` / `ReadAllBytes` (C: `sg_bundle_copy`) copy a
decrypted file into your process's ordinary memory. You need them for a script engine that takes
managed source, and for data files a resource reads. You do not need them for Lua. In your own
tests, assert that `content.ManagedCopies` is zero after a Lua-only resource has started.

**Treat client-side files as public.** If your platform sends scripts to players, those files leave
the server in a form the client can read. Tell creators, in your documentation, to keep anything
valuable in server scripts and to expose only events or an API to the client.

**Say what tier you are.** Publish, next to the feature, which row of the table in section 2 your
platform is in. Creators price their work on that.

## 6. The disk fallback

Some hosts can only load a resource from a folder. For them there is
`EscrowDiskFallback.WriteTo(content, directory)` (and `EscrowMaterializer` in `ScriptGo.Host`):
the release is verified, the key is released to the bound server, the files are decrypted and
written out, and the host loads the folder as usual.

This is the **license-only-grade fallback**. The decrypted scripts sit on the operator's disk, so
no code-secrecy claim is left. What remains is real and worth having: a copied *encrypted* release
still opens only on the bound server, a revoked license gets no further key (so no update and no
reinstall), the release is signed, and the written copy carries the delivery watermark. Present it
as licensing, not as encryption.

## 7. A worked example

`sdk/examples/custom-adapter-dotnet` is "Acme Engine", a fictional third-party server with its own
small Lua sandbox on KeraLua. It references `ScriptGo.Escrow` and nothing else from SCRIPT//GO, and
it is the whole integration: identity, key request, native chunk loading, `require` served from the
escrowed release, renewal, and stopping on revocation.

```
node sdk/examples/tools/demo-master.mjs          # a demo key endpoint over the test vector
dotnet run --project sdk/examples/custom-adapter-dotnet -- \
  --bundle sdk/examples/tools/.demo/demo-1.0.0.escrow.zip --master http://127.0.0.1:4180 \
  --deployment-token sg_dep_demo_token --package kestrel//demo --environment demo \
  --trusted-signer 0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc --once
```

`--once` runs the resource and exits 0; a refusal exits 1 with the reason on stderr
(`refused:revoked`, `unwrap_failed:...`), an unreachable master exits 3. Without `--once` it keeps
running, renews, and exits 4 when the license is revoked and grace has run out (`POST /demo/revoke`
on the demo endpoint shows it).

## 8. Checklist

Before you announce escrow support:

- [ ] You know which row of the tier table you are in, and your documentation says so in those words.
- [ ] The loader runs in compiled code. No key, and no decryptor, in a script.
- [ ] The identity file is outside the resources folder and readable by the server's account only.
- [ ] The release signer's public key is pinned (`trustedSignerPublicKey`), not taken from the bundle.
- [ ] A bundle that fails verification causes no key request (test it).
- [ ] A refusal and an unreachable master are handled differently (test both).
- [ ] The key is renewed before `expiresAt`.
- [ ] At the end of offline grace the resource is stopped, its VM is closed and the content is freed
      (test it with a short lease).
- [ ] Lua scripts are loaded through `LoadLuaChunk` / `sg_bundle_lua_load`; the copy door is used
      only where an engine needs managed source, and you can say where.
- [ ] Nothing decrypted, and no token, appears in any log at any level.
- [ ] Your guidance to creators says: client-side files are not protected; keep valuable logic on
      the server.
- [ ] Nowhere do you say "unbreakable", "uncrackable" or "impossible to copy".

## Where things are

| | |
|---|---|
| Wire contract | `docs/spec/escrow.md` |
| Threat model and what we will not claim | `docs/plan/CREATOR-PROTECTION.md`, sections 1 and 6 |
| Native library, C ABI, build | `sdk/native/README.md`, `sdk/native/include/scriptgo/escrow.h` |
| .NET package | `sdk/dotnet/ScriptGo.Escrow/README.md` |
| Third-party example host | `sdk/examples/custom-adapter-dotnet` |
| The same in the full SCRIPT//GO sandbox | `sdk/examples/host-escrow-dotnet` |
| Cross-language test vector | `sdk/dotnet/ScriptGo.Host.Tests/Fixtures/escrow-vector.json` |
