# Player perks

A server operator sells a **perk** (a monthly VIP, a one-time rank) to the **players** of their own
servers, from their own store. The payment provider tells SCRIPT//GO by webhook; the game server
learns it from SCRIPT//GO; the operator's own script applies the perk (ADR-0038).

- What is sold is a feature of the operator's own script, on the operator's own server.
- The operator's own store (Tebex) takes the payment. SCRIPT//GO never holds the money.
- The game server never talks to the payment provider: it asks SCRIPT//GO.
- SCRIPT//GO does not review offers before sale and acts on reports (ADR-0037).

This page starts with the flow in plain words, then gives the contract: the data, the HTTP protocol
a game server speaks, the purchase link, the script API, and what an adapter author has to supply.
Everything here runs against the mock provider in the tests; no live Tebex store has been used.

## How it works, in short

Once, on the site:

1. Connect your Tebex store and paste its webhook address in Tebex. One address per store covers
   every sale of that store. See "Open a shop" on the Selling page (`docs/site/selling.md`).
2. Create the perk (Dashboard → Perks) and give it the id of its Tebex package.
3. Link your server (Dashboard → Perks → Servers) and put its `sg_srv_` token in the server's
   settings.

Then, for each sale:

1. The player opens the link your script gave them and pays on your Tebex store.
2. Tebex tells SCRIPT//GO. SCRIPT//GO checks the payment (amount, currency, package) and records the
   perk for that player.
3. Your server asks SCRIPT//GO for news every 30 seconds and hears about it.
4. Your script's `granted` handler runs, and it gives the reward.

So a reward can arrive up to 30 seconds after the payment. The server never hears from Tebex,
receives nothing pushed and opens no port: it only needs outgoing HTTPS to the SCRIPT//GO API host,
which the operator allows.

A monthly perk renews with the subscription. A cancelled one stays until the paid month ends, then
goes. A refund or a lost chargeback removes it at once.

## Parties and data

| Thing | What it is |
|---|---|
| Operator | A SCRIPT//GO account with a creator profile and a connected store. The seller. |
| Perk | An offer of an operator: `key` (what the script asks for, unique per operator, `^[a-z0-9][a-z0-9_.-]{0,63}$`), `name`, `interval` (`month` or `perpetual`), price, the store product it maps to (`providerProductId`), and the seller's declaration. |
| Server link | A game server linked to the operator's **account** (not to a purchased license, as a deployment is). It has a token `sg_srv_…`: shown once, stored as a SHA-256 hash, revocable, not reversible. |
| Player perk | One player's perk: operator, perk, **player identifier**, state, period end, payment references. |
| Event queue | Per server link: what changed for the operator's players. Pulled and acknowledged by the server; never pushed. |

### The player identifier

A player is the string the host's `ScriptGo.players.identifier(player)` gives: 1 to 128 printable
ASCII characters, no spaces. SCRIPT//GO treats it as opaque and never interprets it. It is **only as
trustworthy as the platform's own authentication of players**: a platform that lets a player choose
their identifier lets them claim somebody's perk.

| Environment | Identifier |
|---|---|
| Lua Standalone | `local:<name>` of the simulated local players: for tests and tooling |
| OPEN//77 | `Open77.players.identifier(id)`, the player's durable authenticated identifier (the account the OPEN//77 master verified). A masterless `devLocalAuth` server gives its players none: they have no perk and cannot be sold one |
| Rust (Oxide/Carbon) | `steam:<steamid64>` |
| .NET kit | What the integrator's `IHostPlayers.Identifier(id)` returns (the console host: `local:<name>`) |

### Selling rules

A perk offer follows the rules of every offer (ADR-0037), through the same gate
(`offerCheckoutState`), with no rule of its own:

- it stands on the **seller's declaration**, made on the perk ("this is a feature of my own script,
  and I have the right to sell it"; "my script runs on a third-party game platform"). Declared, it
  can be bought at once; not declared, it is `undeclared` and waits for the seller, and for nobody
  else;
- no environment is asked for, and none conditions the sale;
- the operator's store needs no staff approval;
- after a report, staff can put a perk `on_hold` or withdraw it, or suspend the store: there is then
  no purchase path, the operator is notified and can appeal. Players who already hold the perk keep
  it, as a hold leaves existing licenses alone.

## The flow

The provider's webhook goes through the code that issues licenses: the same signature check, the same
deduplication by provider event id, the same money check (amount, currency, product), the same
handling of events that arrive out of order, and the same state rules. A player's perk carries the
states of a license.

| Provider event | Effect on the player's perk | Event queued for the operator's servers |
|---|---|---|
| Payment completed | Granted: `active`. Monthly: period end = paid-through date, else one month | `granted` (`purchase`) |
| Subscription renewed | Period extended | `updated` (`renewed`) |
| Subscription cancelled | `cancelled_active`: kept until the period end, then `expired` | none at the cancellation (nothing changes for the server); `removed` (`expired`) at the period end |
| Payment failed, or a period that ends with no renewal event | `grace` for `LICENSE_PAYMENT_GRACE_DAYS` (7), then `expired` | `updated` (`payment_failed` / `payment_grace`), then `removed` (`expired`) |
| Refund | `refunded`: removed at once | `removed` (`refunded`) |
| Dispute lost (chargeback) | `revoked`: removed at once | `removed` (`chargeback`) |
| Dispute won or closed | Restored if the dispute had revoked it | `granted` (`dispute_won` / `dispute_closed`) |

A perk a player bought holds on **every** linked server of that operator.

## The protocol a game server speaks

Base URL: the API (`scriptgo_api`). Every request carries the server link token:

```
Authorization: Bearer sg_srv_…
```

- An unknown, malformed or revoked token is one answer: `401 unknown_server_link`. **A server that
  is not linked gets nothing.**
- Every answer is cut down to the link's operator. No route takes an operator or a server as a
  parameter, so no operator can ask about another operator's players.
- Limits: per address (each route) and per token (600 requests a minute; 60 purchase links a
  minute). Past them: `429 rate_limited`.
- Errors are `{ "error": { "code", "message" } }`. `4xx` other than 408 and 429 is a refusal;
  network failures, `5xx`, 408 and 429 mean "the API could not answer": nothing is decided by them.
- Answers carry `cache-control: no-store`. Timestamps are ISO-8601 UTC.

### Check: does this player have this perk

The source of truth. Ask it when a player joins.

```
POST /v1/perks/check
{ "player": "steam:76561198000000001", "environment": "rust", "adapterVersion": "rust-0.1.0" }
```

```json
{
  "player": "steam:76561198000000001",
  "perks": [
    { "key": "vip", "status": "active", "expiresAt": "2026-12-10T12:00:00.000Z", "offlineGraceUntil": "2026-11-13T12:00:00.000Z" }
  ],
  "serverTime": "2026-11-10T12:00:00.000Z"
}
```

- `perks` lists every perk of the operator the player holds **now**. A key that is absent is not
  held. `environment` and `adapterVersion` are optional and only shown to the operator.
- `expiresAt`: the end of what is paid for (the end of the payment grace when in `grace`); `null`
  means no end. **Never trust the perk after it without asking again.**
- `offlineGraceUntil`: how long a server that cannot reach the API may keep this answer
  (`LICENSE_OFFLINE_GRACE_HOURS`, 72), never later than `expiresAt`.
- `status`: `active`, `grace` or `cancelled_active`.

### Events since X, with acknowledgement

```
GET /v1/perks/events?after=41&limit=100
```

```json
{
  "events": [
    { "seq": 42, "kind": "granted", "perk": "vip", "player": "steam:76561198000000001", "reason": "purchase",
      "status": "active", "expiresAt": "2026-12-10T12:00:00.000Z", "offlineGraceUntil": "2026-11-13T12:00:05.000Z",
      "at": "2026-11-10T12:00:00.000Z" }
  ],
  "cursor": 42,
  "more": false,
  "serverTime": "2026-11-10T12:00:05.000Z"
}
```

- Pull only: SCRIPT//GO never calls a game server.
- `seq` increases; events come oldest first. `after` is a sequence number. **Without `after`** the
  events after the last acknowledged one are returned: that is where a server starts.
- `kind`: `granted` (the player now has the perk), `updated` (still has it, the end moved),
  `removed` (no longer has it). `reason` is one of the words of the table above.
- An event states the whole fact, so applying one twice changes nothing; a consumer applies an
  event once by keeping its cursor (`seq` at or below the cursor: skip).
- `limit` 1 to 200 (default 100); `more: true` means ask again at once.
- A link gets the events queued while it existed. A new link starts empty and learns the present
  from `check`. An acknowledged event is kept 30 days, one never acknowledged 120
  (`PERK_EVENT_RETENTION_DAYS`).

```
POST /v1/perks/events/ack
{ "upTo": 42 }
```

```json
{ "acked": 42 }
```

Idempotent and monotonic: a lower or repeated value changes nothing; a value above the link's newest
event is cut back to it.

### Catalog

```
GET /v1/perks/catalog
```

```json
[ { "key": "vip", "name": "VIP", "description": "", "interval": "month", "price": { "amount": 500, "currency": "EUR" }, "purchasable": true } ]
```

### Purchase link

```
POST /v1/perks/purchase-link
{ "player": "steam:76561198000000001", "perk": "vip" }
```

```json
{ "url": "https://<site>/perk/<signed token>", "expiresAt": "2026-11-10T12:15:00.000Z" }
```

`201`. Refusals: `404 unknown_perk`, `409 not_purchasable` (the message is the reason shown next to a
disabled offer), `409 already_held`.

The link is signed by the API: a compact JWS (EdDSA) whose payload binds the operator, the perk, the
**player identifier** and the server link, with an expiry (`PERK_PURCHASE_LINK_TTL_SECONDS`, 900).
The buyer is tied to their identifier without typing a name, and a link cannot be turned into one for
another player. The signing key is its own ed25519 key, derived from the server secret for this one
purpose; a token signed with the license-token key or the release key is refused. A link stops
working when it expires or when the server link that asked for it is revoked. The whole link is about
530 characters long.

## What the player sees

The link opens a page of the site that names the perk, the price, the seller and the player
identifier, and a button to the seller's store. No account is needed.

| Route | Purpose |
|---|---|
| `GET /v1/perks/purchase?token=…` | What the link is for, and whether it can be bought now. `404 invalid_link`, `410 link_expired` |
| `POST /v1/perks/purchase/checkout` `{ "token" }` | Starts the checkout through the provider interface, in the operator's store: `{ checkoutId, redirectUrl }`. `409 checkout_disabled` with the reason |
| `GET /v1/perks/checkouts/:id` | The state of that checkout, for the page the store sends the player back to. The id is random and is the only way in |

Returning from the store grants nothing: only the provider's signed webhook does.

## The script API

`ScriptGo.perks`, capability `perks`, server side. A `player` is the host's player id, or an
identifier string.

```lua
-- When a player joins: the answer comes from SCRIPT//GO.
AddEventHandler("onPlayerConnected", function(player)
    local has, info = ScriptGo.perks.has(player, "vip")
    if has then --[[ apply it; info.expiresAt is a Unix time or nil ]] end
end)

-- A purchase, a refund, a chargeback, the end of a period.
ScriptGo.perks.on("granted", function(player, key, info) end)
ScriptGo.perks.on("removed", function(player, key, info) end)

local url, expiresAt = ScriptGo.perks.purchaseLink(player, "vip")
```

A `player` that is a string is read as an identifier. On OPEN//77, `onPlayerConnected` gives the
player id as a string: pass `tonumber(player)`, or use `playerJoining`, whose `source` is a number.

| Call | Answer |
|---|---|
| `has(player, key)` | `true, { expiresAt, status, source }` (`source` is `"api"` or `"cache"`), or `false, reason`: `not_held`, `not_linked`, `unreachable` (nothing cached and no API), `unknown_player`, `invalid_player`, `invalid_perk`. Waits for the API: call it from a thread |
| `list(player)` | `{ { key, expiresAt, status }, … }` sorted by key, or `nil, reason` |
| `refresh(player)` | Asks the API again, whatever is cached |
| `purchaseLink(player, key)` | `url, expiresAt`, or `nil, code, message` (`unknown_perk`, `not_purchasable`, `already_held`, `not_linked`, `unreachable`) |
| `catalog()` | The operator's perks, or `nil, reason` |
| `on(kind, fn)` | `kind` is `"granted"` or `"removed"`. `fn(player, key, info)`: `player` is the connected player with that identifier, or `nil`; `info` is `{ identifier, perk, reason, expiresAt }`. Returns an id for `off(id)` |
| `status()` | `{ linked, configured, cursor, lastPollAt, lastError }` |

Host settings: `scriptgo_api`, `scriptgo_server_token` (the `sg_srv_` token), and optionally
`scriptgo_perks_poll_seconds` (how often the event queue is pulled; 30).

### The cache, and its two bounds

What the API said about a player is kept in memory, and in the host's storage where there is one,
so that neither a restart nor a short API outage strips players of their perks. Two bounds, never
passed:

1. a perk is not trusted after its **period end** (`expiresAt`);
2. nor after the **offline grace** of the answer that brought it (`offlineGraceUntil`, never later
   than the period end).

At a bound the API is asked again. If it answers, its answer stands (a renewed perk is kept, with no
handler called). If it cannot be reached, the perk is removed and the `removed` handler runs with
the reason `unverified`. A server whose token is unknown or revoked keeps nothing: the cache is
dropped and the handlers run with the reason `not_linked`.

An answer about a player is reused for 10 minutes; in between, the event queue keeps it current. The
first answer about a player calls no handler (the caller is being told); later differences do. An
event about a player nobody asked about yet calls the handler and caches nothing: the next question
goes to the API.

Where the cache is kept: the adapter's storage under the key `scriptgo.perks` (standalone: a JSON
file; Rust: the plugin's data files; OPEN//77: the resource's kvp, while it fits in 64 KiB); the
.NET kit keeps it in memory only. The link token is never written to it.

## Several resources on one server

On OPEN//77 the SDK is packed into each resource, so **each resource that uses `ScriptGo.perks`
pulls the event queue on its own**, every 30 seconds, from its first use. Each keeps its own cursor,
so no resource takes another's events. That is harmless: a few small requests every 30 seconds per
resource. (A host built on the portable core has one perks client for the whole host.)

To pull once instead, make **one** resource that uses `ScriptGo.perks` and passes the news on to
your other resources with the host's own events. Scripts you bought from other creators still pull
on their own; leave them be.

On OPEN//77, `TriggerEvent` on the server reaches every running resource that handles the name,
arguments copied by value. The relay, with `capabilities { "perks", "players" }` in its manifest:

```lua
-- perks_relay/server/main.lua: the one resource that talks to SCRIPT//GO.
-- player is the connected player's id, or nil when they are not on this server.
ScriptGo.perks.on("granted", function(player, key, info)
    TriggerEvent("myserver:perkGranted", player, key, info)
end)
ScriptGo.perks.on("removed", function(player, key, info)
    TriggerEvent("myserver:perkRemoved", player, key, info)
end)

-- Tell the others what a player already holds. list() waits for the API: run it in a thread.
local function announce(player)
    CreateThread(function()
        for _, p in ipairs(ScriptGo.perks.list(player) or {}) do
            TriggerEvent("myserver:perkGranted", player, p.key, { expiresAt = p.expiresAt, reason = "held" })
        end
    end)
end

AddEventHandler("playerJoining", function()
    announce(source)   -- source is the joining player's id, a number
end)

-- A resource that starts after the players joined hears it too.
AddEventHandler("onResourceStart", function()
    for _, player in ipairs(ScriptGo.players.list()) do announce(player) end
end)
```

Any other resource of yours, with no SCRIPT//GO capability at all:

```lua
AddEventHandler("myserver:perkGranted", function(player, key, info)
    if player and key == "vip" then --[[ give the VIP garage slot ]] end
end)
AddEventHandler("myserver:perkRemoved", function(player, key, info)
    if player and key == "vip" then --[[ take it back ]] end
end)
```

A receiver can hear the same grant twice (a join, then a resource start): giving the reward twice
must change nothing. Listen with `AddEventHandler`, not `RegisterNetEvent`: a game client can then
not send these events. Any server resource can, so keep the names to your own resources.

## For an adapter author

`ScriptGo.perks` is implemented **once**, in the portable core: `sdk/lua/scriptgo/perks.lua`. It
uses no `os`, `io`, `debug`, `package`, `require` or `setmetatable`, so it runs in a sandbox. An
adapter does not reimplement the protocol; it hands the module what the host already has:

```lua
local perks = PerksModule.new({
    request = function(req, done) end,   -- async HTTP: req = { method, url, headers, body }; done({ status, body })
    await = function(register) end,      -- suspend the calling thread until the callback given to register() runs
    identifier = function(player) end,   -- the platform's identifier of a connected player, or nil
    findPlayer = function(id) end,       -- optional: the connected player with that identifier
    now = function() end,                -- wall clock, Unix seconds
    json = { encode = …, decode = … },
    config = function(key) end,          -- "scriptgo_api", "scriptgo_server_token", "scriptgo_perks_poll_seconds"
    dispatch = function(fn, ...) end,    -- run a handler, in its own thread where the host has threads
    log = function(level, message) end,  -- optional
    storage = { load = …, save = … },    -- optional: load() -> table or nil, save(table)
    environment = "…", adapterVersion = "…",
})
-- then call perks.tick() about once a second: it pulls the event queue and never blocks.
```

- A host built on the portable core (`scriptgo.newHost`) has all of this already: its adapter only
  switches the capability on (`capabilities.perks = true`, with `http` and a player identifier). One
  perks client serves the whole host, whatever the number of resources.
- A host that maps `ScriptGo` onto its own natives includes the module and wires it, as the OPEN//77
  shim does (`sdk/adapters/open77/shim_server.lua`, section `perks`). There each packed resource has
  its own client and pulls the queue on its own; clients keep their own cursor, so they do not take
  events from one another.
- Declare the capability in `sdk/lua/scriptgo/capabilities.lua` for the environment: `supported`,
  `partial`, or `unavailable` with the reason.
- The conformance tests are `sdk/lua/spec/perks_spec.lua` (the module with fake services, then
  through a host), on Lua 5.4, 5.1 and LuaJIT.

### Environments

| Environment | `perks` | Why |
|---|---|---|
| Lua Standalone | partial | The core over curl; players are simulated (`local:<name>`): tests and tooling |
| OPEN//77 | partial | The shim, server side, over `Open77.http.request` (the operator allows the API host); one client per packed resource. Run on a real dedicated server (`tools/perks-e2e.mjs --host open77`), without an authenticated player |
| Rust (Oxide/Carbon) | supported | The core over the plugin's web requests; `steam:<steamid64>`. Unit-tested in the bridge; not run on a real server with a connected player |
| .NET kit | partial | Lua guests only; JavaScript and TypeScript guests get `capability_unavailable:perks@dotnet` |
| LÖVE, Neovim | unavailable | One local player, or no player: nobody to sell to |
| Godot | unavailable | No HTTP in the adapter |
| CC: Tweaked | unavailable | Not implemented, for the reason its licensing is not |
| Luanti, Garry's Mod, Hytale, BeamMP | unavailable | The core would run there (HTTP and an identifier exist) but the adapter has not been switched on or run with it |
| FiveM | unavailable | The shim does not carry the module |
| OpenResty, Defold, Roblox, RedM, KCD:MP, Project Zomboid, Don't Starve Together | unavailable | No adapter yet |

## The operator's side

Signed in, on the site (Dashboard → Perks) or over the API:

| Route | Purpose |
|---|---|
| `GET /v1/creator/perks`, `POST /v1/creator/perks` | List and create perk offers |
| `POST /v1/creator/perks/:id/declare` | Declare rights for a perk |
| `DELETE /v1/creator/perks/:id` | Stop selling it; holders keep it |
| `GET /v1/creator/perk-holders[?perk=key]` | Who holds or held the operator's perks |
| `GET /v1/creator/server-links`, `POST /v1/creator/server-links` | List server links; create one (the token is returned once) |
| `POST /v1/creator/server-links/:id/revoke` | Revoke a link: its token stops at once, its queue is dropped |

Staff, after a report: `GET /v1/admin/perks[?operator=]`, `POST /v1/admin/perks/:id/decision`
(`on_hold`, `rejected`, `lift`).

## Limits

- Never run against a live Tebex store; the Tebex connector is behind the provider interface and
  checkout through it stays off until Tebex approves in writing.
- A perk is as secure as the platform's player identifier and as the server that asks: an operator
  controls their own server and their own script.
- The purchase link is long (about 530 characters); a chat line may not hold it.
- On OPEN//77 the player identifier exists only for players the master authenticated; it was not
  exercised with such a player (the runs are masterless).
- There is no gift (buying for another player) and no operator-granted free perk yet.
