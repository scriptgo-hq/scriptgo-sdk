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

-- Start -----------------------------------------------------------------------------------------------
local verify = opts.verify
local withStarted, withWhy = false, nil
if verify and verify.resource then
    local ok, why = false, "resource not found"
    if host:getResource(verify.resource) then ok, why = host:start(verify.resource) end
    if not ok then host:log("error", "verify: " .. verify.resource .. " did not start: " .. tostring(why)) end
    if ok and verify.with then
        if host:getResource(verify.with) then
            withStarted, withWhy = host:start(verify.with)
        else
            withWhy = "not found"
        end
    end
elseif type(opts.start) == "table" then
    for _, name in ipairs(opts.start) do
        local ok, why = host:start(name)
        if not ok then host:log("error", name .. " did not start: " .. tostring(why)) end
    end
else
    local results = host:startAll()
    local sorted = {}
    for name in pairs(results) do sorted[#sorted + 1] = name end
    table.sort(sorted)
    for _, name in ipairs(sorted) do
        if results[name] ~= "started" then host:log("error", name .. " did not start: " .. tostring(results[name])) end
    end
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
        lines[#lines + 1] = ("%s %s  %s"):format(name, r.manifest.version, host:resourceState(name))
    end
    return #lines > 0 and table.concat(lines, "\n") or "No resources."
end

-- action: start | stop | restart
function rt.control(action, name)
    if not host:getResource(name) then return false, "unknown resource " .. tostring(name) end
    if action == "stop" or action == "restart" then host:stop(name, "command") end
    if action == "start" or action == "restart" then
        local ok, why = host:start(name)
        if not ok then return false, name .. " did not start: " .. tostring(why) end
    end
    return true, name .. ": " .. host:resourceState(name)
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
