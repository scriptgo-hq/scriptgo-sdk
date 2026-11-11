-- The Lua guest prelude of the .NET kit. It runs once in each Lua state (one state per resource
-- side), builds that resource's sandbox and scheduler, and returns the entry points the host calls.
-- The semantics are the portable core's (sdk/lua/scriptgo/host.lua); whatever leaves the resource
-- goes through the host bridge (__sg.call), where the codec copies every value. See
-- docs/spec/multi-language.md.
local ctx = ...
local sg_call, sg_fresh, sg_chunk = __sg.call, __sg.fresh, __sg.chunk
__sg = nil

local load, pcall, xpcall, error, type, tostring, tonumber, select, ipairs, setmetatable, getmetatable, rawget =
    load, pcall, xpcall, error, type, tostring, tonumber, select, ipairs, setmetatable, getmetatable, rawget
local co_create, co_resume, co_status, co_yield = coroutine.create, coroutine.resume, coroutine.status, coroutine.yield
local sethook, traceback, setupvalue = debug.sethook, debug.traceback, debug.setupvalue
local pack, unpack = table.pack, table.unpack
local sort, concat, insert = table.sort, table.concat, table.insert
local str_match, str_gsub, str_lower, str_sub = string.match, string.gsub, string.lower, string.sub
local huge, max = math.huge, math.max
local os_time = os.time

-- Modules shared with the portable core (one implementation each).
local loaded = {}
local function R(name)
    local m = loaded[name]
    if m == nil then
        local f = assert(load(ctx.modules[name], "=scriptgo/" .. name, "t"))
        m = f(R)
        loaded[name] = m
    end
    return m
end
local json = R("json")

local RESOURCE, SIDE, ENVIRONMENT = ctx.resource, ctx.side, ctx.environment
local THREAD_LIMIT = ctx.threads

-- Library copies for the sandbox, taken before this state's own doors are closed.
local function copyLib(lib, names)
    if type(lib) ~= "table" then return nil end
    local out = {}
    if names then
        for _, n in ipairs(names) do out[n] = lib[n] end
    else
        for k, v in next, lib do out[k] = v end
    end
    return out
end
string.dump = nil
local libs = {
    string = copyLib(string), table = copyLib(table), math = copyLib(math), utf8 = copyLib(utf8),
    os = copyLib(os, { "time", "clock", "date", "difftime" }),
}
local collectgarbage = collectgarbage
-- Strings share one metatable per state: resources may not change it (prelude code uses it).
getmetatable("").__metatable = "string"
_G.io, _G.package, _G.debug, _G.dofile, _G.loadfile, _G.load, _G.require = nil, nil, nil, nil, nil, nil, nil
_G.os, _G.coroutine, _G.collectgarbage = nil, nil, nil

-- Instruction budget ---------------------------------------------------------------------------
-- A count hook on every coroutine that runs resource code. The state gets the full budget once per
-- host-level entry (sg_fresh() says when); nested entries in the same host entry, including calls
-- from other resources, draw on what is left. Past it, the hook raises in the resource's thread (an
-- ordinary Lua error), and pcall/xpcall below re-raise it so a script cannot swallow it. Prelude
-- code runs unhooked.
local LIMIT = ctx.instructions
local STEP = LIMIT < 100000 and 1000 or 10000
local BUDGET_ERROR = "quota_exceeded:instructions (" .. LIMIT .. " per entry)"
local budget = { used = 0, exceeded = false, reported = false }

local function hook()
    local used = budget.used + STEP
    budget.used = used
    if used > LIMIT then
        budget.exceeded = true
        error(BUDGET_ERROR, 0)
    end
end

local function newCoroutine(fn)
    local co = co_create(fn)
    sethook(co, hook, "", STEP)
    return co
end

local function errorText(e)
    local t = type(e)
    if t == "string" then return e end
    if t == "number" or t == "boolean" or t == "nil" then return tostring(e) end
    return "(error object is a " .. t .. " value)"
end

local function log(level, msg) sg_call("log", level, msg) end

-- Promises (same contract as the portable core) ----------------------------------------------------
local Promise = {}
Promise.__index = Promise
local nextPromiseId = 0
local pending = {} -- promises the host settles (export calls, HTTP), by id

local current = nil -- the thread being resumed (nil at file scope)
local env

local function newPromise()
    nextPromiseId = nextPromiseId + 1
    return setmetatable({ id = nextPromiseId, state = "pending", waiters = {} }, Promise)
end

function Promise:_settle(state, values, reason)
    if self.state == "cancelled" then return false, "promise_cancelled" end
    if self.state ~= "pending" then return false, "promise_already_settled" end
    self.state, self.values, self.reason = state, values, reason
    local result = state == "resolved" and values or { nil, reason, n = 2 }
    for _, thread in ipairs(self.waiters) do
        thread.wake = 0
        thread.waiting = nil
        thread.resumeArgs = result
    end
    self.waiters = {}
    return true
end

function Promise:resolve(...) return self:_settle("resolved", pack(...), nil) end

function Promise:reject(reason)
    if type(reason) ~= "string" then reason = "promise_rejected" end
    return self:_settle("rejected", nil, reason)
end

function Promise:status() return self.state end
function Promise:isSettled() return self.state ~= "pending" end

function Promise:await()
    if self.state == "resolved" then return unpack(self.values, 1, self.values.n) end
    if self.state == "rejected" then return nil, self.reason end
    if self.state == "cancelled" then return nil, "promise_cancelled" end
    if not current then return nil, "await_requires_scheduler_coroutine" end
    return co_yield({ await = self })
end

-- Scheduler ----------------------------------------------------------------------------------------
local threads, threadCount, nextThreadId = {}, 0, 0
local now, tickCount = ctx.now, 0
local alive = true
local resume

local function finish(thread)
    if threads[thread] then
        threads[thread] = nil
        threadCount = threadCount - 1
    end
end

-- Starts fn in a scheduler thread and runs it until its first yield (or on the next tick: deferred).
local function spawn(fn, tctx, onDone, ...)
    if not alive then return nil, "resource_stopped" end
    if threadCount >= THREAD_LIMIT then
        log("error", "quota_exceeded:threads (" .. THREAD_LIMIT .. ")")
        return nil, "quota_exceeded:threads"
    end
    nextThreadId = nextThreadId + 1
    local thread = { id = nextThreadId, wake = 0, ctx = tctx or {}, onDone = onDone, co = newCoroutine(fn) }
    threads[thread] = true
    threadCount = threadCount + 1
    if thread.ctx.deferred then
        thread.wake = now
        thread.tickSeen = tickCount
        thread.resumeArgs = pack(...)
    else
        resume(thread, pack(...))
    end
    return thread
end

resume = function(thread, args)
    local prevCurrent, prevSource = current, env.source
    current = thread
    env.source = thread.ctx.source
    local res = pack(co_resume(thread.co, unpack(args or {}, 1, args and args.n or 0)))
    current = prevCurrent
    env.source = prevSource
    if not res[1] then
        finish(thread)
        local msg = errorText(res[2])
        -- A spent budget is reported once (with the runaway's traceback), not by every thread it stops.
        if not (budget.exceeded and budget.reported) then log("error", traceback(thread.co, msg)) end
        if budget.exceeded then budget.reported = true end
        if thread.onDone then thread.onDone(false, msg) end
        return
    end
    if co_status(thread.co) == "dead" then
        finish(thread)
        if thread.onDone then thread.onDone(true, pack(unpack(res, 2, res.n))) end
        return
    end
    local req = res[2]
    if type(req) == "table" and req.await then
        thread.waiting = req.await
        thread.wake = huge
        insert(req.await.waiters, thread)
    elseif type(req) == "table" and req.wait then
        thread.wake = now + max(0, req.wait) / 1000
    else
        thread.wake = now
    end
end

function Promise:next(onResolved, onRejected)
    local promise = self
    local thread = spawn(function()
        local res = pack(promise:await())
        if res[1] == nil and type(res[2]) == "string" and promise.state ~= "resolved" then
            if onRejected then onRejected(res[2]) end
        elseif onResolved then
            onResolved(unpack(res, 1, res.n))
        end
    end, {})
    return thread and thread.id or nil
end

local function inThread(fnName)
    if not current then
        error(fnName .. " must be called from a thread (CreateThread, an event handler, an export or a command)", 3)
    end
end

-- Sandbox -----------------------------------------------------------------------------------------
local handlers, exportsTable, commands, timers, modules = {}, {}, {}, {}, {}
local nextTimerId = 0
local capabilities = {}
for _, c in ipairs(ctx.capabilities) do capabilities[c] = true end

local function unavailable(cap) return "capability_unavailable:" .. tostring(cap) .. "@" .. ENVIRONMENT end

local function joinArgs(...)
    local n = select("#", ...)
    local parts = {}
    for i = 1, n do parts[i] = tostring((select(i, ...))) end
    return concat(parts, "\t")
end

local function guardedPcall(f, ...)
    local r = pack(pcall(f, ...))
    if not r[1] and budget.exceeded then error(BUDGET_ERROR, 0) end
    return unpack(r, 1, r.n)
end

local function guardedXpcall(f, handler, ...)
    local r = pack(xpcall(f, handler, ...))
    if not r[1] and budget.exceeded then error(BUDGET_ERROR, 0) end
    return unpack(r, 1, r.n)
end

-- Finalizers would run resource code outside any budget, so __gc is not available.
local function guardedSetmetatable(t, mt)
    if type(mt) == "table" and rawget(mt, "__gc") ~= nil then
        error("setmetatable: __gc is not available to resources", 2)
    end
    return setmetatable(t, mt)
end

env = {}
for _, name in ipairs({ "assert", "error", "ipairs", "next", "pairs", "rawequal", "rawget", "rawset", "rawlen",
    "select", "getmetatable", "tonumber", "tostring", "type", "_VERSION" }) do
    env[name] = _G[name]
end
env.setmetatable = guardedSetmetatable
env.pcall = guardedPcall
env.xpcall = guardedXpcall
env.unpack = unpack
env.string = libs.string
env.table = libs.table
env.math = libs.math
env.utf8 = libs.utf8
env.os = libs.os
env.collectgarbage = function(opt)
    if opt == "count" then return collectgarbage("count") end
    error("collectgarbage: only \"count\" is available to resources", 2)
end
env._G = env

env.print = function(...) log("info", joinArgs(...)) end

-- Scheduler API
env.CreateThread = function(fn)
    if type(fn) ~= "function" then error("CreateThread(fn): fn must be a function", 2) end
    local thread, why = spawn(fn, current and { source = current.ctx.source } or {})
    if not thread and why == "quota_exceeded:threads" then error(why, 2) end
end
env.Wait = function(ms)
    inThread("Wait")
    co_yield({ wait = tonumber(ms) or 0 })
end
env.SetTimeout = function(ms, fn)
    if type(fn) ~= "function" then error("SetTimeout(ms, fn): fn must be a function", 2) end
    nextTimerId = nextTimerId + 1
    local id = nextTimerId
    timers[id] = true
    local thread, why = spawn(function()
        co_yield({ wait = tonumber(ms) or 0 })
        if timers[id] then
            timers[id] = nil
            fn()
        end
    end, {})
    if not thread and why == "quota_exceeded:threads" then error(why, 2) end
    return id
end
env.ClearTimeout = function(id) timers[id] = nil end
env.Citizen = { CreateThread = env.CreateThread, Wait = env.Wait, SetTimeout = env.SetTimeout }
env.Citizen.Await = function(p) return p:await() end
env.promise = { new = newPromise }

-- Events
local function addHandler(name, fn, isNet, level)
    if type(name) ~= "string" or type(fn) ~= "function" then
        error("AddEventHandler(name, fn): name must be a string and fn a function", level)
    end
    local ok, id = sg_call("addHandler", name, isNet)
    if not ok then error(id, level) end
    handlers[id] = fn
    return id
end
env.AddEventHandler = function(name, fn) return addHandler(name, fn, false, 3) end
env.RemoveEventHandler = function(id)
    local ok, removed = sg_call("removeHandler", id)
    handlers[id] = nil
    return ok and removed or false
end
-- OPEN//77: on the client TriggerEvent stays in the resource and runs now; on the server it is the
-- host-wide bus, queued to the next tick and delivered without `source`.
env.TriggerEvent = function(name, ...)
    if type(name) ~= "string" or name == "" or #name > 128 then return false, "invalid_event_name" end
    local ok, why = sg_call("trigger", name, ...)
    if not ok then return false, why end
    return true
end
env.RegisterNetEvent = function(name, fn)
    sg_call("registerNet", name)
    if fn then return addHandler(name, fn, true, 3) end
end
env.TriggerServerEvent = function(name, ...)
    local ok, why = sg_call("triggerServer", name, ...)
    if not ok then return false, why end
    return true
end
env.TriggerClientEvent = function(name, target, ...)
    if type(target) ~= "number" then return false, "invalid_target" end
    local ok, why = sg_call("triggerClient", name, target, ...)
    if not ok then return false, why end
    return true
end

-- Exports: exports(name, fn) registers; exports.other:name(...) is the synchronous proxy (the export
-- runs now, errors are raised as "export other:name <reason>"). File-scope calls are refused while
-- the resource is still loading: "resource_preparing".
local function registerExport(name, fn)
    if type(name) ~= "string" or name == "" or #name > 64 then return nil, "invalid_export_name" end
    if type(fn) ~= "function" then return nil, "export_function_required" end
    local ok, why = sg_call("exportRegister", name)
    if not ok then return nil, why end
    exportsTable[name] = fn
    return true
end
local proxies = {}
local function proxyFor(target)
    local p = proxies[target]
    if p then return p end
    p = setmetatable({}, {
        __index = function(_, exportName)
            return function(_, ...)
                local label = "export " .. tostring(target) .. ":" .. tostring(exportName)
                if current == nil then error(label .. " resource_preparing", 2) end
                local r = pack(sg_call("exportSync", target, exportName, ...))
                if not r[1] then error(label .. " " .. tostring(r[2]), 2) end
                return unpack(r, 2, r.n)
            end
        end,
    })
    proxies[target] = p
    return p
end
env.exports = setmetatable({}, {
    __call = function(_, name, fn) return registerExport(name, fn) end,
    __index = function(_, target) return proxyFor(target) end,
    __newindex = function() error("exports is not assignable", 2) end,
})
env.GetInvokingResource = function() return current and current.ctx.invoking or nil end

-- The provider runs the export in its own thread; it does not inherit the caller's `source`.
local function callExport(target, exportName, ...)
    if current == nil then return nil, "resource_preparing" end
    if type(target) ~= "string" or type(exportName) ~= "string" then return nil, "invalid_export_name" end
    local p = newPromise()
    pending[p.id] = p
    local ok, why = sg_call("exportAsync", p.id, target, exportName, ...)
    if not ok then
        pending[p.id] = nil
        return nil, why
    end
    return p
end

-- Commands
env.RegisterCommand = function(name, fn, restricted)
    if type(name) ~= "string" or not str_match(name, "^[%w_%-%.:]+$") or type(fn) ~= "function" then
        error("RegisterCommand(name, fn, restricted?): invalid arguments", 2)
    end
    local ok, why = sg_call("registerCommand", name, restricted and true or false)
    if not ok then error(why, 2) end
    commands[str_lower(name)] = fn
    return true
end

env.GetCurrentResourceName = function() return RESOURCE end
env.GetResourceState = function(name)
    local _, state = sg_call("resourceState", name)
    return state
end
env.GetConvar = function(name, default)
    local ok, v = sg_call("convar", name)
    if not ok or v == nil then return default end
    return v
end

-- A script the host compiles itself, straight from memory it does not want copied into this VM as
-- a string first (an escrowed resource held by the native loader). Answers the function with the
-- sandbox as its environment (what load(text, name, "t", env) does: _ENV is upvalue 1 of a main
-- chunk); false when the host does not serve that file this way; nil, message when it does not compile.
local function nativeChunk(lib, path, chunkname)
    local fn, err = sg_chunk(lib, path, chunkname)
    if fn == nil then return nil, err end
    if fn == false then return false end
    setupvalue(fn, 1, env)
    return fn
end

-- Modules: `a.b` → a/b.lua then a/b/init.lua in this resource; `@lib` / `@lib/a.b` → a declared
-- dependency's init.lua / a/b.lua. Answers the module or nil, reason (as the portable core).
local function validModule(name)
    if name == "" then return true end
    for seg in (name .. "."):gmatch("([^%.]*)%.") do
        if seg == "" or not str_match(seg, "^[%w_%-]+$") then return false end
    end
    return true
end
env.require = function(modname)
    if type(modname) ~= "string" then return nil, "invalid_module_name" end
    local cached = modules[modname]
    if cached ~= nil then return cached end
    local owner, lib, inner = RESOURCE, nil, modname
    if str_sub(modname, 1, 1) == "@" then
        local l, rest = str_match(modname, "^@([%w_%-]+)/?(.*)$")
        if not l or not validModule(rest) then return nil, "invalid_module_name" end
        owner, lib, inner = l, l, (rest ~= "" and rest or "init")
    elseif modname == "" or not validModule(modname) then
        return nil, "invalid_module_name"
    end
    local base = str_gsub(inner, "%.", "/")
    local function read(path)
        if lib then return sg_call("dependencyFile", lib, path) end
        return sg_call("resourceFile", path)
    end
    -- An escrowed resource is compiled by the host straight from native memory (nativeChunk);
    -- anything else is read as text, exactly as before.
    local fn, err
    for _, path in ipairs({ base .. ".lua", base .. "/init.lua" }) do
        local chunkname = "@" .. owner .. "/" .. path
        fn, err = nativeChunk(lib, path, chunkname)
        if fn == nil then return nil, "module_load_failed: " .. tostring(err) end
        if fn then break end
        local ok, text = read(path)
        if ok then
            fn, err = load(text, chunkname, "t", env)
            if not fn then return nil, "module_load_failed: " .. tostring(err) end
            break
        elseif text ~= "not_found" then
            return nil, text
        end
    end
    if not fn then return nil, "module_not_found:" .. modname end
    local value = fn(modname)
    if value == nil then value = true end
    modules[modname] = value
    return value
end

-- ScriptGo namespace -------------------------------------------------------------------------------
local function has(c) return capabilities[c] == true end
local SG = {}
SG.log = {
    debug = function(m) log("debug", tostring(m)) end,
    info = function(m) log("info", tostring(m)) end,
    warn = function(m) log("warn", tostring(m)) end,
    error = function(m) log("error", tostring(m)) end,
}
SG.json = { encode = json.encode, decode = json.decode, null = json.null, object = json.object }
SG.time = {
    monotonic = function() return now end,
    now = function()
        local ok, t = sg_call("time")
        if ok and t then return t end
        return os_time()
    end,
}
SG.runtime = {
    version = function() return ctx.runtimeVersion end,
    luaVersion = function() return _VERSION end,
    environment = function() return ENVIRONMENT end,
    side = function() return SIDE end,
    adapterVersion = function() return ctx.adapterVersion end,
    language = function() return "lua" end,
}
local permissionSet = {}
for _, p in ipairs(ctx.permissions) do permissionSet[p] = true end
SG.resource = {
    name = function() return RESOURCE end,
    version = function() return ctx.version end,
    generation = function(other)
        local _, g = sg_call("resourceGeneration", other)
        return g
    end,
    state = function(other)
        local _, s = sg_call("resourceState", other or RESOURCE)
        return s
    end,
    hasPermission = function(p) return permissionSet[p] == true end,
    readFile = function(rel)
        if type(rel) ~= "string" then return nil, "invalid_path" end
        local ok, data = sg_call("resourceFile", rel)
        if not ok then return nil, data end
        return data
    end,
    manifest = function()
        local ok, m = sg_call("manifest")
        return ok and m or nil
    end,
}
SG.events = { on = env.AddEventHandler, off = env.RemoveEventHandler, emit = env.TriggerEvent }
SG.net = {
    on = env.RegisterNetEvent, register = env.RegisterNetEvent,
    emitServer = env.TriggerServerEvent, emitClient = env.TriggerClientEvent,
}
SG.exports = { call = callExport }
SG.capabilities = {
    has = has,
    list = function()
        local out = {}
        for i, c in ipairs(ctx.capabilities) do out[i] = c end
        return out
    end,
    require = function(c) if not has(c) then error(unavailable(c), 2) end end,
}

local function capTable(cap, members)
    return setmetatable({}, {
        __index = function(_, k)
            if not has(cap) then error(unavailable(cap), 2) end
            return members[k]
        end,
        __newindex = function() error("ScriptGo." .. cap .. " is read-only", 2) end,
    })
end

SG.storage = capTable("storage", {
    get = function(key)
        local ok, v = sg_call("storageGet", tostring(key))
        if ok then return v end
        return nil
    end,
    set = function(key, value)
        local ok, why, detail = sg_call("storageSet", tostring(key), value)
        if ok then return true end
        return false, detail or why
    end,
    delete = function(key)
        sg_call("storageDelete", tostring(key))
        return true
    end,
    keys = function(prefix)
        local ok, list = sg_call("storageKeys", prefix)
        return ok and list or {}
    end,
})
SG.players = capTable("players", {
    list = function()
        local ok, list = sg_call("playersList")
        return ok and list or {}
    end,
    name = function(id)
        local _, n = sg_call("playerName", id)
        return n
    end,
    exists = function(id)
        local _, n = sg_call("playerName", id)
        return n ~= nil
    end,
    identifier = function(id)
        local _, v = sg_call("playerIdentifier", id)
        return v
    end,
})
SG.permissions = capTable("permissions", {
    has = function(playerId, privilege)
        local ok, v = sg_call("permissionsHas", playerId, privilege)
        return ok and v == true
    end,
})
SG.ui = capTable("ui", {
    notify = function(target, payload)
        -- A client notifies its own player: notify(payload) or notify(nil, payload).
        if SIDE == "client" then
            if payload == nil then payload = target end
            target = nil
        end
        if type(payload) ~= "table" then return false, "invalid_payload" end
        local ok, why = sg_call("uiNotify", target or -1, payload)
        if not ok then return false, why end
        return true
    end,
})
SG.config = capTable("config", {
    get = function(key, default)
        local ok, v = sg_call("configGet", key)
        if not ok or v == nil then return default end
        return v
    end,
})

local function hostRequest(op, ...)
    local p = newPromise()
    pending[p.id] = p
    local ok, why, detail = sg_call(op, p.id, ...)
    if not ok then
        pending[p.id] = nil
        if why == "codec_error" then return nil, detail end
        return nil, why
    end
    return p:await()
end
SG.http = capTable("http", {
    request = function(opts)
        inThread("ScriptGo.http.request")
        if SIDE ~= "server" then return nil, "http is server-side only" end
        if type(opts) ~= "table" then return nil, "invalid_request" end
        return hostRequest("http", opts)
    end,
})
local function licensingCall(kind, opts)
    inThread("ScriptGo.licensing")
    if SIDE ~= "server" then return nil, "licensing is server-side only" end
    if not has("http") then return nil, unavailable("http") end
    if type(opts) ~= "table" then return nil, "invalid_request" end
    return hostRequest("licensing", kind, opts)
end
SG.licensing = capTable("licensing", {
    activate = function(opts) return licensingCall("activate", opts) end,
    verify = function(opts) return licensingCall("verify", opts) end,
})
-- Player perks (ADR-0038): the portable core's module, the one implementation every host shares,
-- over what this guest already has: HTTP through the host, the host's player identifiers, the wall
-- clock and the convars (scriptgo_api, scriptgo_server_token). One client per Lua guest, created on
-- first use; its cache lives in this state's memory and is bounded as the module says.
local perksClient
local perksAnswers = {} -- promise id -> callback of a request the perks module made
local perksNextTick = 0
local function perksOf()
    if perksClient then return perksClient end
    perksClient = R("perks").new({
        request = function(req, done)
            local p = newPromise()
            pending[p.id] = p
            perksAnswers[p.id] = done
            local ok, why = sg_call("http", p.id, req)
            if not ok then
                pending[p.id], perksAnswers[p.id] = nil, nil
                done({ status = 0, body = "", error = tostring(why) })
            end
        end,
        await = function(register)
            local p = newPromise()
            register(function(...) p:resolve(...) end)
            return p:await()
        end,
        identifier = function(id)
            local _, v = sg_call("playerIdentifier", id)
            return v
        end,
        findPlayer = function(identifier)
            local ok, list = sg_call("playersList")
            if not ok or type(list) ~= "table" then return nil end
            for _, id in ipairs(list) do
                local _, v = sg_call("playerIdentifier", id)
                if v == identifier then return id end
            end
            return nil
        end,
        now = function() return SG.time.now() end,
        json = json,
        config = function(key)
            local ok, v = sg_call("convar", key)
            if ok then return v end
            return nil
        end,
        dispatch = function(fn, ...) spawn(fn, {}, nil, ...) end,
        log = function(level, message) log(level, "perks: " .. tostring(message)) end,
        environment = ENVIRONMENT,
        adapterVersion = ctx.adapterVersion,
    })
    return perksClient
end
local function perksCall(name)
    inThread("ScriptGo.perks." .. name)
    if SIDE ~= "server" then return nil end
    return perksOf()
end
SG.perks = capTable("perks", {
    has = function(player, key)
        local client = perksCall("has")
        if not client then return false, "perks is server-side only" end
        return client.has(player, key)
    end,
    list = function(player)
        local client = perksCall("list")
        if not client then return nil, "perks is server-side only" end
        return client.list(player)
    end,
    refresh = function(player)
        local client = perksCall("refresh")
        if not client then return false, "perks is server-side only" end
        return client.refresh(player)
    end,
    purchaseLink = function(player, key)
        local client = perksCall("purchaseLink")
        if not client then return nil, "perks is server-side only" end
        return client.purchaseLink(player, key)
    end,
    catalog = function()
        local client = perksCall("catalog")
        if not client then return nil, "perks is server-side only" end
        return client.catalog()
    end,
    on = function(kind, fn)
        if SIDE ~= "server" then return nil, "perks is server-side only" end
        return perksOf().on(kind, fn)
    end,
    off = function(id)
        if SIDE ~= "server" then return false end
        return perksOf().off(id)
    end,
    status = function()
        if SIDE ~= "server" then return nil, "perks is server-side only" end
        return perksOf().status()
    end,
})
-- Player match (docs/spec/player-match.md): the portable core's presence module, in the one Lua
-- resource of the host that declares the presence capability (declare it in one resource only: each
-- declaring resource reports, and registers the link command). The address comes from the host
-- (IHostPlayerAddresses, or the address given to PlayerJoin) and the HMAC from .NET's HMACSHA256; both
-- stay in the host process, only the fingerprint is sent.
local presenceClient, presenceStarted, presenceActive
local presenceNextTick = 0
local function declaresPresence()
    local ok, m = sg_call("manifest")
    if not ok or type(m) ~= "table" then return false end
    for _, list in ipairs({ m.capabilities or {}, m.optionalCapabilities or {} }) do
        for _, c in ipairs(list) do if c == "presence" then return true end end
    end
    return false
end
local function presenceOf()
    if presenceClient then return presenceClient end
    presenceClient = R("presence").new({
        request = function(req, done)
            local p = newPromise()
            pending[p.id] = p
            perksAnswers[p.id] = done
            local ok, why = sg_call("http", p.id, req)
            if not ok then
                pending[p.id], perksAnswers[p.id] = nil, nil
                done({ status = 0, body = "", error = tostring(why) })
            end
        end,
        await = function(register)
            local p = newPromise()
            register(function(...) p:resolve(...) end)
            return p:await()
        end,
        identifier = function(id)
            local _, v = sg_call("playerIdentifier", id)
            return v
        end,
        name = function(id)
            local _, v = sg_call("playerName", id)
            return v
        end,
        address = function(id)
            local _, v = sg_call("playerAddress", id)
            return v
        end,
        players = function()
            local ok, list = sg_call("playersList")
            return ok and type(list) == "table" and list or {}
        end,
        hmacSha256 = function(key, message)
            local ok, v = sg_call("hmacSha256", key, message)
            return ok and v or nil
        end,
        now = function() return SG.time.now() end,
        json = json,
        config = function(key)
            local ok, v = sg_call("convar", key)
            if ok then return v end
            return nil
        end,
        log = function(level, message) log(level, "presence: " .. tostring(message)) end,
        environment = ENVIRONMENT,
        adapterVersion = ctx.adapterVersion,
    })
    return presenceClient
end
-- Started on the first tick of a server guest that declares presence: join and leave handlers,
-- then the link command once the server is linked (scriptgo_server_token).
local function presenceStart()
    presenceStarted = true
    if SIDE ~= "server" or not has("presence") or not declaresPresence() then return end
    presenceActive = true
    local p = presenceOf()
    env.AddEventHandler("playerJoining", function() p.joined(env.source) end)
    env.AddEventHandler("playerDropped", function() p.left(env.source) end)
end
local presenceCommand
local function presenceTick()
    local p = presenceClient
    if not p or not presenceActive then return end
    p.tick()
    if presenceCommand or not has("commands") then return end
    local okTok, token = sg_call("convar", "scriptgo_server_token")
    local name = p.command()
    if not okTok or type(token) ~= "string" or token == "" or not name then return end
    presenceCommand = name
    local ok, why = pcall(env.RegisterCommand, name, function(source, args)
        local code = type(args) == "table" and args[1] or nil
        if source == 0 then
            log("info", "presence: /" .. name .. " is typed by a player, in game")
            return
        end
        local linked, reason = p.link(source, code)
        local text = p.linkMessage(linked, reason)
        if not (has("ui") and pcall(SG.ui.notify, source, { type = "info", title = "SCRIPT//GO", message = text })) then
            log("info", "presence: " .. text)
        end
    end, false)
    if not ok then log("warn", "presence: the /" .. name .. " command could not be registered: " .. tostring(why)) end
end
SG.presence = capTable("presence", {
    status = function()
        if SIDE ~= "server" then return nil, "presence is server-side only" end
        return presenceOf().status()
    end,
    link = function(player, code)
        inThread("ScriptGo.presence.link")
        if SIDE ~= "server" then return false, "presence is server-side only" end
        return presenceOf().link(player, code)
    end,
    linkMessage = function(ok, reason) return presenceOf().linkMessage(ok, reason) end,
})

-- OPEN//77-compatible names for the portable subset.
SG.notifications = {
    send = function(target, payload) return SG.ui.notify(target, payload) end,
    broadcast = function(payload) return SG.ui.notify(-1, payload) end,
}

-- Native modules the integrator registered: ScriptGo.natives.<module>.<fn>(...) answers its values
-- (true when it has none), or nil, reason.
local natives = {}
for modName, desc in next, ctx.natives do
    local m = {}
    for _, fnName in ipairs(desc.functions) do
        m[fnName] = function(...)
            local r = pack(sg_call("native", modName, fnName, ...))
            if not r[1] then
                if r[3] == nil then return nil, r[2] end
                return nil, r[2], r[3]
            end
            if r.n == 1 then return true end
            return unpack(r, 2, r.n)
        end
    end
    natives[modName] = setmetatable({}, { __index = m, __newindex = function() error("natives are read-only", 2) end })
    if desc.global then env[modName] = natives[modName] end
end
SG.natives = natives

env.ScriptGo = SG
env.Open77 = SG

-- Entry points -------------------------------------------------------------------------------------
-- Each answers true, values... or false, reason[, detail]. The outermost entry resets the budget;
-- every entry restores the scheduler context even when it fails half-way.
local depth = 0
local function enter(f)
    return function(...)
        if depth == 0 and sg_fresh() then
            budget.used = 0
            budget.exceeded = false
            budget.reported = false
        end
        -- Spent earlier in the same host-level entry: refuse at once rather than run up to a hook step.
        if budget.exceeded then return false, BUDGET_ERROR end
        depth = depth + 1
        local prevCurrent, prevSource = current, env.source
        local r = pack(xpcall(f, function(e) return traceback(errorText(e), 2) end, ...))
        current, env.source = prevCurrent, prevSource
        depth = depth - 1
        if not r[1] then return false, r[2] end
        return unpack(r, 2, r.n)
    end
end

local entry = {}

-- Runs a script at file scope (in a hooked coroutine; `current` stays nil, so Wait is refused).
local function runAtFileScope(fn)
    local co = newCoroutine(fn)
    current, env.source = nil, nil
    local res = pack(co_resume(co))
    if not res[1] then
        local msg = errorText(res[2])
        return false, str_match(msg, "^[^\n]*"), traceback(co, msg)
    end
    if co_status(co) ~= "dead" then return false, "a script cannot wait at file scope (use CreateThread)" end
    return true
end

entry.load = enter(function(source, chunkname)
    local fn, err = load(source, chunkname, "t", env)
    if not fn then return false, tostring(err), tostring(err) end
    return runAtFileScope(fn)
end)

-- The same for a script the host compiles from native memory (an escrowed resource): the source
-- never enters this VM as a string, and never was a managed one.
entry.loadNative = enter(function(path, chunkname)
    local fn, err = nativeChunk(nil, path, chunkname)
    if fn == false then return false, "native_chunk_unavailable" end
    if not fn then return false, tostring(err), tostring(err) end
    return runAtFileScope(fn)
end)

-- Declarative export: a global function of that name.
entry.publish = enter(function(name)
    local fn = rawget(env, name)
    if type(fn) ~= "function" then return true, false end
    local ok = sg_call("exportRegister", name)
    if ok then exportsTable[name] = fn end
    return true, ok and true or false
end)

entry.tick = enter(function(n, tc)
    now, tickCount = n, tc
    -- The perks client pulls its event queue about once a second; it never blocks.
    if perksClient and now >= perksNextTick then
        perksNextTick = now + 1
        perksClient.tick()
    end
    -- Player match: the same pace (the module keeps its own 30 s report cadence).
    if not presenceStarted then presenceStart() end
    if presenceActive and now >= presenceNextTick then
        presenceNextTick = now + 1
        presenceTick()
    end
    local ready = {}
    for thread in next, threads do
        if not thread.waiting and thread.wake <= now and thread.tickSeen ~= tickCount then ready[#ready + 1] = thread end
    end
    sort(ready, function(a, b) return a.id < b.id end)
    for i = 1, #ready do
        -- Past the budget, the pass stops; the other threads run on the next tick.
        if budget.exceeded or not alive then break end
        local thread = ready[i]
        if threads[thread] then
            thread.tickSeen = tickCount
            local args = thread.resumeArgs
            thread.resumeArgs = nil
            resume(thread, args)
        end
    end
    return true
end)

entry.settle = enter(function(id, ok, ...)
    local p = pending[id]
    if not p then return true end
    pending[id] = nil
    -- An answer to a request of the perks module goes to its callback, not to a waiting thread.
    local answer = perksAnswers[id]
    if answer then
        perksAnswers[id] = nil
        if ok then answer((...)) else answer({ status = 0, body = "", error = (...) }) end
        return true
    end
    if ok then p:resolve(...) else p:reject((...)) end
    return true
end)

entry.handler = enter(function(id, source, invoking, ...)
    local fn = handlers[id]
    if fn then spawn(fn, { source = source, invoking = invoking }, nil, ...) end
    return true
end)

-- A synchronous export runs in a fresh coroutine and must finish without waiting.
entry.exportSync = enter(function(name, invoking, ...)
    local fn = exportsTable[name]
    if not fn then return false, "export_not_found" end
    local thread = { id = 0, ctx = { invoking = invoking }, co = newCoroutine(fn) }
    current, env.source = thread, nil
    local res = pack(co_resume(thread.co, ...))
    if not res[1] then
        local msg = errorText(res[2])
        -- The caller gets the error; a spent budget is also this resource's to report.
        if budget.exceeded and not budget.reported then
            budget.reported = true
            log("error", traceback(thread.co, msg))
        end
        return false, msg
    end
    if co_status(thread.co) ~= "dead" then return false, "export_yielded" end
    return true, unpack(res, 2, res.n)
end)

entry.exportAsync = enter(function(callId, name, invoking, ...)
    local fn = exportsTable[name]
    if not fn then
        sg_call("asyncDone", callId, false, "export_not_found")
        return true
    end
    local thread, why = spawn(fn, { invoking = invoking }, function(ok, result)
        if not ok then
            sg_call("asyncDone", callId, false, "export_failed: " .. tostring(result))
            return
        end
        local sent, reason = sg_call("asyncDone", callId, true, unpack(result, 1, result.n))
        if not sent then sg_call("asyncDone", callId, false, reason) end
    end, ...)
    if not thread then sg_call("asyncDone", callId, false, why or "resource_stopped") end
    return true
end)

entry.command = enter(function(name, source, raw, ...)
    local fn = commands[name]
    if fn then spawn(fn, { source = source, deferred = true }, nil, source, pack(...), raw) end
    return true
end)

entry.stats = enter(function() return true, threadCount, collectgarbage("count") end)

return entry
