The standalone host is the `scriptgo` CLI on plain Lua 5.4, 5.1 or LuaJIT. It needs Node.js 22 or
later and a Lua interpreter (`lua`/`luajit` on the `PATH`).

1. Install the package into `./resources`:

   ```bash
   scriptgo add scriptgo//inventory-kit
   ```

2. Run it. Without `--for` or `--script`, the host reads steps from the terminal
   (`cmd 1 /help`, `console <cmd>`, `wait <ms>`, `quit`):

   ```bash
   scriptgo run resources/sg_inventory --search resources --realtime
   ```

3. Privileges, per-resource values and convars come from a JSON file:

   ```json
   {
     "permissions": { "1": ["inventory.give"] },
     "resources": { "sg_inventory": { "slots": 12 } },
     "convars": { "scriptgo_api": "https://api.scriptgo.dev" }
   }
   ```

   ```bash
   scriptgo run resources/sg_inventory --search resources --config config.json
   ```

4. A licensed package: add a deployment on its licence page, then let the host check it. A guarded
   resource starts only on a valid answer, is checked again every ten minutes, and stops when the
   offline grace of its last valid answer ends (72 hours by default):

   ```json
   {
     "convars": { "scriptgo_api": "https://api.scriptgo.dev" },
     "licenses": { "inventory_pro": { "deploymentToken": "sg_dep_...", "package": "kestrel//inventory-pro" } }
   }
   ```

   This is a licence check, not code secrecy: the host runs plain Lua, so its operator can read
   what it loads. A protected (escrow) release arrives as an encrypted bundle; on this host
   `scriptgo escrow load --out <dir>` opens it on your bound server and writes the copy to disk,
   which is licence-only protection.

Storage goes to `.scriptgo-data/storage/` (`--data` to change it). HTTP and licensing use the
system `curl`.

## Player perks

Player perks (`ScriptGo.perks`, `docs/spec/perks.md`): the server asks SCRIPT//GO which of the operator's perks a player has. It needs the server linked to the operator's account (Dashboard, Perks, Servers) and the link's token, a secret, in the host's settings.

```json
{ "convars": { "scriptgo_api": "https://api.scriptgo.dev", "scriptgo_server_token": "sg_srv_..." } }
```

Players here are the simulated ones, so their identifiers are `local:<name>`: this host is for
tests and tooling (`node tools/perks-e2e.mjs`), not for real players. The cache is the file
`storage/scriptgo.perks.json` of the data folder. `scriptgo_perks_poll_seconds` (30) sets how
often the event queue is pulled.

## Player match

Player match (`ScriptGo.presence` and the `/link` command, `docs/spec/player-match.md`) ties a buyer on a shop to their player, without an account. It needs the server link of perks (`scriptgo_server_token`). Two parts:

- **`/link <code>`** (name: `scriptgo_link_command`, default `link`; `off` removes it): the player types the code the sign-in page shows, and the server confirms it to SCRIPT//GO. It is registered as soon as the server is linked.
- **Presence** (opt-in: `scriptgo_presence` `true`, default off): while a player is connected, the server tells SCRIPT//GO "this player is here" as `HMAC-SHA256(day's key, address)`, refreshed every 30 seconds and removed when they leave. The address never leaves the server and is never logged. Addresses are personal data: an operator who turns presence on says so in their own notice to players.

Players are simulated, and so are their addresses: `join 2 Bob @203.0.113.7` in a run script, or
`playerAddress` in the config for player 1 (use documentation addresses, 203.0.113.0/24 and
2001:db8::/32). The HMAC comes from the `openssl` executable (config `openssl`, else the environment
variable `SCRIPTGO_OPENSSL`, else the PATH); without it, `ScriptGo.presence.status()` says
`presence unavailable: no HMAC on this host` and only `/link` works, unless address mode is on
(`scriptgo_presence_addr` `true`, default off): then the normalised address is sent and SCRIPT//GO
fingerprints it at once. The day's key is passed to `openssl` on its command line, where other users
of the machine can see it while it runs. Run on this machine (2026-11-11) with
`sdk/conformance/sg_probe_presence` and `scriptgo verify --stub-api` on Lua 5.4, 5.1 and LuaJIT: the
fingerprints OpenSSL produced are the ones Node's HMAC-SHA256 produces. Also run against the
platform's player match end-to-end test (a real API, site and Chrome, 2026-11-11): with OpenSSL, and
again with OpenSSL withheld and address mode on, the page offered the connected player and `/link`
typed with a space linked the code. For tests and tooling, not real players.

