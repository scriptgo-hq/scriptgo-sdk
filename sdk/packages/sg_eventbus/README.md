# EventBus Kit

Typed topics on top of the host event bus. A resource declares a topic once, with a schema, and
any resource can then publish to it. Payloads that break the schema are refused with the path of
the bad field, so a typo in one resource cannot corrupt the state of another.

- **Schemas** for every payload: strings, numbers, booleans, tables, arrays, with bounds, patterns
  and enums.
- **Retained values**: late subscribers read the last payload with `last(topic)`.
- **Client delivery** for topics marked `public`, and client publishing for topics marked
  `clientPublish`, validated by the server and rate limited per player.
- **Ownership**: a topic belongs to the resource that defined it and disappears when that resource
  stops.

## Install

```bash
scriptgo add scriptgo//event-bus
```

```lua
-- scriptgo.lua of your resource
dependency "sg_eventbus >=1.0.0"
```

## Example

A shop announces sales on a typed topic. This block is the README example that `scriptgo verify`
runs next to the package in every environment, so its output is in each compatibility run.

```lua runnable
local bus = exports.sg_eventbus

AddEventHandler("sgbus:shop.sale", function(sale, meta)
    print(("sale #%d from %s: %s for %d"):format(meta.seq, meta.publisher, sale.item, sale.price))
end)

-- Exports are called from a thread or a handler, never at file scope (OPEN//77 refuses that
-- with resource_preparing, and so does every SCRIPT//GO host).
CreateThread(function()
    -- Payloads on "shop.sale" must have this shape. The last sale is kept (retain).
    print(bus:defineTopic("shop.sale", {
        schema = { type = "table", fields = {
            item = { type = "string", maxLength = 32 },
            price = { type = "number", min = 0 },
        } },
        retain = true,
    }))
    print(bus:publish("shop.sale", { item = "water", price = 3 }))      -- true  1
    print(bus:publish("shop.sale", { item = "water", price = "free" })) -- false  invalid_payload: ...
    local last = bus:last("shop.sale")
    print("last sale: " .. last.item)
end)
```

## Server API

Call these through `exports.sg_eventbus:<name>(...)`.

| Export | Returns |
|---|---|
| `defineTopic(name, opts)` | `true`, or `false, reason` |
| `publish(name, payload)` | `true, seq`, or `false, reason` |
| `last(name)` | `payload, meta` of the last retained publication |
| `topics()` | list of `{ name, owner, retain, public, clientPublish, seq }` |
| `stats()` | `{ topics, published, rejected }` |

`opts` of `defineTopic`:

| Field | Default | Meaning |
|---|---|---|
| `schema` | none | shape every payload must match |
| `retain` | `false` | keep the last payload for `last()` and for clients that sync |
| `public` | `false` | also send each publication to every client |
| `clientPublish` | `false` | accept publications from clients |
| `ratePerSecond` | `20` | publications per second per publisher |

Subscribers listen with `AddEventHandler("sgbus:<topic>", function(payload, meta) ... end)`.
`meta` is `{ topic, seq, publisher, player, at }`: `publisher` is the resource that published
(`"client"` for a publication from a client), `player` the player id in that case.

Reasons a publication is refused: `unknown_topic`, `client_publish_forbidden`, `rate_limited`,
`invalid_payload: <path>: <what>`. `defineTopic` refuses with `invalid_topic_name`,
`invalid_schema` or `topic_owned_by:<resource>` (another resource defined it first). `last`
answers `nil, "unknown_topic"` or `nil, "not_retained"`.

### Schemas

| Type | Options |
|---|---|
| `string` | `maxLength`, `pattern`, `enum`, `optional` |
| `number` | `min`, `max`, `integer`, `optional` |
| `boolean` | `optional` |
| `table` | `fields`, `additional` (allow unknown fields, default `true`), `optional` |
| `array` | `items`, `maxItems`, `optional` |
| `any` | anything |

## Client API

| Export | Returns |
|---|---|
| `publish(name, payload)` | sends it to the server, which validates it (needs `clientPublish`) |
| `last(name)` | `payload, meta` of a public retained topic, after the initial sync |
| `track(name)` | keeps `last(name)` current for a public retained topic |
| `rejections()` | the last refusals the server sent back |

Clients receive public publications as the network event `sgbus:<topic>`.

## Environments

Server side everywhere the kit is verified. Client delivery needs a host with clients and
networking (OPEN//77, Luanti players, the simulated players of the standalone host). The
compatibility runs on the package page show what ran where.

## License

MIT.
