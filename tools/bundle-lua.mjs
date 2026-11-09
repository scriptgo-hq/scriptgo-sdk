// Bundles the SCRIPT//GO Lua core into one file: dist/lua/scriptgo.lua (gitignored build output).
//
//   node tools/bundle-lua.mjs [--out <file>]
//   local scriptgo = dofile("scriptgo.lua")      -- or require("scriptgo") with the file on package.path
//
// Every module becomes a preload function; init.lua then loads them through the same `R` require
// it uses from source, so the bundle behaves exactly like sdk/lua/scriptgo/.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "sdk", "lua", "scriptgo");

export function bundle() {
  const modules = readdirSync(src).filter((f) => f.endsWith(".lua") && f !== "init.lua").sort();
  const version = /VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(join(src, "host.lua"), "utf8"))?.[1] ?? "dev";
  const parts = [
    `-- SCRIPT//GO Lua core ${version}, bundled from sdk/lua/scriptgo by tools/bundle-lua.mjs. MIT.`,
    "-- Works on Lua 5.1, 5.4 and LuaJIT: local scriptgo = dofile(\"scriptgo.lua\")",
    "local preload = {}",
  ];
  for (const f of modules) {
    const name = f.slice(0, -4);
    parts.push(`preload[${JSON.stringify(name)}] = function(...)\n${readFileSync(join(src, f), "utf8").trimEnd()}\nend`);
  }
  parts.push(`return (function(...)\n${readFileSync(join(src, "init.lua"), "utf8").trimEnd()}\nend)(nil, nil, preload)`);
  return parts.join("\n\n") + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const out = i > 0 ? resolve(process.argv[i + 1]) : join(root, "dist", "lua", "scriptgo.lua");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bundle());
  console.log(`wrote ${out}`);
}
