-- A FAKE BeamMP-Server process for the CLI's unit tests: it lets `verifyBeamMP` (packages/cli/src/
-- lib/beammp.ts) drive a process end to end (start, report, console `exit`, cleanup) without the
-- real server. It runs the plugin on the MOCK BeamMP API (mock_beammp.lua) and listens on nothing.
-- Never a verification: the real run needs BeamMP-Server and the owner's AuthKey.
--
--   lua53 fake_server.lua <serverFolder>
local run = assert(arg[1], "usage: fake_server.lua <serverFolder>"):gsub("\\", "/")
local here = (debug.getinfo(1, "S").source:gsub("^@", ""):gsub("\\", "/"):match("^(.*)/")) or "."
local mock = dofile(here .. "/mock_beammp.lua")

local function read(path)
    local f = io.open(path, "rb")
    if not f then return nil end
    local t = f:read("*a")
    f:close()
    return t
end

-- One line, so that the runner's log filter (lines naming BeamMP-Server) keeps it.
io.stdout:write("[INFO] FAKE BeamMP-Server v0.0.0 (unit test, not BeamMP), key length "
    .. #(os.getenv("BEAMMP_AUTH_KEY") or "") .. ", port override " .. tostring(os.getenv("BEAMMP_PORT")) .. "\n")
io.stdout:flush()
local plugin = run .. "/Resources/Server/scriptgo"
assert((loadstring or load)(assert(read(plugin .. "/main.lua")), plugin .. "/main.lua"))()
io.stdout:write("[INFO] ALL SYSTEMS STARTED SUCCESSFULLY, EVERYTHING IS OKAY\n")
io.stdout:flush()

local cfg = read(plugin .. "/scriptgo.json") or ""
local report = plugin .. "/" .. (cfg:match('"report"%s*:%s*"([^"]+)"') or "scriptgo-verify-report.json")
local function sleep(ms)
    local untilT = os.clock() + ms / 1000
    while os.clock() < untilT do end
end
local waited = 0
while not read(report) and waited < 60000 do
    sleep(25)
    mock.advance(25)
    waited = waited + 25
end
-- The console: wait for `exit`, as BeamMP's does.
for line in io.lines() do
    if line:match("^%s*exit%s*$") then
        mock.trigger("onShutdown")
        io.stdout:write("[INFO] Shutdown.\n")
        os.exit(0)
    end
end
os.exit(0)
