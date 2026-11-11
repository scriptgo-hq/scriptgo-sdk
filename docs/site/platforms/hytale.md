---
title: Hytale
description: How SCRIPT//GO scripts run on Hytale: setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts on Hytale servers, through one server plugin. Players install nothing.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [Hytale page](/environments/hytale) on the site is the short version.

| | |
|---|---|
| Status | Planned: not usable yet |
| Runs on | Server only |
| Languages | Lua 5.2 |
| Protection | Code escrow, planned |
| Runtime | Hytale server (Java, JDK 25) with Cobalt 0.9.9 (Lua 5.2) |

## How it runs

A Java server plugin that embeds Cobalt, a Lua 5.2 VM written in Java, and runs the core on its own host thread, never on a world thread. Players install nothing.

The adapter's code and README: [`sdk/adapters/hytale`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/hytale).

## Set up

Planned: there are no setup steps for it.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Partial | Server side only: Hytale plugins run on the server and players install nothing. |
| `logging` | Supported | The server log, through the plugin's logger. |
| `storage` | Supported | JSON files in the plugin's data folder (mods/ScriptGo_ScriptGo/storage/&lt;key&gt;.json). |
| `players` | Supported | Connect and disconnect events; session ids, names, identifier hytale:&lt;uuid&gt;. |
| `permissions` | Supported | Hytale permission nodes scriptgo.admin or scriptgo.&lt;privilege&gt;, then the grants in scriptgo.json. |
| `commands` | Partial | Commands known when the server starts become /commands; any command also runs as /sg &lt;command&gt;. |
| `config` | Supported | Per-resource values and convars from scriptgo.json in the plugin's data folder. |
| `ui` | Fallback | Notifications are sent as chat messages. |
| `http` | Partial | java.net.http, off until the operator lists hosts in scriptgo.json http.allowedHosts; redirects are never followed. |
| `licensing` | Partial | Available exactly when http is. |
| `perks` | Not available | Not switched on: the core implements perks over http and the player identifier, which this adapter has, but it has not been wired or run here. |

## Protection

Code escrow is planned: a JVM plugin with a native library would hold the key. Until it exists, licence check and signed releases only.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## The platform's own rules

The game's terms allow paid mods and plugins.

This is the platform's rule, shown as information: whoever runs a script there answers for following it. It does not change what can be sold on SCRIPT//GO. See [the rules](/docs/selling#the-rules).

## Limits

- Not run on a real Hytale server yet: the bridge passes the conformance probe on a plain JVM only (Cobalt, Lua 5.2).
- No client side.
- Lua 5.2 in the JVM (Cobalt): no io library and no C modules; os has time, clock, date and difftime.
- Commands a resource registers after the server has started are reached through /sg &lt;command&gt;.
- HTTP, and so online license checks, only to hosts the operator allows.

## Real runs

No real run yet. Waiting for the Hytale server files, which come with a Hytale account, and for a JDK 25 to build the plugin against them.
