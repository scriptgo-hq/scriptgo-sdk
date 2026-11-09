1. Build the mod, optionally with resources bundled in:

   ```bash
   node sdk/adapters/luanti/build.mjs --with sdk/packages/sg_inventory --with sdk/packages/sg_eventbus
   ```

2. Copy `dist/luanti/scriptgo/` into the server's `mods/` folder and enable it for the world
   (`load_mod_scriptgo = true` in `world.mt`). It is a regular mod: it needs no entry in
   `secure.trusted_mods`.
3. Put further resources in `<world>/scriptgo/resources/<name>/`. Every resource with
   `auto_start true` starts with the server, dependencies first.
4. Optional `<world>/scriptgo.json`:

   ```json
   {
     "resources": { "sg_inventory": { "slots": 30 } },
     "convars": { "scriptgo_api": "https://api.example.com" },
     "permissions": { "alice": ["command.giveitem"] }
   }
   ```

Only the server side runs. HTTP, and so online license checks, needs the mod listed in
`secure.http_mods` by the server owner.
