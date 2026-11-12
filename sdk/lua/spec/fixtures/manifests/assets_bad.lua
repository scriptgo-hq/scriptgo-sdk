-- Every asset refusal of the parser, in the order the three parsers report them.
resource "bad_assets"
version "1.0.0"
scriptgo_version ">=0.1.0"
server_script "server/main.lua"
data_file "VEHICLE_LAYOUTS_FILE"
assets { "../outside.png", ".scriptgo/fingerprint.json" }
cfx_escrow_ignore "C:/config.lua"
environment_asset "Open77" "dist/map.zip"
game_build "open77" "2.5 beta"
data_file "dlc_ityp_request" "stream/a.ytyp"
