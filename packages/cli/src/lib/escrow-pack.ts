// `scriptgo pack --escrow` and `scriptgo publish --escrow`: build the encrypted escrow variant of a
// resource. The packed archive (minus the clear allowlist) is encrypted with a fresh per-release
// content key; the bundle is safe to store/ship, the content key goes to the master only (handed
// over the authenticated API by `publish`, or written to a SEPARATE secret file by `pack`).
//
// What stays clear is decided in one place, `prepareEscrowFiles` (@scriptgo/manifest), which the
// master calls too when it protects an uploaded archive: files a host sends to game clients, and
// for a package that can run on OPEN//77 the generated open77.lua and shim, as signed clear files.
//
// Honest stance (CREATOR-PROTECTION.md): this is real crypto only where a host can hold the key (the
// .NET / native kits). On a pure-Lua host the operator can read the key, so escrow there is
// license-only-grade — the packer still produces a bundle, but the protection claim degrades. The
// CLI prints that where it matters.
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { buildEscrowRelease, openEscrowRelease, releaseSignerFromEnv, type BuiltEscrow, type ReleaseSigner } from "@scriptgo/escrow";
import { clientFacingFiles, prepareEscrowFiles, type ParsedManifest } from "@scriptgo/manifest";
import { sdkRoot } from "./sdk.ts";
import { configDir, isInside, writeSecretFile } from "./secret-files.ts";

// Kept as an export of this module for its callers; the rule itself lives in @scriptgo/manifest.
export { clientFacingFiles };

export interface EscrowPackResult {
  bundlePath: string;
  keyPath: string;
  /** How the key file is protected on this OS, in one honest line. */
  keyProtection: string;
  /** Set when the key file could not be restricted to the current user. */
  keyWarning: string | null;
  clearFiles: string[];
  encryptedFiles: string[];
  bytes: number;
}

/**
 * The creator's own ed25519 key: it signs `escrow.json`, so buyers and the master can tell who built
 * a bundle. SCRIPTGO_SIGNING_KEY (base64 32-byte seed), else RELEASE_SIGNING_KEY, else a key file
 * created on first use in the CLI config folder (~/.scriptgo, or SCRIPTGO_CONFIG_DIR). It is the
 * creator's key, not the registry's release-signing key and not the license-token key.
 */
export function creatorSigner(env: NodeJS.ProcessEnv = process.env): ReleaseSigner {
  const dir = env.SCRIPTGO_CONFIG_DIR || join(homedir(), ".scriptgo");
  const seed = env.SCRIPTGO_SIGNING_KEY?.trim() || env.RELEASE_SIGNING_KEY?.trim();
  // The key file is the creator's own; "production" only matters to the master's key loader.
  return releaseSignerFromEnv({ ...env, RELEASE_SIGNING_KEY: seed ?? "", NODE_ENV: "development" }, join(dir, "release-signing.key"));
}

/**
 * Builds the escrow bundle of a plain SCRIPT//GO archive (entries `<name>/<path>`) in memory, and
 * proves it decrypts with its key before anything is shipped. `allowlist` are extra clear-text
 * globs; the manifest, the docs and every client-facing file are always clear, and only server-side
 * code is encrypted. Each bundle gets a release-level watermark: an opaque token only this build
 * knows, recorded by the master so a leaked copy names its release.
 */
export function buildEscrow(opts: {
  archive: Uint8Array;
  manifest: ParsedManifest;
  manifestFile: string;
  /** "creator//name": bound into the ciphertext and every wrapped key (the release's AAD). */
  identifier: string;
  allowlist: string[];
  signer?: ReleaseSigner;
}): BuiltEscrow {
  const m = opts.manifest;
  const prefix = `${m.name}/`;
  const source = new Map<string, Buffer>();
  for (const [path, data] of Object.entries(unzipSync(opts.archive))) {
    if (!path.startsWith(prefix)) continue;
    source.set(path.slice(prefix.length), Buffer.from(data));
  }
  if (!source.has(opts.manifestFile)) throw new Error(`escrow: the archive has no ${opts.manifestFile}.`);

  // The same file set the master builds: client-facing files clear, OPEN//77 files generated and signed.
  const prepared = prepareEscrowFiles({ manifest: m, manifestFile: opts.manifestFile, files: source, allowlist: opts.allowlist, shimDir: join(sdkRoot, "adapters", "open77") });
  const files = prepared.files;

  const signer = opts.signer ?? creatorSigner();
  const built = buildEscrowRelease({
    files, package: opts.identifier, version: m.version, manifestFile: opts.manifestFile,
    allowlist: prepared.allowlist, signingSeed: signer.seed, watermarkSecret: randomBytes(32).toString("hex"),
  });
  if (built.encryptedFiles.length === 0) {
    throw new Error("escrow: nothing would be encrypted: every file is client-facing or in the clear-text allowlist (--escrow-ignore). Only server-side code can be protected.");
  }

  // Prove the bundle decrypts with the key before shipping either (never ship an unopenable bundle).
  const reopened = openEscrowRelease({ bundle: built.bundle, contentKey: built.contentKey, trustedSignerPublicKey: built.manifest.signerPublicKey });
  for (const path of built.encryptedFiles) {
    if (!reopened.get(path)?.equals(files.get(path)!)) throw new Error(`escrow self-check failed for ${path}`);
  }
  return built;
}

/** Where `pack --escrow` writes a content key by default: the CLI config folder, never the output folder. */
export function defaultEscrowKeyPath(name: string, version: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "escrow-keys", `${name}-${version}.escrow-key.json`);
}

/**
 * Turns the plain archive into an escrow bundle + a secret key file on disk (`scriptgo pack
 * --escrow`). Publish the pair later with `scriptgo publish --bundle <zip> --escrow-key <json>`.
 *
 * The key file goes to the CLI config folder (`defaultEscrowKeyPath`) unless `keyPath` says
 * otherwise, and never into the output folder, where it would travel with the bundle. It is a key in
 * clear on disk: 0600 on POSIX, an ACL for the current user on Windows (writeSecretFile).
 */
export function packEscrow(opts: {
  archive: Uint8Array;
  manifest: ParsedManifest;
  manifestFile: string;
  identifier: string;
  outDir: string;
  allowlist: string[];
  keyPath?: string;
}): EscrowPackResult {
  const m = opts.manifest;
  const keyPath = resolve(opts.keyPath ?? defaultEscrowKeyPath(m.name, m.version));
  if (isInside(keyPath, opts.outDir)) {
    throw new Error(`escrow: the content key file ${keyPath} would be inside the output folder ${resolve(opts.outDir)}, next to the bundle; write it elsewhere (--escrow-key-out)`);
  }
  const built = buildEscrow(opts);

  mkdirSync(opts.outDir, { recursive: true });
  const bundlePath = join(opts.outDir, `${m.name}-${m.version}.escrow.zip`);
  writeFileSync(bundlePath, built.bundle);
  const written = writeSecretFile(keyPath, JSON.stringify({
    note: "SECRET. Upload to the SCRIPT//GO master at publish; never commit or ship this with the bundle.",
    package: opts.identifier, version: m.version, aad: built.manifest.aad,
    contentKeyBase64: built.contentKey.toString("base64"),
    signerPublicKey: built.manifest.signerPublicKey,
  }, null, 2) + "\n");
  built.contentKey.fill(0);

  return {
    bundlePath, keyPath: written.path, keyProtection: written.protection, keyWarning: written.warning,
    clearFiles: built.clearFiles, encryptedFiles: built.encryptedFiles, bytes: built.bundle.length,
  };
}
