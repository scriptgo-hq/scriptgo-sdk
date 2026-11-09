-- The value codec: every value that crosses a boundary (network event, export call, storage) is
-- copied through here. Same rules as OPEN//77: nil, booleans, finite numbers, strings and acyclic
-- tables with string or integer keys. Lua objects are never shared between sides or resources.
local R = ...
local compat = R("compat")
local M = {}

M.MAX_DEPTH = 32
M.MAX_BYTES = 1024 * 1024

local function copy(v, depth, seen, budget)
    local t = type(v)
    if t == "nil" or t == "boolean" then
        return v
    elseif t == "number" then
        if not compat.isFinite(v) then error("codec: non-finite number", 0) end
        budget[1] = budget[1] + 8
        return v
    elseif t == "string" then
        budget[1] = budget[1] + #v
        if budget[1] > M.MAX_BYTES then error("codec: value exceeds 1 MiB", 0) end
        return v
    elseif t == "table" then
        if depth >= M.MAX_DEPTH then error("codec: value nested deeper than " .. M.MAX_DEPTH, 0) end
        if seen[v] then error("codec: cyclic table", 0) end
        seen[v] = true
        local out = {}
        for k, val in pairs(v) do
            local kt = type(k)
            if kt == "number" then
                if not compat.isInteger(k) then error("codec: table keys must be strings or integers", 0) end
            elseif kt ~= "string" then
                error("codec: table keys must be strings or integers", 0)
            end
            budget[1] = budget[1] + 8
            out[copy(k, depth + 1, seen, budget)] = copy(val, depth + 1, seen, budget)
        end
        seen[v] = nil
        if budget[1] > M.MAX_BYTES then error("codec: value exceeds 1 MiB", 0) end
        return out
    end
    error("codec: cannot transfer a " .. t, 0)
end

-- Copies a value; returns copy or nil, reason.
function M.copy(v)
    local ok, res = pcall(copy, v, 0, {}, { 0 })
    if ok then return true, res end
    return false, res
end

-- Copies a vararg list (n-aware, nils preserved).
function M.copyArgs(...)
    local args = compat.pack(...)
    local out = { n = args.n }
    for i = 1, args.n do
        local ok, v = M.copy(args[i])
        if not ok then return nil, "argument " .. i .. ": " .. tostring(v) end
        out[i] = v
    end
    return out
end

return M
