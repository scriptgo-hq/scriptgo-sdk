-- EventBus Kit: typed, validated topics on top of the host event bus.
resource "sg_eventbus"
version "1.0.0"
title "EventBus Kit"
description "Typed topics with schema validation, retained values, rate limits and opt-in client delivery."
author "scriptgo"
license "MIT"
category "events"
scriptgo_version ">=0.1.0"
open77_version ">=0.0.1"
lua { "5.1", "5.4", "luajit" }
environments { "standalone", "love2d", "godot", "luanti", "open77" }
capabilities { "events", "logging" }
optional_capabilities { "players" }
permissions { "local.events", "network.events" }

shared_script "shared/schema.lua"
server_script "server/main.lua"
client_script "client/main.lua"

server_export "defineTopic"
server_export "publish"
server_export "last"
server_export "topics"
server_export "stats"

test_script "tests/eventbus_test.lua"
