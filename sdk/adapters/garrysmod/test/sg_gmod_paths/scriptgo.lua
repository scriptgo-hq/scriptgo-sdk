-- Adapter paths that need a player, run on a real Garry's Mod server with a bot: a chat command
-- typed by the bot, a restricted command refused, permissions granted by usergroup in config.json,
-- per-resource config, a real convar through GetConvar, notifications, players and the drop event.
--   scriptgo verify sdk/adapters/garrysmod/test/sg_gmod_paths --env garrysmod \
--     --gmod-verify sdk/adapters/garrysmod/test/sg_gmod_paths.verify.json
resource "sg_gmod_paths"
version "0.1.0"
description "Garry's Mod adapter paths a player needs."
author "scriptgo"
license "MIT"
scriptgo_version ">=0.1.0"
lua { "5.1", "luajit" }
environments { "garrysmod" }
capabilities { "events", "logging", "players", "permissions", "commands", "config", "ui" }

server_script "server.lua"
