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
     "convars": { "scriptgo_api": "https://api.example" }
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
     "convars": { "scriptgo_api": "https://api.example" },
     "licenses": { "inventory_pro": { "deploymentToken": "sg_dep_...", "package": "kestrel//inventory-pro" } }
   }
   ```

   This is a licence check, not code secrecy: the host runs plain Lua, so its operator can read
   what it loads. A protected (escrow) release arrives as an encrypted bundle; on this host
   `scriptgo escrow load --out <dir>` opens it on your bound server and writes the copy to disk,
   which is licence-only protection.

Storage goes to `.scriptgo-data/storage/` (`--data` to change it). HTTP and licensing use the
system `curl`.
