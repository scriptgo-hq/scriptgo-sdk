-- Prints one line per check, `SGCHECK PASS <name>` or `SGCHECK FAIL <name> <detail>`, then
-- `SGCHECK DONE env=<environment> pass=<n> fail=<n>`. The export `results` returns the same data.
local results = { pass = 0, fail = 0, lines = {}, done = false }

local function record(name, ok, detail)
    local line
    if ok then
        results.pass = results.pass + 1
        line = "SGCHECK PASS " .. name
    else
        results.fail = results.fail + 1
        line = "SGCHECK FAIL " .. name .. (detail ~= nil and (" " .. tostring(detail)) or "")
    end
    results.lines[#results.lines + 1] = line
    print(line)
end

-- Runs one check; an error raised inside it is a failure, not a crash of the probe.
local function check(name, fn)
    local ok, verdict, detail = pcall(fn)
    if not ok then return record(name, false, "raised: " .. tostring(verdict)) end
    record(name, verdict == true, detail)
end

local function contains(list, pred)
    for _, v in ipairs(list or {}) do if pred(v) then return true end end
    return false
end

local bus = {}
AddEventHandler("sgbus:probe.ping", function(payload, meta)
    bus[#bus + 1] = { n = payload and payload.n, seq = meta and meta.seq, publisher = meta and meta.publisher }
end)

local function run()
    local env = ScriptGo.runtime.environment()

    check("runtime.side", function() return ScriptGo.runtime.side() == "server", ScriptGo.runtime.side() end)
    check("resource.name", function() return ScriptGo.resource.name() == "sg_probe" and GetCurrentResourceName() == "sg_probe" end)

    check("storage.roundtrip", function()
        local ok = ScriptGo.storage.set("probe:value", { a = 1, list = { "x", "y" }, flag = true })
        local v = ScriptGo.storage.get("probe:value")
        return ok ~= false and type(v) == "table" and v.a == 1 and v.list[2] == "y" and v.flag == true, ok
    end)
    check("storage.delete", function()
        ScriptGo.storage.delete("probe:value")
        return ScriptGo.storage.get("probe:value") == nil
    end)

    check("time.now", function() local t = ScriptGo.time.now(); return type(t) == "number" and t > 1700000000, t end)
    check("time.monotonic", function()
        local a = ScriptGo.time.monotonic()
        Wait(50)
        local b = ScriptGo.time.monotonic()
        return type(a) == "number" and b >= a, tostring(a) .. " -> " .. tostring(b)
    end)

    check("capabilities.declared", function()
        for _, c in ipairs({ "events", "logging", "storage", "players", "permissions", "config" }) do
            if not ScriptGo.capabilities.has(c) then return false, c end
        end
        return true
    end)
    check("capabilities.refusal", function()
        if ScriptGo.capabilities.has("http") then return true, "http available here" end
        -- A host may refuse when the member is read or when it is called: both are inside the pcall.
        local ok, err = pcall(function() return ScriptGo.http.request({ url = "http://127.0.0.1/" }) end)
        return not ok and tostring(err):find("capability_unavailable:http@", 1, true) ~= nil, err
    end)

    check("players.list", function() return type(ScriptGo.players.list()) == "table" end)
    check("players.invalid_id", function() return ScriptGo.players.name(0) == nil and ScriptGo.players.identifier(-3) == nil end)
    check("permissions.console", function() return ScriptGo.permissions.has(0, "anything.at.all") == true end)
    check("config.default", function() return ScriptGo.config.get("probe_missing_key", 42) == 42 end)

    check("promise.local", function()
        local p = promise.new()
        SetTimeout(10, function() p:resolve("late") end)
        return Citizen.Await(p) == "late"
    end)

    -- Cross-resource exports, synchronous proxy.
    check("exports.sync", function()
        local items = exports.sg_inventory:items()
        return contains(items, function(d) return d.name == "water" end), type(items)
    end)
    check("exports.define_item", function()
        local ok, why = exports.sg_inventory:defineItem({ name = "probe_gem", label = "Probe gem", weight = 0.1, stack = 5 })
        local items = exports.sg_inventory:items()
        return ok == true and contains(items, function(d) return d.name == "probe_gem" end), why
    end)
    check("exports.refusal", function()
        local ok, why = exports.sg_inventory:add(0, "water", 1)
        return ok == false and type(why) == "string", why
    end)

    -- Cross-resource exports, asynchronous.
    check("exports.async", function()
        local stats = ScriptGo.exports.call("sg_eventbus", "stats"):await()
        return type(stats) == "table" and type(stats.topics) == "number", type(stats)
    end)

    -- EventBus: definition, validation, delivery on the host bus, retained value, ownership.
    check("bus.define", function()
        return exports.sg_eventbus:defineTopic("probe.ping", {
            schema = { type = "table", fields = { n = { type = "number", integer = true } } }, retain = true,
        })
    end)
    check("bus.publish", function()
        local ok, seq = exports.sg_eventbus:publish("probe.ping", { n = 7 })
        return ok == true and seq == 1, seq
    end)
    check("bus.reject", function()
        local ok, why = exports.sg_eventbus:publish("probe.ping", { n = "seven" })
        return ok == false and type(why) == "string", why
    end)
    check("bus.delivery", function()
        Wait(100)
        return #bus == 1 and bus[1].n == 7 and bus[1].publisher == "sg_probe", #bus .. " " .. tostring(bus[1] and bus[1].publisher)
    end)
    check("bus.retained", function()
        local payload, meta = exports.sg_eventbus:last("probe.ping")
        return type(payload) == "table" and payload.n == 7 and meta.seq == 1
    end)
    check("bus.owner", function()
        return contains(exports.sg_eventbus:topics(), function(t) return t.name == "probe.ping" and t.owner == "sg_probe" end)
    end)

    -- Permissions kit: runtime role definition with inheritance, and cycle refusal.
    check("perms.define_role", function()
        local ok, why = exports.sg_permissions:defineRole("probe_role", { inherits = { "user" }, privileges = { "probe.use" } })
        local roles = exports.sg_permissions:listRoles()
        return ok == true and contains(roles, function(r) return r.name == "probe_role" end), why
    end)
    check("perms.cycle", function()
        local ok, why = exports.sg_permissions:defineRole("user", { inherits = { "probe_role" }, privileges = {} })
        return ok == false and type(why) == "string", why
    end)

    results.done = true
    print(("SGCHECK DONE env=%s lua=%s pass=%d fail=%d"):format(env, _VERSION, results.pass, results.fail))
end

exports("results", function() return results end)

CreateThread(function()
    Wait(200) -- let the dependencies finish their own start-up work
    run()
end)
