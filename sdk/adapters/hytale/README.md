# SCRIPT//GO for Hytale

A Hytale server plugin (Java) that embeds a Lua 5.2 VM written in Java, [Cobalt][cobalt], and runs
the pure-Lua SCRIPT//GO core in it. Resources keep their format: a `scriptgo.lua` manifest, shared
and server scripts, events, exports, commands, storage. Players install nothing.

**Status: planned.** The plugin is built, and the bridge passes the conformance probe and the SDK
spec suite on a plain JVM, but nothing has run on a real Hytale server yet: the server files come
only with the owner's Hytale account (see [SETUP.md](SETUP.md)). Decision record: ADR-0017.

## Layout

| Path | What |
|---|---|
| `bridge/` | `scriptgo-jvm`: Cobalt, the core (`sdk/lua/scriptgo`, packaged as classpath resources) and `lua/`, behind a small `HostServices` interface. Knows nothing about Hytale; tested on a plain JVM |
| `lua/` | The Hytale adapter table (`adapter.lua`) and the host loop, discovery, verify mode and `/scriptgo` (`main.lua`) |
| `plugin/` | The Hytale plugin: `ScriptGoPlugin`, `HytaleServices` (HostServices on the Hytale API), `LuaCommand`, `manifest.json` |
| `api-stubs/` | Hand-written stand-ins for the dozen Hytale API members the plugin uses, so its Java compiles without the proprietary server jar. Compile check only |

## Build

Maven through the wrapper (Maven 3.9.16, pinned with its SHA-256). Every version is pinned in
`pom.xml`; the Cobalt jar's SHA-256 is checked by a test.

```bash
./mvnw verify                                                  # bridge tests + plugin compile check (JDK 21+)
./mvnw package -Dhytale.server.jar=<server>/HytaleServer.jar   # the real plugin (JDK 25)
./mvnw package -Dhytale.version=0.7.6                          # same, against com.hypixel.hytale:Server from maven.hytale.com
```

`MAVEN_USER_HOME` and `-Dmaven.repo.local` move the wrapper's Maven and the dependency cache
(about 35 MB) off the system drive. The plugin jar bundles Cobalt relocated under
`scriptgo.shaded`, with its licences in `META-INF/THIRD-PARTY-LICENSES.txt`; it never bundles
Hytale code.

## How the runtime maps onto Hytale

| SCRIPT//GO | Hytale |
|---|---|
| Sides | Server only: Hytale plugins run on the server |
| Lua | Cobalt 0.9.9 (Lua 5.2) in the server's JVM. No `io`, no C modules; `os.time`, `os.clock` (CPU time of the host thread), `os.date`, `os.difftime` |
| Tick | A daemon thread, `scriptgo-host`, every 20 ms. All Lua runs there, never on a world thread; game events are posted to it in arrival order |
| Execution budget | The core's per-resume budget (`budgetMs`, default 1000) through Cobalt's debug hook: a runaway resource is stopped, the host keeps ticking |
| Players | `PlayerConnectEvent` / `PlayerDisconnectEvent`; UUIDs get session-stable integer ids; `players.identifier(id)` is `hytale:<uuid>` |
| `RegisterCommand` | Commands known at the end of the plugin's setup become real `/commands` (Hytale takes registrations only then); every command also runs as `/sg <command> [args]` |
| `permissions.has` | Hytale permission nodes `scriptgo.admin` or `scriptgo.<privilege>` (`PermissionsModule`), then `scriptgo.json` grants by name or UUID (`*`, `prefix.*`) |
| `storage` | `<data folder>/storage/<key>.json`, written atomically |
| `config.get` / `GetConvar` | `scriptgo.json` `resources` and `convars` |
| `ui.notify` | A coloured chat message to the player, or to everyone for `-1` |
| `http`, `licensing` | `java.net.http`, asynchronous, answers handed back on the host thread; off until `scriptgo.json` lists `http.allowedHosts`; redirects never followed |
| Files | `readFile` / `listFiles` confined to resource folders and the data folder |

`/scriptgo` lists the resources and their state; `/scriptgo start|stop|restart <name>` needs
`scriptgo.admin` (the console always may). `/sg` alone lists the resource commands.

## Verify

```bash
scriptgo verify <resourceDir> --env hytale --hytale-server <folder> --hytale-java <jdk-25>/bin/java
```

runs the owner's server (`HytaleServer.jar` + `Assets.zip`) from a throwaway folder next to it,
with the plugin in `mods/` and the resource, its dependencies and its README example in a
`resources/` folder. The server is bound to `127.0.0.1:5521`, in offline auth mode (no player can
join, none is needed), with Sentry and updates off. The plugin reads `-Dscriptgo.verify*`
properties, starts only those resources, writes the report after `--hytale-seconds` (default 5)
and stops the server. Without the server files, a Java 25 or the real plugin jar, the run is
reported as skipped, never as verified.

The JVM tests (`./mvnw verify`) are not that run: they drive the same verify mode with in-memory
services instead of Hytale, and only prove the bridge.

[cobalt]: https://github.com/SquidDev/Cobalt

## Assets

A package can carry an asset pack (`environment_asset "hytale" "<pack>.zip"`: `manifest.json` with
`"IncludesAssetPack": true` and no `Main`, `Common/`, `Server/`). `scriptgo pack <dir> --target
hytale` copies it to `mods/`.

Not run in the real runtime: no Hytale server loaded a pack built this way. See
`docs/spec/assets.md`.
