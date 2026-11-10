# SCRIPT//GO escrow on OPEN//77

How an OPEN//77 operator runs an **encrypted** (escrowed) SCRIPT//GO resource — by their choice, with
no change forced into OPEN//77's core. Read `PROPOSAL.md` first; the format is `docs/spec/escrow.md`.

- **Option A (recommended, no OPEN//77 change):** `runner/` is `scriptgo-open77-escrow`, a tool the
  operator runs. It fetches the escrow release, verifies the signature, gets the content key wrapped
  to this server's X25519 key, **decrypts with the `ScriptGo.Escrow` package** (in libscriptgo,
  native memory; the identity file is sealed for the server's account), and writes the resource
  into the OPEN//77 resources root as a normal `open77.lua` folder. OPEN//77 discovers it unchanged.
  Build: `dotnet build runner/ScriptGo.Open77.Escrow.Runner.csproj`.
- **Option B (optional, OPEN//77's own review):** `option-b.patch` is the exact minimal core change
  (one flag + one resource-provider hook) that keeps the plaintext in memory. **Not applied to base.**

Honest caveat: on OPEN//77 (a disk-reading host) Option A writes decrypted scripts to the operator's
own resources directory, so code secrecy there is license-only-grade; binding, revocation, signing
and traceability remain real. Option B is the only way to avoid the disk write on OPEN//77.

Proven on the SCRIPT//GO host (`ScriptGo.Host.Tests.EscrowHostTests`), including the Option A
materialize→disk→run hand-off. What remains: a run on a live OPEN//77 server binary (we must not
modify or build the shared `base` checkout) — the one command is at the end of `PROPOSAL.md`.

## After the package split (2026-11-10): what Option B builds on

Escrow now lives in its own package, `ScriptGo.Escrow` (`sdk/dotnet/ScriptGo.Escrow`), with no
dependency on `ScriptGo.Host`. The runner here uses it; an Option B provider inside OPEN//77 would
reference only that package. The design of the hook is unchanged and still `PROPOSAL.md`'s; these are
the calls it has available:

| Need of an OPEN//77 hook | `ScriptGo.Escrow` |
|---|---|
| The server identity, created once, private key never in managed memory | `EscrowIdentity.LoadOrCreate(path)`, `.PublicKeyBase64Url` |
| Open a release: verify, get the key, decrypt natively | `EscrowSession.OpenAsync(bundle, identity, new HttpEscrowKeyService(http, options), trustedSigner)` |
| The `open77.lua` manifest and the other clear files | `content.ClearFiles["open77.lua"]` (public bytes) |
| Every encrypted file, by path and size, without reading it (to tell server and client files apart with the manifest) | `content.EncryptedEntries`, `content.ContainsEncrypted(path)` |
| Compile a server script into a KeraLua state from native memory | `content.LoadLuaChunk(lua.Handle, path, chunkName, LuaChunkLoader.FromLibraryName("lua54", typeof(KeraLua.Lua).Assembly))`; the function is left on the Lua stack with the state's globals as `_ENV` (set upvalue 1 to run it in a sandbox table) |
| The bytes of a client-side file, to send to players | `content.ReadAllBytes(path)` / `content.CopyTo(path, span)`: the managed door, which is honest here because those files leave the server anyway |
| Re-verification and revocation | `content.StartRenewal()`, the `content.Revoked` event (raised off the server thread: queue the stop), `content.Dispose()` |

The native library ships inside the package (`runtimes/win-x64/native/scriptgo.dll`, Windows x64
only for now) and is found by absolute path next to `ScriptGo.Escrow.dll`. See
`docs/guides/bring-escrow-to-your-platform.md` for the call sequence and the host's duties.
