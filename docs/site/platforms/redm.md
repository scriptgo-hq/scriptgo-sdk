---
title: RedM
description: How SCRIPT//GO scripts run on RedM: setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts on RedM roleplay servers, the same way as on FiveM.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [RedM page](/environments/redm) on the site is the short version.

| | |
|---|---|
| Status | Planned: not usable yet |
| Runs on | Server and client |
| Languages | Lua 5.4 |
| Protection | No licence check; releases are signed |
| Runtime | FXServer (gamename rdr3) and the RedM client (Lua 5.4) |

## How it runs

RedM runs the FiveM resource shape on the same FXServer. `scriptgo pack --target redm` emits a resource folder with a generated `fxmanifest.lua` (`game "rdr3"` and the `rdr3_warning` RedM requires) and the FiveM shim, loaded first, which maps `ScriptGo.*` onto CitizenFX natives. Threads, events and exports stay Cfx.re's own.

The adapter's code and README: [`sdk/adapters/redm`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/redm).

## Set up

Planned: there are no setup steps for it.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Supported | Cfx.re's own events and exports, as on FiveM; TriggerEvent runs its handlers at once instead of on the next tick. |
| `logging` | Supported | print to the server console (channel script:&lt;resource&gt;) or the client console, with the level in front. |
| `storage` | Supported | Resource KVP (GetResourceKvpString / SetResourceKvp) on both sides, values stored as JSON text. |
| `players` | Supported | Server side: GetPlayers, GetPlayerName, and the license: identifier. |
| `permissions` | Supported | Server side: ACE (IsPlayerAceAllowed), granted with add_ace in server.cfg. |
| `commands` | Supported | RegisterCommand; restricted commands check the ACE command.&lt;name&gt;. |
| `config` | Supported | Server side: the convar &lt;resource&gt;:&lt;key&gt; (set in server.cfg). |
| `ui` | Fallback | Chat messages (chat:addMessage, handled by the server's chat resource). |
| `http` | Partial | Server side, through PerformHttpRequest; redirects are not followed. No host allow-list: the server owner decides what a resource may call. |
| `licensing` | Not available | Not implemented: the FiveM shim has no licence check (see FiveM). |
| `perks` | Not available | Not switched on: the shim does not carry the core's perks module. |
| `presence` | Not available | Not on RedM yet: `scriptgo pack --target redm` leaves the shim's player match section out, and refuses a package that requires presence. |

## Protection

It runs the FiveM shim, which has no licence check, so a package runs there without one. Releases are still signed.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## Assets

Maps, models, textures, sounds and other files players download. See [Selling assets](/docs/selling-assets).

| | |
|---|---|
| Support | Supported |
| `assets` | as on FiveM: files under stream/ are streamed to players; other files are listed in files {} and downloaded by players |
| `environment_asset` | Red Dead Redemption 2 streamed files under stream/ and data files listed by data_file, declared with environment_asset "redm" (a GTA V file does not load in RDR2) |
| Pack | `scriptgo pack --target redm` |

Packed (fxmanifest with game rdr3 and rdr3_warning, files, data_file, this_is_a_map); not run on FXServer, which needs a Cfx.re licence key.

Asset escrow: No client work is possible from a resource: the game client is Cfx.re's. Cfx.re's own asset escrow encrypts Lua and .ydr, .ydd and .yft models when the creator uploads the resource to their own Cfx.re account; `scriptgo pack --target redm --cfx-escrow` builds that upload. Cfx.re encrypts it, not SCRIPT//GO, and it reaches buyers through Cfx.re as one copy for all, without SCRIPT//GO's per-buyer fingerprint.

## The platform's own rules

The platform's creator terms keep paid server content on its own marketplace (Rockstar Games Creator Platform License Agreement, 2026-09-10, §3.1(6)).

This is the platform's rule, shown as information: whoever runs a script there answers for following it. It does not change what can be sold on SCRIPT//GO. See [the rules](/docs/selling#the-rules).

## Limits

- Planned: no run on a real FXServer has passed yet. FXServer does not start without a Cfx.re registration key (sv_licenseKey).
- The shim is FiveM's: it calls only CitizenFX natives both games have. Nothing of it has run on RedM.
- No licence check: `scriptgo pack --target redm` refuses a package that needs one (`licensed true`, or the licensing capability), because the shim could not enforce it.
- Only the server half can be verified; the client half needs the game.
- `require` finds no resource module: list every module as a script. The client has no `os`.

## Real runs

No real run yet. Waiting for a server key: FXServer does not start without a Cfx.re registration key (sv_licenseKey).
