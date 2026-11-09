// Tokenizer for the resource manifest DSL (`scriptgo.lua` / `open77.lua`).
// The manifest is parsed, never executed. See docs/spec/manifest.md.

export type TokenKind =
  | "ident"
  | "string"
  | "number"
  | "boolean"
  | "nil"
  | "{"
  | "}"
  | "("
  | ")"
  | ","
  | ";"
  | "="
  | "["
  | "]"
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string | number | boolean | null;
  line: number;
}

export class ManifestSyntaxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly line: number,
  ) {
    super(message);
  }
}

const SINGLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
  "\\": "\\",
  '"': '"',
  "'": "'",
  "\n": "\n",
};

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/** Returns the level of a long bracket opening at `pos` (`[[` = 0, `[==[` = 2), or -1. */
function longBracketLevel(src: string, pos: number): number {
  if (src[pos] !== "[") return -1;
  let i = pos + 1;
  let level = 0;
  while (src[i] === "=") {
    level++;
    i++;
  }
  return src[i] === "[" ? level : -1;
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  const readLong = (level: number, startLine: number): string => {
    // `i` points at the opening bracket.
    i += level + 2;
    // A newline immediately after the opening bracket is skipped, as in Lua.
    if (src[i] === "\r") i++;
    if (src[i] === "\n") {
      i++;
      line++;
    }
    const close = "]" + "=".repeat(level) + "]";
    const end = src.indexOf(close, i);
    if (end < 0) {
      throw new ManifestSyntaxError("unterminated_long_string", "Unterminated long string or comment.", startLine);
    }
    const text = src.slice(i, end);
    for (const ch of text) if (ch === "\n") line++;
    i = end + close.length;
    return text;
  };

  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    // Comments.
    if (c === "-" && src[i + 1] === "-") {
      i += 2;
      const level = longBracketLevel(src, i);
      if (level >= 0) {
        readLong(level, line);
      } else {
        while (i < n && src[i] !== "\n") i++;
      }
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j]!)) j++;
      const word = src.slice(i, j);
      i = j;
      if (word === "true" || word === "false") tokens.push({ kind: "boolean", value: word === "true", line });
      else if (word === "nil") tokens.push({ kind: "nil", value: null, line });
      else tokens.push({ kind: "ident", value: word, line });
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(src[j]!)) j++;
        tokens.push({ kind: "number", value: parseInt(src.slice(i + 2, j), 16), line });
      } else {
        while (j < n && /[0-9.]/.test(src[j]!)) j++;
        if (src[j] === "e" || src[j] === "E") {
          j++;
          if (src[j] === "+" || src[j] === "-") j++;
          while (j < n && isDigit(src[j]!)) j++;
        }
        const text = src.slice(i, j);
        const value = Number(text);
        if (!Number.isFinite(value)) throw new ManifestSyntaxError("invalid_number", `Invalid number '${text}'.`, line);
        tokens.push({ kind: "number", value, line });
      }
      i = j;
      continue;
    }
    if (c === "-" && isDigit(src[i + 1] ?? "")) {
      // Negative number literal (unary minus is the only operator the DSL accepts).
      let j = i + 1;
      while (j < n && /[0-9.]/.test(src[j]!)) j++;
      tokens.push({ kind: "number", value: Number(src.slice(i, j)), line });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const startLine = line;
      let j = i + 1;
      let out = "";
      for (;;) {
        if (j >= n) throw new ManifestSyntaxError("unterminated_string", "Unterminated string.", startLine);
        const ch = src[j]!;
        if (ch === quote) {
          j++;
          break;
        }
        if (ch === "\n") throw new ManifestSyntaxError("unterminated_string", "Unterminated string.", startLine);
        if (ch === "\\") {
          const next = src[j + 1];
          if (next === undefined) throw new ManifestSyntaxError("unterminated_string", "Unterminated string.", startLine);
          if (next in SINGLE_ESCAPES) {
            out += SINGLE_ESCAPES[next];
            if (next === "\n") line++;
            j += 2;
            continue;
          }
          if (isDigit(next)) {
            let k = j + 1;
            let digits = "";
            while (k < n && digits.length < 3 && isDigit(src[k]!)) digits += src[k++];
            out += String.fromCharCode(Number(digits));
            j = k;
            continue;
          }
          if (next === "x") {
            const hex = src.slice(j + 2, j + 4);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new ManifestSyntaxError("invalid_escape", "Invalid \\x escape.", line);
            out += String.fromCharCode(parseInt(hex, 16));
            j += 4;
            continue;
          }
          throw new ManifestSyntaxError("invalid_escape", `Invalid escape '\\${next}'.`, line);
        }
        out += ch;
        j++;
      }
      tokens.push({ kind: "string", value: out, line: startLine });
      i = j;
      continue;
    }
    if (c === "[") {
      const level = longBracketLevel(src, i);
      if (level >= 0) {
        const startLine = line;
        const text = readLong(level, startLine);
        tokens.push({ kind: "string", value: text, line: startLine });
        continue;
      }
      tokens.push({ kind: "[", value: "[", line });
      i++;
      continue;
    }
    if ("{}(),;=]".includes(c)) {
      tokens.push({ kind: c as TokenKind, value: c, line });
      i++;
      continue;
    }
    throw new ManifestSyntaxError("unexpected_character", `Unexpected character '${c}'.`, line);
  }
  tokens.push({ kind: "eof", value: null, line });
  return tokens;
}
