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

**Player match, in one resource.** In a resource that declares the `presence` capability,
`scriptgo pack --target fivem` keeps the shim's player match section, with the core's presence
module included word for word; elsewhere `ScriptGo.presence` raises
`capability_unavailable:presence@fivem`. Declare it in one resource per server. With
`scriptgo_server_token` set, `/link <code>` (convar `scriptgo_link_command`, default `link`) confirms
the code a player types, for their `license:` identifier, and answers with a notification. FiveM's
Lua has no HMAC, so presence (`scriptgo_presence`) reports only in address mode
(`set scriptgo_presence_addr true`, default off; the owner's decision on it is pending): the
normalised address from `GetPlayerEndpoint` is sent, and SCRIPT//GO fingerprints it at once. It is
never logged. Unit-tested against stub natives (`sdk/lua/spec/fivem_shim_spec.lua`); not run on an
FXServer with a connected player.

**The platform's own rules.** Rockstar's Creator Platform License Agreement (2026-09-10, §3.1(6))
forbids a third-party marketplace that sells or licenses server content for FiveM. SCRIPT//GO does
not enforce a platform's rules: you answer to the platform's rights holder for what you run on
your server.

FiveM's `require` finds no resource module, and the client has no `os`, so `pack` refuses code
that uses either. To pack it anyway, with warnings, pass `--allow-unportable`.

**RedM.** `scriptgo pack my_resource --target redm` writes the same resource with `game "rdr3"`,
the `rdr3_warning` line RedM requires, and the shim reporting `redm`. RedM's own files are
`environment_asset "redm"` (GTA V files do not load in RDR2). Player match is not available on RedM
yet. Nothing of it has run on a RedM server.

**Cfx.re's asset escrow.** `scriptgo pack my_resource --target fivem --cfx-escrow` (or `redm`)
writes `dist/fivem-cfx-escrow/my_resource/` and its zip, to upload at portal.cfx.re with your own
Cfx.re account. It adds `lua54 "yes"` and `escrow_ignore` (the files `cfx_escrow_ignore` names in
`scriptgo.lua`, and the shim). Cfx.re encrypts Lua and `.ydr`/`.ydd`/`.yft` models, not
SCRIPT//GO; the pack lists what stays readable.

To check a package on a real server (server half only):

```bash
SCRIPTGO_FIVEM_LICENSE_KEY=<your key> scriptgo verify my_resource --env fivem --fivem-server <path>/FXServer.exe
```

FXServer needs a registration key from the Cfx.re portal (`sv_licenseKey`). The run binds
`127.0.0.1:30121` only (`--fivem-port` changes the port) and stays off the public server list.
