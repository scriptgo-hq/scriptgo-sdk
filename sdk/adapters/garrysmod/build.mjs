// Builds the Garry's Mod addon: dist/garrysmod/scriptgo/ = the addon sources + the SCRIPT//GO core
// (sdk/lua/scriptgo) in lua/scriptgo/core/, ready to drop into a server's garrysmod/addons/ folder.
//
//   node sdk/adapters/garrysmod/build.mjs [--out <dir>] [--with <resourceDir>]...
//
// --with bundles resources into the addon's lua/scriptgo/resources/ folder (server owners can also
// install each resource as its own addon with `scriptgo pack --target garrysmod`, or put it in
// garrysmod/data/scriptgo/resources/).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");

export function buildAddon(outDir, withResources = []) {
  const dest = resolve(outDir);
  if (existsSync(dest)) rmSync(dest, { recursive: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(here, "addon"), dest, { recursive: true });
  const coreSrc = join(repo, "sdk", "lua", "scriptgo");
  const coreDest = join(dest, "lua", "scriptgo", "core");
  mkdirSync(coreDest, { recursive: true });
  for (const f of readdirSync(coreSrc)) {
    if (f.endsWith(".lua")) cpSync(join(coreSrc, f), join(coreDest, f));
  }
  for (const r of withResources) {
    cpSync(resolve(r), join(dest, "lua", "scriptgo", "resources", basename(resolve(r))), {
      recursive: true,
      filter: (src) => !/[\/](tests|node_modules|\.[^\/]+)$/.test(src),
    });
  }
  return dest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let out = join(repo, "dist", "garrysmod", "scriptgo");
  const withRes = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else if (args[i] === "--with") withRes.push(args[++i]);
  }
  console.log(`built ${buildAddon(out, withRes)}`);
}
