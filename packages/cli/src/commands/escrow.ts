// scriptgo escrow inspect  <bundle.escrow.zip> [--trusted-signer <key>]
// scriptgo escrow install  <bundle.escrow.zip> --target open77 --out <resources folder> [--trusted-signer <key>] [--force]
// scriptgo escrow identity --identity <file>
// scriptgo escrow load     --bundle <file> --master <url> --deployment-token <sg_dep_...> --package <creator//name>
//                          --environment <env> --identity <file> [--trusted-signer <key>] [--version <v>]
//                          [--once] [--out <dir>] [--lua lua54|lua51|luajit|<path>] [--recheck <seconds>]
//
// inspect and install never handle a content key: `inspect` reads a bundle's clear manifest and
// checks its signature; `install` writes an OPEN//77 resource folder with the scripts still
// encrypted (the OPEN//77 server decrypts them itself when its resourceEscrow feature is on).
//
// identity and load are the REFERENCE escrow loader (not a compiled host: see
// src/lib/escrow-loader.ts). `load` verifies the bundle, gets the content key wrapped to this server
// from the master, decrypts in memory and, on request, runs the resource in the standalone Lua host
// or writes it to disk (--out: licence-only grade, the operator can read it). Without --once it
// stays up, asks again before each answer expires, and stops when the offline grace of its last
// valid answer runs out.
//
// Exit codes of `load`: 0 loaded (and ran); 1 refused (the master said no, or the bundle does not
// verify); 2 usage; 3 stopped at the end of offline grace; 4 the master could not answer at start.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readBundle, verifyManifest } from "@scriptgo/escrow";
import { MANIFEST_FILES, parseManifest } from "@scriptgo/manifest";
import { parseArgs, type ParsedArgs } from "../lib/args.ts";
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
import { Open77EscrowError, installEscrowForOpen77 } from "../lib/open77-escrow.ts";
import { defaultSearchPaths, pickInterpreters, standaloneMain } from "../lib/sdk.ts";
import { loadCredentials } from "./_api-client.ts";

export const summary = "Protected (escrow) releases: inspect a bundle, install it encrypted for OPEN//77, or open it with the reference loader";

const USAGE = `scriptgo escrow inspect <bundle.escrow.zip> [--trusted-signer <ed25519 public key>]
scriptgo escrow install <bundle.escrow.zip> --target open77 --out <resources folder> [--trusted-signer <key>] [--force]
scriptgo escrow identity --identity <file>
scriptgo escrow load --bundle <file.escrow.zip> --package <creator//name> --environment <env>
    --deployment-token <sg_dep_...> --identity <file> [--master <url>] [--trusted-signer <base64url key>]
    [--version <v>] [--once] [--out <dir>] [--lua lua54|lua51|luajit|<path>] [--recheck <seconds>]

inspect and install never see a content key: install leaves the scripts encrypted on disk.
load is a ${LOADER_LABEL}. It shows the protocol and serves hosts that only read files (--out).
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

// ------------------------------------------------------------------ inspect / install (no key involved)

function inspect(file: string, trusted: string | undefined): number {
  const { manifest, clear, payload } = readBundle(readFileSync(resolve(file)));
  const verdict = verifyManifest(manifest, { trustedSignerPublicKey: trusted });
  console.log(`${manifest.package} ${manifest.version}  (${manifest.format}, ${manifest.cipher})`);
  console.log(`signature: ${verdict.ok ? "valid" : `INVALID (${verdict.reason})`}  signer ${manifest.signerPublicKey}${trusted ? " (pinned)" : " (not pinned)"}`);
  console.log(`payload:   ${payload.length} bytes, ${manifest.encryptedFiles.length} encrypted file(s)`);
  for (const f of manifest.encryptedFiles) console.log(`  encrypted  ${f}`);
  for (const f of [...clear.keys()].sort()) console.log(`  clear      ${f}`);
  return verdict.ok ? 0 : 1;
}

function install(file: string, a: ParsedArgs): number {
  const target = a.flags.target ?? "open77";
  if (target !== "open77") {
    console.error(`scriptgo escrow install: unknown target '${target}'. Only open77 loads an encrypted folder from disk; other hosts take the bundle through their loader.`);
    return 2;
  }
  if (!a.flags.out) {
    console.error("scriptgo escrow install: --out <resources folder> is required.");
    return 2;
  }
  try {
    const r = installEscrowForOpen77({ bundle: readFileSync(resolve(file)), resourcesRoot: resolve(a.flags.out), trustedSignerPublicKey: a.flags["trusted-signer"], force: a.bools.has("force") });
    for (const w of r.warnings) console.log(`warning ${w}`);
    console.log(`installed ${r.package} ${r.version} -> ${r.dest}`);
    console.log(`  encrypted server scripts (stubs on disk): ${r.stubs.length === 0 ? "none" : r.stubs.join(", ")}`);
    console.log(`  clear files: ${r.clear.join(", ")}`);
    console.log("  The scripts stay encrypted on disk. The server needs resourceEscrow enabled, the native loader,");
    console.log("  and a deployment token for this resource; see the OPEN//77 setup guide.");
    return 0;
  } catch (err) {
    if (err instanceof Open77EscrowError) {
      console.error(`error ${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

// ------------------------------------------------------------------ identity / load (the reference loader)

async function load(a: ParsedArgs): Promise<number> {
  const identity = loadIdentity(a.flags.identity!);
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
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const a = parseArgs(rest, { booleans: ["help", "once", "force"] });
  const known = ["inspect", "install", "identity", "load"];
  if (!sub || sub === "--help" || a.bools.has("help") || !known.includes(sub)) {
    (sub && sub !== "--help" && !a.bools.has("help") ? console.error : console.log)(USAGE);
    return sub === "--help" || a.bools.has("help") ? 0 : 2;
  }

  if (sub === "inspect" || sub === "install") {
    const file = a.positional[0];
    if (!file) {
      console.error(`scriptgo escrow ${sub}: give the bundle file\n${USAGE}`);
      return 2;
    }
    return sub === "inspect" ? inspect(file, a.flags["trusted-signer"]) : install(file, a);
  }

  if (!a.flags.identity) {
    console.error(`scriptgo escrow ${sub}: --identity <file> is required\n${USAGE}`);
    return 2;
  }
  if (sub === "identity") {
    const identity = loadIdentity(a.flags.identity);
    console.log(`${identity.created ? "created" : "found"} server identity ${resolve(a.flags.identity)}`);
    console.log(`public key   ${identity.publicKey.toString("base64url")}`);
    console.log(`fingerprint  ${identity.fingerprint}   (the licence page shows it once the deployment is bound)`);
    console.log("keep the file on this server: its private key is what a released content key is wrapped to");
    return 0;
  }
  return load(a);
}

// Exported for tests.
export { checkBundle };
