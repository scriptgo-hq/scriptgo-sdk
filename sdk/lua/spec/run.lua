-- SDK spec runner: lua run.lua <repoRoot> <manifestFixturesCsv> <spec.lua>...
-- Driven by tools/lua-test.mjs on every interpreter (lua54, lua51, luajit). Pure Lua: the file
-- list comes from the caller because standard Lua cannot list directories.
local args = { ... }
local root = (args[1] or "."):gsub("\\", "/"):gsub("/$", "")
local fixtures = {}
for name in (args[2] or ""):gmatch("[^,]+") do fixtures[#fixtures + 1] = name end

local scriptgo = assert(loadfile(root .. "/sdk/lua/scriptgo/init.lua"))(root .. "/sdk/lua/scriptgo/")
local testing = scriptgo.testing

local function readFile(path)
    local f = io.open(path, "rb")
    if not f then return nil end
    local text = f:read("*a")
    f:close()
    return text
end

local ctx = { root = root, readFile = readFile, fixtures = fixtures, scriptgo = scriptgo }

local total, failedTotal = 0, 0
local failures = {}
for i = 3, #args do
    local specPath = args[i]
    local chunk, err = loadfile(specPath)
    if not chunk then
        failedTotal = failedTotal + 1
        failures[#failures + 1] = specPath .. ": " .. tostring(err)
    else
        local suite = testing.suite()
        local ok, loadErr = pcall(chunk, suite, scriptgo, ctx)
        if not ok then
            failedTotal = failedTotal + 1
            failures[#failures + 1] = specPath .. " (load): " .. tostring(loadErr)
        else
            local result = suite.run()
            total = total + result.passed + result.failed
            failedTotal = failedTotal + result.failed
            for _, r in ipairs(result.results) do
                if not r.ok then failures[#failures + 1] = specPath:match("[^/\\]+$") .. " > " .. r.name .. "\n    " .. r.err:gsub("\n", "\n    ") end
            end
            io.write(("%-28s %3d passed, %d failed\n"):format(specPath:match("[^/\\]+$"), result.passed, result.failed))
        end
    end
end

for _, f in ipairs(failures) do io.write("FAIL " .. f .. "\n") end
io.write(("%s: %d tests, %d failed\n"):format(scriptgo.compat.version, total, failedTotal))
os.exit(failedTotal == 0 and 0 or 1)
