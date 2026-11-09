## SCRIPT//GO host for Godot 4.
##
## Runs SCRIPT//GO and OPEN//77 resources inside the game through lua-gdextension: creates a
## LuaState, loads the portable core (sdk/lua/scriptgo) with the Godot adapter, ticks the host from
## _process, forwards console commands and stops every resource when the node leaves the tree.
## Use it as an autoload named ScriptGoHost (see examples/godot/demo) or as a plain node.
##
## Headless verification (writes the same report as `scriptgo verify`, environment "godot"):
##   Godot_v4.5.2-stable_win64_console.exe --headless --path <project> -- \
##       --scriptgo-verify <resourceDir> [--search <dir>]... [--report <out.json>] [--settle 2000]
##       [--with <exampleDir>]
## Exit code 0 = verified, 1 = failing, 2 = setup error (no report written).
extends Node

## A notification a resource sent (ScriptGo.ui.notify): target, type, title, message, resource, durationMs.
signal notified(notification: Dictionary)
## Every host log line.
signal log_line(level: String, origin: String, message: String)

## Folder holding lua/scriptgo/ and adapters/godot/. Empty: --scriptgo-sdk, then
## res://addons/scriptgo/sdk, then an `sdk` folder in the project folder or one of its parents.
@export var sdk_root := ""
## Ticks the host from _process.
@export var auto_tick := true
## Echo host log lines to the Godot output.
@export var echo_logs := true

const LUA_LIBRARIES := ["LUA_BASE", "LUA_COROUTINE", "LUA_STRING", "LUA_OS", "LUA_MATH", "LUA_TABLE",
	"LUA_DEBUG", "LUA_UTF8", "GODOT_VARIANT", "GODOT_CLASSES"]
const CONTROLLER := ["info", "addSearchPath", "add", "startAll", "start", "stop", "stopAll", "join", "drop",
	"tick", "command", "callExport", "drainNotifications", "states", "commands", "verifyBegin", "verifyFinish"]

var lua: Object = null        # LuaState
var sdk_path := ""            # resolved sdk root, with a trailing "/"
var booted := false
var verifying := false
var _fn := {}                 # controller name -> LuaFunction
var _verify := {}
var _stopped := false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var args := OS.get_cmdline_user_args()
	if args.has("--scriptgo-verify"):
		verifying = true
		_verify_start(args)


## Creates the Lua state and the host. options: sdk_root, config (Dictionary: permissions,
## resources, convars), storage_dir (default user://scriptgo/storage), budget_ms, local_player
## ({id, name}), search (Array of folders where dependencies are looked up).
func boot(options: Dictionary = {}) -> bool:
	if booted:
		return true
	if not ClassDB.class_exists("LuaState"):
		push_error("ScriptGo: lua-gdextension is not loaded (run examples/godot/demo/setup.ps1, then import the project once)")
		return false
	sdk_path = _find_sdk_root(String(options.get("sdk_root", sdk_root)))
	if sdk_path == "":
		push_error("ScriptGo: SDK not found (set sdk_root or pass --scriptgo-sdk <dir>)")
		return false
	lua = ClassDB.instantiate("LuaState")
	var libs := 0
	for name in LUA_LIBRARIES:
		libs |= ClassDB.class_get_integer_constant("LuaState", name)
	# The LuaJIT build: open `jit` so the core reports LuaJIT, not "Lua 5.1". FFI stays closed.
	if String(lua.call("get_lua_runtime")) == "luajit":
		libs |= ClassDB.class_get_integer_constant("LuaState", "LUA_JIT")
	lua.open_libraries(libs)
	var source := FileAccess.get_file_as_string(sdk_path + "adapters/godot/runtime.lua")
	if source == "":
		push_error("ScriptGo: cannot read adapters/godot/runtime.lua under " + sdk_path)
		return false
	var boot_fn = lua.do_string(source, "@scriptgo/adapters/godot/runtime.lua")
	if _is_lua_error(boot_fn):
		push_error("ScriptGo: " + str(boot_fn.message))
		return false
	var lua_options := {
		"config": options.get("config", {}),
		"storageDir": options.get("storage_dir", "user://scriptgo/storage"),
		"localPlayer": options.get("local_player", {"id": 1, "name": "Player"}),
	}
	if options.has("budget_ms"):
		lua_options["budgetMs"] = options["budget_ms"]
	var ctl = boot_fn.invoke(sdk_path, JSON.stringify(lua_options), Callable(self, "_clock_usec"), Callable(self, "_on_lua_log"))
	if _is_lua_error(ctl) or ctl == null:
		push_error("ScriptGo: boot failed: " + (str(ctl.message) if ctl != null else "no controller"))
		return false
	for name in CONTROLLER:
		_fn[name] = ctl[name]
	for dir in options.get("search", []):
		_call("addSearchPath", [String(dir)])
	booted = true
	return true


## Adds a resource folder and its dependencies (found in the search paths). Returns "" or the reason.
func add_resource(path: String) -> String:
	return String(_call("add", [_resolve(path, true) if not path.begins_with("res://") else path]))

func add_search_path(dir: String) -> void:
	_call("addSearchPath", [_resolve(dir, true) if not dir.begins_with("res://") else dir])

## Starts every auto-start resource. Returns { name: "started" | reason }.
func start_all() -> Dictionary:
	var r = JSON.parse_string(String(_call("startAll")))
	return r if r is Dictionary else {}

func start(name: String) -> String:
	return String(_call("start", [name]))

func stop(name: String) -> bool:
	return bool(_call("stop", [name]))

func join(id: int, player_name: String) -> void:
	_call("join", [id, player_name])

func drop(id: int, reason := "disconnected") -> void:
	_call("drop", [id, reason])

## A command line as typed in a console (source 0) or by player `source`. Returns "" or the refusal.
func command(line: String, source := 0) -> String:
	return String(_call("command", [source, line]))

## Calls an export. Returns { ok, values } / { ok: false, pending | reason }.
func call_export(resource: String, export_name: String, side := "server", args: Array = []) -> Dictionary:
	var r = JSON.parse_string(String(_call("callExport", [resource, export_name, side, JSON.stringify(args)])))
	return r if r is Dictionary else {"ok": false, "reason": "bad_response"}

func resource_states() -> Dictionary:
	var r = JSON.parse_string(String(_call("states")))
	return r if r is Dictionary else {}

func info() -> Dictionary:
	var r = JSON.parse_string(String(_call("info")))
	return r if r is Dictionary else {}

## Advances the host to the current time and emits pending notifications.
func tick() -> void:
	if not booted:
		return
	var pending = _call("tick")
	if pending is int and pending > 0:
		var list = JSON.parse_string(String(_call("drainNotifications")))
		if list is Array:
			for n in list:
				notified.emit(n)

## Stops every resource (dependents first). Called automatically when the node leaves the tree.
func stop_all() -> void:
	if booted and not _stopped:
		_stopped = true
		_call("stopAll")


func _process(_delta: float) -> void:
	if verifying:
		_verify_frame()
	elif auto_tick:
		tick()


func _exit_tree() -> void:
	stop_all()
	_fn.clear()
	lua = null


func _clock_usec() -> int:
	return Time.get_ticks_usec()


func _on_lua_log(level, origin, message) -> void:
	var line := "[%s] %s %s" % [level, origin, message]
	if echo_logs:
		if level == "error":
			printerr(line)
		else:
			print(line)
	log_line.emit(String(level), String(origin), String(message))


func _call(name: String, args: Array = []) -> Variant:
	var fn = _fn.get(name)
	if fn == null:
		return null
	var r = fn.invokev(args)
	if _is_lua_error(r):
		push_error("ScriptGo: %s failed: %s" % [name, r.message])
		return null
	return r


func _is_lua_error(v) -> bool:
	return v is Object and v != null and v.get_class() == "LuaError"


# Paths -----------------------------------------------------------------------------------------------
# Godot changes the working directory to the project folder (--path), so a relative path is looked
# up from $PWD when the shell exports it (Git Bash does), then from the project folder and each of
# its parents. Returns an absolute path with forward slashes, or "" when nothing exists.
func _resolve(p: String, must_exist := true) -> String:
	p = p.replace("\\", "/")
	if p.is_absolute_path():
		return p.simplify_path()
	for base in _bases():
		var c: String = (String(base) + "/" + p).simplify_path()
		if not must_exist or DirAccess.dir_exists_absolute(c) or FileAccess.file_exists(c):
			return c
	return ""


func _bases() -> Array:
	var bases := []
	var pwd := OS.get_environment("PWD").replace("\\", "/")
	if pwd != "" and DirAccess.dir_exists_absolute(pwd):
		bases.append(pwd)
	var dir := ProjectSettings.globalize_path("res://").replace("\\", "/").trim_suffix("/")
	while dir != "":
		bases.append(dir)
		var parent := dir.get_base_dir()
		if parent == dir or parent == "" or parent.ends_with(":"):
			break
		dir = parent
	return bases


func _find_sdk_root(hint: String) -> String:
	var candidates := []
	if hint != "":
		candidates.append(hint if hint.begins_with("res://") else _resolve(hint))
	var args := OS.get_cmdline_user_args()
	var i := args.find("--scriptgo-sdk")
	if i >= 0 and i + 1 < args.size():
		candidates.append(_resolve(args[i + 1]))
	candidates.append("res://addons/scriptgo/sdk")
	for base in _bases():
		candidates.append(base + "/sdk")
	for c in candidates:
		var root := String(c).trim_suffix("/")
		if root != "" and FileAccess.file_exists(root + "/lua/scriptgo/init.lua") and FileAccess.file_exists(root + "/adapters/godot/runtime.lua"):
			return root + "/"
	return ""


# Verification ----------------------------------------------------------------------------------------
func _arg_values(args: PackedStringArray, flag: String) -> Array:
	var out := []
	for k in range(args.size() - 1):
		if args[k] == flag:
			out.append(args[k + 1])
	return out


func _verify_start(args: PackedStringArray) -> void:
	Engine.max_fps = 60
	var settle_values := _arg_values(args, "--settle")
	_verify = {
		"settle_ms": int(settle_values[0]) if settle_values.size() > 0 else 2000,
		"started_usec": Time.get_ticks_usec(),
		"frames": 0, "done": false, "redact": [],
	}
	# A script error must never leave a headless run hanging.
	get_tree().create_timer(_verify.settle_ms / 1000.0 + 30.0, true, false, true).timeout.connect(func():
		if not _verify.done:
			printerr("scriptgo verify: watchdog fired, the run did not finish")
			_verify.done = true
			get_tree().quit(1))
	var targets := _arg_values(args, "--scriptgo-verify")
	var resource_dir := _resolve(String(targets[0])) if targets.size() > 0 else ""
	if resource_dir == "":
		_verify_abort("resource folder not found: " + (String(targets[0]) if targets.size() > 0 else "(none)"))
		return
	var search := []
	for s in _arg_values(args, "--search"):
		var d := _resolve(String(s))
		if d == "":
			_verify_abort("search folder not found: " + String(s))
			return
		search.append(d)
	search.append(resource_dir.get_base_dir())
	var report_values := _arg_values(args, "--report")
	_verify.report = ""
	if report_values.size() > 0:
		var rp := String(report_values[0]).replace("\\", "/")
		var parent := _resolve(rp.get_base_dir()) if rp.get_base_dir() != "" else ""
		_verify.report = (parent + "/" + rp.get_file()) if parent != "" else _resolve(rp, false)
	# A fresh storage folder per run, so results do not depend on an earlier run.
	var storage := "user://scriptgo/verify/storage"
	DirAccess.make_dir_recursive_absolute(storage)
	for f in DirAccess.get_files_at(storage):
		DirAccess.remove_absolute(storage + "/" + f)
	if not boot({"storage_dir": storage, "local_player": {"id": 1, "name": "Verifier"}}):
		_verify_abort("boot failed")
		return
	_verify.redact = [[resource_dir, "<resource>"], [sdk_path.trim_suffix("/"), "<sdk>"],
		[ProjectSettings.globalize_path("res://").trim_suffix("/"), "<project>"],
		[ProjectSettings.globalize_path("user://").trim_suffix("/"), "<user>"]]
	for k in range(search.size()):
		_verify.redact.append([search[k], "<search%d>" % k])
	var with_dir := ""
	var with_values := _arg_values(args, "--with")
	if with_values.size() > 0:
		with_dir = _resolve(String(with_values[0]))
		if with_dir == "":
			_verify_abort("example folder not found: " + String(with_values[0]))
			return
		_verify.redact.append([with_dir.get_base_dir(), "<example>"])
	var begin = JSON.parse_string(String(_call("verifyBegin", [resource_dir, JSON.stringify(search), with_dir])))
	_verify.resources = begin.get("resources", []) if begin is Dictionary else []
	_verify.run_usec = Time.get_ticks_usec()
	if not (begin is Dictionary and begin.get("ok", false)):
		_verify_finish()


func _verify_frame() -> void:
	if _verify.get("done", true) or not booted:
		return
	tick()
	_verify.frames += 1
	if (Time.get_ticks_usec() - _verify.run_usec) / 1000.0 >= _verify.settle_ms:
		_verify_finish()


func _verify_finish() -> void:
	_verify.done = true
	var now := Time.get_ticks_usec()
	var info := Engine.get_version_info()
	var plugin := ConfigFile.new()
	var bridge := "unknown"
	if plugin.load("res://addons/lua-gdextension/plugin.cfg") == OK:
		bridge = String(plugin.get_value("plugin", "version", "unknown"))
	var lua_runtime := "%s (%s)" % [lua.call("get_lua_version_string"), lua.call("get_lua_runtime")]
	var elapsed_ms: float = (now - int(_verify.get("run_usec", now))) / 1000.0
	var ctx := {
		"runtimeVersion": "Godot %d.%d.%d-%s" % [info.major, info.minor, info.patch, info.status],
		"ranAt": Time.get_datetime_string_from_system(true) + "Z",
		"durationMs": int((now - _verify.started_usec) / 1000),
		"frames": _verify.frames, "elapsedMs": elapsed_ms, "settleMs": _verify.settle_ms,
		"evidence": [
			{"kind": "godot", "path": "%s, %s, headless=%s" % [info.string, OS.get_name(), DisplayServer.get_name() == "headless"]},
			{"kind": "lua-gdextension", "path": bridge},
			{"kind": "lua-runtime", "path": lua_runtime},
			{"kind": "frames", "path": "%d frames in %d ms (max_fps %d)" % [_verify.frames, int(elapsed_ms), Engine.max_fps]},
			{"kind": "resources", "path": ",".join(PackedStringArray(_verify.get("resources", [])))},
		],
		"redact": _verify.redact,
	}
	var text = _call("verifyFinish", [JSON.stringify(ctx)])
	var report = JSON.parse_string(String(text)) if text != null else null
	if not (report is Dictionary):
		_verify_abort("verifyFinish returned no report")
		return
	# JSON.parse_string reads every number as a float; the schema wants an integer.
	report.durationMs = int(report.durationMs)
	var out := JSON.stringify(report, "  ", false) + "\n"
	if _verify.report != "":
		DirAccess.make_dir_recursive_absolute(String(_verify.report).get_base_dir())
		var f := FileAccess.open(_verify.report, FileAccess.WRITE)
		if f == null:
			_verify_abort("cannot write report: error %d" % FileAccess.get_open_error())
			return
		f.store_string(out)
		f.close()
	var failed := 0
	for c in report.checks:
		print("  %-6s %s %s" % ["ok" if c.status == "passed" else ("skip" if c.status == "skipped" else "FAIL"), c.name, c.message])
		if c.status == "failed":
			failed += 1
	print("%s %s on godot: %s" % [report.package, report.version, report.status])
	get_tree().quit(0 if report.status == "verified" else 1)


func _verify_abort(why: String) -> void:
	_verify.done = true
	printerr("scriptgo verify: " + why)
	get_tree().quit(2)
