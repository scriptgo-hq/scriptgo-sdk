## SCRIPT//GO Godot demo: InventoryKit, EventBus and PermissionsKit from sdk/packages, driven by keys.
## Everything on screen comes from the resources: the inventory is the client mirror of
## sg_inventory (export getState), the roles come from sg_permissions, the toasts are
## ScriptGo.ui.notify calls queued by the Godot adapter.
extends Control

const CREAM := Color("#F4EFE4")
const INK := Color("#111111")
const COBALT := Color("#1F3FD1")
const YELLOW := Color("#FFD23F")
const PACKAGES := ["sg_eventbus", "sg_permissions", "sg_inventory"]
const GIFTS := ["water", "bread", "bandage", "rope", "scrap", "coin", "toolbox"]
const COLS := 6
const SLOT := 92.0

var font: Font
var state := {"slots": 0, "maxWeight": 0, "weight": 0, "items": []}
var roles: Array = []
var states := {}
var selected := 1
var toasts: Array = []   # { title, message, type, until }
var info := {}
var poll := 0.0
var booted := false
var gift := 0
# --demo-keys "g,g,u,h,p,h" and --demo-screenshot out.png: scripted run, then a screenshot and quit.
var script_keys: Array = []
var screenshot := ""
var frame := 0


func _ready() -> void:
	font = ThemeDB.fallback_font
	if ScriptGoHost.verifying:
		return
	var args := OS.get_cmdline_user_args()
	for i in range(args.size() - 1):
		if args[i] == "--demo-keys":
			script_keys = Array(args[i + 1].split(",", false))
		elif args[i] == "--demo-screenshot":
			screenshot = args[i + 1]
	ScriptGoHost.notified.connect(_on_notified)
	var config := {
		"resources": {"sg_inventory": {"slots": 12, "maxWeight": 20}},
		# No host privileges for player 1: PermissionsKit decides (press P to grant the admin role).
		"permissions": {},
	}
	if not ScriptGoHost.boot({"config": config}):
		push_error("SCRIPT//GO did not boot; see the errors above (did you run setup.ps1?)")
		return
	ScriptGoHost.add_search_path(ScriptGoHost.sdk_path + "packages")
	for name in PACKAGES:
		var err := ScriptGoHost.add_resource(ScriptGoHost.sdk_path + "packages/" + name)
		if err != "":
			push_error("%s: %s" % [name, err])
	var results := ScriptGoHost.start_all()
	for name in results:
		if results[name] != "started":
			push_error("%s: %s" % [name, results[name]])
	ScriptGoHost.join(1, "Player")
	info = ScriptGoHost.info()
	booted = true


func _process(delta: float) -> void:
	if not booted:
		return
	poll -= delta
	if poll <= 0.0:
		poll = 0.1
		_refresh()
	var now := Time.get_ticks_msec()
	toasts = toasts.filter(func(t): return t.until > now)
	frame += 1
	if not script_keys.is_empty() and frame > 30 and frame % 12 == 0:
		_action(String(script_keys.pop_front()))
	elif screenshot != "" and script_keys.is_empty() and frame > 30 and frame % 12 == 0:
		_refresh()
		queue_redraw()
		await RenderingServer.frame_post_draw
		get_viewport().get_texture().get_image().save_png(screenshot)
		print("demo: screenshot written")
		screenshot = ""
		get_tree().quit(0)
	queue_redraw()


func _refresh() -> void:
	var r := ScriptGoHost.call_export("sg_inventory", "getState", "client")
	if r.get("ok", false) and r.values.size() > 0 and r.values[0] is Dictionary:
		state = r.values[0]
	var p := ScriptGoHost.call_export("sg_permissions", "roles", "client")
	if p.get("ok", false) and p.values.size() > 0 and p.values[0] is Array:
		roles = p.values[0]
	states = ScriptGoHost.resource_states()


func _unhandled_key_input(event: InputEvent) -> void:
	if not (event is InputEventKey and event.pressed and not event.echo) or not booted:
		return
	match event.keycode:
		KEY_G: _action("g")
		KEY_H: _action("h")
		KEY_P: _action("p")
		KEY_U: _action("u")
		KEY_C: _action("c")
		KEY_I: _action("i")
		KEY_LEFT: _action("left")
		KEY_RIGHT: _action("right")
		KEY_UP: _action("up")
		KEY_DOWN: _action("down")
		KEY_ESCAPE: get_tree().quit()


func _action(key: String) -> void:
	var slots := maxi(1, int(state.get("slots", 12)))
	match key:
		"g":  # the console gives an item: always allowed
			ScriptGoHost.command("giveitem 1 %s 1" % GIFTS[gift % GIFTS.size()], 0)
			gift += 1
		"h":  # the player types it: refused unless PermissionsKit grants inventory.give
			ScriptGoHost.command("/giveitem 1 coin 5", 1)
		"p":  # the console toggles the admin role of player 1
			ScriptGoHost.command("perm %s 1 admin" % ("revoke" if roles.has("admin") else "grant"), 0)
		"u":
			ScriptGoHost.call_export("sg_inventory", "use", "client", [selected])
		"c":
			ScriptGoHost.call_export("sg_inventory", "clear", "server", [1])
		"i":
			ScriptGoHost.command("/inventory", 1)
		"left": selected = (selected - 2 + slots) % slots + 1
		"right": selected = selected % slots + 1
		"up": selected = (selected - 1 - COLS + slots * 2) % slots + 1
		"down": selected = (selected - 1 + COLS) % slots + 1
	poll = 0.0


func _on_notified(n: Dictionary) -> void:
	toasts.append({"title": n.get("title", ""), "message": n.get("message", ""), "type": n.get("type", "info"),
		"until": Time.get_ticks_msec() + int(n.get("durationMs", 3500))})
	while toasts.size() > 3:
		toasts.pop_front()


func _item_in(slot: int) -> Dictionary:
	for it in state.get("items", []):
		if int(it.get("slot", 0)) == slot:
			return it
	return {}


func _text(pos: Vector2, s: String, size := 16, color := INK, width := -1.0) -> void:
	draw_string(font, pos, s, HORIZONTAL_ALIGNMENT_LEFT, width, size, color)


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), CREAM)
	_text(Vector2(32, 52), "SCRIPT//GO", 30, INK)
	_text(Vector2(206, 52), "on Godot", 30, COBALT)
	if not booted:
		_text(Vector2(32, 96), "Not booted: run examples/godot/demo/setup.ps1, then check the output.", 16, INK)
		return
	_text(Vector2(32, 78), "%s · %s · environment %s" % [info.get("luaVersion", "?"), info.get("adapterVersion", "?"), info.get("environment", "?")], 13, INK)

	# Inventory grid.
	var origin := Vector2(32, 110)
	var slots := int(state.get("slots", 0))
	for i in range(slots):
		var slot := i + 1
		var p := origin + Vector2((i % COLS) * (SLOT + 8), (i / COLS) * (SLOT + 8))
		var r := Rect2(p, Vector2(SLOT, SLOT))
		var it := _item_in(slot)
		draw_rect(r, YELLOW if not it.is_empty() else CREAM.darkened(0.04))
		draw_rect(r, INK, false, 2.0)
		if slot == selected:
			draw_rect(r.grow(4), COBALT, false, 4.0)
		_text(p + Vector2(6, 16), str(slot), 11, INK)
		if not it.is_empty():
			_text(p + Vector2(6, 52), String(it.get("label", it.get("name", "?"))), 13, INK, SLOT - 10)
			_text(p + Vector2(6, SLOT - 10), "x%d" % int(it.get("count", 0)), 18, COBALT)

	# Weight bar.
	var rows := int(ceil(slots / float(COLS)))
	var bar := Rect2(origin + Vector2(0, rows * (SLOT + 8) + 8), Vector2(COLS * (SLOT + 8) - 8, 18))
	var max_w := float(state.get("maxWeight", 0))
	var w := float(state.get("weight", 0))
	draw_rect(bar, CREAM)
	if max_w > 0:
		draw_rect(Rect2(bar.position, Vector2(bar.size.x * clampf(w / max_w, 0, 1), bar.size.y)), COBALT)
	draw_rect(bar, INK, false, 2.0)
	_text(bar.position + Vector2(0, 40), "%.1f / %.1f kg" % [w, max_w], 15, INK)

	# Side panel: keys, roles, resources.
	var x := 664.0
	_text(Vector2(x, 128), "KEYS", 14, COBALT)
	var keys := ["G  console gives an item", "H  player types /giveitem", "P  grant / revoke admin", "U  use selected slot",
		"C  clear inventory", "I  /inventory", "Arrows  select a slot", "Esc  quit"]
	for k in range(keys.size()):
		_text(Vector2(x, 152 + k * 22), keys[k], 15, INK)
	_text(Vector2(x, 352), "PLAYER 1 ROLES", 14, COBALT)
	_text(Vector2(x, 376), ", ".join(PackedStringArray(roles)) if not roles.is_empty() else "(none)", 15, INK, 300)
	_text(Vector2(x, 412), "RESOURCES", 14, COBALT)
	var k2 := 0
	for name in states:
		_text(Vector2(x, 436 + k2 * 20), "%s  %s" % [name, states[name]], 14, INK)
		k2 += 1

	# Toasts under the inventory, newest at the bottom.
	for t in range(toasts.size()):
		var toast: Dictionary = toasts[t]
		var r := Rect2(Vector2(32, bar.position.y + 58 + t * 42), Vector2(bar.size.x, 36))
		var bg := COBALT
		var fg := CREAM
		if toast.type == "success":
			bg = YELLOW
			fg = INK
		elif toast.type == "error" or toast.type == "warn":
			bg = INK
			fg = YELLOW
		draw_rect(r, bg)
		draw_rect(r, INK, false, 2.0)
		var title := String(toast.title)
		_text(r.position + Vector2(12, 24), (title + ": " if title != "" else "") + String(toast.message), 15, fg, r.size.x - 24)
