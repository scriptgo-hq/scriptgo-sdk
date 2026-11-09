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
| `players` | Who is connected | `players.list/name/exists/identifier`, `playerJoining`, `playerDropped` |
| `permissions` | Host privileges for a player | `permissions.has` |
| `commands` | Console and chat commands | `RegisterCommand` |
| `config` | Per-resource configuration from the host | `config.get` |
| `ui` | Notifications to players | `ui.notify` |
| `http` | Outbound HTTP, where the host allows it | `http.request` |
| `licensing` | License checks against SCRIPT//GO | `licensing.activate`, `licensing.verify` |

Some members need no capability: `json`, `time`, `runtime`, `resource`, `exports` and
`capabilities` are always present.

## Required and optional

```lua
capabilities { "events", "storage" }
optional_capabilities { "ui", "players" }
```

- **Required** (`capabilities`): the resource cannot work without them. If the host lacks one,
  the resource **does not start**, and the host reports `capability_unavailable:<cap>@<env>`,
  for example `capability_unavailable:http@godot`.
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

Using a member of a capability the host does not provide raises the same
`capability_unavailable` error: the portable host raises as soon as the member is read, the
OPEN//77 shim when it is called. Nothing fails silently.

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
`ui` prints to the console, and on Luanti it becomes a chat message. The Environments pages mark
these as *Fallback* so you know what your
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

Storage is per resource and holds JSON values. The host decides where it lives (JSON files,
Luanti mod storage, OPEN//77 KVP). `storage.set` returns `true`, or `false, reason` when the value
cannot be copied.

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

Privileges come from the host: Luanti privileges, the OPEN//77 server ACL, or the standalone
config. The console (`source` 0) has every privilege.

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
CreateThread(function()
  if not ScriptGo.capabilities.has("http") then return end
  local res, err = ScriptGo.http.request({ url = "https://example.org/prices.json", method = "GET" })
  if not res then
    ScriptGo.log.warn("refused: " .. tostring(err))
  elseif res.status == 0 or res.status >= 400 then
    ScriptGo.log.warn("request failed: " .. tostring(res.error or res.status))
  else
    -- res.body
  end
end)
```

`http.request({ method, url, headers, body })` runs on the server side, inside a thread: it waits
for the answer and returns `{ status, body, headers }`. `status` is `0` when the exchange did not
complete; a request the host refuses at once returns `nil, reason`. Only the OPEN//77 shim fills
`headers`; the other hosts leave it empty or absent. Only hosts that allow outbound HTTP provide
`http`: standalone and LÖVE through curl, Luanti when the mod is in `secure.http_mods`, OPEN//77
when the operator sets `http.enabled` and lists each host in `http.allowedHosts` in
`server.jsonc`. Godot has none.

### licensing

Server side only, inside a thread, and only where `http` works. `licensing.verify` calls
`POST /v1/licenses/verify`, `licensing.activate` calls `POST /v1/licenses/activate`, on the API
named by the `scriptgo_api` convar. See [Licensing API](/docs/licensing-api).

## Extension capabilities

The manifest parser also accepts capability names starting with `x-` (for example `x-physics`)
for host-specific features. Hosts that do not know them treat them as missing. Use them sparingly:
a resource that requires an `x-` capability runs only where that host provides it.
