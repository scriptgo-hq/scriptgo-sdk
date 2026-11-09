-- The language-neutral codec vectors (sdk/conformance/vectors/codec.json) through the portable
-- core's codec, on every interpreter. The .NET kit runs the same file through its Lua and
-- JavaScript guests (sdk/dotnet/ScriptGo.Host.Tests/CodecVectorTests.cs).
local suite, scriptgo, ctx = ...
local test = suite.test
local json, codec, compat = scriptgo.json, scriptgo.codec, scriptgo.compat

local text = assert(ctx.readFile(ctx.root .. "/sdk/conformance/vectors/codec.json"), "codec.json not found")
local vectors = json.decode(text)

local hasMathType = type(math.type) == "function"

local function renderNumber(v)
    if hasMathType and math.type(v) == "integer" then return "i:" .. tostring(v) end
    if not hasMathType and compat.isInteger(v) then return "i:" .. string.format("%.0f", v) end
    local s
    for p = 1, 17 do
        s = string.format("%." .. p .. "g", v)
        if tonumber(s) == v then break end
    end
    return "f:" .. s:lower()
end

local function quote(s)
    return '"' .. s:gsub('[%z\1-\31"\\]', function(c)
        if c == '"' or c == "\\" then return "\\" .. c end
        return string.format("\\u%04x", c:byte())
    end) .. '"'
end

local render
local function renderTable(t)
    local n, ints, strs = 0, {}, {}
    for k in pairs(t) do
        n = n + 1
        if type(k) == "number" then ints[#ints + 1] = k else strs[#strs + 1] = k end
    end
    if n == 0 then return "[]" end
    local sequence = #strs == 0
    if sequence then
        for _, k in ipairs(ints) do
            if k < 1 or k > n then sequence = false break end
        end
    end
    local parts = {}
    if sequence then
        for i = 1, n do parts[i] = render(t[i]) end
        return "[" .. table.concat(parts, ",") .. "]"
    end
    table.sort(ints)
    table.sort(strs)
    for _, k in ipairs(ints) do parts[#parts + 1] = renderNumber(k) .. "=" .. render(t[k]) end
    for _, k in ipairs(strs) do parts[#parts + 1] = quote(k) .. "=" .. render(t[k]) end
    return "{" .. table.concat(parts, ",") .. "}"
end

render = function(v)
    local t = type(v)
    if t == "nil" then return "nil" end
    if t == "boolean" then return tostring(v) end
    if t == "number" then return renderNumber(v) end
    if t == "string" then return quote(v) end
    return renderTable(v)
end

local function runsHere(case)
    if case.lua == nil then return false end
    if case.luaVersions == nil then return true end
    for _, v in ipairs(case.luaVersions) do
        if not compat.isLuaJIT and _VERSION == "Lua " .. v then return true end
    end
    return false
end

local env = { math = math, string = string, coroutine = coroutine }
local count = 0
for _, case in ipairs(vectors.cases) do
    if runsHere(case) then
        count = count + 1
        test("codec vector " .. case.name, function()
            local fn, err = compat.loadWithEnv("return " .. case.lua, "=" .. case.name, env)
            assert(fn, err)
            local ok, copy = codec.copy(fn())
            if case.error then
                if ok then error("accepted " .. render(copy) .. ", expected refusal " .. case.error) end
                if copy ~= case.error then error("refused with " .. tostring(copy) .. ", expected " .. case.error) end
                return
            end
            if not ok then error("refused: " .. tostring(copy)) end
            if case.typed and render(copy) ~= case.typed then
                error("got " .. render(copy) .. ", expected " .. case.typed)
            end
        end)
    end
end

test("codec vectors are present", function()
    assert(count >= 35, "only " .. count .. " Lua vectors ran")
end)
