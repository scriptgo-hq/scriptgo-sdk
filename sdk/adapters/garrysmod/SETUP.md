1. Build the runtime addon, optionally with resources bundled in:

   ```bash
   node sdk/adapters/garrysmod/build.mjs --with sdk/packages/sg_inventory --with sdk/packages/sg_eventbus
   ```

   or pack each resource as its own addon (the runtime addon comes with it, `--no-runtime` leaves
   it out):

   ```bash
   scriptgo pack sdk/packages/sg_inventory --target garrysmod   # -> dist/garrysmod/scriptgo_sg_inventory/ + dist/garrysmod/scriptgo/
   ```

2. Copy the folders into the server's `garrysmod/addons/` and restart the map. Every resource with
   `auto_start true` starts once the map has loaded, dependencies first. Server owners can also put
   resources in `garrysmod/data/scriptgo/resources/<name>/`.
3. Optional `garrysmod/data/scriptgo/config.json`:

   ```json
   {
     "resources": { "sg_inventory": { "slots": 30 } },
     "permissions": { "admin": ["command.giveitem"], "76561198000000000": ["shop.*"] }
   }
   ```

   Permissions also come from superadmin and, with an admin mod such as ULX or SAM, from the CAMI
   privileges `scriptgo.<name>`.
4. Licensed packages call the SCRIPT//GO API at `https://api.scriptgo.dev`. To use another one (a
   local API in development), set `scriptgo_api` in `server.cfg`
   (`scriptgo_api "http://localhost:4100"`). An API on a loopback or private address also needs
   `-allowlocalhttp` on the srcds command line.

Only the server side runs: client scripts are not executed yet. Keep `sv_hibernate_think 1` if
resources must keep running while the server is empty. Resource commands are typed in chat as
`/name` or `!name`; the server console has `scriptgo`, `scriptgo restart <name>` and
`scriptgo run <command line>`.

To check a resource on your own server folder (a copy, not a live server):

```bash
scriptgo verify <resourceDir> --env garrysmod --gmod-server <folder with srcds.exe>
```

The server itself is the free Garry's Mod Dedicated Server (Steam app 4020), installed with
SteamCMD and an anonymous login: `steamcmd +force_install_dir <dir> +login anonymous +app_update 4020 validate +quit`.
On Windows it takes about 7 GB.
