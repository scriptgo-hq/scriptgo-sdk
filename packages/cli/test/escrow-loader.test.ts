import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { buildEscrowRelease, DELIVERY_MARKER, ed25519FromSeed, wrapContentKey } from "@scriptgo/escrow";
import { parseManifest } from "@scriptgo/manifest";
import { buildEscrow } from "../src/lib/escrow-pack.ts";
import { checkBundle, graceEnd, loadIdentity, loadRelease, LoaderRefusal, materialize, requestKey } from "../src/lib/escrow-loader.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-cli-loader-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SEED = Buffer.alloc(32, 0x4c);
const SIGNER = ed25519FromSeed(SEED).publicKey.toString("base64url");
const PKG = "kestrel//inv-pro";
const SECRET = "print('proprietary pricing logic')";

const built = buildEscrowRelease({
  files: new Map([
    ["scriptgo.lua", Buffer.from('resource "inv_pro"\nversion "2.1.0"\nserver_script "server/main.lua"\n')],
    ["README.md", Buffer.from("# inv pro")],
    ["server/main.lua", Buffer.from(SECRET)],
  ]),
  package: PKG,
  version: "2.1.0",
  manifestFile: "scriptgo.lua",
  signingSeed: SEED,
  watermarkSecret: "a-watermark-secret-for-this-build",
});

/** A master that binds the first server key it sees for a token, like the real one. */
function master(opts: { licensed?: boolean; down?: boolean } = {}) {
  const bound = new Map<string, string>();
  const calls: any[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (opts.down) return new Response("{}", { status: 503 });
    const refuse = (reason: string) => new Response(JSON.stringify({ valid: false, reason, wrappedKey: null, aad: null, signerPublicKey: null, deliveryWatermark: null, offlineGraceUntil: null, expiresAt: null }), { status: 200 });
    if (opts.licensed === false) return refuse("revoked");
    const known = bound.get(body.deploymentToken);
    if (known && known !== body.serverPublicKey) return refuse("server_key_mismatch");
    bound.set(body.deploymentToken, body.serverPublicKey);
    const aad = Buffer.from(built.manifest.aad, "utf8");
    const wrappedKey = wrapContentKey(built.contentKey, Buffer.from(body.serverPublicKey, "base64url"), aad);
    return new Response(
      JSON.stringify({ valid: true, reason: null, wrappedKey, aad: built.manifest.aad, signerPublicKey: SIGNER, deliveryWatermark: "marker-token-for-this-license-and-deployment", offlineGraceUntil: "2026-11-13T00:00:00.000Z", expiresAt: "2026-11-10T00:15:00.000Z" }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const req = (m: ReturnType<typeof master>, identityFile: string) => ({
  master: "http://master.test", deploymentToken: "sg_dep_test", package: PKG, environment: "standalone",
  identity: loadIdentity(join(tmp, identityFile)), trustedSigner: SIGNER, fetchImpl: m.fetchImpl,
});

describe("reference escrow loader", () => {
  it("creates a server identity once, private key on this machine only", () => {
    const file = join(tmp, "id-a.json");
    const a = loadIdentity(file);
    expect(a.created).toBe(true);
    expect(a.publicKey).toHaveLength(32);
    const again = loadIdentity(file);
    expect(again.created).toBe(false);
    expect(again.fingerprint).toBe(a.fingerprint);
    expect(JSON.parse(readFileSync(file, "utf8")).note).toMatch(/SECRET/);
    expect(statSync(file).isFile()).toBe(true);
  });

  it("loads a bundle on the bound server: decrypts in memory and adds the delivery marker", async () => {
    const m = master();
    const loaded = await loadRelease(built.bundle, req(m, "id-bound.json"));
    expect(loaded.files.get("server/main.lua")!.toString()).toBe(SECRET);
    expect(loaded.files.get("README.md")!.toString()).toBe("# inv pro");
    const marker = JSON.parse(loaded.files.get(DELIVERY_MARKER)!.toString());
    expect(marker).toMatchObject({ releaseId: `${PKG}@2.1.0`, token: "marker-token-for-this-license-and-deployment" });
    // The request names the release in the bundle and carries the public key only.
    expect(m.calls[0]).toMatchObject({ package: PKG, version: "2.1.0", environment: "standalone", deploymentToken: "sg_dep_test" });
    expect(JSON.stringify(m.calls[0])).not.toContain(req(m, "id-bound.json").identity.privateKey.toString("base64url"));
    expect(graceEnd(loaded.answer)).toBe(new Date("2026-11-13T00:00:00.000Z").getTime());
  });

  it("refuses a copy on a second server identity, a revoked license and a master that is down", async () => {
    const m = master();
    await loadRelease(built.bundle, req(m, "id-first.json"));
    await expect(loadRelease(built.bundle, req(m, "id-copy.json"))).rejects.toMatchObject({ code: "server_key_mismatch" });
    await expect(loadRelease(built.bundle, req(master({ licensed: false }), "id-first.json"))).rejects.toMatchObject({ code: "revoked" });
    // No key on disk: when the master cannot answer, a cold start cannot decrypt.
    await expect(loadRelease(built.bundle, req(master({ down: true }), "id-first.json"))).rejects.toMatchObject({ code: "master_unreachable" });
    expect(await requestKey(req(master({ down: true }), "id-first.json"))).toMatchObject({ kind: "unreachable" });
    expect(await requestKey(req(master({ licensed: false }), "id-first.json"))).toEqual({ kind: "refused", reason: "revoked" });
  });

  it("refuses a tampered bundle before any key is requested, and a bundle signed by another key", async () => {
    const m = master();
    const flipped = Buffer.from(built.bundle);
    const at = flipped.indexOf(Buffer.from("# inv pro"));
    // Stored (level 0) entries would show the text; with deflate the README bytes are not literal,
    // so rebuild the bundle with one clear file changed instead.
    expect(at).toBe(-1);
    const { unzipSync } = await import("fflate");
    const entries = unzipSync(built.bundle);
    entries["README.md"] = Buffer.from("# inv pro (edited)");
    const tampered = Buffer.from(zipSync(entries));
    await expect(loadRelease(tampered, req(m, "id-first.json"))).rejects.toMatchObject({ code: "bundle_tampered" });

    // escrow.json edited (another signer key claimed): the pinned signer no longer matches.
    const manifest = JSON.parse(Buffer.from(entries["escrow.json"]!).toString());
    manifest.signerPublicKey = ed25519FromSeed(Buffer.alloc(32, 9)).publicKey.toString("base64url");
    const reSigned = Buffer.from(zipSync({ ...unzipSync(built.bundle), "escrow.json": Buffer.from(JSON.stringify(manifest)) }));
    expect(() => checkBundle(reSigned, SIGNER)).toThrow(LoaderRefusal);
    // The payload itself altered: the hash in the signed manifest catches it, again before any key.
    const payload = Buffer.from(unzipSync(built.bundle)["payload.enc"]!);
    payload[0] = payload[0]! ^ 0xff;
    const badPayload = Buffer.from(zipSync({ ...unzipSync(built.bundle), "payload.enc": payload }));
    await expect(loadRelease(badPayload, req(m, "id-payload.json"))).rejects.toMatchObject({ code: "bundle_tampered" });
    expect(m.calls).toHaveLength(0);
    expect(() => checkBundle(Buffer.from("not a zip"), SIGNER)).toThrow(LoaderRefusal);
  });

  it("writes the decrypted copy to disk only on request, with the marker, never outside the folder", async () => {
    const loaded = await loadRelease(built.bundle, req(master(), "id-out.json"));
    const out = materialize(loaded.files, join(tmp, "out", "inv_pro"));
    expect(readFileSync(join(out, "server", "main.lua"), "utf8")).toBe(SECRET);
    expect(existsSync(join(out, DELIVERY_MARKER))).toBe(true);
    expect(() => materialize(new Map([["../escape.lua", Buffer.from("x")]]), join(tmp, "out2"))).toThrow(LoaderRefusal);
    expect(existsSync(join(tmp, "escape.lua"))).toBe(false);
  });
});

describe("buildEscrow (scriptgo publish --escrow)", () => {
  const manifestText = ['resource "inv_pro"', 'version "2.1.0"', 'author "kestrel"', 'server_script "server/main.lua"', 'files { "config.lua" }'].join("\n");
  const enc = (s: string) => new TextEncoder().encode(s);
  const archive = () =>
    zipSync({ "inv_pro/scriptgo.lua": enc(manifestText), "inv_pro/README.md": enc("# inv pro"), "inv_pro/config.lua": enc("return {}"), "inv_pro/server/main.lua": enc(SECRET) }, { mtime: new Date("2026-01-01T00:00:00Z") });
  const parsed = parseManifest(manifestText, { fileName: "scriptgo.lua" }) as { ok: true; manifest: any };

  it("names the bundle with the registry identifier, watermarks it and signs it with the creator's key", () => {
    process.env.SCRIPTGO_SIGNING_KEY = SEED.toString("base64");
    const b = buildEscrow({ archive: archive(), manifest: parsed.manifest, manifestFile: "scriptgo.lua", identifier: PKG, allowlist: ["config.lua"] });
    expect(b.manifest).toMatchObject({ package: PKG, aad: `${PKG}@2.1.0`, signerPublicKey: SIGNER });
    expect(b.manifest.watermark).toBeTruthy();
    expect(b.encryptedFiles).toEqual(["server/main.lua"]);
    expect(b.bundle.includes(Buffer.from(SECRET))).toBe(false);
    // Two builds of the same sources have different keys and different watermarks.
    const again = buildEscrow({ archive: archive(), manifest: parsed.manifest, manifestFile: "scriptgo.lua", identifier: PKG, allowlist: ["config.lua"] });
    expect(again.contentKey.equals(b.contentKey)).toBe(false);
    expect(again.manifest.watermark).not.toBe(b.manifest.watermark);
    delete process.env.SCRIPTGO_SIGNING_KEY;
  });

  it("refuses to build a bundle that encrypts nothing", () => {
    process.env.SCRIPTGO_SIGNING_KEY = SEED.toString("base64");
    expect(() => buildEscrow({ archive: archive(), manifest: parsed.manifest, manifestFile: "scriptgo.lua", identifier: PKG, allowlist: ["**"] })).toThrow(/nothing would be encrypted/);
    delete process.env.SCRIPTGO_SIGNING_KEY;
  });
});
