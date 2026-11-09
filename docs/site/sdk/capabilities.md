---
title: SDK and capabilities
description: How resources ask for host features, how to check for them, and how to degrade cleanly when one is missing.
order: 4
---

Every SCRIPT//GO host exposes the same runtime. What differs between environments is expressed
as **capabilities**: named interfaces such as `storage` or `ui` that a host either provides or
does not. A resource declares the capabilities it needs; the host decides whether it can start.

The runtime itself is described in [Runtime](/docs/runtime). This page explains how to use
capabilities well.

## The ten capabilities

| Capability | What it gives you | `ScriptGo` members |
|---|---|---|
| `events` | Local and network events | `events.on/off/emit`, `net.emitServer`, `net.emitClient` |
| `logging` | The host log | `log.debug/info/warn/error` |
| `storage` | Per-resource persisted JSON values | `storage.get/set/delete/keys` |
| `players` | Who is connected | `players.list/name/exists`, `playerJoining`, `playerDropped` |
| `permissions` | Host privileges for a player | `permissions.has` |
| `commands` | Console and chat commands | `RegisterCommand` |
| `config` | Per-resource configuration from the host | `config.get` |
| `ui` | Notifications to players | `ui.notify` |
| `http` | Outbound HTTP, where the host allows it | `http.request` |
| `licensing` | License checks against SCRIPT//GO | `licensing.verify` |

Some members need no capability: `json`, `time`, `runtime`, `resource`, `exports` and
`capabilities` are always present.

## Required and optional

```lua
capabilities { "events", "storage" }
optional_capabilities { "ui", "players" }
```

- **Required** (`capabilities`): the resource cannot work without them. If the host lacks one,
  the resource **does not start**, and the host reports `capability_unavailable:<cap>@<env>`,
  for example `capability_unavailable:http@luanti`.
- **Optional** (`optional_capabilities`): the resource uses them when present and has a fallback
  otherwise. The resource starts either way, so your code must check before calling.

Declare as few required capabilities as you can. Each one you add removes environments where your
resource can run.

## Checking at runtime

```lua
-- Returns true or false. Never raises.
if ScriptGo.capabilities.has("ui") then
  ScriptGo.ui.notify(-1, { type = "info", title = "Shop", message = "Prices updated" })
end

-- Returns the list of capabilities this host provides.
for _, cap in ipairs(ScriptGo.capabilities.list()) do
  ScriptGo.log.debug("host provides " .. cap)
end

-- Raises capability_unavailable:<cap>@<env> when missing.
ScriptGo.capabilities.require("storage")
```

Calling a member of a capability the host does not provide raises the same
`capability_unavailable` error. Nothing fails silently.

> [!NOTE]
> Which capabilities each environment provides, and whether support is full, partial or a
> fallback, is published by the registry at `GET /v1/environments` and shown on the
> [Environments](/environments) pages. That matrix is generated from the SDK; do not hard-code it.

## Fallback patterns

Wrap optional capabilities once, at the edge of your resource, so the core never branches on the
host.

```lua
-- server/notify.lua
local function notify(target, title, message)
  if ScriptGo.capabilities.has("ui") then
    ScriptGo.ui.notify(target, { type = "info", title = title, message = message })
  else
    ScriptGo.log.info(("[%s] %s"):format(title, message))
  end
end

return notify
```

Some hosts implement a capability as a **fallback** themselves: in standalone mode, for example,
`ui` may print to the log. The Environments pages mark these as *Fallback* so you know what your
users will see.

## Capability by capability

### events

```lua
AddEventHandler("inventory_pro:itemAdded", function(owner, item, total)
  ScriptGo.log.info(owner .. " has " .. total .. " x " .. item)
end)
TriggerEvent("inventory_pro:itemAdded", "alder", "sword", 1)

-- Network events: only registered names are received.
RegisterNetEvent("inventory_pro:request", function(item)
  local player = source            -- the sending player id, server side
  TriggerClientEvent("inventory_pro:result", player, item, true)
end)
```

`ScriptGo.events.on/off/emit` and `ScriptGo.net.emitServer/emitClient` are aliases of these
globals. Event arguments are copied through the value codec.

### logging

```lua
ScriptGo.log.warn("stack limit reached for " .. item)
```

Always available. `print(...)` also reaches the host log, prefixed with the resource name.

### storage

```lua
ScriptGo.storage.set("inventory/alder", { sword = 2 })
local inv = ScriptGo.storage.get("inventory/alder")   -- nil when absent
for _, key in ipairs(ScriptGo.storage.keys("inventory/")) do
  ScriptGo.log.debug(key)
end
ScriptGo.storage.delete("inventory/alder")
```

Storage is per resource and holds JSON values. The host decides where it lives (a file, mod
storage, a database).

### players

```lua
AddEventHandler("playerJoining", function(playerId)
  ScriptGo.log.info(ScriptGo.players.name(playerId) .. " joined")
end)
for _, id in ipairs(ScriptGo.players.list()) do
  -- ...
end
```

### permissions

```lua
if not ScriptGo.permissions.has(source, "inventory.give") then
  return
end
```

Privileges come from the host: Luanti privileges, OPEN//77 operators, or the standalone config.

### commands

```lua
RegisterCommand("give", function(src, args, raw)
  -- src is 0 when the command comes from the console
end, true)  -- restricted
```

### config

```lua
local maxStack = ScriptGo.config.get("maxStack", 64)
```

### ui

```lua
ScriptGo.ui.notify(playerId, { type = "success", title = "Inventory", message = "Saved", durationMs = 3000 })
```

`target` is a player id or `-1` for everyone. On the client side you may pass `nil`.

> [!CAPABILITY] ui
> Optional in most resources. Pair it with a log fallback as shown above.

### http

```lua
if ScriptGo.capabilities.has("http") then
  ScriptGo.http.request({ url = "https://example.org/prices.json", method = "GET" }, function(res)
    -- handle the response
  end)
end
```

Only hosts that allow outbound HTTP provide `http`. The exact `opts` and callback fields are not
frozen in `scriptgo_version` 0.1; check [Runtime](/docs/runtime) before relying on them.

### licensing

Server side only. Calls `POST /v1/licenses/verify`. See [Licensing API](/docs/licensing-api).

## Extension capabilities

The manifest parser also accepts capability names starting with `x-` (for example `x-physics`)
for host-specific features. Hosts that do not know them treat them as missing. Use them sparingly:
a resource that requires an `x-` capability runs only where that host provides it.
