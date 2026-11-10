# LÖVE adapter (`love2d`)

Runs SCRIPT//GO resources inside a [LÖVE](https://love2d.org) game. The server side and the local
client (player `1`) both run in the game process, on the same portable host as every other
environment (`sdk/lua/scriptgo`); network events between them are looped back through the value
codec, so isolation rules are the ones of a real network.

| File | Role |
|---|---|
| `adapter.lua` | The adapter the host calls: clock, logging, files, storage, toasts, permissions, config, HTTP |
| `scriptgo_love.lua` | What a game uses: loads the core and the adapter, adds resources with their dependencies, runs them |
| `verify.lua` | Headless verification mode (`--scriptgo-verify`), loaded on demand |

What the adapter maps:

| Capability | LÖVE |
|---|---|
| clock | `love.timer.getTime()` |
| `storage` | `<save directory>/scriptgo/storage/<resource>.json` (and `<resource>.client.json`) through `love.filesystem` |
| `ui` | toasts drawn by `sg:draw()` for the local player and for `-1`, and logged; headless, they are only logged |
| `permissions`, `config` | the `config` table the game passes (below) |
| `players` | the single local player, id `1` |
| `http`, `licensing` | `curl` through `io.popen`, in a `love.thread` worker so the game keeps drawing; unavailable when `io.popen` or `curl` is missing, and `licensing` follows `http` |

## Integrating it in a game

Copy the three `.lua` files of this folder and the core (`sdk/lua/scriptgo/*.lua`) into the game,
and put resources in a folder of the game:

```
mygame/
  conf.lua
  main.lua
  lib/scriptgo_love.lua  lib/adapter.lua  lib/verify.lua
  lib/scriptgo/          init.lua, host.lua, ... (sdk/lua/scriptgo)
  resources/sg_inventory/  resources/sg_eventbus/  ...
```

```lua
-- main.lua
local scriptgoLove = require("lib.scriptgo_love")
if scriptgoLove.verify(arg) then return end   -- optional: headless verification mode

local sg
function love.load()
    sg = scriptgoLove.new({
        resources = { "sg_inventory", "sg_permissions" },   -- names, dependencies are added too
        search = { "resources" },
        player = { id = 1, name = "Ada" },
        config = {
            permissions = { ["1"] = { "inventory.give" } },              -- privileges per player id
            resources = { sg_inventory = { slots = 12, maxWeight = 20 } }, -- ScriptGo.config.get
            convars = { scriptgo_api = "https://api.scriptgo.dev" },          -- GetConvar
            -- http = false,                                             -- switch HTTP off
        },
    })
end
function love.update(dt) sg:update(dt) end
function love.draw()
    -- ... the game ...
    sg:draw()                                   -- toasts, and the console when it is open
end
function love.keypressed(key, scancode, isrepeat)
    if sg:keypressed(key, scancode, isrepeat) then return end
    -- ... the game's own keys ...
end
function love.textinput(text) sg:textinput(text) end
function love.quit() sg:shutdown() end
```

```lua
-- conf.lua (only needed for the verification mode)
local scriptgoLove = require("lib.scriptgo_love")
function love.conf(t)
    t.identity = "mygame"
    scriptgoLove.conf(t, arg)  -- headless when --scriptgo-verify is on the command line
end
```

`scriptgo_love` finds the core next to itself (`lib/scriptgo/`) or, in this repository, at
`sdk/lua/scriptgo`; `core = "<folder>"` overrides it. This layout works from a folder and from a
`.love` archive, with `love.filesystem` only (no `io`).

**Paths.** An absolute path (`C:/...`, `/home/...`) is read with `io`; any other path is a
`love.filesystem` path (the game folder, then the save directory). Script globs in a manifest are
expanded from `love.filesystem.getDirectoryItems`, or, for an absolute resource folder, from
`dir /s /b` / `find` through `io.popen`.

### `scriptgoLove.new(options)`

| Option | Default | |
|---|---|---|
| `resources` | `{}` | resource names (looked up in `search`) or folders |
| `search` | `{ "" }` (the game folder) | folders that hold resource folders |
| `player` | `{ id = 1, name = "Player" }` | the local player; joins after the resources start |
| `config` | `{}` | `permissions`, `resources`, `convars`, `http` |
| `storageDir` | `"scriptgo/storage"` | folder of the save directory |
| `autoStart` | `true` | `false` adds resources without starting them (call `sg:start()`) |
| `core` | found | folder of the core's `init.lua` |
| `curl` | `"curl"` | the curl executable |
| `httpThread` | `true` | `false` runs curl on the main thread, which freezes the frame for the request |
| `budgetMs` | none | per-resume execution budget (`debug.sethook`) |
| `consoleKey` | `` ` `` (scancode) | toggles the console |
| `logLevel`, `quiet`, `logSink` | `info`, `false`, none | as the standalone adapter; `quiet` keeps the log off stdout |

### The `sg` object

| Member | |
|---|---|
| `sg:update(dt)` | delivers finished HTTP requests and ticks the host (clock: `love.timer`) |
| `sg:draw()` | toasts top-right, and the console when open |
| `sg:keypressed(key, scancode, isrepeat)` | `true` when consumed (console). Other keys reach client scripts as the event `love:keypressed` (`key, scancode, isrepeat`) |
| `sg:textinput(text)` | `true` when consumed (console) |
| `sg:command(line)` | runs a command as the console (source `0`) |
| `sg:playerCommand(line)` | runs it as the local player: client command first, then the server's; `restricted` commands check `command.<name>` |
| `sg:call(resource, export, side, ...)` | calls an export (`side` defaults to `"server"`); answers its values, or `nil, "pending", promise` when the export waits |
| `sg:emit(side, name, ...)` | raises a host event on `"server"` or `"client"` |
| `sg:shutdown()` | the player drops, every resource stops (dependents first), the HTTP worker ends |
| `sg.host`, `sg.adapter`, `sg.logs` | the host, the adapter, the last 500 log entries |

The console (`` ` `` by default, the key under Escape) shows the log; a line starting with `/` runs
as the local player's chat command, any other line as a console command.

## The demo

`examples/love2d/demo` loads `sg_inventory`, `sg_eventbus` and `sg_permissions` from
`sdk/packages` and draws the client's inventory mirror. It runs from the repository (its
`conf.lua` points `package.path` at this folder):

```bash
love examples/love2d/demo
```

Keys: `G` gives a random item (console), `T` runs `/giveitem` as the player (refused until the
player has a role that grants `inventory.give`), `A` grants or revokes `admin` through
PermissionsKit, `U` uses slot 1, `C` clears the inventory, `` ` `` opens the console. The inventory
and the roles persist in the demo's save directory.

## Verification mode

```bash
lovec examples/love2d/demo --scriptgo-verify sdk/conformance/sg_probe --search sdk/packages \
      --report verification/reports/sg_probe-0.1.0-love2d.json
```

Any game whose `main.lua` calls `scriptgoLove.verify(arg)` (and whose `conf.lua` calls
`scriptgoLove.conf(t, arg)`) accepts it. With the flag, LÖVE starts without a window and without
the graphics, audio and input modules, under the save identity `scriptgo_verify`, with fresh
storage in `scriptgo-verify/storage` (the game's own save is never touched). It then:

1. checks the manifest and that `environments` lists `love2d` (or is empty);
2. adds the resource and its dependencies from `--search`, starts it, checks its `server_exports`;
3. lets the local player join and ticks everything from real `love.update` frames for
   `--settle` ms (default 2000), then stops it;
4. turns the log into checks: `no_runtime_errors`, one `self:<name>` per
   `SGCHECK PASS|FAIL <name> [detail]` line (read as the CLI's `selfChecks` does; `self:done`
   fails when `SGCHECK DONE` never comes), then `tests`: the resource's `test_script` files on the
   in-memory harness, inside LÖVE's LuaJIT;
5. prints the `SGCHECK` lines and the checks, writes the report and quits with `0` (verified),
   `1` (failing) or `2` (usage or internal error).

The report is a `CompatibilityRun`: `runId` (`<package>@<version>:love2d:<ranAt>`), `package`,
`version`, `environment: "love2d"`, `status`, `runtimeVersion` (`LÖVE 11.5`), `adapterVersion`,
`luaVersion`, `ranAt`, `durationMs`, `log`, `checks`, and `evidence` as `{ kind, path }` entries
(LÖVE version, interpreter, OS, frame count, resources, capabilities, HTTP mode, storage files).
`--evidence <kind>=<value>` (repeatable) adds entries, such as the runtime zip's SHA-256. Local
paths are replaced by `.`, `<save>` or `~` before the report is written.

## Measured

On 2026-11-09, Windows 11, LÖVE 11.5 win64 from the official GitHub release
(`love-11.5-win64.zip`, SHA-256
`ba6e56be2685e53c817749c4a5007f51137136fe5a3ab64920508babc2e74369`), `lovec.exe`, LuaJIT
2.1.1700008891:

| Run | Result |
|---|---|
| `sg_probe` 0.1.0 | verified: 25/25 self checks, its test, no runtime errors (~1300 frames in 2 s) |
| `sg_eventbus`, `sg_permissions`, `sg_inventory` 1.0.0 | verified: start, no runtime errors, their tests (5, 9 and 10 passing) |
| HTTP through the worker | GET, POST with a UTF-8 body, `&` in the query and a header with a space, against a loopback server; a refused connection answers `status = 0, error = "connection_failed"`; the host kept ticking (537 ticks) during an 800 ms request |
| `licensing.verify` | reached a loopback mock of `/v1/licenses/verify` with `environment = "love2d"` |
| `httpThread = false` | works, and freezes the frame for the whole request (1 tick during it) |
| `config.http = false` | `http` and `licensing` reported unavailable; `sg_probe` still 25/25, its `capabilities.refusal` check exercising the real refusal |
| script globs | on an absolute resource folder (`dir /s /b`) and on a `love.filesystem` folder |
| restricted commands, console, `love:keypressed`, toasts, storage file, shutdown | as described above |
| vendored layout | from a folder and from a `.love` archive, with `love.filesystem` only |
| windowed demo | drawn and driven by its keys; toasts and console rendered |

## Limitations

- Single player: the client side is the local player `1`; there is no network between processes.
- HTTP needs `io.popen` and a `curl` executable. It returns the status and the body, not the
  response headers. Without them, `http` and `licensing` are reported unavailable and every call
  raises `capability_unavailable:http@love2d`.
- Measured only through `lovec.exe` (the console build). With `love.exe`, Windows may open a
  console window for each `curl` process; not measured.
- Not measured: macOS, Linux, Android, iOS, fused executables, LÖVE 12.
- The verification mode reads the resource under test with `io` (absolute paths), so it verifies
  folders on disk, not resources packed inside a `.love` archive.
