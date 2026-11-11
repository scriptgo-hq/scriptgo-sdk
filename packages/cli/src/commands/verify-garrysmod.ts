// scriptgo verify --env garrysmod: the resource on a real Garry's Mod dedicated server (srcds).
//
// The runner installs two addons into <server>/garrysmod/addons/ — `scriptgo` (the runtime: GLua
// host + core, sdk/adapters/garrysmod) and `scriptgo_verify` (the resource, its dependencies and the
// README example, packed as for `scriptgo pack --target garrysmod`) — writes
// garrysmod/data/scriptgo/verify.json, and starts srcds headless on 127.0.0.1 (sv_lan 1, +map
// gm_construct, 2 slots). The addon's verify mode starts only that resource, has a bot join and
// leave, and writes data/scriptgo/verify-report.json. GMod refuses `quit` from Lua, so the runner
// stops the server by PID once the report exists (or at the timeout), reads console.log
// (-condebug), and removes what it installed.
//
// The server folder comes from --gmod-server, SCRIPTGO_GMOD_SERVER or tools/runtimes/garrysmod/server
// (SteamCMD app 4020, anonymous login: see sdk/adapters/garrysmod/SETUP.md). Without it the run is
// skipped. Only the server half runs: no game client is started.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParsedManifest } from "@scriptgo/manifest";
import { addonJson, buildGarrysmodRuntime, copyResourceForGarrysmod } from "../lib/garrysmod.ts";
import type { ReadmeExample } from "../lib/readme-example.ts";
import { readResource, repoRoot, type LoadedResource } from "../lib/sdk.ts";
import type { StubRequest } from "../lib/stub-api.ts";
import { apiChecks, closure } from "./verify.ts";

interface Check {
  name: string;
  status: "passed" | "failed" | "skipped";
  message: string;
}

interface Report {
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

export interface GarrysmodVerifyOptions {
  server?: string;
  /** srcds binary inside the server folder (default srcds.exe on Windows, srcds_run elsewhere). */
  binary?: string;
  port: number;
  seconds: number;
  timeoutMs: number;
  map?: string;
  stub?: { url: string; licenseKey: string; serverToken?: string; requests: StubRequest[]; label: string };
  example?: ReadmeExample | null;
  /**
   * More for the addon's verify request (--gmod-verify <file.json>): `config` (merged into the
   * run's config.json: resources, convars, permissions) and `botChat` (lines the bot says).
   */
  extra?: { config?: Record<string, Record<string, unknown>>; botChat?: string[] };
}

/** data/scriptgo/verify.json: what the addon's verify mode runs, with the run's own config. */
export function verifyRequest(name: string, opts: GarrysmodVerifyOptions): Record<string, unknown> {
  // Objects merge key by key at every level (resources.<name>.<key> from the stub and from --gmod-verify
  // both survive); arrays and plain values replace.
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const merge = (into: Record<string, unknown>, from?: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(from ?? {})) {
      if (isObject(v) && isObject(into[k])) merge(into[k] as Record<string, unknown>, v);
      else into[k] = structuredClone(v);
    }
  };
  const config: Record<string, unknown> = {};
  if (opts.stub) {
    merge(config, { resources: { [name]: { api: opts.stub.url, license_key: opts.stub.licenseKey } }, convars: { scriptgo_api: opts.stub.url, ...(opts.stub.serverToken ? { scriptgo_server_token: opts.stub.serverToken } : {}) } });
  }
  merge(config, opts.extra?.config);
  return {
    resource: name,
    with: opts.example?.name ?? null,
    seconds: opts.seconds,
    report: "scriptgo/verify-report.json",
    storageDir: "scriptgo/verify/storage",
    bot: true,
    botChat: opts.extra?.botChat ?? [],
    config,
  };
}

const ADAPTER_VERSION = "garrysmod-0.1.0";
/** Marker in the folders the runner creates, so it never deletes an operator's own addon. */
const MARKER = ".scriptgo-verify";

export function findGarrysmodServer(flag?: string): string | null {
  const p = flag ?? process.env.SCRIPTGO_GMOD_SERVER ?? join(repoRoot, "tools", "runtimes", "garrysmod", "server");
  return p && existsSync(join(p, "garrysmod")) ? resolve(p) : null;
}

/** The srcds command line: loopback only, LAN mode (no master server), never hibernating. */
export function srcdsArgs(port: number, map: string, localHttp: boolean): string[] {
  return [
    "-console", "-condebug", "-game", "garrysmod", "-port", String(port), "+ip", "127.0.0.1",
    "-nohltv", "-norestart", "-nocrashdialog",
    ...(localHttp ? ["-allowlocalhttp"] : []),
    "+sv_lan", "1", "+sv_hibernate_think", "1", "+maxplayers", "2", "+map", map,
  ];
}

/** Console lines worth keeping: SCRIPT//GO's own, Lua errors, and the engine's fatal ones. */
export function engineLines(consoleLog: string): string[] {
  return consoleLog.split(/\r?\n/).filter((l) => /\[scriptgo\]|\[ERROR\]|Lua Error|^\s+\d+\. .* - |Couldn't|FATAL|Host_Error/i.test(l));
}

/** `[ERROR]` lines GMod prints for a Lua error raised outside the SCRIPT//GO host (hooks, addons). */
export function luaErrors(consoleLog: string): string[] {
  return consoleLog.split(/\r?\n/).filter((l) => /^\[ERROR\]/.test(l.trim()));
}

interface Srcds {
  pid: number | null;
  error: string;
  alive(): boolean;
  exitCode(): number | null;
  /** Stops the server by its PID and waits (10 s at most) until it is gone. */
  stop(): Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts srcds. On Windows `srcds -console` reads its own console's input and exits (code 100)
 * when its standard input is a pipe or NUL, which is what Node gives a child; PowerShell's
 * Start-Process creates it with a real (hidden) console instead and prints its PID.
 */
function startSrcds(exe: string, cwd: string, args: string[]): Srcds {
  if (process.platform === "win32") {
    const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
    const r = spawnSync("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `$p = Start-Process -FilePath ${q(exe)} -ArgumentList ${q(args.join(" "))} -WorkingDirectory ${q(cwd)} -WindowStyle Hidden -PassThru; $p.Id`,
    ], { encoding: "utf8", timeout: 30000 });
    const pid = Number((r.stdout ?? "").trim().split(/\r?\n/).pop());
    const ok = Number.isInteger(pid) && pid > 0;
    return {
      pid: ok ? pid : null,
      error: ok ? "" : `Start-Process failed: ${(r.stderr ?? "").trim().split(/\r?\n/)[0] ?? ""}`,
      alive: () => ok && pidAlive(pid),
      exitCode: () => null,
      stop: async () => {
        if (!ok) return;
        if (pidAlive(pid)) process.kill(pid);
        const until = Date.now() + 10000;
        while (pidAlive(pid) && Date.now() < until) await new Promise((res) => setTimeout(res, 200));
      },
    };
  }
  const child = spawn(exe, args, { cwd, stdio: "ignore" });
  let code: number | null | undefined;
  let error = "";
  const exited = new Promise<void>((done) => {
    child.on("exit", (c) => { code = c; done(); });
    child.on("error", (e) => { error = String(e); code = null; done(); });
  });
  return {
    pid: child.pid ?? null,
    get error() { return error; },
    alive: () => code === undefined,
    exitCode: () => code ?? null,
    stop: async () => {
      if (code === undefined) child.kill();
      await Promise.race([exited, new Promise((res) => setTimeout(res, 10000))]);
    },
  };
}

function sha256(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function statusOf(checks: Check[]): Report["status"] {
  if (checks.some((c) => c.status === "failed")) return "failing";
  if (checks.length > 0 && checks.every((c) => c.status === "skipped")) return "skipped";
  return "verified";
}

export async function verifyGarrysmod(res: LoadedResource, m: ParsedManifest, search: string[], opts: GarrysmodVerifyOptions): Promise<Report> {
  const started = Date.now();
  const checks: Check[] = [];
  const base = (log = "", evidence: Record<string, unknown> = {}): Report => ({
    package: m.name, version: m.version, environment: "garrysmod", status: statusOf(checks),
    runtimeVersion: "", adapterVersion: ADAPTER_VERSION, luaVersion: "", durationMs: Date.now() - started, checks, log, evidence,
  });

  const { order, missing } = closure(res, search);
  if (missing.length > 0) {
    checks.push({ name: "dependencies_resolved", status: "failed", message: missing.join(", ") });
    return base();
  }
  const server = findGarrysmodServer(opts.server);
  if (!server) {
    checks.push({ name: "server_run", status: "skipped", message: "no Garry's Mod server: pass --gmod-server <dir>, set SCRIPTGO_GMOD_SERVER, or install it in tools/runtimes/garrysmod/server" });
    return base();
  }
  const exeName = opts.binary ?? (process.platform === "win32" ? "srcds.exe" : "srcds_run");
  const exe = join(server, exeName);
  if (!existsSync(exe)) {
    checks.push({ name: "server_run", status: "skipped", message: `${exeName} not found in the server folder` });
    return base();
  }
  const gmod = join(server, "garrysmod");
  const addons = join(gmod, "addons");
  const runtimeDir = join(addons, "scriptgo");
  const resourcesAddon = join(addons, "scriptgo_verify");
  if (existsSync(runtimeDir) && !existsSync(join(runtimeDir, MARKER))) {
    checks.push({ name: "server_run", status: "skipped", message: "garrysmod/addons/scriptgo is the operator's own install: verify needs a dedicated server folder" });
    return base();
  }

  // Install: the runtime, then every resource of the closure (and the README example) in one addon.
  buildGarrysmodRuntime(runtimeDir);
  writeFileSync(join(runtimeDir, MARKER), "created by scriptgo verify; removed after the run\n");
  if (existsSync(resourcesAddon)) rmSync(resourcesAddon, { recursive: true, force: true });
  mkdirSync(resourcesAddon, { recursive: true });
  writeFileSync(join(resourcesAddon, MARKER), "created by scriptgo verify; removed after the run\n");
  writeFileSync(join(resourcesAddon, "addon.json"), addonJson("SCRIPT//GO verify resources"));
  const all = [...order, ...(opts.example ? [readResource(opts.example.dir)] : [])];
  const names: string[] = [];
  let packed = true;
  for (const r of all) {
    const p = copyResourceForGarrysmod(r, join(resourcesAddon, "lua", "scriptgo", "resources"));
    const name = r.result.ok ? r.result.manifest.name : r.root;
    names.push(name);
    if (p.errors.length > 0) {
      packed = false;
      checks.push({ name: `packs:${name}`, status: "failed", message: p.errors.map((e) => e.code).join(", ") });
    } else {
      checks.push({ name: `packs:${name}`, status: "passed", message: p.warnings.join("; ") });
    }
  }

  const dataDir = join(gmod, "data", "scriptgo");
  const reportFile = join(dataDir, "verify-report.json");
  const cleanup = (): void => {
    for (const p of [runtimeDir, resourcesAddon, join(dataDir, "verify"), join(dataDir, "verify.json"), reportFile]) {
      rmSync(p, { recursive: true, force: true });
    }
  };
  if (!packed) {
    cleanup();
    return base();
  }
  mkdirSync(dataDir, { recursive: true });
  rmSync(reportFile, { force: true });
  rmSync(join(dataDir, "verify"), { recursive: true, force: true });
  const stub = opts.stub;
  const firstRequest = stub?.requests.length ?? 0;
  writeFileSync(join(dataDir, "verify.json"), JSON.stringify(verifyRequest(m.name, opts), null, 2));
  const consoleFile = join(gmod, "console.log");
  rmSync(consoleFile, { force: true });

  const map = opts.map ?? "gm_construct";
  const proc = startSrcds(exe, server, srcdsArgs(opts.port, map, stub !== undefined));
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline && proc.alive() && !existsSync(reportFile)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  // The report is written in one call; give the file system a moment before reading it.
  if (existsSync(reportFile)) await new Promise((r) => setTimeout(r, 300));
  const exitCode = proc.alive() ? undefined : proc.exitCode();
  const spawnError = proc.error;
  await proc.stop();

  const scrubServer = (s: string): string => s.split(server).join("<gmod-server>").split(server.split("\\").join("/")).join("<gmod-server>");
  const consoleLog = existsSync(consoleFile) ? scrubServer(readFileSync(consoleFile, "latin1")) : "";
  const engine = engineLines(consoleLog);
  const steamInf = existsSync(join(gmod, "steam.inf")) ? readFileSync(join(gmod, "steam.inf"), "utf8") : "";
  const patch = /PatchVersion=(\S+)/.exec(steamInf)?.[1] ?? "";
  const evidence: Record<string, unknown> = {
    binary: exeName, binarySha256: sha256(exe), patchVersion: patch, map, port: opts.port,
    ...(stub ? { api: stub.label } : {}),
    ...(opts.example ? { readme_example: `${opts.example.name}: the runnable Lua block of README.md` } : {}),
  };

  let report: Report;
  try {
    const addonReport = JSON.parse(readFileSync(reportFile, "utf8")) as Report;
    report = {
      ...addonReport,
      checks: [...checks, { name: "server_run", status: "passed", message: `srcds on 127.0.0.1:${opts.port}, map ${map}` }, ...addonReport.checks],
      log: [addonReport.log, "--- engine (console.log)", ...engine.slice(-200)].filter(Boolean).join("\n"),
      evidence: { ...addonReport.evidence, ...evidence },
    };
    const errs = luaErrors(consoleLog);
    report.checks.push({ name: "engine_lua_errors", status: errs.length === 0 ? "passed" : "failed", message: errs[0] ?? "" });
  } catch {
    checks.push({
      name: "server_run", status: "failed",
      message: spawnError || (exitCode === undefined
        ? `no report within ${Math.round(opts.timeoutMs / 1000)} s; srcds stopped by the runner`
        : `srcds exited${exitCode === null ? "" : ` (${exitCode})`} before writing a report`),
    });
    report = base([...engine.slice(-60), ...consoleLog.split(/\r?\n/).slice(-40)].join("\n"), evidence);
  }
  if (stub) {
    report.checks.push(...apiChecks(stub.requests, firstRequest, "garrysmod", report.adapterVersion || ADAPTER_VERSION));
    report.log = report.log.split(stub.licenseKey).join("<license_key>").split(stub.url).join("<stub-api>");
  }
  cleanup();
  report.environment = "garrysmod";
  report.status = statusOf(report.checks);
  report.durationMs = Date.now() - started;
  return report;
}
