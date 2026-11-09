-- Runs the fixtures shared with packages/manifest (TypeScript) through the Lua parser.
local suite, scriptgo, ctx = ...
local test, expect = suite.test, scriptgo.testing.expect
local json, manifest, semver = scriptgo.json, scriptgo.manifest, scriptgo.semver

-- Partial match with vitest toMatchObject semantics: objects are subsets, arrays match exactly,
-- JSON null matches nil.
local function matches(actual, expected, path)
    if expected == json.null then
        if actual ~= nil then return false, path .. ": expected null, got " .. scriptgo.testing.show(actual) end
        return true
    end
    if type(expected) ~= "table" then
        if actual ~= expected then
            return false, path .. ": expected " .. scriptgo.testing.show(expected) .. ", got " .. scriptgo.testing.show(actual)
        end
        return true
    end
    if type(actual) ~= "table" then return false, path .. ": expected a table, got " .. scriptgo.testing.show(actual) end
    local isArray = #expected > 0 or next(expected) == nil and getmetatable(expected) ~= json.objectMeta
    if isArray and #expected > 0 then
        if #actual ~= #expected then return false, path .. ": expected " .. #expected .. " items, got " .. #actual end
    end
    for k, v in pairs(expected) do
        local ok, why = matches(actual[k], v, path .. "." .. tostring(k))
        if not ok then return false, why end
    end
    return true
end

suite.describe("manifest fixtures (shared with TypeScript)", function()
    test("has fixtures", function() expect(#ctx.fixtures > 10).toBe(true) end)
    for _, name in ipairs(ctx.fixtures) do
        test(name, function()
            local dir = ctx.root .. "/sdk/lua/spec/fixtures/manifests/"
            local source = assert(ctx.readFile(dir .. name .. ".lua"))
            local exp = json.decode(assert(ctx.readFile(dir .. name .. ".expect.json")))
            local result = manifest.parse(source, exp.fileName or "scriptgo.lua")
            expect(result.ok).toBe(exp.ok)
            if exp.errors then
                local codes = {}
                for _, e in ipairs(result.errors or {}) do codes[#codes + 1] = e.code end
                expect(codes).toEqual(exp.errors)
            end
            if exp.warnings then
                local codes = {}
                for _, w in ipairs(result.warnings) do codes[#codes + 1] = w.code end
                expect(codes).toEqual(exp.warnings)
            end
            if exp.manifest and result.ok then
                local ok, why = matches(result.manifest, exp.manifest, "manifest")
                if not ok then error(why, 0) end
            end
        end)
    end
end)

suite.describe("scriptgo.json fixtures (shared with TypeScript)", function()
    test("has fixtures", function() expect(#ctx.jsonFixtures > 8).toBe(true) end)
    for _, name in ipairs(ctx.jsonFixtures) do
        test(name, function()
            local dir = ctx.root .. "/sdk/lua/spec/fixtures/manifests-json/"
            local source = assert(ctx.readFile(dir .. name .. ".json"))
            local exp = json.decode(assert(ctx.readFile(dir .. name .. ".expect.json")))
            local result = manifest.parse(source, exp.fileName or "scriptgo.json")
            expect(result.ok).toBe(exp.ok)
            if exp.errors then
                local codes = {}
                for _, e in ipairs(result.errors or {}) do codes[#codes + 1] = e.code end
                expect(codes).toEqual(exp.errors)
            end
            if exp.warnings then
                local codes = {}
                for _, w in ipairs(result.warnings) do codes[#codes + 1] = w.code end
                expect(codes).toEqual(exp.warnings)
            end
            if exp.manifest and result.ok then
                local ok, why = matches(result.manifest, exp.manifest, "manifest")
                if not ok then error(why, 0) end
            end
            -- JSON diagnostics carry no line.
            for _, d in ipairs(result.errors or {}) do expect(d.line).toBe(nil) end
            for _, d in ipairs(result.warnings) do expect(d.line).toBe(nil) end
        end)
    end
end)

suite.describe("script languages", function()
    test("maps extensions to guest languages", function()
        expect(manifest.scriptLanguage("server/main.lua")).toBe("lua")
        expect(manifest.scriptLanguage("server/main.ts")).toBe("js")
        expect(manifest.scriptLanguage("client/ui.js")).toBe("js")
        expect(manifest.scriptLanguage("server/main.cs")).toBe(nil)
    end)
    test("lists the languages of every script entry, sorted", function()
        local r = manifest.parse([[resource "mixed"
version "1.0.0"
scriptgo_version ">=0.1.0"
shared_script "shared/a.lua"
server_script "server/b.ts"
environment_script "love2d" "env/c.js"
]], "scriptgo.lua")
        expect(r.ok).toBe(true)
        expect(manifest.scriptLanguages(r.manifest)).toEqual({ "js", "lua" })
    end)
end)

suite.describe("semver (same table as the TypeScript tests)", function()
    local cases = {
        { "1.4.1", ">=1.0.0", true }, { "0.9.9", ">=1.0.0", false }, { "1.9.0", "^1.2.0", true },
        { "2.0.0", "^1.2.0", false }, { "0.1.5", "^0.1", true }, { "0.2.0", "^0.1.0", false },
        { "1.2.9", "~1.2.0", true }, { "1.3.0", "~1.2.0", false }, { "2.1.0", "1.x || 2.x", true },
        { "1.0.0-beta.1", ">=1.0.0", false }, { "1.5.0", ">=1.0.0 <2.0.0", true },
    }
    for _, c in ipairs(cases) do
        test(c[1] .. " satisfies " .. c[2] .. " -> " .. tostring(c[3]), function()
            expect(semver.satisfies(c[1], c[2])).toBe(c[3])
        end)
    end
end)

suite.describe("globs (same cases as packages/manifest)", function()
    test("client/**/*.lua needs an intermediate directory", function()
        expect(manifest.expandGlob("client/**/*.lua", { "client/main.lua" })).toEqual({})
        expect(manifest.expandGlob("client/**/*.lua", { "client/ui/main.lua" })).toEqual({ "client/ui/main.lua" })
    end)
    test("a trailing ** matches everything below", function()
        expect(manifest.expandGlob("web/**", { "web/js/app.js", "web/index.html" })).toEqual({ "web/index.html", "web/js/app.js" })
    end)
    test("* and ? stay inside one segment", function()
        expect(manifest.expandGlob("data/*.json", { "data/a.json", "data/x/b.json" })).toEqual({ "data/a.json" })
        expect(manifest.globMatch("img/?.png", "img/a.png")).toBe(true)
        expect(manifest.globMatch("img/?.png", "img/ab.png")).toBe(false)
    end)
    test("a plain path matches only itself", function()
        expect(manifest.expandGlob("a.lua", { "a.lua", "b.lua" })).toEqual({ "a.lua" })
    end)
end)
