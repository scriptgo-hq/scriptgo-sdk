---
title: Create an adapter
description: Bring SCRIPT//GO resources to your engine or framework by writing one adapter file and passing the conformance runs.
order: 7
---

This guide is for people who maintain an engine, a framework or a game server and want their
users to run SCRIPT//GO resources. You do not port the runtime. You write an **adapter**: one
file that connects the portable runtime to your host.

## How the pieces fit

The runtime in `sdk/lua/scriptgo` is pure Lua, compatible with Lua 5.1, 5.4 and LuaJIT. It
implements everything that does not depend on an engine: the manifest parser, the scheduler
(`CreateThread`, `Wait`, timers), events, exports, the value codec, the sandbox and the capability
registry. **It knows nothing about engines.**

The adapter supplies only what the host owns:

| The adapter supplies | Used by |
|---|---|
| A clock | `Wait`, `SetTimeout`, `ScriptGo.time.monotonic` |
| File reads (and a file listing, for script globs) | Loading resources, `ScriptGo.resource.readFile`, `require` |
| Persistence | `ScriptGo.storage` |
| Players (optional; the host tracks joins itself) | `ScriptGo.players`, `playerJoining`, `playerDropped` |
| Privileges | `ScriptGo.permissions.has`, restricted commands |
| Configuration | `ScriptGo.config.get`, `GetConvar` |
| Notification output and logging | `ScriptGo.ui.notify`, the host log |
| HTTP (optional) | `ScriptGo.http`, `ScriptGo.licensing` |

The core does not change. To be listed, an environment also needs an entry in the support matrix
(`sdk/lua/scriptgo/capabilities.lua`, from which `sdk/environments.json` is generated).

## What an adapter looks like

The adapter is a plain table. The reference adapters in `sdk/adapters/` (`standalone`, `love2d`,
`godot`, `luanti`, `neovim`) show complete ones; the in-memory adapter in `sdk/lua/scriptgo/testing.lua` is
the smallest.

```lua
-- adapters/myengine.lua
return {
  environment = "myengine",                   -- a lowercase slug
  adapterVersion = "myengine-0.1.0",
  sides = { server = true, client = true },   -- the resource sides this host runs

  -- true when this host provides the capability. events and logging are always on.
  capabilities = {
    storage = true, players = true, permissions = true, commands = true,
    config = true, ui = true, http = false, licensing = false,
  },

  now = function() return MyEngine.time_seconds() end,          -- monotonic, in seconds
  log = function(level, origin, message) MyEngine.log(level, origin .. ": " .. message) end,
  readFile = function(path) return MyEngine.read_text(path) end, -- nil when missing
  listFiles = function(root) return MyEngine.list_files(root) end, -- optional

  storage = {
    load = function(key) return MyEngine.kv_get(key) end,       -- JSON text or nil
    save = function(key, text) MyEngine.kv_set(key, text) end,
  },

  permissions = {
    has = function(playerId, privilege) return MyEngine.has_priv(playerId, privilege) end,
  },

  config = {
    -- resourceName is nil for a convar (GetConvar).
    get = function(resourceName, key) return MyEngine.setting(resourceName, key) end,
  },

  ui = {
    notify = function(target, n) MyEngine.toast(target, n.title, n.message) end,
  },

  -- Optional: request({ method, url, headers, body }, done), then done({ status, body, headers }).
  -- http = { request = function(req, done) ... end },
}
```

The host is created around it:

```lua
local scriptgo = dofile("sdk/lua/scriptgo/init.lua")
local host = scriptgo.newHost({ adapter = dofile("adapters/myengine.lua") })
host:addResource("resources/inventory_pro")
host:startAll()
host:playerJoin(1, "Ada")
```

Capability values in the adapter are `true` or `false`. The support levels the registry shows are
declared in the matrix, not in the adapter: `supported`, `partial` (say what is missing),
`fallback` (for example `ui` printed to the log) and `unavailable`.

## Ticking the scheduler

Your engine already has a main loop. Call `host:tick()` from it once per frame or server step;
without an argument it reads the time from the adapter's `now`. `Wait(0)` resumes on the next
tick.

```lua env=standalone
-- The standalone CLI owns its loop: `scriptgo run` ticks the host in 10 ms steps of simulated
-- time, or in real time with --realtime.
```

```lua env=love2d
-- sdk/adapters/love2d/scriptgo_love.lua ticks the host from sg:update(dt).
function love.update(dt)
  sg:update(dt)
end
```

```gdscript env=godot
# The ScriptGoHost autoload (sdk/adapters/godot/scriptgo_host.gd) ticks the host from
# _process while auto_tick is on; ScriptGoHost.tick() ticks it by hand.
```

```lua env=luanti
-- What the scriptgo mod (sdk/adapters/luanti/mod/init.lua) does:
core.register_globalstep(function() host:tick() end)
```

```lua env=neovim
-- What the plugin (sdk/adapters/neovim/lua/scriptgo_nvim/init.lua) does: a libuv timer whose
-- callback runs on the main loop, so resources never run inside a fast event.
timer:start(0, 10, vim.schedule_wrap(function() host:tick() end))
```

## Sides

Resources have a server side and a client side. Your adapter declares which ones your host runs
(`sides`):

- **Single-process hosts** (a game, a desktop app) run both. The client side is player `1`.
  Network events are **looped back through the value codec**, so tables are copied and functions
  are refused exactly as on a real network. Do not shortcut this: resources must behave the same
  everywhere.
- **Server-only hosts** run only server scripts. Luanti is one: its mods are server-side.
- **Networked hosts** connect real servers and real clients. OPEN//77 runs the format natively;
  its adapter is a shim mapping `ScriptGo.*` onto `Open77.*`.

## Sandbox expectations

The runtime builds each resource side's environment itself. Your adapter must not widen it.
Do not expose `io`, `os.execute`, `debug`, `package`, `load`, `loadstring`, `dofile` or the
engine's raw API to resources. Expose engine features as capabilities instead.

> [!NOTE]
> The Lua sandbox is **not a security boundary for untrusted code**. Your host should load
> resources its operator chose to install. SCRIPT//GO itself does not execute uploaded code yet:
> its validation only parses it.

## Conformance

The goal is evidence, not a promise. Conformance is checked in three layers.

1. **Manifest fixtures.** `sdk/lua/spec/fixtures/manifests/` holds pairs of `*.lua` manifests and
   `*.expect.json` results. The Lua parser and the TypeScript parser (`packages/manifest`) must
   both produce the expected result for every pair. If your host parses manifests itself, run it
   against the same fixtures.
2. **Runtime behaviour.** The SDK's tests run the scheduler, events, exports, codec and sandbox on
   every Lua interpreter in `tools/runtimes/bin` (5.1, 5.4, LuaJIT, built by
   `tools/build-lua.ps1`). The repository exposes them as `corepack pnpm lua:test`.
3. **Real runs.** `scriptgo verify` runs resources in the real runtime and writes one
   `CompatibilityRun` report per run into `verification/reports/`. The registry ingests these
   reports through `POST /v1/admin/compatibility-runs`.

The conformance probes in `sdk/conformance/` are the reference workload. `sg_probe` prints one
`SGCHECK PASS|FAIL <name>` line per check (storage, time, capabilities and the
`capability_unavailable` refusal, permissions, config, promises, exports, and the official
EventBus and Permissions kits), and `scriptgo verify` turns those lines into checks of its
report. `sg_probe_net` checks `ScriptGo.http` and `ScriptGo.licensing` against an API. The
official packages (`scriptgo//event-bus`, `scriptgo//inventory-kit`,
`scriptgo//permissions-kit`) add more workload. A host that does not use the CLI writes the same
report itself, as the LÖVE and Godot verification modes do.

## From adapter to listed environment

1. Open an issue or contact SCRIPT//GO with your adapter and its capability table.
2. The conformance probes and the official packages are run in your runtime, and their reports
   are ingested by the registry.
3. The environment appears in the directory as **Beta**, listing its capabilities and the gaps
   that remain. It becomes **Available** when the adapter is stable and the conformance runs
   pass.

Each environment page shows the adapter version, the Lua flavour, the runtime versions tested and
the latest run (its status, date and run id). **Verified** comes from runs, never from a form.

OPEN//77 is an environment run by the same owners as SCRIPT//GO. It is shown as **Experimental**
until its integration tests pass and its legal review is complete. It gets no shortcut.

## See also

- [Runtime](/docs/runtime): the globals and the `ScriptGo` namespace your adapter backs.
- [SDK and capabilities](/docs/sdk/capabilities): how resources consume capabilities.
- [Environments](/environments): the current directory and its matrix.
