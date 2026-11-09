resource "bank"
version "1.0.0"
scriptgo_version ">=0.1.0"
server_script "server.lua"
server_exports { "balance", "withdraw-cash", "getBalance" }
exports { "open_menu" }
