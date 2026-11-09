Needs Neovim 0.10 or later (measured on 0.12.6) and `curl` for licensed packages.

1. Add `sdk/adapters/neovim/` to Neovim as a plugin. Inside the SDK checkout it finds the core by
   itself; elsewhere copy `sdk/lua/scriptgo/` to `lua/scriptgo_nvim/core/` in the plugin, or set
   `vim.g.scriptgo_core`. With lazy.nvim:

   ```lua
   {
     dir = "~/scriptgo/sdk/adapters/neovim",
     config = function()
       require("scriptgo_nvim").setup({
         search = { vim.fn.expand("~/scriptgo/resources") },
         resources = { "sg_inventory" },
         config = { permissions = { ["1"] = { "*" } } },
       })
     end,
   }
   ```

2. Use it from the editor:

   ```vim
   :ScriptGo status
   :ScriptGo giveitem 1 water 2
   :ScriptGo log
   ```

The server side and the local client (you, player `1`) run inside the editor, ticked by a timer on
the main loop. Notifications go to `vim.notify`; storage to `stdpath("data")/scriptgo/storage`.
