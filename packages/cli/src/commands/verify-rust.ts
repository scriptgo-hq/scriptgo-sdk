// scriptgo verify --env rust: a real Rust dedicated server (RustDedicated) with Oxide or Carbon runs the
// SCRIPT//GO plugin (sdk/adapters/rust) in its verify mode, bound to loopback; the plugin writes the
// report and quits the server.
//
// The server folder comes from --rust-server or SCRIPTGO_RUST_SERVER and must already hold Oxide or
// Carbon (see sdk/adapters/rust/SETUP.md). Without it the run is reported as skipped, never verified.
// The runner installs the plugin files into the server folder (bridge, KeraLua, lua54, ScriptGo.cs),
// puts the resource and its dependencies in a temporary folder the plugin reads, swaps in a verify
// config for the run and restores the previous one afterwards. Only the server runs: no game client.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ParsedManifest } from "@scriptgo/manifest";
// @ts-expect-error plain ESM build script without type declarations
import { buildPlugin } from "../../../../sdk/adapters/rust/build.mjs";
import { readResource, type LoadedResource } from "../lib/sdk.ts";
import type { ReadmeExample } from "../lib/readme-example.ts";
import type { StubRequest } from "../lib/stub-api.ts";

export const RUST_ADAPTER_VERSION = "rust-0.1.0";
/** Loopback ports of the verify server: game (UDP) and web RCON (TCP; Steam query shares the number over UDP). */
export const RUST_GAME_PORT = 28115;
export const RUST_RCON_PORT = 28116;

interface RustCheck {
  name: string;
  status: "passed" | "failed" | "skipped";
  message: string;
}

/** Same shape as verify.ts's Report. */
export interface RustReport {
  package: string;
  version: string;
  environment: string;
  status: "verified" | "failing" | "skipped";
  runtimeVersion: string;
  adapterVersion: string;
  luaVersion: string;
  durationMs: number;
  checks: RustCheck[];
  log: string;
  evidence: Record<string, unknown>;
}

export type RustFramework = "oxide" | "carbon";

export interface RustVerifyOptions {
  /** Server folder (holds RustDedicated[.exe]); else SCRIPTGO_RUST_SERVER. */
  server?: string;
  /** Seconds the plugin lets the resource run before it writes the report. */
  seconds: number;
  /** Whole-run limit, world generation included (a first boot generates the map). */
  timeoutMs: number;
  example?: ReadmeExample | null;
  /** Licensing API the resource talks to (the stub or a real one), and the checks verify.ts makes on it. */
  api?: { url: string; licenseKey: string; serverToken?: string; requests: StubRequest[] };
  apiChecks?: (requests: StubRequest[], from: number, environment: string, adapterVersion: string) => RustCheck[];
}

export function rustServerExecutable(dir: string): string {
  return join(dir, process.platform === "win32" ? "RustDedicated.exe" : "RustDedicated");
}

/** The server folder from the flag or SCRIPTGO_RUST_SERVER, when it holds the server binary. */
export function findRustServer(flag?: string): string | null {
  const p = flag ?? process.env.SCRIPTGO_RUST_SERVER;
  return p && existsSync(rustServerExecutable(resolve(p))) ? resolve(p) : null;
}

/** Which plugin framework the server folder has installed. */
export function detectRustFramework(dir: string): RustFramework | "both" | null {
  const oxide = existsSync(join(dir, "RustDedicated_Data", "Managed", "Oxide.Rust.dll"));
  const carbon = existsSync(join(dir, "carbon", "managed", "Carbon.dll"));
  return oxide && carbon ? "both" : oxide ? "oxide" : carbon ? "carbon" : null;
}

/** Where each framework keeps plugins, configs and data, relative to the server folder. */
export function rustFrameworkPaths(dir: string, framework: RustFramework): { plugins: string; config: string; data: string } {
  return framework === "oxide"
    ? { plugins: join(dir, "oxide", "plugins"), config: join(dir, "oxide", "config", "ScriptGo.json"), data: join(dir, "oxide", "data") }
    : { plugins: join(dir, "carbon", "plugins"), config: join(dir, "carbon", "configs", "ScriptGo.json"), data: join(dir, "carbon", "data") };
}

/** The files the runner copies from a built dist/rust into the server folder: [from, to] relative paths. */
export function rustInstallFiles(framework: RustFramework): [string, string][] {
  return [
    ["RustDedicated_Data/Managed/ScriptGo.Bridge.dll", "RustDedicated_Data/Managed/ScriptGo.Bridge.dll"],
    ["RustDedicated_Data/Managed/KeraLua.dll", "RustDedicated_Data/Managed/KeraLua.dll"],
    process.platform === "win32"
      ? ["RustDedicated_Data/Plugins/x86_64/lua54.dll", "RustDedicated_Data/Plugins/x86_64/lua54.dll"]
      : ["RustDedicated_Data/Plugins/x86_64/liblua54.so", "RustDedicated_Data/Plugins/x86_64/liblua54.so"],
    [`${framework}/plugins/ScriptGo.cs`, `${framework}/plugins/ScriptGo.cs`],
  ];
}

/** The plugin config for a verify run (keys as plugin/ScriptGo.cs reads them). */
export function rustVerifyConfig(opts: {
  resource: string; with?: string; reportPath: string; resourceFolder: string; seconds: number;
  api?: { url: string; licenseKey: string; serverToken?: string };
}): Record<string, unknown> {
  return {
    tickIntervalSeconds: 0.02,
    budgetMs: 250,
    httpTimeoutSeconds: 15,
    httpAllowedHosts: opts.api ? [new URL(opts.api.url).hostname] : [],
    resourceFolders: [opts.resourceFolder],
    start: null,
    nativeLibraryFolder: null,
    debug: false,
    convars: opts.api ? { scriptgo_api: opts.api.url, ...(opts.api.serverToken ? { scriptgo_server_token: opts.api.serverToken } : {}) } : {},
    resources: opts.api ? { [opts.resource]: { api: opts.api.url, license_key: opts.api.licenseKey } } : {},
    verify: { resource: opts.resource, with: opts.with ?? null, reportPath: opts.reportPath, runSeconds: opts.seconds, quit: true },
  };
}

/** RustDedicated arguments: loopback only, a small throwaway world, Rust+ companion off. */
export function rustServerArgs(logFile: string, rconPassword: string): string[] {
  return [
    "-batchmode", "-nographics", "-logfile", logFile,
    "+server.ip", "127.0.0.1", "+server.port", String(RUST_GAME_PORT), "+server.queryport", String(RUST_RCON_PORT),
    "+rcon.ip", "127.0.0.1", "+rcon.port", String(RUST_RCON_PORT), "+rcon.web", "1", "+rcon.password", rconPassword,
    "+app.port", "-1",
    "+server.identity", "sgverify", "+server.hostname", "SCRIPT//GO verify",
    "+server.level", "Procedural Map", "+server.worldsize", "1000", "+server.seed", "1",
    "+server.maxplayers", "2", "+server.saveinterval", "100000",
  ];
}

function findResource(name: string, search: string[]): string | null {
  for (const dir of search) {
    const p = join(dir, name);
    if (existsSync(join(p, "scriptgo.lua")) || existsSync(join(p, "open77.lua"))) return p;
  }
  return null;
}

/** The resource and every dependency it names, dependencies first. */
export function rustClosure(root: LoadedResource, search: string[]): { order: LoadedResource[]; missing: string[] } {
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

function statusOf(checks: RustCheck[]): RustReport["status"] {
  if (checks.some((c) => c.status === "failed")) return "failing";
  if (checks.length > 0 && checks.every((c) => c.status === "skipped")) return "skipped";
  return "verified";
}

/**
 * A report is committed and shown on the site: it must not carry where the server is installed on
 * the machine that ran it. Every string of the report has the server folder (either slash style,
 * any case) replaced by `<rust-server>`, and the log loses the copies of its lines that the server
 * writes a second time with terminal colours.
 */
export function scrubServerPath<T>(report: T, server: string): T {
  const folder = resolve(server).replace(/[\\/]+$/, "");
  const pattern = new RegExp(folder.split(/[\\/]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]+"), "gi");
  const clean = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      const text = key === "log" ? value.split("\n").filter((line) => !line.includes("\u001b")).join("\n") : value;
      return text.replace(pattern, "<rust-server>");
    }
    if (Array.isArray(value)) return value.map((item) => clean(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
    return value;
  };
  return clean(report) as T;
}

/** Kills a process and its children (Windows: taskkill /T; elsewhere: the process group). */
function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

export async function verifyRust(res: LoadedResource, m: ParsedManifest, search: string[], opts: RustVerifyOptions): Promise<RustReport> {
  const started = Date.now();
  const report = (status: RustReport["status"], checks: RustCheck[], log = "", evidence: Record<string, unknown> = {}): RustReport => ({
    package: m.name, version: m.version, environment: "rust", status, runtimeVersion: "", adapterVersion: RUST_ADAPTER_VERSION,
    luaVersion: "", durationMs: Date.now() - started, checks, log, evidence,
  });
  const skipped = (message: string): RustReport => report("skipped", [{ name: "server_run", status: "skipped", message }]);

  const server = findRustServer(opts.server);
  if (!server) {
    return skipped("no Rust dedicated server: pass --rust-server <folder with RustDedicated> or set SCRIPTGO_RUST_SERVER (sdk/adapters/rust/SETUP.md)");
  }
  const framework = detectRustFramework(server);
  if (framework === null) return skipped(`neither Oxide nor Carbon is installed in ${server} (sdk/adapters/rust/SETUP.md)`);
  if (framework === "both") return skipped(`both Oxide and Carbon are installed in ${server}: keep one`);
  const { order, missing } = rustClosure(res, search);
  if (missing.length > 0) return report("failing", [{ name: "dependencies_resolved", status: "failed", message: missing.join(", ") }]);

  const run = mkdtempSync(join(tmpdir(), "scriptgo-rust-"));
  const paths = rustFrameworkPaths(server, framework);
  const backup = existsSync(paths.config) ? readFileSync(paths.config) : null;
  let child: ReturnType<typeof spawn> | null = null;
  try {
    // Plugin files from a fresh build, then the resources in a folder of their own.
    const dist: string = buildPlugin(join(run, "dist"));
    for (const [from, to] of rustInstallFiles(framework)) {
      mkdirSync(resolve(server, to, ".."), { recursive: true });
      cpSync(join(dist, from), join(server, to));
    }
    const resources = join(run, "resources");
    for (const r of order) {
      if (r.result.ok) cpSync(r.root, join(resources, r.result.manifest.name), { recursive: true });
    }
    if (opts.example) cpSync(opts.example.dir, join(resources, opts.example.name), { recursive: true });
    const reportPath = join(run, "report.json");
    mkdirSync(resolve(paths.config, ".."), { recursive: true });
    writeFileSync(paths.config, JSON.stringify(rustVerifyConfig({
      resource: m.name, with: opts.example?.name, reportPath, resourceFolder: resources, seconds: opts.seconds, api: opts.api,
    }), null, 2));

    const logFile = join(run, "server.log");
    const exe = rustServerExecutable(server);
    const env = { ...process.env };
    if (process.platform !== "win32") {
      env.LD_LIBRARY_PATH = [join(server, "RustDedicated_Data", "Plugins", "x86_64"), server, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    }
    const argv = rustServerArgs(logFile, randomBytes(18).toString("base64url"));
    // Carbon on Linux starts through Doorstop, whose variables its environment script sets.
    const linuxCarbon = process.platform !== "win32" && framework === "carbon" && existsSync(join(server, "carbon", "tools", "environment.sh"));
    child = linuxCarbon
      ? spawn("bash", ["-c", '. ./carbon/tools/environment.sh && exec ./RustDedicated "$@"', "rustdedicated", ...argv], { cwd: server, env, stdio: "ignore", detached: true })
      : spawn(exe, argv, { cwd: server, env, stdio: "ignore", detached: process.platform !== "win32" });
    const exited = new Promise<number | null>((done) => {
      child!.on("exit", (code) => done(code));
      child!.on("error", () => done(null));
    });
    const firstRequest = opts.api?.requests.length ?? 0;
    const state: { exit?: number | null } = {};
    void exited.then((c) => { state.exit = c; });
    const running = (): boolean => !("exit" in state);
    while (Date.now() - started < opts.timeoutMs && running() && !existsSync(reportPath)) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    // The plugin quits the server after the report; give it a moment to save and exit, then make sure.
    const deadline = Date.now() + 60_000;
    while (running() && existsSync(reportPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    if (running() && child.pid) killTree(child.pid);

    const serverLog = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    const relevant = serverLog.split(/\r?\n/).filter((l) => /ScriptGo|SCRIPT\/\/GO|scriptgo|Exception|\bError\b|error CS/.test(l)).slice(-300).join("\n");
    if (!existsSync(reportPath)) {
      const why = running() ? `no report within ${Math.round(opts.timeoutMs / 1000)} s` : `the server exited (${state.exit}) without a report`;
      return report("failing", [{ name: "server_run", status: "failed", message: why }], relevant, { framework });
    }
    const r = JSON.parse(readFileSync(reportPath, "utf8")) as RustReport;
    r.environment = "rust";
    r.log = [r.log, "--- server log", relevant].filter(Boolean).join("\n");
    if (opts.api && opts.apiChecks) r.checks.push(...opts.apiChecks(opts.api.requests, firstRequest, "rust", r.adapterVersion));
    if (opts.api) r.log = r.log.split(opts.api.licenseKey).join("<license_key>").split(opts.api.url).join("<stub-api>");
    r.evidence = {
      ...r.evidence, framework, ports: `${RUST_GAME_PORT}/${RUST_RCON_PORT} on 127.0.0.1`,
      ...(opts.example ? { readme_example: `${opts.example.name}: the runnable Lua block of README.md` } : {}),
    };
    r.status = statusOf(r.checks);
    r.durationMs = Date.now() - started;
    return scrubServerPath(r, server);
  } finally {
    if (child?.pid && child.exitCode === null) killTree(child.pid);
    if (backup) writeFileSync(paths.config, backup);
    else rmSync(paths.config, { force: true });
    rmSync(run, { recursive: true, force: true });
  }
}
