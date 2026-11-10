The CLI packs a resource with a small shim that maps `ScriptGo.*` onto `Open77.*`:

```bash
scriptgo pack my_resource --target open77 --out dist
# dist/open77/my_resource/ is a resource folder OPEN//77 loads as is
```

The packed manifest asks for exactly the OPEN//77 permissions the resource's capabilities need.
A resource that uses `http` or `licensing` also needs the operator to allow the API host in
`server.jsonc`:

```jsonc
"http": { "enabled": true, "allowedHosts": ["api.scriptgo.example"] },
"convars": { "scriptgo_api": "https://api.scriptgo.example" }
```

The license key goes in the `<resource>:license_key` convar, never in the resource folder.

## Player perks

Player perks (`ScriptGo.perks`, `docs/spec/perks.md`): the server asks SCRIPT//GO which of the operator's perks a player has. It needs the server linked to the operator's account (Dashboard, Perks, Servers) and the link's token, a secret, in the host's settings.

```jsonc
"http": { "enabled": true, "allowedHosts": ["api.scriptgo.example"] },
"convars": { "scriptgo_api": "https://api.scriptgo.example", "scriptgo_server_token": "sg_srv_..." }
```

Nothing about payments is in OPEN//77: `scriptgo pack` puts the portable perks module into the
resource's server shim, and that Lua calls SCRIPT//GO over the HTTP the operator allowed. A player is
`Open77.players.identifier(id)`, the account the OPEN//77 master verified; a masterless
`devLocalAuth` server gives its players no identifier, so they have no perk there. The cache is the
key `scriptgo.perks` of the resource's kvp. Each resource that uses perks pulls the event queue on
its own.
