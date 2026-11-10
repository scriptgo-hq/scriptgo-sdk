# Protected (escrow) releases on an OPEN//77 server

How an operator runs an **encrypted** SCRIPT//GO release on their own OPEN//77 dedicated server.
The format is `docs/spec/escrow.md`; the plan and the honest ceiling are in
`docs/plan/CREATOR-PROTECTION.md`.

There are two ways. The first is the real one.

| | What runs | Where the plaintext lives | Protection |
|---|---|---|---|
| **Server feature** (`resourceEscrow`) | The OPEN//77 server itself, with the native loader `scriptgo` | Native memory only: never on disk, never a managed string | Code escrow |
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
seam in its scripting host, and the native library is a separate binary the operator installs.

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
5. Put the native loader next to the server executable (`scriptgo.dll`, built from `sdk/native`;
   OPEN//77 ships a staging script) and start the server.

At start the server verifies the release signature, asks the master for the content key wrapped to
this server's own key, and the native library decrypts and compiles each script straight into the
resource's Lua VM. The server's identity is created on first start and sealed for the account it
runs as; the licence is bound to it on first use. Back it up with the rest of `.open77/`.

### Where the code is

In the OPEN//77 repository (branch `feat/scriptgo-escrow` at the time of writing):

- `Open77.Server.Scripting`: the seam (`IResourceEscrowProvider`, `IEscrowedResource`), one appended
  optional constructor parameter on `ServerResourceHost`, and one branch in
  `LuaResourceRuntime.Prepare`: an encrypted script is compiled by the provider instead of
  `LoadBuffer`, under the same instruction hook and error path. `string.dump` is removed from an
  escrowed resource's VM.
- `Open77.Server/Escrow`: the provider. Managed code handles only public or encrypted data (the
  signed manifest, the key request, the renewal timer). Everything secret is behind `IEscrowNative`,
  bound to `scriptgo` through P/Invoke: identity, unwrap, decrypt, `sg_bundle_lua_load`.
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
node tools/escrow-e2e.mjs --environment open77 --require-output --loader-stays-up --stop-window 80 \
  --loader "node tools/open77-escrow-loader.mjs --open77-server <path to OPEN//77>/server"
```

It publishes a protected release, buys it through the mock payment provider, binds a server and
checks that the resource runs; then that it is refused without a licence, on a second server
identity, with a tampered bundle, after a refund and after a staff revoke; and that a **running**
server stops the resource by itself once the offline grace ends. Results are in `TEST_RESULTS.md`.

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
- The server floors the lifetime of a key answer and sweeps on a timer, so a revoked resource stops
  within about 45 seconds of the end of its grace, not at the exact second.
- Key answers are kept in memory only. After a server restart with the master unreachable, encrypted
  resources stay stopped until it answers.
- The native library is built and tested on Windows x64. The Linux build is written but has not been
  compiled or run.
- Client-side code is not protected. Keep valuable logic on the server.
