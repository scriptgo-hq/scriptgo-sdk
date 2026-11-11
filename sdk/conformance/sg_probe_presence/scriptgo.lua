-- Player match conformance probe: ScriptGo.presence against a SCRIPT//GO API
-- (docs/spec/player-match.md), with the same verdict lines as sg_probe. Needs the host settings
-- `scriptgo_api`, `scriptgo_server_token` and `scriptgo_presence`, a connected player with an
-- address, and an HMAC on the host. `scriptgo verify --stub-api` provides the settings and, on the
-- standalone host, a simulated player at a documentation address
-- (packages/cli/src/lib/stub-presence.ts). See sdk/conformance/README.md.
resource "sg_probe_presence"
version "0.1.0"
title "Player match conformance probe"
description "Checks presence reporting and the link command on whatever host runs it."
author "scriptgo"
license "MIT"
category "library"
scriptgo_version ">=0.1.0"
open77_version ">=0.0.1"
lua { "5.1", "5.3", "5.4", "luajit" }
environments { "standalone", "open77", "dotnet", "rust" }
capabilities { "presence", "players", "config" }

server_script "server/probe_presence.lua"

test_script "tests/probe_presence_test.lua"
