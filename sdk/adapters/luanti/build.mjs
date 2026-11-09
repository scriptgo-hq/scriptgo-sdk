// Builds the distributable Luanti mod: dist/luanti/scriptgo/ = the mod sources + the SCRIPT//GO
// core (sdk/lua/scriptgo) in core/, ready to drop into a server's mods/ folder.
//
//   node sdk/adapters/luanti/build.mjs [--out <dir>] [--with <resourceDir>]...
//
// --with bundles resources into the mod's resources/ folder (server owners can also put them in
// <world>/scriptgo/resources/ instead).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");

export function buildMod(outDir, withResources = []) {
  const dest = resolve(outDir);
  if (existsSync(dest)) rmSync(dest, { recursive: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(here, "mod"), dest, { recursive: true });
  const coreSrc = join(repo, "sdk", "lua", "scriptgo");
  mkdirSync(join(dest, "core"), { recursive: true });
  for (const f of readdirSync(coreSrc)) {
    if (f.endsWith(".lua")) cpSync(join(coreSrc, f), join(dest, "core", f));
  }
  for (const r of withResources) {
    cpSync(resolve(r), join(dest, "resources", basename(resolve(r))), {
      recursive: true,
      filter: (src) => !/[\\/](tests|node_modules|\.[^\\/]+)$/.test(src),
    });
  }
  return dest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let out = join(repo, "dist", "luanti", "scriptgo");
  const withRes = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else if (args[i] === "--with") withRes.push(args[++i]);
  }
  console.log(`built ${buildMod(out, withRes)}`);
}
