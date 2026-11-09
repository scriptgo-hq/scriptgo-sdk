# PermissionsKit

Roles and privileges for any host. Roles inherit from each other, privileges take wildcards and
denials, and grants are stored per player identifier, so they survive reconnects and restarts.

- **Privileges** are dotted names: `inventory.give`, `chat.mute`.
- **Patterns**: an exact name, a trailing wildcard (`inventory.*` covers `inventory.give` and
  `inventory.admin.reset`), `*` for everything, and `-` in front to deny. A denial wins over an
  allow of the same or lower specificity.
- **Roles** with inheritance, from the config or defined at runtime; cycles are refused.
- **Host operators** (Luanti privileges, the OPEN//77 ACL, the standalone config) hold every
  privilege through `scriptgo.admin`, where the host offers the `permissions` capability.

## Install

```bash
scriptgo add scriptgo//permissions-kit
```

```lua
-- scriptgo.lua of your resource
dependency "sg_permissions >=1.0.0"
```

## Example

A mechanic role, granted to each player who joins. This block is the README example that
`scriptgo verify` runs next to the package in every environment; hosts with a (simulated) player
show the whole exchange, hosts without one show only the role definition.

```lua runnable
local perms = exports.sg_permissions

-- Roles usually come from the config ("roles"); this one is added at runtime. Exports are called
-- from a thread or a handler, never at file scope (resource_preparing).
CreateThread(function()
    print(perms:defineRole("mechanic", { inherits = { "user" }, privileges = { "vehicles.repair", "vehicles.tow" } }))
end)

local function report(playerId)
    print(("player %d: repair=%s tow=%s kick=%s"):format(playerId,
        tostring(perms:has(playerId, "vehicles.repair")),
        tostring(perms:has(playerId, "vehicles.tow")),
        tostring(perms:has(playerId, "players.kick"))))
end

AddEventHandler("playerJoining", function()
    local playerId = source
    report(playerId)
    print(perms:grant(playerId, "mechanic")) -- true
    report(playerId)
end)
```

## Server API

Call these through `exports.sg_permissions:<name>(...)`.

| Export | Returns |
|---|---|
| `has(playerId, privilege)` | `true` or `false` |
| `grant(playerId, role)` | `true`, or `false, reason` (`unknown_role`, `unknown_player`) |
| `revoke(playerId, role)` | `true`, or `false, reason` (`unknown_player`, `not_granted`) |
| `roles(playerId)` | the player's roles, inherited ones included |
| `privileges(playerId)` | the player's effective patterns |
| `listRoles()` | `{ { name, inherits, privileges } }`, sorted by name |
| `defineRole(name, { inherits, privileges })` | `true`, or `false, reason`; adds or replaces a role until the next restart |

Player `0` (the console) holds every privilege.

### Events

| Event | Arguments |
|---|---|
| `sg_permissions:changed` (server bus) | `playerId, roles` |
| `sg_permissions:updated` (client) | `roles` |

### Command

`perm grant|revoke|check|roles <playerId> [role|privilege]`, for the console and players holding
`permissions.manage`.

## Client API

| Export | Returns |
|---|---|
| `roles()` | the local player's roles |
| `can(privilege)` | the decision on the local player's patterns (for UI only: the server decides) |

## Configuration

`roles`: a table of `name = { inherits = { ... }, privileges = { ... } }`. Without it:

| Role | Inherits | Privileges |
|---|---|---|
| `user` | | |
| `moderator` | `user` | `chat.mute`, `players.kick`, `inventory.inspect` |
| `admin` | `moderator` | `*` |

## License

MIT.
