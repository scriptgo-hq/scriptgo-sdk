// Generates the cross-language escrow vector the .NET loader tests decrypt, proving the TS packer
// and the C# loader agree byte for byte. Run: node --import tsx packages/escrow/tools/gen-vectors.ts
// Fixed keys → a reproducible bundle (the wrapped key's ephemeral is random, but the vector stores
// one instance the .NET side unwraps with the fixed server private key).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEscrowRelease, ed25519FromSeed, releaseAad, wrapContentKey, type X25519KeyPair } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "..", "sdk", "dotnet", "ScriptGo.Host.Tests", "Fixtures", "escrow-vector.json");

// Fixed material (test only — never a real key).
const signingSeed = Buffer.alloc(32, 0x11);
const contentKey = Buffer.alloc(32, 0x22);
// A fixed X25519 server keypair: derive the public from the private deterministically.
import { generateX25519KeyPair, x25519Shared } from "../src/crypto.ts";
// X25519 has no "public from private" export in node without a keyobject; generate once and pin.
// To stay deterministic across runs we instead derive both from a fresh pair but store the pair.
const server: X25519KeyPair = generateX25519KeyPair();

const pkg = "kestrel//demo";
const version = "1.0.0";
const files = new Map<string, Buffer>([
  ["scriptgo.lua", Buffer.from('resource "demo"\nversion "1.0.0"\nserver_script "server/main.lua"\n', "utf8")],
  ["README.md", Buffer.from("# demo\nA SCRIPT//GO escrow vector.\n", "utf8")],
  ["config.lua", Buffer.from("return { rate = 5 }\n", "utf8")],
  ["server/main.lua", Buffer.from("AddEventHandler('onResourceStart', function() print('escrow secret ok') end)\n", "utf8")],
  ["server/secret.lua", Buffer.from("return { answer = 42 }\n", "utf8")],
]);

const built = buildEscrowRelease({
  files, package: pkg, version, manifestFile: "scriptgo.lua",
  allowlist: ["config.lua"], signingSeed, contentKey, watermarkSecret: "vector-watermark-secret-01",
});
const aad = releaseAad(pkg, version);
const wrapped = wrapContentKey(contentKey, server.publicKey, aad);

// Sanity: the stored shared secret proves node and NSec agree on X25519 (the .NET test recomputes it).
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
  // X25519 interop probe: sharedHex = X25519(probePrivate, serverPublic); the .NET test recomputes it.
  x25519Probe: {
    probePrivateHex: probe.privateKey.toString("hex"),
    probePublicHex: probe.publicKey.toString("hex"),
    sharedHex: x25519Shared(probe.privateKey, server.publicKey).toString("hex"),
  },
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(vector, null, 2) + "\n");
console.log(`wrote ${out} (${built.bundle.length} byte bundle, ${built.encryptedFiles.length} encrypted files)`);
