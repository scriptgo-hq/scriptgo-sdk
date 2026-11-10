-- SCRIPT//GO core loader.
--
--   From source:  local scriptgo = dofile("sdk/lua/scriptgo/init.lua")
--                 local scriptgo = loadfile(path)(baseDir, readFn)   -- hosts without io
--   Bundled:      local scriptgo = dofile("scriptgo.lua")             -- sdk/lua/dist, one file
--
-- Every module receives a `require` of its siblings as its first chunk argument (`local R = ...`),
-- so the core never touches package.path and loads the same way in LÖVE, Godot, Luanti and the CLI.
local baseDir, readFn, preload = ...

local function defaultBase()
    if type(debug) == "table" and debug.getinfo then
        local src = debug.getinfo(1, "S").source
        if type(src) == "string" and src:sub(1, 1) == "@" then
            return (src:sub(2):gsub("\\", "/"):match("^(.*/)") or "./")
        end
    end
    return "./"
end

local function defaultRead(path)
    local f = io and io.open(path, "rb")
    if not f then return nil end
    local text = f:read("*a")
    f:close()
    return text
end

if not preload then
    baseDir = baseDir or defaultBase()
    if baseDir ~= "" and not baseDir:match("[/\\]$") then baseDir = baseDir .. "/" end
    readFn = readFn or defaultRead
end

local loadChunk = loadstring or load
local cache, loading = {}, {}

local function R(name)
    local value = cache[name]
    if value ~= nil then return value end
    if loading[name] then error("scriptgo: circular module dependency on '" .. name .. "'", 2) end
    loading[name] = true
    local fn
    if preload then
        fn = preload[name]
        if not fn then error("scriptgo: module '" .. name .. "' is not in the bundle", 2) end
    else
        local text = readFn(baseDir .. name .. ".lua")
        if not text then error("scriptgo: cannot read module '" .. name .. "' from " .. baseDir, 2) end
        local err
        fn, err = loadChunk(text, "@scriptgo/" .. name .. ".lua")
        if not fn then error(err, 2) end
    end
    value = fn(R)
    if value == nil then value = true end
    loading[name] = nil
    cache[name] = value
    return value
end

local host = R("host")

local M = {
    VERSION = host.VERSION,
    require = R,
    compat = R("compat"),
    json = R("json"),
    semver = R("semver"),
    codec = R("codec"),
    manifest = R("manifest"),
    capabilities = R("capabilities"),
    perks = R("perks"),
    host = host,
    testing = R("testing"),
}

function M.newHost(opts) return host.new(opts) end

return M
