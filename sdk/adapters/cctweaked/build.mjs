// Builds the files of one CC: Tweaked computer: dist/cctweaked/computer/ = the program
// (scriptgo/sg.lua), the adapter, the SCRIPT//GO core (scriptgo/core/) and, with --with, resources.
// Copy the folder's contents onto a computer: into <world>/computercraft/computer/<id>/ on the
// server, or onto a floppy disk.
//
//   node sdk/adapters/cctweaked/build.mjs [--out <dir>] [--with <resourceDir>]... [--startup]
//
// --startup adds /startup.lua, so the computer starts SCRIPT//GO whenever it boots.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");

/** The default computer_space_limit of a CC: Tweaked server, in bytes. */
export const COMPUTER_SPACE = 1_000_000;

export const STARTUP = 'shell.run("/scriptgo/sg.lua")\n';

function sizeOf(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? sizeOf(p) : statSync(p).size;
  }
  return total;
}

/**
 * Writes the computer's files into `outDir` (emptied first) and returns `{ dir, bytes }`.
 * resources: folders copied to scriptgo/resources/<folder name>; tests are left out unless
 * `withTests` (verify runs keep them: the report runs the test_script files).
 * startup: the text of /startup.lua, or null for none.
 */
export function buildComputer(outDir, { resources = [], withTests = false, startup = null } = {}) {
  const dest = resolve(outDir);
  if (existsSync(dest)) rmSync(dest, { recursive: true });
  const sg = join(dest, "scriptgo");
  mkdirSync(join(sg, "core"), { recursive: true });
  cpSync(join(here, "computer", "scriptgo"), sg, { recursive: true });
  const coreSrc = join(repo, "sdk", "lua", "scriptgo");
  for (const f of readdirSync(coreSrc)) {
    if (f.endsWith(".lua")) cpSync(join(coreSrc, f), join(sg, "core", f));
  }
  mkdirSync(join(sg, "resources"), { recursive: true });
  for (const r of resources) {
    cpSync(resolve(r), join(sg, "resources", basename(resolve(r))), {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|\.[^\\/]+)$/.test(src) && (withTests || !/[\\/]tests$/.test(src)),
    });
  }
  if (startup) writeFileSync(join(dest, "startup.lua"), startup);
  return { dir: dest, bytes: sizeOf(dest) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let out = join(repo, "dist", "cctweaked", "computer");
  const withRes = [];
  let startup = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else if (args[i] === "--with") withRes.push(args[++i]);
    else if (args[i] === "--startup") startup = STARTUP;
  }
  const { dir, bytes } = buildComputer(out, { resources: withRes, startup });
  console.log(`built ${dir} (${bytes} bytes)`);
  if (bytes > COMPUTER_SPACE * 0.9) {
    console.log(`warning: ${bytes} bytes is close to or over the default computer_space_limit (${COMPUTER_SPACE}); raise it in computercraft-server.toml`);
  }
}
