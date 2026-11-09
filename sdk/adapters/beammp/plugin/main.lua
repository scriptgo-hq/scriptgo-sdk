-- SCRIPT//GO for BeamMP: runs SCRIPT//GO (and portable OPEN//77) resources inside one BeamMP server
-- plugin, Resources/Server/scriptgo/. BeamMP runs every top-level .lua file of a plugin folder in
-- the plugin's own Lua 5.3 state; this is the only one. The core lives in core/, the adapter in lib/.
--
-- Resources are folders with a scriptgo.lua (or open77.lua) manifest, found in
--   <this plugin>/resources/<name>/   and every folder listed in scriptgo.json "resourceDirs".
-- Every resource whose manifest has `auto_start true` (the default) starts when the plugin loads,
-- dependencies first. Only the server side of a resource runs: there is no client half here.
--
-- Optional <this plugin>/scriptgo.json:
--   { "resources": { "<name>": { "key": "value" } }, "convars": { "key": "value" },
--     "permissions": { "beammp:<account id>": ["*"], "<player name>": ["command.give"] },
--     "start": ["<name>", ...], "dataDir": "<folder>", "http": false, "httpAllowedHosts": ["api.example.com"] }
-- "start", when present, replaces auto-start with an explicit list.
--
-- Chat: resource commands work as chat commands (/giveitem ...); the chat line is then not
-- broadcast. Server console: `scriptgo` lists the resources, `scriptgo start|stop|restart <name>`
-- manages one, and any resource command can be typed there (it runs as the console, source 0).
local function read(path)
    local f = io.open(path, "rb")
    if not f then return nil end
    local text = f:read("*a")
    f:close()
    return text
end

-- BeamMP names the chunk after the file, relative to the server folder and without "@".
local pluginDir = rawget(_G, "SCRIPTGO_BEAMMP_DIR")
if type(pluginDir) ~= "string" then
    local src = (debug and debug.getinfo and debug.getinfo(1, "S").source) or ""
    pluginDir = src:gsub("^@", ""):gsub("\\", "/"):match("^(.*)/[^/]+$") or "Resources/Server/scriptgo"
end
pluginDir = pluginDir:gsub("\\", "/")

local loadChunk = loadstring or load
local function loadModule(path, name)
    local text = read(path)
    if not text then error("[scriptgo] missing " .. path .. ": build the plugin with `node sdk/adapters/beammp/build.mjs`") end
    return assert(loadChunk(text, "@" .. name))
end

-- A hot reload re-runs this file in the same state (BeamMP's plugin monitor): stop the old host first.
local previous = rawget(_G, "ScriptGoBeamMP")
if type(previous) == "table" and previous.shutdown then previous.shutdown("reload") end

local scriptgo = loadModule(pluginDir .. "/core/init.lua", "scriptgo/init.lua")(pluginDir .. "/core/", read)
local json = scriptgo.json

local cfg = {}
do
    local text = read(pluginDir .. "/scriptgo.json")
    if text then
        local ok, value = pcall(json.decode, text)
        if ok and type(value) == "table" then cfg = value
        else Util.LogError("[scriptgo] scriptgo.json is not valid JSON; using defaults") end
    end
end

local logs = {}
local adapter, api = loadModule(pluginDir .. "/lib/adapter.lua", "scriptgo/beammp/adapter.lua")()(scriptgo, {
    pluginDir = pluginDir,
    config = cfg,
    logSink = function(entry)
        logs[#logs + 1] = entry
        if #logs > 5000 then table.remove(logs, 1) end
    end,
})

local host = scriptgo.newHost({ adapter = adapter })

-- Discovery ------------------------------------------------------------------------------------------
local searchDirs = { pluginDir .. "/resources" }
for _, d in ipairs(type(cfg.resourceDirs) == "table" and cfg.resourceDirs or {}) do
    searchDirs[#searchDirs + 1] = tostring(d):gsub("\\", "/")
end

local function hasManifest(root) return read(root .. "/scriptgo.lua") ~= nil or read(root .. "/open77.lua") ~= nil end

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
        if err and err:find("already loaded") then return true end
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
    for _, name in ipairs(FS.ListDirectories(dir) or {}) do
        name = tostring(name):gsub("\\", "/")
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
    if not ok then adapter.log("error", "plugin", name .. ": " .. tostring(err)) end
end

-- Start ----------------------------------------------------------------------------------------------
local verify = type(cfg.verify) == "table" and cfg.verify or nil
local verifyName = verify and verify.resource or nil
local verifyWith = verify and verify.with or nil
local withStarted, withWhy = false, nil

if verifyName then
    -- Verify runs start the resource under test (and its dependencies) only, then the example
    -- resource named by verify.with, if any (the package's README example).
    local ok, why = host:getResource(verifyName) and host:start(verifyName)
    if not ok then adapter.log("error", "plugin", "verify: " .. verifyName .. " did not start: " .. tostring(why)) end
    if ok and verifyWith then
        if host:getResource(verifyWith) then
            withStarted, withWhy = host:start(verifyWith)
        else
            withWhy = "not found"
        end
    end
elseif type(cfg.start) == "table" then
    for _, name in ipairs(cfg.start) do
        local ok, why = host:start(name)
        if not ok then adapter.log("error", "plugin", name .. " did not start: " .. tostring(why)) end
    end
else
    for name, result in pairs(host:startAll()) do
        if result ~= "started" then adapter.log("error", "plugin", name .. " did not start: " .. tostring(result)) end
    end
end

-- Verify mode ----------------------------------------------------------------------------------------
-- scriptgo.json "verify": { "resource": "<name>", "seconds": 3, "report": "<file>", "with": "<name>",
-- "exit": true }. After `seconds` the plugin writes a report with the same schema as the other
-- hosts (relative paths are inside this plugin's folder) and, unless exit is false, shuts the
-- server down with BeamMP's exit().
local verifyStarted = adapter.now()
local verifyDone = false

local function writeVerifyReport()
    local checks = {}
    local function check(name, ok, message)
        checks[#checks + 1] = { name = name, status = ok and "passed" or "failed", message = message or "" }
    end
    local res = host:getResource(verifyName)
    local m = res and res.manifest
    check("manifest_valid", m ~= nil, m and (m.name .. " " .. m.version) or "resource not found or manifest invalid")
    if m then
        local declared = #m.environments == 0
        for _, e in ipairs(m.environments) do if e == "beammp" then declared = true end end
        check("environment_declared", declared, table.concat(m.environments, ", "))
        local missing = {}
        for _, dep in ipairs(m.dependencies) do
            if not host:getResource(dep.name) then missing[#missing + 1] = dep.name end
        end
        check("dependencies_resolved", #missing == 0, table.concat(missing, ", "))
        local state = host:resourceState(verifyName)
        check("starts", state == "started", state)
        local side = res.sides and res.sides.server
        for _, e in ipairs(m.serverExports or {}) do
            check("export:" .. e, side ~= nil and side.exports[e] ~= nil, "")
        end
        if verifyWith then
            check("readme_example", withStarted == true, withStarted == true and (verifyWith .. " started") or tostring(withWhy))
        end
    end
    local errors = {}
    for _, e in ipairs(logs) do if e.level == "error" then errors[#errors + 1] = e end end
    check("no_runtime_errors", #errors == 0, errors[1] and (tostring(errors[1].origin) .. " " .. tostring(errors[1].message)) or "")
    -- SGCHECK lines a resource printed become checks, as in `scriptgo verify`.
    local selfCount, done, lines = 0, false, {}
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
    local major, minor, patch = MP.GetServerVersion()
    local report = {
        package = m and m.name or verifyName, version = m and m.version or "", environment = "beammp",
        status = failed == 0 and "verified" or "failing",
        runtimeVersion = ("BeamMP-Server %s.%s.%s"):format(tostring(major), tostring(minor), tostring(patch)),
        adapterVersion = adapter.adapterVersion, luaVersion = scriptgo.compat.version,
        durationMs = math.floor((adapter.now() - verifyStarted) * 1000),
        checks = checks, log = table.concat(lines, "\n"),
        evidence = { seconds = verify.seconds or 3, os = MP.GetOSName and MP.GetOSName() or nil },
    }
    local name = verify.report or ("scriptgo-verify-" .. verifyName .. ".json")
    local path = (name:match("^%a:[/\\]") or name:match("^/")) and name or (pluginDir .. "/" .. name)
    local ok, err = api.writeFile(path, json.encode(report))
    if not ok then adapter.log("error", "plugin", "verify: cannot write " .. path .. ": " .. tostring(err)) end
    Util.LogInfo(("[scriptgo] verify %s: %s (%d checks, %d failed)"):format(report.package, report.status, #checks, failed))
end

-- Engine wiring --------------------------------------------------------------------------------------
-- BeamMP calls handlers by global function name. A client can trigger any non-reserved server event
-- by name, so the tick handler ignores calls that carry arguments (timer events carry none).
local TICK_EVENT = "scriptgo_tick"
local stopped = false

function ScriptGo_Tick(...)
    if stopped or select("#", ...) > 0 then return end
    local now = adapter.now()
    api.pump(now)
    host:tick(now)
    if verifyName and not verifyDone and now - verifyStarted >= (tonumber(verify.seconds) or 3) then
        verifyDone = true
        writeVerifyReport()
        if verify.exit ~= false and type(exit) == "function" then exit() end
    end
end

function ScriptGo_onPlayerJoin(pid)
    if stopped then return end
    host:playerJoin(api.toScriptGo(pid), MP.GetPlayerName(pid))
end

function ScriptGo_onPlayerDisconnect(pid)
    if stopped then return end
    host:playerDrop(api.toScriptGo(pid), "left")
end

-- Resource commands typed in chat: the line is consumed (returning 1 stops BeamMP broadcasting it).
function ScriptGo_onChatMessage(pid, name, message)
    if stopped or type(message) ~= "string" then return nil end
    local command = message:match("^%s*/(%S+)")
    if not command or not host.commands[command:lower()] then return nil end
    local ok, why = host:executeCommand(api.toScriptGo(pid), (message:gsub("^%s*/", "")))
    if not ok then
        local text = why == "not_allowed" and ("You are not allowed to use /" .. command .. ".") or ("/" .. command .. ": " .. tostring(why))
        MP.SendChatMessage(pid, text)
    end
    return 1
end

-- Server console: `scriptgo [start|stop|restart <resource>]`, and resource commands as the console.
function ScriptGo_onConsoleInput(input)
    if stopped or type(input) ~= "string" then return nil end
    local word = input:match("^%s*(%S+)")
    if not word then return nil end
    if word:lower() == "scriptgo" then
        local action, target = input:match("^%s*%S+%s+(%S+)%s+(%S+)%s*$")
        if not action then
            local lines = {}
            for _, rname in ipairs(host.order) do
                local r = host:getResource(rname)
                lines[#lines + 1] = ("%s %s  %s"):format(rname, r.manifest.version, host:resourceState(rname))
            end
            return #lines > 0 and table.concat(lines, "\n") or "No SCRIPT//GO resources."
        end
        if not host:getResource(target) then return "Unknown resource " .. target .. "." end
        if action == "stop" or action == "restart" then host:stop(target, "command") end
        if action == "start" or action == "restart" then
            local ok, why = host:start(target)
            if not ok then return target .. " did not start: " .. tostring(why) end
        end
        return target .. ": " .. host:resourceState(target)
    end
    if not host.commands[word:lower()] then return nil end
    local ok, why = host:executeCommand(0, input)
    return ok and ("ran " .. word:lower()) or tostring(why)
end

function ScriptGo_onShutdown()
    if stopped then return end
    stopped = true
    host:stopAll()
end

MP.RegisterEvent(TICK_EVENT, "ScriptGo_Tick")
MP.RegisterEvent("onPlayerJoin", "ScriptGo_onPlayerJoin")
MP.RegisterEvent("onPlayerDisconnect", "ScriptGo_onPlayerDisconnect")
MP.RegisterEvent("onChatMessage", "ScriptGo_onChatMessage")
MP.RegisterEvent("onConsoleInput", "ScriptGo_onConsoleInput")
MP.RegisterEvent("onShutdown", "ScriptGo_onShutdown")
-- 25 ms is the shortest interval BeamMP accepts without a warning; Wait(0) resumes on the next tick.
MP.CreateEventTimer(TICK_EVENT, math.max(25, tonumber(cfg.tickMs) or 25))

-- Players already on the server (a hot reload) join the new host.
for pid, name in pairs(MP.GetPlayers() or {}) do
    if type(pid) == "number" then host:playerJoin(api.toScriptGo(pid), name) end
end

ScriptGoBeamMP = {
    host = host,
    adapter = adapter,
    api = api,
    logs = logs,
    shutdown = function(reason)
        if stopped then return end
        stopped = true
        MP.CancelEventTimer(TICK_EVENT)
        host:stopAll()
        adapter.log("info", "plugin", "stopped (" .. tostring(reason) .. ")")
    end,
}

adapter.log("info", "plugin", ("SCRIPT//GO %s on %s, %d resources, http %s"):format(
    scriptgo.VERSION, scriptgo.compat.version, #host.order, adapter.capabilities.http and "on" or "off"))
