-- PermissionsKit: roles with inheritance and wildcard privileges, persisted per player.
resource "sg_permissions"
version "1.0.2"
title "PermissionsKit"
description "Roles, inheritance, wildcard privileges and grants that survive restarts."
author "scriptgo"
license "MIT"
category "permissions"
scriptgo_version ">=0.1.0"
open77_version ">=0.0.1"
lua { "5.1", "5.4", "luajit" }
environments { "standalone", "love2d", "godot", "luanti", "open77", "neovim" }
capabilities { "events", "logging", "storage", "players", "commands" }
optional_capabilities { "permissions", "config", "ui" }
permissions { "local.events", "network.events", "acl.read" }

shared_script "shared/perms.lua"
server_script "server/main.lua"
client_script "client/main.lua"

test_script "tests/permissions_test.lua"
