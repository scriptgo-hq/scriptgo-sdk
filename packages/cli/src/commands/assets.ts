// scriptgo assets fingerprint <release.zip|folder> [--trusted-signer <key>]
// scriptgo assets seal <folder|preload.zip> --package <creator//name> --version <v> --release <id>
//                      --deployment <id> --out <file.sgae> [--chunk-bytes <n>]
// scriptgo assets open <file.sgae> --key <file.sgae.key.json> [--out <folder>] [--trusted-signer <key>]
//
// fingerprint  reads the per-buyer fingerprints of a downloaded release (docs/spec/assets.md,
//              "Per-buyer builds"): the release's own, and the one inside each container. It never
//              needs a secret: a record names its licence and is signed by the platform.
// seal / open  the asset-escrow container format (docs/spec/assets.md, "Asset escrow"), for the
//              people who write a platform's client hook: `seal` makes a container from a folder or
//              a zip, with a fresh content key; `open` is the reference decryptor. On the platform the
//              content key is derived per deployment and never leaves it, except wrapped to a
//              server and to a player's session (the hook). Here `seal` writes the key to a file
//              next to the container (mode 0600): test material, never ship it.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  AssetContainerReader,
  assetKeyId,
  findFingerprints,
  readAssetContainer,
  readZip,
  readZipEntry,
  sealAssetContainer,
  verifyFingerprintRecord,
} from "@scriptgo/escrow";
import { parseArgs } from "../lib/args.ts";
import { FINGERPRINT_FILE } from "../lib/assets.ts";

export const summary = "Assets: read a copy's per-buyer fingerprint; seal or open an asset-escrow container (hook test tooling)";

const USAGE = [
  "scriptgo assets fingerprint <release.zip|folder> [--trusted-signer <key>]",
  "scriptgo assets seal <folder|preload.zip> --package <creator//name> --version <v> --release <id> --deployment <id> --out <file.sgae> [--chunk-bytes <n>]",
  "scriptgo assets open <file.sgae> --key <file.sgae.key.json> [--out <folder>] [--trusted-signer <key>]",
].join("\n");

/** Every file under a folder, relative with `/` (dot folders included: they are part of a copy). */
function walk(root: string): string[] {
  const out: string[] = [];
  const go = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) go(full);
      else out.push(relative(root, full).split(sep).join("/"));
    }
  };
  go(root);
  return out.sort();
}

function fingerprint(target: string, trusted?: string): number {
  const found: { where: string; ok: boolean; reason?: string; licence?: string; deployment?: string; release?: string }[] = [];
  if (statSync(target).isDirectory()) {
    for (const f of walk(target)) {
      if (f === FINGERPRINT_FILE || f.endsWith(`/${FINGERPRINT_FILE}`)) {
        let v: ReturnType<typeof verifyFingerprintRecord>;
        try {
          v = verifyFingerprintRecord(JSON.parse(readFileSync(join(target, f), "utf8")), trusted);
        } catch (e) {
          v = { ok: false, reason: `unreadable: ${e instanceof Error ? e.message : String(e)}` };
        }
        found.push(v.ok ? { where: f, ok: true, licence: v.record.licence, deployment: v.record.deployment, release: v.record.release } : { where: f, ok: false, reason: v.reason });
      } else if (f.toLowerCase().endsWith(".zip")) {
        for (const r of findFingerprints(readFileSync(join(target, f)), trusted)) {
          found.push({ where: `${f}!${r.where}`, ok: r.ok, reason: r.reason, licence: r.record?.licence, deployment: r.record?.deployment, release: r.record?.release });
        }
      }
    }
  } else {
    for (const r of findFingerprints(readFileSync(target), trusted)) {
      found.push({ where: r.where, ok: r.ok, reason: r.reason, licence: r.record?.licence, deployment: r.record?.deployment, release: r.record?.release });
    }
  }
  if (found.length === 0) {
    console.log("no fingerprint: not a buyer's copy, or the fingerprint was removed (repacking removes it)");
    return 1;
  }
  for (const f of found) {
    console.log(f.ok ? `ok      ${f.where}: release ${f.release}, licence ${f.licence}, deployment ${f.deployment || "-"}` : `invalid ${f.where}: ${f.reason}`);
  }
  const licences = new Set(found.filter((f) => f.ok).map((f) => f.licence));
  if (licences.size > 1) console.log(`warning: ${licences.size} different licences in one copy: files from several buyers were mixed`);
  return found.every((f) => f.ok) ? 0 : 1;
}

function seal(source: string, a: ReturnType<typeof parseArgs>): number {
  for (const k of ["package", "version", "release", "deployment", "out"]) {
    if (!a.flags[k]) {
      console.error(`--${k} is required\n${USAGE}`);
      return 2;
    }
  }
  const files = new Map<string, Buffer>();
  if (statSync(source).isDirectory()) {
    for (const f of walk(source)) files.set(f, readFileSync(join(source, f)));
  } else {
    const data = readFileSync(source);
    for (const e of readZip(data).entries) if (!e.isDirectory) files.set(e.name, readZipEntry(data, e));
  }
  const contentKey = randomBytes(32);
  const signerSeed = randomBytes(32);
  const out = resolve(a.flags.out!);
  const container = sealAssetContainer({
    files, package: a.flags.package!, version: a.flags.version!, release: a.flags.release!, deployment: a.flags.deployment!,
    contentKey, signerSeed, ...(a.flags["chunk-bytes"] ? { chunkBytes: Number(a.flags["chunk-bytes"]) } : {}),
  });
  signerSeed.fill(0);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, container);
  const keyPath = `${out}.key.json`;
  writeFileSync(keyPath, JSON.stringify({ note: "SECRET test key for scriptgo assets open; never ship it", keyId: assetKeyId(contentKey), contentKey: contentKey.toString("base64") }, null, 2) + "\n", { mode: 0o600 });
  contentKey.fill(0);
  const header = readAssetContainer(container).header;
  console.log(`sealed ${files.size} files -> ${out} (${container.length} bytes, key ${header.keyId}, signer ${header.signerPublicKey})`);
  console.log(`  content key (SECRET, test material) -> ${keyPath}`);
  return 0;
}

function open(file: string, a: ReturnType<typeof parseArgs>): number {
  if (!a.flags.key) {
    console.error(`--key is required\n${USAGE}`);
    return 2;
  }
  const key = Buffer.from((JSON.parse(readFileSync(resolve(a.flags.key), "utf8")) as { contentKey: string }).contentKey, "base64");
  const reader = new AssetContainerReader(readFileSync(file), key, a.flags["trusted-signer"] ? { trustedSigner: a.flags["trusted-signer"] } : {});
  key.fill(0);
  try {
    const h = reader.header;
    console.log(`${h.package}@${h.version} release ${h.release} deployment ${h.deployment}, ${h.files.length} files${h.fingerprint ? `, fingerprint ${h.fingerprint}` : ""}`);
    const outDir = a.flags.out ? resolve(a.flags.out) : null;
    for (const path of reader.paths()) {
      const data = reader.readAll(path); // every chunk authenticated
      if (outDir) {
        const to = join(outDir, ...path.split("/"));
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, data);
      }
      console.log(`  ok ${path} (${data.length} bytes)`);
    }
    if (outDir) console.log(`wrote the plaintext to ${outDir} (a hook never does this: it reads in memory)`);
    return 0;
  } finally {
    reader.close();
  }
}

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help"] });
  const [sub, target] = a.positional;
  if (a.bools.has("help") || !sub || !target) {
    console.log(USAGE);
    return a.bools.has("help") ? 0 : 2;
  }
  if (!existsSync(target)) {
    console.error(`${target} does not exist`);
    return 2;
  }
  try {
    if (sub === "fingerprint") return fingerprint(target, a.flags["trusted-signer"]);
    if (sub === "seal") return seal(target, a);
    if (sub === "open") return open(target, a);
  } catch (e) {
    console.error(`error ${(e as { code?: string }).code ?? "failed"}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.error(`unknown subcommand '${sub}'\n${USAGE}`);
  return 2;
}
