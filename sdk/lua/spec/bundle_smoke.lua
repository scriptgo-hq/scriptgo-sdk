-- Loads the single-file bundle (tools/bundle-lua.mjs) and runs the conformance probe through it.
--   lua bundle_smoke.lua <bundle.lua> <repoRoot>
local bundlePath, root = ...
local scriptgo = dofile(bundlePath)
assert(type(scriptgo) == "table" and scriptgo.VERSION, "the bundle did not return the core")

local function readFile(path)
    local f = io.open(path, "rb")
    if not f then return nil end
    local text = f:read("*a")
    f:close()
    return text
end

local h = scriptgo.testing.harness({ readFile = readFile })
for _, dir in ipairs({ "sdk/packages/sg_eventbus", "sdk/packages/sg_permissions", "sdk/packages/sg_inventory", "sdk/conformance/sg_probe" }) do
    h:add(root .. "/" .. dir)
end
assert(h:start("sg_probe"))
h:tick(1000)
local r = h:call("sg_probe", "results")
assert(r and r.done, "the probe did not finish")
if r.fail > 0 then
    for _, line in ipairs(r.lines) do print(line) end
    error(("bundle: %d probe checks failed"):format(r.fail))
end
print(("bundle %s on %s: probe %d/%d"):format(scriptgo.VERSION, scriptgo.compat.version, r.pass, r.pass + r.fail))
