FiveM already runs this resource shape (`CreateThread`, `Wait`, events, exports,
`RegisterCommand`). The CLI packs a resource with one shim file that maps `ScriptGo.*` onto FiveM:

```bash
scriptgo pack my_resource --target fivem --out dist
# dist/fivem/my_resource/ is a resource folder FXServer loads as is
```

1. Copy `dist/fivem/my_resource/` into your server's `resources/` folder, with its dependencies
   packed the same way, and start them in `server.cfg`, dependencies first:

   ```cfg
   ensure sg_inventory
   ensure my_resource
   ```

2. Configuration is a convar named `<resource>:<key>`, read by `ScriptGo.config.get`:

   ```cfg
   set my_resource:max_weight 40
   ```

3. Privileges are ACE permissions, read by `ScriptGo.permissions.has`:

   ```cfg
   add_ace group.admin inventory.give allow
   ```

4. `ScriptGo.ui.notify` sends a chat message through FXServer's `chat` resource.

**No licence check.** The shim has none: `ScriptGo.licensing` raises
`capability_unavailable:licensing@fivem`, and `pack` refuses a package that needs one
(`licensed true`, or the `licensing` capability), because the shim could not enforce it. This is
a technical limit of the adapter, not a selling rule.

**No player match.** `ScriptGo.presence` raises `capability_unavailable:presence@fivem`: the shim
does not carry the core's perks or presence modules, and FiveM's Lua has no HMAC. The shim can read
a player's address (`GetPlayerEndpoint`) for when it does; nothing about it has run.

**The platform's own rules.** Rockstar's Creator Platform License Agreement (2026-09-10, §3.1(6))
forbids a third-party marketplace that sells or licenses server content for FiveM. SCRIPT//GO does
not enforce a platform's rules: you answer to the platform's rights holder for what you run on
your server.

FiveM's `require` finds no resource module, and the client has no `os`, so `pack` refuses code
that uses either. To pack it anyway, with warnings, pass `--allow-unportable`.

RedM runs the same shim with `game "rdr3"`. It is not built or verified yet.

To check a package on a real server (server half only):

```bash
SCRIPTGO_FIVEM_LICENSE_KEY=<your key> scriptgo verify my_resource --env fivem --fivem-server <path>/FXServer.exe
```

FXServer needs a registration key from the Cfx.re portal (`sv_licenseKey`). The run binds
`127.0.0.1:30121` only (`--fivem-port` changes the port) and stays off the public server list.
