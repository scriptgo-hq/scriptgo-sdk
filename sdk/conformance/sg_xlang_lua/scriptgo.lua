-- Cross-language conformance, Lua half: calls the TypeScript resource sg_xlang_ts and is called by
-- it (exports both ways, events both ways, the value codec in between). Verified as the root of the
-- pair: `scriptgo verify sdk/conformance/sg_xlang_lua --env dotnet`. See sdk/conformance/README.md.
resource "sg_xlang_lua"
version "0.1.0"
title "Cross-language probe (Lua half)"
description "Lua and TypeScript resources calling each other: exports and events both ways."
author "scriptgo"
license "MIT"
category "library"
scriptgo_version ">=0.1.0"
environments { "dotnet" }
capabilities { "events", "logging" }

dependency "sg_xlang_ts >=0.1.0"

server_script "server/xlang.lua"
test_script "tests/xlang_test.lua"
