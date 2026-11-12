// FiveM target: `pack --target fivem` and the `verify --env fivem` runner. No test here runs FiveM:
// the runner tests use a FAKE FXServer (test/fixtures/fake-fxserver.mjs) that only prints console
// lines, so they check process handling and parsing, never a package. Real evidence comes only from
// `scriptgo verify --env fivem` on a real FXServer.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { fivemManifest, luaString, packForCfx, packForFivem, RDR3_WARNING } from "../src/lib/fivem-pack.ts";
import { fivemServerCfg, newFxConsole, readFxLine, verifyFivem } from "../src/lib/fivem-verify.ts";
import { findInterpreters, readResource, repoRoot } from "../src/lib/sdk.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-fivem-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const search = [join(repoRoot, "sdk", "packages"), join(repoRoot, "sdk", "conformance"), join(repoRoot, "examples", "packages")];
const fake = join(repoRoot, "packages", "cli", "test", "fixtures", "fake-fxserver.mjs");

function resource(name: string, files: Record<string, string>): string {
  const dir = join(tmp, "src", name);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

const manifest = (name: string, extra: string): string =>
  `resource "${name}"\nversion "1.0.0"\nscriptgo_version ">=0.1.0"\nenvironments { "standalone", "fivem" }\n${extra}`;

describe("luaString", () => {
  it("writes valid Lua literals", () => {
    expect(luaString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(luaString("x\ny\u0001")).toBe('"x\\ny\\001"');
    expect(luaString("café")).toBe('"café"');
  });
});

describe("packForFivem", () => {
  it("writes an fxmanifest.lua that loads the shim before every script of the resource", () => {
    const r = packForFivem(readResource(join(repoRoot, "sdk", "packages", "sg_inventory")), join(tmp, "out"));
    expect(r.errors).toEqual([]);
    const text = readFileSync(join(r.dest, "fxmanifest.lua"), "utf8");
    expect(text).toMatch(/^fx_version "cerulean"$/m);
    expect(text).toMatch(/^game "gta5"$/m);
    expect(text).toMatch(/^version "1\.0\.2"$/m);
    const scripts = text.split("\n").filter((l) => /_script /.test(l));
    expect(scripts).toEqual([
      'shared_script "scriptgo_shim.lua"',
      'shared_script "shared/inventory.lua"',
      'server_script "server/main.lua"',
      'client_script "client/main.lua"',
    ]);
    expect(text).toMatch(/^scriptgo_permission "network\.events"$/m);
    expect(readFileSync(join(r.dest, "scriptgo_shim.lua"), "utf8")).toMatch(/ADAPTER_VERSION = "fivem-shim-/);
    expect(r.warnings.join(" ")).toMatch(/does not list fivem/);
  });

  it("keeps the shim's player match section only for a package that declares presence", () => {
    const plain = readFileSync(join(packForFivem(readResource(join(repoRoot, "sdk", "packages", "sg_inventory")), join(tmp, "out")).dest, "scriptgo_shim.lua"), "utf8");
    expect(plain).not.toMatch(/@capability|@include|scriptgo_presence_addr|RegisterCommand\(command/);
    const r = packForFivem(readResource(join(repoRoot, "sdk", "conformance", "sg_probe_presence")), join(tmp, "out"));
    const shim = readFileSync(join(r.dest, "scriptgo_shim.lua"), "utf8");
    expect(shim).not.toMatch(/@capability|@include/);
    expect(shim).toMatch(/function M\.codeFromArgs/); // the core's module, included word for word
    expect(shim).toMatch(/CAPS\.presence = true/);
    const lua = findInterpreters().find((i) => i.name === "lua54");
    if (lua) {
      const out = spawnSync(lua.path, ["-e", `assert(loadfile(${luaString(join(r.dest, "scriptgo_shim.lua"))}))`], { encoding: "utf8" });
      expect(out.status, out.stderr).toBe(0);
    }
  });

  it("drops dependency ranges FiveM cannot express, with a warning", () => {
    const r = packForFivem(readResource(join(repoRoot, "sdk", "conformance", "sg_probe")), join(tmp, "out"));
    expect(r.errors).toEqual([]);
    const text = readFileSync(join(r.dest, "fxmanifest.lua"), "utf8");
    expect(text).toMatch(/^dependencies \{ "sg_eventbus", "sg_inventory", "sg_permissions" \}$/m);
    expect(r.warnings.join(" ")).toMatch(/sg_eventbus >=1\.0\.0/);
  });

  it("refuses a package that needs a licence check: the shim has none (a technical limit, not a selling rule)", () => {
    const r = packForFivem(readResource(join(repoRoot, "examples", "packages", "inventory_pro")), join(tmp, "out"));
    expect(r.errors.map((e) => e.code)).toContain("fivem_licensing_unavailable");
    expect(r.errors[0]!.message).toMatch(/no licence check/);
    expect(r.errors[0]!.message).toMatch(/not a selling rule/);
    // The platform's terms are quoted as the platform's own rule, with their source.
    expect(r.errors[0]!.message).toMatch(/§3\.1\(6\)/);
    expect(r.errors[0]!.message).not.toMatch(/free-only|free only/i);
    expect(r.dest).toBe("");
  });

  it("refuses a required licensing capability and warns about an optional one", () => {
    const req = resource("needs_lic", { "scriptgo.lua": manifest("needs_lic", 'capabilities { "licensing" }\nserver_script "s.lua"\n'), "s.lua": "print(1)\n" });
    expect(packForFivem(readResource(req), join(tmp, "out")).errors.map((e) => e.code)).toEqual(["fivem_licensing_unavailable"]);
    const opt = resource("opt_lic", { "scriptgo.lua": manifest("opt_lic", 'optional_capabilities { "licensing" }\nserver_script "s.lua"\n'), "s.lua": "print(1)\n" });
    const r = packForFivem(readResource(opt), join(tmp, "out"));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/capability_unavailable:licensing@fivem/);
  });

  it("refuses `require` and client-side `os`, unless --allow-unportable", () => {
    const dir = resource("unportable", {
      "scriptgo.lua": manifest("unportable", 'shared_script "shared.lua"\nserver_script "server.lua"\nclient_script "client.lua"\n'),
      "shared.lua": "local util = require(\"lib.util\")\n-- require('commented') is fine\nlocal s = 'require(\"in a string\")'\n",
      "server.lua": "local t = os.time()\nScriptGo.capabilities.require(\"http\")\n",
      "client.lua": "local t = os.clock()\n",
    });
    const r = packForFivem(readResource(dir), join(tmp, "out"));
    expect(r.errors.map((e) => e.code).sort()).toEqual(["fivem_client_no_os", "fivem_no_require"]);
    expect(r.errors.find((e) => e.code === "fivem_no_require")!.message).toMatch(/^shared\.lua:1 /);
    const loose = packForFivem(readResource(dir), join(tmp, "out"), { allowUnportable: true });
    expect(loose.errors).toEqual([]);
    expect(loose.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("puts fivem environment scripts after the side scripts, on both sides", () => {
    const m = readResource(resource("envs", {
      "scriptgo.lua": manifest("envs", 'server_script "s.lua"\nclient_script "c.lua"\nenvironment_script "fivem" "env/fivem.lua"\nenvironment_script "love2d" "env/love.lua"\n'),
      "s.lua": "", "c.lua": "", "env/fivem.lua": "", "env/love.lua": "",
    })).result;
    if (!m.ok) throw new Error("manifest");
    const warnings: string[] = [];
    const text = fivemManifest(m.manifest, warnings);
    expect(text.split("\n").filter((l) => /_script /.test(l))).toEqual([
      'shared_script "scriptgo_shim.lua"', 'server_script "s.lua"', 'server_script "env/fivem.lua"', 'client_script "c.lua"', 'client_script "env/fivem.lua"',
    ]);
    expect(warnings.join(" ")).toMatch(/love2d/);
  });

  it("the generated fxmanifest.lua runs as Lua and declares what FiveM reads", () => {
    const lua = findInterpreters().find((i) => i.name === "lua54");
    if (!lua) return; // tools/build-lua.ps1 not run here
    const r = packForFivem(readResource(join(repoRoot, "sdk", "conformance", "sg_probe")), join(tmp, "out"));
    // FiveM evaluates fxmanifest.lua with a metatable that turns every unknown global into a
    // directive; this stand-in records them the same way.
    const harness = join(tmp, "read-manifest.lua");
    writeFileSync(harness, [
      "local seen = {}",
      "local env = setmetatable({}, { __index = function(_, k) return function(v) seen[#seen + 1] = k .. '=' .. (type(v) == 'table' and table.concat(v, ',') or tostring(v)) end end })",
      "local chunk = assert(loadfile(arg[1], 't', env))",
      "chunk()",
      "print(table.concat(seen, '\\n'))",
    ].join("\n"));
    const out = spawnSync(lua.path, [harness, join(r.dest, "fxmanifest.lua")], { encoding: "utf8" });
    expect(out.status).toBe(0);
    const seen = out.stdout.trim().split(/\r?\n/);
    expect(seen.slice(0, 3)).toEqual(["fx_version=cerulean", "game=gta5", "version=0.1.0"]);
    expect(seen).toContain("shared_script=scriptgo_shim.lua");
    expect(seen).toContain("server_script=server/probe.lua");
    expect(seen).toContain("dependencies=sg_eventbus,sg_inventory,sg_permissions");
  });
});

/**
 * Evaluates a generated fxmanifest.lua the way FXServer does (every unknown global is a directive,
 * `data_file "A" "B"` is a curried call) and returns `name=value` lines. Null without lua54.
 */
function readFxManifest(file: string): string[] | null {
  const lua = findInterpreters().find((i) => i.name === "lua54");
  if (!lua) return null; // tools/build-lua.ps1 not run here
  const harness = join(tmp, "read-fxmanifest.lua");
  writeFileSync(harness, [
    "local seen = {}",
    "local function show(v) return type(v) == 'table' and table.concat(v, ',') or tostring(v) end",
    "local env = setmetatable({}, { __index = function(_, k) return function(v)",
    "  local i = #seen + 1; seen[i] = k .. '=' .. show(v)",
    "  return function(w) seen[i] = seen[i] .. ' ' .. show(w) end",
    "end end })",
    "assert(loadfile(arg[1], 't', env))()",
    "print(table.concat(seen, '\\n'))",
  ].join("\n"));
  const out = spawnSync(lua.path, [harness, file], { encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout.trim().split(/\r?\n/);
}

describe("packForCfx: RedM", () => {
  it("writes game rdr3 with RedM's exact pre-release acknowledgement, and a shim that says redm", () => {
    const r = packForCfx(readResource(join(repoRoot, "sdk", "packages", "sg_inventory")), join(tmp, "redm"), { game: "redm" });
    expect(r.errors).toEqual([]);
    const text = readFileSync(join(r.dest, "fxmanifest.lua"), "utf8");
    expect(text).toMatch(/^game "rdr3"$/m);
    expect(text).not.toMatch(/gta5/);
    // Word for word what FXServer (build 38435) asks for; without it RedM refuses the resource.
    expect(text).toContain('rdr3_warning "I acknowledge that this is a prerelease build of RedM, and I am aware my resources *will* become incompatible once RedM ships."');
    expect(RDR3_WARNING).toBe("I acknowledge that this is a prerelease build of RedM, and I am aware my resources *will* become incompatible once RedM ships.");
    const shim = readFileSync(join(r.dest, "scriptgo_shim.lua"), "utf8");
    expect(shim).toMatch(/^local ENVIRONMENT = "redm"\r?$/m);
    expect(shim).not.toMatch(/^local ENVIRONMENT = "fivem"/m);
    expect(r.warnings.join(" ")).toMatch(/does not list redm/);
    const seen = readFxManifest(join(r.dest, "fxmanifest.lua"));
    if (seen) expect(seen.slice(0, 4)).toEqual(["fx_version=cerulean", "game=rdr3", `rdr3_warning=${RDR3_WARNING}`, "version=1.0.2"]);
  });

  it("ships RedM's own environment assets and scripts, never FiveM's", () => {
    const dir = resource("two_games_pkg", {
      "scriptgo.lua": manifest("two_games_pkg", [
        'server_script "s.lua"',
        'environment_script "redm" "env/redm.lua"',
        'environment_script "fivem" "env/fivem.lua"',
        'environment_asset "fivem" { "stream/gta/**", "data/gta/**" }',
        'environment_asset "redm" { "stream/rdr/**", "data/rdr/**" }',
        'game_build "fivem" "3258"', 'game_build "redm" "1491"',
        'data_file "VEHICLE_METADATA_FILE" "data/gta/vehicles.meta"',
        'data_file "DLC_ITYP_REQUEST" "data/rdr/props.ytyp"',
        "",
      ].join("\n")),
      "s.lua": "\n", "env/redm.lua": "\n", "env/fivem.lua": "\n",
      "stream/gta/a.ydr": "RSC7 gta", "data/gta/vehicles.meta": "<x/>", "stream/rdr/b.ydr": "RSC7 rdr", "stream/rdr/m.ymap": "RSC7 map", "data/rdr/props.ytyp": "RSC7 ytyp",
    });
    const r = packForCfx(readResource(dir), join(tmp, "redm"), { game: "redm" });
    expect(r.errors).toEqual([]);
    const text = readFileSync(join(r.dest, "fxmanifest.lua"), "utf8");
    expect(text).toMatch(/^data_file "DLC_ITYP_REQUEST" "data\/rdr\/props\.ytyp"$/m);
    expect(text).not.toMatch(/gta/);
    expect(text).toMatch(/^this_is_a_map "yes"$/m);
    expect(text.split("\n").filter((l) => /_script /.test(l))).toEqual([
      'shared_script "scriptgo_shim.lua"', 'server_script "s.lua"', 'server_script "env/redm.lua"', 'client_script "env/redm.lua"',
    ]);
    expect(existsSync(join(r.dest, "stream", "gta"))).toBe(false);
    expect(existsSync(join(r.dest, "stream", "rdr", "b.ydr"))).toBe(true);
    // The FiveM build of the same package keeps the other half.
    const f = packForFivem(readResource(dir), join(tmp, "fivem2"));
    expect(f.errors).toEqual([]);
    const ftext = readFileSync(join(f.dest, "fxmanifest.lua"), "utf8");
    expect(ftext).toMatch(/^data_file "VEHICLE_METADATA_FILE" "data\/gta\/vehicles\.meta"$/m);
    expect(ftext).not.toMatch(/rdr/);
  });

  it("refuses a required presence capability on RedM and strips the section otherwise", () => {
    const req = resource("needs_presence", { "scriptgo.lua": manifest("needs_presence", 'capabilities { "presence" }\nserver_script "s.lua"\n'), "s.lua": "\n" });
    expect(packForCfx(readResource(req), join(tmp, "redm"), { game: "redm" }).errors.map((e) => e.code)).toEqual(["redm_presence_unavailable"]);
    const r = packForCfx(readResource(join(repoRoot, "sdk", "conformance", "sg_probe_presence")), join(tmp, "redm"), { game: "redm" });
    if (r.errors.length === 0) {
      expect(readFileSync(join(r.dest, "scriptgo_shim.lua"), "utf8")).not.toMatch(/scriptgo_presence_addr/);
    } else {
      expect(r.errors.map((e) => e.code)).toEqual(["redm_presence_unavailable"]);
    }
  });

  it("refuses a package that needs a licence check, as on FiveM", () => {
    const r = packForCfx(readResource(join(repoRoot, "examples", "packages", "inventory_pro")), join(tmp, "redm"), { game: "redm" });
    expect(r.errors.map((e) => e.code)).toContain("fivem_licensing_unavailable");
  });
});

describe("packForCfx: --cfx-escrow", () => {
  const escrowPkg = (): string =>
    resource("escrowed_shop", {
      "scriptgo.lua": manifest("escrowed_shop", [
        'shared_script "config.lua"',
        'server_script "server/main.lua"',
        'client_script "client/main.lua"',
        'web_ui_page "web/index.html"',
        'web_file "web/app.js"',
        'file "data/prices.json"',
        'environment_asset "fivem" "stream/**"',
        'game_build "fivem" "3258"',
        'cfx_escrow_ignore { "config.lua", "data/*.json", "locales/*.lua" }',
        "",
      ].join("\n")),
      "config.lua": "Config = {}\n", "server/main.lua": "\n", "client/main.lua": "\n",
      "web/index.html": "<p>x</p>", "web/app.js": "1", "data/prices.json": "{}",
      "stream/shop.ydr": "RSC7 model", "stream/shop.ytd": "RSC7 texture",
    });

  it("writes escrow_ignore, lua54 and the upload zip, and says what Cfx.re leaves readable", () => {
    const r = packForCfx(readResource(escrowPkg()), join(tmp, "esc"), { game: "fivem", cfxEscrow: true });
    expect(r.errors).toEqual([]);
    const text = readFileSync(join(r.dest, "fxmanifest.lua"), "utf8");
    expect(text).toMatch(/^lua54 "yes"$/m);
    expect(text).toMatch(/^escrow_ignore \{ "config\.lua", "data\/prices\.json", "scriptgo_shim\.lua" \}$/m);
    expect(text).toMatch(/--cfx-escrow/);
    const e = r.escrow!;
    expect(e.encrypted).toEqual(["client/main.lua", "server/main.lua", "stream/shop.ydr"]);
    expect(e.ignored).toEqual(["config.lua", "data/prices.json", "scriptgo_shim.lua"]);
    expect(e.notEncrypted).toEqual(["stream/shop.ytd", "web/app.js", "web/index.html"]);
    expect(e.serverBuild).toBe(5181);
    const w = r.warnings.join("\n");
    expect(w).toMatch(/cfx_escrow_ignore 'locales\/\*\.lua' matches no file/);
    expect(w).toMatch(/NUI files .* web\/app\.js, web\/index\.html stay readable/);
    expect(w).toMatch(/\.ydr, \.ydd and \.yft models only: 1 other streamed files \(\.ytd\)/);
    // The zip holds the resource folder, byte for byte, and is the same on every build.
    const entries = unzipSync(readFileSync(e.zip));
    expect(Object.keys(entries).sort()).toEqual([
      "escrowed_shop/client/main.lua", "escrowed_shop/config.lua", "escrowed_shop/data/prices.json", "escrowed_shop/fxmanifest.lua",
      "escrowed_shop/scriptgo_shim.lua", "escrowed_shop/server/main.lua", "escrowed_shop/stream/shop.ydr", "escrowed_shop/stream/shop.ytd",
      "escrowed_shop/web/app.js", "escrowed_shop/web/index.html",
    ]);
    expect(Buffer.from(entries["escrowed_shop/fxmanifest.lua"]!).toString("utf8")).toBe(text);
    const again = packForCfx(readResource(escrowPkg()), join(tmp, "esc"), { game: "fivem", cfxEscrow: true });
    expect(readFileSync(again.escrow!.zip).equals(readFileSync(e.zip))).toBe(true);
    const seen = readFxManifest(join(r.dest, "fxmanifest.lua"));
    if (seen) {
      expect(seen).toContain("lua54=yes");
      expect(seen).toContain("escrow_ignore=config.lua,data/prices.json,scriptgo_shim.lua");
    }
  });

  it("RedM: the escrow build needs RedM server 12735 and keeps rdr3_warning", () => {
    const dir = resource("redm_escrow", {
      "scriptgo.lua": manifest("redm_escrow", 'server_script "s.lua"\nfile "config.json"\ncfx_escrow_ignore "config.json"\n'),
      "s.lua": "\n", "config.json": "{}",
    });
    const r = packForCfx(readResource(dir), join(tmp, "esc"), { game: "redm", cfxEscrow: true });
    expect(r.errors).toEqual([]);
    expect(r.escrow!.serverBuild).toBe(12735);
    expect(r.escrow!.encrypted).toEqual(["s.lua"]);
    const text = readFileSync(join(r.dest, "fxmanifest.lua"), "utf8");
    expect(text).toMatch(/^game "rdr3"$/m);
    expect(text).toContain(`rdr3_warning "${RDR3_WARNING}"`);
    expect(text).toMatch(/^escrow_ignore \{ "config\.json", "scriptgo_shim\.lua" \}$/m);
  });

  it("an asset-only package: Cfx.re encrypts its models, and says nothing is encrypted when there are none", () => {
    const models = resource("models_only", {
      "scriptgo.lua": 'resource "models_only"\nversion "1.0.0"\nscriptgo_version ">=0.1.0"\nenvironment_asset "fivem" "stream/**"\ngame_build "fivem" "3258"\n',
      "stream/car.yft": "RSC7 frag", "stream/car.ytd": "RSC7 tex",
    });
    const r = packForCfx(readResource(models), join(tmp, "esc"), { game: "fivem", cfxEscrow: true });
    expect(r.errors).toEqual([]);
    expect(r.escrow!.encrypted).toEqual(["stream/car.yft"]);
    expect(readFileSync(join(r.dest, "fxmanifest.lua"), "utf8")).not.toMatch(/escrow_ignore|scriptgo_shim/);
    const maps = resource("map_only", {
      "scriptgo.lua": 'resource "map_only"\nversion "1.0.0"\nscriptgo_version ">=0.1.0"\nenvironment_asset "fivem" "stream/**"\ngame_build "fivem" "3258"\n',
      "stream/a.ymap": "RSC7 map",
    });
    const m = packForCfx(readResource(maps), join(tmp, "esc"), { game: "fivem", cfxEscrow: true });
    expect(m.escrow!.encrypted).toEqual([]);
    expect(m.warnings.join(" ")).toMatch(/nothing in this build is a file Cfx\.re's escrow encrypts/);
  });

  it("refuses a buyer's fingerprinted copy: the escrow upload is the creator's", () => {
    const dir = escrowPkg();
    mkdirSync(join(dir, ".scriptgo"), { recursive: true });
    writeFileSync(join(dir, ".scriptgo", "fingerprint.json"), "{}");
    const r = packForCfx(readResource(dir), join(tmp, "esc"), { game: "fivem", cfxEscrow: true });
    expect(r.errors.map((e) => e.code)).toEqual(["cfx_escrow_buyer_copy"]);
  });
});

describe("FXServer console", () => {
  // Lines built from the format strings in the FXServer build 38435 binaries.
  const lines = [
    "[           resources] Started resource sg_eventbus",
    "[           resources] Started resource sg_probe (1 warning)",
    "[ citizen-server-impl] \u001b[33mCouldn't start resource sg_inventory.\u001b[0m",
    "[     script:sg_probe] ^1SCRIPT ERROR: @sg_probe/server/probe.lua:12: attempt to index a nil value^7",
    "[     script:sg_probe] Error loading script server/x.lua in resource sg_probe: syntax error",
    "[     script:other_res] ^1SCRIPT ERROR: @other_res/a.lua:1: not ours^7",
    "[          svadhesive] Server license key authentication succeeded. Welcome!",
  ];
  it("reads starts, failures, script errors and the licence state", () => {
    const s = newFxConsole();
    for (const l of lines) readFxLine(s, l, ["sg_eventbus", "sg_probe", "sg_inventory"]);
    expect([...s.started].sort()).toEqual(["sg_eventbus", "sg_probe"]);
    expect(s.failed.get("sg_inventory")).toMatch(/Couldn't start resource sg_inventory/);
    expect(s.failed.get("sg_probe")).toMatch(/attempt to index a nil value/);
    expect(s.errorLines).toHaveLength(3);
    expect(s.licenseOk).toBe(true);
    expect(s.lines[3]).not.toMatch(/\^1|\u001b/);
  });
  it("sees the missing-key fatal error", () => {
    const s = newFxConsole();
    readFxLine(s, "[          svadhesive] Error: This server does not have a license key specified. Please set the sv_licenseKey console variable", []);
    readFxLine(s, "Fatal Error: This server does not have a license key specified.", []);
    expect(s.licenseError).toMatch(/does not have a license key/);
    expect(s.fatal).toMatch(/license key/);
  });
  it("server.cfg binds loopback only and keeps the server off the list", () => {
    const cfg = fivemServerCfg(30121, ["a", "b"], { "a:api": "http://127.0.0.1:1/" });
    expect(cfg).toMatch(/^endpoint_add_tcp "127\.0\.0\.1:30121"$/m);
    expect(cfg).toMatch(/^endpoint_add_udp "127\.0\.0\.1:30121"$/m);
    expect(cfg).toMatch(/^sv_master1 ""$/m);
    expect(cfg).not.toMatch(/0\.0\.0\.0|sv_licenseKey/);
    expect(cfg).toMatch(/^ensure a\nensure b\n$/m);
  });
});

describe("verifyFivem", () => {
  const probe = readResource(join(repoRoot, "sdk", "conformance", "sg_probe"));
  const m = probe.result.ok ? probe.result.manifest : null!;
  const base = { port: 30121, settleMs: 50, timeoutMs: 20000, workDir: join(tmp, "runs"), example: null };

  it("is skipped, never verified, without a server binary", async () => {
    const r = await verifyFivem(probe, m, search, { ...base, server: join(tmp, "missing", "FXServer.exe"), licenseKey: "k" });
    expect(r.status).toBe("skipped");
    expect(r.checks.find((c) => c.name === "server_run")!.message).toMatch(/no FXServer/);
  });

  it("is skipped, never verified, without a licence key", async () => {
    const r = await verifyFivem(probe, m, search, { ...base, server: process.execPath, licenseKey: "" });
    expect(r.status).toBe("skipped");
    expect(r.checks.find((c) => c.name === "server_run")!.message).toMatch(/SCRIPTGO_FIVEM_LICENSE_KEY/);
  });

  it("drives a (fake) server: ensures every packed resource and reads their verdicts", async () => {
    const r = await verifyFivem(probe, m, search, { ...base, licenseKey: "fake-key-123", launcher: [process.execPath, fake] });
    expect(r.environment).toBe("fivem");
    expect(r.runtimeVersion).toBe("fake FXServer (test)");
    for (const n of ["sg_eventbus", "sg_inventory", "sg_permissions", "sg_probe"]) {
      expect(r.checks.find((c) => c.name === `starts:${n}`)!.status).toBe("passed");
    }
    expect(r.checks.find((c) => c.name === "license_key")!.status).toBe("passed");
    expect(r.checks.find((c) => c.name === "server_run")!.status).toBe("passed");
    expect(r.log).not.toMatch(/fake-key-123/);
  });

  it("reports a script error and failed self-checks as failing", async () => {
    process.env.FAKE_FX_SCRIPT_ERROR = "sg_probe";
    process.env.FAKE_FX_SGCHECK = "sg_probe";
    try {
      const r = await verifyFivem(probe, m, search, { ...base, licenseKey: "k", launcher: [process.execPath, fake] });
      expect(r.status).toBe("failing");
      expect(r.checks.find((c) => c.name === "starts:sg_probe")!.message).toMatch(/boom/);
      expect(r.checks.find((c) => c.name === "no_runtime_errors")!.status).toBe("failed");
      expect(r.checks.find((c) => c.name === "self:runtime.side")!.status).toBe("passed");
      expect(r.checks.find((c) => c.name === "self:storage.roundtrip")!.status).toBe("failed");
    } finally {
      delete process.env.FAKE_FX_SCRIPT_ERROR;
      delete process.env.FAKE_FX_SGCHECK;
    }
  });

  it("refuses to pack a package that needs a licence check before any server starts", async () => {
    const pro = readResource(join(repoRoot, "examples", "packages", "inventory_pro"));
    const r = await verifyFivem(pro, pro.result.ok ? pro.result.manifest : null!, search, { ...base, licenseKey: "k", launcher: [process.execPath, fake] });
    expect(r.status).toBe("failing");
    expect(r.checks.find((c) => c.name === "packs:inventory_pro")!.message).toMatch(/fivem_licensing_unavailable/);
    expect(r.checks.some((c) => c.name === "server_run")).toBe(false);
  });
});
