-- Full SCRIPT//GO manifest (docs/spec/manifest.md example)
resource "inventory_pro"
version "1.4.1"
scriptgo_version ">=0.1.0"
open77_version ">=0.0.1"

title "Inventory Pro"
description "Stacks, weights, persistence and events."
author "kestrel"
license "MIT"
category "inventory"

lua { "5.1", "5.4", "luajit" }
environments { "standalone", "love2d", "godot", "luanti", "open77" }
capabilities { "events", "storage" }
optional_capabilities { "ui", "players" }

shared_script "shared/core.lua"
server_script "server/main.lua"
client_script "client/main.lua"
environment_script "love2d" "env/love2d/hud.lua"
environment_scripts "godot" { "env/godot/a.lua", "env/godot/b.lua" }

test_script "tests/core_test.lua"

permissions { "local.events", "network.events", "filesystem.read", "filesystem.write" }
dependencies { "sg_eventbus >=1.0.0", "sg_permissions" }
--[[ block
comment ]]
preload_mod "dist/x.zip"
