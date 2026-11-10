# VIP perks

An example of the script a server operator writes to apply a perk they sell to their players
(player perks, `docs/spec/perks.md`).

What is sold is a feature of this script, on the operator's own server. The operator's own store
takes the payment; SCRIPT//GO never holds the money. SCRIPT//GO does not review offers before sale
and acts on reports. The game server never talks to the payment provider: it asks SCRIPT//GO.

## What the operator does once

1. In the SCRIPT//GO dashboard, **Perks**: create a perk with the key `vip` (name, price, monthly or
   one-time, the product of their store it maps to) and declare their rights.
2. **Perks → Servers**: link the game server. The token (`sg_srv_...`) is shown once.
3. On the game server, set two host settings: `scriptgo_api` (the SCRIPT//GO API) and
   `scriptgo_server_token` (that token). Where a setting lives depends on the host: `convars` in the
   standalone host's config file, a convar in `server.jsonc` on OPEN//77, the plugin's config on
   Rust (Oxide/Carbon).

## What the script does

```lua
-- When a player joins: the answer comes from SCRIPT//GO, the source of truth.
AddEventHandler("onPlayerConnected", function(player)
    if ScriptGo.perks.has(player, "vip") then
        -- apply the perk
    end
end)

-- While the server runs: a purchase, a refund, the end of a period.
ScriptGo.perks.on("granted", function(player, key, info) end)
ScriptGo.perks.on("removed", function(player, key, info) end)

-- A link to buy it, tied to the player's identifier (no name to type).
local url = ScriptGo.perks.purchaseLink(player, "vip")
```

`player` is the host's player id; the perk is held by the player's identifier
(`ScriptGo.players.identifier(player)`), which is only as trustworthy as the platform's own
authentication of players.

## If the API cannot be reached

The host keeps what it was told, for the offline grace the API gave with its answer and never past
the end of what the player paid for. After that the perk is removed and the `removed` handler runs.
A server that is not linked gets nothing.

## Settings of this example

| Setting | Meaning |
|---|---|
| `watch` | A list of player identifiers. The script logs, twice a second, what it would answer for each (`SGPERK state ...`). For demonstrations and the end-to-end run (`node tools/perks-e2e.mjs`). |
| `print_links` | With `watch`: ask for a purchase link whenever a watched player does not have the perk, and log it. |

## Tests

```
node packages/cli/bin/scriptgo.mjs test examples/packages/vip_perks
```
