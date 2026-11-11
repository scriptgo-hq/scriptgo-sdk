---
title: CC: Tweaked (Minecraft)
description: How SCRIPT//GO scripts run on CC: Tweaked (Minecraft): setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts on a ComputerCraft computer in a Minecraft: Java Edition world, through the CC: Tweaked mod. Not an official Minecraft product; not approved by or associated with Mojang or Microsoft.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [CC: Tweaked (Minecraft) page](/environments/cctweaked) on the site is the short version.

| | |
|---|---|
| Status | Experimental: first real runs passed, more to measure |
| Runs on | Server and client |
| Languages | Lua 5.2 |
| Protection | No licence check; releases are signed |
| Runtime | CC: Tweaked 1.121.0 on a Minecraft 1.20.1 Fabric server (Cobalt, Lua 5.2) |

## How it runs

A program on one ComputerCraft computer, which the CC: Tweaked mod adds to a Fabric server. It runs the core in the computer's Lua 5.2 VM, ticked by a CC timer every server tick; the server and client sides both run on that computer.

The adapter's code and README: [`sdk/adapters/cctweaked`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/cctweaked).

## Set up

Needs a Minecraft: Java Edition server you own or run, with [Fabric](https://fabricmc.net) and the
[CC: Tweaked](https://tweaked.cc) mod (measured with Minecraft 1.20.1, Fabric loader 0.20.1, Fabric API
0.92.12 and CC: Tweaked 1.121.0). Not an official Minecraft product. Not approved by or associated
with Mojang or Microsoft. Not affiliated with the CC: Tweaked developers.

**The platform's own rules.** The [Minecraft EULA](https://www.minecraft.net/en-us/eula) lets you do
what you want with mods you create "as long as you don't sell them for money / try to make money from
them". SCRIPT//GO does not enforce a platform's rules: you answer to the platform's rights holder for
what you run on your server.

**No licence check.** This adapter has none. It was built without one after the
[Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines), which allow a mod
only if it "cannot be used to directly or indirectly verify whether a player owns or has access to
out-of-game content, products, or services that affect in-game features and functions". A package
runs here without a licence check.

1. Build the computer's files, with your resources:

   ```sh
   node sdk/adapters/cctweaked/build.mjs --with path/to/my_resource --startup
   ```

   This writes `dist/cctweaked/computer/`: the SCRIPT//GO core, the adapter, the `sg` program and
   your resources. Optional: `scriptgo/config.json` there sets permissions, config and convars:

   ```json
   { "permissions": { "1": ["*"] }, "resources": { "my_resource": { "greeting": "hi" } } }
   ```

2. Place a computer in the world, note its id (`id` in its shell), stop the server and copy the
   folder's contents into `<world>/computercraft/computer/<id>/`. The default disk of a computer is
   1 MB (`computer_space_limit` in `<world>/serverconfig/computercraft-server.toml`).

3. Start the server and use the computer: with `--startup` it runs SCRIPT//GO at boot; otherwise
   type `scriptgo/sg`. At the `sg>` prompt, resource commands run as the person at the terminal
   (player `1`); `status`, `log`, `restart <name>` and `exit` drive the host.

Running a Minecraft server, including the headless one `scriptgo verify --env cctweaked` starts,
means accepting the [Minecraft EULA](https://www.minecraft.net/en-us/eula): the operator must accept
it themselves (`eula=true` in the server's `eula.txt`, or `--accept-minecraft-eula` on a verify run).
SCRIPT//GO never accepts it for anyone.

HTTP, when a resource uses it, goes through CC: Tweaked's `http` API, so the server's
`computercraft-server.toml` decides whether it is on and which hosts answer (`[[http.rules]]`; local
and private addresses are denied by default).

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Supported | Server and client run on the same computer; network events between them are looped back through the value codec. |
| `logging` | Supported |  |
| `storage` | Supported | JSON files on the computer's own disk (/scriptgo/data/&lt;key&gt;.json), within the server's computer_space_limit (1 MB by default). |
| `players` | Partial | One player: the person at the computer's terminal (id 1). The world's other players are not visible. |
| `permissions` | Supported | Privileges per player id from /scriptgo/config.json. |
| `commands` | Supported | Typed at the computer's sg&gt; prompt; they run as the terminal player. |
| `config` | Supported | Per-resource values from /scriptgo/config.json; convars from config.json, then the computer's settings. |
| `ui` | Fallback | Notifications are lines on the computer's terminal. |
| `http` | Partial | CC: Tweaked's asynchronous http API. The server owner decides in computercraft-server.toml whether it is on and which hosts answer ([[http.rules]]; private and local addresses are denied by default). Redirects are not followed. |
| `licensing` | Not available | Not implemented: this adapter was built without a licence check, after the Minecraft Usage Guidelines, which allow a mod only if it "cannot be used to directly or indirectly verify whether a player owns or has access to out-of-game content, products, or services that affect in-game features and functions" (minecraft.net/en-us/usage-guidelines). |
| `perks` | Not available | Not implemented, for the reason given for licensing. |

## Protection

No licence check in this adapter, so a package runs there without one. Releases are still signed.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## The platform's own rules

The Minecraft EULA lets you do what you want with your mods "as long as you don't sell them for money" (minecraft.net/en-us/eula).

This is the platform's rule, shown as information: whoever runs a script there answers for following it. It does not change what can be sold on SCRIPT//GO. See [the rules](/docs/selling#the-rules).

## Limits

- Experimental: one real server run so far, the conformance probe (35 of 35 checks). The official kits fail there only because they do not declare cctweaked yet. Each run needs the operator's own acceptance of the Minecraft EULA.
- No licence check in this adapter (see the licensing note). What the Minecraft EULA says about paid mods is the platform's own rule, shown as the platform note.
- Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft. Not affiliated with the CC: Tweaked developers.
- Lua 5.2 (Cobalt VM): no // or bitwise operators (use bit32), no collectgarbage.
- Everything runs on one computer: code that runs for about 7 seconds without yielding is stopped by CC: Tweaked ("Too long without yielding").
- Pinned for runs: Minecraft 1.20.1, Fabric loader 0.20.1, CC: Tweaked 1.121.0. Other versions are not measured.
- Fast tests use the cc-core harness (CC: Tweaked's own core and Lua VM without Minecraft); those runs are an emulator and do not count as verification.

## Real runs

Each row is a `scriptgo verify` run on CC: Tweaked (Minecraft) itself, not on a mock or an emulator: the package started there and its own tests reported back. Rows marked *probe* are SCRIPT//GO's conformance probes, which exercise the runtime and are never published as packages. See [how a status is earned](/docs/environments#how-a-status-is-earned).

| Script | Version | Ran on | Adapter | Checks passed | Date |
|---|---|---|---|---|---|
| `sg_probe` *probe* | 0.1.0 | CC: Tweaked 1.121.0, Minecraft 1.20.1 · Lua 5.2 | cctweaked-0.1.0 | 35/35 | 2026-11-09 |
