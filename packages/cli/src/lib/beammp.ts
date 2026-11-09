// The BeamMP target: `scriptgo pack --target beammp` and `scriptgo verify --env beammp`.
//
// A BeamMP server runs Lua 5.3 plugins from Resources/Server/<plugin>/. SCRIPT//GO ships one plugin,
// `scriptgo` (sdk/adapters/beammp): the portable core, the BeamMP adapter and the resources in its
// resources/ folder. Only the server half exists: BeamNG.drive client mods are out of scope.
//
// verify starts the real BeamMP-Server on loopback (Private, unlisted, InformationPacket off) with
// the plugin in its verify mode; the plugin writes the report, the CLI reads it, stops the server
// (console `exit`, then a kill) and checks what only the outside can see (the listening sockets,
// Lua errors BeamMP logged outside the SCRIPT//GO host). BeamMP-Server refuses to start without an
// AuthKey from https://keymaster.beammp.com; the key is read from BEAMMP_AUTH_KEY (the server's own
// variable) and never written to a report. Without a server binary or a key the run is skipped.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { validateResourceFiles, type ParsedManifest } from "@scriptgo/manifest";
// @ts-expect-error plain ESM build script without type declarations
import { buildPlugin } from "../../../../sdk/adapters/beammp/build.mjs";
import { apiChecks } from "../commands/verify.ts";
import type { ReadmeExample } from "./readme-example.ts";
import { defaultSearchPaths, listFiles, readResource, repoRoot, sdkRoot, type LoadedResource } from "./sdk.ts";
import type { StubRequest } from "./stub-api.ts";

export const BEAMMP_PORT = 30814;
export const PLUGIN_NAME = "scriptgo";

interface Check {
  name: string;
  status: "passed" | "failed" | "skipped";
  message: string;
}

/** Same shape as the reports of `scriptgo verify` (commands/verify.ts). */
export interface BeamMPReport {
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

interface ApiTarget {
  url: string;
  licenseKey: string;
  requests: StubRequest[];
  label: string;
}

/** The adapter version the plugin reports (and sends to the licensing API). */
export function beammpAdapterVersion(): string {
  const text = readFileSync(join(sdkRoot, "adapters", "beammp", "plugin", "lib", "adapter.lua"), "utf8");
  return /adapterVersion = "([^"]+)"/.exec(text)?.[1] ?? "beammp-0.1.0";
}

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

/** --beammp-server, SCRIPTGO_BEAMMP_SERVER, or tools/runtimes/beammp/BeamMP-Server(.exe). */
export function findBeamMPServer(flag?: string): string | null {
  const p = flag ?? process.env.SCRIPTGO_BEAMMP_SERVER ?? findFile(join(repoRoot, "tools", "runtimes", "beammp"), /^BeamMP-Server(\.exe)?$/);
  return p && existsSync(p) ? resolve(p) : null;
}

/**
 * ServerConfig.toml for a verify run: loopback only, private (never listed), no information packet
 * for unconnected clients, no guests. The AuthKey stays empty here: the server reads it from the
 * environment (BEAMMP_AUTH_KEY), which overrides the file.
 */
export function beammpServerConfig(port: number): string {
  return [
    "# Written by `scriptgo verify --env beammp` for one loopback run. The AuthKey comes from BEAMMP_AUTH_KEY.",
    "[General]",
    `Port = ${port}`,
    'IP = "127.0.0.1"',
    'AuthKey = ""',
    "Private = true",
    "InformationPacket = false",
    "AllowGuests = false",
    'Name = "SCRIPT//GO verify"',
    'Description = "Loopback compatibility run"',
    'Tags = "Freeroam"',
    'Map = "/levels/gridmap_v2/info.json"',
    "MaxPlayers = 2",
    "MaxCars = 1",
    'ResourceFolder = "Resources"',
    "LogChat = true",
    "Debug = false",
    "",
    "[Misc]",
    "ImScaredOfUpdates = true",
    'UpdateReminderTime = "30s"',
    "",
  ].join("\n");
}

function findResource(name: string, search: string[]): string | null {
  for (const dir of search) {
    const p = join(dir, name);
    if (existsSync(join(p, "scriptgo.lua")) || existsSync(join(p, "open77.lua"))) return p;
  }
  return null;
}

/** The resource and its dependency closure, dependencies first. */
export function beammpClosure(root: LoadedResource, search: string[]): { order: LoadedResource[]; missing: string[] } {
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

/** What a BeamMP server cannot run of this resource, as warnings (nothing here is fatal). */
export function beammpWarnings(m: ParsedManifest): string[] {
  const w: string[] = [];
  if (m.clientScripts.length > 0) {
    w.push("client_script files are shipped but never run: BeamMP plugins are server-side, and BeamNG.drive client mods are not a SCRIPT//GO target yet");
  }
  if (m.environments.length > 0 && !m.environments.includes("beammp")) {
    w.push("the manifest does not list beammp in environments; the package is untested there");
  }
  if (m.lua.length > 0 && !m.lua.includes("5.3")) {
    w.push(`the manifest's lua list (${m.lua.join(", ")}) does not include 5.3, the Lua of BeamMP-Server`);
  }
  const caps = new Set([...m.capabilities, ...m.optionalCapabilities]);
  if (caps.has("http") || caps.has("licensing")) {
    w.push("ScriptGo.http and licensing need curl on the server's PATH (the plugin runs it in the background); scriptgo.json \"http\": false turns them off");
  }
  return w;
}

export interface BeamMPPack {
  dest: string;
  resources: string[];
  warnings: string[];
  errors: { code: string; message: string }[];
}

/**
 * `scriptgo pack --target beammp`: writes `<out>/Resources/Server/scriptgo/`, the plugin with the
 * resource and its dependencies in resources/. Copy `Resources` over the server's folder.
 */
export function packForBeamMP(res: LoadedResource, out: string, search: string[], config?: Record<string, unknown>): BeamMPPack {
  if (!res.result.ok) return { dest: "", resources: [], warnings: [], errors: res.result.errors };
  const m = res.result.manifest;
  const problems = validateResourceFiles(m, listFiles(res.root));
  if (problems.length > 0) return { dest: "", resources: [], warnings: [], errors: problems };
  const { order, missing } = beammpClosure(res, search);
  if (missing.length > 0) {
    return { dest: "", resources: [], warnings: [], errors: missing.map((d) => ({ code: "dependency_missing", message: `dependency ${d} not found in the search paths` })) };
  }
  const warnings = beammpWarnings(m);
  // Packing into an existing plugin adds or replaces these resources and keeps the others.
  const dest = buildPlugin(join(out, "Resources", "Server", PLUGIN_NAME), order.map((r) => r.root), config, { merge: true }) as string;
  return { dest, resources: order.map((r) => (r.result.ok ? r.result.manifest.name : basename(r.root))), warnings, errors: [] };
}

/** Local addresses listening on TCP `port` (netstat on Windows, ss elsewhere); null if unknown. */
export function listeningAddresses(port: number): string[] | null {
  const win = process.platform === "win32";
  const r = win ? spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" }) : spawnSync("ss", ["-ltnH"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  const out: string[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    const local = win ? (cols[0] === "TCP" && /LISTENING/i.test(line) ? cols[1] : undefined) : cols[3];
    if (!local) continue;
    const m = /^(.*):(\d+)$/.exec(local);
    if (m && Number(m[2]) === port) out.push(m[1]!.replace(/^\[|\]$/g, ""));
  }
  return out;
}

function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function verifyBeamMP(
  res: LoadedResource,
  m: ParsedManifest,
  search: string[],
  opts: {
    server?: string | null; port?: number; seconds?: number; timeoutMs?: number; authKey?: string; stub?: ApiTarget; example?: ReadmeExample | null;
    /** Unit tests only: another process in place of BeamMP-Server, given the server folder. */
    launch?: { command: string; args: (serverFolder: string) => string[] };
  },
): Promise<BeamMPReport> {
  const started = Date.now();
  const port = opts.port ?? BEAMMP_PORT;
  const seconds = opts.seconds ?? 3;
  const checks: Check[] = [];
  const adapterVersion = beammpAdapterVersion();
  // Packing alone proves nothing about the runtime: without a server run the report is skipped.
  const report = (log = "", evidence: Record<string, unknown> = {}, extra: Partial<BeamMPReport> = {}): BeamMPReport => {
    const failed = checks.some((c) => c.status === "failed");
    const ran = checks.some((c) => c.name === "server_run" && c.status === "passed");
    return {
      package: m.name, version: m.version, environment: "beammp", status: failed ? "failing" : ran ? "verified" : "skipped",
      runtimeVersion: "", adapterVersion, luaVersion: "", durationMs: Date.now() - started, checks, log, evidence, ...extra,
    };
  };

  const { order, missing } = beammpClosure(res, search);
  if (missing.length > 0) {
    checks.push({ name: "dependencies_resolved", status: "failed", message: missing.join(", ") });
    return report();
  }
  const server = opts.server ?? findBeamMPServer();
  if (!server) {
    checks.push({ name: "server_run", status: "skipped", message: "no BeamMP-Server binary: pass --beammp-server, set SCRIPTGO_BEAMMP_SERVER or put it in tools/runtimes/beammp" });
    return report();
  }
  const authKey = opts.authKey ?? process.env.BEAMMP_AUTH_KEY ?? "";
  if (!authKey.trim()) {
    checks.push({
      name: "server_run", status: "skipped",
      message: "BeamMP-Server refuses to start without an AuthKey: the server owner gets one at https://keymaster.beammp.com and sets BEAMMP_AUTH_KEY (never commit it)",
    });
    return report();
  }
  const busy = listeningAddresses(port);
  if (busy && busy.length > 0) {
    checks.push({ name: "server_run", status: "failed", message: `port ${port} is already in use (${busy.join(", ")})` });
    return report();
  }

  const run = mkdtempSync(join(tmpdir(), "scriptgo-beammp-"));
  const reportName = "scriptgo-verify-report.json";
  const pluginDir = join(run, "Resources", "Server", PLUGIN_NAME);
  const scrubs: [string, string][] = [[authKey, "<auth_key>"], [run, "<run>"], [run.split("\\").join("/"), "<run>"]];
  if (opts.stub) scrubs.push([opts.stub.licenseKey, "<license_key>"], [opts.stub.url, "<stub-api>"]);
  const scrub = (s: string): string => scrubs.reduce((acc, [from, to]) => (from ? acc.split(from).join(to) : acc), s);
  const lines: string[] = [];
  let child: ChildProcess | null = null;
  const firstRequest = opts.stub?.requests.length ?? 0;
  try {
    const stub = opts.stub;
    const config: Record<string, unknown> = {
      verify: { resource: m.name, seconds, report: reportName, ...(opts.example ? { with: opts.example.name } : {}), exit: false },
      ...(stub
        ? {
            resources: { [m.name]: { api: stub.url, license_key: stub.licenseKey } },
            convars: { scriptgo_api: stub.url },
            httpAllowedHosts: [new URL(stub.url).hostname],
          }
        : {}),
    };
    const dirs = order.map((r) => r.root);
    if (opts.example) dirs.push(opts.example.dir);
    buildPlugin(pluginDir, dirs, config);
    mkdirSync(join(run, "Resources", "Client"), { recursive: true });
    writeFileSync(join(run, "ServerConfig.toml"), beammpServerConfig(port));

    // Only the key reaches the server from the environment: any other BEAMMP_* variable would
    // override ServerConfig.toml (port, IP, privacy).
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^BEAMMP_/i.test(k)) env[k] = v;
    env.BEAMMP_AUTH_KEY = authKey;
    const [command, argv] = opts.launch
      ? [opts.launch.command, opts.launch.args(run)]
      : [server, [`--working-directory=${run}`, `--config=${join(run, "ServerConfig.toml")}`]];
    child = spawn(command, argv, { cwd: run, env, stdio: ["pipe", "pipe", "pipe"] });
    const onData = (chunk: Buffer): void => {
      for (const raw of chunk.toString("utf8").split(/\r?\n/)) {
        // eslint-disable-next-line no-control-regex
        const line = scrub(raw.replace(/\x1b\[[0-9;]*m/g, "")).trimEnd();
        if (line.trim()) lines.push(line);
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    let exitCode: number | null | undefined;
    const exited = new Promise<void>((done) => child!.on("exit", (code) => { exitCode = code; done(); }));
    child.on("error", (e) => { lines.push(`spawn error: ${String(e)}`); });

    const reportPath = join(pluginDir, reportName);
    const deadline = Date.now() + (opts.timeoutMs ?? 60000) + seconds * 1000;
    while (Date.now() < deadline && exitCode === undefined && !existsSync(reportPath)) await sleep(200);
    // The plugin writes the report in one call; give the file a moment, then look at the sockets.
    await sleep(300);
    const listening = exitCode === undefined ? listeningAddresses(port) : null;

    // Stop: the console's own `exit`, then a kill.
    if (exitCode === undefined) {
      child.stdin!.write("exit\n");
      const stopBy = Date.now() + 15000;
      while (exitCode === undefined && Date.now() < stopBy) await sleep(200);
    }
    const graceful = exitCode !== undefined;
    if (exitCode === undefined) child.kill();
    await exited;

    const all = lines.join("\n");
    const version = /BeamMP-Server v?(\d+\.\d+\.\d+)/.exec(all)?.[1] ?? "";
    let pluginReport: BeamMPReport | null = null;
    try {
      pluginReport = JSON.parse(readFileSync(reportPath, "utf8")) as BeamMPReport;
    } catch {
      pluginReport = null;
    }
    if (!pluginReport) {
      checks.push({ name: "server_run", status: "failed", message: `no report from the plugin (server exit ${exitCode ?? "killed"}): ${lines.filter((l) => /ERROR|error/.test(l)).slice(-1)[0] ?? "see the log"}` });
      return report(lines.slice(-80).join("\n"), { serverBinary: basename(server) });
    }
    checks.push({ name: "server_run", status: "passed", message: `BeamMP-Server ran the plugin${/ALL SYSTEMS STARTED SUCCESSFULLY/.test(all) ? "; all systems started" : ""}` });
    checks.push(...pluginReport.checks.map((c) => ({ ...c, message: scrub(c.message ?? "") })));
    if (listening === null) {
      checks.push({ name: "listens_on_loopback_only", status: "skipped", message: "could not list listening sockets" });
    } else {
      const ok = listening.length > 0 && listening.every((a) => a === "127.0.0.1");
      checks.push({ name: "listens_on_loopback_only", status: ok ? "passed" : "failed", message: listening.length > 0 ? `TCP ${port} on ${[...new Set(listening)].join(", ")}` : `nothing listened on TCP ${port}` });
    }
    // Lua errors BeamMP logged itself (outside the host's own error handling) for this plugin.
    const luaErrors = lines.filter((l) => /LUA ERROR|\[ERROR\].*(scriptgo|Resources[\\/]Server)/i.test(l));
    checks.push({ name: "no_plugin_errors", status: luaErrors.length === 0 ? "passed" : "failed", message: luaErrors[0] ?? "" });
    if (stub) checks.push(...apiChecks(stub.requests, firstRequest, "beammp", adapterVersion));
    const log = [scrub(pluginReport.log ?? ""), "--- server", ...lines.filter((l) => /scriptgo|ERROR|WARN|Lua|LUA|SYSTEMS|BeamMP-Server v/.test(l)).slice(-120)].join("\n");
    return report(log, {
      ...(pluginReport.evidence ?? {}),
      serverBinary: basename(server),
      serverSha256: opts.launch ? "" : sha256File(server),
      resources: dirs.map((d) => basename(d)),
      stoppedBy: graceful ? "console exit" : "kill",
      ...(stub ? { api: stub.label } : {}),
      ...(opts.example ? { readme_example: `${opts.example.name}: the runnable Lua block of README.md` } : {}),
    }, {
      runtimeVersion: version ? `BeamMP-Server ${version}` : pluginReport.runtimeVersion,
      luaVersion: pluginReport.luaVersion,
      adapterVersion: pluginReport.adapterVersion || adapterVersion,
    });
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill();
    // The server rewrites ServerConfig.toml with the key it read: the run folder never survives.
    rmSync(run, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

/** `scriptgo pack <dir> --target beammp`: prints warnings and errors, returns the exit code. */
export function packBeamMPCommand(res: LoadedResource, out: string): number {
  const search = [resolve(res.root, ".."), ...defaultSearchPaths()];
  const r = packForBeamMP(res, out, search);
  for (const w of r.warnings) console.log(`warning ${w}`);
  for (const e of r.errors) console.error(`error ${e.code}: ${e.message}`);
  if (r.errors.length > 0) return 1;
  console.log(`packed for BeamMP (${r.resources.join(", ")}) -> ${r.dest}`);
  console.log("copy the Resources folder over the server's folder; the plugin starts with the server");
  return 0;
}
