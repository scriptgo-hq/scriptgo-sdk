The .NET kit is a library (`ScriptGo.Host`, .NET 10) that a C# engine or server embeds, plus a
console host (`scriptgo-dotnet`) that runs and verifies resources without an engine. It runs Lua
resources (Lua 5.4 through KeraLua) and TypeScript or JavaScript resources (Jint). It is
experimental and has been measured on Windows x64 only.

1. Install the .NET 10 SDK. The `scriptgo` CLI finds it on the `PATH`, in `DOTNET_ROOT`, in the
   default install folder, or through `--dotnet <path>` / `SCRIPTGO_DOTNET`.

2. Verify a resource on the kit. The first run builds the console host; TypeScript entries are
   compiled with esbuild into a temporary copy (the source folder is not changed):

   ```bash
   scriptgo verify resources/sg_inventory --env dotnet
   scriptgo verify resources/my_ts_resource --env dotnet --lang ts
   ```

3. Run resources with the console host. It loads compiled TypeScript (`x.ts.js` next to `x.ts`),
   which a `scriptgo pack` archive contains:

   ```bash
   dotnet sdk/dotnet/ScriptGo.Host.Standalone/bin/Release/net10.0/scriptgo-dotnet.dll run resources/sg_inventory --search resources --for 2000
   ```

4. Privileges, per-resource values and convars come from a JSON file (`--config`), as in the
   standalone host; `--data <dir>` keeps storage in JSON files instead of memory:

   ```json
   {
     "permissions": { "1": ["inventory.give"] },
     "resources": { "sg_inventory": { "slots": 12 } },
     "convars": { "scriptgo_api": "https://api.example" }
   }
   ```

To embed the kit in an engine, see `sdk/dotnet/README.md`.

## Player perks

Player perks (`ScriptGo.perks`, `docs/spec/perks.md`): the server asks SCRIPT//GO which of the operator's perks a player has. It needs the server linked to the operator's account (Dashboard, Perks, Servers) and the link's token, a secret, in the host's settings.

```json
{ "convars": { "scriptgo_api": "https://api.example", "scriptgo_server_token": "sg_srv_..." } }
```

Lua guests have `ScriptGo.perks`: the kit runs the portable perks module in the guest, over
`IHostHttp` and `IHostPlayers.Identifier` (the engine's own account id). JavaScript and TypeScript
guests do not have it yet: `capability_unavailable:perks@dotnet`. The cache is kept in memory.
