-- Run with: scriptgo test sdk/packages/sg_eventbus
-- A consumer resource, kept in memory, owns and listens to the topics.
local consumer = {
    ["consumer/scriptgo.lua"] = [[
resource "consumer"
version "1.0.0"
scriptgo_version ">=0.1.0"
dependency "sg_eventbus"
server_script "server.lua"
client_script "client.lua"
]],
    ["consumer/server.lua"] = [[
received = {}
CreateThread(function()
    local p = Open77.exports.call("sg_eventbus", "defineTopic", "shop:sale", {
        retain = true, public = true, clientPublish = true, ratePerSecond = 2,
        schema = { type = "table", additional = false, fields = {
            item = { type = "string", maxLength = 32 },
            price = { type = "number", min = 0, integer = true },
        } },
    })
    defined = p:await()
end)
AddEventHandler("sgbus:shop:sale", function(payload, meta)
    received[#received + 1] = payload.item .. "@" .. payload.price .. "#" .. meta.seq .. ":" .. tostring(meta.player or meta.publisher)
end)
exports("received", function() return table.concat(received, ","), defined end)
exports("publish", function(p) return exports.sg_eventbus:publish("shop:sale", p) end)
]],
    ["consumer/client.lua"] = [[
seen = {}
RegisterNetEvent("sgbus:shop:sale", function(payload) seen[#seen + 1] = payload.item end)
exports("seen", function() return table.concat(seen, ",") end)
exports("buy", function(p) return exports.sg_eventbus:publish("shop:sale", p) end)
]],
}

local function setup()
    local h = load({ files = consumer, with = { "consumer" } })
    h:tick(10)
    return h
end

describe("sg_eventbus", function()
    test("a defined topic delivers validated payloads to server and clients", function()
        local h = setup()
        local _, defined = h:call("consumer", "received")
        expect(defined).toBe(true)
        local ok, seq = h:call("consumer", "publish", { item = "lamp", price = 12 })
        expect(ok).toBe(true)
        expect(seq).toBe(1)
        h:tick(20)
        expect((h:call("consumer", "received"))).toBe("lamp@12#1:consumer")
        expect(h:callClient("consumer", "seen")).toBe("lamp")
        local last, meta = h:call("sg_eventbus", "last", "shop:sale")
        expect(last).toEqual({ item = "lamp", price = 12 })
        expect(meta.seq).toBe(1)
    end)

    test("payloads that break the schema are refused with a path", function()
        local h = setup()
        local ok, why = h:call("consumer", "publish", { item = "lamp", price = -1 })
        expect(ok).toBe(false)
        expect(why).toBe("invalid_payload: payload.price: below 0")
        local ok2, why2 = h:call("consumer", "publish", { item = "lamp", price = 1, extra = true })
        expect(ok2).toBe(false)
        expect(why2).toContain("payload.extra: not allowed")
    end)

    test("clients publish through the server under a per-player rate limit", function()
        local h = setup()
        h:join(1, "Ada")
        for i = 1, 3 do h:callClient("consumer", "buy", { item = "c" .. i, price = i }) end
        h:tick(20)
        -- Two tokens per second: the third publication is refused and reported to the client.
        expect((h:call("consumer", "received"))).toBe("c1@1#1:1,c2@2#2:1")
        local rejections = h:callClient("sg_eventbus", "rejections")
        expect(rejections[1].reason).toBe("rate_limited")
        h:tick(1000)
        h:callClient("consumer", "buy", { item = "c4", price = 4 })
        h:tick(20)
        expect((h:call("consumer", "received"))).toBe("c1@1#1:1,c2@2#2:1,c4@4#3:1")
    end)

    test("a topic belongs to the resource that defined it", function()
        local h = setup()
        local ok, why = h:call("sg_eventbus", "defineTopic", "shop:sale", {})
        expect(ok).toBe(false)
        expect(why).toBe("topic_owned_by:consumer")
        expect(h:call("sg_eventbus", "defineTopic", "Bad Topic", {})).toBe(false)
    end)

    test("stopping the owner removes its topics", function()
        local h = setup()
        h:stop("consumer")
        h:tick(10)
        expect(h:call("sg_eventbus", "stats").topics).toBe(0)
        local ok, why = h:call("sg_eventbus", "publish", "shop:sale", { item = "x", price = 1 })
        expect(ok).toBe(false)
        expect(why).toBe("unknown_topic")
    end)
end)
