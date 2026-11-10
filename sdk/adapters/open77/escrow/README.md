# Protected (escrow) releases on an OPEN//77 server

How an operator runs an **encrypted** SCRIPT//GO release on their own OPEN//77 dedicated server.
The format is `docs/spec/escrow.md`; the plan and the honest ceiling are in
`docs/plan/CREATOR-PROTECTION.md`.

There are two ways. The first is the real one.

| | What runs | Where the plaintext lives | Protection |
|---|---|---|---|
| **Server feature** (`resourceEscrow`) | The OPEN//77 server itself, through an optional adapter over the `ScriptGo.Escrow` package and its native loader | Native memory only: never on disk, never a managed string | Code escrow |
| **Fallback loader** (`runner/`) | A separate tool the operator runs before the server | The operator's resources folder, as ordinary files | Licence only |

## What it is, and what it is not

Escrow is deterrence, licence binding, revocation and traceability. A copied folder does not run on a
server it was not licensed for; a revoked licence stops the resource; a modified release is refused;
each delivery carries a marker that names the licence it was delivered to. It is not a guarantee: the
operator of a machine can ultimately recover what their own process runs. We never describe it as
doing more than raising the cost.

Only **server** scripts are encrypted. OPEN//77 sends shared scripts, client scripts and declared
files to game clients, so the packer keeps them clear. Anything a creator wants to keep private
belongs in a server script.

## The server feature (as built)

OPEN//77 has an optional, default-off section in `server.jsonc`:

```jsonc
"resourceEscrow": {
  "enabled": true,
  "master": "https://<the SCRIPT//GO API>",
  "environment": "open77",
  "identityFile": ".open77/escrow-identity.bin",
  "tokensDirectory": ".open77/escrow-tokens",
  "trustedSigners": ["<the creator's release key, base64url>"]
}
```

With it off (the default) the server behaves exactly as before and refuses an encrypted folder with
one log line. OPEN//77 does not depend on SCRIPT//GO to build, test or run: the hook is a neutral
seam in its scripting host, and what implements it is an **optional adapter assembly**
(`Open77.Server.Escrow.ScriptGo.dll`) built against the `ScriptGo.Escrow` package, which carries
the native loader. The adapter is the one escrow integration in OPEN//77 and it holds no copy of
the format: the manifest, the canonical JSON, the key request, the lease and the native calls are
the package's. With the section enabled and no adapter beside the executable, the server boots and
refuses each encrypted folder with `adapter_missing`.

### What the operator does

1. Buy the package on the creator's store. The licence appears in the SCRIPT//GO dashboard.
2. Download the release: `scriptgo add <creator//name>` gives `<name>-<version>.escrow.zip`.
3. Install it, still encrypted, into the server's resources:

   ```text
   scriptgo escrow install <name>-<version>.escrow.zip --target open77 --out <resources folder> --trusted-signer <key>
   ```

   The folder holds `open77.lua` and the shim (signed clear files of the release), `escrow.json`,
   `payload.enc`, the clear files, and a one-line stub at the path of each encrypted server script.
   No key is involved and nothing is decrypted.
4. Add a deployment for the licence (dashboard or `POST /v1/licenses/activate`) and put its token in
   `<tokensDirectory>/<resource>.token`, one line. The token never goes in `server.jsonc` or in the
   resource folder.
5. Have the adapter next to the server executable (`Open77.Server.Escrow.ScriptGo.dll`,
   `ScriptGo.Escrow.dll` and `runtimes/<rid>/native/scriptgo.dll` or `libscriptgo.so`), then start
   the server. `ScriptGo.Escrow` is not on nuget.org yet: download `ScriptGo.Escrow.<version>.nupkg`
   from this repository's releases (it carries the win-x64 and linux-x64 loaders; `sdk/dotnet/pack.ps1`
   rebuilds it from source), put it in a folder, and stage it with OPEN//77's script:

   ```text
   pwsh -File server/scripts/stage-scriptgo-escrow.ps1 -Feed <folder with the .nupkg>   (in OPEN//77)
   dotnet build server/Open77.Server.slnx -c Release
   ```

At start the server verifies the release signature and the folder, asks the master **in the
background** for the content key wrapped to this server's own key (the game loop does not wait: the
resource reads `pending_key` and starts at the tick after the answer), and the native library
decrypts and compiles each script straight into the resource's Lua VM. The server's identity is created on first start and sealed for the account it
runs as; the licence is bound to it on first use. Back it up with the rest of `.open77/`.

### Where the code is

In the OPEN//77 repository, on `main` since 2026-11-10 (server tests 4110 run, 0 failed; the
adapter's own 42 tests pass through the real native loader):

- `Open77.Server.Scripting`: the seam (`IResourceEscrowProvider` with its `Ready` signal,
  `IEscrowedResource`, `IResourceEscrowProviderFactory`), one appended optional constructor
  parameter on `ServerResourceHost`, the wait for a key that is on its way, and one branch in
  `LuaResourceRuntime.Prepare`: an encrypted script is compiled by the provider instead of
  `LoadBuffer`, under the same instruction hook and error path. `string.dump` is removed from an
  escrowed resource's VM, on start, restart and reload.
- `Open77.Server/Escrow/ResourceEscrowAdapter.cs`: finds the adapter assembly next to the
  executable and hands it the `resourceEscrow` section; nothing vendor-specific.
- `Open77.Server.Escrow.ScriptGo` (optional, outside the default solution): the adapter, one file
  over `ScriptGo.Escrow`: `EscrowBundle.ReadFolder`, `EscrowIdentity.LoadOrCreate`,
  `HttpEscrowKeyService`, `EscrowKeyCache`, `EscrowSession.Open`, `EscrowContent.LoadLuaChunk`
  with `LuaChunkLoader.FromLibraryName("lua54", typeof(KeraLua.Lua).Assembly)`, renewal and
  `Revoked`. It declares no native function and never uses the package's managed-copy door (a
  test reads its IL to assert both). What it adds is OPEN//77's own: which files of a resource
  must belong to the release, the per-resource token files, the reason codes and log lines.
  Once the package is published, moving it into OPEN//77's default build is a small change
  (listed in OPEN//77's `wiki/resource-escrow.md`).
- Configuration, schema, Warden writer, a lab config (`server.escrow-local.jsonc`), the wiki page
  `wiki/resource-escrow.md` and a research note.

### How it compares with a native asset escrow

The decryptor sits in native code outside the script VM, and a release only opens on an entitled
server. On top of that the content key is wrapped to one server's own key pair (a copy on another
machine cannot open it even with the same token), every release is signed, and each delivery is
watermarked. What it shares with every such system: a determined operator can still read their own
process.

### Proof

`tools/escrow-e2e.mjs` drives the whole chain against a real API and a real OPEN//77 dedicated server
through `tools/open77-escrow-loader.mjs`:

```text
node tools/escrow-e2e.mjs --environment open77 --require-output --loader-stays-up --stop-window 90 \
  --loader "node tools/open77-escrow-loader.mjs --open77-server <path to OPEN//77>/server"
```

It publishes a protected release, buys it through the mock payment provider, binds a server and
checks that the resource runs; then that it is refused without a licence, on a second server
identity, with a tampered bundle, after a refund and after a staff revoke; and that a **running**
server stops the resource by itself after a refund: at once, because the key endpoint marks that
refusal final (a refusal that is not final, or an unreachable master, runs to the end of the
offline grace). Results are in `TEST_RESULTS.md`.

## The fallback loader (licence only)

`runner/` is `scriptgo-open77-escrow`, for an operator who cannot enable the server feature. It
verifies the release, gets the key wrapped to this server, decrypts with the `ScriptGo.Escrow`
package and **writes the resource into the resources folder as ordinary files**. OPEN//77 then loads
it unchanged.

Because the decrypted scripts are on the operator's disk, this is licence-only protection: binding,
revocation, signing and traceability still hold, code secrecy does not. Say so wherever it is
offered. Build: `dotnet build runner/ScriptGo.Open77.Escrow.Runner.csproj`.

## Limits

- A Lua error in an encrypted script reports the script's path, a line number and, for a syntax
  error, the token it stopped near. The source is never logged.
- A resource whose licence is revoked or refunded stops at the first renewal after it (a key answer
  lives 15 minutes in production and is renewed a third of that before it expires), not at the
  second of the refund. A refusal that is not final, and an outage, stop it at the end of the
  offline grace of its last valid answer.
- Key answers are kept in memory only. After a server restart with the master unreachable, encrypted
  resources stay stopped until it answers.
- The native library is built and tested on Windows x64 and Linux x64. The Linux figures for the adapter are in `TEST_RESULTS.md` (the container script `tools/escrow-e2e-linux.ps1 -Loader open77` packs the package and builds the adapter there); no production host, no players.
- Client-side code is not protected. Keep valuable logic on the server.
- With players connected, measured with network bots only (OPEN//77's own `Open77.Bots`, real
  protocol clients, on Windows): three players connected while the encrypted script ran were greeted
  by it, stayed connected when the server stopped the revoked resource, and the server kept running.
  No game client was used.
