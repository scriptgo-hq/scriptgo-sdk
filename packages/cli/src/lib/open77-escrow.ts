// Installs an escrow bundle as an OPEN//77 resource folder WITHOUT decrypting anything.
//
// The folder is what an OPEN//77 server with `resourceEscrow.enabled` loads (ADR-0032):
//
//   <resources>/<name>/open77.lua          a SIGNED clear file of the bundle (generated at pack time)
//   <resources>/<name>/scriptgo_shim*.lua  the OPEN//77 shim, signed clear files of the bundle too
//   <resources>/<name>/escrow.json         the signed escrow manifest, byte for byte from the bundle
//   <resources>/<name>/payload.enc         the encrypted payload, byte for byte from the bundle
//   <resources>/<name>/<server script>     a one-line STUB at each encrypted server script's path
//   <resources>/<name>/...                 the bundle's clear files (docs, config, client/shared files)
//
// The scripts keep their paths, so the OPEN//77 manifest parser finds a file for every script it
// names, while the real chunk is decrypted by the server's native loader and loaded straight into
// the Lua VM. Nothing here needs the content key: the operator's machine never sees the plaintext
// on disk.
//
// Honest limits: client and shared scripts are sent to game clients by OPEN//77, so they must be
// clear (the packer keeps them clear; this installer refuses a bundle that encrypted one).
//
// Nothing is generated here. The OPEN//77 server refuses an escrowed resource unless open77.lua is
// a signed clear file of the release and every script it lists belongs to the signed release, so
// the packer (CLI or master, both through prepareEscrowFiles) puts open77.lua and the shim in the
// bundle. A bundle without open77.lua was not packed for OPEN//77 and is refused: writing an
// unsigned manifest next to signed files would be exactly what the server rejects.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { ESCROW_JSON, ESCROW_PAYLOAD, verifyManifest, type EscrowManifest } from "@scriptgo/escrow";
import { clientFacingFiles, expandGlob, parseManifest, scriptLanguage, validateResourceFiles } from "@scriptgo/manifest";

export interface Open77EscrowInstall {
  dest: string;
  name: string;
  package: string;
  version: string;
  /** Encrypted server scripts that got a stub (their real chunk comes from payload.enc). */
  stubs: string[];
  /** Encrypted entries that OPEN//77 does not load (tests, sources): left inside the payload. */
  unused: string[];
  clear: string[];
  warnings: string[];
}

export class Open77EscrowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** The stub written at an encrypted script's path. One comment line; never executed by an escrow-aware server. */
export function escrowStub(manifest: EscrowManifest, path: string): string {
  return `-- scriptgo-escrow/1 ${manifest.package}@${manifest.version} sha256=${manifest.payload.sha256} path=${path}\n`;
}

function safeRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !/^[a-zA-Z]:/.test(path) && !path.split(/[\\/]/).includes("..") && !path.includes("\0");
}

export function installEscrowForOpen77(opts: {
  bundle: Uint8Array;
  resourcesRoot: string;
  /** ed25519 public key (raw, base64url) the operator trusts for this creator. Strongly recommended. */
  trustedSignerPublicKey?: string;
  /** Replace an existing folder that is not an escrow install. */
  force?: boolean;
}): Open77EscrowInstall {
  const entries = unzipSync(opts.bundle);
  const rawEscrowJson = entries[ESCROW_JSON];
  const payload = entries[ESCROW_PAYLOAD];
  if (!rawEscrowJson) throw new Open77EscrowError("not_escrow", "not an escrow bundle: escrow.json is missing.");
  if (!payload) throw new Open77EscrowError("not_escrow", "escrow bundle has no payload.enc.");
  const manifest = JSON.parse(Buffer.from(rawEscrowJson).toString("utf8")) as EscrowManifest;

  const verdict = verifyManifest(manifest, { trustedSignerPublicKey: opts.trustedSignerPublicKey });
  if (!verdict.ok) throw new Open77EscrowError("signature", `escrow manifest rejected: ${verdict.reason}`);
  if (sha256(payload) !== manifest.payload.sha256) throw new Open77EscrowError("tampered", "payload.enc does not match the signed manifest.");

  const clear = new Map<string, Uint8Array>();
  for (const entry of manifest.clearFiles) {
    if (!safeRelative(entry.path)) throw new Open77EscrowError("unsafe_path", `unsafe path in the bundle: ${entry.path}`);
    const data = entries[entry.path];
    if (!data || sha256(data) !== entry.sha256) throw new Open77EscrowError("tampered", `clear file ${entry.path} is missing or does not match the signed manifest.`);
    clear.set(entry.path, data);
  }
  for (const p of manifest.encryptedFiles) if (!safeRelative(p)) throw new Open77EscrowError("unsafe_path", `unsafe path in the bundle: ${p}`);

  // open77.lua must be in the bundle, as a clear file the signature covers. It is used as is.
  const manifestFile = "open77.lua";
  if (!clear.has(manifestFile)) {
    throw new Open77EscrowError(
      "not_open77",
      "this release was not packed for OPEN//77: its bundle has no signed open77.lua. The creator packs it for OPEN//77 (Lua scripts only, and open77 in the manifest's environments, or none listed) and publishes it again.",
    );
  }
  const parsed = parseManifest(Buffer.from(clear.get(manifestFile)!).toString("utf8"), { fileName: manifestFile });
  if (!parsed.ok) throw new Open77EscrowError("manifest", parsed.errors.map((e) => e.message).join("; "));
  const m = parsed.manifest;

  const all = [...clear.keys(), ...manifest.encryptedFiles];
  const encrypted = new Set(manifest.encryptedFiles);
  const shipped = [...m.sharedScripts, ...m.serverScripts, ...m.clientScripts, ...(m.environmentScripts["open77"] ?? [])];
  const foreign = shipped.filter((p) => scriptLanguage(p) !== "lua");
  if (foreign.length > 0) throw new Open77EscrowError("open77_lua_only", `OPEN//77 runs Lua scripts only: ${foreign.join(", ")}`);

  const leaked = clientFacingFiles(m, all).filter((f) => encrypted.has(f));
  if (leaked.length > 0) {
    throw new Open77EscrowError(
      "client_file_encrypted",
      `these files are sent to game clients, so they cannot be encrypted: ${leaked.join(", ")}. Re-pack the release (the packer keeps client and shared files clear).`,
    );
  }

  const serverScripts = new Set<string>();
  for (const p of m.serverScripts) for (const f of expandGlob(p, all)) serverScripts.add(f);
  const stubs = [...serverScripts].filter((f) => encrypted.has(f)).sort();
  const unused = manifest.encryptedFiles.filter((f) => !serverScripts.has(f)).sort();

  const dest = join(opts.resourcesRoot, m.name);
  if (existsSync(dest)) {
    const isEscrowInstall = existsSync(join(dest, ESCROW_JSON));
    if (!isEscrowInstall && readdirSync(dest).length > 0 && !opts.force) {
      throw new Open77EscrowError("exists", `${dest} exists and is not an escrow install; pass --force to replace it.`);
    }
    rmSync(dest, { recursive: true });
  }
  mkdirSync(dest, { recursive: true });
  const write = (rel: string, data: Uint8Array | string): void => {
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    writeFileSync(join(dest, rel), data);
  };

  for (const [path, data] of clear) write(path, data);
  write(ESCROW_JSON, rawEscrowJson);
  write(ESCROW_PAYLOAD, payload);
  for (const path of stubs) write(path, escrowStub(manifest, path));

  const warnings: string[] = [];
  if (!opts.trustedSignerPublicKey) warnings.push("no --trusted-signer given: the signature proves integrity, not who signed. Pin the creator's release key.");

  // Re-check the installed folder with the parser the OPEN//77 rules are encoded in.
  const check = parseManifest(readFileSync(join(dest, "open77.lua"), "utf8"), { fileName: "open77.lua" });
  if (!check.ok) throw new Open77EscrowError("manifest", check.errors.map((e) => e.message).join("; "));
  const listed = (function walk(dir: string, prefix: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`]));
  })(dest, "");
  const problems = validateResourceFiles(check.manifest, listed);
  if (problems.length > 0) throw new Open77EscrowError("invalid_resource", problems.map((e) => e.message).join("; "));

  return { dest, name: m.name, package: manifest.package, version: manifest.version, stubs, unused, clear: [...clear.keys()].sort(), warnings };
}
