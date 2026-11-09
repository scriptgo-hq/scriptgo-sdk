// Generates packages/types/index.d.ts (TypeScript declarations for resources written in TypeScript
// or JavaScript) from the language-neutral runtime contract, docs/spec/runtime-idl.json. The
// format of that file is described in docs/spec/runtime-idl.md.
//
//   node tools/gen-types.mjs [--check]
//
// --check exits 1 when the committed declarations are out of date (for CI).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const idlPath = join(root, "docs", "spec", "runtime-idl.json");
const out = join(root, "packages", "types", "index.d.ts");

const idl = JSON.parse(readFileSync(idlPath, "utf8"));
if (idl.idl !== 1) throw new Error(`runtime-idl.json: unsupported idl version ${idl.idl}`);
const types = idl.types;

// Members without a languages list exist in every language; others only where listed.
const forJs = (x) => !x.languages || x.languages.includes("js");

const PRIMITIVES = new Set(["value", "any", "nil", "boolean", "integer", "number", "string", "table"]);

function pascal(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function typeName(name) {
  if (!types[name]) throw new Error(`runtime-idl.json: unknown type '${name}'`);
  return "ScriptGo" + name;
}

/** Splits a type expression on top-level '|' (outside <...>). */
function splitUnion(expr) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "<") depth++;
    if (ch === ">") depth--;
    if (ch === "|" && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

/**
 * A type expression in TypeScript. dir "in": a value the resource gives the runtime (codec values
 * are `unknown`, the codec checks them); dir "out": a value the runtime gives the resource (`any`).
 */
function ts(expr, dir) {
  const union = splitUnion(expr);
  if (union.length > 1) return union.map((p) => ts(p, dir)).join(" | ");
  if (expr.endsWith("?")) return `${ts(expr.slice(0, -1), dir)} | undefined`;
  if (expr.endsWith("[]")) {
    const inner = ts(expr.slice(0, -2), dir);
    return /[ |]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
  }
  let m = /^map<(.+)>$/.exec(expr);
  if (m) return `Record<string, ${ts(m[1], dir)}>`;
  m = /^promise<(.+)>$/.exec(expr);
  if (m) return `Promise<${m[1] === "nil" ? "void" : ts(m[1], "out")}>`;
  switch (expr) {
    case "value":
    case "any":
      return dir === "in" ? "unknown" : "any";
    case "nil":
      return "undefined";
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    case "table":
      return "SgTable";
  }
  if (PRIMITIVES.has(expr)) throw new Error(`unmapped primitive ${expr}`);
  return typeName(expr);
}

function params(list, dir) {
  return (list ?? [])
    .map((p) => {
      if (p.type.endsWith("...")) return `...${p.name}: ${arrayOf(ts(p.type.slice(0, -3), dir))}`;
      if (p.type.endsWith("?") && !p.type.includes("|")) return `${p.name}?: ${ts(p.type.slice(0, -1), dir)}`;
      return `${p.name}: ${ts(p.type, dir)}`;
    })
    .join(", ");
}

function arrayOf(t) {
  return /[ |]/.test(t) ? `(${t})[]` : `${t}[]`;
}

/** The JavaScript result: the js binding's returns when it has some, else the contract's. */
function result(member) {
  const list = member.js?.returns ?? member.returns ?? [];
  if (list.length === 0) return "void";
  if (list.length > 1) throw new Error(`${member.name}: several results need a js.returns binding`);
  const r = list[0];
  // A variadic result reaches JavaScript as its first value.
  return ts(r.endsWith("...") ? r.slice(0, -3) : r, "out");
}

function jsdoc(lines, indent) {
  const text = lines.filter((l) => l !== undefined && l !== null && l !== "");
  if (text.length === 0) return [];
  if (text.length === 1 && !text[0].includes("\n")) return [`${indent}/** ${text[0]} */`];
  return [`${indent}/**`, ...text.flatMap((l) => l.split("\n")).map((l) => `${indent} * ${l}`.trimEnd()), `${indent} */`];
}

// A member's doc: its own text, the JavaScript binding's note, the facts it does not share with its
// namespace (whose own doc already says them), and the failure tokens.
function memberDoc(member) {
  const lines = [member.doc];
  if (member.js?.doc) lines.push(`JavaScript: ${member.js.doc}`);
  const facts = [];
  if (member.capability) facts.push(`Capability: ${member.capability}.`);
  if (member.sides) facts.push(`Side: ${member.sides.join(", ")}.`);
  if (member.kits) facts.push(`Kits: ${member.kits.join(", ")}.`);
  if (facts.length) lines.push(facts.join(" "));
  if (member.errors?.length) {
    const how = member.js?.failure === "reject" ? "Rejects with" : "Throws";
    lines.push(`@throws {ScriptGoError} ${how} a ScriptGoError: ${member.errors.join(", ")}.`);
  }
  return lines;
}

const lines = [];
const emit = (...l) => lines.push(...l);

emit(
  `// Generated by tools/gen-types.mjs from docs/spec/runtime-idl.json (idl ${idl.idl}, runtime ${idl.runtime}). Do not edit.`,
  "//",
  "// Globals for SCRIPT//GO resources written in TypeScript or JavaScript. Use them with",
  '// "lib": ["ES2022"] and "types": ["@scriptgo/types"], without the DOM or Node typings: the runtime',
  "// has neither, and Node's own `exports` global would clash with this one.",
  "",
  ...(idl.languages.js.typescriptPreamble ?? []),
  "",
  "/** A value the codec copies between resources and languages (docs/spec/multi-language.md). */",
  "type SgValue = undefined | null | boolean | number | string | SgValue[] | { [key: string]: SgValue };",
  "/** A table: an array or a plain object. */",
  "type SgTable = { [key: string]: any } | any[];",
  "",
);

// Named types ----------------------------------------------------------------------------------
for (const [name, t] of Object.entries(types)) {
  if (t.kind === "primitive" || !forJs(t)) continue;
  const n = typeName(name);
  const doc = jsdoc([t.doc], "");
  switch (t.kind) {
    case "alias":
      emit(...doc, `type ${n} = ${ts(t.type, "out")};`);
      break;
    case "enum":
      emit(...doc, `type ${n} = ${t.values.map((v) => JSON.stringify(v)).join(" | ")};`);
      break;
    case "record": {
      emit(...doc, `interface ${n} {`);
      for (const f of t.fields) {
        emit(...jsdoc([f.doc], "  "));
        const optional = f.type.endsWith("?");
        emit(`  ${f.name}${optional ? "?" : ""}: ${ts(optional ? f.type.slice(0, -1) : f.type, "out")};`);
      }
      if (t.open) emit("  [key: string]: any;");
      emit("}");
      break;
    }
    case "callback":
      emit(...doc, `type ${n} = (${params(t.params, "out")}) => unknown;`);
      break;
    case "opaque":
      emit(...doc, `interface ${n} {`, `  readonly __scriptgo: ${JSON.stringify(name)};`, "}");
      break;
    default:
      throw new Error(`type ${name}: unknown kind ${t.kind}`);
  }
  emit("");
}

// Host events ----------------------------------------------------------------------------------
emit("/** Events the host emits, with their arguments (AddEventHandler infers the handler's parameters). */", "interface ScriptGoHostEvents {");
for (const e of idl.events) {
  const notes = [e.doc, `Side: ${e.side}.${e.source ? " source is the player." : ""}`].filter(Boolean);
  emit(...jsdoc([notes.join(" ")], "  "), `  ${e.name}: (${params(e.params, "out")}) => unknown;`);
}
emit("}", "");

// Globals --------------------------------------------------------------------------------------
const globalsByName = new Map(idl.globals.map((g) => [g.name, g]));
for (const g of idl.globals) {
  if (!forJs(g)) continue;
  // Declarations the binding needs come first; the doc comment belongs to the declaration itself.
  if (g.js?.declarations) emit(...g.js.declarations);
  emit(...jsdoc(memberDoc(g), ""));
  if (g.js?.signature) {
    emit(g.js.signature, "");
    continue;
  }
  switch (g.kind) {
    case "function":
      if (g.name === "AddEventHandler") {
        emit(`declare function ${g.name}<K extends keyof ScriptGoHostEvents>(name: K, fn: ScriptGoHostEvents[K]): ${result(g)};`);
      }
      emit(`declare function ${g.name}(${params(g.params, "in")}): ${result(g)};`, "");
      break;
    case "value":
      emit(`declare var ${g.name}: ${ts(g.type, "out")};`, "");
      break;
    case "class": {
      const inherited = new Set(g.extends === "Error" ? ["name", "message", "stack"] : []);
      emit(`declare class ${g.name}${g.extends ? ` extends ${g.extends}` : ""} {`);
      emit(`  constructor(${params(g.params, "in")});`);
      for (const f of g.fields ?? []) {
        if (inherited.has(f.name)) continue;
        const optional = f.type.endsWith("?");
        emit(...jsdoc([f.doc], "  "), `  ${f.name}${optional ? "?" : ""}: ${ts(optional ? f.type.slice(0, -1) : f.type, "out")};`);
      }
      emit("}", "");
      break;
    }
    default:
      throw new Error(`global ${g.name}: kind ${g.kind} needs a js.signature`);
  }
}

// The ScriptGo namespace ------------------------------------------------------------------------
const interfaceName = (path) => (path === "ScriptGo" ? "ScriptGoNamespace" : `ScriptGo${pascal(path.split(".").pop())}Namespace`);
const children = idl.namespaces.filter((ns) => ns.name !== "ScriptGo" && forJs(ns));

for (const ns of [...children, ...idl.namespaces.filter((n) => n.name === "ScriptGo")]) {
  const nsDoc = [ns.doc];
  if (ns.capability) {
    nsDoc.push(`Capability: ${ns.capability}. Reading a member throws ScriptGoError capability_unavailable:${ns.capability}@<environment> when the host lacks it.`);
  }
  if (ns.sides) nsDoc.push(`Side: ${ns.sides.join(", ")}.`);
  if (ns.kits) nsDoc.push(`Kits: ${ns.kits.join(", ")}.`);
  const header = jsdoc([ns.name + (ns.doc ? `: ${ns.doc}` : ""), ...nsDoc.slice(1)], "");
  if (ns.js?.type) {
    // The binding gives the whole type (the members only document the calls).
    const errors = [...new Set(ns.members.flatMap((m) => m.errors ?? []))];
    const doc = jsdoc([ns.name + (ns.doc ? `: ${ns.doc}` : ""), ...nsDoc.slice(1), ...ns.members.map((m) => m.js?.doc && `JavaScript: ${m.js.doc}`),
      errors.length ? `@throws {ScriptGoError} Throws a ScriptGoError: ${errors.join(", ")}.` : ""], "");
    emit(...doc, `type ${interfaceName(ns.name)} = ${ns.js.type};`, "");
    continue;
  }
  emit(...header, `interface ${interfaceName(ns.name)} {`);
  for (const m of ns.members) {
    if (!forJs(m)) continue;
    if (m.js?.signature) {
      emit(...jsdoc(memberDoc(m), "  "), `  ${m.js.signature}`);
      continue;
    }
    switch (m.kind) {
      case "function":
        emit(...jsdoc(memberDoc(m), "  "), `  ${m.name}(${params(m.params, "in")}): ${result(m)};`);
        break;
      case "alias": {
        if (!globalsByName.has(m.of)) throw new Error(`${ns.name}.${m.name}: unknown global ${m.of}`);
        emit(`  /** Alias of ${m.of}. */`, `  readonly ${m.name}: typeof ${m.of};`);
        break;
      }
      case "value":
        emit(...jsdoc(memberDoc(m), "  "), `  readonly ${m.name}: ${ts(m.type, "out")};`);
        break;
      default:
        throw new Error(`${ns.name}.${m.name}: kind ${m.kind} needs a js.signature`);
    }
  }
  if (ns.name === "ScriptGo") {
    for (const child of children) {
      const key = child.name.slice("ScriptGo.".length);
      if (key.includes(".")) throw new Error(`${child.name}: nested namespaces are not supported`);
      emit(`  readonly ${key}: ${interfaceName(child.name)};`);
    }
  }
  emit("}", "");
}
emit("/** The SCRIPT//GO namespace. */", "declare const ScriptGo: ScriptGoNamespace;");

const text = lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";

if (process.argv.includes("--check")) {
  const current = existsSync(out) ? readFileSync(out, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== text) {
    console.error("packages/types/index.d.ts is out of date: run node tools/gen-types.mjs");
    process.exit(1);
  }
  console.log("packages/types/index.d.ts is up to date");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
