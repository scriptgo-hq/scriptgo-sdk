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
     "convars": { "scriptgo_api": "https://api.scriptgo.dev" }
   }
   ```

To embed the kit in an engine, see `sdk/dotnet/README.md`.

## Player perks

Player perks (`ScriptGo.perks`, `docs/spec/perks.md`): the server asks SCRIPT//GO which of the operator's perks a player has. It needs the server linked to the operator's account (Dashboard, Perks, Servers) and the link's token, a secret, in the host's settings.

```json
{ "convars": { "scriptgo_api": "https://api.scriptgo.dev", "scriptgo_server_token": "sg_srv_..." } }
```

Lua guests have `ScriptGo.perks`: the kit runs the portable perks module in the guest, over
`IHostHttp` and `IHostPlayers.Identifier` (the engine's own account id). JavaScript and TypeScript
guests do not have it yet: `capability_unavailable:perks@dotnet`. The cache is kept in memory.

## Player match

Player match (`ScriptGo.presence` and the `/link` command, `docs/spec/player-match.md`) ties a buyer on a shop to their player, without an account. It needs the server link of perks (`scriptgo_server_token`). Two parts:

- **`/link <code>`** (name: `scriptgo_link_command`, default `link`; `off` removes it): the player types the code the sign-in page shows, and the server confirms it to SCRIPT//GO. It is registered as soon as the server is linked.
- **Presence** (opt-in: `scriptgo_presence` `true`, default off): while a player is connected, the server tells SCRIPT//GO "this player is here" as `HMAC-SHA256(day's key, address)`, refreshed every 30 seconds and removed when they leave. The address never leaves the server and is never logged. Addresses are personal data: an operator who turns presence on says so in their own notice to players.

Lua guests run the portable presence module, in the one resource that declares the `presence`
capability (declare it in one resource per host: each declaring resource reports, and registers
`/link`). The integrator gives addresses by implementing `IHostPlayerAddresses` on its
`IHostPlayers` object (`string? Address(int id)`, "ip" or "ip:port"), or with
`host.PlayerJoin(id, name, address)`. The HMAC is .NET's `HMACSHA256`. JavaScript and TypeScript
guests do not have it: `capability_unavailable:presence@dotnet`. Proven in the kit's tests with a
fake API (`PresenceTests`), and with `scriptgo verify sdk/conformance/sg_probe_presence --env dotnet
--stub-api` (2026-11-11): verified, the fingerprint equal to Node's HMAC-SHA256 of the verifier's
simulated address. No engine embedding the kit has run it with real players.

