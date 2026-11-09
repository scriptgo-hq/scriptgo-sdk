-- Lua 5.1 / 5.2 / 5.3 / 5.4 / LuaJIT differences, in one place.
local R = ...
local M = {}

M.unpack = table.unpack or unpack
M.pack = table.pack or function(...)
    return { n = select("#", ...), ... }
end

M.isLuaJIT = type(rawget(_G, "jit")) == "table"
M.version = M.isLuaJIT and (rawget(_G, "jit").version or "LuaJIT") or _VERSION

-- `load` with an environment, for every dialect. Text chunks only (no bytecode).
local hasEnvLoad = (_VERSION ~= "Lua 5.1")
function M.loadWithEnv(source, chunkname, env)
    if type(source) ~= "string" then
        return nil, "source must be a string"
    end
    if source:byte(1) == 27 then
        return nil, "binary chunks are not allowed"
    end
    if hasEnvLoad then
        return load(source, chunkname, "t", env)
    end
    local fn, err = loadstring(source, chunkname)
    if not fn then
        return nil, err
    end
    setfenv(fn, env)
    return fn
end

-- Can a coroutine yield across pcall in this dialect? Lua 5.1 (PUC) cannot.
M.canYieldAcrossPcall = (_VERSION ~= "Lua 5.1") or M.isLuaJIT

-- Coroutine-aware pcall for Lua 5.1: runs f in a sub-coroutine and forwards its yields to the
-- scheduler, so `Wait` inside `pcall` works on every dialect.
local function coxpcall(f, handler, ...)
    local co = coroutine.create(f)
    local args = M.pack(...)
    while true do
        local res = M.pack(coroutine.resume(co, M.unpack(args, 1, args.n)))
        local ok = res[1]
        if not ok then
            local err = res[2]
            if handler then
                return false, handler(err)
            end
            return false, err
        end
        if coroutine.status(co) == "dead" then
            return true, M.unpack(res, 2, res.n)
        end
        -- Forward the yield to whoever is running us, then pass its answer back in.
        args = M.pack(coroutine.yield(M.unpack(res, 2, res.n)))
    end
end

if M.canYieldAcrossPcall then
    M.pcall = pcall
    M.xpcall = xpcall
else
    M.pcall = function(f, ...)
        return coxpcall(f, nil, ...)
    end
    M.xpcall = function(f, handler, ...)
        return coxpcall(f, handler, ...)
    end
end

function M.isInteger(n)
    return type(n) == "number" and n == math.floor(n) and n > -2 ^ 53 and n < 2 ^ 53
end

function M.isFinite(n)
    return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

return M
