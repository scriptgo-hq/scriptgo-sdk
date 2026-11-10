# CC: Tweaked adapter (`cctweaked`)

Runs SCRIPT//GO resources on one ComputerCraft computer in a Minecraft: Java Edition world, through
the [CC: Tweaked](https://tweaked.cc) mod. The server side and the local client (player `1`, whoever
is at the computer's terminal) both run on the computer, on the same portable host as every other
environment (`sdk/lua/scriptgo`); events between them are looped back through the value codec. A
CC timer ticks the host every server tick (50 ms).

Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft. Not
affiliated with the CC: Tweaked developers. No Minecraft or Mojang logo or art is used anywhere.

| File | Role |
|---|---|
| `computer/scriptgo/adapter.lua` | The adapter the host calls: clocks, logging, files, storage, notifications, permissions, config, HTTP |
| `computer/scriptgo/sg.lua` | The program on the computer: starts the resources, the `sg>` console, and `sg verify` |
| `build.mjs` | Builds a computer's files: the program, the adapter, the core and resources |
| `runtime.mjs` | The pinned runtime for runs (JDK, Fabric, Fabric API, CC: Tweaked), each checked by SHA-256 |
| `harness/` | The cc-core harness: fast tests on CC: Tweaked's own core and Lua VM, without Minecraft |
| `SETUP.md` | Installing it on a server (shown on the environment page) |

What the adapter maps:

| Capability | CC: Tweaked |
|---|---|
| clock | `os.clock()`: the computer's uptime, advanced by server ticks |
| wall clock | `os.epoch("utc")`. `os.time()` is the in-game hour on CC: Tweaked, so the adapter gives the core `wallTime` and resources see Unix time from `os.time()` and `ScriptGo.time.now()` |
| files, `storage` | `fs`, the computer's own disk; storage in `/scriptgo/data/<key>.json` |
| `ui` | a line on the terminal for player `1` (or everyone), always logged |
| `commands` | typed at the `sg>` prompt, run as player `1` |
| `permissions`, `config` | `/scriptgo/config.json`; convars fall back to the computer's `settings` |
| `players` | the single terminal player, id `1` |
| `http` | the asynchronous `http` API: `http.request` now, `http_success` / `http_failure` later. Each request carries a unique `#sg-<n>` fragment (never sent to the server) so two answers to the same URL cannot be swapped. Redirects are not followed |
| `licensing` | off, always (below) |

The computer runs Lua 5.2 (the Cobalt VM): no `//`, no bitwise operators (use `bit32`), no
`collectgarbage`; the core checks for the latter. Code that runs about 7 seconds without yielding is
stopped by CC: Tweaked ("Too long without yielding"); the host yields every tick.

## The platform's rules, and licensing

**The platform's own rules on paid mods.** The [Minecraft EULA](https://www.minecraft.net/en-us/eula),
"USING mods": "Any Mods you create for Minecraft: Java Edition from scratch belong to you (including
pre-run Mods and in-memory Mods) and you can do whatever you want with them, as long as you don't
sell them for money / try to make money from them and so long as you don't distribute Modded
Versions of the game." The registry reports it as `platformRules = "restricts_paid"` with this
sentence as its note. It is information for the operator who runs a script here and answers for it:
SCRIPT//GO does not enforce a platform's rules, and no environment blocks a paid offer (ADR-0037).

**No licence check in this adapter.** The [Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines),
"Extended functionality and modifications": a mod may be created, used or distributed if "The mod
cannot be used to directly or indirectly verify whether a player owns or has access to out-of-game
content, products, or services that affect in-game features and functions". The adapter was built
without a licence check for that reason: it sets `capabilities.licensing = false` whatever the
config says, and the registry marks `licensing` unavailable and the protection tier `none`. That
is a technical fact about this adapter. These are the rights holder's rules quoted as they read;
they are not legal advice.

**Name.** The Usage Guidelines allow the Minecraft name only as a secondary part of a name, hence
"CC: Tweaked (Minecraft)", and ask for the disclaimer above.

## Verifying (`scriptgo verify --env cctweaked`)

The only run that counts. It needs the pinned runtime and **the operator must accept the Minecraft
EULA themselves**:

```sh
node sdk/adapters/cctweaked/runtime.mjs          # JDK, Fabric launcher, Fabric API, CC: Tweaked
# the operator reads https://www.minecraft.net/en-us/eula; if they agree, they accept it with the flag:
scriptgo verify sdk/conformance/sg_probe --env cctweaked --accept-minecraft-eula
```

`--accept-minecraft-eula` writes `eula=true` into the runtime's `server/eula.txt` (under
`tools/runtimes/minecraft`, gitignored, or `SCRIPTGO_MINECRAFT_DIR`), never into a tracked file;
writing that line by hand is the same acceptance. Nothing else writes it, and an agent never passes
the flag on someone's behalf. Without it the run is reported as skipped before anything is fetched
from Mojang. Once accepted, Fabric's launcher downloads the vanilla server at the first start (its
SHA-1 is checked against Mojang's, recorded in `runtime.mjs`).

A run writes `server.properties` (loopback `server-ip=127.0.0.1`, a free port, white-list on and
empty, no status, query or RCON listener, a flat world), starts the server headless in a throwaway
world, builds the computer's disk under `<world>/computercraft/computer/0/` (core, adapter,
resources, the README example, `/scriptgo/verify.json`), places the computer with
`/setblock 0 100 0 computercraft:computer_normal{ComputerId:0,On:1b}` in a force-loaded chunk, and
waits for the report the computer writes (`sg verify`): the usual checks, `self:*` lines, the
resource's tests on the in-memory harness, plus `server_run`, `computer_placed`,
`minecraft_server_jar` and `minecraft_host` (`_HOST` must name Minecraft). The world is deleted
afterwards.

`SCRIPTGO_MINECRAFT_DIR` puts the runtime (several hundred MB) and the worlds elsewhere, for example
on another disk.

## The cc-core harness (emulator)

`harness/CcCoreRun.java` runs one computer on CC: Tweaked's core classes, Cobalt VM, BIOS and ROM
taken from the pinned mod jar, without Minecraft; `_HOST` then reads "... (SCRIPT//GO cc-core harness,
no Minecraft)". It tests the adapter against the real CC APIs in seconds. It is an emulator: its
runs are not compatibility reports, nothing is written to `verification/reports`, and they never make
the environment verified.

```sh
node sdk/adapters/cctweaked/runtime.mjs --harness                 # Maven libraries + javac, once
node sdk/adapters/cctweaked/harness/run.mjs sdk/conformance/sg_probe
```

`node tools/lua-test.mjs` runs the probe on it when the harness is set up.
