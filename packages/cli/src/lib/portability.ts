// Static portability lint: globals a script uses that some declared environment does not have.
//
// The standalone host is the most permissive sandbox (it exposes os.time/clock/date and
// setmetatable everywhere), so a package can pass its tests there and still fail on OPEN//77,
// whose sandbox has no `os`, `io`, `debug` or `package` and whose client sandbox has no
// `setmetatable`. Source: OPEN//77 devkit, server-api#what-the-sandbox-provides, build 2.50.0+op77.156.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expandGlob, type ParsedManifest } from "@scriptgo/manifest";

export interface PortabilityIssue {
  code: string;
  file: string;
  line: number;
  message: string;
}

type Side = "shared" | "server" | "client";

interface Rule {
  code: string;
  pattern: RegExp;
  sides: Side[];
  message: string;
}

// Each pattern must not match inside a longer identifier (`photos.png`, `my_os.time`).
const OPEN77_RULES: Rule[] = [
  { code: "open77_no_os", pattern: /(?<![\w.:])os\s*\.\s*[A-Za-z_]+/, sides: ["shared", "server", "client"], message: "`os` is nil in the OPEN//77 sandbox: use ScriptGo.time.now() / ScriptGo.time.monotonic()" },
  { code: "open77_no_io", pattern: /(?<![\w.:])io\s*\.\s*[A-Za-z_]+/, sides: ["shared", "server", "client"], message: "`io` is nil in the OPEN//77 sandbox: use ScriptGo.storage or ScriptGo.resource.readFile" },
  { code: "open77_no_debug", pattern: /(?<![\w.:])debug\s*\.\s*[A-Za-z_]+/, sides: ["shared", "server", "client"], message: "`debug` is nil in the OPEN//77 sandbox" },
  { code: "open77_no_package", pattern: /(?<![\w.:])package\s*\.\s*[A-Za-z_]+/, sides: ["shared", "server", "client"], message: "`package` is nil in the OPEN//77 sandbox: use require with the resource's own modules" },
  { code: "open77_no_load", pattern: /(?<![\w.:])(loadstring|dofile|loadfile)\s*\(/, sides: ["shared", "server", "client"], message: "dynamic code loading is not available in the OPEN//77 sandbox" },
  { code: "open77_client_no_metatables", pattern: /(?<![\w.:])(setmetatable|getmetatable)\s*\(/, sides: ["shared", "client"], message: "`setmetatable` is nil in the OPEN//77 client sandbox: use plain tables in shared and client scripts" },
];

/** Removes comments and string contents, keeping line breaks so line numbers stay right. */
export function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const keepNewlines = (s: string): string => s.replace(/[^\n]/g, " ");
  while (i < src.length) {
    const rest = src.slice(i);
    const long = /^(--)?\[(=*)\[/.exec(rest);
    if (long) {
      const close = `]${long[2]}]`;
      const end = src.indexOf(close, i + long[0].length);
      const stop = end < 0 ? src.length : end + close.length;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (rest.startsWith("--")) {
      const nl = src.indexOf("\n", i);
      const stop = nl < 0 ? src.length : nl;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += ch + keepNewlines(src.slice(i + 1, j)) + (src[j] === ch ? ch : "");
      i = src[j] === ch ? j + 1 : j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function scanSource(text: string, file: string, side: Side, rules: Rule[] = OPEN77_RULES): PortabilityIssue[] {
  const issues: PortabilityIssue[] = [];
  const lines = stripCommentsAndStrings(text).split("\n");
  lines.forEach((line, idx) => {
    for (const rule of rules) {
      if (!rule.sides.includes(side)) continue;
      if (rule.pattern.test(line)) issues.push({ code: rule.code, file, line: idx + 1, message: rule.message });
    }
  });
  return issues;
}

/** Issues for every script of a resource that declares (or does not restrict) the open77 environment. */
export function open77Portability(root: string, m: ParsedManifest, files: string[]): PortabilityIssue[] {
  if (m.environments.length > 0 && !m.environments.includes("open77")) return [];
  const bySide: [Side, string[]][] = [
    ["shared", [...m.sharedScripts, ...(m.environmentScripts["open77"] ?? [])]],
    ["server", m.serverScripts],
    ["client", m.clientScripts],
  ];
  const issues: PortabilityIssue[] = [];
  const seen = new Set<string>();
  for (const [side, patterns] of bySide) {
    for (const pattern of patterns) {
      for (const file of expandGlob(pattern, files)) {
        const key = `${side}:${file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push(...scanSource(readFileSync(join(root, file), "utf8"), file, side));
      }
    }
  }
  return issues;
}
