Measured with Godot 4.5.2 and lua-gdextension 0.7.0 (0.8.x needs Godot 4.6).

1. Copy `addons/lua-gdextension` from the lua-gdextension release into the project.
2. Copy `scriptgo_host.gd` and `scriptgo_watchdog.gd` from `sdk/adapters/godot/` to
   `res://addons/scriptgo/` and register them as autoloads, watchdog first:

   ```ini
   [autoload]
   ScriptGoWatchdog="*res://addons/scriptgo/scriptgo_watchdog.gd"
   ScriptGoHost="*res://addons/scriptgo/scriptgo_host.gd"
   ```

3. Import once (`Godot --headless --import --path <project>`, or open the editor) so the
   extension is registered.
4. Point the host at the SDK (`sdk_root`, `--scriptgo-sdk <dir>`, or a copy under
   `res://addons/scriptgo/sdk/`), then boot it:

   ```gdscript
   func _ready():
       ScriptGoHost.boot({ "config": { "permissions": { "1": ["inventory.*"] } } })
       ScriptGoHost.add_search_path(ScriptGoHost.sdk_path + "packages")
       ScriptGoHost.add_resource(ScriptGoHost.sdk_path + "packages/sg_inventory")
       ScriptGoHost.start_all()
       ScriptGoHost.join(1, "Player")
   ```

The host ticks from `_process`. There is no HTTP yet, so licensed packages do not run on Godot.
