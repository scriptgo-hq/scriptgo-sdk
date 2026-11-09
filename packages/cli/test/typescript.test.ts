import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { scriptgoArchive } from "../src/commands/pack.ts";
import { compileTypeScript, ESBUILD_VERSION } from "../src/lib/typescript.ts";
import { listFiles, readResource } from "../src/lib/sdk.ts";

const tmp = mkdtempSync(join(tmpdir(), "scriptgo-ts-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function resource(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const manifest = (name: string, scripts: string[]) =>
  JSON.stringify({ resource: name, version: "1.0.0", server_scripts: scripts });

async function compile(dir: string) {
  const r = readResource(dir);
  if (!r.result.ok) throw new Error(r.result.errors.map((e) => e.code).join(", "));
  return compileTypeScript(r.root, r.result.manifest, listFiles(r.root));
}

describe("TypeScript resources", () => {
  it("bundles each entry with its relative imports into <entry>.js, keeping the runtime's exports global", async () => {
    const dir = resource("ts_ok", {
      "scriptgo.json": manifest("ts_ok", ["server/main.ts"]),
      "server/main.ts": 'import { twice } from "./util.ts";\nconst n: number = twice(21);\nexports("answer", () => n);\n',
      "server/util.ts": "export function twice(x: number): number { return x * 2; }\n",
    });
    const { entries, errors } = await compile(dir);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.output).toBe("server/main.ts.js");
    expect(e.inputs).toEqual(["server/main.ts", "server/util.ts"]);
    const code = new TextDecoder().decode(e.code);
    expect(code).toContain("x * 2");
    expect(code).not.toContain(": number");
    // The runtime's `exports` must stay the global, not a CommonJS wrapper's parameter.
    expect(code).toMatch(/exports\("answer"/);
    expect(code).not.toMatch(/__commonJS|module\.exports/);
    expect(ESBUILD_VERSION).toBe("0.25.12");
  });

  it("refuses an import from outside the resource", async () => {
    resource("shared_lib", { "lib.ts": "export const x = 1;\n" });
    const dir = resource("ts_outside", {
      "scriptgo.json": manifest("ts_outside", ["server/main.ts"]),
      "server/main.ts": 'import { x } from "../../shared_lib/lib.ts";\nprint(x);\n',
    });
    const { entries, errors } = await compile(dir);
    expect(entries).toEqual([]);
    expect(errors.map((e) => e.code)).toEqual(["typescript_import_outside_resource"]);
  });

  it("reports a syntax error as typescript_compile_failed with its location", async () => {
    const dir = resource("ts_broken", {
      "scriptgo.json": manifest("ts_broken", ["server/main.ts"]),
      "server/main.ts": "const = 1;\n",
    });
    const { errors } = await compile(dir);
    expect(errors.map((e) => e.code)).toEqual(["typescript_compile_failed"]);
    expect(errors[0]!.message).toMatch(/server\/main\.ts:1:/);
  });

  it("puts the compiled entry in the archive next to its source", async () => {
    const dir = resource("ts_pack", {
      "scriptgo.json": manifest("ts_pack", ["server/*.ts"]),
      "server/main.ts": 'exports("hello", (who: string) => `hi ${who}`);\n',
    });
    const r = readResource(dir);
    if (!r.result.ok) throw new Error("manifest");
    const { zip, files, errors } = await scriptgoArchive(r.result.manifest, listFiles(r.root), r.root, r.manifestFile);
    expect(errors).toEqual([]);
    expect(files).toContain("server/main.ts");
    expect(files).toContain("server/main.ts.js");
    // The archive holds the resource in a folder named after it.
    expect(Object.keys(unzipSync(zip))).toContain("ts_pack/server/main.ts.js");
  });
});
