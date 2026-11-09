-- TypeScript and JavaScript scripts: compiled to JavaScript at pack time, run by hosts with a JS guest
resource "ts_widget"
version "1.0.0"
scriptgo_version ">=0.1.0"
shared_script "shared/types.ts"
server_script "server/main.ts"
client_script "client/ui.js"
environment_script "dotnet" "env/dotnet/extra.lua"
environments { "dotnet", "standalone" }
