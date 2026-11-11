---
title: Garry's Mod
description: How SCRIPT//GO scripts run on Garry's Mod: setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts on Garry's Mod servers (roleplay, sandbox, game modes), through one server addon.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [Garry's Mod page](/environments/garrysmod) on the site is the short version.

| | |
|---|---|
| Status | Beta: usable, tested on a real runtime, conformance partial |
| Runs on | Server only |
| Languages | LuaJIT |
| Protection | Licence check and signed releases |
| Runtime | Garry's Mod dedicated server: GLua on LuaJIT 2.0.4 (32-bit) or LuaJIT 2.1 (64-bit) |

## How it runs

One server addon, `scriptgo`, carries the core and runs it in the server's GLua, ticked on the `Think` hook. `scriptgo pack --target garrysmod` turns each package into its own addon.

The adapter's code and README: [`sdk/adapters/garrysmod`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/garrysmod).

## Set up

1. Build the runtime addon, optionally with resources bundled in:

   ```bash
   node sdk/adapters/garrysmod/build.mjs --with sdk/packages/sg_inventory --with sdk/packages/sg_eventbus
   ```

   or pack each resource as its own addon (the runtime addon comes with it, `--no-runtime` leaves
   it out):

   ```bash
   scriptgo pack sdk/packages/sg_inventory --target garrysmod   # -> dist/garrysmod/scriptgo_sg_inventory/ + dist/garrysmod/scriptgo/
   ```

2. Copy the folders into the server's `garrysmod/addons/` and restart the map. Every resource with
   `auto_start true` starts once the map has loaded, dependencies first. Server owners can also put
   resources in `garrysmod/data/scriptgo/resources/<name>/`.
3. Optional `garrysmod/data/scriptgo/config.json`:

   ```json
   {
     "resources": { "sg_inventory": { "slots": 30 } },
     "permissions": { "admin": ["command.giveitem"], "76561198000000000": ["shop.*"] }
   }
   ```

   Permissions also come from superadmin and, with an admin mod such as ULX or SAM, from the CAMI
   privileges `scriptgo.<name>`.
4. Licensed packages call the SCRIPT//GO API at `https://api.scriptgo.dev`. To use another one (a
   local API in development), set `scriptgo_api` in `server.cfg`
   (`scriptgo_api "http://localhost:4100"`). An API on a loopback or private address also needs
   `-allowlocalhttp` on the srcds command line.

Only the server side runs: client scripts are not executed yet. Keep `sv_hibernate_think 1` if
resources must keep running while the server is empty. Resource commands are typed in chat as
`/name` or `!name`; the server console has `scriptgo`, `scriptgo restart <name>` and
`scriptgo run <command line>`.

To check a resource on your own server folder (a copy, not a live server):

```bash
scriptgo verify <resourceDir> --env garrysmod --gmod-server <folder with srcds.exe>
```

The server itself is the free Garry's Mod Dedicated Server (Steam app 4020), installed with
SteamCMD and an anonymous login: `steamcmd +force_install_dir <dir> +login anonymous +app_update 4020 validate +quit`.
On Windows it takes about 7 GB.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Partial | Server side only; client scripts do not run yet. The scheduler ticks on the Think hook, every server frame. |
| `logging` | Supported | The server console (and garrysmod/console.log with -condebug). |
| `storage` | Supported | JSON files under garrysmod/data/scriptgo/storage/. |
| `players` | Supported | The player's UserID() is its id; identifier steam:&lt;SteamID64&gt;, bot:&lt;id&gt; for bots. Join and drop come from PlayerInitialSpawn and player_disconnect. |
| `permissions` | Supported | superadmin, then CAMI (privilege scriptgo.&lt;name&gt;, for ULX, SAM and other admin mods), then grants by usergroup, SteamID64 or SteamID in data/scriptgo/config.json. |
| `commands` | Supported | Chat /name or !name for commands a resource registered; console `scriptgo run &lt;line&gt;`. |
| `config` | Supported | data/scriptgo/config.json per resource; GetConvar reads its convars, then the server's convars. |
| `ui` | Fallback | Notifications are chat lines (ChatPrint, PrintMessage). |
| `http` | Supported | The engine's asynchronous HTTP(): any method, status, body and headers. Loopback and private addresses need srcds -allowlocalhttp. |
| `licensing` | Supported | Over HTTP() to the scriptgo_api convar (default https://api.scriptgo.dev). |
| `perks` | Not available | Not switched on: the core implements perks over http and the player identifier, which this adapter has, but it has not been wired or run here. |
| `presence` | Partial | With HTTP(): /link works, and presence reports only in address mode (`scriptgo_presence_addr`, default off; the owner's decision on it is pending): the normalised address is sent and SCRIPT//GO fingerprints it at once, from Player:IPAddress(); GLua has no HMAC (util.SHA256 only). Unit-tested against a mock GLua; not run on a srcds server with a connected player. |

## Protection

Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## Assets

Maps, models, textures, sounds and other files players download. See [Selling assets](/docs/selling-assets).

| | |
|---|---|
| Support | Supported |
| `assets` | content of the addon (materials/, models/, sound/, maps/, resource/, particles/), each file added to the download list with resource.AddSingleFile |
| `environment_asset` | the same content roots, including .bsp maps under maps/ |
| Pack | `scriptgo pack --target garrysmod` |

Run on a dedicated server (srcds): every packed file was found by the engine and added to the download list. No client was run.

Asset escrow: Not feasible: GMod clients do not load server-sent binary modules.

## The platform's own rules

The developer allows selling mods you own, outside the Steam Workshop.

This is the platform's rule, shown as information: whoever runs a script there answers for following it. It does not change what can be sold on SCRIPT//GO. See [the rules](/docs/selling#the-rules).

## Limits

- Server side only: client scripts (HUD, Derma) need a game client and are not run yet.
- Verified on the Windows dedicated server (public branch, 32-bit LuaJIT 2.0.4 and 64-bit LuaJIT 2.1), headless, with a bot as the player; Linux servers and real Steam players are not measured yet.
- An empty server hibernates and stops ticking unless sv_hibernate_think is 1.
- CAMI is implemented but not yet run with a real admin mod.

## Real runs

Each row is a `scriptgo verify` run on Garry's Mod itself, not on a mock or an emulator: the package started there and its own tests reported back. Rows marked *probe* are SCRIPT//GO's conformance probes, which exercise the runtime and are never published as packages. See [how a status is earned](/docs/environments#how-a-status-is-earned).

| Script | Version | Ran on | Adapter | Checks passed | Date |
|---|---|---|---|---|---|
| `sg_probe` *probe* | 0.1.0 | Garry's Mod 2026.09.17 (x86) · LuaJIT 2.0.4 | garrysmod-0.1.0 | 39/39 | 2026-11-09 |
| `sg_probe_net` *probe* | 0.1.0 | Garry's Mod 2026.09.17 (x86) · LuaJIT 2.0.4 | garrysmod-0.1.0 | 23/23 | 2026-11-09 |
