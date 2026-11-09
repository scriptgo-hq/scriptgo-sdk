-- SCRIPT//GO for Neovim. Loads the core and the neovim adapter, adds resources with their
-- dependencies, and runs the server side and the local client (player 1) inside the editor,
-- ticked by a libuv timer on the main loop.
--
--   require("scriptgo_nvim").setup({
--       resources = { "sg_inventory" },              -- names (found in `search`) or folders
--       search = { vim.fn.expand("~/scriptgo/resources") },
--       config = { permissions = { ["1"] = { "*" } } },
--   })
--
-- :ScriptGo status | log | add <dir> | start <name> | stop <name> | <command line>
-- See README.md next to plugin/.
local M = {}
local uv = vim.uv or vim.loop

local function normalize(p) return vim.fs.normalize(tostring(p)) end

local function readFile(path)
    local f = io.open(path, "rb")
    if not f then return nil end
    local text = f:read("*a")
    f:close()
    return text
end

-- This file's folder.
local HERE = (function()
    local src = debug.getinfo(1, "S").source
    return normalize(src:sub(2)):match("^(.*)/") .. "/"
end)()
M.HERE = HERE

-- The core folder (init.lua): opts.core, vim.g.scriptgo_core, the repository layout
-- (sdk/adapters/neovim/lua/scriptgo_nvim -> sdk/lua/scriptgo), or a copy vendored next to this file.
local function findCore(explicit)
    -- explicit and vim.g.scriptgo_core may be nil: a plain loop, not ipairs, which stops at a hole.
    local candidates = { explicit, vim.g.scriptgo_core, HERE .. "../../../../lua/scriptgo", HERE .. "core" }
    for i = 1, 4 do
        local dir = candidates[i]
        if type(dir) == "string" and dir ~= "" then
            dir = normalize(dir):gsub("/+$", "")
            if readFile(dir .. "/init.lua") and readFile(dir .. "/host.lua") then return dir .. "/" end
        end
    end
    return nil
end

local SG = {}
SG.__index = SG

-- opts: resources, search, core, config (table or JSON text), storageDir, player = { id, name },
-- autoStart (true), logLevel, quiet, logSink, notify, curl, http, budgetMs, tickMs (10).
function M.new(opts)
    opts = opts or {}
    local coreDir = findCore(opts.core)
    if not coreDir then error("scriptgo_nvim: the SCRIPT//GO core (init.lua) was not found; pass opts.core or set vim.g.scriptgo_core", 2) end
    local scriptgo = assert(loadfile(coreDir .. "init.lua"))(coreDir, readFile)
    local makeAdapter = assert(loadfile(HERE .. "adapter.lua"))()
    local config = opts.config
    if type(config) == "string" then config = scriptgo.json.decode(config) end
    local self = setmetatable({
        scriptgo = scriptgo,
        player = opts.player or { id = 1, name = (uv.os_get_passwd() or {}).username or "Player" },
        search = {},
        ticks = 0,
        tickMs = opts.tickMs or 10,
    }, SG)
    for _, dir in ipairs(opts.search or {}) do self.search[#self.search + 1] = normalize(dir) end
    self.adapter = makeAdapter(scriptgo, {
        config = config, storageDir = opts.storageDir, localPlayerId = self.player.id,
        logLevel = opts.logLevel, quiet = opts.quiet, logSink = opts.logSink, notify = opts.notify, curl = opts.curl, http = opts.http,
    })
    self.host = scriptgo.newHost({ adapter = self.adapter, localPlayer = self.player, budgetMs = opts.budgetMs })
    for _, ref in ipairs(opts.resources or {}) do
        local res, err = self:add(ref)
        if not res then self.host:log("error", err) end
    end
    if opts.autoStart ~= false then self:start() end
    return self
end

-- Finds a resource folder by name in the search paths.
function SG:locate(name)
    for _, dir in ipairs(self.search) do
        local root = dir .. "/" .. name
        if readFile(root .. "/scriptgo.lua") or readFile(root .. "/open77.lua") then return root end
    end
    return nil
end

-- Adds a resource (a name found in `search`, or a folder) and, recursively, its dependencies.
function SG:add(ref)
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

-- Starts every auto-start resource, then the local player joins and the timer runs.
function SG:start()
    local results = self.host:startAll()
    for name, state in pairs(results) do
        if state ~= "started" then self.host:log("error", name .. ": " .. tostring(state)) end
    end
    self:join()
    self:run()
    return results
end

function SG:join()
    if self.joined then return end
    self.joined = true
    self.host:playerJoin(self.player.id, self.player.name)
    self:update()
end

function SG:update()
    self.ticks = self.ticks + 1
    self.host:tick(self.adapter.now())
end

-- Ticks the host every `ms` (default 10) on the main loop; Wait(0) resumes on the next tick.
function SG:run(ms)
    if self.timer or self.closed then return end
    self.timer = uv.new_timer()
    self.timer:start(0, ms or self.tickMs, vim.schedule_wrap(function()
        if not self.closed then self:update() end
    end))
end

function SG:shutdown()
    if self.closed then return end
    if self.timer then
        self.timer:stop()
        self.timer:close()
        self.timer = nil
    end
    if self.joined then self.host:playerDrop(self.player.id, "quit") end
    self.host:stopAll()
    self.host:tick(self.adapter.now())
    self.closed = true
    self.adapter.shutdown()
end

-- Resource commands typed by the person at the keyboard run as the local player.
function SG:command(line)
    local ok, why = self.host:executeCommand(self.player.id, line)
    if not ok then self.host:log("warn", "/" .. line .. ": " .. tostring(why)) end
    return ok, why
end

function SG:status()
    local out = {}
    for _, name in ipairs(self.host.order) do out[#out + 1] = ("%-24s %s"):format(name, tostring(self.host:resourceState(name))) end
    return out
end

-- The editor-wide instance ------------------------------------------------------------------------
function M.setup(opts)
    if M.instance then M.instance:shutdown() end
    M.instance = M.new(opts)
    vim.api.nvim_create_autocmd("VimLeavePre", {
        group = vim.api.nvim_create_augroup("scriptgo_nvim", { clear = true }),
        callback = function() if M.instance then M.instance:shutdown() end end,
    })
    return M.instance
end

local function scratch(lines)
    vim.cmd("botright new")
    local buf = vim.api.nvim_get_current_buf()
    vim.bo[buf].buftype, vim.bo[buf].bufhidden, vim.bo[buf].swapfile = "nofile", "wipe", false
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
end

-- :ScriptGo <subcommand>
function M.command(args)
    local sg = M.instance
    if not sg then return vim.notify("SCRIPT//GO is not set up: call require('scriptgo_nvim').setup{...}", vim.log.levels.WARN) end
    local verb, rest = (args or ""):match("^%s*(%S*)%s*(.-)%s*$")
    if verb == "" or verb == "status" then
        vim.notify(table.concat(sg:status(), "\n"), vim.log.levels.INFO, { title = "SCRIPT//GO" })
    elseif verb == "log" then
        scratch(vim.deepcopy(sg.adapter.lines))
    elseif verb == "add" then
        local res, err = sg:add(vim.fn.expand(rest))
        if not res then return vim.notify(tostring(err), vim.log.levels.ERROR) end
        sg.host:start(res.name)
    elseif verb == "start" then
        local ok, why = sg.host:start(rest)
        if not ok then vim.notify(tostring(why), vim.log.levels.ERROR) end
    elseif verb == "stop" then
        sg.host:stop(rest, "stopped from the editor")
    else
        sg:command(vim.trim(args))
    end
end

return M
