-- A package that sells a map with its scripts: generic assets and per-environment delivery forms.
resource "night_market"
version "2.0.0"
scriptgo_version ">=0.1.0"
category "housing"
environments { "fivem", "redm", "open77", "garrysmod" }

server_script "server/doors.lua"
client_script "client/doors.lua"

assets { "media/**/*.png", "media/sounds/*.ogg" }
environment_asset "open77" "dist/night_market.zip"
environment_assets "fivem" { "stream/**", "data/vehicles.meta" }
environment_asset "garrysmod" "maps/gm_night_market.bsp"
game_build "open77" "2.5"
game_builds "fivem" { "3258", "3407" }
data_file "DLC_ITYP_REQUEST" "stream/night_market.ytyp"
data_file "VEHICLE_METADATA_FILE" "data/vehicles.meta"
cfx_escrow_ignore { "config.lua", "config/**" }
