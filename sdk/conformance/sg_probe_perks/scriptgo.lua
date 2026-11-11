-- Perks conformance probe: ScriptGo.perks against a SCRIPT//GO API (docs/spec/perks.md), with the
-- same verdict lines as sg_probe. Needs the host settings `scriptgo_api` and `scriptgo_server_token`,
-- which `scriptgo verify --stub-api` provides with a loopback stub holding fixed data
-- (packages/cli/src/lib/stub-perks.ts). See sdk/conformance/README.md.
resource "sg_probe_perks"
version "0.1.0"
title "Perks conformance probe"
description "Checks the player perks calls on whatever host runs it."
author "scriptgo"
license "MIT"
category "library"
scriptgo_version ">=0.1.0"
open77_version ">=0.0.1"
lua { "5.1", "5.3", "5.4", "luajit" }
environments { "standalone", "open77", "dotnet", "rust" }
capabilities { "perks", "config" }

server_script "server/probe_perks.lua"

test_script "tests/probe_perks_test.lua"
