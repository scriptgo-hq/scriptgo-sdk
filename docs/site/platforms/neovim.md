---
title: Neovim
description: How SCRIPT//GO scripts run on Neovim: setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts inside the Neovim editor, as an ordinary plugin.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [Neovim page](/environments/neovim) on the site is the short version.

| | |
|---|---|
| Status | Beta: usable, tested on a real runtime, conformance partial |
| Runs on | Server and client |
| Languages | LuaJIT |
| Protection | Licence check and signed releases |
| Runtime | Neovim 0.12.6 (LuaJIT 2.1) |

## How it runs

An ordinary Neovim plugin. `setup()` starts the core in Neovim's LuaJIT, a libuv timer ticks it on the main loop, and `:ScriptGo <command>` runs resource commands. Server and local client run in the editor.

The adapter's code and README: [`sdk/adapters/neovim`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/neovim).

## Set up

Needs Neovim 0.10 or later (measured on 0.12.6) and `curl` for licensed packages.

1. Add `sdk/adapters/neovim/` to Neovim as a plugin. Inside the SDK checkout it finds the core by
   itself; elsewhere copy `sdk/lua/scriptgo/` to `lua/scriptgo_nvim/core/` in the plugin, or set
   `vim.g.scriptgo_core`. With lazy.nvim:

   ```lua
   {
     dir = "~/scriptgo/sdk/adapters/neovim",
     config = function()
       require("scriptgo_nvim").setup({
         search = { vim.fn.expand("~/scriptgo/resources") },
         resources = { "sg_inventory" },
         config = { permissions = { ["1"] = { "*" } } },
       })
     end,
   }
   ```

2. Use it from the editor:

   ```vim
   :ScriptGo status
   :ScriptGo giveitem 1 water 2
   :ScriptGo log
   ```

The server side and the local client (you, player `1`) run inside the editor, ticked by a timer on
the main loop. Notifications go to `vim.notify`; storage to `stdpath("data")/scriptgo/storage`.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Supported |  |
| `logging` | Supported |  |
| `storage` | Supported | JSON files under stdpath("data")/scriptgo/storage/&lt;key&gt;.json. |
| `players` | Partial | Single local player (id 1), the person at the keyboard. |
| `permissions` | Supported | Privileges per player id from the config passed to setup(). |
| `commands` | Supported | Resource commands are typed as :ScriptGo &lt;command&gt; and run as the local player. |
| `config` | Supported | Per-resource values and convars from the config passed to setup(). |
| `ui` | Supported | Notifications go to vim.notify; a headless run only logs them. |
| `http` | Partial | curl through vim.system (Neovim 0.10 or later), asynchronous so the editor never waits; unavailable without curl. Status and body only, no response headers. |
| `licensing` | Partial | Available exactly when http is. |
| `perks` | Not available | Not applicable: an editor has no players to sell a perk to. |
| `presence` | Not available | Not applicable: an editor has no players to match. |

## Protection

Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## Assets

Maps, models, textures, sounds and other files players download. See [Selling assets](/docs/selling-assets).

| | |
|---|---|
| Support | Bundled with the resource |
| `assets` | files of the resource (resource.readFile); there are no players to deliver to |
| `environment_asset` | files of the resource |

No game client downloads anything: assets are files of the resource.

Asset escrow: The host can read containers itself, but its operator holds the key: at-rest encryption only.

## Limits

- Single user: no real network between server and client.
- HTTP, and so online license checks, needs curl and Neovim 0.10 or later.
- Measured with Neovim 0.12.6 (LuaJIT 2.1) on Windows, headless (nvim --headless --clean -l); macOS, Linux and older Neovim releases are not measured yet.

## Real runs

Each row is a `scriptgo verify` run on Neovim itself, not on a mock or an emulator: the package started there and its own tests reported back. Rows marked *probe* are SCRIPT//GO's conformance probes, which exercise the runtime and are never published as packages. See [how a status is earned](/docs/environments#how-a-status-is-earned).

| Script | Version | Ran on | Adapter | Checks passed | Date |
|---|---|---|---|---|---|
| `inventory_pro` | 1.4.3 | Neovim 0.12 · LuaJIT 2.1.1774638290 | neovim-0.1.0 | 10/10 | 2026-11-09 |
| `sg_eventbus` | 1.0.2 | Neovim 0.12 · LuaJIT 2.1.1774638290 | neovim-0.1.0 | 7/7 | 2026-11-09 |
| `sg_inventory` | 1.0.2 | Neovim 0.12 · LuaJIT 2.1.1774638290 | neovim-0.1.0 | 7/7 | 2026-11-09 |
| `sg_permissions` | 1.0.2 | Neovim 0.12 · LuaJIT 2.1.1774638290 | neovim-0.1.0 | 7/7 | 2026-11-09 |
| `sg_probe` *probe* | 0.1.0 | Neovim 0.12 · LuaJIT 2.1.1774638290 | neovim-0.1.0 | 31/31 | 2026-11-09 |
| `sg_probe_net` *probe* | 0.1.0 | Neovim 0.12 · LuaJIT 2.1.1774638290 | neovim-0.1.0 | 18/18 | 2026-11-09 |
