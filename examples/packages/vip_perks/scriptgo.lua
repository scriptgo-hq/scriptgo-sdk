-- VIP perks: the example of a script that applies a perk its operator sells to the players of their
-- own server (player perks, ADR-0038). The operator's store takes the payment; SCRIPT//GO tells this
-- server who has the perk; this script applies it. Used by the perks end-to-end run.
resource "vip_perks"
version "0.1.0"
title "VIP perks"
description "Applies a perk the server's operator sells to players: asks when a player joins, follows grants and removals."
author "scriptgo"
license "MIT"
category "economy"
scriptgo_version ">=0.1.0"
open77_version ">=0.0.1"
lua { "5.1", "5.4", "luajit" }
environments { "standalone", "open77", "rust", "dotnet" }
capabilities { "events", "logging", "players", "perks" }
optional_capabilities { "config", "ui" }

server_script "server/main.lua"

test_script "tests/vip_perks_test.lua"
