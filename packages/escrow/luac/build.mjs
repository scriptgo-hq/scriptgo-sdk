#!/usr/bin/env node
// Builds luac-5.4.8.wasm, the publish-time Lua compiler of client code escrow
// (docs/spec/client-escrow.md, "Bytecode compilation"), from the official Lua 5.4.8 sources.
//
//   node packages/escrow/luac/build.mjs --zig <zig executable> [--work <dir>] [--check]
//
// Inputs, both pinned: lua-5.4.8.tar.gz from lua.org (SHA-256 below, the digest lua.org publishes)
// and Zig 0.15.2 (its bundled clang and wasi-libc). The build is reproducible: the same inputs give
// the same bytes, and `--check` rebuilds and compares with the committed file and its pin
// (luac-5.4.8.wasm.sha256) instead of writing.
//
// Why WebAssembly: the CLI runs on every OS from npm with no native toolchain, and the compiler is
// PUC Lua's own code, so the bytecode is exactly what the target VM loads. Why not the creator's own
// luac: the platform compiles from source with this compiler (never accepts creator bytecode), and a
// release must not depend on how a creator's Lua was built.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LUA = { url: "https://www.lua.org/ftp/lua-5.4.8.tar.gz", sha256: "4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae" };
const ZIG_VERSION = "0.15.2";
const CORE = ["lapi", "lcode", "lctype", "ldebug", "ldo", "ldump", "lfunc", "lgc", "llex", "lmem", "lobject", "lopcodes", "lparser", "lstate", "lstring", "ltable", "ltm", "lundump", "lvm", "lzio"];
const OUT = join(here, "luac-5.4.8.wasm");
const PIN = join(here, "luac-5.4.8.wasm.sha256");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const zig = flag("--zig") ?? process.env.ZIG;
const work = flag("--work") ?? join(tmpdir(), "scriptgo-luac-build");
const check = args.includes("--check");
if (!zig) {
  console.error("usage: node build.mjs --zig <zig executable> [--work <dir>] [--check]");
  process.exit(2);
}
const version = execFileSync(zig, ["version"], { encoding: "utf8" }).trim();
if (version !== ZIG_VERSION) {
  console.error(`zig ${version}: this build is pinned to zig ${ZIG_VERSION} (the bytes depend on its clang and wasi-libc)`);
  process.exit(2);
}

mkdirSync(work, { recursive: true });
const tgz = join(work, "lua-5.4.8.tar.gz");
if (!existsSync(tgz)) {
  const res = await fetch(LUA.url);
  if (!res.ok) throw new Error(`${LUA.url}: HTTP ${res.status}`);
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
}
const got = createHash("sha256").update(readFileSync(tgz)).digest("hex");
if (got !== LUA.sha256) throw new Error(`lua-5.4.8.tar.gz has SHA-256 ${got}, expected ${LUA.sha256}`);
const src = join(work, "lua-5.4.8", "src");
if (!existsSync(join(src, "lparser.c"))) execFileSync("tar", ["-xzf", "lua-5.4.8.tar.gz"], { cwd: work, stdio: "inherit" });
if (!readdirSync(src).includes("lua.h")) throw new Error(`${src}: no lua.h after extraction`);

const target = join(work, "luac-5.4.8.wasm");
const env = { ...process.env, ZIG_GLOBAL_CACHE_DIR: join(work, "zig-cache"), ZIG_LOCAL_CACHE_DIR: join(work, "zig-cache") };
execFileSync(
  zig,
  [
    "cc",
    "-target", "wasm32-wasi",
    "-mexec-model=reactor",
    "-O2",
    "-std=gnu99",
    "-DNDEBUG",
    "-I", join(here, "shim"),
    "-I", src,
    "-include", join(here, "sg_config.h"),
    "-Wl,--strip-all",
    "-o", target,
    join(here, "sg_luac.c"),
    ...CORE.map((c) => join(src, `${c}.c`)),
  ],
  { stdio: "inherit", env, cwd: work },
);
const bytes = readFileSync(target);
const digest = createHash("sha256").update(bytes).digest("hex");
if (check) {
  const committed = existsSync(OUT) ? createHash("sha256").update(readFileSync(OUT)).digest("hex") : "(missing)";
  const pinned = existsSync(PIN) ? readFileSync(PIN, "utf8").trim().split(/\s+/)[0] : "(missing)";
  console.log(`rebuilt ${digest}\ncommitted ${committed}\npinned ${pinned}`);
  process.exit(digest === committed && digest === pinned ? 0 : 1);
}
writeFileSync(OUT, bytes);
writeFileSync(PIN, `${digest}  luac-5.4.8.wasm\n`);
console.log(`luac-5.4.8.wasm: ${bytes.length} bytes, sha256 ${digest}`);
