-- LÖVE adapter (environment "love2d"): resources run inside a LÖVE game, the server side and the
-- local client (player 1) in the game process. Clock from love.timer, storage as JSON files in the
-- save directory, notifications as on-screen toasts (adapter.draw), privileges and config from a
-- table, and HTTP with curl through io.popen in a love.thread worker when io.popen exists.
--
--   local adapter = loadfile("sdk/adapters/love2d/adapter.lua")()(scriptgo, options)
--   -- usually created for you by scriptgo_love.lua
--
-- Paths: an absolute path ("C:/...", "/home/...") is read with io; any other path is a
-- love.filesystem path (the game folder, then the save directory).
--
-- options:
--   config        { permissions = { ["1"] = { "*" } }, resources = { name = { key = value } },
--                   convars = { name = value }, http = false }
--   storageDir    save-directory folder holding <key>.json files (default "scriptgo/storage")
--   localPlayerId the player whose notifications are drawn (default 1)
--   logLevel, quiet, logSink   as the standalone adapter
--   curl          curl executable (default "curl"); http = false (here or in config) disables HTTP
--   httpThread    false: run curl on the main thread, which blocks the frame for the request
--   maxToasts     toasts kept on screen at once (default 5)
return function(scriptgo, opts)
    opts = opts or {}
    local cfg = opts.config or {}
    local lfs = love.filesystem
    local hasIo = type(io) == "table"
    local isWindows = package.config:sub(1, 1) == "\\"
    local storageDir = (opts.storageDir or "scriptgo/storage"):gsub("\\", "/"):gsub("/+$", "")
    local localPlayerId = opts.localPlayerId or 1

    local function isAbsolute(path) return path:match("^%a:/") ~= nil or path:sub(1, 1) == "/" end

    local function readFile(path)
        path = tostring(path):gsub("\\", "/")
        if isAbsolute(path) then
            local f = hasIo and io.open(path, "rb")
            if not f then return nil end
            local text = f:read("*a")
            f:close()
            return text
        end
        if not lfs.getInfo(path, "file") then return nil end
        return (lfs.read(path))
    end

    -- Clock: love.timer when the module is enabled (it is by default).
    local timer = love.timer
    local now = timer and timer.getTime or os.clock
    local sleep = timer and function(ms) timer.sleep(math.max(0, ms) / 1000) end or function() end

    local adapter = {
        environment = "love2d",
        adapterVersion = scriptgo.VERSION,
        capabilities = {},
        now = now,
        sleep = sleep,
        notifications = {},
        toasts = {},
    }
    for _, c in ipairs(scriptgo.capabilities.ALL) do adapter.capabilities[c] = true end
    -- Player perks are not switched on here (one local player, no account to tie a purchase to); the registry says the same (capabilities.lua).
    adapter.capabilities.perks = false

    local logLevel = { debug = 0, info = 1, warn = 2, error = 3 }
    local minLevel = logLevel[opts.logLevel or "info"] or 1
    local logSink = opts.logSink
    function adapter.log(level, origin, msg)
        if logSink then logSink(level, origin, msg) end
        if (logLevel[level] or 1) >= minLevel and not opts.quiet then
            local line = ("[%s] %-28s %s"):format(level, origin, tostring(msg))
            if hasIo and io.write then
                io.write(line, "\n")
                io.flush()
            else
                print(line)
            end
        end
    end

    -- Shell helpers (curl, file listing outside the game folder). cmd.exe strips the first and the
    -- last quote of a command that starts with one, so the whole Windows command is wrapped once.
    local function shellQuote(s)
        if isWindows then return '"' .. tostring(s):gsub('"', '\\"') .. '"' end
        return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
    end
    local function command(text)
        if isWindows then return '"' .. text .. ' 2>NUL"' end
        return text .. " 2>/dev/null"
    end
    local canPopen = hasIo and type(io.popen) == "function"
    local popenRead = isWindows and "rb" or "r"

    adapter.readFile = readFile

    -- Lists files under a resource root, relative and with forward slashes (script globs).
    function adapter.listFiles(root)
        root = root:gsub("\\", "/"):gsub("/+$", "")
        local out = {}
        if not isAbsolute(root) then
            local function walk(dir, rel)
                for _, name in ipairs(lfs.getDirectoryItems(dir)) do
                    local full = dir == "" and name or (dir .. "/" .. name)
                    local relName = rel == "" and name or (rel .. "/" .. name)
                    local info = lfs.getInfo(full)
                    if info and info.type == "directory" then walk(full, relName)
                    elseif info and info.type == "file" then out[#out + 1] = relName end
                end
            end
            walk(root, "")
        elseif not canPopen then
            adapter.log("warn", "love2d", "cannot list " .. root .. " without io.popen: script globs match nothing")
        else
            local cmd, prefix
            if isWindows then
                local p = io.popen(command("cd /d " .. shellQuote((root:gsub("/", "\\"))) .. " && cd"))
                prefix = p and (p:read("*l") or "") or ""
                if p then p:close() end
                prefix = prefix:gsub("\r$", "")
                if prefix == "" then return out end
                cmd = command("dir /s /b /a-d " .. shellQuote(prefix))
                prefix = prefix:gsub("\\", "/"):gsub("/$", "") .. "/"
            else
                cmd = command("find " .. shellQuote(root) .. " -type f")
                prefix = root .. "/"
            end
            local p = io.popen(cmd)
            if p then
                for line in p:lines() do
                    local path = line:gsub("\\", "/"):gsub("\r$", "")
                    if path:sub(1, #prefix):lower() == prefix:lower() then out[#out + 1] = path:sub(#prefix + 1) end
                end
                p:close()
            end
        end
        table.sort(out)
        return out
    end

    -- Storage: one JSON file per key (resource, or resource.client) in the save directory.
    adapter.storage = {
        load = function(key)
            local path = storageDir .. "/" .. key .. ".json"
            if not lfs.getInfo(path, "file") then return nil end
            return (lfs.read(path))
        end,
        save = function(key, text)
            lfs.createDirectory(storageDir)
            local ok, err = lfs.write(storageDir .. "/" .. key .. ".json", text)
            if not ok then adapter.log("error", "love2d", "storage write failed: " .. tostring(err)) end
        end,
    }

    -- Notifications: logged always; drawn as toasts by adapter.draw() when they target the local
    -- player or everyone. Without love.graphics (headless) they are only logged.
    local maxToasts = opts.maxToasts or 5
    adapter.ui = {
        notify = function(target, payload)
            local list = adapter.notifications
            list[#list + 1] = { target = target, payload = payload }
            if #list > 200 then table.remove(list, 1) end
            local title = payload.title and (payload.title .. ": ") or ""
            adapter.log("info", "ui:" .. tostring(payload.resource) .. "->" .. tostring(target),
                ("[%s] %s%s"):format(payload.type or "info", title, tostring(payload.message or "")))
            if target == -1 or target == localPlayerId then
                local ms = tonumber(payload.durationMs) or 4000
                adapter.toasts[#adapter.toasts + 1] = {
                    kind = tostring(payload.type or "info"),
                    title = payload.title and tostring(payload.title) or nil,
                    message = tostring(payload.message or ""),
                    born = now(), duration = math.max(0.5, math.min(ms, 30000)) / 1000,
                }
                while #adapter.toasts > maxToasts do table.remove(adapter.toasts, 1) end
            end
        end,
    }

    local INK, CREAM = { 0x11 / 255, 0x11 / 255, 0x11 / 255 }, { 0xF4 / 255, 0xEF / 255, 0xE4 / 255 }
    local COBALT, YELLOW = { 0x1F / 255, 0x3F / 255, 0xD1 / 255 }, { 0xFF / 255, 0xD2 / 255, 0x3F / 255 }
    local STRIPE = { warn = YELLOW, warning = YELLOW, error = YELLOW }

    -- Draws the toast stack (newest on top), top-right by default. Call it last in love.draw.
    function adapter.draw(x, y, width)
        local g = love.graphics
        if not g then return end
        local t, toasts = now(), adapter.toasts
        for i = #toasts, 1, -1 do
            if t - toasts[i].born > toasts[i].duration then table.remove(toasts, i) end
        end
        if #toasts == 0 then return end
        g.push("all")
        local font = g.getFont()
        local lineH = font:getHeight() * font:getLineHeight()
        width = width or 340
        x = x or (g.getWidth() - width - 16)
        y = y or 16
        local pad = 12
        for i = #toasts, 1, -1 do
            local toast = toasts[i]
            local age = t - toast.born
            local alpha = math.max(0, math.min(1, (toast.duration - age) / 0.25, age / 0.12))
            local _, lines = font:getWrap(toast.message, width - pad * 2 - 6)
            local h = pad * 2 + #lines * lineH + (toast.title and lineH + 2 or 0)
            g.setColor(INK[1], INK[2], INK[3], 0.94 * alpha)
            g.rectangle("fill", x, y, width, h, 3, 3)
            local s = STRIPE[toast.kind] or COBALT
            g.setColor(s[1], s[2], s[3], alpha)
            g.rectangle("fill", x, y, 5, h)
            local ty = y + pad
            if toast.title then
                local tc = (s == COBALT) and CREAM or s -- cobalt is too dark for text on ink
                g.setColor(tc[1], tc[2], tc[3], alpha)
                g.print(toast.title, x + pad + 6, ty)
                ty = ty + lineH + 2
            end
            g.setColor(CREAM[1], CREAM[2], CREAM[3], 0.86 * alpha)
            g.printf(toast.message, x + pad + 6, ty, width - pad * 2 - 6)
            y = y + h + 8
        end
        g.pop()
    end

    -- config.permissions = { ["1"] = { "*" }, ["2"] = { "command.give" } }
    local perms = cfg.permissions or {}
    adapter.permissions = {
        has = function(playerId, privilege)
            local list = perms[tostring(playerId)] or perms[playerId]
            if type(list) ~= "table" then return false end
            for _, p in ipairs(list) do
                if p == "*" or p == privilege then return true end
                if p:sub(-2) == ".*" and privilege:sub(1, #p - 1) == p:sub(1, -2) then return true end
            end
            return false
        end,
    }

    -- config.resources = { name = { key = value } }, config.convars = { name = value }
    adapter.config = {
        get = function(resourceName, key)
            if resourceName == nil then
                local cv = cfg.convars or {}
                return cv[key]
            end
            local r = (cfg.resources or {})[resourceName]
            return r and r[key]
        end,
    }

    -- HTTP through curl. Off when disabled, when io.popen is missing, or when curl does not answer.
    local curl = opts.curl or "curl"
    adapter.httpMode = nil
    if cfg.http == false or opts.http == false then
        adapter.httpUnavailable = "disabled by config"
    elseif not canPopen then
        adapter.httpUnavailable = "io.popen is not available"
    else
        local p = io.popen(command(shellQuote(curl) .. " --version"))
        local out = p and p:read("*a") or ""
        if p then p:close() end
        if not out:find("^curl") then adapter.httpUnavailable = "curl did not answer" end
    end
    if adapter.httpUnavailable then
        adapter.capabilities.http = false
        adapter.capabilities.licensing = false
    end

    local function curlCommand(req, bodyPath)
        local parts = { shellQuote(curl), "-s", "-S", "-m", tostring(math.max(1, math.floor((tonumber(req.timeoutMs) or 10000) / 1000))) }
        parts[#parts + 1] = "-X " .. shellQuote(req.method or "GET")
        for k, v in pairs(req.headers or {}) do parts[#parts + 1] = "-H " .. shellQuote(k .. ": " .. tostring(v)) end
        if bodyPath then parts[#parts + 1] = "--data-binary @" .. shellQuote(bodyPath) end
        -- "\\n" reaches curl as the two characters \n, which its -w format turns into a newline.
        parts[#parts + 1] = "-w " .. shellQuote("\\n__SG_STATUS__%{http_code}")
        parts[#parts + 1] = shellQuote(req.url)
        return command(table.concat(parts, " "))
    end

    local function parseCurl(out, err)
        if err then return { status = 0, body = "", error = err } end
        local body, status = (out or ""):match("^(.*)\n__SG_STATUS__(%d+)$")
        if not status then return { status = 0, body = out or "", error = "curl_failed" } end
        status = tonumber(status) or 0
        if status == 0 then return { status = 0, body = body, error = "connection_failed" } end
        return { status = status, body = body }
    end

    -- The worker runs curl so the game keeps drawing while a request is in flight.
    local WORKER = [[
local jobs, results, mode = ...
while true do
    local job = jobs:demand()
    if job == "stop" then return end
    local ok, out = pcall(function()
        if job.bodyPath then
            local f = assert(io.open(job.bodyPath, "wb"))
            f:write(job.body or "")
            f:close()
        end
        local p = io.popen(job.cmd, mode)
        local text = p and p:read("*a") or ""
        if p then p:close() end
        if job.bodyPath then os.remove(job.bodyPath) end
        return text
    end)
    results:push({ id = job.id, out = ok and out or "", err = (not ok) and tostring(out) or nil })
end
]]
    local worker, jobs, results
    local pending, nextId = {}, 0
    local useThread = opts.httpThread ~= false and love.thread ~= nil

    local function bodyFile(id)
        lfs.createDirectory("scriptgo/tmp")
        return lfs.getSaveDirectory():gsub("\\", "/") .. "/scriptgo/tmp/http-" .. id .. ".body"
    end

    adapter.http = {
        request = function(req, done)
            if adapter.capabilities.http == false then
                done({ status = 0, body = "", error = "http_unavailable" })
                return
            end
            nextId = nextId + 1
            local id = nextId
            local bodyPath = req.body and bodyFile(id) or nil
            local cmd = curlCommand(req, bodyPath)
            if useThread then
                if not worker then
                    jobs, results = love.thread.newChannel(), love.thread.newChannel()
                    worker = love.thread.newThread(WORKER)
                    worker:start(jobs, results, popenRead)
                end
                pending[id] = done
                jobs:push({ id = id, cmd = cmd, body = req.body and tostring(req.body) or nil, bodyPath = bodyPath })
                return
            end
            -- Main-thread fallback: blocks the frame until curl returns.
            if bodyPath then
                local f = io.open(bodyPath, "wb")
                if f then f:write(tostring(req.body)); f:close() end
            end
            local p = io.popen(cmd, popenRead)
            local out = p and p:read("*a") or ""
            if p then p:close() end
            if bodyPath then os.remove(bodyPath) end
            done(parseCurl(out))
        end,
    }
    if not adapter.httpUnavailable then
        adapter.httpMode = useThread and "curl through io.popen in a love.thread worker" or "curl through io.popen on the main thread (blocking)"
    end

    -- Call once per frame (scriptgo_love does): delivers finished HTTP requests.
    function adapter.update()
        if not results then return end
        while true do
            local r = results:pop()
            if not r then break end
            local done = pending[r.id]
            pending[r.id] = nil
            if done then done(parseCurl(r.out, r.err)) end
        end
        local werr = worker and worker:getError()
        if werr then
            for id, done in pairs(pending) do
                pending[id] = nil
                done({ status = 0, body = "", error = "http_worker_failed: " .. tostring(werr) })
            end
            worker = nil
        end
    end

    function adapter.shutdown()
        if worker and jobs then jobs:push("stop") end
    end

    -- A single local player, kept by the host (players.list/name/identifier).
    adapter.players = nil

    return adapter
end
