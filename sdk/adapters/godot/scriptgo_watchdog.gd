## Ends a headless `--scriptgo-verify` run that cannot finish: if scriptgo_host.gd fails to parse
## or an error stops its frame loop, Godot would otherwise keep running forever. Register it as an
## autoload before ScriptGoHost. It depends on nothing, so it still loads when the host does not.
## Exit code 2 = setup error; no report is written.
extends Node

const LIMIT_SECONDS := 90.0


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	if not OS.get_cmdline_user_args().has("--scriptgo-verify"):
		return
	get_tree().create_timer(LIMIT_SECONDS, true, false, true).timeout.connect(func():
		printerr("scriptgo verify: no result after %d s (did scriptgo_host.gd load?)" % int(LIMIT_SECONDS))
		get_tree().quit(2))
