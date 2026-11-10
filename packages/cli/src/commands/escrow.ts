// scriptgo escrow identity --identity <file>
// scriptgo escrow load --bundle <file> --master <url> --deployment-token <sg_dep_...> --package <creator//name>
//                      --environment <env> --identity <file> [--trusted-signer <key>] [--version <v>]
//                      [--once] [--out <dir>] [--lua lua54|lua51|luajit|<path>] [--recheck <seconds>]
//
// The REFERENCE escrow loader (not a compiled host: see src/lib/escrow-loader.ts). `load` verifies the
// bundle, gets the content key wrapped to this server from the master, decrypts in memory and, on
// request, runs the resource in the standalone Lua host or writes it to disk (--out: licence-only
// grade, the operator can read it). Without --once it stays up, asks again before each answer
// expires, and stops when the offline grace of its last valid answer runs out.
//
// Exit codes: 0 loaded (and ran); 1 refused (the master said no, or the bundle does not verify);
// 2 usage; 3 stopped at the end of offline grace; 4 the master could not answer at start.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MANIFEST_FILES, parseManifest } from "@scriptgo/manifest";
import { parseArgs } from "../lib/args.ts";
import {
  checkBundle,
  graceEnd,
  loadIdentity,
  loadRelease,
  LoaderRefusal,
  LOADER_LABEL,
  materialize,
  requestKey,
  type KeyAnswer,
} from "../lib/escrow-loader.ts";
import { defaultSearchPaths, pickInterpreters, standaloneMain } from "../lib/sdk.ts";
import { loadCredentials } from "./_api-client.ts";

export const summary = "Reference loader for protected (escrow) releases, and the server identity it uses";

const USAGE = `scriptgo escrow identity --identity <file>
scriptgo escrow load --bundle <file.escrow.zip> --package <creator//name> --environment <env>
    --deployment-token <sg_dep_...> --identity <file> [--master <url>] [--trusted-signer <base64url key>]
    [--version <v>] [--once] [--out <dir>] [--lua lua54|lua51|luajit|<path>] [--recheck <seconds>]

This is a ${LOADER_LABEL}. It shows the protocol and serves hosts that only read files (--out).
For real code escrow, use a compiled host that decrypts in memory (the .NET kit).
The deployment token may come from SCRIPTGO_DEPLOYMENT_TOKEN, to keep it out of the shell history.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();

/** The resource name its manifest declares: the standalone host wants the folder to carry it. */
function resourceNameOf(files: Map<string, Buffer>, fallback: string): string {
  for (const file of MANIFEST_FILES) {
    const source = files.get(file);
    if (!source) continue;
    const parsed = parseManifest(source.toString("utf8"), { fileName: file });
    if (parsed.ok) return parsed.manifest.name;
  }
  return fallback;
}

/** Runs the decrypted resource once in the standalone Lua host. Returns its exit status. */
function runInLuaHost(dir: string, lua: string, ms: number): number {
  const [interp] = pickInterpreters(lua);
  const argv = [standaloneMain, "run", dir, "--for", String(ms)];
  for (const s of defaultSearchPaths()) argv.push("--search", resolve(s));
  const r = spawnSync(interp!.path, argv, { stdio: "inherit" });
  return r.status ?? 1;
}

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const a = parseArgs(rest, { booleans: ["help", "once"] });
  if (!sub || sub === "--help" || a.bools.has("help") || (sub !== "identity" && sub !== "load")) {
    console.log(USAGE);
    return sub === "--help" || a.bools.has("help") ? 0 : 2;
  }
  if (!a.flags.identity) {
    console.error(`scriptgo escrow ${sub}: --identity <file> is required\n${USAGE}`);
    return 2;
  }
  const identity = loadIdentity(a.flags.identity);
  if (sub === "identity") {
    console.log(`${identity.created ? "created" : "found"} server identity ${resolve(a.flags.identity)}`);
    console.log(`public key   ${identity.publicKey.toString("base64url")}`);
    console.log(`fingerprint  ${identity.fingerprint}   (the licence page shows it once the deployment is bound)`);
    console.log("keep the file on this server: its private key is what a released content key is wrapped to");
    return 0;
  }

  const deploymentToken = a.flags["deployment-token"] ?? process.env.SCRIPTGO_DEPLOYMENT_TOKEN;
  const master = (a.flags.master ?? loadCredentials().api).replace(/\/$/, "");
  const missing = ["bundle", "package", "environment"].filter((k) => !a.flags[k]);
  if (missing.length > 0 || !deploymentToken) {
    console.error(`scriptgo escrow load: missing ${[...missing.map((m) => `--${m}`), ...(deploymentToken ? [] : ["--deployment-token"])].join(", ")}\n${USAGE}`);
    return 2;
  }
  if (!existsSync(a.flags.bundle!)) {
    console.error(`scriptgo escrow load: ${a.flags.bundle} does not exist`);
    return 2;
  }
  const bundle = readFileSync(a.flags.bundle!);
  const trustedSigner = a.flags["trusted-signer"] ?? null;
  const request = {
    master,
    deploymentToken,
    package: a.flags.package!,
    environment: a.flags.environment!,
    version: a.flags.version ?? null,
    adapterVersion: "scriptgo-cli-reference-loader",
    identity,
  };

  console.log(`[escrow] ${LOADER_LABEL}`);
  console.log(`[escrow] server identity ${identity.fingerprint}${identity.created ? " (created now)" : ""}`);
  if (!trustedSigner) console.log("[escrow] warning: no --trusted-signer: the bundle's signature is checked against the key it names, and the master's, not one you pinned");

  let temp: string | null = null;
  const cleanup = () => {
    if (temp) rmSync(temp, { recursive: true, force: true });
    temp = null;
  };
  try {
    const loaded = await loadRelease(bundle, { ...request, trustedSigner });
    let answer: KeyAnswer = loaded.answer;
    const m = loaded.manifest;
    console.log(`[escrow] loaded ${m.package}@${m.version}: ${m.encryptedFiles.length} file(s) decrypted in memory, ${m.clearFiles.length} clear; signer ${m.signerPublicKey.slice(0, 12)}…`);
    console.log(`[escrow] key answer expires ${answer.expiresAt}; offline grace until ${answer.offlineGraceUntil}`);

    if (a.flags.out) {
      const dir = materialize(loaded.files, a.flags.out);
      console.log(`[escrow] wrote the decrypted copy to ${dir} (LICENCE-ONLY GRADE: readable on this disk; delivery marker included)`);
    }
    if (a.flags.lua) {
      let dir: string;
      if (a.flags.out) dir = resolve(a.flags.out);
      else {
        temp = mkdtempSync(join(tmpdir(), "scriptgo-escrow-"));
        dir = materialize(loaded.files, join(temp, resourceNameOf(loaded.files, m.package.split("//").pop()!.replace(/-/g, "_"))));
      }
      console.log(`[escrow] running in the standalone Lua host (${a.flags.lua})`);
      const status = runInLuaHost(dir, a.flags.lua, 300);
      if (status !== 0) {
        console.error(`[escrow] the Lua host exited with ${status}`);
        return 1;
      }
    }
    console.log(`[escrow] RUNNING ${m.package}@${m.version}`);
    if (a.bools.has("once")) return 0;

    // Stay up: ask again before each answer expires; stop when the last valid answer's grace is over.
    const recheckMs = Math.max(1, Number(a.flags.recheck ?? 0)) * 1000;
    let stopReason: string | null = null;
    for (;;) {
      const now = Date.now();
      const until = graceEnd(answer);
      if (stopReason && now >= until) {
        console.log(`[escrow] ${stamp()} STOPPED ${m.package}@${m.version}: ${stopReason}; offline grace ended`);
        return 3;
      }
      const expires = answer.expiresAt ? new Date(answer.expiresAt).getTime() : now + recheckMs;
      const wait = a.flags.recheck ? recheckMs : Math.max(1000, expires - now - 5000);
      await sleep(stopReason ? Math.max(50, Math.min(wait, until - now)) : wait);
      const outcome = await requestKey({ ...request, version: m.version });
      if (outcome.kind === "released") {
        answer = outcome.answer;
        if (stopReason) console.log(`[escrow] ${stamp()} the master answers again: still licensed`);
        stopReason = null;
      } else {
        const why = outcome.kind === "refused" ? `the master refuses the key (${outcome.reason})` : `the master does not answer (${outcome.detail})`;
        if (stopReason !== why) console.log(`[escrow] ${stamp()} ${why}; running on offline grace until ${new Date(until).toISOString()}`);
        stopReason = why;
      }
    }
  } catch (e) {
    if (e instanceof LoaderRefusal) {
      console.error(`[escrow] REFUSED ${e.code}: ${e.message}`);
      return e.code === "master_unreachable" ? 4 : 1;
    }
    throw e;
  } finally {
    cleanup();
  }
}

// Exported for tests.
export { checkBundle };
