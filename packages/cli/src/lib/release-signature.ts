// Release signatures, checked by `scriptgo add` before a single file is written (ADR-0028).
//
// The registry signs every published release with its release-signing key: an ed25519 signature
// over { v, package, version, sha256, size, escrow, publishedAt }. The CLI trusts keys on first use
// per API and pins them in <config>/trusted-keys.json; a release signed by a key that is not pinned
// is refused until the operator accepts it (--trust-new-key), and SCRIPTGO_RELEASE_KEYS pins keys
// out of band (CI, production). Signing shows the bytes are the ones the registry published. It
// hides nothing: it is integrity and provenance, not secrecy.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ed25519Verify } from "@scriptgo/escrow";

export interface TrustedKey {
  keyId: string;
  /** Raw ed25519 public key, base64url. */
  publicKey: string;
}

export interface ReleaseSignature {
  alg: string;
  keyId: string;
  /** The canonical JSON that was signed. */
  payload: string;
  signature: string;
}

export function keyIdOf(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 16);
}

export function trustFile(): string {
  return join(process.env.SCRIPTGO_CONFIG_DIR || join(homedir(), ".scriptgo"), "trusted-keys.json");
}

type TrustStore = Record<string, TrustedKey[]>;

function readStore(): TrustStore {
  const file = trustFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TrustStore;
  } catch {
    throw new Error(`${file} is not valid JSON; delete it to trust the registry's keys again`);
  }
}

function writeStore(store: TrustStore): void {
  const file = trustFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2) + "\n");
}

/** Keys pinned out of band: SCRIPTGO_RELEASE_KEYS, comma-separated base64url public keys. */
function envKeys(): TrustedKey[] | null {
  const raw = process.env.SCRIPTGO_RELEASE_KEYS?.trim();
  if (!raw) return null;
  return raw.split(",").map((k) => k.trim()).filter(Boolean).map((publicKey) => ({ keyId: keyIdOf(publicKey), publicKey }));
}

export interface TrustDecision {
  keys: TrustedKey[];
  /** Messages for the terminal (first use, a new key accepted). */
  notes: string[];
}

/**
 * The keys this machine trusts for `api`, given what the registry serves now. First contact pins
 * them. Afterwards a key the registry serves that is not pinned is ignored unless `trustNew`; the
 * caller then refuses a release signed by it, with the fingerprint to compare.
 */
export function trustedKeysFor(api: string, served: TrustedKey[], opts: { trustNew?: boolean } = {}): TrustDecision {
  const fromEnv = envKeys();
  if (fromEnv) return { keys: fromEnv, notes: [] };
  const store = readStore();
  const pinned = store[api];
  const clean = served.filter((k) => /^[A-Za-z0-9_-]{43}$/.test(k.publicKey)).map((k) => ({ keyId: keyIdOf(k.publicKey), publicKey: k.publicKey }));
  if (!pinned || pinned.length === 0) {
    if (clean.length === 0) return { keys: [], notes: [] };
    store[api] = clean;
    writeStore(store);
    return { keys: clean, notes: [`trusting release key ${clean.map((k) => k.keyId).join(", ")} of ${api} (first use; pinned in ${trustFile()})`] };
  }
  const unknown = clean.filter((k) => !pinned.some((p) => p.publicKey === k.publicKey));
  if (unknown.length > 0 && opts.trustNew) {
    store[api] = [...pinned, ...unknown];
    writeStore(store);
    return { keys: store[api]!, notes: [`now also trusting release key ${unknown.map((k) => k.keyId).join(", ")} of ${api}`] };
  }
  return { keys: pinned, notes: [] };
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Checks the signature against trusted keys, then that it describes exactly these bytes. */
export function verifyRelease(
  sig: ReleaseSignature | null,
  keys: TrustedKey[],
  expected: { package: string; version: string; sha256: string },
): Verdict {
  if (!sig) return { ok: false, reason: "the registry sent no signature for this release" };
  if (sig.alg !== "ed25519") return { ok: false, reason: `unsupported signature algorithm ${sig.alg}` };
  const key = keys.find((k) => k.keyId === sig.keyId);
  if (!key) {
    return { ok: false, reason: `signed by release key ${sig.keyId}, which this machine does not trust. If the registry rotated its key, compare the fingerprint and rerun with --trust-new-key` };
  }
  let valid = false;
  try {
    valid = ed25519Verify(Buffer.from(sig.payload, "utf8"), Buffer.from(sig.signature, "base64url"), Buffer.from(key.publicKey, "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "the release signature does not verify (tampered, or signed by another key)" };
  let att: { package?: string; version?: string; sha256?: string };
  try {
    att = JSON.parse(sig.payload) as typeof att;
  } catch {
    return { ok: false, reason: "the signed payload is not JSON" };
  }
  if (att.package !== expected.package || att.version !== expected.version) {
    return { ok: false, reason: `the signature is for ${att.package}@${att.version}, not ${expected.package}@${expected.version}` };
  }
  if (att.sha256 !== expected.sha256) return { ok: false, reason: "the signed SHA-256 does not match the downloaded bytes (tampered or corrupted)" };
  return { ok: true };
}

/** The signature the download route sends in its headers, or null. */
export function signatureFromHeaders(h: Headers): ReleaseSignature | null {
  const signature = h.get("x-scriptgo-signature");
  const keyId = h.get("x-scriptgo-signature-key");
  const payload = h.get("x-scriptgo-signature-payload");
  if (!signature || !keyId || !payload) return null;
  return { alg: "ed25519", keyId, payload: Buffer.from(payload, "base64url").toString("utf8"), signature };
}
