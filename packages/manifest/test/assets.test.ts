import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inspectAssets, parseManifest, readZip, ZipError, type AssetReport } from "../src/index.ts";

/** A stored zip (method 0) of the given entries, for tests. */
export function storedZip(entries: Record<string, Buffer>, opts: { unixMode?: Record<string, number> } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const n = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4);
    l.writeUInt32LE(crc >>> 0, 14);
    l.writeUInt32LE(data.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(n.length, 26);
    locals.push(l, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    const mode = opts.unixMode?.[name];
    c.writeUInt16LE(mode ? (3 << 8) | 20 : 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    if (mode) c.writeUInt32LE((mode << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(entries).length;
  e.writeUInt16LE(count, 8);
  e.writeUInt16LE(count, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

const RDAR = (n = 32): Buffer => Buffer.concat([Buffer.from("RDAR"), Buffer.alloc(n, 1)]);
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16, 2)]);

function inspect(manifest: string, files: Record<string, Buffer>, targets?: string[]): AssetReport {
  const r = parseManifest(manifest);
  if (!r.ok) throw new Error(`parse: ${r.errors.map((e) => e.code).join(", ")}`);
  return inspectAssets({ manifest: r.manifest, files: Object.keys(files), read: (p) => files[p]!, targets });
}
const codes = (r: AssetReport, which: "errors" | "warnings" = "errors"): string[] => r[which].map((d) => d.code);
const head = (name: string, extra = ""): string => `resource "${name}"\nversion "1.0.0"\nscriptgo_version ">=0.1.0"\n${extra}`;

describe("strict zip reader", () => {
  it("reads a clean archive and refuses hidden bytes, links and traversal", () => {
    const z = storedZip({ "a/b.txt": Buffer.from("x") });
    expect(readZip(z).entries.map((e) => e.name)).toEqual(["a/b.txt"]);
    expect(() => readZip(Buffer.concat([Buffer.from("junk"), z]))).toThrow(ZipError);
    expect(() => readZip(Buffer.concat([z, Buffer.from("tail")]))).toThrow(ZipError);
    expect(() => readZip(storedZip({ "../x": Buffer.from("x") }))).toThrow(/segment/);
    expect(() => readZip(storedZip({ "link": Buffer.from("target") }, { unixMode: { link: 0o120777 } }))).toThrow(/symbolic/);
  });
});

describe("data only", () => {
  it("refuses code by extension and by magic, in the package and inside containers", () => {
    const pkg = head("data_only", 'assets { "media/**" }\nenvironment_asset "open77" "dist/map.zip"\nserver_script "s.lua"\n');
    const r = inspect(pkg, {
      "s.lua": Buffer.from(""),
      "media/ok.png": PNG,
      "media/evil.dll": Buffer.from("MZ...."),
      "media/hidden.png": Buffer.concat([Buffer.from("MZ"), Buffer.alloc(10)]),
      "media/run.lua": Buffer.from("print(1)"),
      "dist/map.zip": storedZip({ "archive/pc/mod/a.archive": RDAR(), "archive/pc/mod/x.asi": Buffer.from("x"), "archive/pc/mod/in.zip": storedZip({ "a": Buffer.from("a") }) }),
    });
    expect(codes(r).sort()).toEqual(["asset_nested_archive", "asset_not_data", "asset_not_data", "asset_not_data", "asset_not_data", "open77_preload_type", "open77_preload_type"]);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/evil\.dll: \.dll is code/);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/hidden\.png: the file is a Windows executable/);
  });

  it("refuses an archive that is not a declared container", () => {
    const r = inspect(head("loose_zip", 'assets { "media/**" }\n'), { "media/pack.zip": storedZip({ "a.png": PNG }) });
    expect(codes(r)).toEqual(["asset_archive"]);
  });

  it("reports a pattern that matches nothing instead of dropping it", () => {
    const r = inspect(head("empty_glob", 'assets { "media/**" }\nserver_script "s.lua"\n'), { "s.lua": Buffer.from("") });
    expect(codes(r)).toEqual(["pattern_empty"]);
  });
});

describe("OPEN//77 preloads", () => {
  const pkg = head("night_market", 'environment_asset "open77" "dist/night_market.zip"\ngame_build "open77" "2.5"\n');
  it("accepts inert REDengine data, sizes the download and names the loader it needs", () => {
    const zip = storedZip({ "archive/pc/mod/night_market.archive": RDAR(), "archive/pc/mod/night_market.archive.xl": Buffer.from("x: 1\n") });
    const r = inspect(pkg, { "dist/night_market.zip": zip });
    expect(r.errors).toEqual([]);
    expect(r.environments["open77"]).toMatchObject({ support: "supported", files: ["dist/night_market.zip"], downloadBytes: zip.length, needs: ["archivexl"], gameBuilds: ["2.5"] });
    expect(r.environments["open77"]!.containers[0]).toMatchObject({ entries: 2, roots: ["archive/"] });
  });
  it("refuses files outside the inert roots, a fake archive and a non-zip preload", () => {
    const r = inspect(pkg.replace('"dist/night_market.zip"', '{ "dist/night_market.zip", "dist/raw.archive" }'), {
      "dist/night_market.zip": storedZip({ "bin/x64/plugins/a.dat": Buffer.from("x"), "archive/pc/mod/fake.archive": Buffer.from("NOPE") }),
      "dist/raw.archive": RDAR(),
    });
    expect(codes(r)).toEqual(["open77_preload_not_zip", "open77_preload_root", "open77_archive_magic"]);
  });
  it("warns when no game build is declared", () => {
    const r = inspect(head("no_build", 'environment_asset "open77" "dist/a.zip"\n'), { "dist/a.zip": storedZip({ "archive/pc/mod/a.archive": RDAR() }) });
    expect(codes(r, "warnings")).toEqual(["asset_game_build_missing"]);
  });
});

describe("FiveM", () => {
  it("accepts streamed formats and data files, flags a map, and refuses an unloadable file", () => {
    const pkg = head("mlo_pack", 'environment_asset "fivem" { "stream/**", "data/**" }\ngame_build "fivem" "3258"\ndata_file "VEHICLE_METADATA_FILE" "data/vehicles.meta"\n');
    const ok = inspect(pkg, { "stream/a.ydr": Buffer.alloc(8), "stream/a.ymap": Buffer.alloc(8), "data/vehicles.meta": Buffer.from("<x/>") });
    expect(ok.errors).toEqual([]);
    expect(ok.environments["fivem"]!.needs).toEqual(["this_is_a_map"]);
    const bad = inspect(pkg, { "stream/a.ydr": Buffer.alloc(8), "stream/readme.txt": Buffer.from("x"), "data/vehicles.meta": Buffer.from("<x/>"), "data/other.meta": Buffer.from("<x/>") });
    expect(codes(bad).sort()).toEqual(["fivem_asset_unused", "fivem_stream_type"]);
  });
  it("refuses a data_file that names no asset", () => {
    const r = inspect(head("data_file_pkg", 'environment_asset "fivem" "stream/**"\ngame_build "fivem" "3258"\ndata_file "DLC_ITYP_REQUEST" "stream/missing.ytyp"\n'), { "stream/a.ydr": Buffer.alloc(8) });
    expect(codes(r)).toEqual(["fivem_data_file_missing"]);
  });
});

describe("Garry's Mod, Luanti, BeamMP, Rust, Hytale", () => {
  it("Garry's Mod: content roots only, maps in maps/", () => {
    const r = inspect(head("gm_stuff", 'assets { "**" }\nenvironments { "garrysmod" }\n'), { "materials/a.vmt": Buffer.from("x"), "maps/gm_x.bsp": Buffer.from("VBSP"), "stuff/a.png": PNG });
    expect(codes(r)).toEqual(["garrysmod_content_root"]);
    expect(r.environments["garrysmod"]!.files).toEqual(["maps/gm_x.bsp", "materials/a.vmt", "stuff/a.png"]);
  });
  it("Luanti: media roots, formats and names", () => {
    const r = inspect(head("lu_media", 'assets { "**" }\nenvironments { "luanti" }\n'), {
      "textures/lu_media_a.png": PNG, "textures/b c.png": PNG, "models/lu_media_m.blend": Buffer.from("x"), "data/lu_media_d.png": PNG,
    });
    expect(codes(r).sort()).toEqual(["luanti_media_name", "luanti_media_root", "luanti_media_type"]);
    expect(codes(r, "warnings")).toContain("luanti_media_prefix");
  });
  it("BeamMP: client zips only, and no generic assets", () => {
    const r = inspect(head("bmp_car", 'assets { "media/**" }\nenvironments { "beammp" }\nenvironment_asset "beammp" "client/car.zip"\n'), {
      "media/a.png": PNG, "client/car.zip": storedZip({ "vehicles/car/car.jbeam": Buffer.from("{}"), "lua/ge/extensions/x.lua": Buffer.from("x") }),
    });
    expect(codes(r)).toEqual(["assets_unsupported", "asset_not_data"]);
  });
  it("Rust: one custom map, the operator hosts it", () => {
    const r = inspect(head("rust_map", 'environment_asset "rust" { "maps/a.map", "maps/b.map" }\n'), { "maps/a.map": Buffer.alloc(4), "maps/b.map": Buffer.alloc(4) });
    expect(codes(r)).toEqual(["rust_one_map"]);
    expect(r.environments["rust"]!.needs).toEqual(["levelurl"]);
  });
  it("Hytale: an asset pack with a data-only manifest", () => {
    const good = storedZip({ "manifest.json": Buffer.from(JSON.stringify({ Name: "X", IncludesAssetPack: true })), "Common/Models/a.blockymodel": Buffer.from("{}") });
    const bad = storedZip({ "manifest.json": Buffer.from(JSON.stringify({ Name: "X", Main: "a.B" })), "lib/x.jar": Buffer.from("PK") });
    expect(inspect(head("hy_pack", 'environment_asset "hytale" "pack.zip"\n'), { "pack.zip": good }).errors).toEqual([]);
    expect(codes(inspect(head("hy_pack", 'environment_asset "hytale" "pack.zip"\n'), { "pack.zip": bad }))).toEqual(["asset_not_data", "hytale_pack_root", "hytale_pack_manifest", "hytale_pack_code"]);
  });
  it("a target that cannot deliver generic assets is an error, not a silent drop", () => {
    const r = inspect(head("generic_only", 'assets { "media/**" }\n'), { "media/a.png": PNG }, ["rust"]);
    expect(codes(r)).toEqual(["assets_unsupported"]);
  });
  it("in-process hosts bundle assets: no player download", () => {
    const r = inspect(head("bundled", 'assets { "media/**" }\nenvironments { "love2d" }\n'), { "media/a.png": PNG });
    expect(r.environments["love2d"]).toMatchObject({ support: "bundled", downloadBytes: 0 });
  });
});
