// scriptgo verify <dir>: machine-checkable compatibility evidence, one JSON report per run.
//
//   standalone  every available Lua dialect: the host's own verify (manifest, start, exports,
//               runtime errors) plus the resource's test_script files.
//   open77      packs the resource and its dependencies for OPEN//77, starts a real OPEN//77
//               dedicated server on loopback with only those resources, and reads its log: every
//               resource must start and none may log an error. Needs the server binary
//               (--open77-server or OP77_SERVER_EXE); without it the run is reported as skipped,
//               never as verified. Only the server half runs: no game client is started.
//   luanti      builds the Luanti mod into a throwaway game and runs the official Luanti server
//               image (Docker, no network) in the mod's verify mode; the mod writes the report.
//               Without Docker or the image the run is skipped.
//   love2d      runs LÖVE (lovec) headless on examples/love2d/demo in its verify mode, ticked by
//               real love.update frames. Needs --love, SCRIPTGO_LOVE or tools/runtimes/love.
//   godot       runs Godot headless on examples/godot/demo (lua-gdextension) in its verify mode,
//               ticked by real frames. Needs --godot, SCRIPTGO_GODOT or tools/runtimes/godot.
//   neovim      runs `nvim --headless --clean -l sdk/adapters/neovim/verify.lua`: the plugin's libuv
//               timer ticks the host on Neovim's main loop. Needs --nvim, SCRIPTGO_NVIM or
//               tools/runtimes/neovim. HTTP and licensing through curl, so --stub-api applies.
//   cctweaked   starts a real Minecraft: Java Edition server (Fabric + CC: Tweaked, pinned by
//               sdk/adapters/cctweaked/runtime.mjs) on 127.0.0.1 with a throwaway flat world, places
//               a ComputerCraft computer whose disk holds the core, the adapter and the resources,
//               and reads the report the computer writes (lib/cctweaked.ts). Skipped until the
//               operator accepts the Minecraft EULA themselves: --accept-minecraft-eula writes
//               eula=true into the runtime's server/eula.txt (never a tracked file); nothing else
//               writes it. --stub-api does not apply: licensing is not offered on Minecraft.
//   dotnet      the console host of the .NET kit (sdk/dotnet/ScriptGo.Host.Standalone): Lua guests on
//               KeraLua, JavaScript guests on Jint. The resource and its dependencies are copied to a
//               temporary folder where every TypeScript entry is compiled (lib/typescript.ts), then
//               the host verifies the copy. Needs the .NET 10 SDK (--dotnet, SCRIPTGO_DOTNET or the
//               default install); the host is built on first use.
//   hytale      runs the owner's Hytale dedicated server on loopback with the plugin in verify
//               mode (commands/verify-hytale.ts). Skipped without the server files and a Java 25.
//   rust        a Rust dedicated server with Oxide or Carbon runs the plugin's verify mode on loopback
//               (commands/verify-rust.ts). Needs --rust-server or SCRIPTGO_RUST_SERVER; else skipped.
//   beammp      starts a real BeamMP-Server on loopback with the SCRIPT//GO plugin in verify mode
//               (lib/beammp.ts). Needs the server (--beammp-server, SCRIPTGO_BEAMMP_SERVER or
//               tools/runtimes/beammp) and the owner's AuthKey in BEAMMP_AUTH_KEY; else skipped.
//
// --lang lua|ts|js names the guest language the run is evidence for (default: the resource's own,
// ts when it has TypeScript scripts). Reports are tagged per language on the dotnet environment
// (`dotnet-lua`, `dotnet-ts`); the other environments run Lua only and skip any other language.
//
// Everywhere, lines a resource prints as `SGCHECK PASS|FAIL <name>` become checks of the report.
//
// README example: when the package's README.md has a fenced block marked `lua runnable`, every run
// also starts it as a resource `<package>_readme` that depends on the package (lib/readme-example.ts).
// Its output is part of the run's log and the check `readme_example` says whether it started; its
// errors count in `no_runtime_errors`. --no-readme-example leaves it out.
//
// --stub-api starts a loopback stand-in for the licensing API (lib/stub-api.ts) that validates
// every request with the API's own schemas, and hands the resource its URL and a valid license key:
// config `api` and `license_key` of the resource, global `scriptgo_api`. On OPEN//77 the server's
// outbound HTTP is switched on with the stub's host as the only allowed host. The report then
// carries api:* checks: every request matched the schema, named the right environment and adapter.
// --api <url> --license-key <key> does the same against a real SCRIPT//GO API (no api:* checks:
// only the stub sees the requests).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error plain ESM build script without type declarations
import { buildMod } from "../../../../sdk/adapters/luanti/build.mjs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ParsedManifest } from "@scriptgo/manifest";
import { CompatibilityRunSchema, type CompatibilityRun } from "@scriptgo/shared";
import { parseArgs } from "../lib/args.ts";
import { defaultSearchPaths, findManifestFile, listFiles, pickInterpreters, readResource, repoRoot, standaloneMain, type LoadedResource } from "../lib/sdk.ts";
import { writeReadmeExample, type ReadmeExample } from "../lib/readme-example.ts";
import { startStubApi, type StubRequest } from "../lib/stub-api.ts";
import { acceptMinecraftEula, verifyCcTweaked } from "../lib/cctweaked.ts";
import { findDotnet, ensureDotnetHost } from "../lib/dotnet.ts";
import { compileTypeScript, ESBUILD_VERSION } from "../lib/typescript.ts";
import { packForOpen77 } from "./pack.ts";
import { verifyGarrysmod } from "./verify-garrysmod.ts";
import { HYTALE_HELP, verifyHytale } from "./verify-hytale.ts";
import { verifyRust } from "./verify-rust.ts";
import { BEAMMP_PORT, findBeamMPServer, verifyBeamMP } from "../lib/beammp.ts";
import { fivemOptions, verifyFivem } from "../lib/fivem-verify.ts";

export const summary = "Run a resource on its environments and write compatibility reports";

export interface Check {
  name: string;
  status: "passed" | "failed" | "skipped";
  message: string;
}

export interface Report {
  package: string;
  version: string;
  environment: string;
  status: "verified" | "failing" | "skipped";
  runtimeVersion: string;
  adapterVersion: string;
  luaVersion: string;
  durationMs: number;
  checks: Check[];
  log: string;
  evidence: Record<string, unknown>;
}

const SDK_VERSION = "0.1.0";

/** The licensing API a run talks to: the loopback stub, or a real API given with --api. */
interface ApiTarget {
  url: string;
  licenseKey: string;
  /** Requests the stub saw; always empty for a real API. */
  requests: StubRequest[];
  label: string;
}

/** The adapter version the OPEN//77 shim reports at runtime (and sends to the licensing API). */
export function open77ShimVersion(): string {
  const text = readFileSync(join(repoRoot, "sdk", "adapters", "open77", "shim.lua"), "utf8");
  return /adapterVersion = function\(\) return "([^"]+)"/.exec(text)?.[1] ?? `open77-shim-${SDK_VERSION}`;
}

/** Package references the stub accepts: the resource name and "author//name-with-dashes". */
function stubPackages(m: ParsedManifest): string[] {
  const refs = [m.name];
  if (m.author) refs.push(`${m.author}//${m.name.replace(/_/g, "-")}`);
  return refs;
}

/**
 * Checks on the requests a run made to the stub API (from index `from`): each body matched the
 * API schema, and named this run's environment and adapter. Nothing is checked when the resource
 * made no request (most packages never call the API).
 */
export function apiChecks(requests: StubRequest[], from: number, environment: string, adapterVersion: string): Check[] {
  const mine = requests.slice(from).filter((r) => r.path.startsWith("/v1/licenses/"));
  if (mine.length === 0) return [];
  const bad = mine.find((r) => r.bodyError !== null);
  const wrongEnv = mine.find((r) => r.bodyError === null && r.environment !== environment);
  const wrongAdapter = mine.find((r) => r.bodyError === null && r.adapterVersion !== adapterVersion);
  return [
    { name: "api:bodies_valid", status: bad ? "failed" : "passed", message: bad ? `${bad.path}: ${bad.bodyError}` : `${mine.length} licensing requests` },
    { name: "api:environment", status: wrongEnv ? "failed" : "passed", message: wrongEnv ? `sent '${wrongEnv.environment}'` : environment },
    { name: "api:adapter_version", status: wrongAdapter ? "failed" : "passed", message: wrongAdapter ? `sent '${wrongAdapter.adapterVersion}'` : adapterVersion },
  ];
}

/**
 * Self-checks a resource prints on any host: `SGCHECK PASS <name>`, `SGCHECK FAIL <name> <detail>`
 * and, once finished, `SGCHECK DONE ...`. Started checks that never finish count as a failure.
 */
export function selfChecks(log: string): Check[] {
  const out: Check[] = [];
  let done = false;
  for (const line of log.split(/\r?\n/)) {
    const m = /SGCHECK (PASS|FAIL) (\S+)(?: (.*))?$/.exec(line);
    if (m) out.push({ name: `self:${m[2]}`, status: m[1] === "PASS" ? "passed" : "failed", message: (m[3] ?? "").trim() });
    if (/SGCHECK DONE/.test(line)) done = true;
  }
  if (out.length > 0 && !done) out.push({ name: "self:done", status: "failed", message: "SGCHECK DONE never printed: the self-checks did not finish" });
  return out;
}

/**
 * The file written to verification/reports: the registry's CompatibilityRun (packages/shared),
 * which the API seed and the ingestion endpoint accept. Internal metadata becomes `evidence`
 * entries; a skipped run has no file (the registry only knows verified and failing runs).
 */
export function toCompatibilityRun(r: Report, tag: string, ranAt: string): CompatibilityRun {
  const evidence = Object.entries(r.evidence)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([kind, v]) => ({ kind, path: Array.isArray(v) ? v.join(",") : String(v) }));
  const run = {
    runId: `${r.package}@${r.version}:${tag}:${ranAt}`,
    package: r.package, version: r.version, environment: r.environment,
    status: r.status, runtimeVersion: r.runtimeVersion || null, adapterVersion: r.adapterVersion || null,
    luaVersion: r.luaVersion || null, ranAt, durationMs: Math.max(0, Math.round(r.durationMs)), log: r.log,
    checks: r.checks.map((c) => ({ name: c.name, status: c.status, message: c.message })), evidence,
  };
  return CompatibilityRunSchema.parse(run);
}

function statusOf(checks: Check[]): Report["status"] {
  if (checks.some((c) => c.status === "failed")) return "failing";
  if (checks.length > 0 && checks.every((c) => c.status === "skipped")) return "skipped";
  return "verified";
}

/** "OPEN//77 server <product version>" from the binary's version resource (Windows), else "". */
function open77ServerVersion(server: string): string {
  if (process.platform !== "win32") return "";
  const dll = server.replace(/\.exe$/i, ".dll");
  const target = existsSync(dll) ? dll : server;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${target.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { encoding: "utf8" });
  const v = (r.stdout ?? "").trim().split(/\r?\n/)[0] ?? "";
  // Keep the version and a short commit: "1.0.0+5282e21ca8..." -> "1.0.0+5282e21c".
  const short = v.replace(/\+([0-9a-f]{8})[0-9a-f]+$/, "+$1");
  return short ? `OPEN//77 server ${short}`.slice(0, 128) : "";
}

/** Finds a resource folder by name in the search paths (folder name = resource name). */
function findResource(name: string, search: string[]): string | null {
  for (const dir of search) {
    const p = join(dir, name);
    if (existsSync(p) && findManifestFile(p)) return p;
  }
  return null;
}

/** The resource and its dependency closure, dependencies first. */
export function closure(root: LoadedResource, search: string[]): { order: LoadedResource[]; missing: string[] } {
  const order: LoadedResource[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const visit = (res: LoadedResource): void => {
    if (!res.result.ok) return;
    const m = res.result.manifest;
    if (seen.has(m.name)) return;
    seen.add(m.name);
    for (const dep of m.dependencies) {
      if (seen.has(dep.name)) continue;
      const dir = findResource(dep.name, search);
      if (!dir) missing.push(dep.name);
      else visit(readResource(dir));
    }
    order.push(res);
  };
  visit(root);
  return { order, missing };
}

/**
 * Resources a package's tests load next to it (`load({ with = { "sg_permissions" } })`), found in
 * the search paths, with their own dependencies. Hosts that read the search paths at test time
 * find them by themselves; a host with its own sandboxed disk (a CC: Tweaked computer) needs them
 * copied in. Any quoted name in a test script that is also a resource folder counts.
 */
function testCompanions(res: LoadedResource, search: string[], have: Set<string>): LoadedResource[] {
  if (!res.result.ok) return [];
  const out: LoadedResource[] = [];
  for (const rel of res.result.manifest.testScripts) {
    const file = join(res.root, rel);
    if (!existsSync(file)) continue;
    for (const [, name] of readFileSync(file, "utf8").matchAll(/["']([A-Za-z0-9_-]{2,64})["']/g)) {
      if (!name || have.has(name)) continue;
      const dir = findResource(name, search);
      if (!dir) continue;
      for (const r of closure(readResource(dir), search).order) {
        if (!r.result.ok || have.has(r.result.manifest.name)) continue;
        have.add(r.result.manifest.name);
        out.push(r);
      }
    }
  }
  return out;
}

/**
 * spawnSync without blocking the event loop: the stub API lives in this process and must keep
 * answering while the Lua host runs.
 */
function spawnAsync(cmd: string, argv: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", (e) => done({ status: null, stdout, stderr: stderr + String(e) }));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

async function verifyStandalone(
  dir: string, m: ParsedManifest, lua: { name: string; path: string }, search: string[], stub?: ApiTarget, example?: ReadmeExample | null,
): Promise<Report> {
  const started = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), "scriptgo-verify-"));
  const reportFile = join(tmp, "report.json");
  const argv = [standaloneMain, "verify", dir, "--report", reportFile, "--settle", "2000"];
  for (const s of search) argv.push("--search", s);
  if (example) argv.push("--with", example.dir);
  const firstRequest = stub?.requests.length ?? 0;
  if (stub) {
    const config = join(tmp, "config.json");
    writeFileSync(config, JSON.stringify({
      resources: { [m.name]: { api: stub.url, license_key: stub.licenseKey } },
      convars: { scriptgo_api: stub.url },
    }));
    argv.push("--config", config);
  }
  const v = await spawnAsync(lua.path, argv);
  let report: Report;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8")) as Report;
  } catch {
    report = {
      package: m.name, version: m.version, environment: "standalone", status: "failing", runtimeVersion: "",
      adapterVersion: SDK_VERSION, luaVersion: lua.name, durationMs: 0, log: (v.stdout ?? "") + (v.stderr ?? ""),
      checks: [{ name: "host_verify", status: "failed", message: `exit ${v.status}` }], evidence: {},
    };
  }
  report.checks.push(...selfChecks(report.log));
  if (stub) report.checks.push(...apiChecks(stub.requests, firstRequest, "standalone", report.adapterVersion));
  if (m.testScripts.length > 0) {
    const targv = [standaloneMain, "test", dir];
    for (const s of search) targv.push("--search", s);
    const t = await spawnAsync(lua.path, targv);
    const summaryLine = (t.stdout ?? "").split(/\r?\n/).filter((l) => /passed, \d+ failed/.test(l)).pop() ?? `exit ${t.status}`;
    report.checks.push({ name: "tests", status: t.status === 0 ? "passed" : "failed", message: summaryLine.trim() });
    report.log = [report.log, (t.stdout ?? "").trim()].filter(Boolean).join("\n");
  } else {
    report.checks.push({ name: "tests", status: "skipped", message: "no test_script" });
  }
  rmSync(tmp, { recursive: true, force: true });
  report.environment = "standalone";
  report.evidence = { ...report.evidence, interpreter: lua.name, ...(stub ? { api: stub.label } : {}), ...exampleEvidence(example) };
  report.status = statusOf(report.checks);
  report.durationMs = Date.now() - started;
  return report;
}

function serverConfig(port: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    identity: { name: "SCRIPT//GO verify", description: "Loopback compatibility run", locale: "en-US", tags: ["development"], visibility: "private" },
    network: { port, publicEndpoint: `127.0.0.1:${port}`, maximumPlayers: 2 },
    simulation: { tickRate: 30, snapshotRate: 20, expectedGameBuild: 25000, helloTimeoutSeconds: 10 },
    warden: { enabled: false, listenUrl: `http://127.0.0.1:${port + 1}` },
    database: { enabled: false, connectionStringEnvironmentVariable: "OP77_DATABASE_CONNECTION", maxRows: 10000 },
    resources: {
      enabled: true, root: "resources", load: ["*"], autoStart: true, watchIntervalMilliseconds: 0,
      download: {
        enabled: false, listenUrl: `http://127.0.0.1:${port + 2}`, publicBaseUrl: `http://127.0.0.1:${port + 2}/`,
        cacheDirectory: "state/resource-cache", signingKeyFile: "state/resource-signing-key.json", chunkSizeBytes: 1048576,
      },
    },
    requiredMods: { enabled: false, unsecured: true, packages: [] },
    // Masterless and loopback-only: the server accepts no connection from another machine.
    masterServer: { enabled: false, devLocalAuth: true, requireConnectTicket: false },
    ...extra,
  }, null, 2);
}

async function verifyOpen77(
  res: LoadedResource,
  m: ParsedManifest,
  search: string[],
  opts: { server?: string; port: number; settleMs: number; timeoutMs: number; stub?: ApiTarget; example?: ReadmeExample | null },
): Promise<Report> {
  const started = Date.now();
  const checks: Check[] = [];
  // Packing alone proves nothing about the runtime: without a server run the report is skipped.
  const status = (): Report["status"] => {
    const s = statusOf(checks);
    return s === "verified" && !checks.some((c) => c.name === "server_run" && c.status === "passed") ? "skipped" : s;
  };
  let runtimeVersion = "";
  const report = (log: string, evidence: Record<string, unknown> = {}): Report => ({
    package: m.name, version: m.version, environment: "open77", status: status(), runtimeVersion,
    adapterVersion: open77ShimVersion(), luaVersion: "Lua 5.4", durationMs: Date.now() - started, checks, log, evidence,
  });
  checks.push({
    name: "environment_declared", status: m.environments.length === 0 || m.environments.includes("open77") ? "passed" : "failed",
    message: m.environments.join(", "),
  });

  const { order, missing } = closure(res, search);
  checks.push({ name: "dependencies_resolved", status: missing.length === 0 ? "passed" : "failed", message: missing.join(", ") });
  if (missing.length > 0) return report("");
  if (opts.example) order.push(readResource(opts.example.dir));

  const run = mkdtempSync(join(tmpdir(), "scriptgo-open77-"));
  const names: string[] = [];
  let packed = true;
  for (const r of order) {
    const p = packForOpen77(r, join(run, "resources"));
    const name = r.result.ok ? r.result.manifest.name : r.root;
    names.push(name);
    if (p.errors.length > 0) {
      packed = false;
      checks.push({ name: `packs:${name}`, status: "failed", message: p.errors.map((e) => e.code).join(", ") });
    } else {
      checks.push({ name: `packs:${name}`, status: "passed", message: p.warnings.join("; ") });
    }
  }
  const server = opts.server ?? process.env.OP77_SERVER_EXE;
  if (!packed || !server || !existsSync(server)) {
    if (packed) checks.push({ name: "server_run", status: "skipped", message: "no OPEN//77 server binary: pass --open77-server or set OP77_SERVER_EXE" });
    rmSync(run, { recursive: true, force: true });
    return report("");
  }

  mkdirSync(join(run, "state"), { recursive: true });
  const stub = opts.stub;
  const firstRequest = stub?.requests.length ?? 0;
  // With the stub: outbound HTTP on, the stub's host as the only reachable destination, and the
  // stub's URL and key as convars (ScriptGo.config reads "<resource>:<key>").
  const extra = stub
    ? {
        http: { enabled: true, allowedHosts: [new URL(stub.url).hostname], timeoutSeconds: 10 },
        convars: { scriptgo_api: stub.url, [`${m.name}:api`]: stub.url, [`${m.name}:license_key`]: stub.licenseKey },
      }
    : {};
  writeFileSync(join(run, "server.jsonc"), serverConfig(opts.port, extra));
  const lines: string[] = [];
  const startedNames = new Set<string>();
  const failedStarts = new Map<string, string>();
  let ready = false;
  const child = spawn(server, ["--config", join(run, "server.jsonc"), "--no-setup"], { cwd: run, stdio: ["ignore", "pipe", "pipe"] });
  const onData = (chunk: Buffer): void => {
    for (const raw of chunk.toString("utf8").split(/\r?\n/)) {
      if (!raw.trim()) continue;
      // Keep the report free of local paths (they carry the user name).
      const line = raw.split(run).join("<run>");
      lines.push(line);
      const st = /\[resource:([a-z0-9_]+)\] started generation=/.exec(line);
      if (st) startedNames.add(st[1]!);
      // A resource's error is tagged [resource:name], or names its chunk (@name/file.lua) when the
      // server's automatic start reports it: "Automatic resource start failed: Lua @name/...".
      const bad = /\[(?:ERR|FTL)\].*\[resource:([a-z0-9_]+)\]\s*(.*)$/.exec(line) ?? /\[(?:ERR|FTL)\].*?@([a-z0-9_]+)\/(.*)$/.exec(line);
      if (bad && !failedStarts.has(bad[1]!)) failedStarts.set(bad[1]!, bad[2]!);
      if (/resource host ready/.test(line)) ready = true;
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  let exitCode: number | null | undefined;
  void exited.then((c) => { exitCode = c; });

  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline && exitCode === undefined && !(ready && names.every((n) => startedNames.has(n) || failedStarts.has(n)))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  // Let timers and threads run: errors raised after start count too.
  if (exitCode === undefined) await new Promise((r) => setTimeout(r, opts.settleMs));
  if (exitCode === undefined) child.kill();
  await exited;

  checks.push({ name: "server_run", status: ready ? "passed" : "failed", message: ready ? "resource host ready" : `server exited (${exitCode}) or timed out before the resource host was ready` });
  for (const n of names) {
    if (opts.example && n === opts.example.name) continue;
    checks.push({ name: `starts:${n}`, status: startedNames.has(n) ? "passed" : "failed", message: failedStarts.get(n) ?? "" });
  }
  if (opts.example) {
    const n = opts.example.name;
    checks.push({ name: "readme_example", status: startedNames.has(n) ? "passed" : "failed", message: startedNames.has(n) ? `${n} started` : failedStarts.get(n) ?? "did not start" });
  }
  const errorLines = lines.filter((l) => /\[(?:ERR|FTL)\]/.test(l) && names.some((n) => l.includes(`[resource:${n}]`) || l.includes(`@${n}/`)));
  checks.push({ name: "no_runtime_errors", status: errorLines.length === 0 ? "passed" : "failed", message: errorLines[0] ?? "" });
  checks.push(...selfChecks(lines.join("\n")));
  if (stub) checks.push(...apiChecks(stub.requests, firstRequest, "open77", open77ShimVersion()));
  rmSync(run, { recursive: true, force: true });
  const log = lines.filter((l) => /\[resource:|resource host|ERR|FTL/.test(l)).join("\n");
  runtimeVersion = open77ServerVersion(server);
  // The license key and the stub's port are throwaway, but keep them out of the stored log anyway.
  const scrubbed = stub ? log.split(stub.licenseKey).join("<license_key>").split(stub.url).join("<stub-api>") : log;
  return report(scrubbed, { serverBinary: server.split(/[\\/]/).slice(-1)[0], resources: names, ...(stub ? { api: stub.label } : {}), ...exampleEvidence(opts.example) });
}

export const LUANTI_IMAGE = "ghcr.io/luanti-org/luanti:latest";

/**
 * Luanti: builds the SCRIPT//GO mod into a throwaway game, puts the resource and its dependencies
 * in the world's scriptgo/resources/, and runs the official Luanti server image with the mod in
 * verify mode (no port published: nothing can connect). The mod writes the report and shuts the
 * server down. Without Docker the run is skipped.
 */
function verifyLuanti(res: LoadedResource, m: ParsedManifest, search: string[], opts: { image: string; seconds: number; example?: ReadmeExample | null }): Report {
  const started = Date.now();
  const skipped = (message: string, checks: Check[] = []): Report => ({
    package: m.name, version: m.version, environment: "luanti",
    status: checks.some((c) => c.status === "failed") ? "failing" : "skipped",
    runtimeVersion: "", adapterVersion: "luanti-0.1.0", luaVersion: "", durationMs: Date.now() - started,
    checks: [...checks, { name: "server_run", status: "skipped", message }], log: "", evidence: {},
  });
  const { order, missing } = closure(res, search);
  if (missing.length > 0) return skipped("dependencies missing", [{ name: "dependencies_resolved", status: "failed", message: missing.join(", ") }]);
  const docker = spawnSync("docker", ["image", "inspect", opts.image, "--format", "{{index .RepoDigests 0}}"], { encoding: "utf8" });
  if (docker.status !== 0) return skipped(`docker or image ${opts.image} unavailable: ${(docker.stderr ?? "").trim().split(/\r?\n/)[0]}`);
  const digest = (docker.stdout ?? "").trim();

  const run = mkdtempSync(join(tmpdir(), "scriptgo-luanti-"));
  const game = join(run, "game");
  const world = join(run, "world");
  const conf = join(run, "conf");
  mkdirSync(join(game, "mods"), { recursive: true });
  mkdirSync(join(world, "scriptgo", "resources"), { recursive: true });
  mkdirSync(conf, { recursive: true });
  writeFileSync(join(game, "game.conf"), "title = SCRIPT//GO verify\ndescription = Throwaway game for SCRIPT//GO verify runs\n");
  buildMod(join(game, "mods", "scriptgo"));
  for (const r of order) {
    if (!r.result.ok) continue;
    cpSync(r.root, join(world, "scriptgo", "resources", r.result.manifest.name), { recursive: true });
  }
  if (opts.example) cpSync(opts.example.dir, join(world, "scriptgo", "resources", opts.example.name), { recursive: true });
  writeFileSync(join(world, "world.mt"), "gameid = sgverify\nbackend = sqlite3\nplayer_backend = sqlite3\nauth_backend = sqlite3\nmod_storage_backend = sqlite3\n");
  const reportName = "scriptgo-verify-report.json";
  writeFileSync(join(conf, "luanti.conf"), [
    "server_announce = false",
    "ipv6_server = false",
    "bind_address = 127.0.0.1",
    `scriptgo_verify = ${m.name}`,
    `scriptgo_verify_seconds = ${opts.seconds}`,
    `scriptgo_verify_report = ${reportName}`,
    ...(opts.example ? [`scriptgo_verify_with = ${opts.example.name}`] : []),
  ].join("\n") + "\n");
  const mount = (p: string): string => p.split("\\").join("/");
  const r = spawnSync("docker", [
    "run", "--rm", "--network", "none",
    "-v", `${mount(game)}:/usr/local/share/luanti/games/sgverify`,
    "-v", `${mount(world)}:/var/lib/minetest/world`,
    "-v", `${mount(conf)}:/etc/minetest`,
    opts.image, "--config", "/etc/minetest/luanti.conf", "--world", "/var/lib/minetest/world",
  ], { encoding: "utf8", timeout: (opts.seconds + 90) * 1000 });
  const engineLog = ((r.stdout ?? "") + (r.stderr ?? "")).split(/\r?\n/).filter((l) => /scriptgo|ERROR|error/.test(l)).slice(-200).join("\n");
  let report: Report;
  try {
    report = JSON.parse(readFileSync(join(world, reportName), "utf8")) as Report;
    report.log = [report.log, "--- engine", engineLog].filter(Boolean).join("\n");
    report.evidence = { ...report.evidence, image: digest, ...exampleEvidence(opts.example) };
  } catch {
    report = skipped("", []);
    report.checks = [{ name: "server_run", status: "failed", message: `no report written (exit ${r.status ?? r.signal})` }];
    report.status = "failing";
    report.log = engineLog;
    report.evidence = { image: digest };
  }
  report.durationMs = Date.now() - started;
  rmSync(run, { recursive: true, force: true });
  return report;
}

/** Guest languages a run can be evidence for. C# guests are planned (phase 3). */
export const RUN_LANGUAGES = ["lua", "ts", "js"] as const;
export type RunLanguage = (typeof RUN_LANGUAGES)[number];

/** The language a resource is written in, as a run reports it: ts when it has TypeScript scripts. */
export function resourceLanguage(m: ParsedManifest): RunLanguage {
  const scripts = [...m.sharedScripts, ...m.serverScripts, ...m.clientScripts, ...Object.values(m.environmentScripts).flat()];
  if (scripts.some((p) => p.endsWith(".ts"))) return "ts";
  if (scripts.some((p) => p.endsWith(".js"))) return "js";
  return "lua";
}

/**
 * The .NET kit: copies the resource and its dependencies to a temporary folder, compiles their
 * TypeScript entries there, and runs `scriptgo-dotnet verify` on the copy. Without the .NET SDK
 * the run is skipped.
 */
async function verifyDotnet(
  res: LoadedResource, m: ParsedManifest, search: string[],
  opts: { lang: RunLanguage; dotnet?: string; rebuild?: boolean; stub?: ApiTarget; example?: ReadmeExample | null },
): Promise<Report> {
  const started = Date.now();
  const base = (status: Report["status"], checks: Check[], log = ""): Report => ({
    package: m.name, version: m.version, environment: "dotnet", status, runtimeVersion: "", adapterVersion: "", luaVersion: "",
    durationMs: Date.now() - started, checks, log, evidence: { language: opts.lang },
  });
  const dotnet = findDotnet(opts.dotnet);
  if (!dotnet) return base("skipped", [{ name: "host_run", status: "skipped", message: "no .NET SDK: install .NET 10, or pass --dotnet <path> or SCRIPTGO_DOTNET" }]);
  const host = ensureDotnetHost(dotnet, opts.rebuild);
  if ("error" in host) return base("failing", [{ name: "host_build", status: "failed", message: host.error }]);
  const { order, missing } = closure(res, search);
  if (missing.length > 0) return base("failing", [{ name: "dependencies_resolved", status: "failed", message: missing.join(", ") }]);

  const tmp = mkdtempSync(join(tmpdir(), "scriptgo-dotnet-"));
  const stage = join(tmp, "resources");
  const tsChecks: Check[] = [];
  let compiled = 0;
  for (const r of order) {
    if (!r.result.ok) continue;
    const name = r.result.manifest.name;
    const dest = join(stage, name);
    cpSync(r.root, dest, { recursive: true, filter: (src) => !/[\\/](?:node_modules|\.git)(?:[\\/]|$)/.test(src) });
    const ts = await compileTypeScript(r.root, r.result.manifest, listFiles(r.root));
    for (const e of ts.errors) tsChecks.push({ name: `typescript:${name}`, status: "failed", message: e.message });
    for (const c of ts.entries) {
      writeFileSync(join(dest, c.output), c.code);
      compiled++;
    }
  }
  if (tsChecks.length > 0) {
    rmSync(tmp, { recursive: true, force: true });
    return base("failing", tsChecks);
  }
  if (compiled > 0) tsChecks.push({ name: "typescript", status: "passed", message: `${compiled} entr${compiled === 1 ? "y" : "ies"} compiled by esbuild ${ESBUILD_VERSION}` });
  let exampleDir: string | null = null;
  if (opts.example) {
    exampleDir = join(stage, opts.example.name);
    cpSync(opts.example.dir, exampleDir, { recursive: true });
  }
  const reportFile = join(tmp, "report.json");
  const argv = [host.dll, "verify", join(stage, m.name), "--search", stage, "--report", reportFile, "--settle", "2000", "--lang", opts.lang];
  if (exampleDir) argv.push("--with", exampleDir);
  const firstRequest = opts.stub?.requests.length ?? 0;
  if (opts.stub) {
    const config = join(tmp, "config.json");
    writeFileSync(config, JSON.stringify({
      resources: { [m.name]: { api: opts.stub.url, license_key: opts.stub.licenseKey } },
      convars: { scriptgo_api: opts.stub.url },
    }));
    argv.push("--config", config);
  }
  const v = await spawnAsync(dotnet, argv);
  let report: Report;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8")) as Report;
  } catch {
    report = base("failing", [{ name: "host_verify", status: "failed", message: `no report (exit ${v.status})` }], ((v.stdout ?? "") + (v.stderr ?? "")).trim());
  }
  rmSync(tmp, { recursive: true, force: true });
  report.checks.push(...tsChecks, ...selfChecks(report.log));
  if (opts.stub) {
    report.checks.push(...apiChecks(opts.stub.requests, firstRequest, "dotnet", report.adapterVersion));
    report.log = report.log.split(opts.stub.licenseKey).join("<license_key>").split(opts.stub.url).join("<stub-api>");
  }
  report.environment = "dotnet";
  report.evidence = {
    ...report.evidence, language: opts.lang, ...(compiled > 0 ? { typescript: `esbuild ${ESBUILD_VERSION}` } : {}),
    ...(opts.stub ? { api: opts.stub.label } : {}), ...exampleEvidence(opts.example),
  };
  report.status = statusOf(report.checks);
  report.durationMs = Date.now() - started;
  return report;
}

function exampleEvidence(example?: ReadmeExample | null): Record<string, string> {
  return example ? { readme_example: `${example.name}: the runnable Lua block of README.md` } : {};
}

/** First file under `dir` (depth-first, sorted) whose name matches. */
function findFile(dir: string, re: RegExp, depth = 3): string | null {
  if (!existsSync(dir) || depth < 0) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name);
    if (entry.isFile() && re.test(entry.name)) return p;
    if (entry.isDirectory()) {
      const found = findFile(p, re, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

export function findLove(flag?: string): string | null {
  const p = flag ?? process.env.SCRIPTGO_LOVE ?? findFile(join(repoRoot, "tools", "runtimes", "love"), /^lovec(\.exe)?$|^love$/);
  return p && existsSync(p) ? resolve(p) : null;
}

export function findNeovim(flag?: string): string | null {
  const p = flag ?? process.env.SCRIPTGO_NVIM ?? findFile(join(repoRoot, "tools", "runtimes", "neovim"), /^nvim(\.exe)?$/, 4);
  return p && existsSync(p) ? resolve(p) : null;
}

export function findGodot(flag?: string): string | null {
  const p = flag ?? process.env.SCRIPTGO_GODOT ?? findFile(join(repoRoot, "tools", "runtimes", "godot"), /^Godot_.*_console\.exe$|^Godot_.*\.x86_64$/);
  return p && existsSync(p) ? resolve(p) : null;
}

function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/**
 * LÖVE, Godot and Neovim: the runtime runs headless in its verify mode (the LÖVE and Godot demo
 * projects, Neovim's `-l` script) and writes a CompatibilityRun itself; this reads it back.
 * Without the binary the run is skipped.
 */
async function verifyEngine(
  environment: "love2d" | "godot" | "neovim", exe: string | null, res: LoadedResource, m: ParsedManifest, search: string[], example?: ReadmeExample | null,
  stub?: ApiTarget,
): Promise<Report> {
  const started = Date.now();
  const base = (status: Report["status"], checks: Check[], log = ""): Report => ({
    package: m.name, version: m.version, environment, status, runtimeVersion: "", adapterVersion: "", luaVersion: "",
    durationMs: Date.now() - started, checks, log, evidence: {},
  });
  if (!exe) {
    const how = environment === "love2d" ? "--love <lovec>, SCRIPTGO_LOVE or tools/runtimes/love"
      : environment === "neovim" ? "--nvim <nvim>, SCRIPTGO_NVIM or tools/runtimes/neovim"
      : "--godot <console exe>, SCRIPTGO_GODOT or tools/runtimes/godot";
    return base("skipped", [{ name: "engine_run", status: "skipped", message: `no ${environment} binary: pass ${how}` }]);
  }
  if (environment === "godot") {
    // The demo project holds copies of the GDScript host (examples/godot/demo/setup.ps1); a stale
    // copy would run an older verify mode than the SDK's, so refresh them before every run.
    const addon = join(repoRoot, "examples", "godot", "demo", "addons");
    if (!existsSync(join(addon, "lua-gdextension"))) {
      return base("skipped", [{ name: "engine_run", status: "skipped", message: "examples/godot/demo is not set up: run examples/godot/demo/setup.ps1" }]);
    }
    mkdirSync(join(addon, "scriptgo"), { recursive: true });
    for (const f of ["scriptgo_host.gd", "scriptgo_watchdog.gd"]) {
      cpSync(join(repoRoot, "sdk", "adapters", "godot", f), join(addon, "scriptgo", f));
    }
  }
  const tmp = mkdtempSync(join(tmpdir(), `scriptgo-${environment}-`));
  const reportFile = join(tmp, "report.json");
  const verifyArgs = ["--scriptgo-verify", res.root, "--report", reportFile, "--settle", "2000"];
  for (const s of search) if (existsSync(s)) verifyArgs.push("--search", s);
  if (example) verifyArgs.push("--with", example.dir);
  // LÖVE and Neovim take the standalone config shape: the API's URL and key reach the resource as
  // config. Godot has no HTTP yet.
  const http = environment !== "godot";
  const firstRequest = stub?.requests.length ?? 0;
  if (stub && http) {
    const config = join(tmp, "config.json");
    writeFileSync(config, JSON.stringify({
      resources: { [m.name]: { api: stub.url, license_key: stub.licenseKey } },
      convars: { scriptgo_api: stub.url },
    }));
    verifyArgs.push("--config", config);
  }
  const argv = environment === "love2d"
    ? [join(repoRoot, "examples", "love2d", "demo"), ...verifyArgs, "--evidence", `engine-sha256=${sha256File(exe)}`]
    : environment === "neovim"
      ? ["--headless", "--clean", "-l", join(repoRoot, "sdk", "adapters", "neovim", "verify.lua"), ...verifyArgs, "--evidence", `nvim-sha256=${sha256File(exe)}`]
      : ["--headless", "--path", join(repoRoot, "examples", "godot", "demo"), "--", ...verifyArgs];
  const r = await spawnAsync(exe, argv);
  let report: Report;
  try {
    const run = CompatibilityRunSchema.parse(JSON.parse(readFileSync(reportFile, "utf8")));
    report = {
      package: run.package, version: run.version, environment, status: run.status as Report["status"],
      runtimeVersion: run.runtimeVersion ?? "", adapterVersion: run.adapterVersion ?? "", luaVersion: run.luaVersion ?? "",
      durationMs: run.durationMs ?? 0, checks: run.checks.map((c) => ({ name: c.name, status: c.status as Check["status"], message: c.message ?? "" })),
      log: run.log ?? "", evidence: Object.fromEntries(run.evidence.map((e) => [e.kind, e.path])),
    };
  } catch (e) {
    const tail = ((r.stdout ?? "") + (r.stderr ?? "")).split(/\r?\n/).slice(-40).join("\n");
    report = base("failing", [{ name: "engine_run", status: "failed", message: `no valid report (exit ${r.status}): ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` }], tail);
  }
  rmSync(tmp, { recursive: true, force: true });
  if (stub && http) {
    report.checks.push(...apiChecks(stub.requests, firstRequest, environment, report.adapterVersion));
    report.log = report.log.split(stub.licenseKey).join("<license_key>").split(stub.url).join("<stub-api>");
  }
  report.evidence = { ...report.evidence, ...exampleEvidence(example), ...(stub && http ? { api: stub.label } : {}) };
  report.status = statusOf(report.checks);
  report.durationMs = Date.now() - started;
  return report;
}

/** The report's tag: standalone per interpreter, dotnet per guest language, else the environment. */
function runTag(r: Report): string {
  if (r.environment === "standalone") return `standalone-${String(r.evidence.interpreter ?? "lua")}`;
  if (r.environment === "dotnet") return `dotnet-${String(r.evidence.language ?? "lua")}`;
  return r.environment;
}

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help", "json", "stub-api", "no-readme-example", "accept-minecraft-eula", "rebuild-dotnet"], repeatable: ["search"] });
  if (a.bools.has("help") || a.positional.length === 0) {
    console.log(`scriptgo verify <resourceDir> [--env standalone|open77|luanti|love2d|godot|neovim|cctweaked|dotnet|garrysmod|hytale|rust|beammp|all] [--lua all|lua54|lua51|luajit]
    [--lang lua|ts|js] [--dotnet path\\to\\dotnet.exe] [--rebuild-dotnet]
    [--luanti-image ${LUANTI_IMAGE}] [--luanti-seconds 3] [--love path\\to\\lovec.exe] [--godot path\\to\\Godot_console.exe]
    [--nvim path\\to\\nvim.exe] [--cctweaked-seconds 3] [--cctweaked-timeout 600] [--accept-minecraft-eula] [--rust-server path\\to\\server] [--rust-seconds 15] [--no-readme-example]
    ${HYTALE_HELP}
    [--beammp-server path\\to\\BeamMP-Server.exe] [--beammp-port ${BEAMMP_PORT}] [--beammp-seconds 3]  (AuthKey: BEAMMP_AUTH_KEY)
    [--search dir]... [--out verification/reports] [--json]
    [--stub-api | --api <url> --license-key <sg_live_...>]
    [--open77-server path\\to\\Open77.Server.exe] [--port 11861] [--settle 1500] [--timeout 30000]
    [--gmod-server <dir>] [--gmod-binary srcds.exe] [--gmod-port 27115] [--gmod-seconds 4] [--gmod-timeout 120000] [--gmod-verify extra.json]`);
    return a.bools.has("help") ? 0 : 2;
  }
  const res = readResource(a.positional[0]!);
  if (!res.result.ok) {
    for (const e of res.result.errors) console.error(`error ${e.code}: ${e.message}`);
    return 1;
  }
  const m = res.result.manifest;
  const search = [...a.multi.search!.map((s) => resolve(s)), ...defaultSearchPaths()];
  const env = a.flags.env ?? "standalone";
  const out = resolve(a.flags.out ?? join(repoRoot, "verification", "reports"));
  const reports: Report[] = [];
  const stubServer = a.bools.has("stub-api") ? await startStubApi({ packages: stubPackages(m) }) : undefined;
  let stub: ApiTarget | undefined;
  if (stubServer) {
    stub = { url: stubServer.url, licenseKey: stubServer.licenseKey, requests: stubServer.requests, label: "stub-api (loopback, schema-checked)" };
  } else if (a.flags.api) {
    const key = a.flags["license-key"] ?? process.env.SCRIPTGO_LICENSE_KEY ?? "";
    stub = { url: a.flags.api.replace(/\/+$/, ""), licenseKey: key, requests: [], label: `api ${new URL(a.flags.api).host}` };
  }

  const asked = a.flags.lang ?? resourceLanguage(m);
  if (!(RUN_LANGUAGES as readonly string[]).includes(asked)) {
    console.error(asked === "cs" ? "C# guests are planned (phase 3): no host runs them yet" : `unknown language '${asked}' (lua, ts, js)`);
    return 2;
  }
  const lang = asked as RunLanguage;
  const example = a.bools.has("no-readme-example") ? null : writeReadmeExample(res.root, m);
  if (example) console.log(`README example: ${example.name} (runnable Lua block of README.md) runs next to ${m.name}`);

  // Every environment but dotnet runs Lua only: another language is reported as skipped there.
  const luaOnly = ["standalone", "open77", "luanti", "love2d", "godot", "neovim", "cctweaked", "garrysmod", "hytale", "rust", "beammp", "fivem"];
  if (lang !== "lua") {
    for (const e of luaOnly.filter((x) => env === x || env === "all")) {
      reports.push({
        package: m.name, version: m.version, environment: e, status: "skipped", runtimeVersion: "", adapterVersion: "", luaVersion: "",
        durationMs: 0, checks: [{ name: "language", status: "skipped", message: `${e} runs Lua resources only (asked: ${lang})` }], log: "", evidence: { language: lang },
      });
    }
  }
  if (lang === "lua" && (env === "standalone" || env === "all")) {
    for (const lua of pickInterpreters(a.flags.lua ?? "all")) reports.push(await verifyStandalone(res.root, m, lua, search, stub, example));
  }
  if (lang === "lua" && (env === "open77" || env === "all")) {
    reports.push(await verifyOpen77(res, m, search, {
      server: a.flags["open77-server"] ? resolve(a.flags["open77-server"]) : undefined,
      port: Number(a.flags.port ?? 11861),
      settleMs: Number(a.flags.settle ?? 1500),
      timeoutMs: Number(a.flags.timeout ?? 30000),
      stub,
      example,
    }));
  }
  if (lang === "lua" && (env === "luanti" || env === "all")) {
    reports.push(verifyLuanti(res, m, search, {
      image: a.flags["luanti-image"] ?? LUANTI_IMAGE,
      seconds: Number(a.flags["luanti-seconds"] ?? 3),
      example,
    }));
  }
  if (lang === "lua" && (env === "love2d" || env === "all")) {
    reports.push(await verifyEngine("love2d", findLove(a.flags.love), res, m, search, example, stub));
  }
  if (lang === "lua" && (env === "godot" || env === "all")) {
    reports.push(await verifyEngine("godot", findGodot(a.flags.godot), res, m, search, example));
  }
  if (lang === "lua" && (env === "neovim" || env === "all")) {
    reports.push(await verifyEngine("neovim", findNeovim(a.flags.nvim), res, m, search, example, stub));
  }
  if (lang === "lua" && (env === "cctweaked" || env === "all")) {
    const { order, missing } = closure(res, search);
    if (missing.length > 0) {
      reports.push({
        package: m.name, version: m.version, environment: "cctweaked", status: "failing", runtimeVersion: "", adapterVersion: "", luaVersion: "",
        durationMs: 0, checks: [{ name: "dependencies_resolved", status: "failed", message: missing.join(", ") }], log: "", evidence: {},
      });
    } else {
      if (a.bools.has("accept-minecraft-eula")) {
        console.log(`Minecraft EULA accepted by the operator (--accept-minecraft-eula): ${acceptMinecraftEula()}`);
      }
      const resources = order.filter((r) => r.result.ok).map((r) => ({ name: (r.result as { manifest: ParsedManifest }).manifest.name, dir: r.root }));
      for (const r of testCompanions(res, search, new Set(resources.map((x) => x.name)))) {
        resources.push({ name: (r.result as { manifest: ParsedManifest }).manifest.name, dir: r.root });
      }
      if (example) resources.push({ name: example.name, dir: example.dir });
      const timeout = Number(a.flags["cctweaked-timeout"] ?? 600) * 1000;
      const report = await verifyCcTweaked({
        pkg: { name: m.name, version: m.version }, resources, resource: m.name, withResource: example?.name ?? null,
        seconds: Number(a.flags["cctweaked-seconds"] ?? 3), readyTimeoutMs: timeout, reportTimeoutMs: Math.min(timeout, 180_000),
      });
      report.evidence = { ...report.evidence, ...exampleEvidence(example) };
      reports.push(report);
    }
  }
  if (env === "dotnet" || env === "all") {
    reports.push(await verifyDotnet(res, m, search, { lang, dotnet: a.flags.dotnet, rebuild: a.bools.has("rebuild-dotnet"), stub, example }));
  }
  if (lang === "lua" && (env === "garrysmod" || env === "all")) {
    reports.push(await verifyGarrysmod(res, m, search, {
      server: a.flags["gmod-server"], binary: a.flags["gmod-binary"], port: Number(a.flags["gmod-port"] ?? 27115),
      seconds: Number(a.flags["gmod-seconds"] ?? 4), timeoutMs: Number(a.flags["gmod-timeout"] ?? 120000), stub, example,
      extra: a.flags["gmod-verify"] ? JSON.parse(readFileSync(resolve(a.flags["gmod-verify"]), "utf8")) : undefined,
    }));
  }
  if (lang === "lua" && (env === "hytale" || env === "all")) reports.push(await verifyHytale(res, m, search, a.flags, example, stub));
  if (lang === "lua" && (env === "rust" || env === "all")) {
    reports.push(await verifyRust(res, m, search, { server: a.flags["rust-server"], seconds: Number(a.flags["rust-seconds"] ?? 15), timeoutMs: Number(a.flags["rust-timeout"] ?? 1_200_000), example, api: stub, apiChecks }));
  }
  if (lang === "lua" && (env === "beammp" || env === "all")) {
    const server = findBeamMPServer(a.flags["beammp-server"]);
    reports.push(await verifyBeamMP(res, m, search, { server, port: Number(a.flags["beammp-port"] ?? BEAMMP_PORT), seconds: Number(a.flags["beammp-seconds"] ?? 3), stub, example }));
  }
  // FiveM: lib/fivem-verify.ts (--fivem-server, --fivem-port, SCRIPTGO_FIVEM_LICENSE_KEY).
  if (lang === "lua" && (env === "fivem" || env === "all")) reports.push(await verifyFivem(res, m, search, fivemOptions(a.flags, stub, example)));
  await stubServer?.close();
  example?.cleanup();
  // Stored logs never carry local paths (they hold the user name): temporary folders and home.
  const scrubs: [string, string][] = [];
  for (const [p, label] of [[repoRoot, "<repo>"], [tmpdir(), "<tmp>"], [homedir(), "~"]] as const) {
    if (p.length < 4) continue;
    scrubs.push([p, label], [p.split("\\").join("/"), label], [p.split("/").join("\\"), label]);
  }
  const scrub = (s: string): string => scrubs.reduce((acc, [from, to]) => acc.split(from).join(to), s);
  for (const r of reports) {
    r.log = scrub(r.log);
    for (const c of r.checks) c.message = scrub(c.message);
  }
  if (reports.length === 0) {
    console.error(`unknown environment '${env}' (standalone, open77, luanti, love2d, godot, neovim, cctweaked, dotnet, garrysmod, hytale, rust, beammp, all)`);
    return 2;
  }

  mkdirSync(out, { recursive: true });
  const ranAt = new Date().toISOString();
  for (const r of reports) {
    const tag = runTag(r);
    if (r.status === "skipped") continue;
    writeFileSync(join(out, `${r.package}-${r.version}-${tag}.json`), JSON.stringify(toCompatibilityRun(r, tag, ranAt), null, 2) + "\n");
  }
  if (a.bools.has("json")) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const r of reports) {
      const tag = runTag(r).replace("-", "/");
      console.log(`${r.package} ${r.version} on ${tag}: ${r.status}`);
      for (const c of r.checks) console.log(`  ${c.status === "passed" ? "ok  " : c.status === "skipped" ? "skip" : "FAIL"} ${c.name}${c.message ? `  ${c.message}` : ""}`);
    }
    console.log(`reports -> ${out}`);
  }
  return reports.some((r) => r.status === "failing") ? 1 : 0;
}
