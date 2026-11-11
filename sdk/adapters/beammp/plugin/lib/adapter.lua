-- BeamMP adapter: SCRIPT//GO resources inside one BeamMP server plugin (BeamMP-Server 3.x, Lua 5.3).
--
--   local adapter, api = loadAdapter()(scriptgo, { pluginDir = ..., config = ..., logSink = ... })
--
-- Everything here goes through the host's own Lua API: MP.* (events, timers, players, chat,
-- notifications), FS.* (directories, listing, rename) and Util.* (logging), plus the standard io
-- library BeamMP opens for plugins (file reads and writes) and io.popen/os.execute for curl.
--
-- BeamMP specifics:
--   - Plugins are server-side; there is no client half here (BeamNG.drive client mods are out of
--     scope), so only the server side of a resource runs.
--   - BeamMP player ids start at 0; SCRIPT//GO reserves 0 for the console. A BeamMP id `n` is the
--     SCRIPT//GO player `n + 1`, both ways, everywhere in this adapter.
--   - MP.CreateTimer() is the monotonic clock (seconds as a 32-bit float, so it is rebased every
--     1000 s to keep sub-millisecond precision).
--   - BeamMP's own Http.CreateConnection(...):Get() discards the response and has no POST, so
--     ScriptGo.http (and licensing) runs curl in the background and polls its result files on
--     each tick: a request never blocks the plugin's Lua state.
return function(scriptgo, opts)
    opts = opts or {}
    local json = scriptgo.json
    local cfg = opts.config or {}
    local pluginDir = (opts.pluginDir or "Resources/Server/scriptgo"):gsub("\\", "/")
    local dataDir = (type(cfg.dataDir) == "string" and cfg.dataDir or (pluginDir .. "/data")):gsub("\\", "/")
    local isWindows = package and package.config and package.config:sub(1, 1) == "\\"

    local adapter = {
        environment = "beammp",
        adapterVersion = "beammp-0.1.0",
        sides = { server = true },
        capabilities = {
            events = true, logging = true, storage = true, players = true, permissions = true,
            commands = true, config = true, ui = true, http = false, licensing = false,
        },
        notifications = {},
    }
    local api = { json = json, dataDir = dataDir }

    -- Files ------------------------------------------------------------------------------------------
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

    local function ensureDir(dir)
        if FS.Exists(dir) then return true end
        local ok, err = FS.CreateDirectory(dir)
        if not ok then return false, err end
        return true
    end

    api.readFile, api.writeFile, api.ensureDir = readFile, writeFile, ensureDir
    adapter.readFile = readFile

    -- FS.ListFiles / FS.ListDirectories list one level, names only, or nil when the folder is missing.
    adapter.listFiles = function(root)
        local out = {}
        local function walk(dir, prefix)
            local files = FS.ListFiles(dir) or {}
            for _, name in ipairs(files) do out[#out + 1] = prefix .. (tostring(name):gsub("\\", "/")) end
            for _, name in ipairs(FS.ListDirectories(dir) or {}) do
                name = tostring(name):gsub("\\", "/")
                if name:sub(1, 1) ~= "." then walk(dir .. "/" .. name, prefix .. name .. "/") end
            end
        end
        walk(root, "")
        table.sort(out)
        return out
    end

    -- Clock ------------------------------------------------------------------------------------------
    local timer = MP.CreateTimer()
    local base = 0
    adapter.now = function()
        local t = timer:GetCurrent()
        if t > 1000 then
            base = base + t
            timer:Start()
            t = 0
        end
        return base + t
    end

    -- Logging ----------------------------------------------------------------------------------------
    local LOG = { debug = "LogDebug", info = "LogInfo", warn = "LogWarn", error = "LogError" }
    adapter.log = function(level, origin, msg)
        local fn = Util[LOG[level] or "LogInfo"] or print
        fn("[scriptgo] " .. tostring(origin) .. " " .. tostring(msg))
        if opts.logSink then opts.logSink({ level = level, origin = origin, message = msg }) end
    end

    -- Storage: one JSON document per resource side, <dataDir>/storage/<key>.json, written to a
    -- temporary file and renamed over the old one so a crash never leaves half a document.
    local function storageFile(key) return dataDir .. "/storage/" .. tostring(key):gsub("[^%w_%.%-]", "_") .. ".json" end
    adapter.storage = {
        load = function(key) return readFile(storageFile(key)) end,
        save = function(key, text)
            local ok, err = ensureDir(dataDir .. "/storage")
            if not ok then
                adapter.log("error", "storage", "cannot create " .. dataDir .. "/storage: " .. tostring(err))
                return
            end
            local final = storageFile(key)
            local tmp = final .. ".tmp"
            local wrote, werr = writeFile(tmp, text)
            if not wrote then
                adapter.log("error", "storage", "cannot write " .. tmp .. ": " .. tostring(werr))
                return
            end
            local renamed = FS.Rename(tmp, final)
            if not renamed then
                -- Some platforms refuse to rename over an existing file: replace it in two steps.
                FS.Remove(final)
                if not FS.Rename(tmp, final) then writeFile(final, text) end
            end
        end,
    }

    -- Players ----------------------------------------------------------------------------------------
    local function beamId(id)
        if type(id) ~= "number" or id < 1 or id ~= math.floor(id) then return nil end
        return math.floor(id) - 1
    end
    api.toScriptGo = function(pid) return pid + 1 end
    api.toBeamMP = beamId

    local function nameOf(id)
        local pid = beamId(id)
        if not pid then return nil end
        local name = MP.GetPlayerName(pid)
        if type(name) ~= "string" or name == "" then return nil end
        return name
    end

    adapter.players = {
        list = function()
            local ids = {}
            for pid in pairs(MP.GetPlayers() or {}) do
                if type(pid) == "number" then ids[#ids + 1] = pid + 1 end
            end
            table.sort(ids)
            return ids
        end,
        name = nameOf,
        -- beammp:<account id> for players logged in to BeamMP; guests (when the server allows
        -- them) have no account, so they get a name-based identifier that is not stable.
        identifier = function(id)
            local pid = beamId(id)
            local name = nameOf(id)
            if not pid or not name then return nil end
            local ids = MP.GetPlayerIdentifiers(pid)
            if type(ids) == "table" and ids.beammp ~= nil and tostring(ids.beammp) ~= "" then
                return "beammp:" .. tostring(ids.beammp)
            end
            return "beammp-guest:" .. name:lower():gsub("[^%w_%-]", "_")
        end,
        -- The player's address, for player match only (docs/spec/player-match.md): the core hashes it
        -- and never sends or logs it. Not visible to scripts. Presence is not switched on here
        -- (BeamMP's Lua has no HMAC), so nothing reads it yet.
        address = function(id)
            local pid = beamId(id)
            if not pid then return nil end
            local ids = MP.GetPlayerIdentifiers(pid)
            return type(ids) == "table" and type(ids.ip) == "string" and ids.ip or nil
        end,
    }

    -- Permissions: BeamMP has no server-side roles, so grants come from scriptgo.json, keyed by
    -- identifier ("beammp:<account id>") or, for players logged in to BeamMP, by player name:
    -- { "permissions": { "beammp:123456": ["*"], "Ada": ["command.giveitem", "shop.*"] } }.
    local grants = type(cfg.permissions) == "table" and cfg.permissions or {}
    local function granted(list, privilege)
        if type(list) ~= "table" then return false end
        for _, p in ipairs(list) do
            if p == "*" or p == privilege then return true end
            if type(p) == "string" and p:sub(-2) == ".*" and privilege:sub(1, #p - 1) == p:sub(1, -2) then return true end
        end
        return false
    end
    adapter.permissions = {
        has = function(id, privilege)
            local pid = beamId(id)
            if not pid or not nameOf(id) then return false end
            local ident = adapter.players.identifier(id)
            if ident and granted(grants[ident], privilege) then return true end
            if not MP.IsPlayerGuest(pid) and granted(grants[nameOf(id)], privilege) then return true end
            return false
        end,
    }

    -- Config: scriptgo.json { "resources": { "<name>": { key: value } }, "convars": { key: value } }.
    adapter.config = {
        get = function(resourceName, key)
            if resourceName == nil then
                local v = (type(cfg.convars) == "table" and cfg.convars or {})[key]
                return v
            end
            local r = (type(cfg.resources) == "table" and cfg.resources or {})[resourceName]
            return type(r) == "table" and r[key] or nil
        end,
    }

    -- Notifications: MP.SendNotification (a toast in the BeamMP client UI), or a chat line on
    -- servers that predate it. -1 reaches every player.
    adapter.ui = {
        notify = function(target, payload)
            adapter.notifications[#adapter.notifications + 1] = { target = target, payload = payload }
            local title = payload.title or payload.resource or "notice"
            local line = "[" .. tostring(title) .. "] " .. tostring(payload.message or "")
            local pid = target == -1 and -1 or beamId(target)
            if pid == nil then return end
            if MP.SendNotification then
                MP.SendNotification(pid, line)
            else
                MP.SendChatMessage(pid, line)
            end
        end,
    }

    -- HTTP: curl in the background ------------------------------------------------------------------
    local function hasCurl()
        if not io.popen then return false end
        local ok, p = pcall(io.popen, isWindows and "curl --version 2>NUL" or "curl --version 2>/dev/null")
        if not ok or not p then return false end
        local out = p:read("*a") or ""
        p:close()
        return out:find("^curl") ~= nil
    end

    local httpOn = cfg.http ~= false and os.execute ~= nil and hasCurl()
    adapter.capabilities.http = httpOn
    adapter.capabilities.licensing = httpOn

    local allowed = nil
    if type(cfg.httpAllowedHosts) == "table" then
        allowed = {}
        for _, h in ipairs(cfg.httpAllowedHosts) do allowed[tostring(h):lower()] = true end
    end
    local function hostOf(url) return (tostring(url):match("^%a[%w+.-]*://([^/:?#]+)") or ""):lower() end

    local pending, seq, httpDir = {}, 0, dataDir .. "/http"
    local runId = tostring(os.time()) .. "-" .. tostring(math.random(100000, 999999))

    local function shq(s)
        if isWindows then return '"' .. tostring(s):gsub("%%", "%%%%") .. '"' end
        return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
    end
    local function native(p) return isWindows and p:gsub("/", "\\") or p end

    local function finish(id, response)
        local r = pending[id]
        pending[id] = nil
        for _, f in ipairs({ r.req, r.body, r.head, r.err, r.code, r.script }) do os.remove(f) end
        local ok, err = pcall(r.done, response)
        if not ok then adapter.log("error", "http", "response handler raised: " .. tostring(err)) end
    end

    local function parseHead(text)
        local status, headers = 0, {}
        -- The last response block wins (an interim 100 Continue comes first).
        for line in (text or ""):gmatch("[^\r\n]+") do
            local code = line:match("^HTTP/%S+%s+(%d%d%d)")
            if code then
                status, headers = tonumber(code), {}
            else
                local k, v = line:match("^([^:]+):%s*(.-)%s*$")
                if k then headers[k:lower()] = v end
            end
        end
        return status, headers
    end

    -- Called on every tick: completes the requests whose curl has finished.
    api.pump = function(now)
        for id, r in pairs(pending) do
            local codeText = readFile(r.code)
            local exitCode = codeText and tonumber(codeText:match("(%d+)"))
            if exitCode then
                local status, headers = parseHead(readFile(r.head))
                if exitCode ~= 0 or status == 0 then
                    local why = exitCode == 28 and "timeout" or "http_failed"
                    finish(id, { status = 0, body = "", headers = {}, error = why })
                else
                    finish(id, { status = status, body = readFile(r.body) or "", headers = headers })
                end
            elseif now and now > r.deadline then
                finish(id, { status = 0, body = "", headers = {}, error = "timeout" })
            end
        end
    end

    if httpOn then
        adapter.http = {
            request = function(req, done)
                local url = tostring(req.url or "")
                if not url:match("^https?://") then return done({ status = 0, body = "", error = "invalid_url" }) end
                if allowed and not allowed[hostOf(url)] then return done({ status = 0, body = "", error = "host_not_allowed" }) end
                local okDir, derr = ensureDir(httpDir)
                if not okDir then return done({ status = 0, body = "", error = "http_failed: " .. tostring(derr) }) end
                seq = seq + 1
                local stem = httpDir .. "/" .. runId .. "-" .. seq
                local r = {
                    req = stem .. ".req", body = stem .. ".body", head = stem .. ".head", err = stem .. ".err",
                    code = stem .. ".code", script = stem .. (isWindows and ".cmd" or ".sh"), done = done,
                }
                local seconds = math.max(1, math.floor((req.timeoutMs or 10000) / 1000))
                local parts = { "curl -s -S -m " .. seconds, "-X " .. shq(req.method or "GET") }
                for k, v in pairs(req.headers or {}) do
                    local h = tostring(k) .. ": " .. tostring(v)
                    if h:find('["\r\n]') then return done({ status = 0, body = "", error = "invalid_header" }) end
                    parts[#parts + 1] = "-H " .. shq(h)
                end
                if url:find('["\r\n]') then return done({ status = 0, body = "", error = "invalid_url" }) end
                if req.body ~= nil then
                    writeFile(r.req, tostring(req.body))
                    parts[#parts + 1] = "--data-binary @" .. shq(native(r.req))
                end
                parts[#parts + 1] = "-o " .. shq(native(r.body))
                parts[#parts + 1] = "-D " .. shq(native(r.head))
                parts[#parts + 1] = shq(url)
                local curl = table.concat(parts, " ") .. " 2>" .. shq(native(r.err))
                local script
                if isWindows then
                    -- The exit code lands in .code last: its presence means curl has finished.
                    -- (Redirection first: "echo 0>file" would redirect handle 0.)
                    script = "@echo off\r\n" .. curl .. "\r\n>" .. shq(native(r.code) .. ".tmp") .. " echo %ERRORLEVEL%"
                        .. "\r\nmove /y " .. shq(native(r.code) .. ".tmp") .. " " .. shq(native(r.code)) .. " >NUL\r\n"
                else
                    script = curl .. "\necho $? > " .. shq(r.code .. ".tmp") .. " && mv " .. shq(r.code .. ".tmp") .. " " .. shq(r.code) .. "\n"
                end
                writeFile(r.script, script)
                r.deadline = adapter.now() + seconds + 15
                pending[seq] = r
                if isWindows then
                    os.execute('start "" /B cmd /C "' .. native(r.script) .. '" >NUL 2>NUL')
                else
                    os.execute("sh " .. shq(r.script) .. " >/dev/null 2>&1 &")
                end
            end,
        }
    end

    api.pendingHttp = function()
        local n = 0
        for _ in pairs(pending) do n = n + 1 end
        return n
    end

    return adapter, api
end
