-- CC: Tweaked adapter (environment "cctweaked"): SCRIPT//GO resources on one ComputerCraft computer
-- in a Minecraft world. The server side and the local client (player 1, whoever is at the
-- computer's terminal) both run on the computer, as on LÖVE and Neovim; network events between them
-- are looped back through the value codec by the core.
--
--   local adapter = dofile("/scriptgo/adapter.lua")(scriptgo, options)   -- sg.lua does it
--
-- options:
--   config       { permissions = { ["1"] = { "*" } }, resources = { name = { key = value } },
--                  convars = { name = value }, http = false }      (/scriptgo/config.json)
--   dataDir      folder of <key>.json storage files (default /scriptgo/data)
--   out          function(line, colour) that shows a line on the terminal (default print)
--   localPlayerId  the player whose notifications reach the terminal (default 1)
--   logLevel, quiet, logSink   as the other adapters; adapter.lines keeps the last 500 lines
--
-- What CC: Tweaked provides and how it maps:
--   clock        os.clock(): the computer's uptime, advanced by server ticks (20 per second)
--   wall clock   os.epoch("utc"): os.time() is the in-game hour on CC: Tweaked, not Unix time
--   files        fs (the computer's own disk, limited by the server's computer_space_limit)
--   HTTP         the http API, asynchronous: http.request now, http_success / http_failure later.
--                The server owner's [[http.rules]] decide which hosts answer.
--   licensing    deliberately off (see sdk/adapters/cctweaked/README.md, "Licensing").
return function(scriptgo, opts)
    opts = opts or {}
    local cfg = opts.config or {}
    local json = scriptgo.json
    local dataDir = (opts.dataDir or "/scriptgo/data"):gsub("/+$", "")
    local localPlayerId = opts.localPlayerId or 1
    local out = opts.out or function(line) print(line) end

    local function readFile(path)
        local h = fs.open(path, "rb")
        if not h then return nil end
        local text = h.readAll() or ""
        h.close()
        return text
    end

    local function writeFile(path, text)
        local dir = fs.getDir(path)
        if dir ~= "" and not fs.exists(dir) then fs.makeDir(dir) end
        local h, err = fs.open(path, "wb")
        if not h then return false, err end
        h.write(text)
        h.close()
        return true
    end

    local adapter = {
        environment = "cctweaked",
        adapterVersion = "cctweaked-" .. scriptgo.VERSION,
        sides = { server = true, client = true },
        capabilities = {},
        now = function() return os.clock() end,
        wallTime = function() return math.floor(os.epoch("utc") / 1000) end,
        notifications = {},
        lines = {},
        dataDir = dataDir,
        readFile = readFile,
        writeFile = writeFile,
    }
    for _, c in ipairs(scriptgo.capabilities.ALL) do adapter.capabilities[c] = true end
    -- Player perks are not switched on here (for the reason licensing is off); the registry says the same (capabilities.lua).
    adapter.capabilities.perks = false

    -- Logging --------------------------------------------------------------------------------------
    local logLevel = { debug = 0, info = 1, warn = 2, error = 3 }
    local minLevel = logLevel[opts.logLevel or "info"] or 1
    local COLOURS = { warn = colours and colours.orange, error = colours and colours.red }
    function adapter.log(level, origin, msg)
        if opts.logSink then opts.logSink(level, origin, msg) end
        if (logLevel[level] or 1) < minLevel then return end
        local line = ("[%s] %s %s"):format(level, origin, tostring(msg))
        local lines = adapter.lines
        lines[#lines + 1] = line
        if #lines > 500 then table.remove(lines, 1) end
        if not opts.quiet then out(line, COLOURS[level]) end
    end

    -- Files ----------------------------------------------------------------------------------------
    -- Files under a resource root, relative and with forward slashes (script globs).
    function adapter.listFiles(root)
        local found = {}
        local function walk(dir, prefix)
            for _, name in ipairs(fs.list(dir)) do
                local p = fs.combine(dir, name)
                if fs.isDir(p) then
                    if name:sub(1, 1) ~= "." then walk(p, prefix .. name .. "/") end
                else
                    found[#found + 1] = prefix .. name
                end
            end
        end
        if fs.isDir(root) then walk(root, "") end
        table.sort(found)
        return found
    end

    adapter.storage = {
        load = function(key) return readFile(dataDir .. "/" .. key .. ".json") end,
        save = function(key, text)
            local ok, err = writeFile(dataDir .. "/" .. key .. ".json", text)
            -- A full disk (computer_space_limit) is the usual cause.
            if not ok then adapter.log("error", "cctweaked", "storage write failed: " .. tostring(err)) end
        end,
    }

    -- Notifications: a line on the terminal for the local player (or everyone), always logged.
    local NOTE_COLOURS = { error = colours and colours.red, warning = colours and colours.orange, warn = colours and colours.orange, success = colours and colours.lime }
    adapter.ui = {
        notify = function(target, payload)
            local list = adapter.notifications
            list[#list + 1] = { target = target, payload = payload }
            if #list > 100 then table.remove(list, 1) end
            local title = payload.title and (tostring(payload.title) .. ": ") or ""
            local text = title .. tostring(payload.message or "")
            if opts.logSink then opts.logSink("info", "ui:" .. tostring(payload.resource) .. "->" .. tostring(target), text) end
            -- nil is the local client's own notification (a client-side call).
            if target == nil or target == -1 or target == localPlayerId then
                out("* " .. text, NOTE_COLOURS[tostring(payload.type)] or (colours and colours.yellow))
            end
        end,
    }

    -- config.permissions = { ["1"] = { "*" }, ["2"] = { "command.give", "shop.*" } }
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

    -- config.resources = { name = { key = value } }; convars from config.convars, then the
    -- computer's own settings (`set <key> <value>` in the shell).
    adapter.config = {
        get = function(resourceName, key)
            if resourceName == nil then
                local v = (cfg.convars or {})[key]
                if v ~= nil then return v end
                if settings and settings.get then return settings.get(key) end
                return nil
            end
            local r = (cfg.resources or {})[resourceName]
            return r and r[key]
        end,
    }

    -- HTTP -----------------------------------------------------------------------------------------
    -- CC: Tweaked answers a request with an event naming its URL only. Each request gets a unique
    -- fragment (#sg-<n>): the fragment is never sent to the server, and the event gives it back,
    -- so answers to the same URL cannot be swapped.
    local pending, seq = {}, 0
    if cfg.http == false then
        adapter.httpUnavailable = "disabled by config"
    elseif type(http) ~= "table" or type(http.request) ~= "function" then
        adapter.httpUnavailable = "the http API is disabled on this server (http.enabled in computercraft-server.toml)"
    end
    -- Licensing stays off on purpose, even with HTTP: see README.md, "Licensing".
    adapter.capabilities.licensing = false
    if adapter.httpUnavailable then
        adapter.capabilities.http = false
    else
        adapter.httpMode = "the CC: Tweaked http API (asynchronous, the server's http.rules apply)"
        adapter.http = {
            request = function(req, done)
                seq = seq + 1
                local url = tostring(req.url):gsub("#.*$", "") .. "#sg-" .. seq
                local headers = {}
                for k, v in pairs(req.headers or {}) do headers[k] = tostring(v) end
                local ok, err = http.request({
                    url = url, method = req.method or "GET", body = req.body, headers = headers,
                    binary = true, redirect = false, timeout = (req.timeoutMs or 10000) / 1000,
                })
                if ok == false then
                    done({ status = 0, body = "", error = "http_failed: " .. tostring(err) })
                    return
                end
                pending[url] = done
            end,
        }
    end

    local function answer(done, handle)
        local status = handle.getResponseCode and handle.getResponseCode() or 0
        local body = handle.readAll and handle.readAll() or ""
        local headers = handle.getResponseHeaders and handle.getResponseHeaders() or {}
        handle.close()
        done({ status = status, body = body or "", headers = headers })
    end

    -- sg.lua hands every CC event here; true when it was an answer to one of our requests.
    function adapter.onEvent(name, a, b, c)
        if name ~= "http_success" and name ~= "http_failure" then return false end
        local done = pending[a]
        if not done then return false end
        pending[a] = nil
        if name == "http_success" then
            answer(done, b)
        elseif type(c) == "table" then
            answer(done, c) -- an HTTP error status still has a response
        else
            done({ status = 0, body = "", error = "http_failed: " .. tostring(b) })
        end
        return true
    end

    function adapter.pendingRequests()
        local n = 0
        for _ in pairs(pending) do n = n + 1 end
        return n
    end

    function adapter.shutdown()
        for url, done in pairs(pending) do
            pending[url] = nil
            done({ status = 0, body = "", error = "http_failed: the host stopped" })
        end
    end

    adapter.json = json
    return adapter
end
