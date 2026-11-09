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
| A clock and a tick | `Wait`, `SetTimeout`, `ScriptGo.time.monotonic` |
| Persistence | `ScriptGo.storage` |
| Players | `ScriptGo.players`, `playerJoining`, `playerDropped` |
| Privileges | `ScriptGo.permissions.has` |
| Notification output | `ScriptGo.ui.notify`, the host log |
| HTTP (optional) | `ScriptGo.http`, `ScriptGo.licensing` |

Adding an environment means writing one adapter file. Nothing in the core or the platform changes.

## What an adapter looks like

> [!WARNING]
> The adapter interface is not frozen yet, and the reference adapters in `sdk/adapters/` have not
> been published. The skeleton below shows the responsibilities; field names may change. Follow
> the standalone adapter once it ships.

```lua
-- adapters/myengine.lua
return {
  environment = "myengine",          -- a lowercase slug
  luaVersion = _VERSION,

  -- Capabilities this host provides, each with its support level.
  capabilities = {
    events = "supported", logging = "supported", storage = "supported",
    players = "supported", permissions = "partial", commands = "supported",
    config = "supported", ui = "fallback", http = "unavailable", licensing = "unavailable",
  },

  clock = function() return MyEngine.time_seconds() end,

  storage = {
    read = function(resource, key) return MyEngine.kv_get(resource .. "/" .. key) end,
    write = function(resource, key, json) MyEngine.kv_set(resource .. "/" .. key, json) end,
  },

  players = {
    list = function() return MyEngine.connected_ids() end,
    name = function(id) return MyEngine.player_name(id) end,
  },

  hasPrivilege = function(playerId, privilege) return MyEngine.has_priv(playerId, privilege) end,

  notify = function(target, n) MyEngine.log(("[%s] %s"):format(n.title or "", n.message or "")) end,
}
```

Support levels are the registry's vocabulary: `supported`, `partial` (say what is missing),
`fallback` (for example `ui` printed to the log) and `unavailable`.

## Ticking the scheduler

Your engine already has a main loop. Call the runtime from it once per frame or server step.
`Wait(0)` resumes on the next tick.

```lua env=standalone
-- The standalone CLI owns its loop: it ticks until no thread or timer is pending.
```

```lua env=love2d
function love.update(dt)
  host:tick(dt)
end
```

```lua env=godot
-- Called from a GDScript autoload's _process(delta) through lua-gdextension.
function tick(delta)
  host:tick(delta)
end
```

```lua env=luanti
core.register_globalstep(function(dtime)
  host:tick(dtime)
end)
```

## Sides

Resources have a server side and a client side. Your adapter declares which ones your host runs:

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
> resources its operator chose to install. SCRIPT//GO itself only executes uploaded code inside
> isolated containers.

## Conformance

The goal is evidence, not a promise. Conformance is checked in three layers.

1. **Manifest fixtures.** `sdk/lua/spec/fixtures/manifests/` holds pairs of `*.lua` manifests and
   `*.expect.json` results. The Lua parser and the TypeScript parser (`packages/manifest`) must
   both produce the expected result for every pair. If your host parses manifests itself, run it
   against the same fixtures.
2. **Runtime behaviour.** The SDK's tests run the scheduler, events, exports, codec and sandbox on
   every Lua interpreter available (5.1, 5.4, LuaJIT). The repository exposes them as
   `corepack pnpm lua:test`. The suite is still being written.
3. **Real runs.** `scriptgo verify` runs resources in the real runtime and writes one
   `CompatibilityRun` report per environment into `verification/reports/`. The SCRIPT//GO CI
   ingests these reports.

A per-capability conformance suite with its own command does not exist yet. Until it does, the
official packages (`scriptgo//event-bus`, `scriptgo//inventory-kit`,
`scriptgo//permissions-kit`) serve as the reference workload: each exercises a set of
capabilities, and their runs show which ones your adapter handles.

## From adapter to listed environment

1. Open an issue or contact SCRIPT//GO with your adapter and its capability table.
2. CI runs the official packages in your runtime and records the results.
3. The environment appears in the directory as **Beta**, listing which capabilities pass and the
   gaps that remain. It becomes **Available** when the adapter is stable and the conformance runs
   pass.

Each environment page shows the adapter version, the Lua flavour, the runtime versions tested and
a link to the latest run. Statuses come from runs, never from a form.

OPEN//77 is an environment run by the same owners as SCRIPT//GO. It is shown as **Experimental**
until its integration tests pass and its legal review is complete. It gets no shortcut.

## See also

- [Runtime](/docs/runtime): the globals and the `ScriptGo` namespace your adapter backs.
- [SDK and capabilities](/docs/sdk/capabilities): how resources consume capabilities.
- [Environments](/environments): the current directory and its matrix.
