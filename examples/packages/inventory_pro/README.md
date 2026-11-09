# Inventory Pro

Crafting, hotbars and item rarities on top of InventoryKit (`scriptgo//inventory-kit`).
Licensed per server through SCRIPT//GO.

> [!NOTE]
> Inventory Pro is the **demonstration package** of the SCRIPT//GO acceptance journey. Its creator,
> Kestrel, is a demo account, and its offers go through the test payment provider: no real payment
> is taken.

- **Crafting**: four recipes (repair kit, lockpick, medkit, lantern) that take InventoryKit items
  and give the output back atomically; the inputs are returned when the output does not fit.
- **Hotbar**: five entries bound to inventory slots, kept per player.
- **Rarities**: common, uncommon, rare, epic, on the items it adds.
- **License gate**: the server verifies its key at start and every six hours; a valid answer is
  cached with its offline grace deadline, so a network outage does not switch a paying server off.

## Install

```bash
scriptgo add kestrel//inventory-pro
```

Give the server its license key and, if your API is not the default, the API address:

| Host | Where |
|---|---|
| Standalone | `config.json`: `resources.inventory_pro.license_key`, `convars.scriptgo_api` |
| OPEN//77 | `server.jsonc` convars `inventory_pro:license_key` and `scriptgo_api`; also `http.enabled` and the API host in `http.allowedHosts` |
| LÖVE, Godot | the host's resource config (see the adapter README) |
| Luanti | the mod in `secure.http_mods`, then the resource config |

## Example

This block is the README example that `scriptgo verify` runs next to the package in every
environment. Without a license key it shows the refusal; with one, the crafted items.

```lua runnable
local pro = exports.inventory_pro

-- License state changes are announced on the server bus.
AddEventHandler("inventory_pro:license", function(state, reason)
    print(("Inventory Pro license: %s%s"):format(state, reason and (" (" .. reason .. ")") or ""))
end)

CreateThread(function()
    for _, r in ipairs(pro:recipes()) do print(("recipe %s (%s)"):format(r.name, r.rarity)) end
end)

AddEventHandler("playerJoining", function()
    local playerId = source
    Wait(500) -- let the license check answer first
    exports.sg_inventory:add(playerId, "scrap", 2)
    local ok, out = pro:craft(playerId, "lockpick")
    print(ok and ("crafted %d x %s"):format(out.count, out.item) or ("craft refused: " .. tostring(out)))
end)
```

## Server API

Call these through `exports.inventory_pro:<name>(...)`.

| Export | Returns |
|---|---|
| `status()` | `{ state, reason, graceUntil, checkedAt }`; `state` is `checking`, `active`, `grace` or `invalid` |
| `recipes()` | `{ { name, output, inputs, rarity } }`, sorted by name |
| `craft(playerId, recipe)` | `true, { item, count }`, or `false, reason` |
| `bindHotbar(playerId, index, slot)` | `true`, or `false, reason` |
| `useHotbar(playerId, index)` | as InventoryKit's `use` |

Every premium export answers `false, "not_licensed:<reason>"` while the license is not active.

Events on the server bus: `inventory_pro:license(state, reason)`, `inventory_pro:crafted(playerId, recipe)`.

Commands: `/craft <recipe>`, `/hotbar <index> <slot>`, `/invpro` (license state).

## What the license gate is, and is not

The server owner controls the machine, so a determined owner can patch any check that runs on it.
The gate makes the paid path the easy one and gives the creator an activation record; it is not
DRM, and Inventory Pro does not pretend otherwise.

## License

Commercial: `LicenseRef-ScriptGo-Commercial`, one license per server deployment.
