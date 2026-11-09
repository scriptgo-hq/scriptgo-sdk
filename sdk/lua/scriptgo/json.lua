-- Pure Lua JSON. Deterministic: object keys are sorted, so the same value always encodes to the
-- same text (used for storage files and signed payloads).
local R = ...
local compat = R("compat")
local M = {}

M.null = setmetatable({}, { __tostring = function() return "null" end })

local escapes = {
    ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f",
    ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t",
}

local function escapeString(s)
    return '"' .. s:gsub('[%c"\\]', function(c)
        return escapes[c] or string.format("\\u%04x", c:byte())
    end) .. '"'
end

local function isArray(t)
    local n = 0
    for k in pairs(t) do
        if type(k) ~= "number" or k < 1 or k ~= math.floor(k) then
            return false
        end
        if k > n then n = k end
    end
    for i = 1, n do
        if t[i] == nil then return false end
    end
    return true, n
end

local function encodeValue(v, out, depth, seen)
    local t = type(v)
    if v == nil or v == M.null then
        out[#out + 1] = "null"
    elseif t == "boolean" then
        out[#out + 1] = v and "true" or "false"
    elseif t == "number" then
        if not compat.isFinite(v) then
            error("json: cannot encode a non-finite number", 0)
        end
        if compat.isInteger(v) then
            out[#out + 1] = string.format("%d", v)
        else
            out[#out + 1] = string.format("%.17g", v)
        end
    elseif t == "string" then
        out[#out + 1] = escapeString(v)
    elseif t == "table" then
        if depth > 64 then error("json: value is nested too deeply", 0) end
        if seen[v] then error("json: cannot encode a cyclic table", 0) end
        seen[v] = true
        local arr, n = isArray(v)
        if arr and (n > 0 or next(v) == nil) and getmetatable(v) ~= M.objectMeta then
            out[#out + 1] = "["
            for i = 1, n do
                if i > 1 then out[#out + 1] = "," end
                encodeValue(v[i], out, depth + 1, seen)
            end
            out[#out + 1] = "]"
        else
            local keys = {}
            for k in pairs(v) do
                local kt = type(k)
                if kt ~= "string" and kt ~= "number" then
                    error("json: object keys must be strings or numbers", 0)
                end
                keys[#keys + 1] = k
            end
            table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
            out[#out + 1] = "{"
            for i, k in ipairs(keys) do
                if i > 1 then out[#out + 1] = "," end
                out[#out + 1] = escapeString(tostring(k))
                out[#out + 1] = ":"
                encodeValue(v[k], out, depth + 1, seen)
            end
            out[#out + 1] = "}"
        end
        seen[v] = nil
    else
        error("json: cannot encode a " .. t, 0)
    end
end

-- Mark a table so an empty one encodes as {} rather than [].
M.objectMeta = {}
function M.object(t)
    return setmetatable(t or {}, M.objectMeta)
end

function M.encode(v)
    local out = {}
    encodeValue(v, out, 0, {})
    return table.concat(out)
end

-- Decoder ------------------------------------------------------------------------------------
local function decodeError(s, i, msg)
    local line = 1
    for _ in s:sub(1, i):gmatch("\n") do line = line + 1 end
    error(string.format("json: %s at line %d", msg, line), 0)
end

local function skip(s, i)
    local _, e = s:find("^[ \n\r\t]*", i)
    return e + 1
end

local function utf8char(cp)
    if cp < 0x80 then return string.char(cp) end
    if cp < 0x800 then return string.char(0xC0 + math.floor(cp / 0x40), 0x80 + cp % 0x40) end
    if cp < 0x10000 then
        return string.char(0xE0 + math.floor(cp / 0x1000), 0x80 + math.floor(cp / 0x40) % 0x40, 0x80 + cp % 0x40)
    end
    return string.char(0xF0 + math.floor(cp / 0x40000), 0x80 + math.floor(cp / 0x1000) % 0x40,
        0x80 + math.floor(cp / 0x40) % 0x40, 0x80 + cp % 0x40)
end

local decodeValue

local function decodeString(s, i)
    local out = {}
    local j = i + 1
    while true do
        local c = s:sub(j, j)
        if c == "" then decodeError(s, j, "unterminated string") end
        if c == '"' then return table.concat(out), j + 1 end
        if c == "\\" then
            local e = s:sub(j + 1, j + 1)
            local map = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }
            if map[e] then
                out[#out + 1] = map[e]
                j = j + 2
            elseif e == "u" then
                local hex = s:sub(j + 2, j + 5)
                if not hex:match("^%x%x%x%x$") then decodeError(s, j, "invalid \\u escape") end
                local cp = tonumber(hex, 16)
                j = j + 6
                if cp >= 0xD800 and cp <= 0xDBFF and s:sub(j, j + 1) == "\\u" then
                    local lo = tonumber(s:sub(j + 2, j + 5), 16)
                    if lo and lo >= 0xDC00 and lo <= 0xDFFF then
                        cp = 0x10000 + (cp - 0xD800) * 0x400 + (lo - 0xDC00)
                        j = j + 6
                    end
                end
                out[#out + 1] = utf8char(cp)
            else
                decodeError(s, j, "invalid escape")
            end
        elseif c:byte() < 32 then
            decodeError(s, j, "control character in string")
        else
            local k = s:find('["\\%c]', j)
            if not k then decodeError(s, j, "unterminated string") end
            out[#out + 1] = s:sub(j, k - 1)
            j = k
        end
    end
end

-- `ordered` (decodeOrdered): objects keep their key order, arrays their length, null is M.null.
function decodeValue(s, i, depth, ordered)
    if depth > 64 then decodeError(s, i, "nesting too deep") end
    i = skip(s, i)
    local c = s:sub(i, i)
    if c == "{" then
        local obj = ordered and { kind = "object", keys = {}, map = {} } or M.object({})
        i = skip(s, i + 1)
        if s:sub(i, i) == "}" then return obj, i + 1 end
        while true do
            i = skip(s, i)
            if s:sub(i, i) ~= '"' then decodeError(s, i, "expected a string key") end
            local key
            key, i = decodeString(s, i)
            i = skip(s, i)
            if s:sub(i, i) ~= ":" then decodeError(s, i, "expected ':'") end
            local val
            val, i = decodeValue(s, i + 1, depth + 1, ordered)
            if ordered then
                -- A repeated key keeps its first position and its last value, like JSON.parse.
                if obj.map[key] == nil then obj.keys[#obj.keys + 1] = key end
                obj.map[key] = val
            else
                obj[key] = val
            end
            i = skip(s, i)
            local d = s:sub(i, i)
            if d == "}" then return obj, i + 1 end
            if d ~= "," then decodeError(s, i, "expected ',' or '}'") end
            i = i + 1
        end
    elseif c == "[" then
        local arr = ordered and { kind = "array", items = {}, n = 0 } or {}
        i = skip(s, i + 1)
        if s:sub(i, i) == "]" then return arr, i + 1 end
        local n = 0
        while true do
            local val
            val, i = decodeValue(s, i, depth + 1, ordered)
            n = n + 1
            if ordered then arr.items[n] = val; arr.n = n else arr[n] = val end
            i = skip(s, i)
            local d = s:sub(i, i)
            if d == "]" then return arr, i + 1 end
            if d ~= "," then decodeError(s, i, "expected ',' or ']'") end
            i = i + 1
        end
    elseif c == '"' then
        return decodeString(s, i)
    elseif s:sub(i, i + 3) == "true" then
        return true, i + 4
    elseif s:sub(i, i + 4) == "false" then
        return false, i + 5
    elseif s:sub(i, i + 3) == "null" then
        return (ordered and M.null or nil), i + 4
    else
        local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", i)
        if not num or num == "" or num == "-" then decodeError(s, i, "unexpected character") end
        local n = tonumber(num)
        if not n then decodeError(s, i, "invalid number") end
        return n, i + #num
    end
end

function M.decode(s)
    if type(s) ~= "string" then error("json: decode expects a string", 0) end
    local v, i = decodeValue(s, 1, 0)
    i = skip(s, i)
    if i <= #s then decodeError(s, i, "trailing characters") end
    return v
end

-- Decodes without losing what plain Lua tables cannot hold (scriptgo.json manifests): objects are
-- { kind = "object", keys = { ...in order }, map = {...} }, arrays { kind = "array", items, n },
-- null is M.null.
function M.decodeOrdered(s)
    if type(s) ~= "string" then error("json: decode expects a string", 0) end
    local v, i = decodeValue(s, 1, 0, true)
    i = skip(s, i)
    if i <= #s then decodeError(s, i, "trailing characters") end
    return v
end

return M
