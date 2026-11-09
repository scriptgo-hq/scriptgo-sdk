// Runs one resource on the cc-core harness: CC: Tweaked's own core classes, Lua VM (Cobalt), BIOS and
// ROM from the pinned mod jar, WITHOUT Minecraft. It is an emulator for fast tests of the adapter.
// Its result is never a compatibility report: nothing is written to verification/reports, and the
// output says "cc-core harness (emulator, no Minecraft)". Only `scriptgo verify --env cctweaked`, on
// a real Minecraft server, can verify the environment.
//
//   node sdk/adapters/cctweaked/harness/run.mjs <resourceDir> [--with <resourceDir>]
//        [--search <dir>]... [--seconds 3] [--json]
//
// Needs the harness: node sdk/adapters/cctweaked/runtime.mjs --harness. Dependencies are found by
// folder name in --search and in sdk/packages and examples/packages. --with adds one more resource
// started after the first (as a README example is).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVerifyComputer } from "../build.mjs";
import { ccTweakedJar, findJava, harnessClasspath, repoRoot } from "../runtime.mjs";

export const LABEL = "cc-core harness (emulator, no Minecraft)";

/** The `name` and dependency names of a manifest (scriptgo.lua), read with patterns. */
export function manifestInfo(text) {
  const name = /^\s*resource\s+"([^"]+)"/m.exec(text)?.[1] ?? null;
  const deps = [];
  for (const m of text.matchAll(/^\s*dependency\s+"([^"\s]+)[^"]*"/gm)) deps.push(m[1]);
  for (const m of text.matchAll(/^\s*dependencies\s*\{([^}]*)\}/gm)) {
    for (const d of m[1].matchAll(/"([^"\s]+)[^"]*"/g)) deps.push(d[1]);
  }
  return { name, deps };
}

function readManifest(dir) {
  for (const f of ["scriptgo.lua", "open77.lua"]) {
    const p = join(dir, f);
    if (existsSync(p)) return manifestInfo(readFileSync(p, "utf8"));
  }
  return null;
}

/** The resource and the resources it depends on, as [{ name, dir }], plus names not found. */
export function resolveResources(dir, search) {
  const out = [];
  const missing = [];
  const seen = new Set();
  const visit = (d) => {
    const info = readManifest(d);
    if (!info) return;
    const name = info.name ?? basename(d);
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, dir: d });
    for (const dep of info.deps) {
      if (seen.has(dep)) continue;
      const found = search.map((s) => join(s, dep)).find((p) => readManifest(p));
      if (found) visit(found);
      else missing.push(dep);
    }
  };
  visit(resolve(dir));
  return { resources: out, missing };
}

/** Runs the harness on `dir`; returns { report, terminal, exit } (report null when none was written). */
export function runHarness(dir, { search = [], withDir = null, seconds = 3 } = {}) {
  const cp = harnessClasspath();
  const java = findJava();
  if (!cp || !java) throw new Error("the cc-core harness is not set up: node sdk/adapters/cctweaked/runtime.mjs --harness");
  const paths = [...search.map((s) => resolve(s)), join(repoRoot, "sdk", "packages"), join(repoRoot, "sdk", "conformance"), join(repoRoot, "examples", "packages")];
  const { resources, missing } = resolveResources(dir, paths);
  if (resources.length === 0) throw new Error(`no manifest in ${dir}`);
  if (missing.length > 0) throw new Error(`dependencies not found: ${missing.join(", ")}`);
  let withName = null;
  if (withDir) {
    const extra = resolveResources(withDir, [...paths, dirname(resolve(dir))]);
    for (const r of extra.resources) if (!resources.some((x) => x.name === r.name)) resources.push(r);
    withName = extra.resources[0]?.name ?? null;
  }
  const tmp = mkdtempSync(join(tmpdir(), "scriptgo-cccore-"));
  try {
    const computer = buildVerifyComputer(join(tmp, "computer"), { resources, resource: resources[0].name, seconds, withResource: withName });
    const r = spawnSync(java, ["-cp", cp, "CcCoreRun", "--jar", ccTweakedJar(), "--computer", computer.dir, "--seconds", String(seconds + 60), "--id", "0"], {
      encoding: "utf8",
      timeout: (seconds + 90) * 1000,
    });
    const terminal = (r.stdout ?? "").split(/\r?\n/).filter((l) => l.startsWith("CCTERM ")).map((l) => l.slice(7)).filter(Boolean);
    const exit = /CCCORE .* exit=(\S+) ticks=(\d+)/.exec(r.stdout ?? "");
    let report = null;
    if (existsSync(computer.report)) report = JSON.parse(readFileSync(computer.report, "utf8"));
    return { report, terminal, exit: exit ? { state: exit[1], ticks: Number(exit[2]) } : null, stderr: (r.stderr ?? "").trim(), bytes: computer.bytes };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let dir = null;
  let withDir = null;
  let seconds = 3;
  let json = false;
  const search = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--with") withDir = args[++i];
    else if (args[i] === "--search") search.push(args[++i]);
    else if (args[i] === "--seconds") seconds = Number(args[++i]);
    else if (args[i] === "--json") json = true;
    else if (!dir) dir = args[i];
  }
  if (!dir) {
    console.error("usage: node sdk/adapters/cctweaked/harness/run.mjs <resourceDir> [--with <dir>] [--search <dir>]... [--seconds 3] [--json]");
    process.exit(2);
  }
  try {
    const run = runHarness(dir, { search, withDir, seconds });
    if (json) {
      console.log(JSON.stringify({ label: LABEL, ...run }, null, 2));
    } else if (!run.report) {
      console.log(`${LABEL}: no report written`);
      for (const l of run.terminal) console.log(`  | ${l}`);
      if (run.stderr) console.log(run.stderr.split(/\r?\n/).slice(-20).join("\n"));
    } else {
      const r = run.report;
      const failed = r.checks.filter((c) => c.status === "failed");
      console.log(`${LABEL}: ${r.package} ${r.version} ${r.status === "verified" ? "passed" : "failed"} (${r.checks.length} checks, ${failed.length} failed)`);
      console.log(`  ${r.runtimeVersion}, ${r.luaVersion}; ${run.bytes} bytes on the computer`);
      for (const c of r.checks) console.log(`  ${c.status === "passed" ? "ok  " : c.status === "skipped" ? "skip" : "FAIL"} ${c.name}${c.message ? `  ${c.message}` : ""}`);
      console.log("  (emulator run: not a compatibility report, nothing written to verification/reports)");
    }
    process.exit(run.report && run.report.status === "verified" ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
