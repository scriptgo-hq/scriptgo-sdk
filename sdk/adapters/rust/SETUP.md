These steps were followed on real Windows dedicated servers, one with Oxide and one with Carbon
(2026-11-10: the conformance probe and the escrow chain pass on both, see README.md, "What has
run"). On Linux, Oxide was run the same way in a container (`tools/rust-server-linux.ps1`); Carbon
on Linux and a start through `runds.sh` are written from the documentation and untested.

1. Build the plugin files, optionally with resources:

   ```bash
   node sdk/adapters/rust/build.mjs --with sdk/packages/sg_inventory --with sdk/packages/sg_eventbus
   ```

   `dist/rust/` mirrors the server's root folder. The build needs the .NET SDK.

2. Install Oxide or Carbon on the server, not both. Then copy from `dist/rust/` into the server root:

   | File | Where |
   |---|---|
   | `ScriptGo.Bridge.dll`, `KeraLua.dll` | `RustDedicated_Data/Managed/` |
   | `lua54.dll` (Windows) or `liblua54.so` (Linux) | `RustDedicated_Data/Plugins/x86_64/` |
   | `ScriptGo.cs` | `oxide/plugins/` for Oxide, `carbon/plugins/` for Carbon |

   The plugin loads the two DLLs through its `// Reference: ScriptGo.Bridge` line. After you replace
   either DLL, restart the server: reloading the plugin keeps the old ones loaded.

3. Put each resource in `oxide/data/ScriptGo/resources/<name>/` (Carbon: `carbon/data/...`). Every
   resource with `auto_start true` starts when the server is up, dependencies first.

4. Edit the plugin config, `oxide/config/ScriptGo.json` (Carbon: `carbon/configs/ScriptGo.json`).
   The plugin writes it on its first load.

   ```json
   {
     "resources": { "sg_inventory": { "slots": 30 } },
     "convars": { "scriptgo_api": "https://api.scriptgo.dev" },
     "httpAllowedHosts": ["api.scriptgo.dev"],
     "start": null
   }
   ```

5. Grant privileges with Oxide permissions. Every SCRIPT//GO privilege `p` becomes `scriptgo.p`:

   ```text
   oxide.grant user <steamid> scriptgo.command.giveitem      (Carbon: c.grant user ...)
   oxide.grant group admin scriptgo.admin                    (every privilege, and the scriptgo command)
   ```

Only the server side runs: Rust has no client-side plugins. Check what is running with
`scriptgo status` in the server console.

## Encrypted (escrowed) packages

Optional and off by default. Proven on Windows servers with Oxide and with Carbon, and on a Linux
server with Oxide in a container. Read
"Escrow" in README.md first: it is deterrence, licence binding, revocation and traceability, not a
guarantee, and the operator of the machine can ultimately recover what their own server runs.

1. Build with the native escrow library, from a build of `sdk/native` (`build.ps1` on Windows,
   `build-linux.ps1` for Linux x64):

   ```bash
   node sdk/adapters/rust/build.mjs --native sdk/native/dist
   ```

   `SCRIPTGO_NATIVE_DIR` works too. Copy `scriptgo.dll` (on Linux `libscriptgo.so`) from
   `dist/rust/RustDedicated_Data/Plugins/x86_64/` to the same folder of the server, next to
   `lua54`. Without it the plugin still runs clear packages and refuses an escrowed one with
   `native_missing`.

2. Put the escrowed resource in `oxide/data/ScriptGo/resources/<name>/` as the creator's bundle
   unzipped (`escrow.json`, `payload.enc`, the clear files) plus a one-line stub at the path of
   each encrypted script the manifest lists. README.md, "On disk", shows the stub.

3. Put the deployment token of that resource on this server in
   `oxide/data/ScriptGo/escrow/tokens/<name>.token` (Carbon: `carbon/data/...`), one line. It is a
   secret: keep the folder readable by the server's account only, and out of backups you share.

4. Turn escrow on in the plugin config and reload the plugin:

   ```json
   "escrow": { "enabled": true, "master": "https://api.scriptgo.dev", "trustedSigners": [] }
   ```

   The first escrowed start creates this server's identity in
   `oxide/data/ScriptGo/escrow/identity.key` and logs its public key. The licence is bound to it on
   the first key request. Back the file up: without it the server has to be bound again.

5. `scriptgo status` shows each escrowed resource: `pending_key` while the key is on its way, then
   `started  [escrow licensed, ...]`, or `failed  [escrow <reason>: ...]`. The reasons are listed in
   README.md, "Refusals". After fixing the cause, `scriptgo start <name>` asks the key service again.

## Player perks

Player perks (`ScriptGo.perks`, `docs/spec/perks.md`): the server asks SCRIPT//GO which of the operator's perks a player has. It needs the server linked to the operator's account (Dashboard, Perks, Servers) and the link's token, a secret, in the host's settings. In the plugin's configuration, next to `scriptgo_api`:

```json
"convars": { "scriptgo_api": "https://api.scriptgo.dev", "scriptgo_server_token": "sg_srv_..." }
```

A player is `steam:<steamid64>`. The cache goes to the plugin's data files (`scriptgo.perks`). This
is unit-tested in the bridge with fake services; it has not been run on a Rust server with a
connected player.
