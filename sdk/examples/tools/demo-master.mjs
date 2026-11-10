// A DEMO key endpoint for the escrow examples: the one route an escrow host talks to
// (POST /v1/licenses/key), over the repository's cross-language test vector. It lets you run the
// example hosts end to end on one machine with no account, no database and no real license.
//
//   node sdk/examples/tools/demo-master.mjs [--port 4180] [--ttl 900] [--grace 3600] [--out <dir>]
//
// It is NOT the SCRIPT//GO master and holds no real key: the content key, the signing key and the
// bundle are the fixed test material of sdk/dotnet/ScriptGo.Host.Tests/Fixtures/escrow-vector.json.
// It mirrors the real endpoint's behaviour where a host can observe it (docs/spec/escrow.md):
//   - a definitive refusal is HTTP 200 { valid:false, reason };
//   - the first public key a deployment presents is registered; a different one is `unbound`;
//   - the answer carries expiresAt and offlineGraceUntil.
// Two extra routes steer the demo:  POST /demo/revoke   POST /demo/restore   POST /demo/offline
//
// It listens on 127.0.0.1 only. Needs Node 22.18+ (it imports the TypeScript packer directly).
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const { wrapContentKey, releaseAad } = await import(new URL("../../../packages/escrow/src/index.ts", import.meta.url).href);

function option(name, fallback) {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}
const port = Number(option("port", "4180"));
const ttlSeconds = Number(option("ttl", "900"));
const graceSeconds = Number(option("grace", "3600"));
const outDir = resolve(option("out", join(here, ".demo")));

const vector = JSON.parse(readFileSync(join(repo, "sdk", "dotnet", "ScriptGo.Host.Tests", "Fixtures", "escrow-vector.json"), "utf8"));
const contentKey = Buffer.from(vector.contentKeyHex, "hex");
const DEPLOYMENT_TOKEN = "sg_dep_demo_token";
const bundlePath = join(outDir, "demo-1.0.0.escrow.zip");
mkdirSync(outDir, { recursive: true });
writeFileSync(bundlePath, Buffer.from(vector.bundleB64, "base64"));

const state = { revoked: false, offline: false, boundKey: null, requests: 0 };

const refuse = (reason) => ({
  valid: false, reason, wrappedKey: null, aad: null, signerPublicKey: null, deliveryWatermark: null, offlineGraceUntil: null, expiresAt: null,
});

function releaseKey(body) {
  if (body.deploymentToken !== DEPLOYMENT_TOKEN || body.package !== vector.package) return refuse("unknown_key");
  if (state.revoked) return refuse("revoked");
  if (body.version && body.version !== vector.version) return refuse("not_escrowed");
  // Binding: trust on first use, refuse a swapped key afterwards (as the master does).
  if (!state.boundKey) {
    if (!body.serverPublicKey) return refuse("unbound");
    state.boundKey = body.serverPublicKey;
    console.log(`demo-master: deployment bound to server key ${state.boundKey}`);
  } else if (body.serverPublicKey && body.serverPublicKey !== state.boundKey) {
    return refuse("unbound");
  }
  const aad = releaseAad(vector.package, vector.version);
  const now = Date.now();
  return {
    valid: true,
    reason: null,
    wrappedKey: wrapContentKey(contentKey, Buffer.from(state.boundKey, "base64url"), aad),
    aad: aad.toString("utf8"),
    signerPublicKey: vector.signerPublicKeyB64Url,
    deliveryWatermark: "demo-delivery-watermark",
    offlineGraceUntil: new Date(now + graceSeconds * 1000).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
  };
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST") return send(404, { error: "not_found" });
    if (req.url === "/demo/revoke") { state.revoked = true; console.log("demo-master: license REVOKED"); return send(200, { ok: true }); }
    if (req.url === "/demo/restore") { state.revoked = false; state.offline = false; console.log("demo-master: license restored"); return send(200, { ok: true }); }
    if (req.url === "/demo/offline") { state.offline = true; console.log("demo-master: now answering 503"); return send(200, { ok: true }); }
    if (req.url !== "/v1/licenses/key") return send(404, { error: "not_found" });
    if (state.offline) return send(503, { error: "unavailable" });
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return send(400, { error: "bad_json" }); }
    const answer = releaseKey(body);
    state.requests++;
    // The deployment token is a secret: it is never logged, here or anywhere.
    console.log(`demo-master: key request #${state.requests} for ${body.package} -> ${answer.valid ? "released" : "refused: " + answer.reason}`);
    send(200, answer);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`demo-master: listening on http://127.0.0.1:${port} (key ttl ${ttlSeconds}s, offline grace ${graceSeconds}s)`);
  console.log(`demo-master: bundle written to ${bundlePath}`);
  console.log("demo-master: run an example host with:");
  console.log(`  --bundle "${bundlePath}" --master http://127.0.0.1:${port} --deployment-token ${DEPLOYMENT_TOKEN} \\`);
  console.log(`  --package ${vector.package} --environment demo --trusted-signer ${vector.signerPublicKeyB64Url}`);
});
