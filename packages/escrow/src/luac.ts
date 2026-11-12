// The publish-time Lua 5.4.8 compiler of client code escrow (docs/spec/client-escrow.md,
// "Bytecode compilation"): PUC Lua's own parser and code generator built to WebAssembly
// (luac/sg_luac.c, luac/build.mjs), run here with no import and no file system. The source is
// compiled with mode "t": this compiler never reads bytecode, so creator-supplied bytecode can never
// pass through it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The committed module's SHA-256 (luac/luac-5.4.8.wasm.sha256): the loader refuses any other. */
export const LUAC_WASM_SHA256 = "35b70e2f20d701ecaa7b0ce24364e05fc3cad44727a6b852dba0f49846012b20";
/** A source larger than this is refused before it is compiled (OPEN//77 reads scripts up to 4 MiB). */
export const LUAC_MAX_SOURCE_BYTES = 4 * 1024 * 1024;

export type LuacStrip = "none" | "names" | "full" | "stock";
const MODES: Record<LuacStrip, number> = { none: 0, names: 1, full: 2, stock: 3 };

export class LuacError extends Error {
  readonly code: "syntax" | "memory" | "too_large" | "invalid";
  constructor(code: LuacError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface LuacResult {
  /** Lua 5.4.8 bytecode, the standard dump format. */
  bytecode: Buffer;
  /** `full` only: the source line of each position (index = position - 1). */
  positions: number[] | null;
}

let compiled: WebAssembly.Module | null = null;

/**
 * Where the module is read from: `../luac/` next to this file (the sources, and the package's dist/),
 * `./luac/` next to a bundle that inlined this file (the CLI's dist/scriptgo.mjs), or SCRIPTGO_LUAC_WASM.
 */
function wasmPath(): string {
  if (process.env.SCRIPTGO_LUAC_WASM) return process.env.SCRIPTGO_LUAC_WASM;
  const candidates = ["../luac/luac-5.4.8.wasm", "./luac/luac-5.4.8.wasm"].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

function module(): WebAssembly.Module {
  if (compiled) return compiled;
  const bytes = readFileSync(wasmPath());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== LUAC_WASM_SHA256) throw new LuacError("invalid", `luac-5.4.8.wasm has SHA-256 ${digest}, expected ${LUAC_WASM_SHA256}`);
  compiled = new WebAssembly.Module(bytes);
  return compiled;
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  sg_alloc(n: number): number;
  sg_compile(src: number, srcLen: number, name: number, nameLen: number, dump: number, dumpLen: number, mode: number): number;
  sg_out_ptr(): number;
  sg_out_len(): number;
  sg_map_ptr(): number;
  sg_map_len(): number;
  sg_error_ptr(): number;
  sg_error_len(): number;
}

/**
 * Compiles one Lua chunk. `chunkName` follows Lua's rules (`=name` or `@file`); `dumpSource` is the
 * main function's recorded source under `full` (the chunk name a runtime error shows). A fresh
 * instance per call: a Lua error traps the instance, which is then dropped.
 */
export function compileLua(source: string | Uint8Array, opts: { chunkName: string; strip: LuacStrip; dumpSource?: string }): LuacResult {
  const src = typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  if (src.length > LUAC_MAX_SOURCE_BYTES) throw new LuacError("too_large", `the source is ${src.length} bytes; at most ${LUAC_MAX_SOURCE_BYTES}`);
  if (src.length >= 4 && src[0] === 0x1b && src.subarray(1, 4).toString("latin1") === "Lua") throw new LuacError("invalid", "precompiled bytecode is never accepted: publish the source");
  const name = Buffer.from(opts.chunkName, "utf8");
  const dump = Buffer.from(opts.dumpSource ?? "", "utf8");
  if (name.includes(0) || dump.includes(0)) throw new LuacError("invalid", "a chunk name cannot hold a NUL byte");
  const instance = new WebAssembly.Instance(module(), {});
  const x = instance.exports as unknown as Exports;
  x._initialize();
  const put = (b: Buffer): number => {
    const p = x.sg_alloc(b.length);
    new Uint8Array(x.memory.buffer, p, b.length).set(b);
    return p;
  };
  const ps = put(src);
  const pn = put(name);
  const pd = put(dump);
  let status: number;
  try {
    status = x.sg_compile(ps, src.length, pn, name.length, pd, dump.length, MODES[opts.strip]);
  } catch (e) {
    if (!(e instanceof WebAssembly.RuntimeError)) throw e;
    const message = Buffer.from(new Uint8Array(x.memory.buffer, x.sg_error_ptr(), x.sg_error_len())).toString("utf8");
    throw new LuacError(message === "not enough memory" ? "memory" : "syntax", message || "the compiler stopped");
  }
  if (status !== 0) throw new LuacError(status === 4 ? "memory" : "syntax", `the compiler answered status ${status}`);
  const bytecode = Buffer.from(new Uint8Array(x.memory.buffer, x.sg_out_ptr(), x.sg_out_len()));
  let positions: number[] | null = null;
  if (opts.strip === "full") {
    const n = x.sg_map_len();
    const view = new Int32Array(x.memory.buffer, x.sg_map_ptr(), n);
    positions = Array.from(view);
  }
  return { bytecode, positions };
}

/** The 31-byte LUAC header the compiler writes ("\x1bLua", version, format, LUAC_DATA, sizes, check values). */
export const LUAC_HEADER_BYTES = 31;

/** The header of a dump, hex: what a bytecode target pins. */
export function luacHeaderOf(bytecode: Uint8Array): string {
  if (bytecode.length < LUAC_HEADER_BYTES) throw new LuacError("invalid", "shorter than a LUAC header");
  return Buffer.from(bytecode.buffer, bytecode.byteOffset, LUAC_HEADER_BYTES).toString("hex");
}
