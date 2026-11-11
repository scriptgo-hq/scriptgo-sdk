-- Godot 4 adapter: resources run inside a Godot game through the lua-gdextension bridge (Lua 5.4).
-- Files are read and listed with Godot's FileAccess / DirAccess (res://, user:// and absolute
-- paths), storage is JSON files under user://, notifications are queued for a Godot scene to show
-- as toasts, and privileges and config come from an options table.
--
--   local adapter = loadfile(".../adapter.lua")(scriptgo, options)   -- usually through runtime.lua
--
-- options:
--   clock()        monotonic time in seconds. The Godot glue passes a Callable over
--                  Time.get_ticks_usec(): Lua code must not touch the `Time` singleton (with
--                  lua-gdextension 0.7.0 on Godot 4.5.2 that crashes the engine at exit; see README).
--   config         { permissions = { ["1"] = { "*" } }, resources = { name = { k = v } }, convars = { k = v } }
--   storageDir     default "user://scriptgo/storage"
--   logSink(level, origin, msg), logLevel ("info"), quiet
--   godot          { FileAccess = ..., DirAccess = ... }; defaults to the classes the bridge exposes
--                  (LuaState library GODOT_CLASSES). Specs pass fakes.
return function(scriptgo, opts)
    opts = opts or {}
    local cfg = opts.config or {}
    local godot = opts.godot or {}
    -- The bridge resolves Godot classes through _G's metatable, so a plain index (not rawget).
    local FileAccess = godot.FileAccess or _G.FileAccess
    local DirAccess = godot.DirAccess or _G.DirAccess
    assert(FileAccess and DirAccess, "godot adapter: FileAccess and DirAccess are required (open the GODOT_CLASSES library)")
    local storageDir = (opts.storageDir or "user://scriptgo/storage"):gsub("\\", "/"):gsub("/+$", "")

    local function norm(path) return (tostring(path):gsub("\\", "/")) end

    -- Godot arrays (PackedStringArray) iterate with pairs from index 0; plain tables from 1.
    local function values(list)
        local out = {}
        if list == nil then return out end
        for _, v in pairs(list) do out[#out + 1] = tostring(v) end
        table.sort(out)
        return out
    end

    local function readFile(path)
        path = norm(path)
        if not FileAccess:file_exists(path) then return nil end
        return FileAccess:get_file_as_string(path)
    end

    local function writeFile(path, text)
        local f = FileAccess:open(path, FileAccess.WRITE)
        if not f then return false, "open_failed:" .. tostring(FileAccess:get_open_error()) end
        f:store_string(text)
        f:close()
        return true
    end

    -- Clock: the Godot glue's Callable. os.clock (CPU time) is a fallback for runs without one.
    local now = os.clock
    if opts.clock then
        local clock = opts.clock
        now = function() return clock() end
    end

    local adapter = {
        environment = "godot",
        adapterVersion = "godot-" .. scriptgo.VERSION,
        capabilities = {},
        now = now,
        budgetMs = opts.budgetMs,
        notifications = {},  -- every notification of the run (bounded)
        pending = {},        -- not yet shown by the scene; drained each frame
    }
    for _, c in ipairs(scriptgo.capabilities.ALL) do adapter.capabilities[c] = true end
    -- Player perks are not switched on here (no HTTP); the registry says the same (capabilities.lua).
    adapter.capabilities.perks = false
    -- Player match follows perks (nobody to match, or no HTTP): off as well.
    adapter.capabilities.presence = false
    -- No HTTP: Godot's HTTPRequest is a scene node driven by signals, and nothing in this adapter
    -- performs a request yet. Licensing needs HTTP, so it is off too.
    adapter.capabilities.http = false
    adapter.capabilities.licensing = false

    local logLevel = { debug = 0, info = 1, warn = 2, error = 3 }
    local minLevel = logLevel[opts.logLevel or "info"] or 1
    local logSink = opts.logSink
    function adapter.log(level, origin, msg)
        if logSink then logSink(level, origin, tostring(msg)) end
        if not logSink and (logLevel[level] or 1) >= minLevel and not opts.quiet then
            print(("[%s] %-28s %s"):format(level, origin, tostring(msg)))
        end
    end

    adapter.readFile = readFile

    -- Lists every file under a resource root, relative, forward slashes, sorted (script globs).
    function adapter.listFiles(root)
        root = norm(root):gsub("/+$", "")
        local out = {}
        if not DirAccess:dir_exists_absolute(root) then return out end
        local function walk(dir, prefix)
            for _, name in ipairs(values(DirAccess:get_files_at(dir))) do out[#out + 1] = prefix .. name end
            for _, name in ipairs(values(DirAccess:get_directories_at(dir))) do
                walk(dir .. "/" .. name, prefix .. name .. "/")
            end
        end
        walk(root, "")
        table.sort(out)
        return out
    end

    local storageReady = false
    adapter.storageDir = storageDir
    adapter.storage = {
        load = function(key)
            return readFile(storageDir .. "/" .. key .. ".json")
        end,
        save = function(key, text)
            if not storageReady then
                DirAccess:make_dir_recursive_absolute(storageDir)
                storageReady = true
            end
            local ok, err = writeFile(storageDir .. "/" .. key .. ".json", text)
            if not ok then adapter.log("error", "godot", "storage write failed for " .. key .. ": " .. tostring(err)) end
        end,
    }

    -- Notifications: queued for the scene (toasts) and logged.
    adapter.ui = {
        notify = function(target, payload)
            local entry = { target = target, payload = payload }
            adapter.notifications[#adapter.notifications + 1] = entry
            if #adapter.notifications > 200 then table.remove(adapter.notifications, 1) end
            adapter.pending[#adapter.pending + 1] = entry
            local title = payload.title and (payload.title .. ": ") or ""
            adapter.log("info", "ui:" .. tostring(payload.resource) .. "->" .. tostring(target),
                ("[%s] %s%s"):format(payload.type or "info", title, tostring(payload.message or "")))
        end,
    }

    function adapter.drainNotifications()
        local out = adapter.pending
        adapter.pending = {}
        return out
    end

    -- config.permissions = { ["1"] = { "*" }, ["2"] = { "command.give", "inventory.*" } }
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

    -- Players: the host's own table (the local player joins from the scene). No adapter.players.
    adapter.players = nil

    return adapter
end
