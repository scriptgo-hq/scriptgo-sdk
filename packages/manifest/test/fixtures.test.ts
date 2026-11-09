import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expandGlob, parseManifest, satisfies, scriptLanguage, scriptLanguages, validateResourceFiles } from "../src/index.ts";

// The same fixtures are run by the Lua parser (sdk/lua/spec/manifest_spec.lua).
const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../sdk/lua/spec/fixtures/manifests");

interface Expectation {
  ok: boolean;
  fileName?: string;
  errors?: string[];
  warnings?: string[];
  manifest?: Record<string, unknown>;
}

describe("manifest fixtures (shared with the Lua parser)", () => {
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".lua"))
    .map((f) => f.slice(0, -4));
  it("has fixtures", () => expect(names.length).toBeGreaterThan(10));
  for (const name of names) {
    it(name, () => {
      const source = readFileSync(join(dir, `${name}.lua`), "utf8");
      const exp = JSON.parse(readFileSync(join(dir, `${name}.expect.json`), "utf8")) as Expectation;
      const result = parseManifest(source, { fileName: exp.fileName ?? "scriptgo.lua" });
      expect(result.ok).toBe(exp.ok);
      if (exp.errors) expect(result.ok ? [] : result.errors.map((e) => e.code)).toEqual(exp.errors);
      if (exp.warnings) expect(result.warnings.map((w) => w.code)).toEqual(exp.warnings);
      if (exp.manifest && result.ok) expect(result.manifest).toMatchObject(exp.manifest);
    });
  }
});

describe("scriptgo.json fixtures (shared with the Lua parser)", () => {
  const jsonDir = join(dirname(fileURLToPath(import.meta.url)), "../../../sdk/lua/spec/fixtures/manifests-json");
  const names = readdirSync(jsonDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".expect.json"))
    .map((f) => f.slice(0, -5));
  it("has fixtures", () => expect(names.length).toBeGreaterThan(8));
  for (const name of names) {
    it(name, () => {
      const source = readFileSync(join(jsonDir, `${name}.json`), "utf8");
      const exp = JSON.parse(readFileSync(join(jsonDir, `${name}.expect.json`), "utf8")) as Expectation;
      const result = parseManifest(source, { fileName: exp.fileName ?? "scriptgo.json" });
      expect(result.ok).toBe(exp.ok);
      if (exp.errors) expect(result.ok ? [] : result.errors.map((e) => e.code)).toEqual(exp.errors);
      if (exp.warnings) expect(result.warnings.map((w) => w.code)).toEqual(exp.warnings);
      if (exp.manifest && result.ok) expect(result.manifest).toMatchObject(exp.manifest);
      // JSON diagnostics carry no line.
      for (const d of [...(result.ok ? [] : result.errors), ...result.warnings]) expect(d.line).toBeUndefined();
    });
  }
});

describe("script languages", () => {
  it("maps extensions to guest languages", () => {
    expect(scriptLanguage("server/main.lua")).toBe("lua");
    expect(scriptLanguage("server/main.ts")).toBe("js");
    expect(scriptLanguage("client/ui.js")).toBe("js");
    expect(scriptLanguage("server/main.cs")).toBeNull();
  });
  it("lists the languages of every script entry, sorted", () => {
    const r = parseManifest(`resource "mixed"
version "1.0.0"
scriptgo_version ">=0.1.0"
shared_script "shared/a.lua"
server_script "server/b.ts"
environment_script "love2d" "env/c.js"
`);
    if (!r.ok) throw new Error("parse failed");
    expect(scriptLanguages(r.manifest)).toEqual(["js", "lua"]);
  });
});

describe("validateResourceFiles", () => {
  const src = `resource "res_x"\nversion "1.0.0"\nscriptgo_version ">=0.1.0"\nserver_script "server/main.lua"\nfiles { "assets/**/*.png", "data/*.json" }\n`;
  it("accepts a complete listing", () => {
    const r = parseManifest(src);
    if (!r.ok) throw new Error("parse failed");
    expect(validateResourceFiles(r.manifest, ["scriptgo.lua", "server/main.lua", "assets/ui/a.png", "data/b.json"])).toEqual([]);
  });
  it("accepts scriptgo.json as the manifest of a scriptgo resource", () => {
    const r = parseManifest(src);
    if (!r.ok) throw new Error("parse failed");
    expect(validateResourceFiles(r.manifest, ["scriptgo.json", "server/main.lua", "assets/ui/a.png", "data/b.json"])).toEqual([]);
    expect(validateResourceFiles(r.manifest, ["server/main.lua", "assets/ui/a.png", "data/b.json"]).map((d) => d.code)).toEqual(["missing_manifest"]);
  });
  it("reports missing scripts and empty globs with OPEN//77 ** semantics", () => {
    const r = parseManifest(src);
    if (!r.ok) throw new Error("parse failed");
    const codes = validateResourceFiles(r.manifest, ["scriptgo.lua", "assets/a.png"]).map((d) => d.code);
    expect(codes).toEqual(["missing_file", "pattern_empty", "pattern_empty"]);
  });
  it("expands globs like OPEN//77", () => {
    expect(expandGlob("client/**/*.lua", ["client/main.lua"])).toEqual([]);
    expect(expandGlob("client/**/*.lua", ["client/ui/main.lua"])).toEqual(["client/ui/main.lua"]);
    expect(expandGlob("web/**", ["web/index.html", "web/js/app.js"])).toEqual(["web/index.html", "web/js/app.js"]);
  });
});

describe("semver ranges", () => {
  it.each([
    ["1.4.1", ">=1.0.0", true],
    ["0.9.9", ">=1.0.0", false],
    ["1.9.0", "^1.2.0", true],
    ["2.0.0", "^1.2.0", false],
    ["0.1.5", "^0.1", true],
    ["0.2.0", "^0.1.0", false],
    ["1.2.9", "~1.2.0", true],
    ["1.3.0", "~1.2.0", false],
    ["2.1.0", "1.x || 2.x", true],
    ["1.0.0-beta.1", ">=1.0.0", false],
    ["1.5.0", ">=1.0.0 <2.0.0", true],
  ])("%s satisfies %s → %s", (v, range, expected) => {
    expect(satisfies(v, range)).toBe(expected);
  });
});
