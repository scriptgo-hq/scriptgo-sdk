-- In this repository the SDK sits three folders up, so the demo runs from source with
--   love examples/love2d/demo
-- A shipped game copies scriptgo_love.lua, adapter.lua and the core into its own folder instead
-- (see sdk/adapters/love2d/README.md).
local source = love.filesystem.getSource():gsub("\\", "/")
package.path = source .. "/../../../sdk/adapters/love2d/?.lua;" .. package.path
local scriptgoLove = require("scriptgo_love")

function love.conf(t)
    t.identity = "scriptgo_love_demo"
    t.version = "11.5"
    t.window.title = "SCRIPT//GO on LÖVE"
    t.window.width = 1000
    t.window.height = 620
    t.modules.joystick = false
    t.modules.physics = false
    t.modules.video = false
    -- `--scriptgo-verify <resourceDir>` runs headless: no window, no graphics, no audio.
    scriptgoLove.conf(t, arg)
end
