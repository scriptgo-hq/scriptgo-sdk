import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildFingerprinted,
  CLIENT_ESCROW_ENTRY,
  ClientContainerReader,
  clientChunkName,
  clientEscrowCopy,
  clientKeyId,
  clientServerAad,
  clientSessionAad,
  compileClientScript,
  compileLua,
  deriveAssetContentKey,
  deriveClientContentKey,
  ed25519FromSeed,
  findFingerprints,
  generateX25519KeyPair,
  LUA_548_TARGET,
  luacHeaderOf,
  readClientContainer,
  readZip,
  readZipEntry,
  resolveClientMessage,
  resolveClientPosition,
  sealClientContainer,
  unwrapClientKeyInSession,
  unwrapContentKey,
  wrapClientKeyForSession,
  wrapContentKey,
  clientLineMap,
  LuacError,
} from "../src/index.ts";
import { zipSync } from "fflate";

const here = fileURLToPath(new URL(".", import.meta.url));
/** The test matrix's PUC Lua 5.4.8 (tools/build-lua.ps1), when built on this machine. */
const LUA54 = [join(here, "../../../tools/runtimes/bin/lua54.exe"), join(here, "../../../tools/runtimes/bin/lua54")].find((p) => existsSync(p));
const itLua = LUA54 ? it : it.skip;

const SOURCE = `-- client script
local SECRET_MARKER = "sgce-distinctive-constant-7f3a"
local function greet(who)
  local msg = "hello " .. who
  return msg
end

local t = {}
for i = 1, 3 do
  t[#t + 1] = greet(tostring(i))
end

local function fail(x)
  return x.field.missing
end

return { greeting = table.concat(t, ","), marker = SECRET_MARKER, fail = fail }
`;

/** Runs a Lua snippet with the test matrix's lua54 and returns stdout. */
function runLua(script: string, files: Record<string, Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "sgce-lua-"));
  try {
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
    writeFileSync(join(dir, "main.lua"), script);
    return execFileSync(LUA54!, ["main.lua"], { cwd: dir, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const READ_CHUNK = `local function read(n) local f = assert(io.open(n, "rb")) local d = f:read("a") f:close() return d end\n`;

describe("the publish-time compiler", () => {
  it("writes the Lua 5.4.8 header OPEN//77's VM checks", () => {
    const r = compileLua("return 1", { chunkName: "=x", strip: "names" });
    expect(luacHeaderOf(r.bytecode)).toBe(LUA_548_TARGET.luacHeader);
  });

  it("refuses precompiled bytecode as input", () => {
    const bc = compileLua("return 1", { chunkName: "=x", strip: "names" }).bytecode;
    expect(() => compileLua(bc, { chunkName: "=x", strip: "full" })).toThrow(/never accepted/);
  });

  it("reports a syntax error with its line", () => {
    try {
      compileLua("local a = 1\nlocal = 2\n", { chunkName: "=client/main.lua", strip: "full" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LuacError);
      expect((e as Error).message).toMatch(/client\/main\.lua:2:/);
    }
  });

  it("is deterministic", () => {
    const a = compileClientScript(SOURCE, { package: "c//pkg", version: "1.0.0", path: "client/main.lua", strip: "full" });
    const b = compileClientScript(SOURCE, { package: "c//pkg", version: "1.0.0", path: "client/main.lua", strip: "full" });
    expect(a.bytecode.equals(b.bytecode)).toBe(true);
    expect(a.lines).toEqual(b.lines);
  });

  it("full strip keeps no source text, local names or line numbers; names strip keeps lines only", () => {
    const full = compileClientScript(SOURCE, { package: "c//pkg", version: "1.0.0", path: "client/main.lua", strip: "full" });
    const names = compileClientScript(SOURCE, { package: "c//pkg", version: "1.0.0", path: "client/main.lua", strip: "names" });
    for (const bc of [full.bytecode, names.bytecode]) {
      const text = bc.toString("latin1");
      expect(text).not.toContain("SECRET_MARKER"); // a local name
      expect(text).not.toContain("msg");
      expect(text).not.toContain("-- client script"); // a comment
      expect(text).toContain("sgce-distinctive-constant-7f3a"); // string constants stay (in the encrypted chunk)
      expect(text).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//); // no local path
    }
    expect(full.bytecode.toString("latin1")).toContain("pkg@1.0.0/client/main.lua:pos");
    expect(full.lines!.length).toBeGreaterThan(10);
    expect(Math.max(...full.lines!)).toBe(17);
    expect(names.lines).toBeNull();
  });

  itLua("matches stock luac's string.dump(f, true) byte for byte", () => {
    const sources = [SOURCE, "local a, b = 1, 2.5\nreturn a + b, 'x' .. a, {1, 2, n = 3}", "local t = setmetatable({}, {__index = function(_, k) return k * 2 end})\nreturn t[21]"];
    for (const src of sources) {
      const ours = compileLua(src, { chunkName: "=stock", strip: "stock" }).bytecode;
      const stock = runLua(`local f = assert(load(${JSON.stringify(src).replace(/\\n/g, "\\n")}, "=stock", "t"))\nlocal d = string.dump(f, true)\nio.write((d:gsub(".", function(c) return string.format("%02x", c:byte()) end)))`, {});
      expect(ours.toString("hex")).toBe(stock);
    }
  });

  itLua("runs in PUC Lua 5.4.8, and a runtime error carries a position the line map resolves", () => {
    for (const strip of ["full", "names"] as const) {
      const c = compileClientScript(SOURCE, { package: "creator//pkg", version: "1.2.0", path: "client/main.lua", strip });
      const out = runLua(
        `${READ_CHUNK}local f = assert(load(read("chunk.bin"), "ignored", "b"))\nlocal m = f()\nprint(m.greeting, m.marker)\nlocal ok, err = pcall(m.fail, {field = {}})\nprint(ok, err)\nprint(pcall(m.fail, {}))`,
        { "chunk.bin": c.bytecode },
      );
      const lines = out.trim().split(/\r?\n/);
      expect(lines[0]).toBe("hello 1,hello 2,hello 3\tsgce-distinctive-constant-7f3a");
      expect(lines[1]).toBe("true\tnil");
      if (strip === "names") {
        expect(lines[2]).toMatch(/^false\tpkg@1\.2\.0\/client\/main\.lua:14: attempt to index a nil value \(field 'field'\)$/);
      } else {
        const m = /^false\tpkg@1\.2\.0\/client\/main\.lua:pos:(\d+): attempt to index a nil value \(field 'field'\)$/.exec(lines[2]!);
        expect(m).not.toBeNull();
        const map = clientLineMap("creator//pkg", "1.2.0", "full", [c]);
        expect(resolveClientPosition(map, "client/main.lua", Number(m![1]))).toBe(14);
        expect(resolveClientMessage(map, lines[2]!)).toBe("false\tclient/main.lua:14: attempt to index a nil value (field 'field')");
      }
    }
  });

  it("keeps the end of a chunk name too long for Lua's message buffer", () => {
    const name = clientChunkName("creator//a-rather-long-package-name", "10.20.30", "client/some/deep/folder/script.lua", "full");
    expect(Buffer.byteLength(name) - 1).toBeLessThanOrEqual(59);
    expect(name.startsWith("=...")).toBe(true);
    expect(name.endsWith("folder/script.lua:pos")).toBe(true);
  });
});

const signerSeed = Buffer.alloc(32, 7);
const signer = ed25519FromSeed(signerSeed).publicKey.toString("base64url");
const releaseSecret = Buffer.alloc(32, 3);

function sealed(opts: { deployment?: string; strip?: "full" | "names" } = {}) {
  const deployment = opts.deployment ?? "dep_1";
  const strip = opts.strip ?? "full";
  const key = deriveClientContentKey(releaseSecret, deployment);
  const a = compileClientScript(SOURCE, { package: "c//pkg", version: "1.0.0", path: "client/main.lua", strip });
  const b = compileClientScript("return 42", { package: "c//pkg", version: "1.0.0", path: "client/b.lua", strip });
  const container = sealClientContainer({
    chunks: new Map([[a.path, a.bytecode], [b.path, b.bytecode]]),
    package: "c//pkg", version: "1.0.0", release: "rel_1", deployment, contentKey: key, signerSeed, strip, fingerprint: "fp_1",
  });
  return { key, container, a, b };
}

describe("the SGCE container", () => {
  it("opens with the deployment key and gives back the exact bytecode", () => {
    const { key, container, a, b } = sealed();
    const r = new ClientContainerReader(container, key, { trustedSigner: signer });
    expect(r.paths()).toEqual(["client/b.lua", "client/main.lua"]);
    expect(r.bytecode("client/main.lua").equals(a.bytecode)).toBe(true);
    expect(r.bytecode("client/b.lua").equals(b.bytecode)).toBe(true);
    expect(r.header.keyId).toBe(clientKeyId(key));
    expect(r.header.permGeneration).toBe(0);
    r.close();
    expect(() => r.bytecode("client/b.lua")).toThrow(/closed/);
  });

  it("keeps the source's distinctive constant out of the ciphertext", () => {
    const { container } = sealed();
    expect(container.toString("latin1")).not.toContain("sgce-distinctive-constant-7f3a");
  });

  it("a key from another deployment, or the asset key, does not open it", () => {
    const { container } = sealed();
    expect(() => new ClientContainerReader(container, deriveClientContentKey(releaseSecret, "dep_2"), { trustedSigner: signer })).toThrow(/not this container's key/);
    expect(() => new ClientContainerReader(container, deriveAssetContentKey(releaseSecret, "dep_1"), { trustedSigner: signer })).toThrow(/not this container's key/);
  });

  it("needs a pinned signer to decrypt, and refuses a container re-signed by another key", () => {
    const { key, container, a } = sealed();
    expect(() => new ClientContainerReader(container, key, {} as { trustedSigner: string })).toThrow(/pinned signer is required/);
    expect(() => new ClientContainerReader(container, key, { trustedSigner: "" })).toThrow(/pinned signer is required/);
    // Whoever holds the content key (a game server does) can seal bytecode of its choice and sign it with
    // its own key: it verifies under the key its header names, and only the pin refuses it.
    const forged = sealClientContainer({ chunks: new Map([[a.path, a.bytecode]]), package: "c//pkg", version: "1.0.0", release: "rel_1", deployment: "dep_1", contentKey: key, signerSeed: Buffer.alloc(32, 0x42), strip: "full" });
    expect(readClientContainer(forged).header.signerPublicKey).not.toBe(signer);
    expect(() => new ClientContainerReader(forged, key, { trustedSigner: signer })).toThrow(/pinned/);
  });

  it("signs a hash of each chunk's ciphertext, never of its bytecode", () => {
    const { container, a, b } = sealed();
    const header = readClientContainer(container).header;
    for (const c of header.chunks) {
      expect(c.sha256).toBeUndefined();
      expect(c.ciphertextSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const text = container.toString("latin1");
    for (const bytecode of [a.bytecode, b.bytecode]) expect(text).not.toContain(createHash("sha256").update(bytecode).digest("hex"));
  });

  it("refuses a flipped ciphertext byte, a forged header and an unpinned signer", () => {
    const { key, container } = sealed();
    const bad = Buffer.from(container);
    bad[bad.length - 5]! ^= 1;
    // The signed ciphertext hash refuses it before any key is used ...
    expect(() => readClientContainer(bad)).toThrow(/ciphertext hash mismatch/);
    expect(() => new ClientContainerReader(bad, key, { trustedSigner: signer })).toThrow(/ciphertext hash mismatch/);
    // ... and a legacy container (plaintext sha256) still fails on the AEAD tag.
    const legacy = sealClientContainer({ chunks: new Map([["client/x.lua", compileClientScript("return 1", { package: "c//pkg", version: "1.0.0", path: "client/x.lua", strip: "full" }).bytecode]]), package: "c//pkg", version: "1.0.0", release: "rel_1", deployment: "dep_1", contentKey: key, signerSeed, strip: "full", legacyPlaintextSha256: true });
    const badLegacy = Buffer.from(legacy);
    badLegacy[badLegacy.length - 5]! ^= 1;
    const r = new ClientContainerReader(badLegacy, key, { trustedSigner: signer });
    expect(() => r.bytecode("client/x.lua")).toThrow(/does not authenticate/);
    const view = readClientContainer(container);
    const forged = Buffer.from(container.toString("latin1").replace('"strip":"full"', '"strip":"name"'), "latin1");
    expect(() => readClientContainer(forged)).toThrow();
    expect(() => readClientContainer(container, { trustedSigner: "AAAA" })).toThrow(/pinned/);
    expect(view.header.target).toEqual(LUA_548_TARGET);
  });

  it("refuses another opcode generation and another bytecode target", () => {
    const { key } = sealed();
    const a = compileClientScript("return 1", { package: "c//pkg", version: "1.0.0", path: "x.lua", strip: "full" });
    const other = { lua: "5.4.8-x", luacHeader: LUA_548_TARGET.luacHeader.replace(/^1b4c756154/, "1b4c756153") };
    expect(() => sealClientContainer({ chunks: new Map([["x.lua", a.bytecode]]), package: "c//pkg", version: "1.0.0", release: "r", deployment: "dep_1", contentKey: key, signerSeed, strip: "full", target: other })).toThrow(/declared target/);
    const c = sealed().container;
    expect(() => new ClientContainerReader(c, key, { trustedSigner: signer, target: other })).toThrow(/another Lua VM/);
  });

  it("refuses unsafe paths", () => {
    const { key } = sealed();
    const a = compileClientScript("return 1", { package: "c//pkg", version: "1.0.0", path: "x.lua", strip: "full" });
    for (const p of ["../x.lua", "/x.lua", "a\\b.lua", "c:x.lua", "a//b.lua"]) {
      expect(() => sealClientContainer({ chunks: new Map([[p, a.bytecode]]), package: "c//pkg", version: "1.0.0", release: "r", deployment: "dep_1", contentKey: key, signerSeed, strip: "full" })).toThrow(/unsafe/);
    }
  });

  it("is deterministic for one deployment and differs per deployment", () => {
    expect(sealed().container.equals(sealed().container)).toBe(true);
    expect(sealed().container.equals(sealed({ deployment: "dep_2" }).container)).toBe(false);
  });
});

describe("the key flow", () => {
  it("API → server → session → container", () => {
    const { key, container } = sealed();
    const server = generateX25519KeyPair();
    const serverAad = clientServerAad("c//pkg", "1.0.0", "dep_1");
    const toServer = wrapContentKey(key, server.publicKey, serverAad);
    const onServer = unwrapContentKey(toServer, server.privateKey, server.publicKey, serverAad);
    const session = generateX25519KeyPair();
    const sessionAad = clientSessionAad("c//pkg", "1.0.0", clientKeyId(onServer));
    const toSession = wrapClientKeyForSession(onServer, session.publicKey, sessionAad);
    const inSession = unwrapClientKeyInSession(toSession, session.privateKey, session.publicKey, sessionAad);
    expect(new ClientContainerReader(container, inSession, { trustedSigner: signer }).paths().length).toBe(2);
    // A session wrap is not a server wrap (labels differ), and the aad binds the key id.
    expect(() => unwrapContentKey(toSession, session.privateKey, session.publicKey, sessionAad)).toThrow();
    expect(() => unwrapClientKeyInSession(toSession, session.privateKey, session.publicKey, clientSessionAad("c//pkg", "1.0.1", clientKeyId(onServer)))).toThrow();
  });
});

describe("the per-buyer copy", () => {
  const release = Buffer.from(zipSync({
    "res/open77.lua": Buffer.from('client_scripts { "client/main.lua" }\n'),
    "res/client/main.lua": Buffer.from(SOURCE),
    "res/client/b.lua": Buffer.from("return 42"),
    "res/server/main.lua": Buffer.from("print('server')"),
  }, { level: 6 }));
  const identity = { licence: "lic_1", release: "rel_1", package: "c//pkg", version: "1.0.0", deployment: "dep_1" };
  const secret = Buffer.alloc(32, 9);

  function build(legacyPlaintextSha256?: boolean) {
    let lines: ReturnType<typeof clientEscrowCopy>["lines"] | null = null;
    const out = buildFingerprinted({
      zip: release, root: "res/", containers: [], identity, secret, signerSeed,
      clientEscrow: ({ marker, read }) => {
        const copy = clientEscrowCopy({ read, root: "res/", scripts: ["client/main.lua", "client/b.lua"], package: "c//pkg", version: "1.0.0", release: "rel_1", deployment: "dep_1", contentKey: deriveClientContentKey(releaseSecret, "dep_1"), signerSeed, strip: "full", fingerprint: marker, legacyPlaintextSha256 });
        lines = copy.lines;
        return copy;
      },
    });
    return { out, lines: lines! };
  }

  it("replaces client scripts with stubs, appends the container, keeps the rest and the fingerprint", () => {
    const { out, lines } = build();
    const zip = readZip(out.zip);
    expect(zip.entries.map((e) => e.name)).toEqual(["res/open77.lua", "res/client/main.lua", "res/client/b.lua", "res/server/main.lua", `res/${CLIENT_ESCROW_ENTRY}`, "res/.scriptgo/fingerprint.json"]);
    const entry = (n: string) => readZipEntry(out.zip, zip.entries.find((e) => e.name === n)!);
    expect(entry("res/client/main.lua").toString()).toMatch(/^-- SCRIPT\/\/GO client code escrow/);
    expect(entry("res/server/main.lua").toString()).toBe("print('server')");
    expect(out.zip.toString("latin1")).not.toContain("sgce-distinctive-constant-7f3a");
    const container = entry(`res/${CLIENT_ESCROW_ENTRY}`);
    const r = new ClientContainerReader(container, deriveClientContentKey(releaseSecret, "dep_1"), { trustedSigner: signer });
    expect(r.header.fingerprint).toBe(out.marker);
    expect(out.clientEscrow?.sha256).toBe(createHash("sha256").update(container).digest("hex"));
    expect(findFingerprints(out.zip, signer).every((f) => f.ok)).toBe(true);
    expect(Object.keys(lines.chunks)).toEqual(["client/b.lua", "client/main.lua"]);
    expect(build().out.sha256).toBe(out.sha256);
  });

  it("writes the ciphertext hash by default and the legacy plaintext hash only when asked", () => {
    const chunksOf = (zipBytes: Buffer) => {
      const zip = readZip(zipBytes);
      const container = readZipEntry(zipBytes, zip.entries.find((e) => e.name === `res/${CLIENT_ESCROW_ENTRY}`)!);
      return readClientContainer(container).header.chunks;
    };
    const current = chunksOf(build().out.zip);
    expect(current.every((c) => typeof c.ciphertextSha256 === "string" && c.sha256 === undefined)).toBe(true);
    const legacy = chunksOf(build(true).out.zip);
    expect(legacy.every((c) => typeof c.sha256 === "string" && c.ciphertextSha256 === undefined)).toBe(true);
  });

  it("refuses an escrowed client script missing from the release", () => {
    expect(() => buildFingerprinted({
      zip: release, root: "res/", containers: [], identity, secret, signerSeed,
      clientEscrow: ({ marker, read }) => clientEscrowCopy({ read, root: "res/", scripts: ["client/none.lua"], package: "c//pkg", version: "1.0.0", release: "rel_1", deployment: "dep_1", contentKey: randomBytes(32), signerSeed, strip: "full", fingerprint: marker }),
    })).toThrow(/not in the release archive/);
  });
});

describe("the committed compiler", () => {
  it("matches its pin", () => {
    const wasm = readFileSync(join(here, "../luac/luac-5.4.8.wasm"));
    const pin = readFileSync(join(here, "../luac/luac-5.4.8.wasm.sha256"), "utf8").split(/\s+/)[0];
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(pin);
  });
});

describe("the client-escrow vectors", () => {
  const committed = () => JSON.parse(readFileSync(join(here, "vectors", "client-vectors.json"), "utf8")) as Record<string, any>;

  it("are reproduced exactly (regenerate with node packages/escrow/tools/gen-client-vectors.ts)", async () => {
    const { clientVectors } = await import("./vectors/client-build.ts");
    expect(JSON.parse(JSON.stringify(clientVectors()))).toEqual(committed());
  });

  it("open with the session key and refuse the foreign, lying and permuted containers", () => {
    const v = committed();
    const session = { privateKey: Buffer.from(v.session.privateKey, "base64url"), publicKey: Buffer.from(v.session.publicKey, "base64url") };
    const key = unwrapClientKeyInSession(v.session.wrapped, session.privateKey, session.publicKey, Buffer.from(v.session.aad));
    const r = new ClientContainerReader(Buffer.from(v.containerBase64, "base64"), key, { trustedSigner: v.signerPublicKey });
    for (const c of v.chunks) expect(createHash("sha256").update(r.bytecode(c.path)).digest("hex")).toBe(c.sha256);
    // The container as pre-0.1.12 writers sealed it (plaintext sha256 per chunk) still reads.
    const legacy = new ClientContainerReader(Buffer.from(v.legacyContainerBase64, "base64"), key, { trustedSigner: v.signerPublicKey });
    for (const c of v.chunks) expect(createHash("sha256").update(legacy.bytecode(c.path)).digest("hex")).toBe(c.sha256);
    const pinned = { trustedSigner: v.signerPublicKey as string };
    expect(() => new ClientContainerReader(Buffer.from(v.foreignTargetBase64, "base64"), key, pinned)).toThrow(/another Lua VM/);
    const lying = new ClientContainerReader(Buffer.from(v.lyingBase64, "base64"), key, pinned);
    expect(() => lying.bytecode("client/main.lua")).toThrow(/differs from the target/);
    expect(() => readClientContainer(Buffer.from(v.permutedBase64, "base64"))).toThrow(/generation 1/);
    const other = unwrapClientKeyInSession(v.session.otherWrapped, session.privateKey, session.publicKey, Buffer.from(v.session.aad));
    expect(() => new ClientContainerReader(Buffer.from(v.containerBase64, "base64"), other, pinned)).toThrow(/not this container's key/);
  });
});
