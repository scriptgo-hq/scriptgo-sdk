-- EventBus Kit, server side.
--
-- A topic is declared once (defineTopic) by the resource that owns it, then published by anyone.
-- Delivery uses the host bus: subscribers write AddEventHandler("sgbus:<topic>", fn(payload, meta)).
-- Topics marked `public` are also sent to clients ("sgbus:<topic>" network event), and topics
-- marked `clientPublish` accept publications from clients, validated and rate limited per player.
local topics = {}      -- name -> { owner, schema, retain, public, clientPublish, ratePerSecond, seq, last, lastMeta }
local buckets = {}     -- publisher key -> { tokens, at }
local counters = { published = 0, rejected = 0, delivered = 0 }

local DEFAULT_RATE = 20

local function now() return ScriptGo.time.monotonic() end

local function allow(key, ratePerSecond)
    local b = buckets[key]
    local t = now()
    if not b then
        b = { tokens = ratePerSecond, at = t }
        buckets[key] = b
    end
    b.tokens = math.min(ratePerSecond, b.tokens + (t - b.at) * ratePerSecond)
    b.at = t
    if b.tokens < 1 then return false end
    b.tokens = b.tokens - 1
    return true
end

local function publish(topicName, payload, publisher, fromPlayer)
    local topic = topics[topicName]
    if not topic then counters.rejected = counters.rejected + 1; return false, "unknown_topic" end
    if fromPlayer and not topic.clientPublish then counters.rejected = counters.rejected + 1; return false, "client_publish_forbidden" end
    local key = fromPlayer and ("player:" .. tostring(fromPlayer)) or ("resource:" .. tostring(publisher))
    if not allow(key .. "@" .. topicName, topic.ratePerSecond) then
        counters.rejected = counters.rejected + 1
        return false, "rate_limited"
    end
    local ok, err = SgSchema.validate(payload, topic.schema)
    if not ok then counters.rejected = counters.rejected + 1; return false, "invalid_payload: " .. err end
    topic.seq = topic.seq + 1
    local meta = { topic = topicName, seq = topic.seq, publisher = publisher, player = fromPlayer, at = ScriptGo.time.now() }
    if topic.retain then topic.last, topic.lastMeta = payload, meta end
    local sent, why = TriggerEvent("sgbus:" .. topicName, payload, meta)
    if not sent then return false, why end
    if topic.public then TriggerClientEvent("sgbus:" .. topicName, -1, payload, meta) end
    counters.published = counters.published + 1
    return true, topic.seq
end

-- defineTopic(name, { schema?, retain?, public?, clientPublish?, ratePerSecond? }) -> true | false, reason
exports("defineTopic", function(name, opts)
    opts = opts or {}
    if not SgSchema.isTopic(name) then return false, "invalid_topic_name" end
    if not SgSchema.isSchema(opts.schema) then return false, "invalid_schema" end
    local owner = GetInvokingResource() or GetCurrentResourceName()
    local existing = topics[name]
    if existing and existing.owner ~= owner then return false, "topic_owned_by:" .. existing.owner end
    topics[name] = {
        owner = owner, schema = opts.schema, retain = opts.retain == true, public = opts.public == true,
        clientPublish = opts.clientPublish == true, ratePerSecond = tonumber(opts.ratePerSecond) or DEFAULT_RATE,
        seq = existing and existing.seq or 0, last = existing and existing.last, lastMeta = existing and existing.lastMeta,
    }
    ScriptGo.log.debug(("topic %s defined by %s"):format(name, owner))
    return true
end)

-- publish(topic, payload) -> true, seq | false, reason
exports("publish", function(name, payload)
    return publish(name, payload, GetInvokingResource() or GetCurrentResourceName(), nil)
end)

-- last(topic) -> payload, meta (retained topics only)
exports("last", function(name)
    local t = topics[name]
    if not t then return nil, "unknown_topic" end
    if not t.retain then return nil, "not_retained" end
    return t.last, t.lastMeta
end)

exports("topics", function()
    local out = {}
    for name, t in pairs(topics) do
        out[#out + 1] = { name = name, owner = t.owner, retain = t.retain, public = t.public, clientPublish = t.clientPublish, seq = t.seq }
    end
    table.sort(out, function(a, b) return a.name < b.name end)
    return out
end)

exports("stats", function()
    local n = 0
    for _ in pairs(topics) do n = n + 1 end
    return { topics = n, published = counters.published, rejected = counters.rejected }
end)

-- Clients publish through the server, which validates and rate limits per player.
RegisterNetEvent("sg_eventbus:publish", function(name, payload)
    local player = source
    local ok, why = publish(name, payload, "client", player)
    if not ok then TriggerClientEvent("sg_eventbus:rejected", player, name, why) end
end)

-- A client asks for the retained values of public topics (on join or after a reload).
RegisterNetEvent("sg_eventbus:sync", function()
    local player = source
    local retained = {}
    for name, t in pairs(topics) do
        if t.public and t.retain and t.last ~= nil then retained[name] = { payload = t.last, meta = t.lastMeta } end
    end
    TriggerClientEvent("sg_eventbus:retained", player, retained)
end)

-- Topics owned by a stopped resource are removed with it.
AddEventHandler("onResourceStop", function(name)
    for topic, t in pairs(topics) do
        if t.owner == name then topics[topic] = nil end
    end
end)

AddEventHandler("playerDropped", function()
    local prefix = "player:" .. tostring(source) .. "@"
    for key in pairs(buckets) do
        if key:sub(1, #prefix) == prefix then buckets[key] = nil end
    end
end)
