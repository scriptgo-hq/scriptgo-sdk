---
title: BeamMP
description: How SCRIPT//GO scripts run on BeamMP: setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts on BeamMP servers (BeamNG.drive multiplayer), through one server plugin.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [BeamMP page](/environments/beammp) on the site is the short version.

| | |
|---|---|
| Status | Planned: not usable yet |
| Runs on | Server only |
| Languages | Lua 5.3 |
| Protection | Licence check and signed releases, planned |
| Runtime | BeamMP-Server 3.9.3 (Lua 5.3) |

## How it runs

One BeamMP server plugin, `scriptgo`, runs the core in the plugin's own Lua 5.3 state, ticked by a 25 ms event timer. `scriptgo pack --target beammp` builds it with the package and its dependencies.

The adapter's code and README: [`sdk/adapters/beammp`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/beammp).

## Set up

Planned: there are no setup steps for it.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Partial | Server side only: the plugin runs no client scripts, and TriggerClientEvent answers network_unavailable. |
| `logging` | Supported |  |
| `storage` | Supported | JSON files in the plugin's data/storage folder (scriptgo.json dataDir), replaced atomically. |
| `players` | Supported | MP.GetPlayers and the join and disconnect events. BeamMP id n is SCRIPT//GO player n + 1 (0 is the console); identifier is beammp:&lt;account id&gt;, beammp-guest:&lt;name&gt; for guests. |
| `permissions` | Supported | Grants in scriptgo.json, by beammp:&lt;account id&gt;, or by name for players logged in to BeamMP: BeamMP has no server-side roles. |
| `commands` | Supported | Chat commands (/name ...; the line is not broadcast) and the server console, where they run as the console. |
| `config` | Supported | scriptgo.json resources and convars. |
| `ui` | Partial | MP.SendNotification (a toast in the BeamMP client); its display is not verified, as no game client runs here. |
| `http` | Partial | curl started in the background through os.execute and polled each tick, so a request never blocks the plugin; needs curl on the server's PATH. BeamMP's own Http.CreateConnection has no POST and drops the response. |
| `licensing` | Partial | Over the same curl path, to the scriptgo_api convar. |
| `perks` | Not available | Not switched on: the core implements perks over http and the player identifier, which this adapter has, but it has not been wired or run here. |

## Protection

Licence check and signed releases, once the adapter has passed a run on a real server. The server plugin is plain Lua, so the operator can read what it loads: no code-secrecy claim.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## The platform's own rules

Neither BeamNG nor BeamMP publishes a rule on selling mods.

This is the platform's rule, shown as information: whoever runs a script there answers for following it. It does not change what can be sold on SCRIPT//GO. See [the rules](/docs/selling#the-rules).

## Limits

- Not verified on a real server yet: BeamMP-Server (3.9.3) refuses to start without an AuthKey from keymaster.beammp.com, which only the server owner can get. Until then the adapter has passed unit tests on a mock of BeamMP's Lua API only.
- Server side only: BeamNG.drive client mods are out of scope, and no game client is run.
- HTTP, and so online license checks, needs curl on the server's PATH.

## Real runs

No real run yet. Waiting for a server key: BeamMP-Server does not start without an AuthKey from the BeamMP Keymaster, which the server owner requests.
