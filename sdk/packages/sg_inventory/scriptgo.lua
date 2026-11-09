-- InventoryKit: slot and weight inventories with stacking, persistence and a client mirror.
resource "sg_inventory"
version "1.0.0"
title "InventoryKit"
description "Slot and weight inventories with stacking, unique items, moves, use events and persistence."
author "scriptgo"
license "MIT"
category "inventory"
scriptgo_version ">=0.1.0"
open77_version ">=0.0.1"
lua { "5.1", "5.4", "luajit" }
environments { "standalone", "love2d", "godot", "luanti", "open77" }
capabilities { "events", "logging", "storage", "players" }
optional_capabilities { "commands", "config", "ui", "permissions" }
permissions { "local.events", "network.events" }

shared_script "shared/inventory.lua"
server_script "server/main.lua"
client_script "client/main.lua"

server_export "defineItem"
server_export "items"
server_export "getInventory"
server_export "count"
server_export "add"
server_export "remove"
server_export "move"
server_export "use"
server_export "clear"

test_script "tests/inventory_test.lua"
