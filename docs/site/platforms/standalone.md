---
title: Lua Standalone
description: How SCRIPT//GO scripts run on Lua Standalone: setup, capabilities, protection, limits and the real runs behind its status.
---

Runs scripts on plain Lua, with no engine: the place to test them.

This page is generated from the SDK's platform registry (`sdk/environments.json`) and the adapter's `SETUP.md`. The [Lua Standalone page](/environments/standalone) on the site is the short version.

| | |
|---|---|
| Status | Available: stable, every conformance check passing |
| Runs on | Server and client |
| Languages | Lua 5.1, Lua 5.4, LuaJIT |
| Protection | Licence check and signed releases |
| Runtime | PUC Lua 5.4 and 5.1, or LuaJIT 2.1, from the PATH |

## How it runs

The `scriptgo` CLI runs resources on a plain Lua interpreter, with no engine. `scriptgo run` ticks the host in simulated or real time and `scriptgo test` runs test scripts; it is the reference host the other environments are compared with.

The adapter's code and README: [`sdk/adapters/standalone`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/sdk/adapters/standalone).

## Set up

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

### Player perks

Player perks (`ScriptGo.perks`, `docs/spec/perks.md`): the server asks SCRIPT//GO which of the operator's perks a player has. It needs the server linked to the operator's account (Dashboard, Perks, Servers) and the link's token, a secret, in the host's settings.

```json
{ "convars": { "scriptgo_api": "https://api.scriptgo.dev", "scriptgo_server_token": "sg_srv_..." } }
```

Players here are the simulated ones, so their identifiers are `local:<name>`: this host is for
tests and tooling (`node tools/perks-e2e.mjs`), not for real players. The cache is the file
`storage/scriptgo.perks.json` of the data folder. `scriptgo_perks_poll_seconds` (30) sets how
often the event queue is pulled.

## Capabilities

What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.

| Capability | Support | Note |
|---|---|---|
| `events` | Supported |  |
| `logging` | Supported |  |
| `storage` | Supported |  |
| `players` | Partial | Simulated local players (one by default). |
| `permissions` | Supported |  |
| `commands` | Supported |  |
| `config` | Supported |  |
| `ui` | Fallback | Notifications are printed to the console. |
| `http` | Partial | Uses the system curl executable when present. |
| `licensing` | Supported |  |
| `perks` | Partial | Implemented in the core, over curl. The players are the simulated local ones, so the identifier is local:&lt;name&gt;: for tests and tooling, not for real players. |

## Protection

Licence check and signed releases. The host runs plain script, so its operator can read what it loads: no code-secrecy claim.

See [Protect your work](/docs/protect-your-work) for what protection does and does not do.

## Limits

- No rendering: `ui` falls back to console output.
- HTTP needs curl on the PATH.

## Real runs

Each row is a `scriptgo verify` run on Lua Standalone itself, not on a mock or an emulator: the package started there and its own tests reported back. Rows marked *probe* are SCRIPT//GO's conformance probes, which exercise the runtime and are never published as packages. See [how a status is earned](/docs/environments#how-a-status-is-earned).

| Script | Version | Ran on | Adapter | Checks passed | Date |
|---|---|---|---|---|---|
| `inventory_pro` | 1.4.3 | Lua 5.1 | 0.1.0 | 10/10 | 2026-11-09 |
| `inventory_pro` | 1.4.3 | Lua 5.4 | 0.1.0 | 10/10 | 2026-11-09 |
| `inventory_pro` | 1.4.3 | LuaJIT 2.1.1794164915 | 0.1.0 | 10/10 | 2026-11-09 |
| `sg_eventbus` | 1.0.2 | Lua 5.1 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_eventbus` | 1.0.2 | Lua 5.4 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_eventbus` | 1.0.2 | LuaJIT 2.1.1794164915 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_inventory` | 1.0.2 | Lua 5.1 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_inventory` | 1.0.2 | Lua 5.4 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_inventory` | 1.0.2 | LuaJIT 2.1.1794164915 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_permissions` | 1.0.2 | Lua 5.1 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_permissions` | 1.0.2 | Lua 5.4 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_permissions` | 1.0.2 | LuaJIT 2.1.1794164915 | 0.1.0 | 7/7 | 2026-11-09 |
| `sg_probe` *probe* | 0.1.0 | Lua 5.1 | 0.1.0 | 31/31 | 2026-11-09 |
| `sg_probe` *probe* | 0.1.0 | Lua 5.4 | 0.1.0 | 31/31 | 2026-11-09 |
| `sg_probe` *probe* | 0.1.0 | LuaJIT 2.1.1794164915 | 0.1.0 | 31/31 | 2026-11-09 |
| `sg_probe_net` *probe* | 0.1.0 | Lua 5.1 | 0.1.0 | 18/18 | 2026-11-09 |
| `sg_probe_net` *probe* | 0.1.0 | Lua 5.4 | 0.1.0 | 18/18 | 2026-11-09 |
| `sg_probe_net` *probe* | 0.1.0 | LuaJIT 2.1.1794164915 | 0.1.0 | 18/18 | 2026-11-09 |
