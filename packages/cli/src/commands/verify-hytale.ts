// scriptgo verify --env hytale: the real Hytale dedicated server, run on loopback with the
// SCRIPT//GO plugin in verify mode.
//
// The server is never downloaded here. Its files (HytaleServer.jar and Assets.zip) come only with
// a Hytale account and under the Hytale EULA, so the owner supplies them: --hytale-server <folder>,
// SCRIPTGO_HYTALE_SERVER or tools/runtimes/hytale (sdk/adapters/hytale/SETUP.md). Without them, or
// without a Java 25, or without the plugin built against that server, the run is skipped, never
// verified.
//
// A run gets its own folder next to the server (scriptgo-runs/<stamp>, removed afterwards unless
// SCRIPTGO_HYTALE_KEEP=1): mods/ holds the plugin, resources/ the resource, its dependencies and the
// README example. The server starts there in offline auth mode (nobody can join: verification needs
// no player and no account), bound to 127.0.0.1, Sentry and updates off. The plugin reads
// -Dscriptgo.* properties, runs the resource, writes the report and stops the server. Only the
// server half runs: there is no client half and no game client is started.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParsedManifest } from "@scriptgo/manifest";
import { readResource, repoRoot, type LoadedResource } from "../lib/sdk.ts";
import type { ReadmeExample } from "../lib/readme-example.ts";
import type { StubRequest } from "../lib/stub-api.ts";
import { apiChecks } from "./verify.ts";

export const HYTALE_ADAPTER_VERSION = "hytale-0.1.0";
export const HYTALE_PORT = 5521;
/** The jar `./mvnw package -Dhytale.server.jar=...` builds in sdk/adapters/hytale. */
export const HYTALE_PLUGIN = join(repoRoot, "sdk", "adapters", "hytale", "plugin", "target", "scriptgo-hytale-0.1.0.jar");
export const HYTALE_HELP = "[--hytale-server dir] [--hytale-java path\\to\\java25] [--hytale-plugin jar] [--hytale-seconds 5] [--hytale-port 5521] [--hytale-timeout 300000]";

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

interface ApiTarget {
  url: string;
  licenseKey: string;
  requests: StubRequest[];
  label: string;
}

/** The folder holding HytaleServer.jar and Assets.zip, or null. */
export function findHytaleServer(flag?: string): string | null {
  for (const p of [flag, process.env.SCRIPTGO_HYTALE_SERVER, join(repoRoot, "tools", "runtimes", "hytale")]) {
    if (!p) continue;
    const dir = resolve(p);
    if (existsSync(join(dir, "HytaleServer.jar")) && existsSync(join(dir, "Assets.zip"))) return dir;
    if (p === flag || p === process.env.SCRIPTGO_HYTALE_SERVER) return null; // named but incomplete: do not guess further
  }
  return null;
}

/** Major version from `java -version` output ("openjdk version \"25.0.1\"" -> 25; "1.8.0" -> 8). */
export function javaMajor(versionOutput: string): number {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (!m) return 0;
  const first = Number(m[1]);
  return first === 1 && m[2] ? Number(m[2]) : first;
}

/** A Java 25 or newer: --hytale-java, SCRIPTGO_HYTALE_JAVA, JAVA_HOME, then java on the PATH. */
export function findJava25(flag?: string): { java: string; version: string } | { java: null; tried: string[] } {
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const candidates = [flag, process.env.SCRIPTGO_HYTALE_JAVA, process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", exe) : undefined, "java"]
    .filter((c): c is string => Boolean(c));
  const tried: string[] = [];
  for (const c of candidates) {
    const r = spawnSync(c, ["-version"], { encoding: "utf8" });
    const text = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    const major = r.status === 0 ? javaMajor(text) : 0;
    tried.push(`${c}: ${major ? `Java ${major}` : "not runnable"}`);
    if (major >= 25) return { java: c, version: text.split(/\r?\n/)[0]!.trim() };
    if (c === flag) break; // an explicit choice is not second-guessed
  }
  return { java: null, tried };
}

/** The java command line of a verify run (exported for tests). */
export function hytaleArgs(o: {
  server: string; run: string; resource: string; with?: string; seconds: number; port: number; config?: string;
}): string[] {
  return [
    `-Dscriptgo.resources=${join(o.run, "resources")}`,
    `-Dscriptgo.verify=${o.resource}`,
    ...(o.with ? [`-Dscriptgo.verify.with=${o.with}`] : []),
    `-Dscriptgo.verify.seconds=${o.seconds}`,
    `-Dscriptgo.verify.report=${join(o.run, "report.json")}`,
    ...(o.config ? [`-Dscriptgo.config=${o.config}`] : []),
    "-jar", join(o.server, "HytaleServer.jar"),
    "--assets", join(o.server, "Assets.zip"),
    "--bind", `127.0.0.1:${o.port}`,
    "--auth-mode", "offline",
    "--disable-sentry",
  ];
}

function sha256(p: string): Promise<string> {
  return new Promise((done, fail) => {
    const h = createHash("sha256");
    createReadStream(p).on("data", (c) => h.update(c)).on("end", () => done(h.digest("hex"))).on("error", fail);
  });
}

function findResource(name: string, search: string[]): string | null {
  for (const dir of search) {
    const p = join(dir, name);
    if (existsSync(join(p, "scriptgo.lua")) || existsSync(join(p, "open77.lua"))) return p;
  }
  return null;
}

/** The resource and its dependencies (dependencies first), and the names not found. */
function closure(root: LoadedResource, search: string[]): { order: LoadedResource[]; missing: string[] } {
  const order: LoadedResource[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const visit = (res: LoadedResource): void => {
    if (!res.result.ok || seen.has(res.result.manifest.name)) return;
    seen.add(res.result.manifest.name);
    for (const dep of res.result.manifest.dependencies) {
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

/** Runs java until it exits; after the report appears it gets `graceMs` to stop, then `stop`, then a kill. */
function runServer(java: string, argv: string[], cwd: string, report: string, timeoutMs: number, graceMs = 30000):
  Promise<{ status: number | null; output: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn(java, argv, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HYTALE_DISABLE_UPDATES: "1" } });
    let output = "";
    let timedOut = false;
    let reportSeenAt = 0;
    const onData = (c: Buffer): void => {
      output += c.toString("utf8");
      if (output.length > 4_000_000) output = output.slice(-2_000_000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const started = Date.now();
    const stop = (): void => {
      try { child.stdin.write("stop\n"); } catch { /* already closed */ }
      setTimeout(() => { if (child.exitCode === null) child.kill(); }, 15000).unref();
    };
    const poll = setInterval(() => {
      if (!reportSeenAt && existsSync(report)) reportSeenAt = Date.now();
      if (reportSeenAt && Date.now() - reportSeenAt > graceMs) { clearInterval(poll); stop(); }
      else if (Date.now() - started > timeoutMs) { timedOut = true; clearInterval(poll); stop(); }
    }, 250);
    child.on("error", (e) => { clearInterval(poll); done({ status: null, output: output + String(e), timedOut }); });
    child.on("close", (status) => { clearInterval(poll); done({ status, output, timedOut }); });
  });
}

export async function verifyHytale(
  res: LoadedResource, m: ParsedManifest, search: string[], flags: Record<string, string>,
  example?: ReadmeExample | null, stub?: ApiTarget,
): Promise<Report> {
  const started = Date.now();
  const base = (status: Report["status"], checks: Check[], log = "", evidence: Record<string, unknown> = {}): Report => ({
    package: m.name, version: m.version, environment: "hytale", status, runtimeVersion: "", adapterVersion: HYTALE_ADAPTER_VERSION,
    luaVersion: "", durationMs: Date.now() - started, checks, log, evidence,
  });
  const skip = (message: string): Report => base("skipped", [{ name: "server_run", status: "skipped", message }]);

  const server = findHytaleServer(flags["hytale-server"]);
  if (!server) {
    return skip("no Hytale server: pass --hytale-server <folder with HytaleServer.jar and Assets.zip> or SCRIPTGO_HYTALE_SERVER; "
      + "the files come with the owner's Hytale account (sdk/adapters/hytale/SETUP.md)");
  }
  const java = findJava25(flags["hytale-java"]);
  if (java.java === null) return skip(`no Java 25 or newer (the Hytale server needs it): pass --hytale-java or SCRIPTGO_HYTALE_JAVA; tried ${java.tried.join("; ")}`);
  const plugin = resolve(flags["hytale-plugin"] ?? HYTALE_PLUGIN);
  if (!existsSync(plugin) || /STUBS/i.test(plugin)) {
    return skip("plugin not built against the server: in sdk/adapters/hytale run "
      + "./mvnw package -Dhytale.server.jar=<server>/HytaleServer.jar with a JDK 25, or pass --hytale-plugin");
  }
  const { order, missing } = closure(res, search);
  if (missing.length > 0) {
    return base("failing", [{ name: "dependencies_resolved", status: "failed", message: missing.join(", ") }, { name: "server_run", status: "skipped", message: "dependencies missing" }]);
  }

  const seconds = Number(flags["hytale-seconds"] ?? 5);
  const port = Number(flags["hytale-port"] ?? HYTALE_PORT);
  const timeoutMs = Number(flags["hytale-timeout"] ?? 300000);
  const run = join(server, "scriptgo-runs", `${m.name}-${Date.now()}`);
  mkdirSync(join(run, "mods"), { recursive: true });
  mkdirSync(join(run, "resources"), { recursive: true });
  cpSync(plugin, join(run, "mods", "scriptgo-hytale.jar"));
  for (const r of order) if (r.result.ok) cpSync(r.root, join(run, "resources", r.result.manifest.name), { recursive: true });
  if (example) cpSync(example.dir, join(run, "resources", example.name), { recursive: true });
  let config: string | undefined;
  const firstRequest = stub?.requests.length ?? 0;
  if (stub) {
    // The plugin's HTTP is off unless the operator allows hosts: allow the stub's only.
    config = join(run, "scriptgo.json");
    writeFileSync(config, JSON.stringify({
      http: { allowedHosts: [new URL(stub.url).hostname] },
      resources: { [m.name]: { api: stub.url, license_key: stub.licenseKey } },
      convars: { scriptgo_api: stub.url },
    }));
  }
  const reportFile = join(run, "report.json");
  const argv = hytaleArgs({ server, run, resource: m.name, with: example?.name, seconds, port, config });
  const r = await runServer(java.java, argv, run, reportFile, timeoutMs);

  const engineLog = r.output.split(/\r?\n/)
    .filter((l) => /scriptgo|SEVERE|ERROR|Exception|Caused by|plugin/i.test(l)).slice(-300).join("\n");
  const evidence: Record<string, unknown> = {
    "server-sha256": await sha256(join(server, "HytaleServer.jar")),
    "plugin-sha256": await sha256(plugin),
    java: java.version,
    "auth-mode": "offline (loopback, no player)",
    ...(example ? { readme_example: `${example.name}: the runnable Lua block of README.md` } : {}),
    ...(stub ? { api: stub.label } : {}),
  };
  let report: Report;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8")) as Report;
    report.log = [report.log, "--- server", engineLog].filter(Boolean).join("\n");
    report.evidence = { ...report.evidence, ...evidence };
    if (r.timedOut) report.checks.push({ name: "server_stopped", status: "failed", message: `the server did not stop within ${timeoutMs} ms` });
  } catch {
    const why = r.timedOut ? `timed out after ${timeoutMs} ms` : `exit ${r.status}`;
    report = base("failing", [{ name: "server_run", status: "failed", message: `no report written (${why})` }], engineLog, evidence);
  }
  if (stub) {
    report.checks.push(...apiChecks(stub.requests, firstRequest, "hytale", report.adapterVersion));
    report.log = report.log.split(stub.licenseKey).join("<license_key>").split(stub.url).join("<stub-api>");
  }
  // Stored logs carry no local paths: the run and server folders get labels (verify.ts scrubs the rest).
  for (const [p, label] of [[run, "<run>"], [server, "<hytale-server>"]] as const) {
    for (const form of [p, p.split("\\").join("/"), p.split("/").join("\\")]) {
      report.log = report.log.split(form).join(label);
      for (const c of report.checks) c.message = c.message.split(form).join(label);
    }
  }
  report.status = report.checks.some((c) => c.status === "failed") ? "failing" : "verified";
  report.durationMs = Date.now() - started;
  if (process.env.SCRIPTGO_HYTALE_KEEP !== "1") rmSync(run, { recursive: true, force: true });
  return report;
}
