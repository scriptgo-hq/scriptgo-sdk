-- Prints `SGCHECK PASS|FAIL <name>` per check and `SGCHECK DONE ...` at the end, like sg_probe.
-- The fixed data is the stub's (packages/cli/src/lib/stub-presence.ts): code `K7-4QX` links,
-- `US-ED00` is used, `EX-P1RE` has expired. What the probe cannot see from here (that only
-- fingerprints reached the API) the stub checks on its side: `api:presence_bodies_valid`.
local results = { pass = 0, fail = 0, done = false }

local function record(name, ok, detail)
    if ok then
        results.pass = results.pass + 1
        print("SGCHECK PASS " .. name)
    else
        results.fail = results.fail + 1
        print("SGCHECK FAIL " .. name .. (detail ~= nil and (" " .. tostring(detail)) or ""))
    end
end

local function check(name, fn)
    local ok, verdict, detail = pcall(fn)
    if not ok then return record(name, false, "raised: " .. tostring(verdict)) end
    record(name, verdict == true, detail)
end

local function waitFor(fn, ms)
    local waited = 0
    while not fn() and waited < ms do
        Wait(250)
        waited = waited + 250
    end
    return fn()
end

local function run()
    local env = ScriptGo.runtime.environment()
    check("capabilities.declared", function() return ScriptGo.capabilities.has("presence"), "presence" end)

    -- A connected player: the verifier joins right after the resources start.
    local player = nil
    waitFor(function()
        local list = ScriptGo.players.list()
        player = type(list) == "table" and list[1] or nil
        return player ~= nil
    end, 2000)
    check("presence.player_connected", function() return player ~= nil, "no connected player" end)

    check("presence.enabled", function()
        local s = ScriptGo.presence.status()
        return type(s) == "table" and s.enabled == true, "set scriptgo_presence"
    end)
    -- Active means: a server link token, a readable address and an HMAC. The reason says which is
    -- missing ("presence unavailable: no HMAC on this host").
    check("presence.active", function()
        local s = ScriptGo.presence.status()
        return s.active == true, s.reason
    end)
    waitFor(function() return (ScriptGo.presence.status().reported or 0) >= 1 end, 1500)
    check("presence.reported", function()
        local s = ScriptGo.presence.status()
        return (s.reported or 0) >= 1 and s.lastError == nil and type(s.rotatesAt) == "number",
            ("reported=%s error=%s"):format(tostring(s.reported), tostring(s.lastError))
    end)

    if player ~= nil then
        check("link.confirmed", function()
            local ok, why = ScriptGo.presence.link(player, "k7 4qx")
            return ok == true, why
        end)
        check("link.code_used", function()
            local ok, why = ScriptGo.presence.link(player, "US-ED00")
            return ok == false and why == "code_used", why
        end)
        check("link.code_expired", function()
            local ok, why = ScriptGo.presence.link(player, "EX-P1RE")
            return ok == false and why == "code_expired", why
        end)
        check("link.unknown_code", function()
            local ok, why = ScriptGo.presence.link(player, "ZZ-ZZZZ")
            return ok == false and why == "unknown_code", why
        end)
        check("link.malformed_code", function()
            local ok, why = ScriptGo.presence.link(player, "not a code!")
            return ok == false and why == "invalid_code", why
        end)
    end
    check("link.message", function()
        local text = ScriptGo.presence.linkMessage(true)
        return text == "Linked: you can go back to your browser.", text
    end)

    results.done = true
    print(("SGCHECK DONE env=%s lua=%s pass=%d fail=%d"):format(env, _VERSION, results.pass, results.fail))
end

exports("results", function() return results end)

CreateThread(function()
    Wait(100)
    run()
end)
