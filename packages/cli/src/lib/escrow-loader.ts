// The reference escrow loader behind `scriptgo escrow load`.
//
// REFERENCE LOADER, NOT A COMPILED HOST. It is plain JavaScript on Node: the operator of the machine
// can read it, read its memory and read what it writes. It exists to show the protocol end to end,
// to test the master, and as the labelled licence-only fallback for hosts that run plain script
// (it can write the decrypted copy to disk on the bound server, with the delivery marker). Real code
// escrow needs a compiled host that holds the key and decrypts in memory: the .NET kit
// (sdk/dotnet, ScriptGo.Host.Escrow) is the one that exists.
//
// What it does, in order: verify escrow.json against the signer key you trust, ask the master for
// the content key wrapped to this server's X25519 key (POST /v1/licenses/key), unwrap it with the
// private key that never leaves this machine, decrypt in memory, check every hash, add the delivery
// marker. It never writes a key to disk. A definitive refusal stops it; a master that cannot answer
// does not release a key either, so a cold start always needs the master.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import {
  DELIVERY_MARKER,
  generateX25519KeyPair,
  openEscrowRelease,
  readBundle,
  unwrapContentKey,
  verifyManifest,
  type EscrowManifest,
  type X25519KeyPair,
} from "@scriptgo/escrow";

export const LOADER_LABEL = "reference loader, not a compiled host";

export interface ServerIdentity extends X25519KeyPair {
  /** Short fingerprint of the public key: what the dashboard shows as "bound to". */
  fingerprint: string;
  created: boolean;
}

export function fingerprintOf(publicKey: Buffer): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

/**
 * The server's X25519 identity, created on first use. The private key stays in this file on this
 * machine (mode 0600); only the public key goes to the master. Copying the resource folder to
 * another machine does not copy a usable identity unless this file is copied too, and a second
 * machine with the same deployment token and another identity is refused (server_key_mismatch).
 */
export function loadIdentity(file: string): ServerIdentity {
  const path = resolve(file);
  if (existsSync(path)) {
    const j = JSON.parse(readFileSync(path, "utf8")) as { publicKey?: string; privateKey?: string };
    if (!j.publicKey || !j.privateKey) throw new Error(`${path} is not a server identity file`);
    const publicKey = Buffer.from(j.publicKey, "base64url");
    return { publicKey, privateKey: Buffer.from(j.privateKey, "base64url"), fingerprint: fingerprintOf(publicKey), created: false };
  }
  const pair = generateX25519KeyPair();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        note: "SCRIPT//GO server identity (X25519). SECRET: the private key must stay on this server. Do not copy it with a resource.",
        alg: "X25519",
        publicKey: pair.publicKey.toString("base64url"),
        privateKey: pair.privateKey.toString("base64url"),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return { ...pair, fingerprint: fingerprintOf(pair.publicKey), created: true };
}

export interface KeyAnswer {
  valid: boolean;
  reason: string | null;
  wrappedKey: { epk: string; nonce: string; wrapped: string } | null;
  aad: string | null;
  signerPublicKey: string | null;
  deliveryWatermark: string | null;
  offlineGraceUntil: string | null;
  expiresAt: string | null;
}

export type KeyOutcome =
  /** The master answered with a key. */
  | { kind: "released"; answer: KeyAnswer }
  /** A definitive refusal: unknown key, revoked, refunded, another server key, and so on. */
  | { kind: "refused"; reason: string }
  /** The master could not answer (network error, 4xx, 5xx). Only this case uses offline grace. */
  | { kind: "unreachable"; detail: string };

export interface LoadRequest {
  master: string;
  deploymentToken: string;
  package: string;
  environment: string;
  version?: string | null;
  adapterVersion?: string | null;
  identity: X25519KeyPair;
  fetchImpl?: typeof fetch;
}

/** One call to POST /v1/licenses/key. Never throws for an API answer. */
export async function requestKey(req: LoadRequest): Promise<KeyOutcome> {
  const f = req.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${req.master.replace(/\/$/, "")}/v1/licenses/key`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        deploymentToken: req.deploymentToken,
        package: req.package,
        version: req.version ?? null,
        environment: req.environment,
        adapterVersion: req.adapterVersion ?? null,
        serverPublicKey: req.identity.publicKey.toString("base64url"),
      }),
    });
  } catch (e) {
    return { kind: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { kind: "unreachable", detail: `HTTP ${res.status}` };
  const answer = (await res.json().catch(() => null)) as KeyAnswer | null;
  if (!answer || typeof answer.valid !== "boolean") return { kind: "unreachable", detail: "unreadable answer" };
  if (!answer.valid) return { kind: "refused", reason: answer.reason ?? "refused" };
  if (!answer.wrappedKey || !answer.aad) return { kind: "unreachable", detail: "answer without a key" };
  return { kind: "released", answer };
}

export interface LoadedRelease {
  manifest: EscrowManifest;
  /** Every file of the resource, clear and decrypted, plus the delivery marker. In memory. */
  files: Map<string, Buffer>;
  answer: KeyAnswer;
}

export class LoaderRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Verifies the bundle before any network call. `trustedSigner` is the ed25519 key you pinned for
 * this creator (GET /v1/creators/:username/signing-keys, or the release page). Without it only the
 * bundle's self-consistency is checked, which proves integrity but not who signed it.
 */
export function checkBundle(bundle: Buffer, trustedSigner: string | null): EscrowManifest {
  let read: ReturnType<typeof readBundle>;
  try {
    read = readBundle(bundle);
  } catch (e) {
    throw new LoaderRefusal("bundle_invalid", e instanceof Error ? e.message : "not an escrow bundle");
  }
  const { manifest, clear, payload } = read;
  const verdict = verifyManifest(manifest, trustedSigner ? { trustedSignerPublicKey: trustedSigner } : {});
  if (!verdict.ok) throw new LoaderRefusal("bundle_tampered", `the bundle does not verify: ${verdict.reason}`);
  // Every hash in the signed manifest is checked before the master is asked for anything: a
  // tampered bundle never causes a key release.
  const sha = (d: Buffer) => createHash("sha256").update(d).digest("hex");
  if (sha(payload) !== manifest.payload.sha256) throw new LoaderRefusal("bundle_tampered", "payload.enc does not match the signed manifest");
  for (const entry of manifest.clearFiles) {
    const got = clear.get(entry.path);
    if (!got || sha(got) !== entry.sha256) throw new LoaderRefusal("bundle_tampered", `the clear file ${entry.path} is missing or was changed`);
  }
  for (const path of clear.keys()) {
    if (!manifest.clearFiles.some((c) => c.path === path)) throw new LoaderRefusal("bundle_tampered", `${path} was added to the bundle`);
  }
  return manifest;
}

/** Unwraps the key with this server's private key and decrypts the bundle in memory. */
export function openWithAnswer(bundle: Buffer, answer: KeyAnswer, identity: X25519KeyPair, trustedSigner: string | null): Map<string, Buffer> {
  const aad = Buffer.from(answer.aad!, "utf8");
  let contentKey: Buffer;
  try {
    contentKey = unwrapContentKey(answer.wrappedKey!, identity.privateKey, identity.publicKey, aad);
  } catch {
    // The key was wrapped to another server key: this is a copy on a machine that is not the bound one.
    throw new LoaderRefusal("unbound", "the key released by the master is not wrapped to this server's identity");
  }
  try {
    const files = openEscrowRelease({ bundle, contentKey, trustedSignerPublicKey: trustedSigner ?? answer.signerPublicKey ?? undefined });
    // The delivery marker: the token the master logged for this license and deployment. Traceability
    // only: it makes a leaked copy attributable, it prevents nothing.
    files.set(
      DELIVERY_MARKER,
      Buffer.from(
        JSON.stringify(
          {
            note: "SCRIPT//GO escrow delivery marker. Traceability only; this copy is attributable to the license and deployment it was delivered to.",
            releaseId: answer.aad,
            token: answer.deliveryWatermark,
            stampedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
        "utf8",
      ),
    );
    return files;
  } catch (e) {
    throw new LoaderRefusal("bundle_tampered", e instanceof Error ? e.message : "the bundle does not decrypt");
  } finally {
    contentKey.fill(0);
  }
}

/** The whole load: check the bundle, get the key, decrypt in memory. Throws LoaderRefusal. */
export async function loadRelease(bundle: Buffer, req: LoadRequest & { trustedSigner: string | null }): Promise<LoadedRelease> {
  const manifest = checkBundle(bundle, req.trustedSigner);
  const outcome = await requestKey({ ...req, version: req.version ?? manifest.version });
  if (outcome.kind === "refused") throw new LoaderRefusal(outcome.reason, `the master refused the key: ${outcome.reason}`);
  if (outcome.kind === "unreachable") {
    throw new LoaderRefusal("master_unreachable", `the master did not answer (${outcome.detail}); a key is never kept on disk, so a start needs the master`);
  }
  if (outcome.answer.aad !== manifest.aad) throw new LoaderRefusal("release_mismatch", `the master released a key for ${outcome.answer.aad}, the bundle is ${manifest.aad}`);
  return { manifest, files: openWithAnswer(bundle, outcome.answer, req.identity, req.trustedSigner), answer: outcome.answer };
}

/**
 * Writes the decrypted resource to disk for a host that can only read files. LICENCE-ONLY GRADE:
 * once on disk the operator can read it. The delivery marker goes with it. Paths are re-checked:
 * nothing is written outside `dir`.
 */
export function materialize(files: Map<string, Buffer>, dir: string): string {
  const root = resolve(dir);
  rmSync(root, { recursive: true, force: true });
  for (const [name, data] of files) {
    if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..")) {
      throw new LoaderRefusal("bundle_invalid", `refusing unsafe path '${name}'`);
    }
    const file = resolve(root, name);
    if (!file.startsWith(root + sep)) throw new LoaderRefusal("bundle_invalid", `refusing '${name}': outside ${root}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  return root;
}

/** When a running loader must stop: the offline grace of its last valid answer, as a time. */
export function graceEnd(answer: KeyAnswer): number {
  return answer.offlineGraceUntil ? new Date(answer.offlineGraceUntil).getTime() : 0;
}

export const markerPath = (dir: string): string => join(dir, DELIVERY_MARKER);
