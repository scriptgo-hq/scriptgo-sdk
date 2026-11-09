-- Inventory Pro: the sample paid package of the acceptance journey. Built on InventoryKit; its
-- premium features (crafting, hotbar, rarities) run only with a valid SCRIPT//GO license.
resource "inventory_pro"
version "1.4.3"
title "Inventory Pro"
description "Crafting, hotbars and item rarities on top of InventoryKit. Licensed per server."
author "kestrel"
license "LicenseRef-ScriptGo-Commercial"
category "inventory"
scriptgo_version ">=0.1.0"
open77_version ">=0.0.1"
licensed true
lua { "5.1", "5.4", "luajit" }
environments { "standalone", "love2d", "luanti", "open77", "neovim" }
capabilities { "events", "logging", "storage", "players", "licensing", "http" }
optional_capabilities { "commands", "ui", "config" }
permissions { "local.events", "network.events" }

dependency "sg_inventory >=1.0.0"

shared_script "shared/catalog.lua"
server_script "server/license.lua"
server_script "server/main.lua"
client_script "client/main.lua"

test_script "tests/inventory_pro_test.lua"
