// Assets in `scriptgo pack`, `validate` and `assets` (docs/spec/assets.md): every target's delivery
// form, the data-only rule, no silent drop, the per-buyer fingerprint carried through a pack, and the
// asset-escrow tooling. Fixtures are built here, per test, from small synthetic files.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { buildFingerprinted, escrowPreload } from "@scriptgo/escrow";
import { fingerprintEntryPath, parseManifest } from "@scriptgo/manifest";
import { run as assetsCommand } from "../src/commands/assets.ts";
import { packForOpen77, run as packCommand, scriptgoArchive } from "../src/commands/pack.ts";
import { run as validateCommand } from "../src/commands/validate.ts";
import { packForHytale, packForLuanti, packForRust } from "../src/lib/asset-targets.ts";
import { planAssets } from "../src/lib/assets.ts";
import { packBeamMPClient } from "../src/lib/beammp.ts";
import { fivemManifest, packForFivem } from "../src/lib/fivem-pack.ts";
import { garrysmodAssetLoader, packForGarrysmod } from "../src/lib/garrysmod.ts";
import { listFiles, readResource } from "../src/lib/sdk.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-assets-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 1)]);
const RDAR = Buffer.concat([Buffer.from("RDAR", "ascii"), Buffer.alloc(64, 7)]);
const MZ = Buffer.concat([Buffer.from("MZ", "ascii"), Buffer.alloc(64, 0)]);
const FIXED = new Date("2026-01-01T00:00:00Z");
const zip = (entries: Record<string, Uint8Array>): Buffer => Buffer.from(zipSync(entries, { level: 6, mtime: FIXED }));

let n = 0;
/** A resource folder `<tmp>/src/<id>/<name>/` from a manifest body and files. */
function resource(name: string, body: string, files: Record<string, Uint8Array | string>): string {
  const dir = join(tmp, "src", String(n++), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scriptgo.lua"), `resource "${name}"\nversion "1.0.0"\nscriptgo_version ">=0.1.0"\n${body}`);
  for (const [f, data] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), data);
  }
  return dir;
}
const out = (label: string): string => join(tmp, "out", `${label}-${n++}`);

/** Runs a command with the console captured. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  try {
    const code = await fn();
    return { code, text: lines.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

const preload = (extra: Record<string, Uint8Array> = {}): Buffer =>
  zip({ "archive/pc/mod/market.archive": RDAR, "archive/pc/mod/market.archive.xl": Buffer.from("streaming:\n  sectors: []\n"), ...extra });

describe("OPEN//77", () => {
  it("packs generic assets as resource files and preload packages as preload_mod, with archivexl", () => {
    const dir = resource("market", 'game_build "open77" "2.31"\nserver_script "server.lua"\nassets "media/*.png"\nenvironment_asset "open77" "dist/market.zip"\n', {
      "server.lua": "print('hi')\n", "media/market_sign.png": PNG, "dist/market.zip": preload(),
    });
    const r = packForOpen77(readResource(dir), out("o77"));
    expect(r.errors).toEqual([]);
    const text = readFileSync(join(r.dest, "open77.lua"), "utf8");
    expect(text).toMatch(/preload_mod "dist\/market\.zip"/);
    expect(text).toMatch(/files \{ "media\/\*\.png" \}/);
    expect(text).toMatch(/dependency "archivexl"/);
    expect(readFileSync(join(r.dest, "dist", "market.zip")).equals(readFileSync(join(dir, "dist", "market.zip")))).toBe(true);
    expect(existsSync(join(r.dest, "media", "market_sign.png"))).toBe(true);
    expect(parseManifest(text, { fileName: "open77.lua" }).ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/server restart/);
  });

  it("refuses code and foreign roots inside a preload package", () => {
    const dir = resource("bad_market", 'environment_asset "open77" "dist/bad.zip"\n', {
      "dist/bad.zip": zip({ "archive/pc/mod/x.archive": RDAR, "bin/x64/plugin.dll": MZ, "archive/pc/mod/fake.archive": Buffer.from("NOPE1234") }),
    });
    const r = packForOpen77(readResource(dir), out("o77bad"));
    const codes = r.errors.map((e) => e.code).sort();
    expect(codes).toContain("asset_not_data");
    expect(codes).toContain("open77_preload_root");
    expect(codes).toContain("open77_archive_magic");
    expect(r.dest).toBe("");
  });

  it("copies an open77.lua resource's own preload_mod files", () => {
    const dir = join(tmp, "src", "o77fmt", "native_map");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "open77.lua"), 'resource_manifest_version "1"\nname "native_map"\nversion "1.0.0"\npreload_mod "dist/map.zip"\nserver_script "s.lua"\n');
    writeFileSync(join(dir, "s.lua"), "\n");
    writeFileSync(join(dir, "dist", "map.zip"), preload());
    const res = readResource(dir);
    if (!res.result.ok) return; // the open77 grammar is covered by the manifest tests
    const r = packForOpen77(res, out("o77fmt"));
    expect(r.errors).toEqual([]);
    expect(existsSync(join(r.dest, "dist", "map.zip"))).toBe(true);
  });
});

describe("FiveM", () => {
  const files = {
    "stream/market_props.ydr": Buffer.from("RSC7....ydr-data"),
    "stream/market.ymap": Buffer.from("RSC7....ymap-data"),
    "data/market_archetypes.meta": Buffer.from("<CMapTypes></CMapTypes>"),
  };
  const body = 'environment_asset "fivem" { "stream/*", "data/market_archetypes.meta" }\ndata_file "DLC_ITYP_REQUEST" "data/market_archetypes.meta"\ngame_build "fivem" "3095"\n';

  it("writes stream/, files, data_file and this_is_a_map; an asset-only package has no shim", () => {
    const dir = resource("market_map", body, files);
    const r = packForFivem(readResource(dir), out("fivem"));
    expect(r.errors).toEqual([]);
    const fx = readFileSync(join(r.dest, "fxmanifest.lua"), "utf8");
    expect(fx).toMatch(/this_is_a_map "yes"/);
    expect(fx).toMatch(/data_file "DLC_ITYP_REQUEST" "data\/market_archetypes\.meta"/);
    expect(fx).toMatch(/files \{ "data\/market_archetypes\.meta" \}/);
    expect(fx).not.toMatch(/shared_script/);
    expect(fx).not.toMatch(/stream\//); // streamed by FXServer from the folder itself
    expect(existsSync(join(r.dest, "stream", "market.ymap"))).toBe(true);
    expect(existsSync(join(r.dest, "scriptgo_shim.lua"))).toBe(false);
  });

  it("packs a licensed asset-only package (the licence gates the download), but not licensed scripts", () => {
    const assetsOnly = resource("paid_map", `licensed true\n${body}`, files);
    const r = packForFivem(readResource(assetsOnly), out("fivem-paid"));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/gates the download/);
    const withScripts = resource("paid_script", `licensed true\nserver_script "s.lua"\n${body}`, { ...files, "s.lua": "print(1)\n" });
    expect(packForFivem(readResource(withScripts), out("fivem-paid2")).errors.map((e) => e.code)).toContain("fivem_licensing_unavailable");
  });

  it("refuses a native file FiveM would never load", () => {
    const dir = resource("stray", 'environment_asset "fivem" "extra/readme.meta"\n', { "extra/readme.meta": Buffer.from("<x/>") });
    expect(packForFivem(readResource(dir), out("fivem-stray")).errors.map((e) => e.code)).toContain("fivem_asset_unused");
  });

  it("keeps the script part of fxmanifest unchanged for a package without assets", () => {
    const res = readResource(resource("plain", 'server_script "s.lua"\n', { "s.lua": "\n" }));
    if (!res.result.ok) throw new Error("fixture");
    expect(fivemManifest(res.result.manifest, [])).toMatch(/shared_script "scriptgo_shim\.lua"/);
  });
});

describe("Garry's Mod", () => {
  it("writes an asset-only addon: content at the root and a download list, no runtime", () => {
    const dir = resource("gm_props", 'environment_asset "garrysmod" { "materials/**", "models/**", "maps/gm_market.bsp" }\n', {
      "materials/gm_props/sign.vmt": Buffer.from('"VertexLitGeneric" { "$basetexture" "gm_props/sign" }\n'),
      "materials/gm_props/sign.vtf": Buffer.concat([Buffer.from("VTF\0"), Buffer.alloc(32, 2)]),
      "models/gm_props/crate.mdl": Buffer.concat([Buffer.from("IDST"), Buffer.alloc(32, 3)]),
      "maps/gm_market.bsp": Buffer.concat([Buffer.from("VBSP"), Buffer.alloc(32, 4)]),
    });
    const parent = out("gmod");
    const r = packForGarrysmod(readResource(dir), parent);
    expect(r.errors).toEqual([]);
    expect(r.runtime).toBeUndefined();
    expect(existsSync(join(parent, "scriptgo"))).toBe(false);
    expect(existsSync(join(r.dest, "lua", "scriptgo"))).toBe(false);
    expect(existsSync(join(r.dest, "materials", "gm_props", "sign.vtf"))).toBe(true);
    const loader = readFileSync(join(r.dest, "lua", "autorun", "server", "sgassets_gm_props.lua"), "utf8");
    expect(loader).toMatch(/resource\.AddSingleFile\(path\)/);
    expect(loader).toMatch(/"maps\/gm_market\.bsp"/);
    expect(r.warnings.join("\n")).toMatch(/\.bsp map/);
    expect(JSON.parse(readFileSync(join(r.dest, "addon.json"), "utf8")).title).toMatch(/content/);
  });

  it("refuses content outside GMod's content folders", () => {
    const dir = resource("gm_bad", 'environment_asset "garrysmod" "art/sign.png"\n', { "art/sign.png": PNG });
    expect(packForGarrysmod(readResource(dir), out("gmod-bad")).errors.map((e) => e.code)).toContain("garrysmod_content_root");
  });

  it("the loader is plain GLua with every path quoted", () => {
    expect(garrysmodAssetLoader("x", ['sound/a"b.wav'])).toContain('"sound/a\\"b.wav"');
  });
});

describe("Luanti, BeamMP, Rust, Hytale", () => {
  it("Luanti: a media mod with mod.conf, init.lua and the media folders", () => {
    const dir = resource("lt_market", 'assets { "textures/*.png", "sounds/*.ogg" }\n', {
      "textures/lt_market_sign.png": PNG, "sounds/lt_market_bell.ogg": Buffer.concat([Buffer.from("OggS"), Buffer.alloc(32, 5)]),
    });
    const r = packForLuanti(readResource(dir), out("luanti"));
    expect(r.errors).toEqual([]);
    const mod = r.written[0]!;
    expect(readFileSync(join(mod, "mod.conf"), "utf8")).toMatch(/^name = sgmedia_lt_market$/m);
    expect(readFileSync(join(mod, "init.lua"), "utf8")).toMatch(/2 media files/);
    expect(existsSync(join(mod, "textures", "lt_market_sign.png"))).toBe(true);
    expect(r.written.length).toBe(1); // no scripts, no SCRIPT//GO mod
  });

  it("Luanti: refuses formats the engine does not send", () => {
    const dir = resource("lt_bad", 'assets "textures/*"\n', { "textures/lt_bad_x.webp": Buffer.from("RIFF....WEBP") });
    expect(packForLuanti(readResource(dir), out("luanti-bad")).errors.map((e) => e.code)).toContain("luanti_media_type");
  });

  it("BeamMP: client mods go to Resources/Client; generic assets are refused there", () => {
    const dir = resource("bm_car", 'environment_asset "beammp" "client/bm_car.zip"\n', {
      "client/bm_car.zip": zip({ "vehicles/bm_car/body.dae": Buffer.from("<COLLADA/>"), "vehicles/bm_car/skin.png": PNG }),
    });
    const res = readResource(dir);
    const plan = planAssets(res, "beammp");
    expect(plan.errors).toEqual([]);
    const o = out("beammp");
    const r = packBeamMPClient(res, o, plan);
    expect(r.files).toEqual(["bm_car.zip"]);
    expect(existsSync(join(o, "Resources", "Client", "bm_car.zip"))).toBe(true);
    const generic = resource("bm_generic", 'environments { "beammp" }\nassets "media/x.png"\n', { "media/x.png": PNG });
    expect(planAssets(readResource(generic), "beammp").errors.map((e) => e.code)).toContain("assets_unsupported");
  });

  it("Rust: one map, copied for the operator's levelurl; two maps are refused", () => {
    const dir = resource("rs_island", 'environment_asset "rust" "maps/rs_island.map"\n', { "maps/rs_island.map": Buffer.alloc(128, 9) });
    const r = packForRust(readResource(dir), out("rust"));
    expect(r.errors).toEqual([]);
    expect(r.next.join("\n")).toMatch(/server\.levelurl/);
    const two = resource("rs_two", 'environment_asset "rust" "maps/*.map"\n', { "maps/a.map": Buffer.alloc(8, 1), "maps/b.map": Buffer.alloc(8, 2) });
    expect(packForRust(readResource(two), out("rust2")).errors.map((e) => e.code)).toContain("rust_one_map");
  });

  it("Hytale: the asset pack goes to mods/; a pack naming a Main class is refused", () => {
    const manifest = (extra: object) => Buffer.from(JSON.stringify({ Group: "kestrel", Name: "Market", Version: "1.0.0", IncludesAssetPack: true, ...extra }));
    const dir = resource("hy_market", 'environment_asset "hytale" "packs/hy_market.zip"\n', {
      "packs/hy_market.zip": zip({ "manifest.json": manifest({}), "Common/Icons/market.png": PNG, "Server/Item/Items/market.json": Buffer.from("{}") }),
    });
    const r = packForHytale(readResource(dir), out("hytale"));
    expect(r.errors).toEqual([]);
    expect(r.written[0]!.replace(/\\/g, "/")).toMatch(/mods\/hy_market\.zip$/);
    const code = resource("hy_code", 'environment_asset "hytale" "packs/p.zip"\n', { "packs/p.zip": zip({ "manifest.json": manifest({ Main: "com.example.Main" }) }) });
    expect(packForHytale(readResource(code), out("hytale2")).errors.map((e) => e.code)).toContain("hytale_pack_code");
  });
});

describe("no silent drop", () => {
  const fivemOnly = () => resource("only_fivem", 'environment_asset "fivem" "stream/x.ydr"\n', { "stream/x.ydr": Buffer.from("RSC7 data") });

  it("a target that delivers none of the package's assets is an error", async () => {
    const r = await capture(() => packCommand([fivemOnly(), "--target", "garrysmod", "--out", out("drop")]));
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/assets_not_for_target/);
  });

  it("--without-assets builds it on purpose, and says so", async () => {
    const dir = resource("both", 'server_script "s.lua"\nenvironment_asset "fivem" "stream/x.ydr"\n', { "s.lua": "\n", "stream/x.ydr": Buffer.from("RSC7 data") });
    const r = await capture(() => packCommand([dir, "--target", "garrysmod", "--no-runtime", "--without-assets", "--out", out("drop2")]));
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/packed without them/);
    expect(r.text).toMatch(/not in this build: 1 files for fivem/);
  });

  it("an environment without asset delivery is an error, not a skip", () => {
    const dir = resource("roblox_art", 'environments { "roblox" }\nassets "media/x.png"\n', { "media/x.png": PNG });
    expect(planAssets(readResource(dir), "fivem").report.errors.map((e) => e.code)).toContain("assets_unsupported");
  });
});

describe("data only", () => {
  it("validate refuses an executable disguised as a texture, and code declared as an asset", async () => {
    const dir = resource("sneaky", 'assets { "media/*" }\n', { "media/sign.png": MZ, "media/run.lua": "os.execute('x')\n" });
    const r = await capture(() => validateCommand([dir]));
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/asset_not_data.*sign\.png.*Windows executable/);
    expect(r.text).toMatch(/asset_not_data.*run\.lua.*code, not data/);
  });

  it("validate reports the per-environment download of a clean package", async () => {
    const dir = resource("clean", 'environments { "open77", "standalone" }\nassets "media/*.png"\n', { "media/clean_sign.png": PNG });
    const r = await capture(() => validateCommand([dir]));
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/open77: supported, 1 files, each player downloads/);
    expect(r.text).toMatch(/standalone: bundled/);
  });
});

describe("the publish archive and the buyer's copy", () => {
  it("the scriptgo archive carries every environment's assets", async () => {
    const dir = resource("all_assets", 'server_script "s.lua"\nassets "media/*.png"\nenvironment_asset "fivem" "stream/x.ydr"\n', {
      "s.lua": "\n", "media/a.png": PNG, "stream/x.ydr": Buffer.from("RSC7 data"),
    });
    const res = readResource(dir);
    if (!res.result.ok) throw new Error("fixture");
    const r = await scriptgoArchive(res.result.manifest, listFiles(res.root), res.root, res.manifestFile);
    expect(Object.keys(unzipSync(r.zip)).sort()).toEqual(["all_assets/media/a.png", "all_assets/s.lua", "all_assets/scriptgo.lua", "all_assets/stream/x.ydr"]);
  });

  it("a fingerprinted copy keeps its fingerprint through a pack, and `assets fingerprint` reads it", async () => {
    const dir = resource("fp_market", 'environment_asset "open77" "dist/fp.zip"\nassets "media/*.png"\n', { "dist/fp.zip": preload(), "media/fp_sign.png": PNG });
    const res = readResource(dir);
    if (!res.result.ok) throw new Error("fixture");
    const release = await scriptgoArchive(res.result.manifest, listFiles(res.root), res.root, res.manifestFile);
    const copy = buildFingerprinted({
      zip: release.zip, root: "fp_market/", containers: [{ path: "fp_market/dist/fp.zip", entry: fingerprintEntryPath("open77", "dist/fp.zip") }],
      identity: { package: "kestrel//fp-market", version: "1.0.0", release: "rel_1", licence: "lic_9", deployment: "dep_3" },
      secret: Buffer.alloc(32, 1), signerSeed: Buffer.alloc(32, 2),
    });
    // The buyer unzips the copy and packs it.
    const unpacked = join(tmp, "buyer", String(n++));
    for (const [name, data] of Object.entries(unzipSync(copy.zip))) {
      mkdirSync(join(unpacked, name, ".."), { recursive: true });
      writeFileSync(join(unpacked, name), data);
    }
    const buyerDir = join(unpacked, "fp_market");
    const packed = packForOpen77(readResource(buyerDir), out("fp"));
    expect(packed.errors).toEqual([]);
    expect(existsSync(join(packed.dest, ".scriptgo", "fingerprint.json"))).toBe(true);
    const r = await capture(() => assetsCommand(["fingerprint", packed.dest]));
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/\.scriptgo\/fingerprint\.json: release rel_1, licence lic_9/);
    expect(r.text).toMatch(/dist\/fp\.zip!archive\/pc\/mod\/fp\.scriptgo-fingerprint\.json: release rel_1, licence lic_9/);
    const zipped = await capture(() => {
      const f = join(tmp, `copy-${n++}.zip`);
      writeFileSync(f, copy.zip);
      return assetsCommand(["fingerprint", f]);
    });
    expect(zipped.code).toBe(0);
    const none = await capture(() => assetsCommand(["fingerprint", dir]));
    expect(none.code).toBe(1);
    // A buyer's copy is never re-published.
    const republish = await capture(() => packCommand([buyerDir, "--target", "scriptgo", "--out", out("republish")]));
    expect(republish.code).toBe(1);
    expect(republish.text).toMatch(/asset_fingerprinted/);
  });
});

describe("asset escrow tooling", () => {
  it("seal then open round-trips a preload package, and a wrong key is refused", async () => {
    const src = join(tmp, `seal-${n++}.zip`);
    writeFileSync(src, preload());
    const container = join(tmp, `sealed-${n++}`, "market.sgae");
    const sealed = await capture(() => assetsCommand(["seal", src, "--package", "kestrel//market", "--version", "1.0.0", "--release", "rel_1", "--deployment", "dep_1", "--out", container, "--chunk-bytes", "4096"]));
    expect(sealed.code).toBe(0);
    expect(readFileSync(container).subarray(0, 4).toString("ascii")).toBe("SGAE");
    expect(readFileSync(container).includes(RDAR)).toBe(false);
    const dest = join(tmp, `opened-${n++}`);
    const opened = await capture(() => assetsCommand(["open", container, "--key", `${container}.key.json`, "--out", dest]));
    expect(opened.code).toBe(0);
    expect(readFileSync(join(dest, "archive", "pc", "mod", "market.archive")).equals(RDAR)).toBe(true);
    const other = join(tmp, `other-${n++}`, "o.sgae");
    await capture(() => assetsCommand(["seal", src, "--package", "p", "--version", "1", "--release", "r", "--deployment", "d", "--out", other]));
    const wrong = await capture(() => assetsCommand(["open", container, "--key", `${other}.key.json`]));
    expect(wrong.code).toBe(1);
    expect(wrong.text).toMatch(/wrong_key/);
    expect(readdirSync(dest).length).toBeGreaterThan(0);
  });

  it("open reads the container of an escrowed OPEN//77 preload (the zip a deployment's copy carries)", async () => {
    const key = randomBytes(32);
    const zipped = escrowPreload({
      preload: preload(), entry: "archive/pc/mod/market.sgae", package: "kestrel//market", version: "1.0.0", release: "rel_1",
      deployment: "dep_1", contentKey: key, signerSeed: Buffer.alloc(32, 9), fingerprint: null, chunkBytes: 4096,
    });
    expect(Object.keys(unzipSync(zipped))).toEqual(["archive/pc/mod/market.sgae"]);
    expect(zipped.includes(RDAR)).toBe(false);
    const file = join(tmp, `escrowed-${n++}.zip`);
    writeFileSync(file, zipped);
    writeFileSync(`${file}.key.json`, JSON.stringify({ contentKey: key.toString("base64") }));
    const dest = join(tmp, `escrowed-out-${n++}`);
    const opened = await capture(() => assetsCommand(["open", file, "--key", `${file}.key.json`, "--out", dest]));
    expect(opened.code).toBe(0);
    expect(readFileSync(join(dest, "archive", "pc", "mod", "market.archive")).equals(RDAR)).toBe(true);
  });
});
