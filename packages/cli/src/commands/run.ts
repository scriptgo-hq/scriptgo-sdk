// scriptgo run <dir...>: runs resources in the standalone host (server + one local client).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "../lib/args.ts";
import { defaultSearchPaths, pickInterpreters, standaloneMain } from "../lib/sdk.ts";

export const summary = "Run resources in the standalone host (simulated or real time)";

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help", "realtime", "quiet"], repeatable: ["search"] });
  if (a.bools.has("help") || a.positional.length === 0) {
    console.log(`scriptgo run <resourceDir>... [--lua lua54|lua51|luajit|<path>] [--search dir]...
    [--config file.json] [--data dir] [--script steps.txt] [--for ms] [--realtime] [--log level]

Without --script or --for, steps are read from the terminal (cmd 1 /help, console <cmd>, wait <ms>, quit).`);
    return a.bools.has("help") ? 0 : 2;
  }
  const [lua] = pickInterpreters(a.flags.lua ?? "luajit");
  const argv = [standaloneMain, "run", ...a.positional.map((p) => resolve(p))];
  for (const s of [...a.multi.search!, ...defaultSearchPaths()]) argv.push("--search", resolve(s));
  for (const key of ["config", "data", "script", "for", "log"]) {
    if (a.flags[key] !== undefined) argv.push(`--${key}`, key === "for" || key === "log" ? a.flags[key]! : resolve(a.flags[key]!));
  }
  for (const b of ["realtime", "quiet"]) if (a.bools.has(b)) argv.push(`--${b}`);
  const r = spawnSync(lua!.path, argv, { stdio: "inherit" });
  return r.status ?? 1;
}
