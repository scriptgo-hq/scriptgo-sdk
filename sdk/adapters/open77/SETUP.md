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
so they stay readable.

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
