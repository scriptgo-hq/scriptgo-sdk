import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");

type Member = { name: string; kind: string; languages?: string[]; js?: { signature?: string } };
type Idl = {
  idl: number;
  globals: Member[];
  namespaces: { name: string; members: Member[]; js?: { type?: string } }[];
  events: { name: string }[];
};
const idl = JSON.parse(readFileSync(join(repo, "docs", "spec", "runtime-idl.json"), "utf8")) as Idl;
const forJs = (m: { languages?: string[] }) => !m.languages || m.languages.includes("js");
const forLua = (m: { languages?: string[] }) => !m.languages || m.languages.includes("lua");

function diagnostics(configPath: string): string[] {
  const config = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file && d.start !== undefined ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} ` : "";
    return where + ts.flattenDiagnosticMessageText(d.messageText, "\n");
  });
}

describe("@scriptgo/types", () => {
  it("is up to date with docs/spec/runtime-idl.json", () => {
    const r = spawnSync(process.execPath, [join(repo, "tools", "gen-types.mjs"), "--check"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("type-checks a sample resource, and rejects the misuse it marks with @ts-expect-error", () => {
    expect(diagnostics(join(here, "sample", "tsconfig.json"))).toEqual([]);
  });

  it("declares every JavaScript global and host event of the IDL", () => {
    const dts = readFileSync(join(repo, "packages", "types", "index.d.ts"), "utf8");
    for (const g of idl.globals.filter(forJs)) {
      expect(dts, g.name).toMatch(new RegExp(`declare (function|var|const|class) ${g.name}\\b`));
    }
    for (const g of idl.globals.filter((m) => !forJs(m))) {
      expect(dts, g.name).not.toMatch(new RegExp(`declare (function|var|const|class) ${g.name}\\b`));
    }
    for (const e of idl.events) expect(dts).toContain(`  ${e.name}: (`);
  });
});

// The IDL describes what the kits expose: each name it lists must exist in the .NET kit's guest
// preludes (a cheap guard against the contract and the implementation drifting apart).
describe("runtime-idl.json against the .NET kit preludes", () => {
  const preludeJs = readFileSync(join(repo, "sdk", "dotnet", "ScriptGo.Host", "Guests", "JavaScript", "prelude.js"), "utf8");
  const preludeLua = readFileSync(join(repo, "sdk", "dotnet", "ScriptGo.Host", "Guests", "Lua", "prelude.lua"), "utf8");

  it("lists globals the preludes define", () => {
    for (const g of idl.globals) {
      if (forJs(g)) expect(preludeJs, `js ${g.name}`).toMatch(new RegExp(`\\b${g.name}\\b`));
      if (forLua(g)) expect(preludeLua, `lua ${g.name}`).toMatch(new RegExp(`env\\.${g.name}\\b`));
    }
  });

  it("lists namespace members the preludes define", () => {
    for (const ns of idl.namespaces) {
      for (const m of ns.members) {
        if (m.kind === "natives") continue;
        const key = new RegExp(`\\b${m.name}\\s*[:=(]`);
        if (forJs(m)) expect(preludeJs, `js ${ns.name}.${m.name}`).toMatch(key);
        if (forLua(m)) expect(preludeLua, `lua ${ns.name}.${m.name}`).toMatch(key);
      }
    }
  });
});
