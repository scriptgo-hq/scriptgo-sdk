-- Prints `SGCHECK PASS|FAIL <name>` per check and `SGCHECK DONE ...` at the end, like sg_probe.
-- The fixed data is the stub's (packages/cli/src/lib/stub-perks.ts): `sgprobe:holder` holds `vip`,
-- the event queue grants `vip` to `sgprobe:buyer`, the catalog sells `vip` and not `gold`. Players
-- are given as identifier strings, so no connected player is needed.
local results = { pass = 0, fail = 0, done = false }
local HOLDER, BUYER = "sgprobe:holder", "sgprobe:buyer"

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

local granted = nil
local function run()
    local env = ScriptGo.runtime.environment()
    check("capabilities.declared", function() return ScriptGo.capabilities.has("perks"), "perks" end)
    -- Registered before the first call, so the first pull of the event queue reaches it.
    ScriptGo.perks.on("granted", function(player, key, info)
        if type(info) == "table" and info.identifier == BUYER then granted = { player = player, key = key, info = info } end
    end)
    check("perks.configured", function()
        local s = ScriptGo.perks.status()
        return type(s) == "table" and s.configured == true, "set scriptgo_server_token"
    end)

    -- The client pulls the event queue on the host's next tick after its first use (the `on`
    -- above): wait for the grant first (at most 10 s), so a host that runs the probe on a short
    -- simulated clock (the standalone verify) still sees it.
    local waited = 0
    while not granted and waited < 10000 do
        Wait(250)
        waited = waited + 250
    end
    check("perks.event_granted", function()
        if not granted then return false, "no granted event in 10 s" end
        return granted.key == "vip" and granted.info.reason == "purchase" and granted.player == nil,
            tostring(granted.key) .. " " .. tostring(granted.info.reason)
    end)
    check("perks.has_held", function()
        local has, info = ScriptGo.perks.has(HOLDER, "vip")
        if not has then return false, info end
        return type(info) == "table" and info.source == "api" and info.status == "active" and type(info.expiresAt) == "number",
            type(info) == "table" and tostring(info.source) .. " " .. tostring(info.status) or tostring(info)
    end)
    check("perks.has_cached", function()
        local has, info = ScriptGo.perks.has(HOLDER, "vip")
        return has == true and type(info) == "table" and info.source == "cache", type(info) == "table" and info.source or info
    end)
    check("perks.not_held", function()
        local has, why = ScriptGo.perks.has(HOLDER, "gold")
        return has == false and why == "not_held", why
    end)
    check("perks.invalid_perk", function()
        local has, why = ScriptGo.perks.has(HOLDER, "Not A Key")
        return has == false and why == "invalid_perk", why
    end)
    check("perks.list", function()
        local list, why = ScriptGo.perks.list(HOLDER)
        if type(list) ~= "table" then return false, why end
        return #list == 1 and list[1].key == "vip" and list[1].status == "active", #list
    end)
    check("perks.catalog", function()
        local list, why = ScriptGo.perks.catalog()
        if type(list) ~= "table" then return false, why end
        local keys = {}
        for _, p in ipairs(list) do keys[p.key] = p.purchasable end
        return keys.vip == true and keys.gold == false, "vip/gold"
    end)
    check("perks.purchase_link", function()
        local url, expiresAt = ScriptGo.perks.purchaseLink(BUYER, "vip")
        return type(url) == "string" and url ~= "" and type(expiresAt) == "number", tostring(expiresAt)
    end)
    check("perks.purchase_link_held", function()
        local url, code = ScriptGo.perks.purchaseLink(HOLDER, "vip")
        return url == nil and code == "already_held", code
    end)
    check("perks.purchase_link_unsold", function()
        local url, code = ScriptGo.perks.purchaseLink(BUYER, "gold")
        return url == nil and code == "not_purchasable", code
    end)

    check("perks.status_linked", function()
        local s = ScriptGo.perks.status()
        return s.linked == true and (tonumber(s.cursor) or 0) >= 1 and s.lastError == nil,
            ("linked=%s cursor=%s error=%s"):format(tostring(s.linked), tostring(s.cursor), tostring(s.lastError))
    end)

    results.done = true
    print(("SGCHECK DONE env=%s lua=%s pass=%d fail=%d"):format(env, _VERSION, results.pass, results.fail))
end

exports("results", function() return results end)

CreateThread(function()
    Wait(100)
    run()
end)
