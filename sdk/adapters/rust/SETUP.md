These steps are written from the Oxide and Carbon plugin documentation and checked by compiling the
plugin against both frameworks' assemblies. No Rust server run has passed yet, so treat them as
untested on a live server.

1. Build the plugin files, optionally with resources:

   ```bash
   node sdk/adapters/rust/build.mjs --with sdk/packages/sg_inventory --with sdk/packages/sg_eventbus
   ```

   `dist/rust/` mirrors the server's root folder. The build needs the .NET SDK.

2. Install Oxide or Carbon on the server, not both. Then copy from `dist/rust/` into the server root:

   | File | Where |
   |---|---|
   | `ScriptGo.Bridge.dll`, `KeraLua.dll` | `RustDedicated_Data/Managed/` |
   | `lua54.dll` (Windows) or `liblua54.so` (Linux) | `RustDedicated_Data/Plugins/x86_64/` |
   | `ScriptGo.cs` | `oxide/plugins/` for Oxide, `carbon/plugins/` for Carbon |

   The plugin loads the two DLLs through its `// Reference: ScriptGo.Bridge` line. After you replace
   either DLL, restart the server: reloading the plugin keeps the old ones loaded.

3. Put each resource in `oxide/data/ScriptGo/resources/<name>/` (Carbon: `carbon/data/...`). Every
   resource with `auto_start true` starts when the server is up, dependencies first.

4. Edit the plugin config, `oxide/config/ScriptGo.json` (Carbon: `carbon/configs/ScriptGo.json`).
   The plugin writes it on its first load.

   ```json
   {
     "resources": { "sg_inventory": { "slots": 30 } },
     "convars": { "scriptgo_api": "https://api.example.com" },
     "httpAllowedHosts": ["api.example.com"],
     "start": null
   }
   ```

5. Grant privileges with Oxide permissions. Every SCRIPT//GO privilege `p` becomes `scriptgo.p`:

   ```text
   oxide.grant user <steamid> scriptgo.command.giveitem      (Carbon: c.grant user ...)
   oxide.grant group admin scriptgo.admin                    (every privilege, and the scriptgo command)
   ```

Only the server side runs: Rust has no client-side plugins. Check what is running with
`scriptgo status` in the server console.
