# InventoryKit

Server-authoritative player inventories: slots, a weight limit, stacking, unique items, moves,
use events and persistence. Clients get a mirror of their own inventory and send requests; the
server validates every one of them.

- **Slots and weight**: 24 slots and 30 weight units by default, both configurable.
- **Stacking** up to each item's `stack`; items given a `meta` table are unique and never stack.
- **Use events**: `usable` items fire `sg_inventory:used`; `consume` items lose one per use.
- **Persistence** per player identifier, so an inventory survives reconnects and restarts.
- **Rate limits** on client requests (10 per second per player).

## Install

```bash
scriptgo add scriptgo//inventory-kit
```

```lua
-- scriptgo.lua of your resource
dependency "sg_inventory >=1.0.0"
```

## Example

A starter kit for every player who joins. This block is the README example that `scriptgo verify`
runs next to the package in every environment; hosts with a (simulated) player show the whole
exchange, hosts without one show only the item definition.

```lua runnable
local inv = exports.sg_inventory

-- Items come from the config ("items") or are added at runtime, like this one. Exports are called
-- from a thread or a handler, never at file scope (resource_preparing).
CreateThread(function()
    print(inv:defineItem({ name = "medkit", label = "Medkit", weight = 1.0, stack = 3, usable = true, consume = true }))
end)

AddEventHandler("sg_inventory:used", function(playerId, item)
    print(("player %d used a %s"):format(playerId, item))
end)

AddEventHandler("playerJoining", function()
    local playerId = source
    print(inv:add(playerId, "medkit", 2))  -- true
    print(inv:add(playerId, "medkit", 50)) -- false  too_heavy
    print(("player %d has %d medkits"):format(playerId, inv:count(playerId, "medkit")))
    for _, it in ipairs(inv:getInventory(playerId).items) do
        if it.name == "medkit" then print(inv:use(playerId, it.slot)) break end
    end
end)
```

## Server API

Call these through `exports.sg_inventory:<name>(...)`.

| Export | Returns |
|---|---|
| `defineItem(def)` | `true`, or `false, reason` |
| `items()` | every item definition, sorted by name |
| `getInventory(playerId)` | `{ slots, maxWeight, weight, items = { { slot, name, label, count, meta, weight, usable } } }` |
| `count(playerId, name)` | how many the player holds (0 for an unknown player) |
| `add(playerId, name, count?, meta?)` | `true`, or `false, reason` |
| `remove(playerId, name, count?)` | `true`, or `false, reason` |
| `move(playerId, from, to, count?)` | `true`, or `false, reason` |
| `use(playerId, slot)` | `true`, or `false, reason` |
| `clear(playerId)` | `true`, or `false, reason` |

An item definition: `{ name, label?, weight?, stack?, usable?, consume?, category?, description? }`.
`name` matches `^[a-z0-9_]+$`, up to 48 characters.

Reasons: `unknown_player`, `unknown_item`, `invalid_count`, `too_heavy`, `no_space`,
`not_enough`, `empty_slot`, `not_usable`, `invalid_slot`, `stack_full`, `slot_occupied`, and for
`defineItem` `invalid_item`, `invalid_item_name`, `invalid_label`, `invalid_weight`,
`invalid_stack`.

### Events

| Event (server bus) | Arguments |
|---|---|
| `sg_inventory:changed` | `playerId, { item, delta, reason? }` (or `{ cleared = true }`) |
| `sg_inventory:used` | `playerId, name, slot, meta` |

### Command

`giveitem <playerId> <item> [count]`, for players holding the privilege `inventory.give`
(through PermissionsKit when it runs, otherwise the host's own privileges). The console always may.

## Client API

| Export | Does |
|---|---|
| `getState()` | the last snapshot the server sent |
| `count(name)` | count in that snapshot |
| `move(from, to, count?)`, `use(slot)`, `refresh()` | requests to the server |
| `lastRefusal()` | the last refused request and its reason |

Client events: `sg_inventory:updated(state)`, `sg_inventory:itemUsed(name)`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `slots` | `24` | slots per player |
| `maxWeight` | `30` | weight limit |
| `items` | water, bread, bandage, rope, scrap, coin, toolbox | the item list |

## License

MIT.
