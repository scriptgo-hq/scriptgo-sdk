// The asset vectors, built from fixed test material (never a real key). Shared by the generator
// (tools/gen-asset-vectors.ts) and the test that checks the committed JSON is reproduced exactly.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { zipSync } from "fflate";
import {
  assetClientAad,
  assetKeyId,
  assetServerAad,
  buildFingerprinted,
  deriveAssetContentKey,
  ed25519FromSeed,
  escrowedPreloadTransform,
  sealAssetContainer,
  wrapAssetKeyForClient,
  wrapContentKey,
  type X25519KeyPair,
} from "../../src/index.ts";

const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX_LEN = 12;

/** A fixed X25519 key pair from a private key (test material). */
export function fixedX25519(privateHex: string): X25519KeyPair {
  const privateKey = Buffer.from(privateHex, "hex");
  const pub = createPublicKey(createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, privateKey]), format: "der", type: "pkcs8" }));
  return { privateKey, publicKey: Buffer.from(pub.export({ type: "spki", format: "der" }).subarray(X25519_SPKI_PREFIX_LEN)) };
}

export const MATERIAL = {
  fingerprintSecret: Buffer.alloc(32, 0x33),
  fingerprintSignerSeed: Buffer.alloc(32, 0x44),
  assetSignerSeed: Buffer.alloc(32, 0x55),
  /** A signer nobody pins: the self-signed containers a reader must refuse. */
  strangerSignerSeed: Buffer.alloc(32, 0x66),
  releaseSecret: Buffer.alloc(32, 0x66),
  client: fixedX25519("a8abababababababababababababababababababababababababababababab6b"),
  ephemeral: fixedX25519("c8cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd4d"),
  server: fixedX25519("98999999999999999999999999999999999999999999999999999999999999d9"),
  serverEphemeral: fixedX25519("e8efefefefefefefefefefefefefefefefefefefefefefefefefefefefefef6f"),
};

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
// Local midnight: zip times are local wall-clock (DOS), so a UTC instant would change with the time zone.
const FIXED = new Date(2026, 0, 1);

/** A small release archive: a resource folder with a script, a texture and an OPEN//77 preload. */
export function releaseArchive(): { zip: Buffer; preload: Buffer } {
  const preload = Buffer.from(
    zipSync(
      {
        "archive/pc/mod/night_market.archive": Buffer.concat([Buffer.from("RDAR", "ascii"), Buffer.alloc(60, 7)]),
        "archive/pc/mod/night_market.archive.xl": Buffer.from("streaming:\n  sectors: []\n", "utf8"),
      },
      { level: 6, mtime: FIXED },
    ),
  );
  const zip = Buffer.from(
    zipSync(
      {
        "night_market/scriptgo.lua": Buffer.from('resource "night_market"\nversion "2.0.0"\nscriptgo_version ">=0.1.0"\nenvironment_asset "open77" "dist/night_market.zip"\n'),
        "night_market/media/night_market_sign.png": Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(40, 1)]),
        "night_market/dist/night_market.zip": [preload, { level: 0 }],
      },
      { level: 9, mtime: FIXED },
    ),
  );
  return { zip, preload };
}

/** Where an OPEN//77 preload carries its fingerprint (@scriptgo/manifest fingerprintEntryPath("open77", ...)). */
export const OPEN77_PRELOAD_ENTRY = "archive/pc/mod/night_market.scriptgo-fingerprint.json";

export function assetVectors(): Record<string, unknown> {
  const { zip, preload } = releaseArchive();
  const identity = { package: "kestrel//night-market", version: "2.0.0", release: "rel_01", licence: "lic_42", deployment: "dep_7" };
  const build = buildFingerprinted({
    zip,
    root: "night_market/",
    containers: [{ path: "night_market/dist/night_market.zip", entry: OPEN77_PRELOAD_ENTRY }],
    identity,
    secret: MATERIAL.fingerprintSecret,
    signerSeed: MATERIAL.fingerprintSignerSeed,
  });

  const contentKey = deriveAssetContentKey(MATERIAL.releaseSecret, identity.deployment);
  const files = new Map<string, Buffer>([
    ["archive/pc/mod/night_market.archive", Buffer.concat([Buffer.from("RDAR", "ascii"), Buffer.alloc(9000, 9)])],
    ["textures/empty.png", Buffer.alloc(0)],
    ["textures/exact.bin", Buffer.alloc(4096, 3)],
  ]);
  const container = sealAssetContainer({
    files, package: identity.package, version: identity.version, release: identity.release, deployment: identity.deployment,
    contentKey, signerSeed: MATERIAL.assetSignerSeed, fingerprint: build.marker, chunkBytes: 4096,
  });
  // The same files sealed under the same key by someone else (whoever holds the content key can) and
  // signed with their own key: it verifies under the key its header names, so only a pinned signer refuses it.
  const stranger = sealAssetContainer({
    files, package: identity.package, version: identity.version, release: identity.release, deployment: identity.deployment,
    contentKey, signerSeed: MATERIAL.strangerSignerSeed, fingerprint: build.marker, chunkBytes: 4096,
  });
  const keyId = assetKeyId(contentKey);
  const serverWrap = wrapContentKey(contentKey, MATERIAL.server.publicKey, assetServerAad(identity.package, identity.version, identity.deployment), { ephemeral: MATERIAL.serverEphemeral, nonce: Buffer.alloc(12, 0x5a) });
  // The same copy with its OPEN//77 preload escrowed for the deployment (docs/spec/assets.md, "OPEN//77").
  const escrowed = buildFingerprinted({
    zip,
    root: "night_market/",
    containers: [{ path: "night_market/dist/night_market.zip", entry: OPEN77_PRELOAD_ENTRY }],
    identity,
    secret: MATERIAL.fingerprintSecret,
    signerSeed: MATERIAL.fingerprintSignerSeed,
    transform: escrowedPreloadTransform({
      identity, releaseSecret: MATERIAL.releaseSecret, fingerprintSecret: MATERIAL.fingerprintSecret,
      signerSeed: MATERIAL.fingerprintSignerSeed, escrowed: ["night_market/dist/night_market.zip"], chunkBytes: 4096,
    }),
  });
  const clientWrap = wrapAssetKeyForClient(contentKey, MATERIAL.client.publicKey, assetClientAad(identity.package, identity.version, keyId), { ephemeral: MATERIAL.ephemeral, nonce: Buffer.alloc(12, 0x77) });

  return {
    note: "Test-only material. Every value is reproduced by packages/escrow/test/asset-vectors.test.ts; see docs/spec/assets.md.",
    fingerprint: {
      identity,
      secret: MATERIAL.fingerprintSecret.toString("base64"),
      signerSeed: MATERIAL.fingerprintSignerSeed.toString("base64"),
      signerPublicKey: ed25519FromSeed(MATERIAL.fingerprintSignerSeed).publicKey.toString("base64url"),
      root: "night_market/",
      containers: [{ path: "night_market/dist/night_market.zip", entry: OPEN77_PRELOAD_ENTRY }],
      input: { zipBase64: zip.toString("base64"), sha256: sha(zip), preloadSha256: sha(preload) },
      output: { zipBase64: build.zip.toString("base64"), sha256: build.sha256, marker: build.marker, containers: build.containers },
    },
    assetEscrow: {
      releaseSecret: MATERIAL.releaseSecret.toString("base64"),
      deployment: identity.deployment,
      contentKey: contentKey.toString("base64"),
      keyId,
      signerSeed: MATERIAL.assetSignerSeed.toString("base64"),
      signerPublicKey: ed25519FromSeed(MATERIAL.assetSignerSeed).publicKey.toString("base64url"),
      chunkBytes: 4096,
      files: [...files].map(([path, data]) => ({ path, bytes: data.length, sha256: sha(data) })),
      containerBase64: container.toString("base64"),
      containerSha256: sha(container),
      strangerContainerBase64: stranger.toString("base64"),
      serverAad: assetServerAad(identity.package, identity.version, identity.deployment).toString("utf8"),
      server: {
        privateKey: MATERIAL.server.privateKey.toString("base64url"),
        publicKey: MATERIAL.server.publicKey.toString("base64url"),
        aad: assetServerAad(identity.package, identity.version, identity.deployment).toString("utf8"),
        wrapped: serverWrap,
      },
      escrowedCopy: {
        signerPublicKey: ed25519FromSeed(MATERIAL.fingerprintSignerSeed).publicKey.toString("base64url"),
        zipBase64: escrowed.zip.toString("base64"),
        sha256: escrowed.sha256,
        containers: escrowed.containers,
        preloadEntry: "archive/pc/mod/night_market.sgae",
        preloadFiles: [
          { path: "archive/pc/mod/night_market.archive", sha256: sha(Buffer.concat([Buffer.from("RDAR", "ascii"), Buffer.alloc(60, 7)])) },
          { path: "archive/pc/mod/night_market.archive.xl", sha256: sha(Buffer.from("streaming:\n  sectors: []\n", "utf8")) },
        ],
      },
      client: {
        privateKey: MATERIAL.client.privateKey.toString("base64url"),
        publicKey: MATERIAL.client.publicKey.toString("base64url"),
        ephemeralPrivateKey: MATERIAL.ephemeral.privateKey.toString("base64url"),
        wrapNonce: Buffer.alloc(12, 0x77).toString("base64url"),
        aad: assetClientAad(identity.package, identity.version, keyId).toString("utf8"),
        wrapped: clientWrap,
        // Another deployment's key, wrapped the same way: opens the wrap, must not open the container.
        otherWrapped: wrapAssetKeyForClient(deriveAssetContentKey(MATERIAL.releaseSecret, "dep_8"), MATERIAL.client.publicKey, assetClientAad(identity.package, identity.version, keyId), { ephemeral: MATERIAL.ephemeral, nonce: Buffer.alloc(12, 0x78) }),
      },
    },
  };
}
