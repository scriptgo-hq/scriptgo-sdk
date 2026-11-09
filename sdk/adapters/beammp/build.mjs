// Builds the distributable BeamMP plugin: <out>/ = main.lua (the only top-level .lua file, so the
// only one BeamMP runs), lib/adapter.lua and the SCRIPT//GO core (sdk/lua/scriptgo) in core/. Copy
// the folder to the server as Resources/Server/scriptgo/.
//
//   node sdk/adapters/beammp/build.mjs [--out <dir>] [--with <resourceDir>]...
//
// --with bundles resources into the plugin's resources/ folder.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");

/**
 * Writes the plugin into `outDir`. `config`, when given, is written as the plugin's scriptgo.json.
 * With `merge`, an existing plugin keeps its other resources, its scriptgo.json and its data/:
 * only the plugin code and the resources given here are replaced. Otherwise `outDir` is replaced.
 */
export function buildPlugin(outDir, withResources = [], config, { merge = false } = {}) {
  const dest = resolve(outDir);
  if (existsSync(dest) && !merge) rmSync(dest, { recursive: true });
  for (const d of ["lib", "core"]) if (existsSync(join(dest, d))) rmSync(join(dest, d), { recursive: true });
  for (const r of withResources) {
    const target = join(dest, "resources", basename(resolve(r)));
    if (existsSync(target)) rmSync(target, { recursive: true });
  }
  mkdirSync(join(dest, "lib"), { recursive: true });
  mkdirSync(join(dest, "core"), { recursive: true });
  mkdirSync(join(dest, "resources"), { recursive: true });
  cpSync(join(here, "plugin", "main.lua"), join(dest, "main.lua"));
  cpSync(join(here, "plugin", "lib", "adapter.lua"), join(dest, "lib", "adapter.lua"));
  const coreSrc = join(repo, "sdk", "lua", "scriptgo");
  for (const f of readdirSync(coreSrc)) {
    if (f.endsWith(".lua")) cpSync(join(coreSrc, f), join(dest, "core", f));
  }
  for (const r of withResources) {
    cpSync(resolve(r), join(dest, "resources", basename(resolve(r))), {
      recursive: true,
      filter: (src) => !/[\\/](tests|node_modules|\.[^\\/]+)$/.test(src),
    });
  }
  if (config) writeFileSync(join(dest, "scriptgo.json"), JSON.stringify(config, null, 2) + "\n");
  return dest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let out = join(repo, "dist", "beammp", "Resources", "Server", "scriptgo");
  const withRes = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else if (args[i] === "--with") withRes.push(args[++i]);
    else {
      console.error(`unknown argument ${args[i]}; usage: build.mjs [--out <dir>] [--with <resource>]...`);
      process.exit(2);
    }
  }
  console.log(`built ${buildPlugin(out, withRes)}`);
}
