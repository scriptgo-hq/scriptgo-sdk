-- Network conformance probe: ScriptGo.http and ScriptGo.licensing against a SCRIPT//GO API, with
-- the same verdict lines as sg_probe. Needs the config `api` (base URL) and `license_key`, which
-- `scriptgo verify --stub-api` provides. See sdk/conformance/README.md.
resource "sg_probe_net"
version "0.1.0"
title "Network conformance probe"
description "Checks outbound HTTP and the licensing calls on whatever host runs it."
author "scriptgo"
license "MIT"
category "library"
scriptgo_version ">=0.1.0"
open77_version ">=0.0.1"
lua { "5.1", "5.4", "luajit" }
environments { "standalone", "open77", "neovim", "dotnet", "garrysmod" }
capabilities { "http", "licensing", "config" }

server_script "server/probe_net.lua"

test_script "tests/probe_net_test.lua"
