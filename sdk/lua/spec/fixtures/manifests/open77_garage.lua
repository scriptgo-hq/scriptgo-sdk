resource "garage"
version "1.0.0"
open77_version ">=0.0.1"
auto_start true
reload_policy "local"

shared_script "shared/config.lua"
server_script "server/main.lua"
client_script "client/main.lua"

files { "assets/**/*.png" }

web_ui_page "web/index.html"
web_ui_auto_create false
web_files { "web/**" }

permissions {
    "local.events",
    "network.events"
}
