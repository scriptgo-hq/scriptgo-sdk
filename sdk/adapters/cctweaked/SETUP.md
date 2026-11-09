Needs a Minecraft: Java Edition server you own or run, with [Fabric](https://fabricmc.net) and the
[CC: Tweaked](https://tweaked.cc) mod (measured with Minecraft 1.20.1, Fabric loader 0.20.1, Fabric API
0.92.12 and CC: Tweaked 1.121.0). Not an official Minecraft product. Not approved by or associated
with Mojang or Microsoft. Not affiliated with the CC: Tweaked developers.

**Free packages only.** The [Minecraft EULA](https://www.minecraft.net/en-us/eula) lets you do what
you want with mods you create "as long as you don't sell them for money / try to make money from
them", so packages for this environment cannot have paid offers. Licence checks are not offered
either: the [Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines) allow a mod
only if it "cannot be used to directly or indirectly verify whether a player owns or has access to
out-of-game content, products, or services that affect in-game features and functions".

1. Build the computer's files, with your resources:

   ```sh
   node sdk/adapters/cctweaked/build.mjs --with path/to/my_resource --startup
   ```

   This writes `dist/cctweaked/computer/`: the SCRIPT//GO core, the adapter, the `sg` program and
   your resources. Optional: `scriptgo/config.json` there sets permissions, config and convars:

   ```json
   { "permissions": { "1": ["*"] }, "resources": { "my_resource": { "greeting": "hi" } } }
   ```

2. Place a computer in the world, note its id (`id` in its shell), stop the server and copy the
   folder's contents into `<world>/computercraft/computer/<id>/`. The default disk of a computer is
   1 MB (`computer_space_limit` in `<world>/serverconfig/computercraft-server.toml`).

3. Start the server and use the computer: with `--startup` it runs SCRIPT//GO at boot; otherwise
   type `scriptgo/sg`. At the `sg>` prompt, resource commands run as the person at the terminal
   (player `1`); `status`, `log`, `restart <name>` and `exit` drive the host.

Running a Minecraft server, including the headless one `scriptgo verify --env cctweaked` starts,
means accepting the [Minecraft EULA](https://www.minecraft.net/en-us/eula): the operator must accept
it themselves (`eula=true` in the server's `eula.txt`, or `--accept-minecraft-eula` on a verify run).
SCRIPT//GO never accepts it for anyone.

HTTP, when a resource uses it, goes through CC: Tweaked's `http` API, so the server's
`computercraft-server.toml` decides whether it is on and which hosts answer (`[[http.rules]]`; local
and private addresses are denied by default).
