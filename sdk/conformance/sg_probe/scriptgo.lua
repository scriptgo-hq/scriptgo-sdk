-- Conformance probe: the same resource runs on every host and prints the same verdicts, so
-- "works the same on OPEN//77" is a measured claim, not a hope. See sdk/conformance/README.md.
resource "sg_probe"
version "0.1.0"
title "Conformance probe"
description "Checks the ScriptGo namespace and the three base packages on whatever host runs it."
author "scriptgo"
license "MIT"
category "library"
scriptgo_version ">=0.1.0"
open77_version ">=0.0.1"
lua { "5.1", "5.4", "luajit" }
environments { "standalone", "love2d", "godot", "luanti", "open77", "neovim", "cctweaked", "dotnet", "garrysmod" }
capabilities { "events", "logging", "storage", "players", "permissions", "config" }
permissions { "local.events" }

dependency "sg_eventbus >=1.0.0"
dependency "sg_inventory >=1.0.0"
dependency "sg_permissions >=1.0.0"

server_script "server/probe.lua"

test_script "tests/probe_test.lua"
