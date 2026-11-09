#!/usr/bin/env node
// Runs the Lua SDK specs on every interpreter found in tools/runtimes/bin (built by
// tools/build-lua.ps1) or given with --lua <path>. Exit code 0 only when every interpreter passes.
//
//   node tools/lua-test.mjs                 # all interpreters
//   node tools/lua-test.mjs --only lua51    # one interpreter
//   node tools/lua-test.mjs --json out.json # machine-readable summary
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const exe = process.platform === "win32" ? ".exe" : "";
const binDir = join(root, "tools", "runtimes", "bin");
let interpreters = ["lua54", "lua51", "luajit"]
  .map((name) => ({ name, path: join(binDir, name + exe) }))
  .filter((i) => existsSync(i.path));
if (opt("--lua")) interpreters = [{ name: "custom", path: opt("--lua") }];
if (opt("--only")) interpreters = interpreters.filter((i) => i.name === opt("--only"));
if (interpreters.length === 0) {
  console.error("No Lua interpreter found. Build them with: pwsh -File tools/build-lua.ps1");
  process.exit(2);
}

const specDir = join(root, "sdk", "lua", "spec");
const specs = readdirSync(specDir)
  .filter((f) => f.endsWith("_spec.lua"))
  .sort()
  .map((f) => join(specDir, f));
// Resources with test_script files: official packages, the conformance probe and examples.
const packageDirs = [join(root, "sdk", "packages"), join(root, "sdk", "conformance"), join(root, "examples", "packages")];
const packages = [];
for (const dir of packageDirs) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir).sort()) {
    if (existsSync(join(dir, name, "scriptgo.lua"))) packages.push(join(dir, name));
  }
}
const searchArgs = packageDirs.filter((d) => existsSync(d)).flatMap((d) => ["--search", d]);

const fixtures = readdirSync(join(specDir, "fixtures", "manifests"))
  .filter((f) => f.endsWith(".lua"))
  .map((f) => f.slice(0, -4))
  .sort()
  .join(",");

const summary = [];
let failed = false;
for (const lua of interpreters) {
  const started = Date.now();
  const r = spawnSync(lua.path, [join(specDir, "run.lua"), root, fixtures, ...specs], {
    cwd: root,
    encoding: "utf8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  console.log(`\n=== ${lua.name} (${lua.path})`);
  process.stdout.write(out);
  const last = out.trim().split("\n").pop() || "";
  const m = last.match(/^(.*): (\d+) tests, (\d+) failed$/);
  const entry = {
    interpreter: lua.name,
    version: m ? m[1] : "unknown",
    tests: m ? Number(m[2]) : 0,
    failed: m ? Number(m[3]) : -1,
    exitCode: r.status,
    durationMs: Date.now() - started,
  };
  if (r.status !== 0) failed = true;

  // Resource test_script files of every official package and example, through the standalone host.
  for (const pkg of packages) {
    const t = spawnSync(lua.path, [join(root, "sdk", "adapters", "standalone", "main.lua"), "test", pkg, ...searchArgs], {
      cwd: root,
      encoding: "utf8",
    });
    const text = (t.stdout || "") + (t.stderr || "");
    const line = text.trim().split(/\r?\n/).pop() || "";
    const pm = line.match(/^(\S+): (\d+) passed, (\d+) failed/);
    console.log(`  ${line}`);
    if (t.status !== 0) {
      failed = true;
      process.stdout.write(text.split(/\r?\n/).filter((l) => /FAIL|error|^\s{7}/.test(l)).join("\n") + "\n");
    }
    if (pm) {
      entry.tests += Number(pm[2]) + Number(pm[3]);
      entry.failed += Number(pm[3]);
    } else {
      entry.failed += 1;
    }
  }
  summary.push(entry);
}

console.log("\nSummary:");
for (const s of summary) {
  console.log(`  ${s.interpreter.padEnd(7)} ${s.version.padEnd(14)} ${s.tests} tests, ${s.failed} failed (${s.durationMs} ms)`);
}
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify({ ranAt: new Date().toISOString(), runs: summary }, null, 2));
process.exit(failed ? 1 : 0);
