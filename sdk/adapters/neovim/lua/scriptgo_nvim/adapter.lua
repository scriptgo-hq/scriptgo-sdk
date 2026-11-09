-- Neovim adapter (environment "neovim"): resources run inside the editor process, the server side
-- and the local client (player 1, the person at the keyboard). Clock from vim.uv.hrtime, storage
-- as JSON files under stdpath("data"), notifications through vim.notify, privileges and config
-- from the table given to setup(), and HTTP with curl through vim.system (asynchronous: the editor
-- never blocks on a request).
--
--   local adapter = dofile(".../adapter.lua")(scriptgo, options)   -- scriptgo_nvim.new() does it
--
-- options:
--   config      { permissions = { ["1"] = { "*" } }, resources = { name = { key = value } },
--                 convars = { name = value }, http = false }
--   storageDir  folder of <key>.json files (default stdpath("data")/scriptgo/storage)
--   localPlayerId  the player whose notifications reach vim.notify (default 1)
--   logLevel, quiet, logSink   as the standalone adapter; the ring buffer (adapter.lines, :ScriptGo log)
--               keeps the last 1000 lines even when quiet
--   notify      send notifications to vim.notify (default: when the editor has a UI)
--   curl        curl executable (default "curl"); http = false (here or in config) disables HTTP
return function(scriptgo, opts)
    opts = opts or {}
    local cfg = opts.config or {}
    local uv = vim.uv or vim.loop
    local storageDir = (opts.storageDir or (vim.fn.stdpath("data") .. "/scriptgo/storage")):gsub("\\", "/"):gsub("/+$", "")
    local localPlayerId = opts.localPlayerId or 1
    local headless = #vim.api.nvim_list_uis() == 0
    local toEditor = opts.notify
    if toEditor == nil then toEditor = not headless end

    local function readFile(path)
        local f = io.open(path, "rb")
        if not f then return nil end
        local text = f:read("*a")
        f:close()
        return text
    end

    local function writeFile(path, text)
        local f, err = io.open(path, "wb")
        if not f then return false, err end
        f:write(text)
        f:close()
        return true
    end

    local adapter = {
        environment = "neovim",
        adapterVersion = "neovim-" .. scriptgo.VERSION,
        sides = { server = true, client = true },
        capabilities = {},
        now = function() return uv.hrtime() / 1e9 end,
        notifications = {},
        lines = {},
        storageDir = storageDir,
    }
    for _, c in ipairs(scriptgo.capabilities.ALL) do adapter.capabilities[c] = true end

    local logLevel = { debug = 0, info = 1, warn = 2, error = 3 }
    local minLevel = logLevel[opts.logLevel or "info"] or 1
    local logSink = opts.logSink
    function adapter.log(level, origin, msg)
        if logSink then logSink(level, origin, msg) end
        if (logLevel[level] or 1) < minLevel then return end
        local line = ("[%s] %-28s %s"):format(level, origin, tostring(msg))
        local lines = adapter.lines
        lines[#lines + 1] = line
        if #lines > 1000 then table.remove(lines, 1) end
        if opts.quiet then return end
        if headless then
            io.stdout:write(line, "\n")
            io.stdout:flush()
        elseif level == "warn" or level == "error" then
            vim.notify("SCRIPT//GO " .. origin .. ": " .. tostring(msg), level == "error" and vim.log.levels.ERROR or vim.log.levels.WARN)
        end
    end

    adapter.readFile = readFile

    -- Files under a resource root, relative and with forward slashes (script globs).
    function adapter.listFiles(root)
        local out = {}
        for name, kind in vim.fs.dir(root, { depth = 64 }) do
            if kind == "file" then out[#out + 1] = (name:gsub("\\", "/")) end
        end
        table.sort(out)
        return out
    end

    adapter.storage = {
        load = function(key) return readFile(storageDir .. "/" .. key .. ".json") end,
        save = function(key, text)
            vim.fn.mkdir(storageDir, "p")
            local ok, err = writeFile(storageDir .. "/" .. key .. ".json", text)
            if not ok then adapter.log("error", "neovim", "storage write failed: " .. tostring(err)) end
        end,
    }

    local LEVELS = { error = vim.log.levels.ERROR, warning = vim.log.levels.WARN, warn = vim.log.levels.WARN }
    adapter.ui = {
        notify = function(target, payload)
            local list = adapter.notifications
            list[#list + 1] = { target = target, payload = payload }
            if #list > 200 then table.remove(list, 1) end
            local title = payload.title and (tostring(payload.title) .. ": ") or ""
            adapter.log("info", "ui:" .. tostring(payload.resource) .. "->" .. tostring(target),
                ("[%s] %s%s"):format(payload.type or "info", title, tostring(payload.message or "")))
            -- nil is the local client's own notification (a client-side call).
            if (target == nil or target == -1 or target == localPlayerId) and toEditor then
                vim.notify(title .. tostring(payload.message or ""), LEVELS[tostring(payload.type)] or vim.log.levels.INFO,
                    { title = payload.resource and tostring(payload.resource) or "SCRIPT//GO" })
            end
        end,
    }

    -- config.permissions = { ["1"] = { "*" }, ["2"] = { "command.give" } }
    local perms = cfg.permissions or {}
    adapter.permissions = {
        has = function(playerId, privilege)
            local list = perms[tostring(playerId)]
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
            if resourceName == nil then return (cfg.convars or {})[key] end
            local r = (cfg.resources or {})[resourceName]
            return r and r[key]
        end,
    }

    -- HTTP: curl through vim.system. The request runs in the background; its answer is handed to
    -- the host on the main loop (vim.schedule), and the waiting coroutine resumes on a later tick.
    local curl = opts.curl or "curl"
    if cfg.http == false or opts.http == false then
        adapter.httpUnavailable = "disabled by config"
    elseif type(vim.system) ~= "function" then
        adapter.httpUnavailable = "vim.system is missing (Neovim 0.10 or later is needed)"
    elseif vim.fn.executable(curl) ~= 1 then
        adapter.httpUnavailable = "curl was not found"
    end
    if adapter.httpUnavailable then
        adapter.capabilities.http = false
        adapter.capabilities.licensing = false
    else
        adapter.httpMode = "curl through vim.system (asynchronous)"
        adapter.http = {
            request = function(req, done)
                local argv = { curl, "-s", "-S", "-m", tostring(math.max(1, math.floor((req.timeoutMs or 10000) / 1000))), "-X", req.method or "GET" }
                for k, v in pairs(req.headers or {}) do
                    argv[#argv + 1] = "-H"
                    argv[#argv + 1] = k .. ": " .. tostring(v)
                end
                if req.body then
                    argv[#argv + 1] = "--data-binary"
                    argv[#argv + 1] = "@-"
                end
                -- curl turns the backslash-n of -w into a newline; the status follows the body.
                argv[#argv + 1] = "-w"
                argv[#argv + 1] = "\\n__SG_STATUS__%{http_code}"
                argv[#argv + 1] = req.url
                local ok, err = pcall(vim.system, argv, { text = true, stdin = req.body or false }, function(r)
                    local out = r.stdout or ""
                    local body, status = out:match("^(.*)\n__SG_STATUS__(%d+)$")
                    local code = tonumber(status) or 0
                    -- curl writes 000 when the exchange did not complete (refused, timeout, DNS).
                    vim.schedule(function()
                        done({ status = code, body = body or out, error = code == 0 and "http_failed" or nil })
                    end)
                end)
                if not ok then done({ status = 0, body = "", error = "http_failed: " .. tostring(err) }) end
            end,
        }
    end

    function adapter.shutdown() end

    return adapter
end
