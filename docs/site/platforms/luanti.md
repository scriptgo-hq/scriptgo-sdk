---
title: Luanti
description: How SCRIPT//GO scripts run on Luanti: setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts on Luanti (formerly Minetest) servers, through one regular mod.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [Luanti page](/environments/luanti) on the site is the short version.

| | |
|---|---|
| Status | Beta: usable, tested on a real runtime, conformance partial |
| Runs on | Server only |
| Languages | Lua 5.1, LuaJIT |
| Protection | Licence check and signed releases |
| Runtime | Luanti 5.18.0 server (LuaJIT 2.1) |

## How it runs

One regular Luanti mod, `scriptgo`, runs the core in the server's Lua and ticks it from a globalstep. It needs no trusted-mod entry; HTTP needs the server owner to list it in `secure.http_mods`.

The adapter's code and README: [`sdk/adapters/luanti`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/luanti).

## Set up

1. Build the mod, optionally with resources bundled in:

   ```bash
   node sdk/adapters/luanti/build.mjs --with sdk/packages/sg_inventory --with sdk/packages/sg_eventbus
   ```

2. Copy `dist/luanti/scriptgo/` into the server's `mods/` folder and enable it for the world
   (`load_mod_scriptgo = true` in `world.mt`). It is a regular mod: it needs no entry in
   `secure.trusted_mods`.
3. Put further resources in `<world>/scriptgo/resources/<name>/`. Every resource with
   `auto_start true` starts with the server, dependencies first.
4. Optional `<world>/scriptgo.json`:

   ```json
   {
     "resources": { "sg_inventory": { "slots": 30 } },
     "convars": { "scriptgo_api": "https://api.scriptgo.dev" },
     "permissions": { "alice": ["command.giveitem"] }
   }
   ```

Only the server side runs. HTTP, and so online license checks, needs the mod listed in
`secure.http_mods` by the server owner.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Partial | Server side only; client scripts do not run (Luanti mods are server-side). |
| `logging` | Supported |  |
| `storage` | Supported |  |
| `players` | Supported | Player names get session-stable integer ids; identifier is luanti:&lt;name&gt;. |
| `permissions` | Supported | server or scriptgo_admin privilege, then the grants in &lt;world&gt;/scriptgo.json. |
| `commands` | Supported | Resource commands are ordinary chat commands. |
| `config` | Supported |  |
| `ui` | Fallback | Notifications are sent as chat messages. |
| `http` | Partial | Needs the mod listed in secure.http_mods by the server owner. |
| `licensing` | Partial |  |
| `perks` | Not available | Not switched on: the core implements perks over http and the player identifier, which this adapter has, but it has not been wired or run here. |
| `presence` | Partial | With http: /link works, and presence reports only in address mode (`scriptgo_presence_addr`, default off; the owner's decision on it is pending): the normalised address is sent and SCRIPT//GO fingerprints it at once, from core.get_player_ip; Luanti has no HMAC. The identifier is the player name, which is not an account other servers share. Unit-tested through the core; not run on a Luanti server with a connected player. |

## Protection

Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## Assets

Maps, models, textures, sounds and other files players download. See [Selling assets](/docs/selling-assets).

| | |
|---|---|
| Support | Supported |
| `assets` | mod media (textures/, sounds/, models/, media/, locale/, fonts/) in a generated media mod: the engine sends it to every client at join |
| `environment_asset` | the same media folders |
| Pack | `scriptgo pack --target luanti` |

Run on Luanti 5.18.0 (official server image): every packed media file was announced to clients with the SHA-1 of its bytes. No client was run.

Asset escrow: Not available: the server sends media in clear and each client caches it by hash; a decryptor would need an engine fork. What protects it: the licence-gated download and the copy's fingerprint record in the media mod.

## Limits

- No client side.
- HTTP, and so online license checks, only when the server owner allows it.
- Verified headless on Luanti 5.18.0 (LuaJIT); paths that need a connected player are not yet covered by a run.

## Real runs

Each row is a `scriptgo verify` run on Luanti itself, not on a mock or an emulator: the package started there and its own tests reported back. Rows marked *probe* are SCRIPT//GO's conformance probes, which exercise the runtime and are never published as packages. See [how a status is earned](/docs/environments#how-a-status-is-earned).

| Script | Version | Ran on | Adapter | Checks passed | Date |
|---|---|---|---|---|---|
| `sg_eventbus` | 1.0.2 | Luanti 5.18.0 · LuaJIT 2.1.1793275035 | luanti-0.1.0 | 6/6 | 2026-11-09 |
| `sg_inventory` | 1.0.2 | Luanti 5.18.0 · LuaJIT 2.1.1793275035 | luanti-0.1.0 | 6/6 | 2026-11-09 |
| `sg_permissions` | 1.0.2 | Luanti 5.18.0 · LuaJIT 2.1.1793275035 | luanti-0.1.0 | 6/6 | 2026-11-09 |
| `sg_probe` *probe* | 0.1.0 | Luanti 5.18.0 · LuaJIT 2.1.1793275035 | luanti-0.1.0 | 30/30 | 2026-11-09 |
