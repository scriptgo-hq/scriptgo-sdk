-- SCRIPT//GO for Garry's Mod: runs SCRIPT//GO (and portable OPEN//77) resources on a server.
-- Included by lua/autorun/server/scriptgo.lua; server side only.
--
-- Resources are folders with a scriptgo.lua (or open77.lua) manifest, found in
--   garrysmod/data/scriptgo/resources/<name>/      (the server owner's resources)
--   <any addon>/lua/scriptgo/resources/<name>/     (addons made by `scriptgo pack --target garrysmod`)
-- Every resource whose manifest has `auto_start true` (the default) starts when the map has
-- loaded (InitPostEntity), dependencies first. Only the server side of a resource runs.
--
-- Optional garrysmod/data/scriptgo/config.json:
--   { "resources": { "<name>": { "key": "value" } }, "convars": { "key": "value" },
--     "permissions": { "<usergroup|SteamID64|SteamID>": ["command.give", "shop.*"] },
--     "start": ["<name>", ...] }
-- "start", when present, replaces auto-start with an explicit list.
--
-- Chat: resource commands work as /name or !name. Console: `scriptgo` lists the resources;
-- `scriptgo start|stop|restart <name>` and `scriptgo run <command line>` (server console or a
-- superadmin). Other addons reach the host through the global SCRIPTGO.
if SCRIPTGO and SCRIPTGO.host then
    MsgC(Color(255, 200, 80), "[scriptgo] already running; restart the map to reload it\n")
    return
end

local function readLua(path) return file.Read(path, "LUA") end

-- The core and resource chunks are compiled with CompileString: GLua has no loadstring, load or
-- dofile. Core modules run in an environment that adds `loadstring` on top of _G, so the core's
-- own loader and its sandbox (compat.loadWithEnv) work unchanged.
local coreEnv
local function compile(text, name)
    local fn = CompileString(text, name, false)
    if type(fn) ~= "function" then return nil, tostring(fn) end
    setfenv(fn, coreEnv)
    return fn
end
coreEnv = setmetatable({ loadstring = compile }, { __index = _G })

local initText = readLua("scriptgo/core/init.lua")
if not initText then
    error("[scriptgo] the SCRIPT//GO core is missing from lua/scriptgo/core: build the addon with `node sdk/adapters/garrysmod/build.mjs`")
end
local scriptgo = assert(compile(initText, "@scriptgo/init.lua"))("scriptgo/core/", readLua)
local json = scriptgo.json

local function readJson(path)
    local text = file.Read(path, "DATA")
    if not text or text == "" then return nil end
    local ok, value = pcall(json.decode, text)
    if ok and type(value) == "table" then return value end
    MsgC(Color(255, 90, 90), "[scriptgo] data/" .. path .. " is not valid JSON; ignored\n")
    return nil
end

-- A verify run (scriptgo verify --env garrysmod) leaves data/scriptgo/verify.json: it brings its
-- own config and storage folder, and the operator's config.json is not read.
local verifyReq = readJson("scriptgo/verify.json")
local cfg = verifyReq and (verifyReq.config or {}) or (readJson("scriptgo/config.json") or {})

CreateConVar("scriptgo_api", "", 0, "SCRIPT//GO licensing API base URL (default https://api.scriptgo.dev)")
CreateConVar("scriptgo_debug", "0", 0, "Print SCRIPT//GO debug log lines")

local logs = {}
local adapter, api = include("scriptgo/adapter.lua")(scriptgo, {
    config = cfg,
    storageDir = verifyReq and (verifyReq.storageDir or "scriptgo/verify/storage") or "scriptgo/storage",
    debug = GetConVar("scriptgo_debug"):GetBool(),
    logSink = function(entry)
        logs[#logs + 1] = entry
        if #logs > 5000 then table.remove(logs, 1) end
    end,
})

local host = scriptgo.newHost({ adapter = adapter })
SCRIPTGO = { host = host, scriptgo = scriptgo, adapter = adapter, version = adapter.adapterVersion }

-- Discovery ----------------------------------------------------------------------------------------
local SEARCH = verifyReq and { "LUA:scriptgo/resources" } or { "DATA:scriptgo/resources", "LUA:scriptgo/resources" }

local function hasManifest(root)
    return adapter.readFile(root .. "/scriptgo.lua") ~= nil or adapter.readFile(root .. "/open77.lua") ~= nil
end

local function locate(name)
    for _, dir in ipairs(SEARCH) do
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
for _, dir in ipairs(SEARCH) do
    local base, id = api.split(dir)
    local _, dirs = file.Find(base .. "/*", id)
    for _, name in ipairs(dirs or {}) do
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
    if not ok then adapter.log("error", "host", name .. ": " .. tostring(err)) end
end

-- Start ----------------------------------------------------------------------------------------------
local verify = verifyReq and include("scriptgo/verify.lua")({
    host = host, scriptgo = scriptgo, adapter = adapter, api = api, logs = logs, request = verifyReq,
}) or nil

local started = false
local function startResources()
    if started then return end
    started = true
    if verify then
        verify.start()
    elseif type(cfg.start) == "table" then
        for _, name in ipairs(cfg.start) do
            local ok, why = host:start(name)
            if not ok then adapter.log("error", "host", name .. " did not start: " .. tostring(why)) end
        end
    else
        for name, result in pairs(host:startAll()) do
            if result ~= "started" then adapter.log("error", "host", name .. " did not start: " .. tostring(result)) end
        end
    end
    -- Players already on the server (the addon loaded late) join now.
    for _, ply in ipairs(player.GetAll()) do host:playerJoin(api.remember(ply), ply:Nick()) end
    local hibernate = GetConVar("sv_hibernate_think")
    if hibernate and not hibernate:GetBool() then
        adapter.log("warn", "host", "the server hibernates while empty (sv_hibernate_think 0): resource threads pause until a player joins")
    end
end

-- InitPostEntity fires once the map's entities exist, even on an empty server; a late load (after
-- the map started) starts at once.
hook.Add("InitPostEntity", "scriptgo", startResources)
if #ents.GetAll() > 0 and GAMEMODE then startResources() end

-- Engine wiring --------------------------------------------------------------------------------------
-- The scheduler ticks on Think, every server frame. A failing tick is logged once a second at most,
-- never raised into the hook system (which would remove nothing and spam every frame).
local lastTickError = -1
hook.Add("Think", "scriptgo", function()
    local ok, err = pcall(host.tick, host)
    if not ok and SysTime() - lastTickError > 1 then
        lastTickError = SysTime()
        adapter.log("error", "host", "tick: " .. tostring(err))
    end
end)

hook.Add("PlayerInitialSpawn", "scriptgo", function(ply)
    host:playerJoin(api.remember(ply), ply:Nick())
end)

-- player_disconnect carries the reason; it also fires for players who never spawned, whom the
-- host ignores.
gameevent.Listen("player_disconnect")
hook.Add("player_disconnect", "scriptgo", function(data)
    local id = tonumber(data.userid)
    if id then host:playerDrop(id, data.reason or "disconnected") end
end)

hook.Add("ShutDown", "scriptgo", function() host:stopAll() end)

-- Resource commands in chat, as /name or !name. Only names a resource registered are taken; every
-- other line goes on to the game and other addons.
hook.Add("PlayerSay", "scriptgo", function(ply, text)
    local rest = text:match("^[/!](%S.*)$")
    if not rest then return end
    local name = rest:match("^(%S+)"):lower()
    if not host.commands[name] then return end
    local ok, why = host:executeCommand(ply:UserID(), rest)
    if not ok then
        adapter.log("info", "host", ("%s (userid %d) was refused /%s: %s"):format(ply:Nick(), ply:UserID(), name, tostring(why)))
        if why == "not_allowed" then
            ply:ChatPrint("You are not allowed to use /" .. name .. ".")
        else
            ply:ChatPrint("/" .. name .. ": " .. tostring(why))
        end
    end
    return ""
end)

local function isAdmin(ply)
    return not IsValid(ply) or ply:IsSuperAdmin() or api.camiAllows(ply, "admin") == true
end

concommand.Add("scriptgo", function(ply, _, args, argStr)
    local function reply(msg)
        if IsValid(ply) then ply:PrintMessage(HUD_PRINTCONSOLE, msg .. "\n") else print(msg) end
    end
    local action, target = args[1], args[2]
    if not action or action == "list" then
        local lines = {}
        for _, rname in ipairs(host.order) do
            local r = host:getResource(rname)
            lines[#lines + 1] = ("%s %s  %s"):format(rname, r.manifest.version, host:resourceState(rname))
        end
        reply(#lines > 0 and table.concat(lines, "\n") or "No resources.")
        return
    end
    if action == "run" then
        local line = (argStr or ""):match("^%s*run%s+(.-)%s*$")
        if not line or line == "" then return reply("usage: scriptgo run <command> [args]") end
        local ok, why = host:executeCommand(IsValid(ply) and ply:UserID() or 0, line)
        if not ok then reply("scriptgo run: " .. tostring(why)) end
        return
    end
    if action ~= "start" and action ~= "stop" and action ~= "restart" then
        return reply("usage: scriptgo [list] | start|stop|restart <resource> | run <command> [args]")
    end
    if not isAdmin(ply) then return reply("Needs the server console or a superadmin.") end
    if not target or not host:getResource(target) then return reply("Unknown resource " .. tostring(target) .. ".") end
    if action == "stop" or action == "restart" then host:stop(target, "command") end
    if action == "start" or action == "restart" then
        local ok, why = host:start(target)
        if not ok then return reply(target .. " did not start: " .. tostring(why)) end
    end
    reply(target .. ": " .. host:resourceState(target))
end)

adapter.log("info", "host", ("SCRIPT//GO %s on %s, %s: %d resource(s) found"):format(
    adapter.adapterVersion, tostring(VERSIONSTR), scriptgo.compat.version, #names))
