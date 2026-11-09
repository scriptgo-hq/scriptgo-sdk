// `scriptgo verify --env cctweaked`: one real Minecraft: Java Edition server (Fabric + CC: Tweaked,
// the versions pinned in sdk/adapters/cctweaked/runtime.mjs), bound to 127.0.0.1, with a throwaway
// flat world. A ComputerCraft computer whose disk holds the SCRIPT//GO core, the adapter and the
// resources is placed with /setblock; it boots, runs `sg verify` and writes the report on its disk.
//
// The operator must accept the Minecraft EULA themselves: `--accept-minecraft-eula` (or eula=true
// written by hand) in server/eula.txt of the runtime (tools/runtimes/minecraft, or
// SCRIPTGO_MINECRAFT_DIR). Without it the run is skipped before anything is downloaded from Mojang
// or started. The cc-core harness (no Minecraft) is never used here.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { CompatibilityRunSchema } from "@scriptgo/shared";
// @ts-expect-error plain ESM build script without type declarations
import { buildVerifyComputer } from "../../../../sdk/adapters/cctweaked/build.mjs";
import {
  CC_TWEAKED_VERSION,
  EULA_URL,
  FABRIC_LOADER_VERSION,
  MINECRAFT_VERSION,
  PINS,
  VANILLA_SERVER,
  checkRuntime,
  eulaState,
  findJava,
  runtimeDir,
  serverDir,
  sha1File,
  sha256File,
  shown,
  // @ts-expect-error plain ESM script without type declarations
} from "../../../../sdk/adapters/cctweaked/runtime.mjs";
import { repoRoot } from "./sdk.ts";

export interface CcCheck {
  name: string;
  status: "passed" | "failed" | "skipped";
  message: string;
}

export interface CcReport {
  package: string;
  version: string;
  environment: string;
  status: "verified" | "failing" | "skipped";
  runtimeVersion: string;
  adapterVersion: string;
  luaVersion: string;
  durationMs: number;
  checks: CcCheck[];
  log: string;
  evidence: Record<string, unknown>;
}

export const CC_EULA_URL: string = EULA_URL;

/** Why a run cannot start on this machine, or null when it can (runtime complete, EULA accepted by the owner). */
export function ccTweakedBlocker(root: string = repoRoot): string | null {
  const bad = (checkRuntime(root) as { ok: boolean; pin: { id: string } }[]).filter((r) => !r.ok);
  if (bad.length > 0) return `runtime incomplete (${bad.map((b) => b.pin.id).join(", ")}): run node sdk/adapters/cctweaked/runtime.mjs`;
  if (!findJava(root)) return "no Java in the runtime's jdk folder: run node sdk/adapters/cctweaked/runtime.mjs";
  const eula = eulaState(root) as { accepted: boolean; file: string };
  if (!eula.accepted) {
    return `needs the operator's own acceptance of the Minecraft EULA (${EULA_URL}). Nothing was downloaded from Mojang and no server ran. ` +
      `After reading it, the operator accepts it by passing --accept-minecraft-eula (or by writing eula=true to ${shown(eula.file, root) as string}).`;
  }
  return null;
}

/**
 * The operator's acceptance of the Minecraft EULA, given on the command line
 * (`--accept-minecraft-eula`): writes eula=true into the runtime's server/eula.txt, outside the
 * repository's tracked files. Nothing calls this without that flag.
 */
export function acceptMinecraftEula(root: string = repoRoot, now: Date = new Date()): string {
  const file = (eulaState(root) as { file: string }).file;
  mkdirSync(serverDir(root) as string, { recursive: true });
  writeFileSync(file, [
    `# Accepted by the operator with scriptgo verify --accept-minecraft-eula on ${now.toISOString()}`,
    `# ${EULA_URL}`,
    "eula=true",
    "",
  ].join("\n"));
  return file;
}

/**
 * server.properties of a verify run: loopback only, nobody can join (white-list on, empty), no
 * status, query or RCON listener, a small flat world.
 */
export function minecraftServerProperties(port: number): string {
  return [
    "# Written by scriptgo verify --env cctweaked for each run.",
    "server-ip=127.0.0.1",
    `server-port=${port}`,
    "online-mode=true",
    "white-list=true",
    "enforce-whitelist=true",
    "max-players=1",
    "enable-status=false",
    "enable-query=false",
    "enable-rcon=false",
    "enable-jmx-monitoring=false",
    "enable-command-block=false",
    "level-type=minecraft\\:flat",
    "generate-structures=false",
    "allow-nether=false",
    "spawn-npcs=false",
    "spawn-animals=false",
    "spawn-monsters=false",
    "spawn-protection=0",
    "view-distance=4",
    "simulation-distance=4",
    "sync-chunk-writes=false",
    "motd=SCRIPT//GO verify run (not an official Minecraft server)",
    "",
  ].join("\n");
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => done(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CcTweakedRunOptions {
  root?: string;
  pkg: { name: string; version: string };
  /** Every resource the computer gets, dependencies included: { name, dir }. */
  resources: { name: string; dir: string }[];
  /** The resource under test (started first) and an optional one started after it (README example). */
  resource: string;
  withResource: string | null;
  /** How long the host runs on the computer, in computer seconds. */
  seconds: number;
  /** Server start (the first start downloads the vanilla server and libraries). */
  readyTimeoutMs: number;
  /** From the computer's placement to its report. */
  reportTimeoutMs: number;
  log?: (line: string) => void;
}

export async function verifyCcTweaked(o: CcTweakedRunOptions): Promise<CcReport> {
  const root = o.root ?? repoRoot;
  const started = Date.now();
  const base = (status: CcReport["status"], checks: CcCheck[], log = "", evidence: Record<string, unknown> = {}): CcReport => ({
    package: o.pkg.name, version: o.pkg.version, environment: "cctweaked", status,
    runtimeVersion: "", adapterVersion: "", luaVersion: "", durationMs: Date.now() - started, checks, log, evidence,
  });
  const blocker = ccTweakedBlocker(root);
  if (blocker) return base("skipped", [{ name: "server_run", status: "skipped", message: blocker }]);

  const java = findJava(root) as string;
  const server = serverDir(root) as string;
  // The world lives next to the server (SCRIPTGO_MINECRAFT_DIR can put both on another disk).
  const runtime = runtimeDir(root) as string;
  mkdirSync(join(runtime, "worlds"), { recursive: true });
  const universe = mkdtempSync(join(runtime, "worlds", "run-"));
  const world = join(universe, "sgverify");
  const computer = buildVerifyComputer(join(world, "computercraft", "computer", "0"), {
    resources: o.resources, resource: o.resource, seconds: o.seconds, withResource: o.withResource,
  }) as { dir: string; bytes: number; report: string };
  const port = await freePort();
  writeFileSync(join(server, "server.properties"), minecraftServerProperties(port));

  const lines: string[] = [];
  let exited: number | null | undefined;
  const child = spawn(java, ["-Xms512M", "-Xmx2G", "-jar", "fabric-server-launch.jar", "--nogui", "--universe", universe, "--world", "sgverify"], {
    cwd: server, stdio: ["pipe", "pipe", "pipe"],
  });
  const take = (chunk: Buffer): void => {
    for (const l of chunk.toString("utf8").split(/\r?\n/)) {
      if (!l) continue;
      lines.push(l);
      if (lines.length > 4000) lines.shift();
      o.log?.(l);
    }
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("exit", (code) => { exited = code; });
  child.on("error", () => { exited ??= null; });
  child.stdin.on("error", () => { /* the server is gone; the exit handler records it */ });
  const send = (cmd: string): void => { if (exited === undefined) child.stdin.write(cmd + "\n"); };
  const waitFor = async (re: RegExp, ms: number, from = 0): Promise<string | null> => {
    const end = Date.now() + ms;
    while (Date.now() < end && exited === undefined) {
      for (let i = from; i < lines.length; i++) if (re.test(lines[i]!)) return lines[i]!;
      await sleep(250);
    }
    for (let i = from; i < lines.length; i++) if (re.test(lines[i]!)) return lines[i]!;
    return null;
  };

  const checks: CcCheck[] = [];
  let report: CcReport | null = null;
  try {
    const ready = await waitFor(/\]: Done \([\d.,]+s\)!/, o.readyTimeoutMs);
    if (!ready) {
      checks.push({ name: "server_run", status: "failed", message: exited !== undefined ? `the server exited (${exited}) before it was ready` : `not ready after ${Math.round(o.readyTimeoutMs / 1000)} s` });
    } else {
      checks.push({ name: "server_run", status: "passed", message: `Minecraft ${MINECRAFT_VERSION}, Fabric loader ${FABRIC_LOADER_VERSION}, CC: Tweaked ${CC_TWEAKED_VERSION} on 127.0.0.1:${port} (${ready.replace(/^.*\]: /, "")})` });
      const mark = lines.length;
      send("forceload add 0 0");
      send("setblock 0 100 0 computercraft:computer_normal{ComputerId:0,On:1b}");
      const placed = await waitFor(/Changed the block at 0, 100, 0|Could not set the block|Unknown block type/, 20_000, mark);
      const ok = !!placed && /Changed the block/.test(placed);
      checks.push({ name: "computer_placed", status: ok ? "passed" : "failed", message: placed ? placed.replace(/^.*\]: /, "") : "no answer to /setblock" });
      if (ok) {
        const end = Date.now() + o.reportTimeoutMs;
        while (Date.now() < end && exited === undefined) {
          if (existsSync(computer.report)) {
            try {
              const run = CompatibilityRunSchema.parse(JSON.parse(readFileSync(computer.report, "utf8")));
              report = {
                package: run.package, version: run.version, environment: "cctweaked", status: run.status as CcReport["status"],
                runtimeVersion: run.runtimeVersion ?? "", adapterVersion: run.adapterVersion ?? "", luaVersion: run.luaVersion ?? "",
                durationMs: run.durationMs ?? 0, checks: run.checks.map((c) => ({ name: c.name, status: c.status as CcCheck["status"], message: c.message ?? "" })),
                log: run.log ?? "", evidence: Object.fromEntries(run.evidence.map((e) => [e.kind, e.path])),
              };
              break;
            } catch {
              // Still being written: the computer writes a temporary file, then moves it.
            }
          }
          await sleep(500);
        }
        if (!report) checks.push({ name: "computer_report", status: "failed", message: `no report from the computer after ${Math.round(o.reportTimeoutMs / 1000)} s` });
      }
    }
  } finally {
    send("stop");
    const end = Date.now() + 60_000;
    while (exited === undefined && Date.now() < end) await sleep(250);
    if (exited === undefined) child.kill();
  }

  const hide = (t: string): string => [runtime, runtime.split("\\").join("/")].reduce((acc, p) => acc.split(p).join("<minecraft-runtime>"), t);
  const serverLog = lines.filter((l) => /ERROR|Exception|computercraft|ComputerCraft|SCRIPT\/\/GO|Done \(/i.test(l)).slice(-200).map(hide).join("\n");
  // Where Fabric's launcher keeps the vanilla server it downloaded (its DATA_DIR, "%s-server.jar").
  const vanilla = join(server, ".fabric", "server", `${MINECRAFT_VERSION}-server.jar`);
  const vanillaSha1 = existsSync(vanilla) ? (sha1File(vanilla) as string) : "";
  const pinSha = (id: string): string => (PINS as { id: string; sha256: string; dest: string }[]).filter((p) => p.id === id).map((p) => sha256File(join(server, "..", p.dest)) as string)[0] ?? "";
  const evidence: Record<string, unknown> = {
    bind: "127.0.0.1 only (server-ip); white-list on and empty; status, query and RCON off",
    minecraft_server_sha1: vanillaSha1,
    fabric_server_launcher_sha256: pinSha("fabric-server-launcher"),
    fabric_api_sha256: pinSha("fabric-api"),
    cc_tweaked_sha256: pinSha("cc-tweaked"),
    computer_disk: `${computer.bytes} bytes`,
  };
  checks.push({
    name: "minecraft_server_jar",
    status: vanillaSha1 === VANILLA_SERVER.sha1 ? "passed" : "failed",
    message: vanillaSha1 ? `${MINECRAFT_VERSION}-server.jar SHA-1 ${vanillaSha1}${vanillaSha1 === VANILLA_SERVER.sha1 ? ` (Mojang's ${MINECRAFT_VERSION} server)` : `, expected ${VANILLA_SERVER.sha1}`}` : `${MINECRAFT_VERSION}-server.jar not found in .fabric/server`,
  });
  if (report) {
    // _HOST names Minecraft only inside a real Minecraft world: the harness says "no Minecraft".
    const inMinecraft = /, Minecraft /.test(report.runtimeVersion) && !/no Minecraft/.test(report.runtimeVersion);
    checks.push({ name: "minecraft_host", status: inMinecraft ? "passed" : "failed", message: String(report.evidence.host ?? report.runtimeVersion) });
    report.checks = [...checks, ...report.checks];
    report.log = [report.log, "--- server", serverLog].filter(Boolean).join("\n");
    report.evidence = { ...report.evidence, ...evidence };
  } else {
    report = base("failing", checks, serverLog, evidence);
  }
  rmSync(universe, { recursive: true, force: true });
  report.status = report.checks.some((c) => c.status === "failed") ? "failing" : report.checks.every((c) => c.status === "skipped") ? "skipped" : "verified";
  report.durationMs = Date.now() - started;
  return report;
}
