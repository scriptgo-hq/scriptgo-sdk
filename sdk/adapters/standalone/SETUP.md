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

Storage goes to `.scriptgo-data/storage/` (`--data` to change it). HTTP and licensing use the
system `curl`.
