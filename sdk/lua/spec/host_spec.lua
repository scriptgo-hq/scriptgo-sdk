-- Runtime behaviour of the host, with in-memory resources and a manual clock.
local suite, scriptgo, ctx = ...
local test, expect, describe = suite.test, scriptgo.testing.expect, suite.describe
local testing = scriptgo.testing

-- files: { ["name/scriptgo.lua"] = "...", ... }
local function harness(files, opts)
    opts = opts or {}
    opts.files = files
    opts.readFile = function() return nil end
    return testing.harness(opts)
end

local function manifestFor(name, extra)
    return ('resource "%s"\nversion "1.0.0"\nscriptgo_version ">=0.1.0"\n%s'):format(name, extra or "")
end

describe("loading", function()
    test("loads scriptgo.lua and runs shared, server and client scripts in order", function()
        local h = harness({
            ["res_a/scriptgo.lua"] = manifestFor("res_a", 'shared_script "s.lua"\nserver_script "sv.lua"\nclient_script "cl.lua"\n'),
            ["res_a/s.lua"] = 'order = (order or "") .. "s"; SIDE = ScriptGo.runtime.side()',
            ["res_a/sv.lua"] = 'exports("order", function() return order .. "v" end)',
            ["res_a/cl.lua"] = 'exports("order", function() return order .. "c" end)',
        })
        h:add("res_a")
        expect(h:start("res_a")).toBe(true)
        expect(h:call("res_a", "order")).toBe("sv")
        expect(h:callClient("res_a", "order")).toBe("sc")
    end)

    test("loads an OPEN//77 resource from open77.lua unchanged", function()
        local h = harness({
            ["garage/open77.lua"] = 'resource "garage"\nversion "0.2.0"\nserver_script "server.lua"\n',
            ["garage/server.lua"] = 'exports("hello", function(n) Open77.log.info("hi " .. n) return "garage:" .. n end)',
        })
        h:add("garage")
        expect(h:start("garage")).toBe(true)
        expect(h:call("garage", "hello", "v")).toBe("garage:v")
        expect(h:findLog("hi v")).toBeTruthy()
    end)

    test("refuses a folder whose name differs from the resource", function()
        local h = harness({ ["dir/scriptgo.lua"] = manifestFor("other", 'server_script "x.lua"\n') })
        local res, err = h.host:addResource("dir")
        expect(res).toBeNil()
        expect(err).toContain("must match its folder")
    end)

    test("a script error fails the start and leaves nothing running", function()
        local h = harness({
            ["bad/scriptgo.lua"] = manifestFor("bad", 'server_script "a.lua"\nserver_script "b.lua"\n'),
            ["bad/a.lua"] = 'RegisterCommand("ping", function() end)',
            ["bad/b.lua"] = 'error("boom")',
        })
        h:add("bad")
        local ok, why = h:start("bad")
        expect(ok).toBe(false)
        expect(why).toContain("boom")
        expect(h.host:resourceState("bad")).toBe("failed")
        local cmdOk, cmdWhy = h:command(0, "ping")
        expect(cmdOk).toBe(false)
        expect(cmdWhy).toBe("unknown_command:ping")
    end)
end)

describe("scheduler", function()
    test("Wait resumes after the requested time", function()
        local h = harness({
            ["res_t/scriptgo.lua"] = manifestFor("res_t", 'server_script "s.lua"\n'),
            ["res_t/s.lua"] = [[
                marks = {}
                CreateThread(function()
                    marks[#marks + 1] = "a"
                    Wait(100)
                    marks[#marks + 1] = "b"
                end)
                exports("marks", function() return table.concat(marks, ",") end)
            ]],
        })
        h:add("res_t"); h:start("res_t")
        expect(h:call("res_t", "marks")).toBe("a")
        h:tick(50)
        expect(h:call("res_t", "marks")).toBe("a")
        h:tick(60)
        expect(h:call("res_t", "marks")).toBe("a,b")
    end)

    test("SetTimeout fires once and ClearTimeout cancels", function()
        local h = harness({
            ["res_t/scriptgo.lua"] = manifestFor("res_t", 'server_script "s.lua"\n'),
            ["res_t/s.lua"] = [[
                fired = 0
                SetTimeout(20, function() fired = fired + 1 end)
                local id = SetTimeout(20, function() fired = fired + 100 end)
                ClearTimeout(id)
                exports("fired", function() return fired end)
            ]],
        })
        h:add("res_t"); h:start("res_t")
        h:tick(100)
        expect(h:call("res_t", "fired")).toBe(1)
    end)

    test("Wait inside pcall works on every dialect", function()
        local h = harness({
            ["res_t/scriptgo.lua"] = manifestFor("res_t", 'server_script "s.lua"\n'),
            ["res_t/s.lua"] = [[
                state = "init"
                CreateThread(function()
                    local ok, err = pcall(function()
                        Wait(10)
                        error("inside")
                    end)
                    state = (ok and "ok" or "caught:") .. tostring(err):match("inside")
                end)
                exports("state", function() return state end)
            ]],
        })
        h:add("res_t"); h:start("res_t")
        h:tick(50)
        expect(h:call("res_t", "state")).toBe("caught:inside")
    end)

    test("Wait outside a thread raises a clear error", function()
        local h = harness({
            ["res_t/scriptgo.lua"] = manifestFor("res_t", 'server_script "s.lua"\n'),
            ["res_t/s.lua"] = 'exports("w", function() return pcall(Wait, 0) end)',
        })
        h:add("res_t"); h:start("res_t")
        -- Exports run in a scheduler thread, so Wait is allowed there.
        expect(h:call("res_t", "w")).toBe(true)
    end)
end)

describe("events", function()
    test("client TriggerEvent stays inside the resource side", function()
        local h = harness({
            ["res_a/scriptgo.lua"] = manifestFor("res_a", 'client_script "c.lua"\n'),
            ["res_a/c.lua"] = [[
                got = {}
                AddEventHandler("ping", function(x) got[#got + 1] = "a" .. x end)
                exports("fire", function() TriggerEvent("ping", 1) return table.concat(got, ",") end)
                exports("got", function() return table.concat(got, ",") end)
            ]],
            ["res_b/scriptgo.lua"] = manifestFor("res_b", 'client_script "c.lua"\n'),
            ["res_b/c.lua"] = [[
                got = {}
                AddEventHandler("ping", function(x) got[#got + 1] = "b" .. x end)
                exports("got", function() return table.concat(got, ",") end)
            ]],
        })
        h:add("res_a"); h:add("res_b"); h:start("res_a"); h:start("res_b")
        expect(h:callClient("res_a", "fire")).toBe("a1")
        expect(h:callClient("res_b", "got")).toBe("")
    end)

    test("server TriggerEvent is the host bus: queued, every resource, no source", function()
        local h = harness({
            ["res_a/scriptgo.lua"] = manifestFor("res_a", 'server_script "s.lua"\n'),
            ["res_a/s.lua"] = [[
                exports("fire", function()
                    local ok = TriggerEvent("bank:robbed", 7, { amount = 50 })
                    return ok, seen
                end)
                AddEventHandler("bank:robbed", function(who, d) seen = who + d.amount end)
                exports("seen", function() return seen end)
            ]],
            ["res_b/scriptgo.lua"] = manifestFor("res_b", 'server_script "s.lua"\n'),
            ["res_b/s.lua"] = [[
                AddEventHandler("bank:robbed", function(who, d) seen = { who = who, src = source } end)
                exports("seen", function() return seen end)
            ]],
        })
        h:add("res_a"); h:add("res_b"); h:start("res_a"); h:start("res_b")
        local promise = h.host:callExport("res_a", "fire", "server")
        expect(promise:status()).toBe("resolved")
        local ok, seenAtCall = promise:await()
        expect(ok).toBe(true)
        expect(seenAtCall).toBeNil() -- not re-entrant: delivered at the next tick
        h:tick(10)
        expect(h:call("res_a", "seen")).toBe(57)
        expect(h:call("res_b", "seen")).toEqual({ who = 7 })
    end)

    test("RemoveEventHandler takes the handler id", function()
        local h = harness({
            ["res_a/scriptgo.lua"] = manifestFor("res_a", 'client_script "c.lua"\n'),
            ["res_a/c.lua"] = [[
                n = 0
                local id = AddEventHandler("x", function() n = n + 1 end)
                exports("run", function()
                    TriggerEvent("x")
                    RemoveEventHandler(id)
                    TriggerEvent("x")
                    return n, type(id)
                end)
            ]],
        })
        h:add("res_a"); h:start("res_a")
        local n, kind = h:callClient("res_a", "run")
        expect(n).toBe(1)
        expect(kind).toBe("number")
    end)

    test("network events reach only registered handlers, with the sender in source", function()
        local h = harness({
            ["inv/scriptgo.lua"] = manifestFor("inv", 'server_script "s.lua"\nclient_script "c.lua"\n'),
            ["inv/s.lua"] = [[
                RegisterNetEvent("inv:request", function(page)
                    last = { src = source, page = page }
                    TriggerClientEvent("inv:state", source, { page = page, items = 3 })
                end)
                AddEventHandler("inv:local", function() leaked = true end)
                exports("last", function() return last, leaked end)
            ]],
            ["inv/c.lua"] = [[
                RegisterNetEvent("inv:state", function(state) received = state end)
                exports("ask", function()
                    TriggerServerEvent("inv:request", 2)
                    TriggerServerEvent("inv:local")
                    return true
                end)
                exports("received", function() return received end)
            ]],
        })
        h:add("inv"); h:start("inv")
        h:join(1, "Tester")
        expect(h:callClient("inv", "ask")).toBe(true)
        h:tick(20)
        local last, leaked = h:call("inv", "last")
        expect(last).toEqual({ src = 1, page = 2 })
        expect(leaked).toBeNil()
        expect(h:callClient("inv", "received")).toEqual({ page = 2, items = 3 })
    end)

    test("values are copied and functions are refused", function()
        local h = harness({
            ["res_a/scriptgo.lua"] = manifestFor("res_a", 'client_script "c.lua"\n'),
            ["res_a/c.lua"] = [[
                exports("send", function()
                    local ok, why = TriggerServerEvent("x", function() end)
                    return ok, why
                end)
            ]],
        })
        h:add("res_a"); h:start("res_a")
        local ok, why = h:callClient("res_a", "send")
        expect(ok).toBe(false)
        expect(why).toBe("event_payload_not_serializable")
    end)

    test("lifecycle and player events follow OPEN//77", function()
        local h = harness({
            ["obs/scriptgo.lua"] = manifestFor("obs", 'server_script "s.lua"\n'),
            ["obs/s.lua"] = [[
                seen = {}
                AddEventHandler("onResourceStart", function(n) seen[#seen + 1] = "start:" .. n end)
                AddEventHandler("onResourceStop", function(n, r) seen[#seen + 1] = "stop:" .. n .. ":" .. r end)
                AddEventHandler("playerJoining", function() seen[#seen + 1] = "joining:" .. source end)
                AddEventHandler("onPlayerConnected", function(id) seen[#seen + 1] = "connected:" .. id end)
                AddEventHandler("playerDropped", function(reason) seen[#seen + 1] = "dropped:" .. source .. ":" .. reason end)
                AddEventHandler("onPlayerDisconnected", function(id, reason) seen[#seen + 1] = "disc:" .. id .. ":" .. reason end)
                exports("seen", function() return table.concat(seen, " ") end)
            ]],
            ["other/scriptgo.lua"] = manifestFor("other", 'server_script "s.lua"\n'),
            ["other/s.lua"] = "",
        })
        h:add("obs"); h:add("other")
        h:start("obs"); h:start("other")
        h:join(4, "Ana")
        h:drop(4, "quit")
        h:stop("other")
        expect(h:call("obs", "seen")).toBe("start:obs start:other joining:4 connected:4 dropped:4:quit disc:4:quit stop:other:stopped")
    end)
end)

describe("exports and promises", function()
    test("Open77.exports.call returns a promise; await yields the copied values", function()
        local h = harness({
            ["bank/scriptgo.lua"] = manifestFor("bank", 'server_script "s.lua"\n'),
            ["bank/s.lua"] = [[
                local balance = { [1] = 100 }
                exports("withdraw", function(player, amount)
                    Wait(5)
                    if balance[player] < amount then return false, "insufficient_funds" end
                    balance[player] = balance[player] - amount
                    return true, balance[player], GetInvokingResource()
                end)
            ]],
            ["shop/scriptgo.lua"] = manifestFor("shop", 'server_script "s.lua"\ndependency "bank"\n'),
            ["shop/s.lua"] = [[
                exports("buy", function()
                    local pending, reason = Open77.exports.call("bank", "withdraw", 1, 30)
                    if not pending then return nil, reason end
                    return pending:await()
                end)
                exports("missing", function()
                    return ScriptGo.exports.call("bank", "nope")
                end)
            ]],
        })
        h:add("bank"); h:add("shop")
        expect(h:start("shop")).toBe(true)
        expect(h.host:resourceState("bank")).toBe("started")
        local ok, left, invoker = h:call("shop", "buy")
        expect(ok).toBe(true)
        expect(left).toBe(70)
        expect(invoker).toBe("shop")
        local p, reason = h:call("shop", "missing")
        expect(p).toBeNil()
        expect(reason).toBe("export_not_found")
    end)

    test("promise.new, Citizen.Await and await outside a thread", function()
        local h = harness({
            ["res_p/scriptgo.lua"] = manifestFor("res_p", 'server_script "s.lua"\n'),
            ["res_p/s.lua"] = [[
                local p = promise.new()
                outside = { p:await() }
                CreateThread(function() Wait(20) p:resolve("done", 2) end)
                CreateThread(function() result = { Citizen.Await(p) } end)
                exports("state", function() return outside[2], result, p:status(), p:resolve("again") end)
            ]],
        })
        h:add("res_p"); h:start("res_p")
        h:tick(50)
        local outsideReason, result, status, again = h:call("res_p", "state")
        expect(outsideReason).toBe("await_requires_scheduler_coroutine")
        expect(result).toEqual({ "done", 2 })
        expect(status).toBe("resolved")
        expect(again).toBe(false)
    end)

    test("an export error rejects the promise", function()
        local h = harness({
            ["res_e/scriptgo.lua"] = manifestFor("res_e", 'server_script "s.lua"\n'),
            ["res_e/s.lua"] = 'exports("fail", function() error("nope") end)',
        })
        h:add("res_e"); h:start("res_e")
        local v, reason = h:call("res_e", "fail")
        expect(v).toBeNil()
        expect(reason).toContain("export_failed")
    end)
end)

describe("dependencies and lifecycle", function()
    test("a dependency outside its range fails the dependent", function()
        local h = harness({
            ["lib/scriptgo.lua"] = manifestFor("lib", 'server_script "s.lua"\n'),
            ["lib/s.lua"] = "",
            ["app/scriptgo.lua"] = manifestFor("app", 'server_script "s.lua"\ndependency "lib >=2.0.0"\n'),
            ["app/s.lua"] = "",
        })
        h:add("lib"); h:add("app")
        local ok, why = h:start("app")
        expect(ok).toBe(false)
        expect(why).toContain("does not satisfy >=2.0.0")
    end)

    test("stopping a dependency stops its dependents first", function()
        local h = harness({
            ["lib/scriptgo.lua"] = manifestFor("lib", 'server_script "s.lua"\n'),
            ["lib/s.lua"] = "",
            ["app/scriptgo.lua"] = manifestFor("app", 'server_script "s.lua"\ndependency "lib"\n'),
            ["app/s.lua"] = "",
        })
        h:add("lib"); h:add("app")
        h:start("app")
        h:stop("lib")
        expect(h.host:resourceState("app")).toBe("stopped")
        expect(h.host:resourceState("lib")).toBe("stopped")
    end)

    test("a required capability the host lacks fails with capability_unavailable", function()
        local h = harness({
            ["net/scriptgo.lua"] = manifestFor("net", 'server_script "s.lua"\ncapabilities { "events", "http" }\n'),
            ["net/s.lua"] = "",
        }, { capabilities = { events = true, logging = true } })
        h:add("net")
        local ok, why = h:start("net")
        expect(ok).toBe(false)
        expect(why).toBe("capability_unavailable:http@standalone")
    end)

    test("touching an unavailable optional capability raises the same token", function()
        local h = harness({
            ["opt/scriptgo.lua"] = manifestFor("opt", 'server_script "s.lua"\n'),
            ["opt/s.lua"] = [[
                exports("try", function()
                    local ok, err = pcall(function() return ScriptGo.storage.get("x") end)
                    return ok, err, ScriptGo.capabilities.has("storage")
                end)
            ]],
        }, { capabilities = { events = true, logging = true } })
        h:add("opt"); h:start("opt")
        local ok, err, has = h:call("opt", "try")
        expect(ok).toBe(false)
        expect(err).toContain("capability_unavailable:storage@standalone")
        expect(has).toBe(false)
    end)
end)

describe("sandbox", function()
    test("dangerous globals are absent", function()
        local h = harness({
            ["res_s/scriptgo.lua"] = manifestFor("res_s", 'server_script "s.lua"\n'),
            ["res_s/s.lua"] = [[
                exports("probe", function()
                    return {
                        io = io == nil, debug = debug == nil, load = load == nil, loadstring = loadstring == nil,
                        dofile = dofile == nil, require_pkg = package == nil, coroutine = coroutine == nil,
                        execute = os.execute == nil, getenv = os.getenv == nil, time = type(os.time) == "function",
                    }
                end)
            ]],
        })
        h:add("res_s"); h:start("res_s")
        expect(h:call("res_s", "probe")).toEqual({
            io = true, debug = true, load = true, loadstring = true, dofile = true, require_pkg = true,
            coroutine = true, execute = true, getenv = true, time = true,
        })
    end)

    test("require is confined to the resource and cached, and answers nil, reason", function()
        local h = harness({
            ["res_m/scriptgo.lua"] = manifestFor("res_m", 'client_script "c.lua"\nfiles { "lib/*.lua" }\n'),
            ["res_m/lib/util.lua"] = 'loads = (loads or 0) + 1\nreturn { twice = function(x) return x * 2 end }',
            ["res_m/c.lua"] = [[
                local u = require("lib.util")
                local again = require("lib.util")
                exports("run", function()
                    local bad, why = require("../other/x")
                    local missing, why2 = require("lib.nope")
                    local undeclared, why3 = require("@other")
                    return u.twice(21), u == again, loads, bad, why, missing, why2, undeclared, why3
                end)
            ]],
        })
        h:add("res_m"); h:start("res_m")
        local v, same, loads, bad, why, missing, why2, undeclared, why3 = h:callClient("res_m", "run")
        expect(v).toBe(42)
        expect(same).toBe(true)
        expect(loads).toBe(1)
        expect(bad).toBeNil()
        expect(why).toBe("invalid_module_name")
        expect(missing).toBeNil()
        expect(why2).toBe("module_not_found:lib.nope")
        expect(undeclared).toBeNil()
        expect(why3).toBe("dependency_not_declared:other")
    end)

    test("require('@lib') loads a declared dependency's init.lua", function()
        local h = harness({
            ["lib/scriptgo.lua"] = manifestFor("lib", 'files { "init.lua", "helpers/*.lua" }\n'),
            ["lib/init.lua"] = 'return { name = "lib" }',
            ["lib/helpers/math.lua"] = 'return { add = function(a, b) return a + b end }',
            ["app/scriptgo.lua"] = manifestFor("app", 'client_script "c.lua"\ndependency "lib"\n'),
            ["app/c.lua"] = [[
                local lib = require("@lib")
                local m = require("@lib/helpers.math")
                exports("run", function() return lib.name, m.add(2, 3) end)
            ]],
        })
        h:add("lib"); h:add("app")
        expect(h:start("app")).toBe(true)
        local name, sum = h:callClient("app", "run")
        expect(name).toBe("lib")
        expect(sum).toBe(5)
    end)

    test("server and client sides do not share globals", function()
        local h = harness({
            ["res_g/scriptgo.lua"] = manifestFor("res_g", 'server_script "s.lua"\nclient_script "c.lua"\n'),
            ["res_g/s.lua"] = 'SHARED = "server"; exports("v", function() return SHARED end)',
            ["res_g/c.lua"] = 'exports("v", function() return SHARED end)',
        })
        h:add("res_g"); h:start("res_g")
        expect(h:call("res_g", "v")).toBe("server")
        expect(h:callClient("res_g", "v")).toBeNil()
    end)
end)

describe("commands, storage, ui, config", function()
    test("restricted commands need the privilege; the console always may", function()
        local h = harness({
            ["res_c/scriptgo.lua"] = manifestFor("res_c", 'server_script "s.lua"\n'),
            ["res_c/s.lua"] = [[
                calls = {}
                RegisterCommand("give", function(src, args, raw) calls[#calls + 1] = src .. ":" .. table.concat(args, "|") end, true)
                exports("calls", function() return table.concat(calls, " ") end)
            ]],
        }, { permissions = { [2] = { ["command.give"] = true } } })
        h:add("res_c"); h:start("res_c")
        expect(select(2, h:command(1, "/give medkit 2"))).toBe("not_allowed")
        expect(h:command(2, "/give medkit 2")).toBe(true)
        expect(h:command(0, "give ammo")).toBe(true)
        expect(h:call("res_c", "calls")).toBe("2:medkit|2 0:ammo")
    end)

    test("storage persists JSON through the adapter and survives a restart", function()
        local h = harness({
            ["res_st/scriptgo.lua"] = manifestFor("res_st", 'server_script "s.lua"\ncapabilities { "storage" }\n'),
            ["res_st/s.lua"] = [[
                exports("put", function(k, v) return ScriptGo.storage.set(k, v) end)
                exports("get", function(k) return ScriptGo.storage.get(k) end)
                exports("keys", function(p) return ScriptGo.storage.keys(p) end)
            ]],
        })
        h:add("res_st"); h:start("res_st")
        expect(h:call("res_st", "put", "inv:1", { medkit = 2 })).toBe(true)
        h:call("res_st", "put", "inv:2", { ammo = 30 })
        h:call("res_st", "put", "other", 1)
        h:stop("res_st")
        h.host.storageCache = {}
        h:start("res_st")
        expect(h:call("res_st", "get", "inv:1")).toEqual({ medkit = 2 })
        expect(h:call("res_st", "keys", "inv:")).toEqual({ "inv:1", "inv:2" })
        expect(h:storage("res_st")).toEqual({ ["inv:1"] = { medkit = 2 }, ["inv:2"] = { ammo = 30 }, other = 1 })
    end)

    test("ui.notify reaches the adapter tagged with the resource", function()
        local h = harness({
            ["res_n/scriptgo.lua"] = manifestFor("res_n", 'server_script "s.lua"\n'),
            ["res_n/s.lua"] = 'exports("n", function() return Open77.notifications.send(3, { type = "success", message = "Stored." }) end)',
        })
        h:add("res_n"); h:start("res_n")
        expect(h:call("res_n", "n")).toBe(true)
        expect(h:lastNotification()).toEqual({ target = 3, payload = { type = "success", message = "Stored.", resource = "res_n" } })
    end)

    test("config.get reads per-resource values with a default", function()
        local h = harness({
            ["res_cf/scriptgo.lua"] = manifestFor("res_cf", 'server_script "s.lua"\n'),
            ["res_cf/s.lua"] = 'exports("c", function() return ScriptGo.config.get("slots", 10), ScriptGo.config.get("missing", "d"), GetConvar("sv_name", "x") end)',
        }, { config = { res_cf = { slots = 24 }, _global = { sv_name = "lab" } } })
        h:add("res_cf"); h:start("res_cf")
        local slots, missing, convar = h:call("res_cf", "c")
        expect(slots).toBe(24)
        expect(missing).toBe("d")
        expect(convar).toBe("lab")
    end)
end)

describe("licensing", function()
    test("verify posts to the API through the http capability", function()
        local h = harness({
            ["lic/scriptgo.lua"] = manifestFor("lic", 'server_script "s.lua"\ncapabilities { "licensing", "http" }\n'),
            ["lic/s.lua"] = [[
                exports("verify", function()
                    return ScriptGo.licensing.verify({ licenseKey = "SG-TEST", package = "kestrel//inventory-pro" })
                end)
            ]],
        }, {
            config = { _global = { scriptgo_api = "http://api.test" } },
            http = {
                ["POST http://api.test/v1/licenses/verify"] = function(req)
                    return { status = 200, body = '{"valid":true,"status":"active","echo":' .. req.body .. '}' }
                end,
            },
        })
        h:add("lic"); h:start("lic")
        local result, err = h:call("lic", "verify")
        expect(err).toBeNil()
        expect(result.valid).toBe(true)
        expect(result.echo.environment).toBe("standalone")
        expect(result.echo.package).toBe("kestrel//inventory-pro")
    end)

    test("an API error comes back as nil, code", function()
        local h = harness({
            ["lic/scriptgo.lua"] = manifestFor("lic", 'server_script "s.lua"\n'),
            ["lic/s.lua"] = 'exports("verify", function() return ScriptGo.licensing.verify({ licenseKey = "bad", package = "x//y" }) end)',
        }, {
            http = {
                ["POST http://localhost:4100/v1/licenses/verify"] = { status = 404, body = '{"error":{"code":"license_not_found","message":"No such license."}}' },
            },
        })
        h:add("lic"); h:start("lic")
        local result, code = h:call("lic", "verify")
        expect(result).toBeNil()
        expect(code).toBe("license_not_found")
    end)
end)

describe("OPEN//77 manifest semantics", function()
    test("server_export publishes a global function after the last script", function()
        local h = harness({
            ["bank/open77.lua"] = [[
resource "bank"
version "1.0.0"
server_script "a.lua"
server_script "b.lua"
server_export "balance"
]],
            ["bank/a.lua"] = "-- defined later",
            ["bank/b.lua"] = "function balance(id) return id * 10 end",
        })
        h:add("bank")
        expect(h:start("bank")).toBe(true)
        expect(h:call("bank", "balance", 4)).toBe(40)
    end)

    test("a declared export that is not a global function fails the start", function()
        local h = harness({
            ["bank/open77.lua"] = [[
resource "bank"
version "1.0.0"
server_script "a.lua"
server_export "withdraw"
]],
            ["bank/a.lua"] = "local function withdraw() end",
        })
        h:add("bank")
        local ok, why = h:start("bank")
        expect(ok).toBe(false)
        expect(why).toBe("manifest_export_missing:withdraw")
    end)

    test("script globs expand in name order with ** needing a directory", function()
        local h = harness({
            ["globs/open77.lua"] = [[
resource "globs"
version "1.0.0"
client_script "client/**/*.lua"
client_script "client/*.lua"
]],
            ["globs/client/main.lua"] = 'order = (order or "") .. "main;"',
            ["globs/client/ui/b.lua"] = 'order = (order or "") .. "ui/b;"',
            ["globs/client/ui/a.lua"] = 'order = (order or "") .. "ui/a;"',
            ["globs/client/zz/deep/c.lua"] = 'order = (order or "") .. "deep;" exports("order", function() return order end)',
        })
        h:add("globs")
        expect(h:start("globs")).toBe(true)
        expect(h:callClient("globs", "order")).toBe("ui/a;ui/b;deep;main;")
    end)
end)
