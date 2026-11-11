---
title: LÖVE
description: How SCRIPT//GO scripts run on LÖVE: setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts in 2D games made with LÖVE.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [LÖVE page](/environments/love2d) on the site is the short version.

| | |
|---|---|
| Status | Beta: usable, tested on a real runtime, conformance partial |
| Runs on | Server and client |
| Languages | LuaJIT |
| Protection | Licence check and signed releases |
| Runtime | LÖVE 11.5 (LuaJIT 2.1) |

## How it runs

A Lua module the game loads, `scriptgo_love.lua`. It runs the core in LÖVE's LuaJIT, ticks it from `love.update` through `sg:update(dt)` and draws notifications with `sg:draw()`. Server and local client share the game process.

The adapter's code and README: [`sdk/adapters/love2d`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/love2d).

## Set up

1. Copy `scriptgo_love.lua`, `adapter.lua` and `verify.lua` from `sdk/adapters/love2d/` into the
   game (for example `lib/`), and the core `sdk/lua/scriptgo/` next to them as `lib/scriptgo/`.
2. Put resources in a folder of the game, for example `resources/sg_inventory/`.
3. Create the host in `love.load` and drive it from the game's callbacks:

   ```lua
   local scriptgoLove = require("lib.scriptgo_love")
   local sg
   function love.load()
       sg = scriptgoLove.new({
           resources = { "sg_inventory" },          -- dependencies are added too
           search = { "resources" },
           player = { id = 1, name = "Ada" },
           config = { permissions = { ["1"] = { "inventory.give" } } },
       })
   end
   function love.update(dt) sg:update(dt) end
   function love.draw() --[[ the game ]] sg:draw() end
   function love.quit() sg:shutdown() end
   ```

The server side and the local client (player `1`) both run in the game process. Storage goes to
the save directory; HTTP and licensing use `curl` in a `love.thread` worker, so frames keep running.
The layout works from a folder and from a `.love` archive.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Supported |  |
| `logging` | Supported |  |
| `storage` | Supported | JSON files in the game's save directory (scriptgo/storage/&lt;key&gt;.json). |
| `players` | Partial | Single local player (id 1), the game's own client side. |
| `permissions` | Supported | Privileges per player id from the config table the game passes. |
| `commands` | Supported |  |
| `config` | Supported | Per-resource values and convars from the config table the game passes. |
| `ui` | Supported | On-screen toasts drawn by sg:draw(); also logged. Without love.graphics (headless) they are only logged. |
| `http` | Partial | curl through io.popen, run in a love.thread worker so frames keep running; unavailable when io.popen or curl is missing. Status and body only, no response headers. |
| `licensing` | Partial | Available exactly when http is. |
| `perks` | Not available | Not switched on: a single local player, with no account to tie a purchase to. |

## Protection

Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## Limits

- Single-player only: no real network between server and client.
- HTTP needs io.popen and a curl executable (on the PATH, or opts.curl).
- Measured with LÖVE 11.5 (LuaJIT 2.1) on Windows, as a folder and as a .love archive, through lovec.exe; macOS, Linux, mobile and fused builds are not measured yet.

## Real runs

Each row is a `scriptgo verify` run on LÖVE itself, not on a mock or an emulator: the package started there and its own tests reported back. Rows marked *probe* are SCRIPT//GO's conformance probes, which exercise the runtime and are never published as packages. See [how a status is earned](/docs/environments#how-a-status-is-earned).

| Script | Version | Ran on | Adapter | Checks passed | Date |
|---|---|---|---|---|---|
| `inventory_pro` | 1.4.3 | LÖVE 11.5 · LuaJIT 2.1.1700008891 | 0.1.0 | 10/10 | 2026-11-09 |
| `sg_eventbus` | 1.0.2 | LÖVE 11.5 · LuaJIT 2.1.1700008891 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_inventory` | 1.0.2 | LÖVE 11.5 · LuaJIT 2.1.1700008891 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_permissions` | 1.0.2 | LÖVE 11.5 · LuaJIT 2.1.1700008891 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_probe` *probe* | 0.1.0 | LÖVE 11.5 · LuaJIT 2.1.1700008891 | 0.1.0 | 31/31 | 2026-11-09 |
