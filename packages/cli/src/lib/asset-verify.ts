// `scriptgo verify --env luanti|garrysmod` for a package with assets: the packed delivery form in
// the real server, with evidence that the engine picked each file up (docs/spec/assets.md,
// "Verification"). Only servers run here: no game client downloads anything, so a client-side
// load is not proven by these runs.
//
//   luanti     the media mod from `scriptgo pack --target luanti` in a throwaway game, in the official
//              server image (no network). With --verbose the server logs one line per media file it
//              announces to clients, `Server: <sha1> is <name>`: every delivered file must appear
//              with the SHA-1 of its bytes.
//   garrysmod  the content addon from `scriptgo pack --target garrysmod` in a dedicated srcds
//              folder: its generated autorun checks each file in the GAME file system and adds it
//              to the download list, and prints how many it added. Every file must be found.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedManifest } from "@scriptgo/manifest";
import { findGarrysmodServer, luaErrors, srcdsArgs, startSrcds } from "../commands/verify-garrysmod.ts";
import { luantiMediaModName, packForLuanti } from "./asset-targets.ts";
import { planAssets } from "./assets.ts";
import { packForGarrysmod } from "./garrysmod.ts";
import type { LoadedResource } from "./sdk.ts";

export interface AssetCheck {
  name: string;
  status: "passed" | "failed" | "skipped";
  message: string;
}

export interface AssetReport {
  package: string;
  version: string;
  environment: string;
  status: "verified" | "failing" | "skipped";
  runtimeVersion: string;
  adapterVersion: string;
  luaVersion: string;
  durationMs: number;
  checks: AssetCheck[];
  log: string;
  evidence: Record<string, unknown>;
}

const statusOf = (checks: AssetCheck[]): AssetReport["status"] =>
  checks.some((c) => c.status === "failed") ? "failing" : checks.every((c) => c.status === "skipped") ? "skipped" : "verified";

/** True when the package has asset files this environment delivers. */
export function hasAssetsFor(res: LoadedResource, env: string): boolean {
  if (!res.result.ok) return false;
  return planAssets(res, env, { withoutAssets: true }).delivered.length > 0;
}

/** `Server: <sha1> is <name> (` lines of a verbose Luanti server log, by file name. */
export function luantiAnnounced(log: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of log.matchAll(/Server: ([0-9a-f]{40}) is (.+?) \(/g)) out.set(m[2]!, m[1]!);
  return out;
}

export function verifyLuantiAssets(res: LoadedResource, m: ParsedManifest, opts: { image: string; timeoutMs?: number }): AssetReport {
  const started = Date.now();
  const checks: AssetCheck[] = [];
  const report = (log = "", evidence: Record<string, unknown> = {}): AssetReport => ({
    package: m.name, version: m.version, environment: "luanti", status: statusOf(checks), runtimeVersion: "",
    adapterVersion: "luanti-assets-0.1.0", luaVersion: "", durationMs: Date.now() - started, checks, log, evidence: { kind: "assets", ...evidence },
  });
  const docker = spawnSync("docker", ["image", "inspect", opts.image, "--format", "{{index .RepoDigests 0}}"], { encoding: "utf8" });
  if (docker.status !== 0) {
    checks.push({ name: "server_run", status: "skipped", message: `docker or image ${opts.image} unavailable` });
    return report();
  }
  const run = mkdtempSync(join(tmpdir(), "scriptgo-luanti-assets-"));
  try {
    const packed = packForLuanti(res, join(run, "pack"));
    checks.push({ name: "packs", status: packed.errors.length === 0 ? "passed" : "failed", message: packed.errors.map((e) => `${e.code}: ${e.message}`).join("; ") });
    const mod = luantiMediaModName(m.name);
    const modDir = join(run, "pack", "mods", mod);
    if (packed.errors.length > 0 || !existsSync(modDir)) return report();
    const delivered = packed.assets?.delivered ?? [];

    const game = join(run, "game");
    const world = join(run, "world");
    const conf = join(run, "conf");
    for (const d of [join(game, "mods"), world, conf]) mkdirSync(d, { recursive: true });
    writeFileSync(join(game, "game.conf"), "title = SCRIPT//GO asset verify\n");
    // The packed media mod, as an operator installs it, and a helper mod that stops the server.
    cpSync(modDir, join(game, "mods", mod), { recursive: true });
    mkdirSync(join(game, "mods", "sgverify_stop"), { recursive: true });
    writeFileSync(join(game, "mods", "sgverify_stop", "mod.conf"), "name = sgverify_stop\n");
    writeFileSync(join(game, "mods", "sgverify_stop", "init.lua"), 'core.after(1, function() core.request_shutdown("scriptgo asset verify done") end)\n');
    writeFileSync(join(world, "world.mt"), "gameid = sgassets\nbackend = sqlite3\nplayer_backend = sqlite3\nauth_backend = sqlite3\nmod_storage_backend = sqlite3\n");
    writeFileSync(join(conf, "luanti.conf"), "server_announce = false\nipv6_server = false\nbind_address = 127.0.0.1\n");
    const mount = (p: string): string => p.split("\\").join("/");
    const r = spawnSync("docker", [
      "run", "--rm", "--network", "none",
      "-v", `${mount(game)}:/usr/local/share/luanti/games/sgassets`,
      "-v", `${mount(world)}:/var/lib/minetest/world`,
      "-v", `${mount(conf)}:/etc/minetest`,
      opts.image, "--config", "/etc/minetest/luanti.conf", "--world", "/var/lib/minetest/world", "--verbose",
    ], { encoding: "utf8", timeout: opts.timeoutMs ?? 120_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
    const log = (r.stdout ?? "") + (r.stderr ?? "");
    const version = /Luanti (\d+\.\d+\.\d+)/.exec(log)?.[1] ?? "";
    const loaded = new RegExp(`\\[${mod}\\] (\\d+) media files`).exec(log);
    checks.push({ name: "server_run", status: /Server: \d+ media files collected/.test(log) ? "passed" : "failed", message: version ? `Luanti ${version} (official image)` : `exit ${r.status ?? r.signal}` });
    checks.push({ name: "media_mod_loaded", status: loaded ? "passed" : "failed", message: loaded ? `${mod} loaded` : `${mod} did not load` });
    const announced = luantiAnnounced(log);
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const f of delivered) {
      const name = f.slice(f.lastIndexOf("/") + 1);
      const sha1 = createHash("sha1").update(readFileSync(join(res.root, ...f.split("/")))).digest("hex");
      const got = announced.get(name);
      if (!got) missing.push(f);
      else if (got !== sha1) mismatched.push(f);
    }
    checks.push({
      name: "assets_media_announced",
      status: missing.length + mismatched.length === 0 && delivered.length > 0 ? "passed" : "failed",
      message: missing.length + mismatched.length === 0 ? `${delivered.length} of ${delivered.length} files announced to clients with the SHA-1 of their bytes` : `missing: ${missing.join(", ") || "-"}; other bytes: ${mismatched.join(", ") || "-"}`,
    });
    const errors = log.split(/\r?\n/).filter((l) => /ERROR/.test(l) && (l.includes(mod) || delivered.some((f) => l.includes(f.slice(f.lastIndexOf("/") + 1)))));
    checks.push({ name: "no_media_errors", status: errors.length === 0 ? "passed" : "failed", message: errors[0] ?? "" });
    const keep = log.split(/\r?\n/).filter((l) => /Luanti \d|Loading mods|media files|sgmedia_|ERROR/.test(l) || delivered.some((f) => l.includes(` is ${f.slice(f.lastIndexOf("/") + 1)} (`)));
    return report(keep.slice(-200).join("\n"), { image: (docker.stdout ?? "").trim(), files: delivered.length, runtime: version });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}

const MARKER = ".scriptgo-verify";

export async function verifyGarrysmodAssets(res: LoadedResource, m: ParsedManifest, opts: { server?: string; binary?: string; port: number; timeoutMs: number; map?: string }): Promise<AssetReport> {
  const started = Date.now();
  const checks: AssetCheck[] = [];
  const report = (log = "", evidence: Record<string, unknown> = {}): AssetReport => ({
    package: m.name, version: m.version, environment: "garrysmod", status: statusOf(checks), runtimeVersion: "",
    adapterVersion: "garrysmod-assets-0.1.0", luaVersion: "", durationMs: Date.now() - started, checks, log, evidence: { kind: "assets", ...evidence },
  });
  const server = findGarrysmodServer(opts.server);
  if (!server) {
    checks.push({ name: "server_run", status: "skipped", message: "no Garry's Mod server: pass --gmod-server <dir> or set SCRIPTGO_GMOD_SERVER" });
    return report();
  }
  const exeName = opts.binary ?? (process.platform === "win32" ? "srcds.exe" : "srcds_run");
  const exe = join(server, exeName);
  if (!existsSync(exe)) {
    checks.push({ name: "server_run", status: "skipped", message: `${exeName} not found in the server folder` });
    return report();
  }
  const gmod = join(server, "garrysmod");
  const addons = join(gmod, "addons");
  const addon = join(addons, `scriptgo_${m.name}`);
  if (existsSync(addon) && !existsSync(join(addon, MARKER))) {
    checks.push({ name: "server_run", status: "skipped", message: `garrysmod/addons/scriptgo_${m.name} is the operator's own install: verify needs a dedicated server folder` });
    return report();
  }
  // The content addon only: the package's scripts are verified by the script run (--env garrysmod).
  const packed = packForGarrysmod(res, addons, { runtime: false });
  const tag = `sgassets_${m.name}`;
  const files = packed.assets?.delivered ?? [];
  checks.push({ name: "packs", status: packed.errors.length === 0 ? "passed" : "failed", message: packed.errors.map((e) => `${e.code}: ${e.message}`).join("; ") });
  const cleanup = (): void => rmSync(addon, { recursive: true, force: true });
  if (packed.errors.length > 0) {
    cleanup();
    return report();
  }
  writeFileSync(join(addon, MARKER), "created by scriptgo verify; removed after the run\n");
  const consoleFile = join(gmod, "console.log");
  rmSync(consoleFile, { force: true });
  const map = opts.map ?? "gm_construct";
  const proc = startSrcds(exe, server, srcdsArgs(opts.port, map, false));
  const line = new RegExp(`\\[${tag}\\] (\\d+) of (\\d+) files added to the download list`);
  const deadline = Date.now() + opts.timeoutMs;
  let consoleLog = "";
  try {
    while (Date.now() < deadline && proc.alive()) {
      consoleLog = existsSync(consoleFile) ? readFileSync(consoleFile, "latin1") : "";
      if (line.test(consoleLog)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // A moment for the lines after it (errors from the same autorun) to reach the file.
    await new Promise((r) => setTimeout(r, 1000));
  } finally {
    await proc.stop();
    consoleLog = existsSync(consoleFile) ? readFileSync(consoleFile, "latin1") : consoleLog;
    cleanup();
  }
  const scrub = (s: string): string => s.split(server).join("<gmod-server>").split(server.split("\\").join("/")).join("<gmod-server>");
  const lines = scrub(consoleLog).split(/\r?\n/);
  const hit = line.exec(consoleLog);
  checks.push({ name: "server_run", status: consoleLog.length > 0 ? "passed" : "failed", message: proc.error || `srcds on 127.0.0.1:${opts.port}, map ${map}` });
  const added = hit ? Number(hit[1]) : 0;
  const total = hit ? Number(hit[2]) : files.length;
  checks.push({
    name: "assets_download_list",
    status: hit && added === total && total === files.length ? "passed" : "failed",
    message: hit ? `${added} of ${total} files found in the GAME file system and added with resource.AddSingleFile` : "the content addon's autorun did not report",
  });
  const missing = lines.filter((l) => l.includes(`[${tag}] missing `));
  checks.push({ name: "assets_all_found", status: missing.length === 0 && hit ? "passed" : "failed", message: missing.slice(0, 3).join("; ") });
  const errs = luaErrors(consoleLog);
  checks.push({ name: "engine_lua_errors", status: errs.length === 0 ? "passed" : "failed", message: errs[0] ?? "" });
  const steamInf = existsSync(join(gmod, "steam.inf")) ? readFileSync(join(gmod, "steam.inf"), "utf8") : "";
  return report(lines.filter((l) => l.includes(tag) || /^\[ERROR\]|Lua Error/.test(l)).slice(-100).join("\n"), {
    files: files.length, map, port: opts.port, patchVersion: /PatchVersion=(\S+)/.exec(steamInf)?.[1] ?? "",
    note: "server side only: no GMod client downloaded the files",
  });
}
