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
| `presence` | Not available | The adapter answers a player's address (core.get_player_ip), but presence is not switched on: perks are not, Luanti has no HMAC (only hashes), and a player name is not an account other servers share. |

## Protection

Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

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
