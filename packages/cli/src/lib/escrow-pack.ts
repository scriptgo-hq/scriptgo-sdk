// `scriptgo pack --escrow`: builds the encrypted escrow variant of a resource. The packed archive
// (minus the clear allowlist) is encrypted with a fresh per-release content key; the bundle is safe
// to store/ship, the content key is written to a SEPARATE secret file for the master only.
//
// Honest stance (CREATOR-PROTECTION.md): this is real crypto only where a host can hold the key (the
// .NET / native kits). On a pure-Lua host the operator can read the key, so escrow there is
// license-only-grade — the packer still produces a bundle, but the protection claim degrades. The
// CLI prints that where it matters.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { buildEscrowRelease, openEscrowRelease, releaseSignerFromEnv } from "@scriptgo/escrow";
import { expandGlob, type ParsedManifest } from "@scriptgo/manifest";

export interface EscrowPackResult {
  bundlePath: string;
  keyPath: string;
  clearFiles: string[];
  encryptedFiles: string[];
  bytes: number;
}

/** Paths a host sends to game clients: they cannot be secret, so they must be clear in the bundle. */
export function clientFacingFiles(m: ParsedManifest, all: string[]): string[] {
  const out = new Set<string>();
  const add = (pattern: string): void => {
    for (const f of expandGlob(pattern, all)) out.add(f);
  };
  for (const p of [...m.sharedScripts, ...m.clientScripts, ...m.files, ...m.webFiles]) add(p);
  // OPEN//77 loads its environment scripts as shared scripts, so they reach clients too.
  for (const p of m.environmentScripts["open77"] ?? []) add(p);
  if (m.webUiPage) add(m.webUiPage);
  return [...out].sort();
}

/**
 * Turns the plain SCRIPT//GO archive (entries `<name>/<path>`) into an escrow bundle + a secret key
 * file. `allowlist` are extra clear-text globs (the manifest and docs are always clear). The signing
 * key is RELEASE_SIGNING_KEY or a dev key under ~/.scriptgo. Self-checks the round-trip before writing.
 */
export function packEscrow(opts: {
  archive: Uint8Array;
  manifest: ParsedManifest;
  manifestFile: string;
  identifier: string;
  outDir: string;
  allowlist: string[];
}): EscrowPackResult {
  const m = opts.manifest;
  const prefix = `${m.name}/`;
  const files = new Map<string, Buffer>();
  for (const [path, data] of Object.entries(unzipSync(opts.archive))) {
    if (!path.startsWith(prefix)) continue;
    files.set(path.slice(prefix.length), Buffer.from(data));
  }
  if (!files.has(opts.manifestFile)) throw new Error(`escrow: the archive has no ${opts.manifestFile}.`);

  // Files a host sends to game clients (shared and client scripts, files, web files) cannot be
  // secret: they stay clear, so only server-side code is encrypted.
  const clientFacing = clientFacingFiles(m, [...files.keys()]);

  const signer = releaseSignerFromEnv(process.env, join(homedir(), ".scriptgo", "release-signing.key"));
  const built = buildEscrowRelease({
    files, package: opts.identifier, version: m.version, manifestFile: opts.manifestFile,
    allowlist: [...clientFacing, ...opts.allowlist], signingSeed: signer.seed, watermarkSecret: undefined,
  });

  // Prove the bundle decrypts with the key before shipping either (never ship an unopenable bundle).
  const reopened = openEscrowRelease({ bundle: built.bundle, contentKey: built.contentKey, trustedSignerPublicKey: built.manifest.signerPublicKey });
  for (const path of built.encryptedFiles) {
    if (!reopened.get(path)?.equals(files.get(path)!)) throw new Error(`escrow self-check failed for ${path}`);
  }

  mkdirSync(opts.outDir, { recursive: true });
  const bundlePath = join(opts.outDir, `${m.name}-${m.version}.escrow.zip`);
  const keyPath = join(opts.outDir, `${m.name}-${m.version}.escrow-key.json`);
  writeFileSync(bundlePath, built.bundle);
  writeFileSync(keyPath, JSON.stringify({
    note: "SECRET. Upload to the SCRIPT//GO master at publish; never commit or ship this with the bundle.",
    package: opts.identifier, version: m.version, aad: built.manifest.aad,
    contentKeyBase64: built.contentKey.toString("base64"),
    signerPublicKey: built.manifest.signerPublicKey,
  }, null, 2) + "\n", { mode: 0o600 });

  return { bundlePath, keyPath, clearFiles: built.clearFiles, encryptedFiles: built.encryptedFiles, bytes: built.bundle.length };
}
