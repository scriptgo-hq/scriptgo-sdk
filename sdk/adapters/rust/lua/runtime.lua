-- SCRIPT//GO on Rust (Oxide/Carbon): the Lua half of the bridge. The C# bridge loads the portable core
-- (sdk/lua/scriptgo) and this file into one KeraLua (Lua 5.4) state, then drives it through the
-- table this chunk returns. Everything engine-specific stays in C#; this file only discovers
-- resources, starts them, routes players and commands, and builds verify reports.
--
--   local rt = runtime(scriptgo, makeAdapter, H, opts)
--
-- opts: caps, adapterVersion, budgetMs,
--       searchDirs  folders holding resource folders (<data>/ScriptGo/resources, ...)
--       start       explicit list of resources to start (nil: every auto_start resource)
--       verify      { resource = <name>, with = <name>? }: start only that resource (and its
--                   dependencies), then the README example, for `scriptgo verify --env rust`.
--
-- Escrowed resources (a folder with escrow.json, see README.md "Escrow") go through the section
-- "Escrow" below: their start waits for a key the bridge asks the master for, and their encrypted
-- scripts are compiled by the native library, never from the text on disk.
local scriptgo, makeAdapter, H, opts = ...
opts = opts or {}
local json = scriptgo.json

-- A bounded copy of the log for verify reports (SGCHECK lines, errors).
local logs = {}
local adapter = makeAdapter(scriptgo, H, {
    caps = opts.caps, adapterVersion = opts.adapterVersion, budgetMs = opts.budgetMs,
    logSink = function(entry)
        logs[#logs + 1] = entry
        if #logs > 5000 then table.remove(logs, 1) end
    end,
})
local host = scriptgo.newHost({ adapter = adapter })
local started = H.now()

-- Discovery -------------------------------------------------------------------------------------------
local searchDirs = opts.searchDirs or {}

local function hasManifest(root)
    return H.isFile(root .. "/scriptgo.lua") or H.isFile(root .. "/open77.lua")
end

local function locate(name)
    for _, dir in ipairs(searchDirs) do
        local root = dir .. "/" .. name
        if hasManifest(root) then return root end
    end
    return nil
end

local function addWithDeps(root)
    local res, err = host:addResource(root)
    if not res then
        if err and err:find("already loaded", 1, true) then return true end
        return nil, err
    end
    for _, dep in ipairs(res.manifest.dependencies) do
        if not host:getResource(dep.name) then
            local depRoot = locate(dep.name)
            if depRoot then
                local ok, derr = addWithDeps(depRoot)
                if not ok then return nil, derr end
            end
        end
    end
    return res
end

local discovered, names = {}, {}
for _, dir in ipairs(searchDirs) do
    for _, name in ipairs({ H.listDirs(dir) }) do
        local root = dir .. "/" .. name
        if not discovered[name] and hasManifest(root) then
            discovered[name] = root
            names[#names + 1] = name
        end
    end
end
table.sort(names)
for _, name in ipairs(names) do
    local ok, err = addWithDeps(discovered[name])
    if not ok then host:log("error", name .. ": " .. tostring(err)) end
end

-- Escrow ----------------------------------------------------------------------------------------------
-- A resource is escrowed if and only if its folder holds escrow.json. Its encrypted scripts are stubs
-- on disk; the real chunks sit in payload.enc and are decrypted by the native library (libscriptgo)
-- once the master has released the key to this server. The C# bridge (bridge/Escrow) owns the checks,
-- the licence and the native calls; this section owns the three places where the core must behave
-- differently, without changing the core:
--
--   1. host:start is wrapped. Web requests are asynchronous on this host, so the key never arrives
--      inside the start that asked for it: the resource becomes "pending_key" and the bridge reports
--      later, through rt.escrow, that the key arrived (the start runs then) or was refused (the
--      resource fails with a reason code). A resource that depends on a pending one waits with it.
--   2. host:stop is wrapped, so that a stopped resource's decrypted release is wiped.
--   3. The core compiles every script through compat.loadWithEnv, with a chunk name
--      "@<resource>/<path>". That one function is wrapped: an encrypted script is compiled by the
--      native library straight from its memory, into the environment of its own resource only, and
--      the stub read from disk is dropped. A stub is never compiled, in any resource.
--
-- Deterrence, licence binding, revocation and traceability: not a guarantee. The operator of the
-- machine can ultimately recover what their own process runs.
local escrow = {}    -- name -> { state = "idle" | "pending" | "ready" | "refused", failure = <text> }
local waiting = {}   -- name -> true: its start waits for a key (its own, or a dependency's)
local resolving = {} -- name -> true while its escrowed dependencies are being started
local unpack = scriptgo.compat.unpack
local STUB = "-- scriptgo-escrow/1 "
local coreStart, coreStop, coreLoad = host.start, host.stop, scriptgo.compat.loadWithEnv

local function isEscrowed(res) return H.isFile(res.root .. "/escrow.json") == true end

-- The scripts the core is about to run for a resource, expanded the way Host:start expands them.
local function scriptsOf(res)
    local m = res.manifest
    local entries = {}
    for _, p in ipairs(m.sharedScripts) do entries[#entries + 1] = p end
    for _, p in ipairs(m.serverScripts) do entries[#entries + 1] = p end
    for _, p in ipairs(m.environmentScripts[host.environment] or {}) do entries[#entries + 1] = p end
    local out, listing = {}, nil
    for _, p in ipairs(entries) do
        if scriptgo.manifest.isGlob(p) then
            listing = listing or adapter.listFiles(res.root) or {}
            for _, f in ipairs(scriptgo.manifest.expandGlob(p, listing)) do out[#out + 1] = f end
        else
            out[#out + 1] = p
        end
    end
    return out
end

-- Escrowed resources among the dependencies of `res` that are not started yet, deepest first.
local function escrowedDependencies(res, seen, out)
    for _, dep in ipairs(res.manifest.dependencies) do
        local d = host.resources[dep.name]
        if d and not seen[dep.name] then
            seen[dep.name] = true
            escrowedDependencies(d, seen, out)
            if d.state ~= "started" and isEscrowed(d) then out[#out + 1] = dep.name end
        end
    end
    return out
end

-- One error line, starting with the reason code; `scriptgo status` shows the same text.
local function refuse(name, code, detail)
    local res, e = host.resources[name], escrow[name]
    local failure = tostring(code) .. ": " .. tostring(detail)
    e.state, e.failure = "refused", failure
    waiting[name] = nil
    res.state, res.failure = "failed", failure
    host:log("error", name .. ": " .. failure)
    return false, failure
end

function host:start(name, visiting)
    local res = self.resources[name]
    if not res or res.state == "started" then return coreStart(self, name, visiting) end
    waiting[name] = nil
    -- An escrowed dependency that waits for its key makes this resource wait with it, not fail.
    -- (`resolving` stops a dependency cycle from recursing here; the core then reports the cycle.)
    if not resolving[name] then
        resolving[name] = true
        local held
        for _, depName in ipairs(escrowedDependencies(res, { [name] = true }, {})) do
            if not self:start(depName) and waiting[depName] then
                held = depName
                break
            end
        end
        resolving[name] = nil
        if held then
            waiting[name] = true
            res.state, res.failure = "pending_key", nil
            return false, "pending_key (waits for " .. held .. ")"
        end
    end
    if not isEscrowed(res) then
        escrow[name] = nil
        if res.state == "pending_key" then res.state = "stopped" end
        return coreStart(self, name, visiting)
    end

    local e = escrow[name]
    if not e then
        e = { state = "idle" }
        escrow[name] = e
    end
    -- A refusal stands until an operator asks again (`scriptgo start <resource>`).
    if e.state == "refused" then
        res.state, res.failure = "failed", e.failure
        return false, e.failure
    end
    if e.state ~= "pending" then
        local verdict, code, detail = H.escrowBegin(name, res.root, unpack(scriptsOf(res)))
        if verdict == "ready" then
            e.state, e.failure = "ready", nil
        elseif verdict == "pending" then
            e.state = "pending"
            self:log("info", name .. ": escrowed release, waiting for its key from the key service")
        elseif verdict == "refused" then
            return refuse(name, code, detail)
        else
            -- The bridge call itself failed (verdict is nil, `code` holds its message): nothing was checked.
            return refuse(name, "invalid_manifest", "the escrow check did not run: " .. tostring(code))
        end
    end
    if e.state == "pending" then
        waiting[name] = true
        res.state, res.failure = "pending_key", nil
        return false, "pending_key"
    end

    -- Ready: the release is open in native memory, and loadWithEnv below serves its scripts.
    if res.state == "pending_key" then res.state = "stopped" end
    local ok, why = coreStart(self, name, visiting)
    if not ok then
        H.escrowRelease(name)
        e.state = "idle"
    end
    return ok, why
end

function host:stop(name, reason)
    local res = self.resources[name]
    if res and waiting[name] then
        -- A start that was still waiting for a key is cancelled.
        waiting[name] = nil
        if res.state == "pending_key" then res.state = "stopped" end
        local e = escrow[name]
        if e and e.state == "pending" then
            H.escrowRelease(name)
            e.state = "idle"
        end
        return true
    end
    local ok = coreStop(self, name, reason)
    local e = escrow[name]
    if ok and e and e.state == "ready" then
        H.escrowRelease(name)
        e.state = "idle"
    end
    return ok
end

scriptgo.compat.loadWithEnv = function(source, chunkname, env)
    local owner, rel = tostring(chunkname):match("^@([^/]+)/(.+)$")
    local e = owner and escrow[owner]
    if e then
        local res = host.resources[owner]
        local side = res and res.sides and res.sides.server
        -- `own`: the chunk is being loaded into the environment of the resource it belongs to.
        local own = e.state == "ready" and side ~= nil and side.env == env
        local fn, why = H.escrowLoad(owner, rel, chunkname, env, own, source)
        if fn == true then return coreLoad(source, chunkname, env) end   -- a clear file of the release
        if fn == nil then return nil, why or "escrow: cannot load " .. tostring(rel) end
        return fn
    end
    if type(source) == "string" and source:sub(1, #STUB) == STUB then
        return nil, "escrow: " .. tostring(chunkname) .. " is the stub of an encrypted script and is never run"
    end
    return coreLoad(source, chunkname, env)
end

-- Start -----------------------------------------------------------------------------------------------
local verify = opts.verify
local withStarted, withWhy, withTried = false, nil, false

-- Verify mode: the README example starts once the verified resource runs (at once, or when its key arrived).
local function startWith()
    if not (verify and verify.resource and verify.with) or withTried then return end
    if host:resourceState(verify.resource) ~= "started" then return end
    withTried = true
    if host:getResource(verify.with) then
        withStarted, withWhy = host:start(verify.with)
    else
        withWhy = "not found"
    end
end

-- A start that waits for a key is not a failure, and an escrow refusal already logged its one line.
local function report(name, ok, why, prefix)
    if ok or waiting[name] then return end
    local e = escrow[name]
    if e and e.state == "refused" then return end
    host:log("error", (prefix or "") .. name .. " did not start: " .. tostring(why))
end

-- Starts again every resource whose start was waiting for a key.
local function resume()
    local names = {}
    for _, name in ipairs(host.order) do
        if waiting[name] then names[#names + 1] = name end
    end
    for _, name in ipairs(names) do
        if waiting[name] then
            local ok, why = host:start(name)
            report(name, ok, why)
        end
    end
    startWith()
end

-- An operator's start asks the key service again, for the resource and what it depends on.
local function forget(name, seen)
    if seen[name] then return end
    seen[name] = true
    local e, res = escrow[name], host.resources[name]
    if e and e.state == "refused" then e.state, e.failure = "idle", nil end
    for _, dep in ipairs(res and res.manifest.dependencies or {}) do forget(dep.name, seen) end
end

if verify and verify.resource then
    local ok, why = false, "resource not found"
    if host:getResource(verify.resource) then ok, why = host:start(verify.resource) end
    report(verify.resource, ok, why, "verify: ")
    startWith()
elseif type(opts.start) == "table" then
    for _, name in ipairs(opts.start) do
        local ok, why = host:start(name)
        report(name, ok, why)
    end
else
    local results = host:startAll()
    local sorted = {}
    for name in pairs(results) do sorted[#sorted + 1] = name end
    table.sort(sorted)
    for _, name in ipairs(sorted) do report(name, results[name] == "started", results[name]) end
end

-- The interface the C# bridge calls --------------------------------------------------------------------
local rt = {}

function rt.tick() host:tick() end

function rt.join(id, name) host:playerJoin(id, name) end

function rt.drop(id, reason) host:playerDrop(id, reason) end

function rt.hasCommand(name)
    return type(name) == "string" and host.commands[name:lower()] ~= nil
end

-- Every resource command name, restricted ones flagged, for the plugin's permission registration.
function rt.commands()
    local out = {}
    for _, name in ipairs(host:commandList()) do
        local restricted = false
        for _, e in ipairs(host.commands[name] or {}) do
            if e.restricted then restricted = true end
        end
        out[#out + 1] = name .. (restricted and " restricted" or "")
    end
    return table.concat(out, "\n")
end

function rt.command(source, line) return host:executeCommand(source, line) end

function rt.status()
    local lines = {}
    for _, name in ipairs(host.order) do
        local r = host:getResource(name)
        local line = ("%s %s  %s"):format(name, r.manifest.version, host:resourceState(name))
        -- An escrowed resource also says where its licence stands, starting with a reason code when refused.
        local note = escrow[name] and H.escrowStatus(name)
        if note then line = line .. "  [escrow " .. note .. "]" end
        lines[#lines + 1] = line
    end
    return #lines > 0 and table.concat(lines, "\n") or "No resources."
end

-- action: start | stop | restart
function rt.control(action, name)
    if not host:getResource(name) then return false, "unknown resource " .. tostring(name) end
    if action == "stop" or action == "restart" then host:stop(name, "command") end
    if action == "start" or action == "restart" then
        forget(name, {})
        local ok, why = host:start(name)
        if not ok and waiting[name] then return true, name .. ": pending_key (waiting for the key service)" end
        if not ok then return false, name .. " did not start: " .. tostring(why) end
    end
    return true, name .. ": " .. host:resourceState(name)
end

-- What the bridge reports about an escrowed resource, on a tick after the request that caused it:
--   "ready"    the key arrived and the release is open: the waiting start runs now
--   "refused"  the key was refused or could not be had: the start fails with the reason code
--   "stop"     the licence could not be renewed and its offline grace ended: the resource is stopped
function rt.escrow(name, kind, code, detail)
    local res, e = host:getResource(name), escrow[name]
    if not res or not e then return end
    if kind == "stop" then
        host:stop(name, "escrow_" .. tostring(code))
        local failure = tostring(code) .. ": " .. tostring(detail)
        e.state, e.failure = "refused", failure
        res.state, res.failure = "failed", failure
        host:log("error", name .. ": stopped: " .. failure)
        return
    end
    if e.state ~= "pending" then return end
    if kind == "ready" then
        e.state = "idle"
    else
        refuse(name, code, detail)
    end
    resume()
end

function rt.httpDone(...)
    if adapter.httpDone then adapter.httpDone(...) end
end

function rt.stopAll() host:stopAll() end

function rt.luaVersion() return scriptgo.compat.version end

-- Verify report ---------------------------------------------------------------------------------------
-- Same schema as the Luanti mod's verify mode and `scriptgo verify` on the standalone host; the
-- CLI turns it into a CompatibilityRun. evidenceJson: extra evidence from the plugin (framework,
-- Rust build), as a JSON object.
function rt.verifyReport(runtimeVersion, evidenceJson)
    local name = verify and verify.resource or ""
    local checks = {}
    local function check(cname, ok, message)
        checks[#checks + 1] = { name = cname, status = ok and "passed" or "failed", message = message or "" }
    end
    local res = host:getResource(name)
    local m = res and res.manifest
    check("manifest_valid", m ~= nil, m and (m.name .. " " .. m.version) or "resource not found or manifest invalid")
    if m then
        local declared = #m.environments == 0
        for _, e in ipairs(m.environments) do if e == "rust" then declared = true end end
        check("environment_declared", declared, table.concat(m.environments, ", "))
        local missing = {}
        for _, dep in ipairs(m.dependencies) do
            if not host:getResource(dep.name) then missing[#missing + 1] = dep.name end
        end
        check("dependencies_resolved", #missing == 0, table.concat(missing, ", "))
        local state = host:resourceState(name)
        check("starts", state == "started", state)
        local side = res.sides and res.sides.server
        for _, e in ipairs(m.serverExports or {}) do
            check("export:" .. e, side ~= nil and side.exports[e] ~= nil, "")
        end
        if verify.with then
            check("readme_example", withStarted == true, withStarted == true and (verify.with .. " started") or tostring(withWhy))
        end
    end
    local errors = {}
    for _, e in ipairs(logs) do if e.level == "error" then errors[#errors + 1] = e end end
    check("no_runtime_errors", #errors == 0, errors[1] and (tostring(errors[1].origin) .. " " .. tostring(errors[1].message)) or "")
    -- SGCHECK lines a resource printed become checks, as in `scriptgo verify`.
    local selfCount, done = 0, false
    local lines = {}
    for _, e in ipairs(logs) do
        local msg = tostring(e.message)
        lines[#lines + 1] = ("[%s] %s %s"):format(e.level, tostring(e.origin), msg)
        local verdict, cname, detail = msg:match("SGCHECK (%u+) (%S+)%s*(.*)$")
        if verdict == "PASS" or verdict == "FAIL" then
            selfCount = selfCount + 1
            checks[#checks + 1] = { name = "self:" .. cname, status = verdict == "PASS" and "passed" or "failed", message = detail or "" }
        end
        if msg:find("SGCHECK DONE", 1, true) then done = true end
    end
    if selfCount > 0 and not done then check("self:done", false, "SGCHECK DONE never printed: the self-checks did not finish") end

    local failed = 0
    for _, c in ipairs(checks) do if c.status == "failed" then failed = failed + 1 end end
    local evidence = {}
    if type(evidenceJson) == "string" and evidenceJson ~= "" then
        local ok, decoded = pcall(json.decode, evidenceJson)
        if ok and type(decoded) == "table" then evidence = decoded end
    end
    evidence.ticks = host.tickCount
    local report = {
        package = m and m.name or name, version = m and m.version or "", environment = "rust",
        status = failed == 0 and "verified" or "failing",
        runtimeVersion = runtimeVersion or "", adapterVersion = adapter.adapterVersion,
        luaVersion = scriptgo.compat.version,
        durationMs = math.floor((H.now() - started) * 1000),
        checks = checks, log = table.concat(lines, "\n"), evidence = json.object(evidence),
    }
    return json.encode(report), failed, #checks
end

return rt
