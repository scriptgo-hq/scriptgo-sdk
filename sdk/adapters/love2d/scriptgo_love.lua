-- SCRIPT//GO for LÖVE games. Loads the core and the love2d adapter, adds resources with their
-- dependencies, and runs the server side and the local client (player 1) inside the game process.
--
--   local sg = require("scriptgo_love").new{
--       resources = { "sg_inventory" },          -- names (found in `search`) or folders
--       search = { "resources" },                -- love.filesystem folders or absolute paths
--   }
--   function love.update(dt) sg:update(dt) end
--   function love.draw() --[[ the game ]] sg:draw() end
--   function love.keypressed(k, sc, r) if sg:keypressed(k, sc, r) then return end end
--   function love.textinput(t) if sg:textinput(t) then return end end
--   function love.quit() sg:shutdown() end
--
-- Paths: absolute ("C:/...", "/home/...") are read with io; others are love.filesystem paths.
-- See README.md next to this file.
local M = {}

local function isAbsolute(p) return p:match("^%a:/") ~= nil or p:sub(1, 1) == "/" end

-- Collapses "." and ".." segments; keeps a leading drive or "/".
local function normalize(p)
    p = tostring(p):gsub("\\", "/")
    local lead = ""
    if p:match("^%a:/") then lead, p = p:sub(1, 3), p:sub(4)
    elseif p:sub(1, 1) == "/" then lead, p = "/", p:sub(2) end
    local parts = {}
    for seg in p:gmatch("[^/]+") do
        if seg == ".." and #parts > 0 and parts[#parts] ~= ".." then parts[#parts] = nil
        elseif seg ~= "." then parts[#parts + 1] = seg end
    end
    return lead .. table.concat(parts, "/")
end
M.normalize = normalize

-- A command-line path made absolute against the working directory.
function M.absolute(p)
    p = tostring(p):gsub("\\", "/")
    if isAbsolute(p) then return normalize(p) end
    return normalize(love.filesystem.getWorkingDirectory() .. "/" .. p)
end

local function readAny(path)
    path = tostring(path):gsub("\\", "/")
    if isAbsolute(path) then
        local f = io and io.open(path, "rb")
        if not f then return nil end
        local text = f:read("*a")
        f:close()
        return text
    end
    if not love.filesystem.getInfo(path, "file") then return nil end
    return (love.filesystem.read(path))
end
M.readFile = readAny

local function loadChunk(path)
    if isAbsolute(path) then return loadfile(path) end
    return love.filesystem.load(path)
end

-- This file's folder: absolute when found through package.path, a love.filesystem path when
-- required from the game folder.
local HERE = (function()
    local src = debug.getinfo(1, "S").source
    if type(src) ~= "string" or src:sub(1, 1) ~= "@" then return "" end
    local dir = src:sub(2):gsub("\\", "/"):match("^(.*)/") or ""
    dir = normalize(dir)
    return dir == "" and "" or (dir .. "/")
end)()
M.HERE = HERE

-- The core folder (init.lua): opts.core, else the repository layout, else a vendored copy.
local function findCore(explicit)
    local candidates = explicit and { explicit } or { HERE .. "../../lua/scriptgo", HERE .. "scriptgo", "scriptgo" }
    for _, dir in ipairs(candidates) do
        dir = normalize(dir)
        local prefix = dir == "" and "" or (dir .. "/")
        if readAny(prefix .. "init.lua") and readAny(prefix .. "host.lua") then return prefix end
    end
    return nil
end

local SG = {}
SG.__index = SG

-- opts: resources, search, core, config, storageDir, player = { id, name }, autoStart (true),
-- logLevel, quiet, logSink, curl, http, httpThread, budgetMs, consoleKey (scancode, default "`").
function M.new(opts)
    opts = opts or {}
    local coreDir = findCore(opts.core)
    if not coreDir then error("scriptgo_love: the SCRIPT//GO core (init.lua) was not found; pass opts.core", 2) end
    local scriptgo = assert(loadChunk(coreDir .. "init.lua"))(coreDir, readAny)
    local makeAdapter = assert(loadChunk(HERE .. "adapter.lua"))()
    local self = setmetatable({
        scriptgo = scriptgo,
        player = opts.player or { id = 1, name = "Player" },
        search = {},
        logs = {}, errorCount = 0,
        console = { open = false, input = "", history = {}, key = opts.consoleKey or "`" },
    }, SG)
    for _, dir in ipairs(opts.search or { "" }) do self.search[#self.search + 1] = normalize(dir) end
    local userSink = opts.logSink
    self.adapter = makeAdapter(scriptgo, {
        config = opts.config, storageDir = opts.storageDir, localPlayerId = self.player.id,
        logLevel = opts.logLevel, quiet = opts.quiet, curl = opts.curl, http = opts.http,
        httpThread = opts.httpThread, maxToasts = opts.maxToasts,
        logSink = function(level, origin, msg)
            self:_record(level, origin, msg)
            if userSink then userSink(level, origin, msg) end
        end,
    })
    self.host = scriptgo.newHost({ adapter = self.adapter, localPlayer = self.player, budgetMs = opts.budgetMs })
    for _, ref in ipairs(opts.resources or {}) do
        local res, err = self:add(ref)
        if not res then self.host:log("error", err) end
    end
    if opts.autoStart ~= false then self:start() end
    return self
end

function SG:_record(level, origin, msg)
    local logs = self.logs
    logs[#logs + 1] = { level = level, origin = origin, message = tostring(msg) }
    if #logs > 500 then table.remove(logs, 1) end
    if level == "error" then self.errorCount = self.errorCount + 1 end
end

-- Finds a resource folder by name in the search paths.
function SG:locate(name)
    for _, dir in ipairs(self.search) do
        local root = dir == "" and name or (dir .. "/" .. name)
        if readAny(root .. "/scriptgo.lua") or readAny(root .. "/open77.lua") then return root end
    end
    return nil
end

-- Adds a resource (a name found in `search`, or a folder) and, recursively, its dependencies.
-- Returns the resource record or nil, reason.
function SG:add(ref, seen)
    local root = ref
    if not tostring(ref):find("[/\\]") then
        root = self:locate(ref)
        if not root then return nil, "resource '" .. tostring(ref) .. "' not found in the search paths" end
    end
    local res, err = self.host:addResource(normalize(root))
    if not res then
        if err and err:find("already loaded") then return self.host:getResource(tostring(ref):match("([^/\\]+)$")) or true end
        return nil, err
    end
    for _, dep in ipairs(res.manifest.dependencies) do
        if not self.host:getResource(dep.name) then
            local depRoot = self:locate(dep.name)
            if depRoot then
                local ok, derr = self:add(depRoot)
                if not ok then return nil, derr end
            end
        end
    end
    return res
end

-- Starts every auto-start resource, then the local player joins.
function SG:start()
    local results = self.host:startAll()
    for name, state in pairs(results) do
        if state ~= "started" then self.host:log("error", name .. ": " .. tostring(state)) end
    end
    self:join()
    self.results = results
    return results
end

function SG:join()
    if self.joined then return end
    self.joined = true
    self.host:playerJoin(self.player.id, self.player.name)
    self:update(0)
end

-- Call from love.update. The host clock is love.timer, so `dt` is not needed.
function SG:update(dt)
    self.console.skipText = false
    self.adapter.update()
    self.host:tick(self.adapter.now())
end

function SG:draw()
    self.adapter.draw()
    if self.console.open then self:_drawConsole() end
end

-- Console commands run as the console (source 0); playerCommand runs as the local player.
function SG:command(line) return self:_run(0, line) end
function SG:playerCommand(line) return self:_run(self.player.id, line) end

function SG:_run(source, line)
    local ok, why = self.host:executeCommand(source, line)
    if not ok then self.host:log("warn", "command refused: " .. tostring(why)) end
    return ok, why
end

-- Calls an export. Answers its values when it finished at once, else nil, "pending", promise.
function SG:call(resource, export, side, ...)
    local promise, err = self.host:callExport(resource, export, side or "server", ...)
    if not promise then return nil, err end
    if promise.state == "resolved" then return self.scriptgo.compat.unpack(promise.values, 1, promise.values.n) end
    if promise.state == "rejected" then return nil, promise.reason end
    return nil, "pending", promise
end

-- Raises a host event on a side ("server" or "client") for every started resource.
function SG:emit(side, name, ...) self.host:emit(side, name, ...) end

-- Keys: the console key toggles the console; while it is open it takes every key. Otherwise the
-- key reaches client scripts as the event "love:keypressed" (key, scancode, isrepeat).
-- Returns true when the key was consumed.
function SG:keypressed(key, scancode, isrepeat)
    local c = self.console
    if scancode == c.key or key == c.key then
        c.open = not c.open
        c.skipText = true -- the toggle key's own character
        return true
    end
    if not c.open then
        self.host:emit("client", "love:keypressed", key, scancode, isrepeat and true or false)
        return false
    end
    if key == "return" or key == "kpenter" then
        local line = c.input:gsub("^%s+", ""):gsub("%s+$", "")
        c.input = ""
        if line ~= "" then
            c.history[#c.history + 1] = line
            c.cursor = nil
            self.host:log("info", "> " .. line)
            -- "/cmd" is the local player's chat command; anything else runs as the console.
            if line:sub(1, 1) == "/" then self:playerCommand(line) else self:command(line) end
        end
    elseif key == "backspace" then
        c.input = c.input:gsub("[%z\1-\127\194-\244][\128-\191]*$", "")
    elseif key == "up" and #c.history > 0 then
        c.cursor = math.max(1, (c.cursor or (#c.history + 1)) - 1)
        c.input = c.history[c.cursor]
    elseif key == "escape" then
        c.open = false
    end
    return true
end

function SG:textinput(text)
    local c = self.console
    if not c.open then return false end
    if c.skipText then c.skipText = false; return true end
    c.input = c.input .. text
    return true
end

local INK, CREAM = { 0x11 / 255, 0x11 / 255, 0x11 / 255 }, { 0xF4 / 255, 0xEF / 255, 0xE4 / 255 }
local COBALT, YELLOW = { 0x1F / 255, 0x3F / 255, 0xD1 / 255 }, { 0xFF / 255, 0xD2 / 255, 0x3F / 255 }

function SG:_drawConsole()
    local g = love.graphics
    if not g then return end
    g.push("all")
    local w, h = g.getDimensions()
    local font = g.getFont()
    local lineH = math.floor(font:getHeight() * font:getLineHeight() + 2)
    local ph = math.floor(h * 0.42)
    local top = h - ph
    g.setColor(INK[1], INK[2], INK[3], 0.95)
    g.rectangle("fill", 0, top, w, ph)
    g.setColor(COBALT)
    g.rectangle("fill", 0, top, w, 3)
    local rows = math.floor((ph - lineH * 2 - 16) / lineH)
    local y = h - lineH * 2 - 8
    for i = #self.logs, math.max(1, #self.logs - rows + 1), -1 do
        local e = self.logs[i]
        if e.level == "error" or e.level == "warn" then g.setColor(YELLOW) else g.setColor(CREAM[1], CREAM[2], CREAM[3], 0.8) end
        local text = ("%s  %s"):format(e.origin, e.message:match("^[^\n]*"))
        g.print(text, 12, y)
        y = y - lineH
    end
    g.setColor(COBALT)
    g.print(">", 12, h - lineH - 6)
    g.setColor(CREAM)
    g.print(self.console.input .. ((love.timer and love.timer.getTime() % 1 < 0.5) and "_" or ""), 28, h - lineH - 6)
    g.pop()
end

-- Stops every resource (dependents first) and the HTTP worker. Call from love.quit.
function SG:shutdown()
    if self.closed then return end
    self.closed = true
    if self.joined then self.host:playerDrop(self.player.id, "quit") end
    self.host:stopAll()
    self.host:tick(self.adapter.now())
    self.adapter.shutdown()
end

-- Headless verification -------------------------------------------------------------------------
-- `--scriptgo-verify <resourceDir>` on the command line turns the game into a verifier.
function M.verifyRequested(argv)
    for _, a in ipairs(argv or {}) do if a == "--scriptgo-verify" then return true end end
    return false
end

-- For conf.lua: no window and only the modules the host needs when verifying.
function M.conf(t, argv)
    if not M.verifyRequested(argv) then return false end
    t.identity = "scriptgo_verify"
    t.console = true
    t.window = false
    for _, m in ipairs({ "audio", "font", "graphics", "image", "joystick", "keyboard", "mouse", "physics", "sound", "touch", "video", "window" }) do
        t.modules[m] = false
    end
    return true
end

-- For main.lua: when verifying, installs the verifier's love callbacks and returns true.
function M.verify(argv)
    if not M.verifyRequested(argv) then return false end
    local run = assert(loadChunk(HERE .. "verify.lua"))()
    run(M, argv)
    return true
end

return M
