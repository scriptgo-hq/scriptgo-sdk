-- The SCRIPT//GO host: loads resources (scriptgo.lua / open77.lua), runs each resource side in its
-- own sandbox with a coroutine scheduler, routes events, exports, commands and storage, and asks
-- the adapter for everything that depends on the engine. See docs/spec/runtime.md.
local R = ...
local compat = R("compat")
local json = R("json")
local codec = R("codec")
local manifest = R("manifest")
local semver = R("semver")
local caps = R("capabilities")

local unpack, pack = compat.unpack, compat.pack

local M = {}
M.VERSION = "0.1.0"

local Host = {}
Host.__index = Host

-- Promise ---------------------------------------------------------------------------------------
-- Same contract as Open77.Promise (server flavour): resolve(...) keeps every value, await() returns
-- them or nil, reason; await outside a scheduler thread answers nil, "await_requires_scheduler_coroutine".
local Promise = {}
Promise.__index = Promise

local function newPromise(host)
    return setmetatable({ state = "pending", waiters = {}, host = host }, Promise)
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

function Promise:await()
    if self.state == "resolved" then return unpack(self.values, 1, self.values.n) end
    if self.state == "rejected" then return nil, self.reason end
    if self.state == "cancelled" then return nil, "promise_cancelled" end
    local side = self.host.currentSide
    if not (side and side.current) then return nil, "await_requires_scheduler_coroutine" end
    return coroutine.yield({ await = self })
end

-- Schedules a continuation; returns its task id (not a new promise, as in Open77).
function Promise:next(onResolved, onRejected)
    local side = self.host.currentSide
    if not side then return nil, "next_requires_resource" end
    local promise = self
    local thread = side:spawn(function()
        local res = pack(promise:await())
        if res[1] == nil and type(res[2]) == "string" and promise.state ~= "resolved" then
            if onRejected then onRejected(res[2]) end
        elseif onResolved then
            onResolved(unpack(res, 1, res.n))
        end
    end, {})
    return thread and thread.id or nil
end

function Promise:isSettled() return self.state ~= "pending" end

M.newPromise = newPromise

-- Utilities -------------------------------------------------------------------------------------
local function shallowCopyList(t)
    local out = {}
    for i, v in ipairs(t or {}) do out[i] = v end
    return out
end

local function joinArgs(...)
    local n = select("#", ...)
    local parts = {}
    for i = 1, n do parts[i] = tostring((select(i, ...))) end
    return table.concat(parts, "\t")
end

local function traceback(msg)
    if type(debug) == "table" and debug.traceback then
        return debug.traceback(tostring(msg), 2)
    end
    return tostring(msg)
end

-- Sandbox ---------------------------------------------------------------------------------------
local SAFE_GLOBALS = {
    "assert", "error", "ipairs", "next", "pairs", "rawequal", "rawget", "rawset", "select",
    "setmetatable", "getmetatable", "tonumber", "tostring", "type", "unpack", "_VERSION",
}

local function copyLib(lib, names)
    if type(lib) ~= "table" then return nil end
    local out = {}
    if names then
        for _, n in ipairs(names) do out[n] = lib[n] end
    else
        for k, v in pairs(lib) do out[k] = v end
    end
    return out
end

local function buildBaseEnv()
    local env = {}
    for _, name in ipairs(SAFE_GLOBALS) do env[name] = rawget(_G, name) end
    env.rawlen = rawget(_G, "rawlen")
    env.unpack = compat.unpack
    env.pcall = compat.pcall
    env.xpcall = compat.xpcall
    env.string = copyLib(string)
    env.table = copyLib(table)
    env.table.unpack = compat.unpack
    env.math = copyLib(math)
    env.utf8 = copyLib(rawget(_G, "utf8"))
    env.bit = copyLib(rawget(_G, "bit"))
    env.os = copyLib(os, { "time", "clock", "date", "difftime" })
    env.collectgarbage = function(opt)
        if opt == "count" then return collectgarbage("count") end
        error("collectgarbage: only \"count\" is available to resources", 2)
    end
    env._G = env
    return env
end

-- Side runtime ------------------------------------------------------------------------------------
-- One per (resource, side): its own environment, threads, handlers, exports and modules.
local Side = {}
Side.__index = Side

local function newSide(host, res, sideName)
    local side = setmetatable({
        host = host, res = res, name = sideName,
        threads = {}, handlers = {}, handlerById = {}, netEvents = {}, exports = {}, modules = {},
        timers = {}, nextId = 0, current = nil, alive = true,
    }, Side)
    side.env = host:_buildEnv(side)
    return side
end

function Side:_id()
    self.nextId = self.nextId + 1
    return self.nextId
end

function Side:log(level, msg)
    self.host:_log(level, self.res.name .. ":" .. self.name, msg)
end

-- Starts fn in a scheduler-owned coroutine and runs it until its first yield.
function Side:spawn(fn, ctx, onDone, ...)
    if not self.alive then return nil end
    local thread = { id = self:_id(), wake = 0, ctx = ctx or {}, onDone = onDone }
    thread.co = coroutine.create(fn)
    self.threads[thread] = true
    if thread.ctx.deferred then
        -- Starts on the next scheduler tick instead of inline (commands, as in Open77).
        thread.wake = self.host.now
        thread.resumeArgs = pack(...)
    else
        self:_resume(thread, pack(...))
    end
    return thread
end

function Side:_resume(thread, args)
    local host = self.host
    local prevSide, prevThread = host.currentSide, self.current
    local env = self.env
    local prevSource, prevInvoking = env.source, self.invoking
    host.currentSide, self.current = self, thread
    env.source = thread.ctx.source
    self.invoking = thread.ctx.invoking
    host:_armBudget(thread.co)
    local res = pack(coroutine.resume(thread.co, unpack(args or {}, 1, args and args.n or 0)))
    host:_disarmBudget(thread.co)
    host.currentSide, self.current = prevSide, prevThread
    env.source = prevSource
    self.invoking = prevInvoking

    if not res[1] then
        self.threads[thread] = nil
        local msg = tostring(res[2])
        if type(debug) == "table" and debug.traceback then msg = debug.traceback(thread.co, msg) end
        self:log("error", msg)
        if thread.onDone then thread.onDone(false, tostring(res[2])) end
        return
    end
    if coroutine.status(thread.co) == "dead" then
        self.threads[thread] = nil
        if thread.onDone then thread.onDone(true, pack(unpack(res, 2, res.n))) end
        return
    end
    local req = res[2]
    if type(req) == "table" and req.await then
        thread.waiting = req.await
        thread.wake = math.huge
        table.insert(req.await.waiters, thread)
    elseif type(req) == "table" and req.wait then
        thread.wake = host.now + math.max(0, req.wait) / 1000
        thread.waitZero = (req.wait <= 0)
    else
        -- A bare yield (e.g. from an adapter) resumes on the next tick.
        thread.wake = host.now
    end
end

function Side:tick(now)
    local ready = {}
    for thread in pairs(self.threads) do
        if not thread.waiting and thread.wake <= now and thread.tickSeen ~= self.host.tickCount then
            ready[#ready + 1] = thread
        end
    end
    table.sort(ready, function(a, b) return a.id < b.id end)
    for _, thread in ipairs(ready) do
        if self.threads[thread] then
            thread.tickSeen = self.host.tickCount
            local args = thread.resumeArgs
            thread.resumeArgs = nil
            self:_resume(thread, args)
        end
    end
end

function Side:addHandler(name, fn, isNet)
    if type(name) ~= "string" or type(fn) ~= "function" then
        error("AddEventHandler(name, fn): name must be a string and fn a function", 3)
    end
    local list = self.handlers[name]
    if not list then list = {}; self.handlers[name] = list end
    local handle = { side = self, name = name, id = self:_id(), fn = fn }
    list[#list + 1] = handle
    self.handlerById[handle.id] = handle
    if isNet then self.netEvents[name] = true end
    return handle.id
end

-- Takes the handler id returned by AddEventHandler (Open77 passes the id alone, not the name).
function Side:removeHandler(id)
    local handle = self.handlerById[id]
    if not handle then return false end
    self.handlerById[id] = nil
    local list = self.handlers[handle.name]
    if not list then return false end
    for i, h in ipairs(list) do
        if h == handle then table.remove(list, i); return true end
    end
    return false
end

-- Runs every handler of `name` on this side, each in its own thread. Args are already copied.
function Side:dispatch(name, args, ctx, netOnly)
    if not self.alive then return 0 end
    if netOnly and not self.netEvents[name] then return 0 end
    local list = self.handlers[name]
    if not list then return 0 end
    local snapshot = shallowCopyList(list)
    for _, h in ipairs(snapshot) do
        self:spawn(h.fn, ctx, nil, unpack(args, 1, args.n))
    end
    return #snapshot
end

function Side:kill()
    self.alive = false
    self.threads = {}
    self.handlers = {}
    self.handlerById = {}
    self.netEvents = {}
    self.exports = {}
end

-- Host ----------------------------------------------------------------------------------------------
function M.new(opts)
    assert(type(opts) == "table" and type(opts.adapter) == "table", "scriptgo.host.new{ adapter = ... } is required")
    local adapter = opts.adapter
    local self = setmetatable({
        adapter = adapter,
        environment = opts.environment or adapter.environment or "standalone",
        sides = opts.sides or adapter.sides or { server = true, client = true },
        resources = {}, order = {},
        players = {}, localPlayer = opts.localPlayer,
        commands = {},
        queue = {},
        now = 0, tickCount = 0,
        storageCache = {},
        budgetMs = opts.budgetMs or adapter.budgetMs,
        logs = {},
    }, Host)
    self.capabilities = {}
    for _, c in ipairs(caps.ALL) do
        self.capabilities[c] = adapter.capabilities and adapter.capabilities[c] and true or false
    end
    self.capabilities.events = true
    self.capabilities.logging = true
    self.now = self:_clock()
    return self
end

function Host:_clock()
    if self.adapter.now then return self.adapter.now() end
    return os.clock()
end

function Host:_log(level, origin, msg)
    local entry = { level = level, origin = origin, message = msg, at = self.now }
    self.logs[#self.logs + 1] = entry
    if #self.logs > 2000 then table.remove(self.logs, 1) end
    if self.adapter.log then self.adapter.log(level, origin, msg) end
end

function Host:log(level, msg) self:_log(level, "host", msg) end

-- Execution budget (where debug.sethook exists): a runaway resume raises instead of freezing the host.
function Host:_armBudget(co)
    if not self.budgetMs or type(debug) ~= "table" or not debug.sethook then return end
    local deadline = os.clock() + self.budgetMs / 1000
    debug.sethook(co, function()
        if os.clock() > deadline then
            error("script execution budget exceeded (" .. self.budgetMs .. " ms)", 2)
        end
    end, "", 10000)
end

function Host:_disarmBudget(co)
    if not self.budgetMs or type(debug) ~= "table" or not debug.sethook then return end
    if coroutine.status(co) ~= "dead" then debug.sethook(co) end
end

function Host:hasCapability(c) return self.capabilities[c] == true end

function Host:_requireCap(c)
    if not self.capabilities[c] then error(caps.unavailable(c, self.environment), 3) end
end

-- Resource loading ------------------------------------------------------------------------------------
function Host:_read(path)
    local read = self.adapter.readFile
    if not read then return nil, "adapter has no readFile" end
    return read(path)
end

-- Adds a resource from a folder. Returns the resource record or nil, reason.
function Host:addResource(root, opts)
    opts = opts or {}
    root = root:gsub("[/\\]+$", "")
    local source, fileName = self:_read(root .. "/scriptgo.lua"), "scriptgo.lua"
    if not source then
        source, fileName = self:_read(root .. "/open77.lua"), "open77.lua"
    end
    if not source then return nil, "no scriptgo.lua or open77.lua in " .. root end
    local parsed = manifest.parse(source, fileName)
    if not parsed.ok then
        local msgs = {}
        for _, e in ipairs(parsed.errors) do msgs[#msgs + 1] = e.code .. ": " .. e.message end
        return nil, "invalid manifest in " .. root .. ": " .. table.concat(msgs, "; ")
    end
    local m = parsed.manifest
    local folder = root:match("([^/\\]+)$")
    if opts.checkFolderName ~= false and folder ~= m.name then
        return nil, "resource name '" .. m.name .. "' must match its folder '" .. tostring(folder) .. "'"
    end
    if self.resources[m.name] then return nil, "resource '" .. m.name .. "' is already loaded" end
    local res = { name = m.name, manifest = m, root = root, state = "stopped", generation = 0, sides = {}, warnings = parsed.warnings }
    self.resources[m.name] = res
    self.order[#self.order + 1] = m.name
    return res
end

function Host:getResource(name) return self.resources[name] end

function Host:resourceState(name)
    local r = self.resources[name]
    return r and r.state or "missing"
end

local function sideHasCode(m, sideName, environment)
    if #m.sharedScripts > 0 then return true end
    if sideName == "server" and #m.serverScripts > 0 then return true end
    if sideName == "client" and #m.clientScripts > 0 then return true end
    return false
end

function Host:_runScript(side, rel)
    local res = side.res
    local text, err = self:_read(res.root .. "/" .. rel)
    if not text then error("cannot read " .. rel .. ": " .. tostring(err), 0) end
    local fn, cerr = compat.loadWithEnv(text, "@" .. res.name .. "/" .. rel, side.env)
    if not fn then error(cerr, 0) end
    -- As in Open77, script load is not a scheduler task: Wait/await belong in CreateThread.
    local prevSide, prevThread = self.currentSide, side.current
    self.currentSide, side.current = side, nil
    side.env.source = nil
    local ok, perr = xpcall(fn, function(e)
        if type(debug) == "table" and debug.traceback then return debug.traceback(tostring(e), 2) end
        return tostring(e)
    end)
    self.currentSide, side.current = prevSide, prevThread
    if not ok then
        side:log("error", perr)
        error(rel .. ": " .. tostring(perr):match("^[^\n]*"), 0)
    end
end

-- Starts a resource and its dependencies. Returns true or false, reason.
function Host:start(name, visiting)
    local res = self.resources[name]
    if not res then return false, "missing" end
    if res.state == "started" then return true end
    visiting = visiting or {}
    if visiting[name] then return false, "dependency cycle through " .. name end
    visiting[name] = true
    local m = res.manifest
    for _, dep in ipairs(m.dependencies) do
        local d = self.resources[dep.name]
        if not d then
            res.state, res.failure = "failed", "missing dependency " .. dep.name
            self:log("error", name .. ": " .. res.failure)
            return false, res.failure
        end
        if dep.range and not semver.satisfies(d.manifest.version, dep.range) then
            res.state, res.failure = "failed", "dependency " .. dep.name .. " " .. d.manifest.version .. " does not satisfy " .. dep.range
            self:log("error", name .. ": " .. res.failure)
            return false, res.failure
        end
        local ok, why = self:start(dep.name, visiting)
        if not ok then
            res.state, res.failure = "failed", "dependency " .. dep.name .. " failed: " .. tostring(why)
            self:log("error", name .. ": " .. res.failure)
            return false, res.failure
        end
    end
    if m.scriptgoVersion and not semver.satisfies(M.VERSION, m.scriptgoVersion) then
        res.state, res.failure = "failed", "requires scriptgo " .. m.scriptgoVersion .. ", host is " .. M.VERSION
        self:log("error", name .. ": " .. res.failure)
        return false, res.failure
    end
    for _, c in ipairs(m.capabilities) do
        if not self.capabilities[c] then
            res.state, res.failure = "failed", caps.unavailable(c, self.environment)
            self:log("error", name .. ": " .. res.failure)
            return false, res.failure
        end
    end
    if #m.environments > 0 then
        local declared = false
        for _, e in ipairs(m.environments) do if e == self.environment then declared = true end end
        if not declared then self:log("warn", name .. ": environment_undeclared (" .. self.environment .. ")") end
    end

    res.state = "starting"
    res.generation = res.generation + 1
    res.sides = {}
    local order = { "server", "client" }
    for _, sideName in ipairs(order) do
        if self.sides[sideName] and sideHasCode(m, sideName, self.environment) then
            res.sides[sideName] = newSide(self, res, sideName)
        end
    end
    local function fail(why)
        for _, s in pairs(res.sides) do s:kill() end
        self:_dropCommands(name)
        res.sides = {}
        res.state, res.failure = "failed", why
        self:log("error", name .. ": " .. why)
        return false, why
    end
    for _, sideName in ipairs(order) do
        local side = res.sides[sideName]
        if side then
            local entries = shallowCopyList(m.sharedScripts)
            for _, p in ipairs(sideName == "server" and m.serverScripts or m.clientScripts) do entries[#entries + 1] = p end
            for _, p in ipairs(m.environmentScripts[self.environment] or {}) do entries[#entries + 1] = p end
            -- Script globs (allowed by OPEN//77) expand against the adapter's file listing.
            local scripts, listing = {}, nil
            for _, p in ipairs(entries) do
                if manifest.isGlob(p) then
                    if not listing then
                        if not self.adapter.listFiles then return fail("script_glob_needs_file_listing:" .. p) end
                        listing = self.adapter.listFiles(res.root) or {}
                    end
                    for _, f in ipairs(manifest.expandGlob(p, listing)) do scripts[#scripts + 1] = f end
                else
                    scripts[#scripts + 1] = p
                end
            end
            for _, rel in ipairs(scripts) do
                local ok, err = pcall(self._runScript, self, side, rel)
                if not ok then return fail(tostring(err)) end
            end
            -- Declarative exports (OPEN//77): names of global functions, published after the last
            -- script of the side ran; a missing one fails the start.
            for _, exportName in ipairs(sideName == "server" and m.serverExports or m.exports) do
                local fn = rawget(side.env, exportName)
                if type(fn) ~= "function" then return fail("manifest_export_missing:" .. exportName) end
                side.exports[exportName] = fn
            end
        end
    end
    res.state = "started"
    res.failure = nil
    self:log("info", "started " .. name .. " " .. m.version)
    self:broadcast("server", "onResourceStart", name)
    self:broadcast("client", "onClientResourceStart", name)
    return true
end

function Host:stop(name, reason)
    local res = self.resources[name]
    if not res or res.state ~= "started" then return false end
    -- Stop dependents first.
    for _, other in ipairs(self.order) do
        local r = self.resources[other]
        if r.state == "started" then
            for _, dep in ipairs(r.manifest.dependencies) do
                if dep.name == name then self:stop(other, "dependency_stopped") end
            end
        end
    end
    self:broadcast("server", "onResourceStop", name, reason or "stopped")
    self:broadcast("client", "onClientResourceStop", name, reason or "stopped")
    for _, s in pairs(res.sides) do s:kill() end
    res.sides = {}
    self:_dropCommands(name)
    res.state = "stopped"
    self:log("info", "stopped " .. name)
    return true
end

function Host:startAll()
    local results = {}
    for _, name in ipairs(self.order) do
        local res = self.resources[name]
        if res.manifest.autoStart and res.state ~= "started" and res.state ~= "failed" then
            local ok, why = self:start(name)
            results[name] = ok and "started" or why
        end
    end
    return results
end

function Host:stopAll()
    for i = #self.order, 1, -1 do self:stop(self.order[i], "host_shutdown") end
end

-- Events -----------------------------------------------------------------------------------------------
-- Host events (lifecycle, players, adapter events) reach every started resource on that side.
function Host:broadcast(sideName, name, ...)
    self:_fanout(sideName, name, {}, ...)
end

-- Resource names in name order: the order Open77 fans the server bus out in.
function Host:_byName()
    local names = {}
    for _, n in ipairs(self.order) do names[#names + 1] = n end
    table.sort(names)
    return names
end

-- Queued deliveries, drained at the next tick boundary (never re-entrant).
-- kind "net": network event to the `target` side of every started resource, registered names only.
-- kind "bus": server TriggerEvent, to every started server side; `source` is not propagated.
function Host:_queue(kind, target, name, args, ctx)
    if #self.queue >= 4096 then return false, "event_queue_limit" end
    self.queue[#self.queue + 1] = { kind = kind, target = target, name = name, args = args, ctx = ctx or {} }
    return true
end

function Host:_drain()
    local queue = self.queue
    self.queue = {}
    local names = self:_byName()
    for _, msg in ipairs(queue) do
        for _, rname in ipairs(names) do
            local r = self.resources[rname]
            local side = r and r.state == "started" and r.sides[msg.target]
            if side then side:dispatch(msg.name, msg.args, msg.ctx, msg.kind == "net") end
        end
    end
end

-- Dispatches immediately to every started resource on a side, with an optional source.
function Host:_fanout(sideName, name, ctx, ...)
    local args = codec.copyArgs(...)
    if not args then return end
    for _, rname in ipairs(self:_byName()) do
        local r = self.resources[rname]
        local side = r.sides[sideName]
        if side and (r.state == "started" or r.state == "starting") then side:dispatch(name, args, ctx or {}) end
    end
end

-- Players ----------------------------------------------------------------------------------------------
-- Same events as Open77: playerJoining(oldId) and playerDropped(reason) carry the player in `source`;
-- onPlayerConnected(playerId) and onPlayerDisconnected(playerId, reason) carry it as an argument.
function Host:playerJoin(id, name)
    self.players[id] = { id = id, name = name or ("Player " .. tostring(id)) }
    self:_fanout("server", "playerJoining", { source = id }, id)
    self:_fanout("server", "onPlayerConnected", {}, id)
end

function Host:playerDrop(id, reason)
    if not self.players[id] then return end
    reason = reason or "disconnected"
    self:_fanout("server", "playerDropped", { source = id }, reason)
    self:_fanout("server", "onPlayerDisconnected", {}, id, reason)
    self.players[id] = nil
end

function Host:playerList()
    if self.adapter.players and self.adapter.players.list then return self.adapter.players.list() end
    local ids = {}
    for id in pairs(self.players) do ids[#ids + 1] = id end
    table.sort(ids)
    return ids
end

-- A stable identifier for a player (for storage keys). Adapters map it to the engine's account id.
function Host:playerIdentifier(id)
    if self.adapter.players and self.adapter.players.identifier then return self.adapter.players.identifier(id) end
    local p = self.players[id]
    if not p then return nil end
    return "local:" .. tostring(p.name):lower():gsub("[^%w_%-]", "_")
end

function Host:playerName(id)
    if self.adapter.players and self.adapter.players.name then return self.adapter.players.name(id) end
    local p = self.players[id]
    return p and p.name or nil
end

-- Commands ---------------------------------------------------------------------------------------------
function Host:_dropCommands(resName)
    for name, list in pairs(self.commands) do
        for i = #list, 1, -1 do
            if list[i].side.res.name == resName then table.remove(list, i) end
        end
        if #list == 0 then self.commands[name] = nil end
    end
end

function Host:commandList()
    local names = {}
    for name in pairs(self.commands) do names[#names + 1] = name end
    table.sort(names)
    return names
end

-- Executes a command line as `source` (0 = console). Returns true or false, reason.
-- Same contract as Open77: names are case-insensitive, the handler gets (source, args, raw) with
-- string args and args.n, raw has no leading "/", and it runs on the next scheduler tick.
-- A player's line reaches a client command of that name first (local chat), then the server's.
function Host:executeCommand(source, line)
    local name, rest = line:match("^%s*/?(%S+)%s*(.-)%s*$")
    if not name then return false, "empty_command" end
    name = name:lower()
    local list = self.commands[name]
    if not list or #list == 0 then return false, "unknown_command:" .. name end
    local entry
    if source ~= 0 then
        for _, e in ipairs(list) do if e.side.name == "client" then entry = e end end
    end
    if not entry then
        for _, e in ipairs(list) do if e.side.name == "server" then entry = e end end
    end
    if not entry then return false, "unknown_command:" .. name end
    if entry.restricted and source ~= 0 then
        local allowed = self.adapter.permissions and self.adapter.permissions.has
            and self.adapter.permissions.has(source, "command." .. name)
        if not allowed then return false, "not_allowed" end
    end
    local args = { n = 0 }
    for word in rest:gmatch("%S+") do
        args.n = args.n + 1
        args[args.n] = word
    end
    local raw = name
    if args.n > 0 then raw = name .. " " .. table.concat(args, " ", 1, args.n) end
    entry.side:spawn(entry.fn, { source = source, deferred = true }, nil, source, args, raw)
    return true
end

-- Storage ----------------------------------------------------------------------------------------------
function Host:_storageKey(side)
    return side.name == "client" and (side.res.name .. ".client") or side.res.name
end

function Host:_storageLoad(side)
    local key = self:_storageKey(side)
    local cached = self.storageCache[key]
    if cached then return cached end
    local data = {}
    local st = self.adapter.storage
    if st and st.load then
        local text = st.load(key)
        if type(text) == "string" and text ~= "" then
            local ok, decoded = pcall(json.decode, text)
            if ok and type(decoded) == "table" then data = decoded
            else self:log("warn", "storage for " .. key .. " is unreadable and was reset") end
        end
    end
    self.storageCache[key] = data
    return data
end

function Host:_storageSave(side)
    local key = self:_storageKey(side)
    local st = self.adapter.storage
    if st and st.save then st.save(key, json.encode(json.object(self.storageCache[key] or {}))) end
end

-- HTTP -----------------------------------------------------------------------------------------------
-- Performs an HTTP request through the adapter and waits for it from the calling thread.
function Host:httpRequest(opts)
    local http = self.adapter.http
    if not http or not http.request then return nil, caps.unavailable("http", self.environment) end
    local promise = newPromise(self)
    local ok, err = pcall(http.request, opts, function(response)
        promise:resolve(response)
    end)
    if not ok then return nil, tostring(err) end
    local response, perr = promise:await()
    if not response then return nil, perr end
    return response
end

-- Tick -------------------------------------------------------------------------------------------------
function Host:tick(now)
    self.now = now or self:_clock()
    self.tickCount = self.tickCount + 1
    self:_drain()
    for _, rname in ipairs(self.order) do
        local r = self.resources[rname]
        for _, sideName in ipairs({ "server", "client" }) do
            local side = r.sides[sideName]
            if side and side.alive then side:tick(self.now) end
        end
    end
end

-- Runs ticks until nothing is ready to run or `maxMs` of simulated time passes (tests, CLI).
function Host:runFor(ms, stepMs)
    stepMs = stepMs or 10
    local target = self.now + ms / 1000
    while self.now < target do
        self:tick(self.now + stepMs / 1000)
    end
end

-- Environment for one side ----------------------------------------------------------------------------
function Host:_buildEnv(side)
    local host = self
    local res = side.res
    local env = buildBaseEnv()
    local environment = self.environment

    local function inThread(fnName)
        if host.currentSide ~= side or not side.current then
            error(fnName .. " must be called from a thread (CreateThread, an event handler, an export or a command)", 3)
        end
    end

    env.print = function(...) side:log("info", joinArgs(...)) end

    -- Scheduler
    env.CreateThread = function(fn)
        if type(fn) ~= "function" then error("CreateThread(fn): fn must be a function", 2) end
        local parent = side.current
        side:spawn(fn, parent and { source = parent.ctx.source } or {})
    end
    env.Wait = function(ms)
        inThread("Wait")
        coroutine.yield({ wait = tonumber(ms) or 0 })
    end
    env.SetTimeout = function(ms, fn)
        if type(fn) ~= "function" then error("SetTimeout(ms, fn): fn must be a function", 2) end
        local id = side:_id()
        side.timers[id] = true
        side:spawn(function()
            coroutine.yield({ wait = tonumber(ms) or 0 })
            if side.timers[id] then
                side.timers[id] = nil
                fn()
            end
        end, {})
        return id
    end
    env.ClearTimeout = function(id) side.timers[id] = nil end
    env.Citizen = { CreateThread = env.CreateThread, Wait = env.Wait, SetTimeout = env.SetTimeout }

    -- Events
    env.AddEventHandler = function(name, fn) return side:addHandler(name, fn, false) end
    env.RemoveEventHandler = function(handle) return side:removeHandler(handle) end
    -- Open77 semantics: on the client TriggerEvent stays in this resource's VM and runs now; on the
    -- server it is the host-wide bus, queued to the next tick and delivered without `source`.
    env.TriggerEvent = function(name, ...)
        if type(name) ~= "string" or name == "" or #name > 128 then return false, "invalid_event_name" end
        local args, why = codec.copyArgs(...)
        if not args then return false, "event_payload_not_serializable" end
        if side.name == "server" then return host:_queue("bus", "server", name, args, {}) end
        side:dispatch(name, args, {})
        return true
    end
    env.RegisterNetEvent = function(name, fn)
        side.netEvents[name] = true
        if fn then return side:addHandler(name, fn, true) end
    end
    local function localPlayerId() return host.localPlayer and host.localPlayer.id or 1 end
    env.TriggerServerEvent = function(name, ...)
        if side.name ~= "client" then return false, "client_only" end
        if not host.sides.server then return false, "network_unavailable" end
        local args = codec.copyArgs(...)
        if not args then return false, "event_payload_not_serializable" end
        return host:_queue("net", "server", name, args, { source = localPlayerId() })
    end
    env.TriggerClientEvent = function(name, target, ...)
        if side.name ~= "server" then return false, "server_only" end
        if type(target) ~= "number" or (target < 1 and target ~= -1) then return false, "invalid_target" end
        if not host.sides.client then return false, "network_unavailable" end
        local args = codec.copyArgs(...)
        if not args then return false, "event_payload_not_serializable" end
        -- Single-process hosts have one local client; other targets are simply not connected.
        if target == -1 or target == localPlayerId() then return host:_queue("net", "client", name, args, {}) end
        return true
    end

    -- Exports
    local exportsFn = function(name, fn)
        if type(name) ~= "string" or name == "" or #name > 64 then return nil, "invalid_export_name" end
        if type(fn) ~= "function" then return nil, "export_function_required" end
        side.exports[name] = fn
        return true
    end
    -- exports(name, fn) registers; exports.other:name(...) is Open77's synchronous proxy: the export
    -- runs inline and errors are raised as "export other:name <reason>" (FiveM behaviour).
    -- Like Open77, a resource cannot call exports from file scope while its own scripts are still
    -- loading: "resource_preparing". Calls belong in CreateThread, handlers or onResourceStart.
    local function syncProxy(target)
        return setmetatable({}, {
            __index = function(_, exportName)
                return function(_, ...)
                    if res.state == "starting" and side.current == nil then error("export " .. target .. ":" .. exportName .. " resource_preparing", 2) end
                    local tr = host.resources[target]
                    local tside = tr and tr.state == "started" and tr.sides[side.name]
                    if not tside then error("export " .. target .. ":" .. exportName .. " export_resource_unavailable", 2) end
                    local fn = tside.exports[exportName]
                    if not fn then error("export " .. target .. ":" .. exportName .. " export_not_found", 2) end
                    local args = codec.copyArgs(...)
                    if not args then error("export " .. target .. ":" .. exportName .. " export_arguments_not_serializable", 2) end
                    local prevInvoking = tside.invoking
                    tside.invoking = res.name
                    local out = pack(pcall(fn, unpack(args, 1, args.n)))
                    tside.invoking = prevInvoking
                    if not out[1] then error("export " .. target .. ":" .. exportName .. " " .. tostring(out[2]), 2) end
                    local copied = { n = out.n - 1 }
                    for i = 2, out.n do
                        local ok, v = codec.copy(out[i])
                        if not ok then error("export " .. target .. ":" .. exportName .. " export_result_not_serializable", 2) end
                        copied[i - 1] = v
                    end
                    return unpack(copied, 1, copied.n)
                end
            end,
        })
    end
    env.exports = setmetatable({}, {
        __call = function(_, name, fn) return exportsFn(name, fn) end,
        __index = function(_, target) return syncProxy(target) end,
        __newindex = function() error("exports is not assignable", 2) end,
    })
    env.GetInvokingResource = function() return side.invoking end

    -- The provider runs the export in its own thread; it does not inherit the caller's `source`.
    local function callExport(target, exportName, ...)
        if res.state == "starting" and side.current == nil then return nil, "resource_preparing" end
        return host:_callExport(res.name, side.name, target, exportName, ...)
    end
    env.promise = { new = function() return newPromise(host) end }
    env.Citizen.Await = function(p) return p:await() end

    -- Commands
    env.RegisterCommand = function(name, fn, restricted)
        if type(name) ~= "string" or not name:match("^[%w_%-%.:]+$") or type(fn) ~= "function" then
            error("RegisterCommand(name, fn, restricted?): invalid arguments", 2)
        end
        host:_requireCap("commands")
        local key = name:lower()
        local list = host.commands[key] or {}
        for _, e in ipairs(list) do
            if e.side.name == side.name then error("duplicate command '" .. key .. "'", 2) end
        end
        host.commands[key] = list
        list[#list + 1] = { side = side, fn = fn, restricted = restricted and true or false }
        return true
    end

    env.GetCurrentResourceName = function() return res.name end
    env.GetResourceState = function(name) return host:resourceState(name) end
    env.GetConvar = function(name, default)
        local cfg = host.adapter.config
        local v = cfg and cfg.get and cfg.get(nil, name)
        if v == nil then return default end
        return v
    end

    -- Modules, as Open77's client `require`: `a.b` → a/b.lua then a/b/init.lua in this resource;
    -- `@lib` / `@lib/a.b` → a declared dependency's init.lua / a/b.lua. Answers module or nil, reason.
    -- (Open77 has no server-side require: portable server code shares code through shared_script.)
    local function validModule(name)
        if name == "" then return true end
        for seg in (name .. "."):gmatch("([^%.]*)%.") do
            if seg == "" or not seg:match("^[%w_%-]+$") then return false end
        end
        return true
    end
    env.require = function(modname)
        if type(modname) ~= "string" then return nil, "invalid_module_name" end
        local cached = side.modules[modname]
        if cached ~= nil then return cached end
        local ownerRoot, owner, inner = res.root, res.name, modname
        if modname:sub(1, 1) == "@" then
            local lib, rest = modname:match("^@([%w_%-]+)/?(.*)$")
            if not lib or not validModule(rest) then return nil, "invalid_module_name" end
            local declared = false
            for _, dep in ipairs(res.manifest.dependencies) do if dep.name == lib then declared = true end end
            local dr = host.resources[lib]
            if not declared or not dr then return nil, "dependency_not_declared:" .. lib end
            ownerRoot, owner, inner = dr.root, lib, (rest ~= "" and rest or "init")
        elseif modname == "" or not validModule(modname) then
            return nil, "invalid_module_name"
        end
        local base = inner:gsub("%.", "/")
        local path = base .. ".lua"
        local text = host:_read(ownerRoot .. "/" .. path)
        if not text then
            path = base .. "/init.lua"
            text = host:_read(ownerRoot .. "/" .. path)
        end
        if not text then return nil, "module_not_found:" .. modname end
        local fn, err = compat.loadWithEnv(text, "@" .. owner .. "/" .. path, env)
        if not fn then return nil, "module_load_failed: " .. tostring(err) end
        local value = fn(modname)
        if value == nil then value = true end
        side.modules[modname] = value
        return value
    end

    -- ScriptGo namespace
    local SG = {}
    SG.log = {
        debug = function(m) side:log("debug", tostring(m)) end,
        info = function(m) side:log("info", tostring(m)) end,
        warn = function(m) side:log("warn", tostring(m)) end,
        error = function(m) side:log("error", tostring(m)) end,
    }
    SG.json = { encode = json.encode, decode = json.decode, null = json.null, object = json.object }
    SG.time = {
        monotonic = function() return host.now end,
        now = function() return os.time() end,
    }
    SG.runtime = {
        version = function() return M.VERSION end,
        luaVersion = function() return compat.version end,
        environment = function() return environment end,
        side = function() return side.name end,
        adapterVersion = function() return host.adapter.adapterVersion or M.VERSION end,
    }
    SG.resource = {
        name = function() return res.name end,
        version = function() return res.manifest.version end,
        generation = function(other)
            local r = other and host.resources[other] or res
            return r and r.generation or nil
        end,
        state = function(other) return host:resourceState(other or res.name) end,
        hasPermission = function(p)
            for _, x in ipairs(res.manifest.permissions) do if x == p then return true end end
            return false
        end,
        readFile = function(rel)
            if type(rel) ~= "string" or manifest.unsafePathReason(rel) then return nil, "invalid_path" end
            local text = host:_read(res.root .. "/" .. rel)
            if not text then return nil, "not_found" end
            return text
        end,
        manifest = function()
            local ok, copy = codec.copy(res.manifest)
            return ok and copy or nil
        end,
    }
    SG.events = {
        on = env.AddEventHandler, off = env.RemoveEventHandler, emit = env.TriggerEvent,
    }
    SG.net = {
        on = env.RegisterNetEvent,
        emitServer = env.TriggerServerEvent,
        emitClient = env.TriggerClientEvent,
        register = env.RegisterNetEvent,
    }
    SG.exports = { call = callExport }
    SG.capabilities = {
        has = function(c) return host:hasCapability(c) end,
        list = function()
            local out = {}
            for _, c in ipairs(caps.ALL) do if host.capabilities[c] then out[#out + 1] = c end end
            return out
        end,
        require = function(c) if not host:hasCapability(c) then error(caps.unavailable(c, environment), 2) end end,
    }
    local function capTable(cap, members)
        return setmetatable({}, {
            __index = function(_, k)
                if not host:hasCapability(cap) then error(caps.unavailable(cap, environment), 2) end
                return members[k]
            end,
            __newindex = function() error("ScriptGo." .. cap .. " is read-only", 2) end,
        })
    end
    SG.storage = capTable("storage", {
        get = function(key)
            local data = host:_storageLoad(side)
            local ok, v = codec.copy(data[tostring(key)])
            return ok and v or nil
        end,
        set = function(key, value)
            local ok, v = codec.copy(value)
            if not ok then return false, v end
            local data = host:_storageLoad(side)
            data[tostring(key)] = v
            host:_storageSave(side)
            return true
        end,
        delete = function(key)
            local data = host:_storageLoad(side)
            data[tostring(key)] = nil
            host:_storageSave(side)
            return true
        end,
        keys = function(prefix)
            local data = host:_storageLoad(side)
            local out = {}
            for k in pairs(data) do
                if not prefix or k:sub(1, #prefix) == prefix then out[#out + 1] = k end
            end
            table.sort(out)
            return out
        end,
    })
    SG.players = capTable("players", {
        list = function() return host:playerList() end,
        name = function(id) return host:playerName(id) end,
        exists = function(id) return host:playerName(id) ~= nil end,
        identifier = function(id) return host:playerIdentifier(id) end,
    })
    SG.permissions = capTable("permissions", {
        has = function(playerId, privilege)
            if playerId == 0 then return true end
            local p = host.adapter.permissions
            return (p and p.has and p.has(playerId, privilege)) and true or false
        end,
    })
    SG.ui = capTable("ui", {
        notify = function(target, payload)
            -- A client notifies its own player: notify(payload) or notify(nil, payload).
            if side.name == "client" then
                if payload == nil then payload = target end
                target = host.localPlayer and host.localPlayer.id or 1
            end
            local ok, copy = codec.copy(payload)
            if not ok or type(copy) ~= "table" then return false, "invalid_payload" end
            copy.resource = res.name
            local ui = host.adapter.ui
            if not ui or not ui.notify then return false, caps.unavailable("ui", environment) end
            ui.notify(target or -1, copy)
            return true
        end,
    })
    SG.config = capTable("config", {
        get = function(key, default)
            local cfg = host.adapter.config
            local v = cfg and cfg.get and cfg.get(res.name, key)
            if v == nil then return default end
            local ok, copy = codec.copy(v)
            return ok and copy or default
        end,
    })
    SG.http = capTable("http", {
        request = function(opts)
            inThread("ScriptGo.http.request")
            if side.name ~= "server" then return nil, "http is server-side only" end
            return host:httpRequest(opts)
        end,
    })
    local function apiBase()
        local cfg = host.adapter.config
        return (cfg and cfg.get and cfg.get(nil, "scriptgo_api")) or "http://localhost:4100"
    end
    local function licensingCall(path, body)
        inThread("ScriptGo.licensing")
        if side.name ~= "server" then return nil, "licensing is server-side only" end
        if not host:hasCapability("http") then return nil, caps.unavailable("http", environment) end
        local response, err = host:httpRequest({
            method = "POST", url = apiBase() .. path,
            headers = { ["content-type"] = "application/json" },
            body = json.encode(body),
        })
        if not response then return nil, err end
        local ok, decoded = pcall(json.decode, response.body or "")
        if not ok then return nil, "invalid_response (" .. tostring(response.status) .. ")" end
        if (response.status or 0) >= 400 then
            local e = type(decoded) == "table" and decoded.error
            return nil, (type(e) == "table" and e.code) or ("http_" .. tostring(response.status)), decoded
        end
        return decoded
    end
    SG.licensing = capTable("licensing", {
        activate = function(opts)
            return licensingCall("/v1/licenses/activate", {
                licenseKey = opts.licenseKey, package = opts.package, environment = environment,
                deploymentName = opts.deploymentName, adapterVersion = SG.runtime.adapterVersion(),
            })
        end,
        verify = function(opts)
            return licensingCall("/v1/licenses/verify", {
                licenseKey = opts.licenseKey, deploymentToken = opts.deploymentToken,
                package = opts.package, environment = environment, adapterVersion = SG.runtime.adapterVersion(),
            })
        end,
    })
    -- OPEN//77-compatible names for the portable subset.
    SG.notifications = {
        send = function(target, payload) return SG.ui.notify(target, payload) end,
        broadcast = function(payload) return SG.ui.notify(-1, payload) end,
    }

    env.ScriptGo = SG
    env.Open77 = SG
    return env
end

-- Export dispatch shared by resources and outside callers. Returns a promise or nil, reason.
-- Reason tokens follow Open77: export_resource_unavailable, export_not_found,
-- export_arguments_not_serializable; a raised error or an unserializable result rejects.
function Host:_callExport(invoking, sideName, target, exportName, ...)
    if type(target) ~= "string" or type(exportName) ~= "string" then return nil, "invalid_export_name" end
    local tr = self.resources[target]
    if not tr or tr.state ~= "started" then return nil, "export_resource_unavailable" end
    local tside = tr.sides[sideName]
    local fn = tside and tside.exports[exportName]
    if not fn then return nil, "export_not_found" end
    local args = codec.copyArgs(...)
    if not args then return nil, "export_arguments_not_serializable" end
    local promise = newPromise(self)
    tside:spawn(fn, { invoking = invoking }, function(ok, result)
        if not ok then
            promise:reject("export_failed: " .. tostring(result))
            return
        end
        local out = { n = result.n }
        for i = 1, result.n do
            local okCopy, value = codec.copy(result[i])
            if not okCopy then promise:reject("export_result_not_serializable") return end
            out[i] = value
        end
        promise:resolve(unpack(out, 1, out.n))
    end, unpack(args, 1, args.n))
    return promise
end

-- Calls an export from outside any resource (CLI, tests, adapters). Returns a promise.
function Host:callExport(resourceName, exportName, sideName, ...)
    return self:_callExport("host", sideName or "server", resourceName, exportName, ...)
end

-- Same, but ticks the host until the promise settles (synchronous callers only).
-- Returns the resolved values, or nil, reason.
function Host:callExportSync(resourceName, exportName, sideName, timeoutMs, ...)
    local promise, err = self:callExport(resourceName, exportName, sideName, ...)
    if not promise then return nil, err end
    local deadline = self.now + (timeoutMs or 5000) / 1000
    while not promise:isSettled() and self.now < deadline do
        self:tick(self.now + 0.01)
    end
    if not promise:isSettled() then return nil, "timeout" end
    if promise.state ~= "resolved" then return nil, promise.reason end
    return unpack(promise.values, 1, promise.values.n)
end

-- Triggers a host-level event on a side (adapters use this for engine events).
function Host:emit(sideName, name, ...)
    self:broadcast(sideName, name, ...)
end

return M
