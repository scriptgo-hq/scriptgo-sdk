1. Copy `scriptgo_love.lua`, `adapter.lua` and `verify.lua` from `sdk/adapters/love2d/` into the
   game (for example `lib/`), and the core `sdk/lua/scriptgo/` next to them as `lib/scriptgo/`.
2. Put resources in a folder of the game, for example `resources/sg_inventory/`.
3. Create the host in `love.load` and drive it from the game's callbacks:

   ```lua
   local scriptgoLove = require("lib.scriptgo_love")
   local sg
   function love.load()
       sg = scriptgoLove.new({
           resources = { "sg_inventory" },          -- dependencies are added too
           search = { "resources" },
           player = { id = 1, name = "Ada" },
           config = { permissions = { ["1"] = { "inventory.give" } } },
       })
   end
   function love.update(dt) sg:update(dt) end
   function love.draw() --[[ the game ]] sg:draw() end
   function love.quit() sg:shutdown() end
   ```

The server side and the local client (player `1`) both run in the game process. Storage goes to
the save directory; HTTP and licensing use `curl` in a `love.thread` worker, so frames keep running.
The layout works from a folder and from a `.love` archive.
