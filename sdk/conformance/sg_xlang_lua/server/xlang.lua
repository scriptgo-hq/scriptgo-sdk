-- Lua -> TypeScript checks, then the TypeScript -> Lua checks of sg_xlang_ts (started by the event
-- "xlang:go"), then `SGCHECK DONE`. Same line format as sg_probe.
local pass, fail = 0, 0

local function record(name, ok, detail)
    if ok then
        pass = pass + 1
        print("SGCHECK PASS " .. name)
    else
        fail = fail + 1
        print("SGCHECK FAIL " .. name .. (detail ~= nil and (" " .. tostring(detail)) or ""))
    end
end

local function check(name, fn)
    local ok, verdict, detail = pcall(fn)
    if not ok then return record(name, false, "raised: " .. tostring(verdict)) end
    record(name, verdict == true, detail)
end

-- Exports TypeScript calls.
exports("sum", function(list)
    local s = 0
    for _, v in ipairs(list) do s = s + v end
    return s
end)
exports("multi", function() return 1, "b", true end)
exports("slowDouble", function(n) Wait(20) return n * 2 end)
exports("fail", function() error("lua says no") end)
exports("sparse", function() return { map = { [1] = "a", [3] = "c" }, empty = {}, int = 3, float = 1.5 } end)

-- Event TypeScript sends: answer on another event.
AddEventHandler("xlang:tsPing", function(n) TriggerEvent("xlang:tsPong", n + 1, math.type(n)) end)

local pong
AddEventHandler("xlang:pong", function(p) pong = p end)
local tsDone
AddEventHandler("xlang:tsDone", function(p, f) tsDone = { pass = p, fail = f } end)

local function same(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= "table" then return a == b and math.type(a) == math.type(b) end
    for k, v in pairs(a) do if not same(v, b[k]) then return false end end
    for k in pairs(b) do if a[k] == nil then return false end end
    return true
end

CreateThread(function()
    Wait(0)
    local ts = exports.sg_xlang_ts

    check("xlang.sync_call", function() local r = ts:add(2, 3) return r == 5 and math.type(r) == "integer", r end)
    check("xlang.multi_values", function()
        local a, b, c = ts:pair()
        return a == 1 and b == "two" and c == nil, tostring(a) .. " " .. tostring(b)
    end)
    check("xlang.codec_roundtrip", function()
        local v = { a = { b = { "x", "y" } }, n = 1.25, i = 3, s = "é ✓", t = true, neg = -7 }
        local back = ts:echo(v)
        return same(v, back), ScriptGo.json.encode(back)
    end)
    check("xlang.empty_table", function()
        local back = ts:echo({})
        return type(back) == "table" and next(back) == nil
    end)
    check("xlang.integer_kinds", function()
        local kind, isInt, f, big = ts:types(3, 1.5, 2 ^ 53)
        return kind == "number" and isInt == true and f == 1.5 and big == true, tostring(kind) .. " " .. tostring(isInt)
    end)
    check("xlang.async_call", function()
        local r = ScriptGo.exports.call("sg_xlang_ts", "slow", 4):await()
        return r == 8, r
    end)
    check("xlang.error", function()
        local ok, err = pcall(function() return ts:fail() end)
        return not ok and tostring(err):find("export sg_xlang_ts:fail", 1, true) ~= nil and tostring(err):find("nope", 1, true) ~= nil, err
    end)
    check("xlang.yield_refused", function()
        local ok, err = pcall(function() return ts:slow(1) end)
        return not ok and tostring(err):find("export_yielded", 1, true) ~= nil, err
    end)
    check("xlang.invoking", function() local who = ts:whoCalls() return who == "sg_xlang_lua", who end)
    check("xlang.refuse_function", function()
        local ok, err = pcall(function() return ts:echo(function() end) end)
        -- The portable core's token for an argument the codec refuses (sdk/lua/scriptgo/host.lua).
        return not ok and tostring(err):find("export sg_xlang_ts:echo export_arguments_not_serializable", 1, true) ~= nil, err
    end)
    check("xlang.event_roundtrip", function()
        pong = nil
        TriggerEvent("xlang:ping", { x = 41 })
        for _ = 1, 50 do
            if pong then break end
            Wait(10)
        end
        return pong ~= nil and pong.reply == 42 and math.type(pong.reply) == "integer" and #pong.list == 3, pong and ScriptGo.json.encode(pong)
    end)

    -- The other direction: TypeScript runs its checks against this resource and reports back.
    TriggerEvent("xlang:go")
    for _ = 1, 150 do
        if tsDone then break end
        Wait(10)
    end
    check("xlang.ts_half_finished", function() return tsDone ~= nil and tsDone.fail == 0, tsDone and (tsDone.pass .. " passed, " .. tsDone.fail .. " failed") end)
    print(("SGCHECK DONE env=%s lang=lua+ts pass=%d fail=%d"):format(ScriptGo.runtime.environment(), pass, fail))
end)
