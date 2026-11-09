The Hytale plugin is built but has not run on a real Hytale server yet (status: planned). These
steps need the server owner's own Hytale account: SCRIPT//GO never downloads or ships Hytale files.

1. **Get the server files with your Hytale account.** Downloading and running them means accepting
   the Hytale EULA; that is the server owner's decision. Either copy `Server/HytaleServer.jar` and
   `Assets.zip` from your Hytale launcher install, or use the official Hytale Downloader, which
   signs in with your account. Put both files in one folder (about 3.4 GB), for example
   `D:/scriptgo-runtimes/hytale/server/`.
2. **Install a JDK 25** (the server needs Java 25), for example Eclipse Temurin 25.
3. **Build the plugin against your server jar** (in `sdk/adapters/hytale`, with that JDK):

   ```bash
   JAVA_HOME=<jdk-25> ./mvnw package -Dhytale.server.jar=<server folder>/HytaleServer.jar
   ```

   The plugin is `plugin/target/scriptgo-hytale-0.1.0.jar` (Cobalt is bundled; Hytale is not).
   A plain `./mvnw verify` only compiles the plugin against stand-ins: the jar it makes is named
   `...-STUBS-DO-NOT-INSTALL` and must never go on a server.
4. **Install it:** copy the jar into the server's `mods/` folder. At startup the server log shows
   `[scriptgo] data folder: ...` (expected `mods/ScriptGo_ScriptGo/`). Resources go in
   `<data folder>/resources/<name>/`; every resource with `auto_start true` starts with the server,
   dependencies first. Optional `<data folder>/scriptgo.json`:

   ```json
   {
     "resources": { "sg_inventory": { "slots": 30 } },
     "convars": { "scriptgo_api": "https://api.example.com" },
     "permissions": { "Alice": ["command.giveitem"] },
     "http": { "allowedHosts": ["api.example.com"] },
     "start": ["sg_inventory"]
   }
   ```

   Grants take a player name or UUID. Hytale permission nodes work too: `scriptgo.admin` (every
   privilege, and `/scriptgo start|stop|restart`), or `scriptgo.<privilege>` such as
   `scriptgo.command.giveitem`. Operators hold `*`, so they have both.
5. **Verify on the real server** (loopback, offline auth mode, no player needed), then commit the
   reports written to `verification/reports/`:

   ```bash
   scriptgo verify sdk/conformance/sg_probe --env hytale --hytale-server <server folder> --hytale-java <jdk-25>/bin/java
   scriptgo verify sdk/packages/sg_eventbus --env hytale --hytale-server <server folder> --hytale-java <jdk-25>/bin/java
   ```

   `SCRIPTGO_HYTALE_SERVER` and `SCRIPTGO_HYTALE_JAVA` can replace the two flags. A package's
   README example runs with it. A package passes `environment_declared` only once its manifest
   lists `hytale` (sg_eventbus 1.0.2 does not yet, so that one check fails until it does).

Only the server side runs: Hytale plugins are server-side and players install nothing. HTTP, and
so online license checks, reaches only the hosts listed in `http.allowedHosts`.
