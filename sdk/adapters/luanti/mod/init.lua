-- SCRIPT//GO for Luanti: runs SCRIPT//GO (and portable OPEN//77) resources inside this mod.
--
-- Resources are folders with a scriptgo.lua (or open77.lua) manifest, found in
--   <world>/scriptgo/resources/<name>/   (the server owner's resources)
--   <this mod>/resources/<name>/         (resources bundled with the mod)
-- Every resource whose manifest has `auto_start true` (the default) is started when the server
-- starts, dependencies first. Only the server side of a resource runs: Luanti mods are server-side.
--
-- Optional <world>/scriptgo.json:
--   { "resources": { "<name>": { "key": "value" } }, "convars": { "key": "value" },
--     "permissions": { "<player name>": ["command.give", "shop.*"] }, "start": ["<name>", ...] }
-- "start", when present, replaces auto-start with an explicit list.
--
-- Chat: resource commands work as ordinary chat commands (/giveitem ...). `/scriptgo` lists the
-- resources; `/scriptgo start|stop|restart <name>` needs the `server` or `scriptgo_admin` privilege.
local modname = core.get_current_modname()
local modpath = core.get_modpath(modname)
local worldpath = core.get_worldpath()
-- Only granted when the server owner lists this mod in secure.http_mods; must be asked at load time.
local http = core.request_http_api and core.request_http_api() or nil

local function read(path)
    local f = io.open(path, "rb")
    if not f then return nil end
    local text = f:read("*a")
    f:close()
    return text
end

local coreDir = modpath .. "/core/"
local coreText = read(coreDir .. "init.lua")
if not coreText then
    error("[scriptgo] the SCRIPT//GO core is missing from " .. coreDir .. ": build the mod with `node sdk/adapters/luanti/build.mjs`")
end
local scriptgo = assert(loadstring(coreText, "@scriptgo/init.lua"))(coreDir, read)
local json = scriptgo.json

local cfg = {}
do
    local text = read(worldpath .. "/scriptgo.json")
    if text then
        local ok, value = pcall(json.decode, text)
        if ok and type(value) == "table" then
            cfg = value
        else
            core.log("error", "[scriptgo] scriptgo.json is not valid JSON; using defaults")
        end
    end
end

core.register_privilege("scriptgo_admin", {
    description = "Manage SCRIPT//GO resources and pass every SCRIPT//GO permission check",
    give_to_singleplayer = false,
})

local logs = {}
local adapter, api = dofile(modpath .. "/adapter.lua")(scriptgo, {
    config = cfg,
    http = http,
    logSink = function(entry)
        logs[#logs + 1] = entry
        if #logs > 5000 then table.remove(logs, 1) end
    end,
})

local host = scriptgo.newHost({ adapter = adapter })

-- Discovery ------------------------------------------------------------------------------------------
local searchDirs = { worldpath .. "/scriptgo/resources", modpath .. "/resources" }

local function locate(name)
    for _, dir in ipairs(searchDirs) do
        local root = dir .. "/" .. name
        if read(root .. "/scriptgo.lua") or read(root .. "/open77.lua") then return root end
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

local discovered = {}
for _, dir in ipairs(searchDirs) do
    for _, name in ipairs(core.get_dir_list(dir, true) or {}) do
        local root = dir .. "/" .. name
        if not discovered[name] and (read(root .. "/scriptgo.lua") or read(root .. "/open77.lua")) then
            discovered[name] = root
        end
    end
end

local names = {}
for name in pairs(discovered) do names[#names + 1] = name end
table.sort(names)
for _, name in ipairs(names) do
    local ok, err = addWithDeps(discovered[name])
    if not ok then core.log("error", "[scriptgo] " .. name .. ": " .. tostring(err)) end
end

-- Start ----------------------------------------------------------------------------------------------
local verifyName = core.settings:get("scriptgo_verify")
if verifyName == "" then verifyName = nil end

if verifyName then
    -- Verify runs start the resource under test (and its dependencies) only.
    local ok, why = host:getResource(verifyName) and host:start(verifyName)
    if not ok then core.log("error", "[scriptgo] verify: " .. verifyName .. " did not start: " .. tostring(why)) end
elseif type(cfg.start) == "table" then
    for _, name in ipairs(cfg.start) do
        local ok, why = host:start(name)
        if not ok then core.log("error", "[scriptgo] " .. name .. " did not start: " .. tostring(why)) end
    end
else
    for name, result in pairs(host:startAll()) do
        if result ~= "started" then core.log("error", "[scriptgo] " .. name .. " did not start: " .. tostring(result)) end
    end
end

-- Engine wiring --------------------------------------------------------------------------------------
core.register_globalstep(function() host:tick() end)

core.register_on_joinplayer(function(player)
    local name = player:get_player_name()
    host:playerJoin(api.idFor(name), name)
end)

core.register_on_leaveplayer(function(player, timedOut)
    local id = api.idFor(player:get_player_name())
    host:playerDrop(id, timedOut and "timed_out" or "left")
end)

core.register_on_shutdown(function() host:stopAll() end)

-- Resource commands answer as ordinary chat commands; unknown ones fall through to Luanti.
core.register_on_chatcommand(function(name, command, params)
    if not host.commands[command:lower()] then return false end
    local ok, why = host:executeCommand(api.idFor(name), command .. " " .. (params or ""))
    if not ok then
        if why == "not_allowed" then
            core.chat_send_player(name, "You are not allowed to use /" .. command .. ".")
        else
            core.chat_send_player(name, "/" .. command .. ": " .. tostring(why))
        end
    end
    return true
end)

core.register_chatcommand("scriptgo", {
    params = "[start|stop|restart <resource>]",
    description = "List SCRIPT//GO resources, or start, stop or restart one",
    func = function(name, param)
        local action, target = param:match("^(%S+)%s+(%S+)$")
        if not action then
            local lines = {}
            for _, rname in ipairs(host.order) do
                local r = host:getResource(rname)
                lines[#lines + 1] = ("%s %s  %s"):format(rname, r.manifest.version, host:resourceState(rname))
            end
            return true, #lines > 0 and table.concat(lines, "\n") or "No resources."
        end
        local privs = core.get_player_privs(name) or {}
        if not (privs.server or privs.scriptgo_admin) then return false, "Needs the server or scriptgo_admin privilege." end
        if not host:getResource(target) then return false, "Unknown resource " .. target .. "." end
        if action == "stop" or action == "restart" then host:stop(target, "command") end
        if action == "start" or action == "restart" then
            local ok, why = host:start(target)
            if not ok then return false, target .. " did not start: " .. tostring(why) end
        end
        return true, target .. ": " .. host:resourceState(target)
    end,
})

-- Verify mode ----------------------------------------------------------------------------------------
-- scriptgo_verify = <resource>        resource under test (from the search dirs)
-- scriptgo_verify_seconds = 3         how long to let it run
-- scriptgo_verify_report = <file>     report file name, written in the world folder
-- The report has the same schema as `scriptgo verify` on the standalone host; the server shuts
-- down when it is written.
if verifyName then
    local seconds = tonumber(core.settings:get("scriptgo_verify_seconds")) or 3
    local reportName = core.settings:get("scriptgo_verify_report") or ("scriptgo-verify-" .. verifyName .. ".json")
    local started = core.get_us_time()

    core.after(seconds, function()
        local checks = {}
        local function check(name, ok, message)
            checks[#checks + 1] = { name = name, status = ok and "passed" or "failed", message = message or "" }
        end
        local res = host:getResource(verifyName)
        local m = res and res.manifest
        check("manifest_valid", m ~= nil, m and (m.name .. " " .. m.version) or "resource not found or manifest invalid")
        if m then
            local declared = #m.environments == 0
            for _, e in ipairs(m.environments) do if e == "luanti" then declared = true end end
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
        local version = core.get_version()
        local report = {
            package = m and m.name or verifyName, version = m and m.version or "", environment = "luanti",
            status = failed == 0 and "verified" or "failing",
            runtimeVersion = (version.project or "Luanti") .. " " .. tostring(version.string),
            adapterVersion = adapter.adapterVersion, luaVersion = scriptgo.compat.version,
            durationMs = math.floor((core.get_us_time() - started) / 1000),
            checks = checks, log = table.concat(lines, "\n"), evidence = { seconds = seconds },
        }
        local path = worldpath .. "/" .. reportName
        local ok, err = core.safe_file_write(path, json.encode(report))
        if not ok then core.log("error", "[scriptgo] verify: cannot write " .. path .. ": " .. tostring(err)) end
        core.log("action", ("[scriptgo] verify %s: %s (%d checks, %d failed)"):format(report.package, report.status, #checks, failed))
        core.request_shutdown("SCRIPT//GO verify finished", false, 0)
    end)
end
