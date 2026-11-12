---
title: Rust (Oxide/Carbon)
description: How SCRIPT//GO scripts run on Rust (Oxide/Carbon): setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts on Rust servers, through one Oxide or Carbon plugin.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [Rust (Oxide/Carbon) page](/environments/rust) on the site is the short version.

| | |
|---|---|
| Status | Experimental: first real runs passed, more to measure |
| Runs on | Server only |
| Languages | Lua 5.4 |
| Protection | Code escrow |
| Runtime | Rust dedicated server with Oxide or Carbon; KeraLua (Lua 5.4) |

## How it runs

One C# plugin, `ScriptGo.cs`, the same file for Oxide and Carbon. Rust's plugin frameworks no longer run Lua, so the plugin loads a small bridge that runs the core in a KeraLua (Lua 5.4) VM, ticked by a framework timer.

The adapter's code and README: [`sdk/adapters/rust`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/rust).

## Set up

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

### Encrypted (escrowed) packages

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

### Player perks

Player perks (`ScriptGo.perks`, `docs/spec/perks.md`): the server asks SCRIPT//GO which of the operator's perks a player has. It needs the server linked to the operator's account (Dashboard, Perks, Servers) and the link's token, a secret, in the host's settings. In the plugin's configuration, next to `scriptgo_api`:

```json
"convars": { "scriptgo_api": "https://api.scriptgo.dev", "scriptgo_server_token": "sg_srv_..." }
```

A player is `steam:<steamid64>`. The cache goes to the plugin's data files (`scriptgo.perks`). This
is unit-tested in the bridge with fake services; it has not been run on a Rust server with a
connected player.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Partial | Server side only: Rust has no client-side plugins. Lua 5.4 runs in KeraLua inside the plugin. |
| `logging` | Supported |  |
| `storage` | Supported | Oxide/Carbon data files: &lt;data&gt;/ScriptGo/storage/&lt;key&gt;.json. |
| `players` | Supported | BasePlayer. Steam ids get integer ids that stay stable while the plugin is loaded; identifier is steam:&lt;steamid64&gt;. |
| `permissions` | Supported | Oxide permissions: privilege p is scriptgo.p; scriptgo.admin holds every privilege. |
| `commands` | Supported | Chat commands (/name) through OnPlayerCommand; the console command scriptgo manages resources. |
| `config` | Supported | The plugin config (ScriptGo.json): resources.&lt;name&gt; and convars. Rust's own server convars are not exposed. |
| `ui` | Fallback | Notifications are sent as colored chat lines. |
| `http` | Partial | Oxide/Carbon web requests. Response headers are not available; httpAllowedHosts can limit the hosts. |
| `licensing` | Supported | Over the plugin's web requests, to the scriptgo_api convar. |
| `perks` | Partial | Implemented in the core, over the plugin's web requests; the player is steam:&lt;steamid64&gt;. The cache is kept in the plugin's data files. Proven in the bridge's .NET test process with fake services; not run on a Rust server yet. |
| `presence` | Partial | Implemented in the core: the address is the player's connection address (net.connection.ipaddress), the HMAC is .NET's HMACSHA256 in the bridge. Proven in the bridge's .NET test process with fake services; not run on a Rust server with a connected player yet. |

## Protection

Code escrow: the compiled bridge next to the plugin has the native loader decrypt in memory, with a key released to this server only. It is off until the operator turns it on in the plugin config. Measured on Windows servers with Oxide and with Carbon, and on a Linux server with Oxide in a container. The operator of the machine can still inspect their own process; that takes real effort and the copy is traceable.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## Assets

Maps, models, textures, sounds and other files players download. See [Selling assets](/docs/selling-assets).

| | |
|---|---|
| Support | Partial |
| `environment_asset` | one custom map (.map), which players download from a URL the operator hosts (server.levelurl); a plugin cannot send files to players |
| Pack | `scriptgo pack --target rust` |

Packed (the map for server.levelurl); not run.

Asset escrow: Not available: every player downloads the map in clear from the operator's URL into Facepunch's client, and Facepunch documents no map protection. RustEdit's map encryption (a third-party editor) covers RustEdit's own data in the map, not Rust's. What protects it: the licence-gated download; the map is a loose file, so copies are not fingerprinted.

## The platform's own rules

The developer allows selling mods you own.

This is the platform's rule, shown as information: whoever runs a script there answers for following it. It does not change what can be sold on SCRIPT//GO. See [the rules](/docs/selling#the-rules).

## Limits

- Measured on Windows dedicated servers with Oxide and with Carbon, and on a Linux dedicated server with Oxide in a container, with no player connected: the conformance probe and the escrow chain. What a connected player triggers (chat commands, permissions of real Steam ids) is not measured, nor Carbon on Linux.
- No client side.
- KeraLua's native Lua 5.4 (lua54.dll or liblua54.so) must be installed in RustDedicated_Data/Plugins/x86_64.
- HTTP responses carry no headers.

## Real runs

Each row is a `scriptgo verify` run on Rust (Oxide/Carbon) itself, not on a mock or an emulator: the package started there and its own tests reported back. Rows marked *probe* are SCRIPT//GO's conformance probes, which exercise the runtime and are never published as packages. See [how a status is earned](/docs/environments#how-a-status-is-earned).

| Script | Version | Ran on | Adapter | Checks passed | Date |
|---|---|---|---|---|---|
| `sg_probe` *probe* | 0.1.0 | Rust unknown on oxide 2.0.7900+5a033c3ab435eb3fd33526b259bce4c7418ee3c2 · Lua 5.4 | rust-0.1.0 | 30/30 | 2026-11-10 |
