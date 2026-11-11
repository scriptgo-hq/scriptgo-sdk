---
title: Godot 4
description: How SCRIPT//GO scripts run on Godot 4: setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts in Godot 4 games, through a Lua add-on.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [Godot 4 page](/environments/godot) on the site is the short version.

| | |
|---|---|
| Status | Beta: usable, tested on a real runtime, conformance partial |
| Runs on | Server and client |
| Languages | Lua 5.4, LuaJIT |
| Protection | Licence check and signed releases, planned |
| Runtime | Godot 4.5.2 with lua-gdextension 0.7.0 (Lua 5.4 or LuaJIT) |

## How it runs

An autoload node, `ScriptGoHost`, creates a Lua state through the lua-gdextension addon, runs the core in it and ticks it from `_process`. Server and local client share the game process.

The adapter's code and README: [`sdk/adapters/godot`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/godot).

## Set up

Measured with Godot 4.5.2 and lua-gdextension 0.7.0 (0.8.x needs Godot 4.6).

1. Copy `addons/lua-gdextension` from the lua-gdextension release into the project.
2. Copy `scriptgo_host.gd` and `scriptgo_watchdog.gd` from `sdk/adapters/godot/` to
   `res://addons/scriptgo/` and register them as autoloads, watchdog first:

   ```ini
   [autoload]
   ScriptGoWatchdog="*res://addons/scriptgo/scriptgo_watchdog.gd"
   ScriptGoHost="*res://addons/scriptgo/scriptgo_host.gd"
   ```

3. Import once (`Godot --headless --import --path <project>`, or open the editor) so the
   extension is registered.
4. Point the host at the SDK (`sdk_root`, `--scriptgo-sdk <dir>`, or a copy under
   `res://addons/scriptgo/sdk/`), then boot it:

   ```gdscript
   func _ready():
       ScriptGoHost.boot({ "config": { "permissions": { "1": ["inventory.*"] } } })
       ScriptGoHost.add_search_path(ScriptGoHost.sdk_path + "packages")
       ScriptGoHost.add_resource(ScriptGoHost.sdk_path + "packages/sg_inventory")
       ScriptGoHost.start_all()
       ScriptGoHost.join(1, "Player")
   ```

The host ticks from `_process`. There is no HTTP yet, so licensed packages do not run on Godot.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Supported |  |
| `logging` | Supported |  |
| `storage` | Supported | JSON files at user://scriptgo/storage/&lt;key&gt;.json, written with FileAccess. |
| `players` | Partial | Single local player (id 1) joined by the scene; ScriptGoHost.join adds simulated ones. |
| `permissions` | Supported | Privileges per player id from the config passed to ScriptGoHost.boot. |
| `commands` | Supported |  |
| `config` | Supported | Per-resource values and convars from the config passed to ScriptGoHost.boot. |
| `ui` | Supported | Queued for the scene (ScriptGoHost.notified signal) and logged; the demo draws them as toasts. |
| `http` | Not available | Not implemented: no outbound HTTP from resources yet. |
| `licensing` | Not available | Needs http. |
| `perks` | Not available | Needs http, which this adapter does not have. |
| `presence` | Not available | Needs http, which this adapter does not have. |

## Protection

Licence check and signed releases, once the adapter has HTTP. The adapter is script-level, so the operator can read what it loads; a native GDExtension loader would be a later upgrade.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## Limits

- Needs the lua-gdextension addon, 0.7.0 for Godot 4.5 (it declares 4.4 as its minimum; the 0.8.x binaries are built for Godot 4.6 and refuse 4.5.2).
- No HTTP, so no online license checks.
- Single-player only: no real network between server and client.
- Measured with Godot 4.5.2 on Windows x86_64, headless and windowed, with the Lua 5.4 and LuaJIT builds of lua-gdextension 0.7.0; exported builds, macOS, Linux, mobile and Web are not measured yet.

## Real runs

Each row is a `scriptgo verify` run on Godot 4 itself, not on a mock or an emulator: the package started there and its own tests reported back. Rows marked *probe* are SCRIPT//GO's conformance probes, which exercise the runtime and are never published as packages. See [how a status is earned](/docs/environments#how-a-status-is-earned).

| Script | Version | Ran on | Adapter | Checks passed | Date |
|---|---|---|---|---|---|
| `sg_eventbus` | 1.0.2 | Godot 4.5.2-stable · Lua 5.4 | godot-0.1.0 | 8/8 | 2026-11-09 |
| `sg_inventory` | 1.0.2 | Godot 4.5.2-stable · Lua 5.4 | godot-0.1.0 | 8/8 | 2026-11-09 |
| `sg_permissions` | 1.0.2 | Godot 4.5.2-stable · Lua 5.4 | godot-0.1.0 | 8/8 | 2026-11-09 |
| `sg_probe` *probe* | 0.1.0 | Godot 4.5.2-stable · Lua 5.4 | godot-0.1.0 | 32/32 | 2026-11-09 |
