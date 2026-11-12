// The client-escrow vectors (docs/spec/client-escrow.md, "Vector"), built from fixed test material
// (never a real key). Shared by the generator (tools/gen-client-vectors.ts) and the test that checks
// the committed JSON is reproduced exactly.
import { createHash } from "node:crypto";
import {
  clientKeyId,
  clientServerAad,
  clientSessionAad,
  compileClientScript,
  deriveAssetContentKey,
  deriveClientContentKey,
  ed25519FromSeed,
  LUA_548_TARGET,
  sealClientContainer,
  wrapClientKeyForSession,
  wrapContentKey,
} from "../../src/index.ts";
import { fixedX25519, MATERIAL } from "./build.ts";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export const CLIENT_PACKAGE = "kestrel//night-market";
export const CLIENT_VERSION = "2.0.0";
export const CLIENT_DEPLOYMENT = "dep_7";

/** The two client scripts of the vector: one sets a global and returns a table, one raises an error. */
export const CLIENT_SOURCES: Record<string, string> = {
  "client/main.lua": [
    "-- the vector's client entry script",
    "SGCE_LOADED = (SGCE_LOADED or 0) + 1",
    'local tag = "sgce-vector-constant"',
    "return { answer = 6 * 7, tag = tag }",
    "",
  ].join("\n"),
  "client/fail.lua": ["local function deep(t)", "  return t.missing.field", "end", "return deep", ""].join("\n"),
};

const sessionPair = fixedX25519("b8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb7b");
const sessionEphemeral = fixedX25519("d8dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd5d");

export function clientVectors(): Record<string, unknown> {
  const pkg = CLIENT_PACKAGE, version = CLIENT_VERSION, deployment = CLIENT_DEPLOYMENT;
  const compiled = Object.entries(CLIENT_SOURCES).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, src]) => compileClientScript(src, { package: pkg, version, path, strip: "full" }));
  const chunks = new Map(compiled.map((c) => [c.path, c.bytecode]));
  const contentKey = deriveClientContentKey(MATERIAL.releaseSecret, deployment);
  const keyId = clientKeyId(contentKey);
  const fingerprint = "fp_vector_marker";
  const container = sealClientContainer({ chunks, package: pkg, version, release: "rel_01", deployment, contentKey, signerSeed: MATERIAL.assetSignerSeed, strip: "full", fingerprint });

  // A container whose declared target is another VM's (a 5.3-looking header): the target check refuses it.
  const otherTarget = { lua: "5.3.6", luacHeader: LUA_548_TARGET.luacHeader.replace(/^1b4c756154/, "1b4c756153") };
  const foreignChunks = new Map([...chunks].map(([p, b]) => [p, Buffer.concat([Buffer.from(otherTarget.luacHeader, "hex"), b.subarray(31)])]));
  const foreignTarget = sealClientContainer({ chunks: foreignChunks, package: pkg, version, release: "rel_01", deployment, contentKey, signerSeed: MATERIAL.assetSignerSeed, strip: "full", fingerprint, target: otherTarget });
  // A container that declares the right target over a chunk that is not that VM's bytecode: the loader
  // checks the decrypted bytes too.
  const lying = sealClientContainer({ chunks: foreignChunks, package: pkg, version, release: "rel_01", deployment, contentKey, signerSeed: MATERIAL.assetSignerSeed, strip: "full", fingerprint, unchecked: { skipTargetCheck: true } });
  // Opcode permutation generation 1: specified, not supported by v1 readers.
  const permuted = sealClientContainer({ chunks, package: pkg, version, release: "rel_01", deployment, contentKey, signerSeed: MATERIAL.assetSignerSeed, strip: "full", fingerprint, unchecked: { permGeneration: 1 } });

  const serverAad = clientServerAad(pkg, version, deployment);
  const serverWrap = wrapContentKey(contentKey, MATERIAL.server.publicKey, serverAad, { ephemeral: MATERIAL.serverEphemeral, nonce: Buffer.alloc(12, 0x5b) });
  const sessionAad = clientSessionAad(pkg, version, keyId);
  const sessionWrap = wrapClientKeyForSession(contentKey, sessionPair.publicKey, sessionAad, { ephemeral: sessionEphemeral, nonce: Buffer.alloc(12, 0x79) });
  const otherWrap = wrapClientKeyForSession(deriveClientContentKey(MATERIAL.releaseSecret, "dep_8"), sessionPair.publicKey, sessionAad, { ephemeral: sessionEphemeral, nonce: Buffer.alloc(12, 0x7a) });
  // The asset key of the same deployment, wrapped as a client-code key: unwraps, never binds.
  const assetKeyWrap = wrapClientKeyForSession(deriveAssetContentKey(MATERIAL.releaseSecret, deployment), sessionPair.publicKey, sessionAad, { ephemeral: sessionEphemeral, nonce: Buffer.alloc(12, 0x7b) });

  return {
    note: "Test-only material. Every value is reproduced by packages/escrow/test/client-escrow.test.ts; see docs/spec/client-escrow.md.",
    package: pkg,
    version,
    deployment,
    target: LUA_548_TARGET,
    sources: CLIENT_SOURCES,
    chunks: compiled.map((c) => ({ path: c.path, bytes: c.bytecode.length, sha256: sha(c.bytecode), bytecodeBase64: c.bytecode.toString("base64"), lines: c.lines })),
    releaseSecret: MATERIAL.releaseSecret.toString("base64"),
    contentKey: contentKey.toString("base64"),
    keyId,
    signerPublicKey: ed25519FromSeed(MATERIAL.assetSignerSeed).publicKey.toString("base64url"),
    containerBase64: container.toString("base64"),
    containerSha256: sha(container),
    foreignTargetBase64: foreignTarget.toString("base64"),
    lyingBase64: lying.toString("base64"),
    permutedBase64: permuted.toString("base64"),
    server: {
      privateKey: MATERIAL.server.privateKey.toString("base64url"),
      publicKey: MATERIAL.server.publicKey.toString("base64url"),
      aad: serverAad.toString("utf8"),
      wrapped: serverWrap,
    },
    session: {
      privateKey: sessionPair.privateKey.toString("base64url"),
      publicKey: sessionPair.publicKey.toString("base64url"),
      aad: sessionAad.toString("utf8"),
      wrapped: sessionWrap,
      otherWrapped: otherWrap,
      assetKeyWrapped: assetKeyWrap,
    },
  };
}
