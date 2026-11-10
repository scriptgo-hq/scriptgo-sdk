// Generates the cross-language escrow vector that the three loaders decrypt, proving the TypeScript
// packer, the managed .NET loader and the native loader (libscriptgo) agree byte for byte.
// Run: node packages/escrow/tools/gen-vectors.ts   (Node 22.18+ runs TypeScript directly)
//
// Outputs (both committed, both test-only material, never a real key):
//   sdk/dotnet/ScriptGo.Host.Tests/Fixtures/escrow-vector.json   (the .NET tests)
//   sdk/native/tests/escrow_vector.h                              (the native CTest suite)
//
// The signing seed, the content key and the server key pair are fixed. The AES-GCM nonces and the
// ephemeral key of the wrap are random, so two runs give different ciphertexts for the same
// plaintext: every loader must cope with that, and the stored instance is what the tests open.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, type Zippable } from "fflate";
import {
  aeadEncrypt,
  buildEscrowRelease,
  canonicalJson,
  ed25519FromSeed,
  generateX25519KeyPair,
  readBundle,
  releaseAad,
  wrapContentKey,
  x25519Shared,
  type X25519KeyPair,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const jsonOut = join(repo, "sdk", "dotnet", "ScriptGo.Host.Tests", "Fixtures", "escrow-vector.json");
const headerOut = join(repo, "sdk", "native", "tests", "escrow_vector.h");

// Fixed material (test only, never a real key).
const signingSeed = Buffer.alloc(32, 0x11);
const contentKey = Buffer.alloc(32, 0x22);
// A fixed X25519 server key pair: the public key is derived from the pinned private key.
const serverPrivate = Buffer.from("98b93e3fe2143b0f50813fa33a3607be2558dee987f78c25b60a0b82a42f3b77", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX_BYTES = 12;
const serverPublic = Buffer.from(
  createPublicKey(createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, serverPrivate]), format: "der", type: "pkcs8" }))
    .export({ type: "spki", format: "der" })
    .subarray(X25519_SPKI_PREFIX_BYTES),
);
const server: X25519KeyPair = { publicKey: serverPublic, privateKey: serverPrivate };

const pkg = "kestrel//demo";
const version = "1.0.0";
const files = new Map<string, Buffer>([
  ["scriptgo.lua", Buffer.from('resource "demo"\nversion "1.0.0"\nserver_script "server/main.lua"\n', "utf8")],
  ["README.md", Buffer.from("# demo\nA SCRIPT//GO escrow vector.\n", "utf8")],
  ["config.lua", Buffer.from("return { rate = 5 }\n", "utf8")],
  // Runs at file scope on every host (it only needs print), requires an escrowed module, and
  // registers a handler where the host offers AddEventHandler.
  [
    "server/main.lua",
    Buffer.from(
      "local secret = require('server.secret')\n" +
        "print('escrow secret ok ' .. tostring(secret.answer))\n" +
        "if AddEventHandler then AddEventHandler('onResourceStart', function() print('escrow handler ok') end) end\n",
      "utf8",
    ),
  ],
  ["server/secret.lua", Buffer.from("return { answer = 42 }\n", "utf8")],
  // Not Lua: a data file (the managed copy door), and a chunk that must not compile.
  ["data/notes.txt", Buffer.from("not lua {\n", "utf8")],
  // The header of a precompiled Lua chunk: a loader that passes mode "t" must refuse it.
  ["data/precompiled.luac", Buffer.from("\u001bLuaT", "utf8")],
]);

const built = buildEscrowRelease({
  files, package: pkg, version, manifestFile: "scriptgo.lua",
  allowlist: ["config.lua"], signingSeed, contentKey, watermarkSecret: "vector-watermark-secret-01",
});
const aad = releaseAad(pkg, version);
const wrapped = wrapContentKey(contentKey, server.publicKey, aad);
const parsed = readBundle(built.bundle);
const canonical = canonicalJson({ ...parsed.manifest, signature: "" });

// Negative payloads: each authenticates under the vector's content key and aad, so a loader gets
// past the key unwrap and the AEAD and must refuse on the archive itself.
function hostilePayload(inner: Buffer) {
  const { nonce, ciphertext } = aeadEncrypt(contentKey, inner, aad);
  return { nonceHex: nonce.toString("hex"), payloadHex: ciphertext.toString("hex"), sha256Hex: createHash("sha256").update(ciphertext).digest("hex") };
}
const zip = (entries: Zippable) => Buffer.from(zipSync(entries, { level: 9 }));
const goodInner = zip({ "server/main.lua": Buffer.from("return 1 -- " + "padding ".repeat(40), "utf8") });
const badCrc = Buffer.from(goodInner);
badCrc[14] ^= 0xff; // the CRC-32 field of the first local header; the central directory keeps the true one
const centralCrc = badCrc.lastIndexOf(Buffer.from("504b0102", "hex")) + 16;
badCrc[centralCrc] ^= 0xff; // flip the central CRC too, so the data no longer matches what the archive claims
const hostile = {
  // Authentic ciphertext whose plaintext is not a zip at all.
  notAZip: hostilePayload(Buffer.from("this is not a zip archive, only bytes that decrypt correctly", "utf8")),
  // A zip whose stored CRC does not match its data.
  badCrc: hostilePayload(badCrc),
  // Zip slip: entries that would escape the resource root once joined onto a directory.
  traversal: hostilePayload(zip({ "../escape.lua": Buffer.from("return 'escaped'\n", "utf8") })),
  nestedTraversal: hostilePayload(zip({ "server/../../escape.lua": Buffer.from("return 'escaped'\n", "utf8") })),
  absolute: hostilePayload(zip({ "/etc/escape.lua": Buffer.from("return 'escaped'\n", "utf8") })),
  backslash: hostilePayload(zip({ "..\\escape.lua": Buffer.from("return 'escaped'\n", "utf8") })),
  drive: hostilePayload(zip({ "C:/escape.lua": Buffer.from("return 'escaped'\n", "utf8") })),
};

// Sanity: the stored shared secret proves node and libsodium agree on X25519.
const probe = generateX25519KeyPair();
const vector = {
  package: pkg,
  version,
  aad: aad.toString("utf8"),
  signingSeedHex: signingSeed.toString("hex"),
  signerPublicKeyB64Url: ed25519FromSeed(signingSeed).publicKey.toString("base64url"),
  contentKeyHex: contentKey.toString("hex"),
  serverPublicHex: server.publicKey.toString("hex"),
  serverPrivateHex: server.privateKey.toString("hex"),
  wrappedKey: wrapped,
  bundleB64: built.bundle.toString("base64"),
  watermark: built.manifest.watermark,
  expectedFiles: Object.fromEntries([...files.entries()].map(([p, b]) => [p, b.toString("utf8")])),
  encryptedFiles: built.encryptedFiles,
  // The exact bytes the ed25519 signature covers: an implementer's canonicaliser must reproduce them.
  canonicalManifest: canonical,
  hostile,
  // X25519 interop probe: sharedHex = X25519(probePrivate, serverPublic); each loader recomputes it.
  x25519Probe: {
    probePrivateHex: probe.privateKey.toString("hex"),
    probePublicHex: probe.publicKey.toString("hex"),
    sharedHex: x25519Shared(probe.privateKey, server.publicKey).toString("hex"),
  },
};

mkdirSync(dirname(jsonOut), { recursive: true });
writeFileSync(jsonOut, JSON.stringify(vector, null, 2) + "\n");

// ---------------------------------------------------------------- the same vector as a C header

function cBytes(name: string, data: Buffer): string {
  const rows: string[] = [];
  for (let i = 0; i < data.length; i += 16) rows.push("    " + [...data.subarray(i, i + 16)].map((b) => "0x" + b.toString(16).padStart(2, "0")).join(", "));
  // A zero-length array is not C: keep one byte and carry the true length next to it.
  const body = rows.length > 0 ? rows.join(",\n") : "    0x00";
  return `static const unsigned char ${name}[] = {\n${body}\n};\nstatic const size_t ${name}_len = ${data.length};\n`;
}
function cString(text: string): string {
  return '"' + [...Buffer.from(text, "utf8")].map((b) => (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c && b !== 0x3f ? String.fromCharCode(b) : "\\" + b.toString(8).padStart(3, "0"))).join("") + '"';
}

const encrypted = built.encryptedFiles.map((path) => ({ path, data: files.get(path)! })).sort((a, b) => (a.path < b.path ? -1 : 1));
const header: string[] = [
  "/* GENERATED by packages/escrow/tools/gen-vectors.ts: do not edit. Test-only material, never a real key.",
  " * The same vector as sdk/dotnet/ScriptGo.Host.Tests/Fixtures/escrow-vector.json. */",
  "#ifndef SCRIPTGO_ESCROW_VECTOR_H",
  "#define SCRIPTGO_ESCROW_VECTOR_H",
  "#include <stddef.h>",
  "",
  cBytes("VEC_BUNDLE", built.bundle),
  cBytes("VEC_PAYLOAD", parsed.payload),
  cBytes("VEC_PAYLOAD_NONCE", Buffer.from(parsed.manifest.payload.nonce, "base64url")),
  cBytes("VEC_PAYLOAD_SHA256", Buffer.from(parsed.manifest.payload.sha256, "hex")),
  cBytes("VEC_AAD", aad),
  cBytes("VEC_EPK", Buffer.from(wrapped.epk, "base64url")),
  cBytes("VEC_WRAP_NONCE", Buffer.from(wrapped.nonce, "base64url")),
  cBytes("VEC_WRAPPED", Buffer.from(wrapped.wrapped, "base64url")),
  cBytes("VEC_SERVER_PRIVATE", server.privateKey),
  cBytes("VEC_SERVER_PUBLIC", server.publicKey),
  cBytes("VEC_SIGNER_PUBLIC", Buffer.from(parsed.manifest.signerPublicKey, "base64url")),
  cBytes("VEC_SIGNATURE", Buffer.from(parsed.manifest.signature, "base64url")),
  cBytes("VEC_CANONICAL_MANIFEST", Buffer.from(canonical, "utf8")),
  `#define VEC_ENCRYPTED_COUNT ${encrypted.length}`,
  "static const struct { const char* path; const char* content; size_t size; } VEC_ENCRYPTED[VEC_ENCRYPTED_COUNT] = {",
  ...encrypted.map((f) => `    { ${cString(f.path)}, ${cString(f.data.toString("utf8"))}, ${f.data.length} },`),
  "};",
  "",
  `#define VEC_CLEAR_COUNT ${built.clearFiles.length}`,
  "static const char* const VEC_CLEAR[VEC_CLEAR_COUNT] = { " + built.clearFiles.map(cString).join(", ") + " };",
  "",
];
for (const [name, value] of Object.entries(hostile)) {
  const upper = name.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase();
  header.push(cBytes(`VEC_HOSTILE_${upper}`, Buffer.from(value.payloadHex, "hex")));
  header.push(cBytes(`VEC_HOSTILE_${upper}_NONCE`, Buffer.from(value.nonceHex, "hex")));
  header.push(cBytes(`VEC_HOSTILE_${upper}_SHA256`, Buffer.from(value.sha256Hex, "hex")));
}
header.push("#endif /* SCRIPTGO_ESCROW_VECTOR_H */", "");
mkdirSync(dirname(headerOut), { recursive: true });
writeFileSync(headerOut, header.join("\n"));

console.log(`wrote ${jsonOut} (${built.bundle.length} byte bundle, ${built.encryptedFiles.length} encrypted files)`);
console.log(`wrote ${headerOut}`);
