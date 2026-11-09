# Godot 4 adapter

Runs SCRIPT//GO (and OPEN//77-format) resources inside a Godot 4 game. The portable core
(`sdk/lua/scriptgo`) runs unchanged in a Lua state created by the
[lua-gdextension](https://github.com/gilzoide/lua-gdextension) addon (MIT); this folder adds the
Godot-specific parts.

| File | Role |
|---|---|
| `adapter.lua` | The adapter table the host calls: clock, logs, `FileAccess`/`DirAccess` reads and listing, JSON storage under `user://`, notification queue, privileges and config from options |
| `runtime.lua` | Lua glue: loads the core and the adapter inside the LuaState, creates the host, and returns a small controller for GDScript (plus the verify routine) |
| `scriptgo_host.gd` | The Godot node (autoload `ScriptGoHost`): creates the LuaState, boots the runtime, ticks the host from `_process`, forwards console commands, stops everything on exit, and runs `--scriptgo-verify` |
| `scriptgo_watchdog.gd` | Autoload that ends a headless verify run with exit code 2 if the host never reports (for example when `scriptgo_host.gd` fails to parse) |

`examples/godot/demo` is a working project that uses all of it.

## Versions (measured 2026-11-09)

| Component | Version | Download (SHA-256 of the zip) |
|---|---|---|
| Godot | 4.5.2-stable, Windows x86_64 | `Godot_v4.5.2-stable_win64.exe.zip` from the official GitHub release, `3766090865330ab2a0ed33594520394b711c620b1378f9223904faeef60f2f14` (its SHA-512 matches the release's `SHA512-SUMS.txt`) |
| lua-gdextension | 0.7.0, Lua 5.4 build (embeds Lua 5.4.7) | `lua-gdextension.zip`, `e0f940889a799abd3e9916be338417135996dd40adc2fe04af8abff230ebf644` |
| lua-gdextension | 0.7.0, LuaJIT build (embeds LuaJIT 2.1.1748459687) | `lua-gdextension+luajit.zip`, `13ab0a5ca12abf90db02c856a6e7eb44b6fd07ff0bddaac58054ddc1d96340b7` |

**Why 0.7.0 and not the latest (0.8.2).** The 0.8.x binaries are built against the Godot 4.6
API. Their `.gdextension` file declares `compatibility_minimum = "4.5"`, but Godot 4.5.2 refuses
them at load: `Cannot load a GDExtension built for Godot 4.6.0 using an older version of Godot
(4.5.2)`. 0.7.0 (godot-cpp 4.5, declared minimum 4.4) is the latest release that loads on 4.5.
Godot 4.4 itself was not tried. With Godot 4.6 or later, 0.8.x should be the one to use, but that
has not been measured.

## Setting up a project

1. Copy the addon folder `addons/lua-gdextension` from the release zip into the project.
2. Copy `scriptgo_host.gd` and `scriptgo_watchdog.gd` into the project (the demo uses
   `res://addons/scriptgo/`) and register them as autoloads, watchdog first:

   ```ini
   [autoload]
   ScriptGoWatchdog="*res://addons/scriptgo/scriptgo_watchdog.gd"
   ScriptGoHost="*res://addons/scriptgo/scriptgo_host.gd"
   ```

3. Open the project in the editor once, or run `Godot --headless --import --path <project>`. A plain
   run does not scan for GDExtensions: until `.godot/extension_list.cfg` lists the addon,
   `LuaState` does not exist. The **first** headless import of a fresh project sometimes crashes
   with signal 11 after it has written that file; a second import is clean (seen with both builds).
4. Tell the host where the SDK is. It looks, in order, at `sdk_root` (export variable or
   `boot({ sdk_root = ... })`), `--scriptgo-sdk <dir>` on the command line,
   `res://addons/scriptgo/sdk/`, then an `sdk/` folder in the project folder or any of its parents
   (how the demo finds the repository's SDK). For an exported game, copy `sdk/lua/scriptgo/` and
   `sdk/adapters/godot/*.lua` to `res://addons/scriptgo/sdk/lua/scriptgo/` and
   `res://addons/scriptgo/sdk/adapters/godot/` (not measured in an export yet).

`examples/godot/demo/setup.ps1` does steps 1 to 3 for the demo from `tools/runtimes/godot/`.

## Using it from GDScript

```gdscript
func _ready():
    ScriptGoHost.notified.connect(func(n): print("toast: ", n.title, " ", n.message))
    ScriptGoHost.boot({
        "config": {"resources": {"sg_inventory": {"slots": 12}}, "permissions": {"1": ["inventory.*"]}},
    })
    ScriptGoHost.add_search_path(ScriptGoHost.sdk_path + "packages")   # where dependencies are found
    ScriptGoHost.add_resource(ScriptGoHost.sdk_path + "packages/sg_inventory")
    ScriptGoHost.start_all()
    ScriptGoHost.join(1, "Player")                                     # the local player

func _on_give_pressed():
    ScriptGoHost.command("giveitem 1 water 1")         # console (source 0)
    ScriptGoHost.command("/inventory", 1)              # typed by player 1
    var state = ScriptGoHost.call_export("sg_inventory", "getState", "client")
    # { ok = true, values = [ { slots, weight, items = [...] } ] }
```

`boot(options)`: `config` (`permissions` per player id with `*` and `prefix.*` wildcards,
`resources` per resource name, `convars`), `storage_dir` (default `user://scriptgo/storage`),
`budget_ms` (per-resume execution budget; off by default), `local_player` (`{id, name}`, default
`{1, "Player"}`), `search`. Other members: `start(name)`, `stop(name)`, `stop_all()`,
`drop(id, reason)`, `resource_states()`, `info()`, `tick()` (automatic while `auto_tick` is on),
signals `notified(Dictionary)` and `log_line(level, origin, message)`.

Exports that do not `Wait` settle inside `call_export`; one that waits answers
`{ ok = false, pending = true }`.

## The Lua state

`scriptgo_host.gd` opens `LUA_BASE`, `LUA_COROUTINE`, `LUA_STRING`, `LUA_OS`, `LUA_MATH`,
`LUA_TABLE`, `LUA_DEBUG`, `LUA_UTF8`, `GODOT_VARIANT`, `GODOT_CLASSES` (plus `LUA_JIT` on the
LuaJIT build, so the core reports LuaJIT instead of "Lua 5.1"). Not opened: `io`, `package`, FFI,
`GODOT_SINGLETONS`, `GODOT_UTILITY_FUNCTIONS` (which would replace `print`). Files are read with
`FileAccess:get_file_as_string` after `FileAccess:file_exists`, listed with
`DirAccess:get_files_at` / `get_directories_at` after `DirAccess:dir_exists_absolute` (without that
check a missing folder prints a Godot `ERROR`). The core gets `os.time` and `os.clock` from the
`os` library; resources still see only the sandbox (`os.time/clock/date/difftime`, no Godot class).

**Lua must not touch the `Time` singleton.** Measured with lua-gdextension 0.7.0 on Godot 4.5.2:
any script that reads the global `Time` (even `local T = Time`, with `GODOT_SINGLETONS` open)
makes Godot crash with signal 11 at exit (exit code 139), after the work is done. `OS`, `Engine`,
`FileAccess` and `DirAccess` do not. The adapter therefore takes its monotonic clock from a
GDScript `Callable` over `Time.get_ticks_usec()`, and the host never opens `GODOT_SINGLETONS`.

Calls in Lua on Godot classes use `:` (`FileAccess:file_exists(p)`); with `.` the bridge prints
an error and returns nil. Godot classes are resolved through `_G`'s metatable, so `rawget(_G,
"FileAccess")` is nil while `_G.FileAccess` works.

## Headless verification

```bash
pwsh -File examples/godot/demo/setup.ps1     # once, and after editing scriptgo_host.gd
tools/runtimes/godot/godot-4.5.2-stable/Godot_v4.5.2-stable_win64_console.exe --headless \
  --path examples/godot/demo -- --scriptgo-verify sdk/conformance/sg_probe --search sdk/packages \
  --report verification/reports/sg_probe-0.1.0-godot.json
```

Godot changes its working directory to the project (`--path`), so relative paths are looked up
from `$PWD` when the shell exports it (Git Bash does), then from the project folder and each of its
parents; absolute paths are used as given. Options: `--search <dir>` (repeatable; the resource's own
parent folder is always searched), `--report <file>`, `--settle <ms>` (default 2000),
`--scriptgo-sdk <dir>`.

The run adds the resource and its dependencies, starts it, joins the local player (id 1), runs
`--settle` milliseconds of real frames (`Engine.max_fps = 60`), then drops the player, stops
everything and writes the report. Storage goes to `user://scriptgo/verify/storage`, emptied before
each run. Checks, in order: `manifest_valid`, `environment_declared`, `dependencies_resolved` (fails
when a declared dependency is not found), `starts`, `export:<name>` for declared `server_exports`,
`real_frames` (at least 30 frames over 90 % of the settle time), `no_runtime_errors`, one
`self:<name>` per `SGCHECK PASS|FAIL <name>` line (plus `self:done` when `SGCHECK DONE` never comes,
as `selfChecks` in `packages/cli/src/commands/verify.ts`), and `tests`: the resource's `test_script`
files run in the same LuaState on the memory harness, like `scriptgo test`.

The report follows `CompatibilityRunSchema` (`packages/shared/src/registry.ts`): `runId`
(`<package>@<version>:godot:<ranAt>`), `package`, `version`, `environment: "godot"`,
`status: verified|failing`, `runtimeVersion` (`Godot 4.5.2-stable`), `adapterVersion`
(`godot-0.1.0`), `luaVersion`, `ranAt` (UTC), `durationMs`, `checks`, `log`, and `evidence` as
`[{kind, path}]` (Godot build, lua-gdextension version, Lua runtime, frame count, resources).
Absolute paths are replaced by `<resource>`, `<sdk>`, `<project>`, `<user>`, `<searchN>` and
`<home>`. Exit code: 0 verified, 1 failing, 2 setup error (bridge or SDK missing, path not found;
no report is written).

### Results (2026-11-09, Godot 4.5.2, Windows x86_64)

| Resource | Lua 5.4 build | LuaJIT build |
|---|---|---|
| `sdk/conformance/sg_probe` | verified, 25/25 self checks, tests 1/1 | verified, 25/25, tests 1/1 |
| `sdk/packages/sg_eventbus` | verified, tests 5/5 | verified, tests 5/5 |
| `sdk/packages/sg_permissions` | verified, tests 9/9 | verified, tests 9/9 |
| `sdk/packages/sg_inventory` | verified, tests 10/10 | verified, tests 10/10 |

Each run: about 120 frames in 2 s, exit code 0, no crash at exit. The Lua 5.4 reports are
`verification/reports/<name>-<version>-godot.json`; the LuaJIT runs were made from a scratch copy
of the demo and their reports are not kept (one report per environment). A negative control (a
resource that prints `SGCHECK FAIL` and raises in a thread) gave `failing`, exit code 1, with
`no_runtime_errors`, the failed self check and `self:done` reported. The demo was also run in a
window (OpenGL 3.3 compatibility renderer) with scripted keys and a screenshot.

## Limitations

- **No HTTP, so no licensing.** `ScriptGo.http` and `ScriptGo.licensing` raise
  `capability_unavailable:http@godot`. The host's HTTP contract is callback based
  (`adapter.http.request(req, done)`), so a Godot `HTTPRequest` node answering through
  `request_completed` would fit without threads; it is not written or measured.
- **Single process, one local player.** Server and client sides run in the game; network events are
  looped back through the value codec. No multiplayer between Godot peers.
- **Measured on Windows x86_64 only**, Godot 4.5.2, headless and windowed, from the editor-less
  runtime with `--path`. Exported builds, macOS, Linux, mobile and Web are not measured.
- `scriptgo_host.gd` is copied into the project; after changing the SDK copy, re-run `setup.ps1`.
- Godot's `JSON.parse_string` turns every number into a float, which is why the controller returns
  JSON text and the host turns `durationMs` back into an integer before writing the report.
