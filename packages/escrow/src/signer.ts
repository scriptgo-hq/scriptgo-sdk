import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { ed25519FromSeed } from "./crypto.ts";

/**
 * The ed25519 release-signing key. It signs escrow manifests (provenance + tamper-evidence); it is a
 * distinct key from the license verify-token signer, so compromising one never forges the other.
 * RELEASE_SIGNING_KEY (base64 32-byte seed) when set; otherwise, outside production, a seed kept in
 * `devKeyFile` so signatures stay verifiable across restarts. Production requires the env.
 */
export interface ReleaseSigner {
  seed: Buffer;
  publicKeyBase64Url: string;
}

export function releaseSignerFromSeed(seed: Buffer): ReleaseSigner {
  return { seed, publicKeyBase64Url: ed25519FromSeed(seed).publicKey.toString("base64url") };
}

export function releaseSignerFromEnv(env: NodeJS.ProcessEnv, devKeyFile: string): ReleaseSigner {
  const configured = env.RELEASE_SIGNING_KEY?.trim();
  if (configured) return releaseSignerFromSeed(Buffer.from(configured, "base64"));
  if (env.NODE_ENV === "production") throw new Error("RELEASE_SIGNING_KEY is required in production.");
  if (existsSync(devKeyFile)) return releaseSignerFromSeed(Buffer.from(readFileSync(devKeyFile, "utf8").trim(), "base64"));
  const seed = randomBytes(32);
  mkdirSync(dirname(devKeyFile), { recursive: true });
  writeFileSync(devKeyFile, seed.toString("base64"), { mode: 0o600 });
  return releaseSignerFromSeed(seed);
}
