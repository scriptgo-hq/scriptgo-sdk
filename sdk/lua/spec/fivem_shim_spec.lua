-- The FiveM shim (sdk/adapters/fivem/shim.lua) against a STUB of the FiveM natives
-- (sdk/adapters/fivem/test/natives_stub.lua). This checks how the shim calls each native and maps
-- its answers; it is not FiveM and is never evidence that a package runs there. Only
-- `scriptgo verify --env fivem` on a real FXServer is.
local suite, scriptgo, ctx = ...
local test, expect, describe = suite.test, scriptgo.testing.expect, suite.describe

local stub = dofile(ctx.root .. "/sdk/adapters/fivem/test/natives_stub.lua")
local shimText = assert(ctx.readFile(ctx.root .. "/sdk/adapters/fivem/shim.lua"))

local function world(opts)
    opts = opts or {}
    opts.json = scriptgo.json
    opts.resource = opts.resource or "res_a"
    local w = stub.new(opts)
    w.load(shimText)
    return w, w.env.ScriptGo
end

local function capError(fn)
    local ok, err = pcall(fn)
    return (not ok) and tostring(err) or nil
end

describe("fivem shim (stub natives)", function()
    test("builds the namespace on the server side", function()
        local w, SG = world()
        expect(SG.runtime.environment()).toBe("fivem")
        expect(SG.runtime.side()).toBe("server")
        expect(SG.runtime.adapterVersion()).toBe("fivem-shim-0.1.0")
        expect(SG.resource.name()).toBe("res_a")
        expect(w.env.Open77).toBe(SG)
    end)

    test("builds the namespace on the client side", function()
        local _, SG = world({ server = false })
        expect(SG.runtime.side()).toBe("client")
        expect(SG.capabilities.has("ui")).toBe(true)
        expect(SG.capabilities.has("players")).toBe(false)
    end)

    test("never replaces an existing ScriptGo", function()
        local w = stub.new({ json = scriptgo.json })
        local mine = {}
        w.env.ScriptGo = mine
        w.load(shimText)
        expect(w.env.ScriptGo).toBe(mine)
    end)

    test("storage round trip goes through the resource KVP as JSON text", function()
        local w, SG = world()
        expect(SG.storage.set("bag", { a = 1, list = { "x", "y" }, flag = true })).toBe(true)
        local set = w.called("SetResourceKvp")[1]
        expect(set[1]).toBe("bag")
        expect(type(set[2])).toBe("string")
        local v = SG.storage.get("bag")
        expect(v.a).toBe(1)
        expect(v.list[2]).toBe("y")
        expect(v.flag).toBe(true)
        expect(SG.storage.delete("bag")).toBe(true)
        expect(SG.storage.get("bag")).toBeNil()
        expect(w.called("DeleteResourceKvp")[1][1]).toBe("bag")
    end)

    test("storage refuses values JSON cannot hold", function()
        local _, SG = world()
        local ok, why = SG.storage.set("f", function() end)
        expect(ok).toBe(false)
        expect(why).toBe("value_not_serializable")
    end)

    test("storage keys are found by prefix, sorted, and the find handle is closed", function()
        local w, SG = world()
        SG.storage.set("inv:2", 2)
        SG.storage.set("inv:1", 1)
        SG.storage.set("other", 0)
        expect(SG.storage.keys("inv:")).toEqual({ "inv:1", "inv:2" })
        expect(SG.storage.keys()).toEqual({ "inv:1", "inv:2", "other" })
        expect(SG.storage.keys("none:")).toEqual({})
        expect(w.openFinds).toBe(0)
        expect(w.called("StartFindKvp")[2][1]).toBe("")
    end)

    test("time: GetGameTimer in seconds; os.time on the server, nil on the client", function()
        local w, SG = world({ osTime = 1800000123 })
        w.clock = 2500
        expect(SG.time.monotonic()).toBe(2.5)
        expect(SG.time.now()).toBe(1800000123)
        local _, client = world({ server = false })
        expect(client.time.now()).toBeNil()
    end)

    test("players.list turns FiveM's string ids into sorted integers", function()
        local _, SG = world({ players = { ["3"] = { name = "C" }, ["1"] = { name = "A" } } })
        expect(SG.players.list()).toEqual({ 1, 3 })
    end)

    test("players.name, exists and identifier pass the id as a string", function()
        local w, SG = world({ players = {
            ["2"] = { name = "Ada", identifiers = { "steam:110000100000000", "license:abc123" } },
            ["5"] = { name = "Bob", identifiers = { "discord:42" } },
        } })
        expect(SG.players.name(2)).toBe("Ada")
        expect(w.called("GetPlayerName")[1][1]).toBe("2")
        expect(SG.players.exists(2)).toBe(true)
        expect(SG.players.exists(4)).toBe(false)
        expect(SG.players.identifier(2)).toBe("license:abc123")
        expect(SG.players.identifier(5)).toBe("discord:42")
    end)

    test("invalid player ids answer nil/false without reaching a native", function()
        local w, SG = world({ players = { ["1"] = { name = "A" } } })
        expect(SG.players.name(0)).toBeNil()
        expect(SG.players.identifier(-3)).toBeNil()
        expect(SG.players.name(1.5)).toBeNil()
        expect(SG.players.name("1")).toBeNil()
        expect(SG.players.exists(0)).toBe(false)
        expect(#w.called("GetPlayerName")).toBe(0)
        expect(#w.called("GetPlayerIdentifierByType")).toBe(0)
    end)

    test("permissions: console allowed, players through IsPlayerAceAllowed", function()
        local w, SG = world({ aces = { ["7|inventory.give"] = true } })
        expect(SG.permissions.has(0, "anything.at.all")).toBe(true)
        expect(SG.permissions.has(7, "inventory.give")).toBe(true)
        expect(SG.permissions.has(7, "inventory.take")).toBe(false)
        expect(SG.permissions.has(-1, "inventory.give")).toBe(false)
        local call = w.called("IsPlayerAceAllowed")[1]
        expect(call[1]).toBe("7")
        expect(call[2]).toBe("inventory.give")
        expect(#w.called("IsPlayerAceAllowed")).toBe(2)
    end)

    test("config reads the convar <resource>:<key> and decodes it", function()
        local w, SG = world({ convars = {
            ["res_a:max"] = "40", ["res_a:on"] = "true", ["res_a:off"] = "false",
            ["res_a:list"] = '["a","b"]', ["res_a:name"] = "kestrel", ["res_a:bad"] = "{nope",
        } })
        expect(SG.config.get("max")).toBe(40)
        expect(SG.config.get("on")).toBe(true)
        expect(SG.config.get("off")).toBe(false)
        expect(SG.config.get("list")).toEqual({ "a", "b" })
        expect(SG.config.get("name")).toBe("kestrel")
        expect(SG.config.get("bad", "dflt")).toBe("dflt")
        expect(SG.config.get("missing", 42)).toBe(42)
        expect(w.called("GetConvar")[1][1]).toBe("res_a:max")
        expect(w.called("GetConvar")[1][2]).toBe("")
    end)

    test("ui.notify on the server sends chat:addMessage to one player or to everyone", function()
        local w, SG = world()
        expect(SG.ui.notify(3, { type = "success", title = "Shop", message = "Bought" })).toBe(true)
        expect(SG.ui.notify(-1, { message = "Restart in 5 min" })).toBe(true)
        local ok, why = SG.ui.notify(0, { message = "x" })
        expect(ok).toBe(false)
        expect(why).toBe("invalid_target")
        local calls = w.called("TriggerClientEvent")
        expect(#calls).toBe(2)
        expect(calls[1][1]).toBe("chat:addMessage")
        expect(calls[1][2]).toBe(3)
        expect(calls[1][3].args).toEqual({ "Shop", "Bought" })
        expect(calls[2][2]).toBe(-1)
        expect(calls[2][3].args).toEqual({ "info", "Restart in 5 min" })
        expect(SG.notifications.broadcast({ message = "y" })).toBe(true)
    end)

    test("ui.notify on the client triggers the local chat event", function()
        local w, SG = world({ server = false })
        expect(SG.ui.notify({ title = "Hi", message = "there" })).toBe(true)
        expect(SG.ui.notify(nil, { title = "Hi", message = "again" })).toBe(true)
        local calls = w.called("TriggerEvent")
        expect(calls[1][1]).toBe("chat:addMessage")
        expect(calls[1][2].args).toEqual({ "Hi", "there" })
        expect(calls[2][2].args).toEqual({ "Hi", "again" })
    end)

    test("http.request answers a 200 with status, body and headers, without following redirects", function()
        local w, SG = world({ http = function() return 200, '{"ok":true}', { ["content-type"] = "application/json" }, nil end })
        local r = w.run(function()
            return SG.http.request({ method = "POST", url = "http://127.0.0.1:9/v1/x", body = "{}", headers = { a = "b" } })
        end)
        expect(r.status).toBe(200)
        expect(r.body).toBe('{"ok":true}')
        expect(r.headers["content-type"]).toBe("application/json")
        expect(r.error).toBeNil()
        local call = w.called("PerformHttpRequest")[1]
        expect(call[1]).toBe("http://127.0.0.1:9/v1/x")
        expect(call[2]).toBe("POST")
        expect(call[3]).toBe("{}")
        expect(call[5].followLocation).toBe(false)
    end)

    test("http.request turns FXServer's 'HTTP 404: <body>' failure back into an answer", function()
        local w, SG = world({ http = function() return 404, nil, {}, 'HTTP 404: {"error":"nope"}' end })
        local r = w.run(function() return SG.http.request({ url = "http://127.0.0.1:9/missing" }) end)
        expect(r.status).toBe(404)
        expect(r.body).toBe('{"error":"nope"}')
        expect(r.error).toBeNil()
    end)

    test("http.request reports a transport failure as status 0 with the error", function()
        local w, SG = world({ http = function() return 0, nil, {}, "Couldn't connect to server" end })
        local r = w.run(function() return SG.http.request({ url = "http://127.0.0.1:9/" }) end)
        expect(r.status).toBe(0)
        expect(r.error).toBe("Couldn't connect to server")
    end)

    test("http.request must run in a thread and needs a url", function()
        local w, SG = world()
        -- The spec runner itself runs inside a coroutine on Lua 5.1 (compat.xpcall), so the
        -- "outside a thread" case can only be seen from the main thread.
        local co, isMain = coroutine.running()
        if co == nil or isMain then
            expect(function() SG.http.request({ url = "http://x/" }) end).toThrow("must be called from a thread")
        end
        local r, why = w.run(function() return SG.http.request({}) end)
        expect(r).toBeNil()
        expect(why).toBe("invalid_request")
    end)

    test("licensing is unavailable on both sides (free-only environment)", function()
        local _, SG = world()
        expect(SG.capabilities.has("licensing")).toBe(false)
        expect(capError(function() SG.licensing.verify({ licenseKey = "k" }) end)).toContain("capability_unavailable:licensing@fivem")
        expect(capError(function() SG.capabilities.require("licensing") end)).toContain("capability_unavailable:licensing@fivem")
        for _, c in ipairs(SG.capabilities.list()) do expect(c ~= "licensing").toBe(true) end
        local _, client = world({ server = false })
        expect(capError(function() client.licensing.activate({}) end)).toContain("capability_unavailable:licensing@fivem")
    end)

    test("server-only capabilities refuse on the client", function()
        local _, SG = world({ server = false })
        expect(capError(function() SG.players.list() end)).toContain("capability_unavailable:players@fivem")
        expect(capError(function() SG.permissions.has(1, "x") end)).toContain("capability_unavailable:permissions@fivem")
        expect(capError(function() SG.config.get("x") end)).toContain("capability_unavailable:config@fivem")
        expect(capError(function() SG.http.request({ url = "http://x/" }) end)).toContain("capability_unavailable:http@fivem")
    end)

    test("capabilities.list on the server", function()
        local _, SG = world()
        expect(SG.capabilities.list()).toEqual({ "events", "logging", "storage", "players", "permissions", "commands", "config", "ui", "http" })
    end)

    test("exports.call returns a settled promise whose await gives every value", function()
        local _, SG = world({ resources = { kit = { exports = { pair = function(a) return a, a * 2 end } } } })
        local p = SG.exports.call("kit", "pair", 21)
        local a, b = p:await()
        expect(a).toBe(21)
        expect(b).toBe(42)
        expect(p:status()).toBe("resolved")
    end)

    test("exports.call refusals use the SCRIPT//GO reasons", function()
        local _, SG = world({ resources = {
            kit = { exports = { boom = function() error("kaput") end } },
            down = { state = "stopped", exports = {} },
        } })
        local p, why = SG.exports.call("kit", "nope")
        expect(p).toBeNil()
        expect(why).toBe("export_not_found")
        p, why = SG.exports.call("down", "x")
        expect(why).toBe("export_resource_unavailable")
        p, why = SG.exports.call("ghost", "x")
        expect(why).toBe("export_resource_unavailable")
        local r, err = SG.exports.call("kit", "boom"):await()
        expect(r).toBeNil()
        expect(err).toContain("export_failed")
        expect(err).toContain("kaput")
    end)

    test("resource.version, hasPermission and readFile come from the packed manifest", function()
        local _, SG = world({
            metadata = { version = { "1.4.2" }, scriptgo_permission = { "local.events", "filesystem.read" } },
            files = { ["data/items.json"] = "[]" },
        })
        expect(SG.resource.version()).toBe("1.4.2")
        expect(SG.resource.hasPermission("filesystem.read")).toBe(true)
        expect(SG.resource.hasPermission("network.events")).toBe(false)
        expect(SG.resource.readFile("data/items.json")).toBe("[]")
        local text, why = SG.resource.readFile("../other/x.lua")
        expect(text).toBeNil()
        expect(why).toBe("invalid_path")
        text, why = SG.resource.readFile("missing.txt")
        expect(why).toBe("not_found")
    end)

    test("log lines are printed with their level", function()
        local w, SG = world()
        SG.log.warn("careful")
        expect(w.printed[1]).toBe("[warn] careful")
    end)
end)
