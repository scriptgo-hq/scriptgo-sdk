-- An asset-only conformance package: no scripts, one file per delivery form. `scriptgo verify
-- --env luanti` and `--env garrysmod` pack it and load it in the real server (docs/spec/assets.md).
resource "sg_assets_probe"
version "1.0.0"
title "SCRIPT//GO assets probe"
description "Conformance fixture: client-delivered assets on Luanti and Garry's Mod."
author "scriptgo"
license "MIT"
scriptgo_version ">=0.1.0"
environments { "luanti", "garrysmod", "standalone" }

test_script "tests/assets_test.lua"

environment_asset "luanti" { "textures/sg_assets_probe_sign.png", "locale/sg_assets_probe.fr.tr" }
environment_asset "garrysmod" { "materials/sg_assets_probe/sign.png", "sound/sg_assets_probe/chime.wav" }
