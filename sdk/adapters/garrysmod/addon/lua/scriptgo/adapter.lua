-- Garry's Mod adapter: SCRIPT//GO resources inside one server-side addon (GLua, LuaJIT).
--
--   local adapter, api = include("scriptgo/adapter.lua")(scriptgo, opts)
--
-- opts: config (table from data/scriptgo/config.json), storageDir (folder under data/, default
-- "scriptgo/storage"), logSink (function(entry), for verify runs), debug (print debug lines).
--
-- How the host maps onto Garry's Mod:
--   clock          SysTime()
--   files          file.Read / file.Find; a resource root is "<PATH>:<folder>" with PATH = LUA
--                  (lua/ of every addon, merged) or DATA (garrysmod/data)
--   storage        one JSON file per resource side in data/<storageDir>/
--   players        the player's UserID() is its id; identifier steam:<SteamID64> (bots: bot:<id>)
--   permissions    superadmin, then CAMI (privilege scriptgo.<name>) when an admin mod provides
--                  it, then the grants in config.json by usergroup, SteamID64 or SteamID
--   config         config.json, then registered convars for GetConvar
--   ui             chat lines (ChatPrint, PrintMessage): no client script runs yet
--   http           HTTP(); licensing goes through it
-- Only the server side of a resource runs: client scripts need a game client.
return function(scriptgo, opts)
    opts = opts or {}
    local cfg = opts.config or {}
    local storageDir = opts.storageDir or "scriptgo/storage"
    local hasHttp = type(HTTP) == "function"

    local adapter = {
        environment = "garrysmod",
        adapterVersion = "garrysmod-0.1.0",
        sides = { server = true },
        capabilities = {
            events = true, logging = true, storage = true, players = true, permissions = true,
            commands = true, config = true, ui = true,
            http = hasHttp, licensing = hasHttp,
        },
        notifications = {},
    }

    adapter.now = function() return SysTime() end

    -- Log: the server console, which -condebug also writes to garrysmod/console.log.
    local COLORS = { error = { 255, 90, 90 }, warn = { 255, 200, 80 } }
    adapter.log = function(level, origin, msg)
        if opts.logSink then opts.logSink({ level = level, origin = origin, message = msg }) end
        if level == "debug" and not opts.debug then return end
        local tag = (level == "error" and "ERROR ") or (level == "warn" and "WARN ") or ""
        local line = "[scriptgo] " .. tag .. tostring(origin) .. " " .. tostring(msg)
        local c = COLORS[level]
        if c and MsgC and Color then
            MsgC(Color(c[1], c[2], c[3]), line .. "\n")
        else
            print(line)
        end
    end

    -- Files ------------------------------------------------------------------------------------------
    local function split(path)
        local id, rest = path:match("^(%u+):(.*)$")
        if not id then return (path:gsub("\\", "/")), "LUA" end
        return (rest:gsub("\\", "/")), id
    end
    local api = { split = split }

    adapter.readFile = function(path)
        local p, id = split(path)
        return file.Read(p, id)
    end

    adapter.listFiles = function(root)
        local base, id = split(root)
        local out = {}
        local function walk(dir, prefix)
            local files, dirs = file.Find(dir .. "/*", id)
            for _, name in ipairs(files or {}) do out[#out + 1] = prefix .. name end
            for _, name in ipairs(dirs or {}) do
                if name:sub(1, 1) ~= "." then walk(dir .. "/" .. name, prefix .. name .. "/") end
            end
        end
        walk(base, "")
        table.sort(out)
        return out
    end

    -- Storage: data/<storageDir>/<resource>[.client].json. file.Write only writes under data/ and
    -- only some extensions (.json is one of them).
    local function storageFile(key)
        local safe = tostring(key):lower():gsub("[^%w_%.%-]", "_")
        return storageDir .. "/" .. safe .. ".json"
    end
    adapter.storage = {
        load = function(key)
            local text = file.Read(storageFile(key), "DATA")
            if text == nil or text == "" then return nil end
            return text
        end,
        save = function(key, text)
            file.CreateDir(storageDir)
            file.Write(storageFile(key), text)
        end,
    }

    -- Players -----------------------------------------------------------------------------------------
    -- UserID() is unique for the session, like a FiveM server id. Identifiers are remembered so a
    -- playerDropped handler can still read one after the entity is gone.
    local identifiers = {}
    local function byId(id)
        if type(id) ~= "number" then return nil end
        local ply = Player(id)
        if IsValid(ply) then return ply end
        return nil
    end
    api.byId = byId

    function api.remember(ply)
        local id = ply:UserID()
        if ply:IsBot() then
            identifiers[id] = "bot:" .. tostring(id)
        else
            identifiers[id] = "steam:" .. tostring(ply:SteamID64())
        end
        return id
    end

    adapter.players = {
        list = function()
            local ids = {}
            for _, ply in ipairs(player.GetAll()) do ids[#ids + 1] = ply:UserID() end
            table.sort(ids)
            return ids
        end,
        name = function(id)
            local ply = byId(id)
            return ply and ply:Nick() or nil
        end,
        identifier = function(id)
            local ply = byId(id)
            if ply then api.remember(ply) end
            return identifiers[id]
        end,
        -- The player's address ("ip:port"), for player match only (docs/spec/player-match.md): the
        -- core hashes it and never sends or logs it. Not visible to scripts. Presence is not switched
        -- on here (GLua has no HMAC), so nothing reads it yet.
        address = function(id)
            local ply = byId(id)
            return ply and ply:IPAddress() or nil
        end,
    }

    -- Permissions -------------------------------------------------------------------------------------
    local grants = cfg.permissions or {}
    local function granted(list, privilege)
        if type(list) ~= "table" then return false end
        for _, p in ipairs(list) do
            if p == "*" or p == privilege then return true end
            if type(p) == "string" and p:sub(-2) == ".*" and privilege:sub(1, #p - 1) == p:sub(1, -2) then return true end
        end
        return false
    end

    -- CAMI (the admin-mod interface ULX, SAM, sAdmin and others implement): each privilege is
    -- registered once as scriptgo.<privilege>, superadmin by default, so the admin mod can grant it
    -- to groups. Only a synchronous answer counts; an admin mod that answers later falls back to
    -- the grants in config.json.
    local registered = {}
    local function camiAllows(ply, privilege)
        local cami = rawget(_G, "CAMI")
        if type(cami) ~= "table" or type(cami.PlayerHasAccess) ~= "function" then return nil end
        local name = "scriptgo." .. privilege
        if not registered[name] then
            registered[name] = true
            local known = type(cami.GetPrivilege) == "function" and cami.GetPrivilege(name)
            if not known and type(cami.RegisterPrivilege) == "function" then
                pcall(cami.RegisterPrivilege, { Name = name, MinAccess = "superadmin", Description = "SCRIPT//GO: " .. privilege })
            end
        end
        local ok, has = pcall(cami.PlayerHasAccess, ply, name, nil)
        if ok and has ~= nil then return has and true or false end
        return nil
    end
    api.camiAllows = camiAllows

    adapter.permissions = {
        has = function(id, privilege)
            local ply = byId(id)
            if not ply or type(privilege) ~= "string" then return false end
            if ply:IsSuperAdmin() then return true end
            if camiAllows(ply, privilege) == true then return true end
            return granted(grants[ply:GetUserGroup()], privilege)
                or granted(grants[tostring(ply:SteamID64())], privilege)
                or granted(grants[tostring(ply:SteamID())], privilege)
        end,
    }

    -- Config: config.json { "resources": { "<name>": { key: value } }, "convars": { key: value } },
    -- then convars that exist on the server (engine, addons, and scriptgo_api) for GetConvar.
    adapter.config = {
        get = function(resourceName, key)
            if resourceName == nil then
                local v = (cfg.convars or {})[key]
                if v ~= nil then return v end
                if type(GetConVar) ~= "function" or type(key) ~= "string" then return nil end
                local ok, cv = pcall(GetConVar, key)
                if ok and cv then
                    local s = cv:GetString()
                    if s ~= "" then return s end
                end
                return nil
            end
            local r = (cfg.resources or {})[resourceName]
            if type(r) == "table" then return r[key] end
            return nil
        end,
    }

    -- Notifications as chat lines (the client cannot draw anything SCRIPT//GO sends yet).
    adapter.ui = {
        notify = function(target, payload)
            adapter.notifications[#adapter.notifications + 1] = { target = target, payload = payload }
            local title = payload.title or payload.resource or "notice"
            local line = ("[" .. tostring(title) .. "] " .. tostring(payload.message or "")):sub(1, 240)
            if target == -1 then
                PrintMessage(HUD_PRINTTALK, line)
            else
                local ply = byId(target)
                if ply then ply:ChatPrint(line) end
            end
            adapter.log("info", "ui", "notify " .. tostring(target) .. " " .. line)
        end,
    }

    -- HTTP through the engine's asynchronous HTTP(); callbacks run on the main thread. A body's
    -- content type goes in `type`, as GMod wants it, not in the headers.
    if hasHttp then
        adapter.http = {
            request = function(req, done)
                local headers, ctype = {}, nil
                for k, v in pairs(req.headers or {}) do
                    if tostring(k):lower() == "content-type" then ctype = tostring(v) else headers[tostring(k)] = tostring(v) end
                end
                local finished = false
                local function finish(r)
                    if finished then return end
                    finished = true
                    done(r)
                end
                local started = HTTP({
                    url = req.url,
                    method = tostring(req.method or "GET"):upper(),
                    headers = headers,
                    body = req.body,
                    type = req.body and (ctype or "text/plain; charset=utf-8") or nil,
                    timeout = req.timeout or 10,
                    success = function(code, body, resHeaders)
                        finish({ status = code, body = body or "", headers = resHeaders or {} })
                    end,
                    failed = function(reason)
                        -- Loopback and private addresses fail here unless srcds runs with -allowlocalhttp.
                        adapter.log("warn", "http", tostring(req.method or "GET") .. " " .. tostring(req.url) .. " failed: " .. tostring(reason))
                        finish({ status = 0, body = "", error = tostring(reason) })
                    end,
                })
                if started == false then
                    adapter.log("warn", "http", "HTTP() refused " .. tostring(req.url))
                    finish({ status = 0, body = "", error = "request_failed" })
                end
            end,
        }
    end

    return adapter, api
end
