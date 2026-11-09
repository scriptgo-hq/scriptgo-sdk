SCRIPT//GO runs on a BeamMP server as one server plugin, `scriptgo`. Players install nothing: only
the server half of a package runs (BeamNG.drive client mods are not a SCRIPT//GO target yet).

1. Pack the package and its dependencies into the plugin:

   ```bash
   scriptgo pack my_resource --target beammp --out dist
   # dist/beammp/Resources/Server/scriptgo/ = main.lua, lib/, core/, resources/my_resource/ ...
   ```

   Packing more packages into the same `--out` adds them to the same plugin.

2. Copy `dist/beammp/Resources` over the server's folder, so the plugin lands in
   `Resources/Server/scriptgo/`. BeamMP runs `main.lua` when the server starts; every package with
   `auto_start true` starts with it, dependencies first.

3. Optional `Resources/Server/scriptgo/scriptgo.json`:

   ```json
   {
     "resources": { "my_resource": { "slots": 30 } },
     "convars": { "scriptgo_api": "https://api.scriptgo.example" },
     "permissions": { "beammp:123456": ["*"], "Ada": ["command.giveitem"] },
     "httpAllowedHosts": ["api.scriptgo.example"]
   }
   ```

   BeamMP has no server roles, so permissions are granted here, by `beammp:<account id>` or by the
   name of a player logged in to BeamMP. `"start": [...]` replaces auto-start with a list.

Commands work in chat (`/giveitem ...`) and in the server console, where `scriptgo` lists the
packages and `scriptgo restart <name>` restarts one. `ScriptGo.http` and online license checks
need `curl` on the server's PATH; `"http": false` turns them off. A license key goes in the
package's config in `scriptgo.json`, never in the package folder.

The server itself needs the AuthKey every BeamMP server needs, from https://keymaster.beammp.com.
