// scriptgo init <name> [--dir <parent>]: a new resource in the shared SCRIPT//GO / OPEN//77 format.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RESOURCE_NAME } from "@scriptgo/manifest";
import { parseArgs } from "../lib/args.ts";

export const summary = "Create a new resource (manifest, server, client, test)";

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help"] });
  const name = a.positional[0];
  if (a.bools.has("help") || !name) {
    console.log("scriptgo init <name> [--dir <parentFolder>] [--author <name>]");
    return a.bools.has("help") ? 0 : 2;
  }
  if (!RESOURCE_NAME.test(name)) {
    console.error("A resource name is 3 to 64 lowercase letters, digits or '_', starting with a letter.");
    return 2;
  }
  const root = resolve(a.flags.dir ?? ".", name);
  if (existsSync(root)) {
    console.error(`${root} already exists.`);
    return 1;
  }
  const author = a.flags.author ?? "you";
  const files: Record<string, string> = {
    "scriptgo.lua": `resource "${name}"
version "0.1.0"
title "${name}"
description "Describe what it does in one sentence."
author "${author}"
license "MIT"
category "other"
scriptgo_version ">=0.1.0"
lua { "5.1", "5.4", "luajit" }
environments { "standalone" }
capabilities { "events", "logging" }
permissions { "network.events" }

shared_script "shared/config.lua"
server_script "server/main.lua"
client_script "client/main.lua"

test_script "tests/main_test.lua"
`,
    "shared/config.lua": `-- Shared by server and client.
Config = {
    greeting = "Hello",
}
`,
    "server/main.lua": `-- Server side: authoritative.
RegisterNetEvent("${name}:hello", function()
    local player = source
    TriggerClientEvent("${name}:greet", player, Config.greeting .. ", player " .. tostring(player))
end)

exports("greet", function(who)
    return Config.greeting .. ", " .. tostring(who)
end)
`,
    "client/main.lua": `-- Client side.
RegisterNetEvent("${name}:greet", function(text)
    print(text)
end)

TriggerServerEvent("${name}:hello")
`,
    "tests/main_test.lua": `-- Run with: scriptgo test .
describe("${name}", function()
    test("greets", function()
        local h = load()
        expect(h:call("${name}", "greet", "Ada")).toBe("Hello, Ada")
    end)
end)
`,
  };
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  console.log(`created ${root}`);
  console.log(`next: scriptgo test ${name}  |  scriptgo run ${name}  |  scriptgo pack ${name} --target open77`);
  return 0;
}
