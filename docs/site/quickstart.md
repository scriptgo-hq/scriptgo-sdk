---
title: Quickstart
description: Write a resource once, test it in the standalone host, run it in other environments, then publish it.
order: 1
---

This guide builds a small resource from an empty folder. You will write a manifest, a portable
core, a server side that wires the core to the runtime, a test, and then run the same folder in
other environments. It takes about fifteen minutes.

If you have written an OPEN//77 or FiveM resource before, you already know the format. A
SCRIPT//GO package is a folder with a declarative manifest and shared, server and client scripts.

> [!WARNING]
> The `scriptgo` CLI and the environment adapters are in preview. Commands shown here come from
> the specs and may gain flags. See [CLI](/docs/cli) for the current state.

## 1. Lay out the folder

```text
inventory_pro/
  scriptgo.lua          manifest
  shared/core.lua       portable logic, no host calls
  server/main.lua       wires the core to the runtime
  tests/core_test.lua   run by `scriptgo test`, never shipped to clients
  README.md
```

The folder name must match the `resource` name in the manifest when a host loads it from disk.
Resource names are lowercase slugs: `a-z`, `0-9`, `_` and `-`, up to 64 characters.

`scriptgo init` creates this layout for you. Writing it by hand is just as valid.

## 2. Write the manifest

The manifest is **parsed, never executed**. Each line is a directive followed by its value.

```lua
resource "inventory_pro"
version "0.1.0"
scriptgo_version ">=0.1.0"

title "Inventory Pro"
description "Stacks, weights, persistence and events."
author "kestrel"
license "MIT"
category "inventory"

lua { "5.1", "5.4", "luajit" }
environments { "standalone", "love2d", "godot", "luanti" }
capabilities { "events", "storage" }
optional_capabilities { "ui" }

shared_script "shared/core.lua"
server_script "server/main.lua"
test_script "tests/core_test.lua"
```

`capabilities` lists what the resource **requires**. If a host lacks one, the resource does not
start. `optional_capabilities` lists what it uses when present. Every directive is described in
[Manifest](/docs/manifest).

## 3. Write the portable core

Keep business logic free of host calls. It is then trivially testable and identical everywhere.

```lua
-- shared/core.lua
Inventory = {}

function Inventory.new()
  return { items = {} }
end

function Inventory.add(inv, item, count)
  assert(type(item) == "string", "item must be a string")
  count = count or 1
  inv.items[item] = (inv.items[item] or 0) + count
  return inv.items[item]
end

function Inventory.count(inv, item)
  return inv.items[item] or 0
end
```

Shared scripts run on both sides, before side scripts, in a sandbox. `io`, `os.execute`, `load`
and `debug` are not available there. See [Runtime](/docs/runtime) for the full list.

## 4. Wire it to the runtime

The server side uses the same globals as OPEN//77: `CreateThread`, `Wait`, events and exports,
plus the `ScriptGo` namespace.

```lua
-- server/main.lua
local inventories = {}

local function load(owner)
  local saved = ScriptGo.storage.get("inventory/" .. owner)
  return saved or Inventory.new()
end

local function give(owner, item, count)
  local inv = inventories[owner] or load(owner)
  inventories[owner] = inv
  local total = Inventory.add(inv, item, count)
  ScriptGo.storage.set("inventory/" .. owner, inv)
  TriggerEvent("inventory_pro:itemAdded", owner, item, total)
  return total
end

exports("give", give)
exports("count", function(owner, item)
  return Inventory.count(inventories[owner] or load(owner), item)
end)

AddEventHandler("inventory_pro:itemAdded", function(owner, item, total)
  ScriptGo.log.info(owner .. " now has " .. total .. " x " .. item)
  if ScriptGo.capabilities.has("ui") then
    ScriptGo.ui.notify(-1, { type = "info", title = "Inventory", message = item .. " added" })
  end
end)

CreateThread(function()
  Wait(0)
  give("alder", "sword", 1)
end)
```

`ui` is optional here, so the handler checks for it before calling `ScriptGo.ui`. A required
capability needs no check: the host refuses to start the resource without it.

## 5. Test it

```lua
-- tests/core_test.lua
local inv = Inventory.new()
assert(Inventory.add(inv, "sword") == 1)
assert(Inventory.add(inv, "sword", 2) == 3)
assert(Inventory.count(inv, "shield") == 0)
```

```bash
scriptgo test
```

`scriptgo test` runs every `test_script` in the standalone host. A failed `assert` fails the run.

## 6. Run it in other environments

The resource folder does not change between environments. Only the host around it does. Each
host loads the SCRIPT//GO runtime (`sdk/lua/scriptgo`) with one adapter and ticks it from the
engine's own loop.

> [!WARNING]
> The adapters in `sdk/adapters/` are not published yet. The entry points below (`scriptgo.host`,
> `host:load`, `host:tick`) show the intended shape. Check each adapter's README for the exact
> calls once it ships.

```bash env=standalone
# The standalone host is the CLI adapter. Run the resource's tests in it:
scriptgo test
```

```lua env=love2d
-- main.lua of your LÖVE game. LÖVE runs LuaJIT.
local scriptgo = require("scriptgo")
local host = scriptgo.host(require("scriptgo.adapters.love2d"))

function love.load()
  host:load("resources/inventory_pro")
end

function love.update(dt)
  host:tick(dt)
end
```

```lua env=godot
-- Runs inside lua-gdextension (Lua 5.4). A GDScript autoload calls
-- tick(delta) from _process(delta).
local scriptgo = require("scriptgo")
local host = scriptgo.host(require("scriptgo.adapters.godot"))
host:load("res://resources/inventory_pro")

function tick(delta)
  host:tick(delta)
end
```

```lua env=luanti
-- init.lua of a Luanti mod. Luanti mods are server-side only.
local scriptgo = dofile(core.get_modpath(core.get_current_modname()) .. "/scriptgo/init.lua")
local host = scriptgo.host(dofile(core.get_modpath("scriptgo_luanti") .. "/adapter.lua"))
host:load(core.get_modpath(core.get_current_modname()) .. "/resources/inventory_pro")

core.register_globalstep(function(dtime)
  host:tick(dtime)
end)
```

In single-process hosts (standalone, LÖVE, Godot) the client side is player `1`, and network
events are looped back through the value codec. Isolation rules are the same as on a real network.

Which capabilities each environment provides is listed on [Environments](/environments). If your
resource requires one an environment lacks, the host reports
`capability_unavailable:<capability>@<environment>` and does not start it.

## 7. Publish

1. Create a personal access token in [Dashboard → Settings](/dashboard/settings). It starts with
   `sg_pat_` and is shown once.
2. Publish from the resource folder:

```bash
scriptgo publish
```

The archive is uploaded, its manifest parsed and its files hashed. Validation then runs: archive
safety, manifest, integrity, static checks, unit tests, and one run per declared environment.
You declare your rights to the code before the release can be published.

A published version is immutable. To fix `0.1.0`, publish `0.1.1`.

An environment shows **Verified** on your package page only after a compatibility run passed for
that release. Declaring an environment in the manifest is not enough: until a run passes, it
shows as **Not tested**.

## Next steps

- [Manifest](/docs/manifest): every directive and parsing rule.
- [Runtime](/docs/runtime): globals, the `ScriptGo` namespace, codec and sandbox.
- [SDK and capabilities](/docs/sdk/capabilities): write code that degrades cleanly.
- [Licensing API](/docs/licensing-api): sell your resource and check licenses from deployments.
