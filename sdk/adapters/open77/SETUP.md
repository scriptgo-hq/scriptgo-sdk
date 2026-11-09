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
