// scriptgo test <dir>: runs the resource's test_script files on every Lua dialect available.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "../lib/args.ts";
import { defaultSearchPaths, pickInterpreters, standaloneMain } from "../lib/sdk.ts";

export const summary = "Run a resource's test_script files on Lua 5.4, 5.1 and LuaJIT";

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help"], repeatable: ["search"] });
  if (a.bools.has("help") || a.positional.length === 0) {
    console.log("scriptgo test <resourceDir> [--lua all|lua54|lua51|luajit|<path>] [--search dir]...");
    return a.bools.has("help") ? 0 : 2;
  }
  const dir = resolve(a.positional[0]!);
  let failed = 0;
  for (const lua of pickInterpreters(a.flags.lua ?? "all")) {
    const argv = [standaloneMain, "test", dir];
    for (const s of [...a.multi.search!, ...defaultSearchPaths()]) argv.push("--search", resolve(s));
    console.log(`--- ${lua.name}`);
    const r = spawnSync(lua.path, argv, { stdio: "inherit" });
    if (r.status !== 0) failed++;
  }
  return failed === 0 ? 0 : 1;
}
