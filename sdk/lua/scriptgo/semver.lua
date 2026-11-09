-- Semantic versions and ranges, same rules as packages/manifest/src/semver.ts.
local R = ...
local M = {}

function M.parse(v)
    if type(v) ~= "string" then return nil end
    v = v:match("^%s*(.-)%s*$")
    local core, rest = v:match("^(%d+%.%d+%.%d+)(.*)$")
    if not core then return nil end
    local major, minor, patch = core:match("^(%d+)%.(%d+)%.(%d+)$")
    for _, part in ipairs({ major, minor, patch }) do
        if #part > 1 and part:sub(1, 1) == "0" then return nil end
    end
    local pre = {}
    if rest ~= "" then
        local prerelease, build = rest:match("^%-([0-9A-Za-z%-%.]+)(.*)$")
        if prerelease then
            rest = build
            for id in (prerelease .. "."):gmatch("([^%.]*)%.") do
                if id == "" then return nil end
                if id:match("^%d+$") then
                    if #id > 1 and id:sub(1, 1) == "0" then return nil end
                    pre[#pre + 1] = tonumber(id)
                else
                    pre[#pre + 1] = id
                end
            end
        end
        if rest ~= "" and not rest:match("^%+[0-9A-Za-z%-]+[0-9A-Za-z%-%.]*$") then return nil end
    end
    return { major = tonumber(major), minor = tonumber(minor), patch = tonumber(patch), prerelease = pre }
end

function M.isValid(v)
    return M.parse(v) ~= nil
end

function M.compare(a, b)
    for _, k in ipairs({ "major", "minor", "patch" }) do
        if a[k] ~= b[k] then return a[k] < b[k] and -1 or 1 end
    end
    local pa, pb = a.prerelease, b.prerelease
    if #pa == 0 or #pb == 0 then return #pb - #pa end
    for i = 1, math.max(#pa, #pb) do
        local x, y = pa[i], pb[i]
        if x == nil then return -1 end
        if y == nil then return 1 end
        if x ~= y then
            local tx, ty = type(x), type(y)
            if tx == "number" and ty == "number" then return x < y and -1 or 1 end
            if tx == "number" then return -1 end
            if ty == "number" then return 1 end
            return x < y and -1 or 1
        end
    end
    return 0
end

local function sv(major, minor, patch)
    return { major = major, minor = minor or 0, patch = patch or 0, prerelease = {} }
end

local function partial(text)
    text = text:gsub("^v", "")
    local full = M.parse(text)
    if full then return { full.major, full.minor, full.patch }, full end
    local parts = {}
    local fields = {}
    for f in (text .. "."):gmatch("([^%.]*)%.") do fields[#fields + 1] = f end
    if #fields == 0 or #fields > 3 then return nil end
    for _, f in ipairs(fields) do
        if f:match("^[xX%*]$") then break end
        if not f:match("^%d+$") then return nil end
        parts[#parts + 1] = tonumber(f)
    end
    return parts, nil
end

local function comparators(token)
    if token == "*" or token == "x" or token == "X" then return {} end
    local op, rest = token:match("^([<>=%^~]*)(.+)$")
    if not op or (op ~= "" and op ~= ">=" and op ~= "<=" and op ~= ">" and op ~= "<" and op ~= "=" and op ~= "^" and op ~= "~") then
        return nil
    end
    local parts, full = partial(rest)
    if not parts then return nil end
    local maj, min, pat = parts[1], parts[2], parts[3]
    local lower = full or sv(maj or 0, min or 0, pat or 0)
    if op == "^" then
        if maj == nil then return {} end
        local upper
        if maj > 0 or min == nil then upper = sv(maj + 1)
        elseif min > 0 or pat == nil then upper = sv(0, min + 1)
        else upper = sv(0, 0, pat + 1) end
        return { { ">=", lower }, { "<", upper } }
    end
    if op == "~" then
        if maj == nil then return {} end
        local upper = min == nil and sv(maj + 1) or sv(maj, min + 1)
        return { { ">=", lower }, { "<", upper } }
    end
    if op == "" or op == "=" then
        if full then return { { "=", full } } end
        if maj == nil then return {} end
        local upper
        if min == nil then upper = sv(maj + 1)
        elseif pat == nil then upper = sv(maj, min + 1)
        else upper = sv(maj, min, pat + 1) end
        return { { ">=", lower }, { "<", upper } }
    end
    if maj == nil then return nil end
    return { { op, lower } }
end

local function parseRange(range)
    local sets = {}
    for alt in (range .. "||"):gmatch("(.-)||") do
        alt = alt:gsub("([<>=%^~]+)%s+", "%1")
        local set = {}
        for tok in alt:gmatch("%S+") do
            local c = comparators(tok)
            if c == nil then return nil end
            for _, x in ipairs(c) do set[#set + 1] = x end
        end
        sets[#sets + 1] = set
    end
    return sets
end

function M.isValidRange(range)
    return type(range) == "string" and range:match("%S") ~= nil and parseRange(range) ~= nil
end

function M.satisfies(version, range)
    local v = M.parse(version)
    local sets = type(range) == "string" and parseRange(range) or nil
    if not v or not sets then return false end
    for _, set in ipairs(sets) do
        local ok = true
        for _, c in ipairs(set) do
            local cmp = M.compare(v, c[2])
            local op = c[1]
            local pass = (op == ">=" and cmp >= 0) or (op == ">" and cmp > 0) or (op == "<=" and cmp <= 0)
                or (op == "<" and cmp < 0) or (op == "=" and cmp == 0)
            if not pass then ok = false break end
        end
        if ok then return true end
    end
    return false
end

return M
