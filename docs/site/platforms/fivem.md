---
title: FiveM
description: How SCRIPT//GO scripts run on FiveM: setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts on FiveM servers, packed as regular FiveM resources.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [FiveM page](/environments/fivem) on the site is the short version.

| | |
|---|---|
| Status | Planned: not usable yet |
| Runs on | Server and client |
| Languages | Lua 5.4 |
| Protection | No licence check; releases are signed |
| Runtime | FXServer and the FiveM client (Lua 5.4) |

## How it runs

FiveM already runs this resource shape. `scriptgo pack --target fivem` emits a resource folder with a generated `fxmanifest.lua` and one shared shim file, loaded first, that maps `ScriptGo.*` onto FiveM natives. Threads, events and exports stay FiveM's own.

The adapter's code and README: [`sdk/adapters/fivem`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/fivem).

## Set up

Planned: there are no setup steps for it.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Supported | FiveM's own events and exports; TriggerEvent runs its handlers at once instead of on the next tick. |
| `logging` | Supported | print to the server console (channel script:&lt;resource&gt;) or the client console, with the level in front. |
| `storage` | Supported | Resource KVP (GetResourceKvpString / SetResourceKvp) on both sides, values stored as JSON text. |
| `players` | Supported | Server side: GetPlayers, GetPlayerName, and the license: identifier. |
| `permissions` | Supported | Server side: ACE (IsPlayerAceAllowed), granted with add_ace in server.cfg. |
| `commands` | Supported | RegisterCommand; restricted commands check the ACE command.&lt;name&gt;. |
| `config` | Supported | Server side: the convar &lt;resource&gt;:&lt;key&gt; (set in server.cfg). |
| `ui` | Fallback | Chat messages (chat:addMessage, handled by FXServer's chat system resource). |
| `http` | Partial | Server side, through PerformHttpRequest; redirects are not followed. No host allow-list: the server owner decides what a resource may call. |
| `licensing` | Not available | Not implemented: the shim has no licence check. It was written without one after Rockstar's Creator Platform License Agreement (2026-09-10, §3.1(6)), which forbids a third-party marketplace that sells or licenses server content. |
| `perks` | Not available | Not switched on: the shim does not carry the core's perks module. |
| `presence` | Not available | The shim answers a player's address (GetPlayerEndpoint) for later use, but it does not carry the core's perks or presence modules, and FiveM's Lua has no HMAC. |

## Protection

No licence check in the shim, so a package runs there without one. Releases are still signed.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## The platform's own rules

The platform's creator terms keep paid server content on its own marketplace (Rockstar Games Creator Platform License Agreement, 2026-09-10, §3.1(6)).

This is the platform's rule, shown as information: whoever runs a script there answers for following it. It does not change what can be sold on SCRIPT//GO. See [the rules](/docs/selling#the-rules).

## Limits

- Planned: no run on a real FXServer has passed yet. FXServer does not start without a Cfx.re registration key (sv_licenseKey).
- No licence check: `scriptgo pack --target fivem` refuses a package that needs one (`licensed true`, or the licensing capability), because the shim could not enforce it.
- Only the server half can be verified; the client half needs the game.
- `require` finds no resource module on FiveM: list every module as a script.
- The client has no `os`: ScriptGo.time.now() is nil there.
- RedM runs the same shim (game rdr3); it is not built or verified yet.

## Real runs

No real run yet. Waiting for a server key: FXServer does not start without a Cfx.re registration key (sv_licenseKey).
