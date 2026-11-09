/** The escrow on-the-wire format. Shared by the CLI packer, the master key endpoint and the .NET
 * loader; see docs/spec/escrow.md. Releases are immutable, so one content key per release. */

export const ESCROW_FORMAT = "scriptgo-escrow/1";
export const ESCROW_CIPHER = "AES-256-GCM";
export const ESCROW_KDF = "HKDF-SHA256+X25519";
export const ESCROW_SIG_ALG = "ed25519";

/** The clear-text `escrow.json` at the root of an escrow bundle. Everything here is readable. */
export interface EscrowManifest {
  format: typeof ESCROW_FORMAT;
  /** Package identifier ("creator//name") or the resource name — provenance, not a secret. */
  package: string;
  version: string;
  cipher: typeof ESCROW_CIPHER;
  kdf: typeof ESCROW_KDF;
  /** Additional authenticated data for the payload and the wrapped key: `${package}@${version}`. */
  aad: string;
  /** The AES-256-GCM payload (one blob of the encrypted inner zip). */
  payload: { nonce: string; sha256: string; bytes: number };
  /** Files left clear (manifest, docs, creator-named config), with their hashes for integrity. */
  clearFiles: Array<{ path: string; sha256: string; bytes: number }>;
  /** Paths of the files inside the encrypted payload (names only; contents are opaque). */
  encryptedFiles: string[];
  /** The `escrow_ignore`-style allowlist the bundle was built with (globs kept clear). */
  allowlist: string[];
  /** ed25519 public key (raw, base64url) that signed this manifest — provenance. */
  signerPublicKey: string;
  /** Release-level watermark (HMAC over the release identity); traceability, not prevention. */
  watermark: string | null;
  /** ed25519 signature (base64url) over the canonical manifest with this field empty. */
  signature: string;
}

export const ESCROW_JSON = "escrow.json";
export const ESCROW_PAYLOAD = "payload.enc";
/** Marker file a loader writes into a materialized/decrypted copy to attribute a later leak. */
export const DELIVERY_MARKER = ".scriptgo-escrow";
