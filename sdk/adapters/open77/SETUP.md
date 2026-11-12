The CLI packs a resource with a small shim that maps `ScriptGo.*` onto `Open77.*`:

```bash
scriptgo pack my_resource --target open77 --out dist
# dist/open77/my_resource/ is a resource folder OPEN//77 loads as is
```

The packed manifest asks for exactly the OPEN//77 permissions the resource's capabilities need.
A resource that uses `http` or `licensing` also needs the operator to allow the API host in
`server.jsonc`:

```jsonc
"http": { "enabled": true, "allowedHosts": ["api.scriptgo.dev"] },
"convars": { "scriptgo_api": "https://api.scriptgo.dev" }
```

`scriptgo_api` defaults to `https://api.scriptgo.dev`: set it only to use another SCRIPT//GO API (a
local one in development), and allow that host instead.

The license key goes in the `<resource>:license_key` convar, never in the resource folder.

## Protected (escrowed) scripts

Code escrow is an opt-in, default-off feature of the OPEN//77 server. The server decrypts a
protected release through a native library: the key stays in native memory and the plain code never
reaches the disk. Only server scripts are encrypted; shared and client scripts go to game clients,
so they stay readable. A release published with `--client-escrow` is the exception for client
scripts: they reach players as encrypted, stripped bytecode, compiled into the game only for a session
the server admits (client code escrow, same server switch and token). A player can still decompile
what their game runs.

1. Install the release still encrypted:

   ```bash
   scriptgo escrow install <name>-<version>.escrow.zip --target open77 --out <resources folder> --trusted-signer <key>
   ```

2. Put the deployment token of that licence in `.open77/escrow-tokens/<resource>.token`, one line,
   never in `server.jsonc` or in the resource folder.
3. Turn `resourceEscrow` on in `server.jsonc` and put the escrow adapter next to the server, built
   with `ScriptGo.Escrow` from this SDK's releases. Without the adapter, the server refuses an
   escrowed resource with `adapter_missing`.

The full procedure is in `sdk/adapters/open77/escrow/README.md`. The operator of the machine can
still inspect their own process; that takes real effort, and the copy is traceable.

## Player perks

Player perks (`ScriptGo.perks`, `docs/spec/perks.md`): the server asks SCRIPT//GO which of the operator's perks a player has. It needs the server linked to the operator's account (Dashboard, Perks, Servers) and the link's token, a secret, in the host's settings.

```jsonc
"http": { "enabled": true, "allowedHosts": ["api.scriptgo.dev"] },
"convars": { "scriptgo_api": "https://api.scriptgo.dev", "scriptgo_server_token": "sg_srv_..." }
```

Nothing about payments is in OPEN//77: `scriptgo pack` puts the portable perks module into the
resource's server shim, and that Lua calls SCRIPT//GO over the HTTP the operator allowed. A player is
`Open77.players.identifier(id)`, the account the OPEN//77 master verified; a masterless
`devLocalAuth` server gives its players no identifier, so they have no perk there. The cache is the
key `scriptgo.perks` of the resource's kvp. Each resource that uses perks pulls the event queue on
its own.

The server opens no port and receives nothing pushed: it pulls the queue every 30 seconds
(`scriptgo_perks_poll_seconds`) over the outgoing HTTPS allowed above, so a reward can arrive up to
that long after the payment. `onPlayerConnected` gives the player id as a string: pass
`tonumber(id)` to `ScriptGo.perks`, which reads a string as an identifier. To pull once for all
your resources, let one resource relay `granted` and `removed` with `TriggerEvent`: the example is
in `docs/spec/perks.md`, section "Several resources on one server".

## Player match

Player match (`ScriptGo.presence` and the `/link` command, `docs/spec/player-match.md`) ties a buyer on a shop to their player, without an account. It needs the server link of perks (`scriptgo_server_token`). Two parts:

- **`/link <code>`** (name: `scriptgo_link_command`, default `link`; `off` removes it): the player types the code the sign-in page shows, and the server confirms it to SCRIPT//GO. It is registered as soon as the server is linked.
- **Presence** (opt-in: `scriptgo_presence` `true`, default off): while a player is connected, the server tells SCRIPT//GO "this player is here" as `HMAC-SHA256(day's key, address)`, refreshed every 30 seconds and removed when they leave. The address never leaves the server and is never logged. Addresses are personal data: an operator who turns presence on says so in their own notice to players.

`scriptgo pack` adds the presence module to the server shim of a resource that declares the
`presence` capability, and only then asks for `players.identity.sensitive` (to read
`Open77.players.endpoint`). Declare it in **one resource per server**: each declaring resource
reports and registers `/link`. The answer to `/link` arrives in the player's chat.

**What works today:** `/link` (every word after the command is the code: `/link mt4 2jf` works).
Presence with fingerprints needs HMAC-SHA256, and OPEN//77 (build 2.50.0+op77.208) has no native for
it; the SDK does not hash in Lua by itself. So `ScriptGo.presence.status()` answers `presence
unavailable: no HMAC on this host`, and buyers use the code, unless the operator turns **address
mode** on:

```
set scriptgo_presence_addr true
```

In address mode (default off; whether it is offered is the owner's decision, still pending) the
shim sends the player's normalised address (IPv4, or the IPv6 `/64`), and SCRIPT//GO fingerprints it
at once and keeps only the fingerprint. The shim never logs it; it logs once that address mode is on.
Every request also says `environment: "open77"` and the shim's version.

Run on an OPEN//77 server (2026-11-11, `sg_probe_presence`, `scriptgo verify --env open77
--stub-api`): the resource packs, the server accepts the permission, the shim starts and reports
the missing HMAC. No game client was connected, so neither `/link` nor address mode has run with a
real player; address mode and `/link` with a space are unit-tested against stub natives
(`sdk/lua/spec/open77_shim_perks_spec.lua`).

