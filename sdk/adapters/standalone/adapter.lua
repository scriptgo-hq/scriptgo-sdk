-- Standalone adapter: a command-line host on plain Lua (5.1, 5.4 or LuaJIT). It reads resources
-- from disk, persists storage as JSON files, prints notifications, takes privileges and config
-- from a JSON file, and performs HTTP with the system curl when allowed.
--
--   local adapter = dofile("sdk/adapters/standalone/adapter.lua")(scriptgo, options)
return function(scriptgo, opts)
    opts = opts or {}
    local json = scriptgo.json
    local dataDir = (opts.dataDir or ".scriptgo-data"):gsub("\\", "/")
    local cfg = opts.config or {}
    local isWindows = package.config:sub(1, 1) == "\\"

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
        if readFile(dir .. "/.keep") then return end
        if isWindows then
            os.execute('mkdir "' .. dir:gsub("/", "\\") .. '" >NUL 2>NUL')
        else
            os.execute("mkdir -p '" .. dir .. "' 2>/dev/null")
        end
        writeFile(dir .. "/.keep", "")
    end

    -- Wall clock: LuaJIT FFI when present, else os.clock (CPU time; the run loop busy-waits so it
    -- tracks wall time closely enough for a console host).
    local now, sleep
    local okFfi, ffi = pcall(require, "ffi")
    if okFfi and type(ffi) == "table" then
        if isWindows then
            pcall(ffi.cdef, [[
                int QueryPerformanceCounter(int64_t *c);
                int QueryPerformanceFrequency(int64_t *f);
                void Sleep(uint32_t ms);
            ]])
            local freq = ffi.new("int64_t[1]")
            ffi.C.QueryPerformanceFrequency(freq)
            local f = tonumber(freq[0])
            local c = ffi.new("int64_t[1]")
            now = function() ffi.C.QueryPerformanceCounter(c) return tonumber(c[0]) / f end
            sleep = function(ms) ffi.C.Sleep(math.max(0, math.floor(ms))) end
        else
            pcall(ffi.cdef, [[
                typedef struct { long tv_sec; long tv_nsec; } sg_timespec;
                int clock_gettime(int clk, sg_timespec *tp);
                int usleep(unsigned int usec);
            ]])
            local ts = ffi.new("sg_timespec")
            now = function() ffi.C.clock_gettime(1, ts) return tonumber(ts.tv_sec) + tonumber(ts.tv_nsec) / 1e9 end
            sleep = function(ms) ffi.C.usleep(math.max(0, math.floor(ms * 1000))) end
        end
    else
        now = os.clock
        sleep = function(ms)
            local target = os.clock() + ms / 1000
            while os.clock() < target do end
        end
    end

    local adapter = {
        environment = "standalone",
        adapterVersion = scriptgo.VERSION,
        capabilities = {},
        now = now,
        sleep = sleep,
        notifications = {},
    }
    for _, c in ipairs(scriptgo.capabilities.ALL) do adapter.capabilities[c] = true end
    -- HTTP needs curl; it is also switched off with config.http = false.
    if cfg.http == false then adapter.capabilities.http = false end
    if cfg.http ~= false and not opts.curl then
        local probe = io.popen and io.popen(isWindows and "curl --version 2>NUL" or "curl --version 2>/dev/null")
        local out = probe and probe:read("*a") or ""
        if probe then probe:close() end
        if not out:find("^curl") then adapter.capabilities.http = false end
    end
    -- Licensing and player perks both go through HTTP.
    if adapter.capabilities.http == false then
        adapter.capabilities.licensing = false
        adapter.capabilities.perks = false
    end

    local logLevel = { debug = 0, info = 1, warn = 2, error = 3 }
    local minLevel = logLevel[opts.logLevel or "info"] or 1
    local logSink = opts.logSink
    function adapter.log(level, origin, msg)
        if logSink then logSink(level, origin, msg) end
        if (logLevel[level] or 1) >= minLevel and not opts.quiet then
            io.write(("[%s] %-28s %s\n"):format(level, origin, tostring(msg)))
            io.flush()
        end
    end

    adapter.readFile = readFile

    -- Lists files under a resource root, relative and with forward slashes (script globs).
    function adapter.listFiles(root)
        local out = {}
        local cmd, prefix
        if isWindows then
            local win = root:gsub("/", "\\")
            local p = io.popen('cd /d "' .. win .. '" 2>NUL && cd')
            prefix = p and (p:read("*l") or "") or ""
            if p then p:close() end
            if prefix == "" then return out end
            cmd = 'dir /s /b /a-d "' .. prefix .. '" 2>NUL'
            prefix = prefix:gsub("\\", "/"):gsub("/$", "") .. "/"
        else
            cmd = "find '" .. root .. "' -type f 2>/dev/null"
            prefix = root:gsub("/$", "") .. "/"
        end
        local p = io.popen(cmd)
        if not p then return out end
        for line in p:lines() do
            local path = line:gsub("\\", "/"):gsub("\r$", "")
            if path:sub(1, #prefix):lower() == prefix:lower() then out[#out + 1] = path:sub(#prefix + 1) end
        end
        p:close()
        table.sort(out)
        return out
    end

    adapter.storage = {
        load = function(key)
            return readFile(dataDir .. "/storage/" .. key .. ".json")
        end,
        save = function(key, text)
            ensureDir(dataDir .. "/storage")
            local ok, err = writeFile(dataDir .. "/storage/" .. key .. ".json", text)
            if not ok then adapter.log("error", "standalone", "storage write failed: " .. tostring(err)) end
        end,
    }

    adapter.ui = {
        notify = function(target, payload)
            adapter.notifications[#adapter.notifications + 1] = { target = target, payload = payload }
            local title = payload.title and (payload.title .. ": ") or ""
            adapter.log("info", "ui:" .. tostring(payload.resource) .. "->" .. tostring(target),
                ("[%s] %s%s"):format(payload.type or "info", title, tostring(payload.message or "")))
        end,
    }

    -- config.permissions = { ["1"] = ["*"], ["2"] = ["command.give"] }
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
            if resourceName == nil then
                local cv = cfg.convars or {}
                return cv[key]
            end
            local r = (cfg.resources or {})[resourceName]
            return r and r[key]
        end,
    }

    -- HTTP through curl. Blocking; the request is made when the scheduler asks for it.
    local function shellQuote(s)
        if isWindows then return '"' .. tostring(s):gsub('"', '\\"') .. '"' end
        return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
    end
    -- os.tmpname() on Windows: the UCRT gives a full path in %TEMP%, the old MSVCRT a name at the
    -- drive root ("\s1v4."), which is usually not writable.
    local function tempFile()
        local name = os.tmpname()
        if isWindows and name:find("^[\\/]") then
            local dir = os.getenv("TEMP") or os.getenv("TMP") or "."
            name = dir .. "\\" .. name:gsub("^[\\/]+", "")
        end
        return name
    end
    adapter.http = {
        request = function(req, done)
            if adapter.capabilities.http == false then
                done({ status = 0, body = "", error = "http_unavailable" })
                return
            end
            local tmpBody = tempFile()
            local parts = { "curl -s -S -m " .. tostring(math.floor((req.timeoutMs or 10000) / 1000)) }
            parts[#parts + 1] = "-X " .. (req.method or "GET")
            for k, v in pairs(req.headers or {}) do parts[#parts + 1] = "-H " .. shellQuote(k .. ": " .. v) end
            if req.body then
                writeFile(tmpBody, req.body)
                parts[#parts + 1] = "--data-binary @" .. shellQuote(tmpBody)
            end
            -- A backslash and an n, which curl turns into a newline: a real newline would end the
            -- command line under cmd.exe (Windows) before the URL.
            parts[#parts + 1] = "-w " .. shellQuote("\\n__SG_STATUS__%{http_code}")
            parts[#parts + 1] = shellQuote(req.url)
            local p = io.popen(table.concat(parts, " ") .. (isWindows and " 2>NUL" or " 2>/dev/null"))
            local out = p and p:read("*a") or ""
            if p then p:close() end
            os.remove(tmpBody)
            local body, status = out:match("^(.*)\n__SG_STATUS__(%d+)$")
            local code = tonumber(status) or 0
            -- curl writes 000 when the exchange did not complete (refused, timeout, DNS).
            done({ status = code, body = body or out, error = code == 0 and "http_failed" or nil })
        end,
    }

    -- Simulated players: config.players = [{ "id": 1, "name": "Ada" }]
    adapter.players = nil

    return adapter
end
