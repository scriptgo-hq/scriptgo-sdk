import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest, type ParsedManifest } from "@scriptgo/manifest";
import { exampleCapabilities, exampleManifest, exampleName, runnableBlock, writeReadmeExample } from "../src/lib/readme-example.ts";

function manifest(source: string): ParsedManifest {
  const r = parseManifest(source, { fileName: "scriptgo.lua" });
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join("; "));
  return r.manifest;
}

const KIT = manifest(`resource "sg_kit"
version "1.2.3"
environments { "standalone", "open77" }
server_script "server/main.lua"
`);

describe("runnableBlock", () => {
  it("takes the first block marked lua runnable, not the first lua block", () => {
    const md = [
      "# Kit", "", "```lua", 'dependency "sg_kit"', "```", "",
      "```lua runnable", "print(1)", "", "```", "",
      "```lua runnable", "print(2)", "```", "",
    ].join("\n");
    expect(runnableBlock(md)).toBe("print(1)\n");
  });

  it("accepts tildes, CRLF and extra info words", () => {
    expect(runnableBlock("~~~lua title=x runnable\r\nprint(3)\r\n~~~\r\n")).toBe("print(3)\n");
  });

  it("answers null without a runnable block", () => {
    expect(runnableBlock("```lua\nprint(1)\n```\n")).toBeNull();
    expect(runnableBlock("```js runnable\nx\n```\n")).toBeNull();
  });

  it("does not end a block on a shorter or different fence", () => {
    expect(runnableBlock("````lua runnable\na = [[\n```\n]]\n````\n")).toBe("a = [[\n```\n]]\n");
  });
});

describe("the generated resource", () => {
  it("is named after the package within the name limit", () => {
    expect(exampleName("sg_kit")).toBe("sg_kit_readme");
    const long = "a".repeat(64);
    expect(exampleName(long)).toHaveLength(64);
    expect(exampleName(long).endsWith("_readme")).toBe(true);
  });

  it("declares only the capabilities the code visibly uses", () => {
    expect(exampleCapabilities("print(1)")).toEqual(["events", "logging"]);
    expect(exampleCapabilities('AddEventHandler("playerJoining", f) RegisterCommand("x", f)')).toEqual(["events", "logging", "commands", "players"]);
    expect(exampleCapabilities("ScriptGo.storage.set('a', 1)")).toContain("storage");
  });

  it("has a valid manifest that depends on the package with its version and environments", () => {
    const m = manifest(exampleManifest(KIT, "print(1)\n"));
    expect(m.name).toBe("sg_kit_readme");
    expect(m.version).toBe("1.2.3");
    expect(m.environments).toEqual(["standalone", "open77"]);
    expect(m.dependencies.map((d) => d.name)).toEqual(["sg_kit"]);
    expect(m.serverScripts).toEqual(["server/main.lua"]);
  });

  it("is written from the README, and absent without one", () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-readme-test-"));
    try {
      expect(writeReadmeExample(dir, KIT)).toBeNull();
      writeFileSync(join(dir, "README.md"), "# Kit\n\n```lua runnable\nprint('hi')\n```\n");
      const ex = writeReadmeExample(dir, KIT)!;
      expect(ex.name).toBe("sg_kit_readme");
      expect(readFileSync(join(ex.dir, "server", "main.lua"), "utf8")).toBe("print('hi')\n");
      expect(existsSync(join(ex.dir, "scriptgo.lua"))).toBe(true);
      ex.cleanup();
      expect(existsSync(ex.dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
