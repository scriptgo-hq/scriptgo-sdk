---
title: OPEN//77
description: How SCRIPT//GO scripts run on OPEN//77: setup, capabilities, protection, limits and the real runs behind its status.
---

Scripts on OPEN//77 servers, packed as regular OPEN//77 resources.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [OPEN//77 page](/environments/open77) on the site is the short version.

| | |
|---|---|
| Status | Beta: usable, tested on a real runtime, conformance partial |
| Runs on | Server and client |
| Languages | Lua 5.4 |
| Protection | Code escrow, an opt-in server feature |
| Runtime | OPEN//77's own Lua 5.4 runtime, on its dedicated server and game client |

## How it runs

OPEN//77 runs its own Lua runtime with the same resource shape. `scriptgo pack --target open77` adapts a package to it: a generated `open77.lua` manifest, the package's files, and a three-file shim (shared, server, client), loaded first, that maps `ScriptGo.*` onto OPEN//77's `Open77.*` API. The packed manifest asks only for the permissions the package's capabilities need.

The adapter's code and README: [`sdk/adapters/open77`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/open77).

## Set up

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

### Protected (escrowed) scripts

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

### Player perks

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

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Supported |  |
| `logging` | Supported |  |
| `storage` | Supported | Open77.kvp on both sides, values stored as JSON text. |
| `players` | Supported | Server side: GetPlayers, GetPlayerName, Open77.players.identifier. |
| `permissions` | Supported | Server side: the server ACL (Open77.acl.isAllowed, permission acl.read). |
| `commands` | Supported |  |
| `config` | Supported | Server side: convar &lt;resource&gt;:&lt;key&gt;, then the resource's tunables. |
| `ui` | Supported | Server: Open77.notifications; client: the open77_notifications package. |
| `http` | Partial | Server side, through Open77.http.request (permission http.request). Off until the operator sets server.jsonc http.enabled and lists each host in http.allowedHosts; redirects are never followed. |
| `licensing` | Partial | Server side, over Open77.http.request to the scriptgo_api convar; the operator allows the API host. |
| `perks` | Partial | Server side, in the shim: the core's perks module over Open77.http.request (the operator allows the API host) and Open77.players.identifier. The shim is packed per resource, so each resource that uses perks polls on its own; the cache is kept in the resource's kvp. |

## Protection

Code escrow, an opt-in server feature: a protected release is decrypted in memory, with a key released to the licensed server only. The operator of the machine can still inspect their own process; that takes real effort and the copy is traceable.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## The platform's own rules

A script is your own code. CD PROJEKT RED's own rules cover the game's content.

This is the platform's rule, shown as information: whoever runs a script there answers for following it. It does not change what can be sold on SCRIPT//GO. See [the rules](/docs/selling#the-rules).

## Limits

- Outbound HTTP, and so licensing and perks, needs the server operator to allow the SCRIPT//GO API host; the client side has no HTTP.
- The client side has no wall clock: ScriptGo.time.now() is nil there.
- Real runs cover the server side; the client side has not been run in a verification yet.

## Real runs

Each row is a `scriptgo verify` run on OPEN//77 itself, not on a mock or an emulator: the package started there and its own tests reported back. Rows marked *probe* are SCRIPT//GO's conformance probes, which exercise the runtime and are never published as packages. See [how a status is earned](/docs/environments#how-a-status-is-earned).

| Script | Version | Ran on | Adapter | Checks passed | Date |
|---|---|---|---|---|---|
| `inventory_pro` | 1.4.3 | OPEN//77 server 1.0.0+5282e21c · Lua 5.4 | open77-shim-0.3.0 | 13/13 | 2026-11-09 |
| `sg_eventbus` | 1.0.2 | OPEN//77 server 1.0.0+5282e21c · Lua 5.4 | open77-shim-0.3.0 | 8/8 | 2026-11-09 |
| `sg_inventory` | 1.0.2 | OPEN//77 server 1.0.0+5282e21c · Lua 5.4 | open77-shim-0.3.0 | 8/8 | 2026-11-09 |
| `sg_permissions` | 1.0.2 | OPEN//77 server 1.0.0+5282e21c · Lua 5.4 | open77-shim-0.3.0 | 8/8 | 2026-11-09 |
| `sg_probe` *probe* | 0.1.0 | OPEN//77 server 1.0.0+5282e21c · Lua 5.4 | open77-shim-0.3.0 | 37/37 | 2026-11-09 |
| `sg_probe_net` *probe* | 0.1.0 | OPEN//77 server 1.0.0+5282e21c · Lua 5.4 | open77-shim-0.3.0 | 19/19 | 2026-11-09 |
