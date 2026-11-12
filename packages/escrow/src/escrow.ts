import { createHash } from "node:crypto";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { canonicalJson } from "./canonical.ts";
import {
  aeadDecrypt,
  aeadEncrypt,
  ed25519FromSeed,
  ed25519Sign,
  ed25519Verify,
  randomContentKey,
} from "./crypto.ts";
import {
  ESCROW_CIPHER,
  ESCROW_FORMAT,
  ESCROW_JSON,
  ESCROW_KDF,
  ESCROW_PAYLOAD,
  type EscrowManifest,
} from "./format.ts";
import { watermarkToken } from "./watermark.ts";

const FIXED_MTIME = new Date("2026-01-01T00:00:00Z");

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** aad bytes binding the payload and the wrapped key to this exact release. */
export function releaseAad(pkg: string, version: string): Buffer {
  return Buffer.from(`${pkg}@${version}`, "utf8");
}

// --------------------------------------------------------------------------- allowlist (escrow_ignore)

/** The default clear-text allowlist: the manifest and the docs (modelled on FiveM `escrow_ignore`). */
export function defaultAllowlist(manifestFile: string): string[] {
  return [manifestFile, "README.md", "CHANGELOG.md", "LICENSE", "LICENSE.md", "LICENSE.txt"];
}

/** Minimal glob: `*` matches within a segment, `**` across segments; everything else is literal. */
export function matchesAllowlist(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += "[^\\0]*"; // ** : any characters, including '/'
        i++;
        if (glob[i + 1] === "/") i++; // swallow the slash after ** so stream/**/x matches stream/x
      } else re += "[^/]*";
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

// --------------------------------------------------------------------------- build

export interface BuildEscrowInput {
  /** Resource-relative paths → bytes (the plaintext resource, as `scriptgo pack` assembles it). */
  files: Map<string, Buffer>;
  /** Package identifier ("creator//name") or resource name — provenance only. */
  package: string;
  version: string;
  /** The manifest file name (scriptgo.lua / scriptgo.json / open77.lua): always kept clear. */
  manifestFile: string;
  /** Extra clear-text patterns the creator names (config, schemas). Manifest + docs are implicit. */
  allowlist?: string[];
  /** 32-byte ed25519 release-signing seed. */
  signingSeed: Buffer;
  /** HMAC secret for the release watermark. Omit to bake no watermark. */
  watermarkSecret?: string;
  /** The per-release content key. One is generated when omitted. */
  contentKey?: Buffer;
}

export interface BuiltEscrow {
  /** The escrow bundle (zip: escrow.json + clear files + payload.enc). Safe to store/ship. */
  bundle: Buffer;
  manifest: EscrowManifest;
  /** The per-release content key. Stored by the master, NEVER inside the bundle. */
  contentKey: Buffer;
  clearFiles: string[];
  encryptedFiles: string[];
}

export function buildEscrowRelease(input: BuildEscrowInput): BuiltEscrow {
  const contentKey = input.contentKey ?? randomContentKey();
  const allowlist = Array.from(new Set([...defaultAllowlist(input.manifestFile), ...(input.allowlist ?? [])]));
  const aad = releaseAad(input.package, input.version);

  const clear: Array<{ path: string; data: Buffer }> = [];
  const encrypted: Array<{ path: string; data: Buffer }> = [];
  for (const [path, data] of [...input.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (path === input.manifestFile || matchesAllowlist(path, allowlist)) clear.push({ path, data });
    else encrypted.push({ path, data });
  }

  const innerZip = Buffer.from(zipSync(Object.fromEntries(encrypted.map((f) => [f.path, f.data])) as Zippable, { level: 9, mtime: FIXED_MTIME }));
  const { nonce, ciphertext } = aeadEncrypt(contentKey, innerZip, aad);

  const manifest: EscrowManifest = {
    format: ESCROW_FORMAT,
    package: input.package,
    version: input.version,
    cipher: ESCROW_CIPHER,
    kdf: ESCROW_KDF,
    aad: aad.toString("utf8"),
    payload: { nonce: nonce.toString("base64url"), sha256: sha256(ciphertext), bytes: ciphertext.length },
    clearFiles: clear.map((f) => ({ path: f.path, sha256: sha256(f.data), bytes: f.data.length })),
    encryptedFiles: encrypted.map((f) => f.path),
    allowlist,
    signerPublicKey: ed25519FromSeed(input.signingSeed).publicKey.toString("base64url"),
    watermark: input.watermarkSecret ? watermarkToken({ releaseId: aad.toString("utf8") }, input.watermarkSecret) : null,
    signature: "",
  };
  manifest.signature = ed25519Sign(Buffer.from(canonicalJson(manifest), "utf8"), input.signingSeed).toString("base64url");

  const bundleEntries: Zippable = { [ESCROW_JSON]: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"), [ESCROW_PAYLOAD]: ciphertext };
  for (const f of clear) bundleEntries[f.path] = f.data;
  const bundle = Buffer.from(zipSync(bundleEntries, { level: 9, mtime: FIXED_MTIME }));
  return { bundle, manifest, contentKey, clearFiles: clear.map((f) => f.path), encryptedFiles: encrypted.map((f) => f.path) };
}

// --------------------------------------------------------------------------- read / verify / open

export interface ReadBundle {
  manifest: EscrowManifest;
  clear: Map<string, Buffer>;
  payload: Buffer;
}

export function readBundle(bundle: Buffer): ReadBundle {
  const entries = unzipSync(bundle);
  const json = entries[ESCROW_JSON];
  if (!json) throw new Error("not an escrow bundle: escrow.json is missing.");
  const manifest = JSON.parse(Buffer.from(json).toString("utf8")) as EscrowManifest;
  const payloadRaw = entries[ESCROW_PAYLOAD];
  if (!payloadRaw) throw new Error("escrow bundle has no payload.enc.");
  const clear = new Map<string, Buffer>();
  for (const [path, data] of Object.entries(entries)) {
    if (path === ESCROW_JSON || path === ESCROW_PAYLOAD) continue;
    clear.set(path, Buffer.from(data));
  }
  return { manifest, clear, payload: Buffer.from(payloadRaw) };
}

/**
 * The first entry of a bundle that the signed manifest does not account for, or a path the manifest
 * lists both clear and encrypted; null when the bundle holds exactly escrow.json, payload.enc and the
 * manifest's clear files. The signature covers the manifest, not the zip: an entry added next to a
 * validly signed manifest (a `server/evil.lua`) would otherwise be served as a clear file.
 */
export function bundleEntryProblem(manifest: EscrowManifest, clearEntries: Iterable<string>): string | null {
  const clearFiles = Array.isArray(manifest.clearFiles) ? manifest.clearFiles : [];
  const encryptedFiles = Array.isArray(manifest.encryptedFiles) ? manifest.encryptedFiles : [];
  const listed = new Set(clearFiles.map((f) => f.path));
  for (const path of encryptedFiles) if (listed.has(path)) return `${path} is listed both clear and encrypted`;
  for (const path of clearEntries) {
    if (path === ESCROW_JSON || path === ESCROW_PAYLOAD) continue;
    if (!listed.has(path)) return `${path} is in the bundle but not in escrow.json`;
  }
  return null;
}

export interface VerifyOptions {
  /**
   * The ed25519 public key (raw base64url) the loader trusts. When set, the manifest's own
   * `signerPublicKey` must equal it — otherwise an attacker could re-sign with their own key and the
   * signature would still "verify" (provenance, not just integrity). Omit only in tests.
   */
  trustedSignerPublicKey?: string;
}

/** Verifies the manifest signature and (when given) that it was signed by the trusted key. */
export function verifyManifest(manifest: EscrowManifest, options: VerifyOptions = {}): { ok: boolean; reason?: string } {
  if (manifest.format !== ESCROW_FORMAT) return { ok: false, reason: `unsupported format ${manifest.format}` };
  if (manifest.cipher !== ESCROW_CIPHER || manifest.kdf !== ESCROW_KDF) return { ok: false, reason: "unsupported cipher/kdf" };
  if (options.trustedSignerPublicKey && options.trustedSignerPublicKey !== manifest.signerPublicKey) {
    return { ok: false, reason: "signer is not the trusted release key" };
  }
  const signature = Buffer.from(manifest.signature, "base64url");
  const signed = ed25519Verify(Buffer.from(canonicalJson({ ...manifest, signature: "" }), "utf8"), signature, Buffer.from(manifest.signerPublicKey, "base64url"));
  return signed ? { ok: true } : { ok: false, reason: "bad signature" };
}

export interface OpenEscrowInput {
  bundle: Buffer;
  contentKey: Buffer;
  trustedSignerPublicKey?: string;
}

/**
 * The reference decryptor: verifies the signature and the payload hash, decrypts in memory, and
 * returns every file (clear + decrypted). The .NET loader mirrors this; vectors keep them in step.
 * Throws on any integrity failure (tamper-evident). Never writes a key or plaintext to disk.
 */
export function openEscrowRelease(input: OpenEscrowInput): Map<string, Buffer> {
  const { manifest, clear, payload } = readBundle(input.bundle);
  const verdict = verifyManifest(manifest, { trustedSignerPublicKey: input.trustedSignerPublicKey });
  if (!verdict.ok) throw new Error(`escrow verify failed: ${verdict.reason}`);
  const stray = bundleEntryProblem(manifest, clear.keys());
  if (stray) throw new Error(`escrow bundle refused: ${stray}`);
  if (sha256(payload) !== manifest.payload.sha256) throw new Error("escrow payload hash mismatch (tampered).");
  for (const entry of manifest.clearFiles) {
    const got = clear.get(entry.path);
    if (!got || sha256(got) !== entry.sha256) throw new Error(`clear file ${entry.path} is missing or tampered.`);
  }
  const aad = Buffer.from(manifest.aad, "utf8");
  const innerZip = aeadDecrypt(input.contentKey, Buffer.from(manifest.payload.nonce, "base64url"), payload, aad);
  const out = new Map<string, Buffer>(clear);
  const inner = unzipSync(innerZip);
  for (const [path, data] of Object.entries(inner)) out.set(path, Buffer.from(data));
  return out;
}
