import { ManifestSyntaxError, tokenize, type Token } from "./lexer.ts";

export interface TableValue {
  kind: "table";
  list: Value[];
  map: Record<string, Value>;
}
export type Value = string | number | boolean | null | TableValue;

export interface RawDirective {
  name: string;
  args: Value[];
  line: number;
}

/** Parses manifest source into an ordered list of directives. Throws ManifestSyntaxError. */
export function parseDirectives(src: string): RawDirective[] {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;
  const expect = (kind: Token["kind"], what: string): Token => {
    const t = next();
    if (t.kind !== kind) throw new ManifestSyntaxError("unexpected_token", `Expected ${what}, found ${describe(t)}.`, t.line);
    return t;
  };

  const parseValue = (): Value => {
    const t = next();
    switch (t.kind) {
      case "string":
      case "number":
      case "boolean":
        return t.value as string | number | boolean;
      case "nil":
        return null;
      case "{":
        pos--;
        return parseTable();
      default:
        throw new ManifestSyntaxError("unexpected_token", `Expected a value, found ${describe(t)}.`, t.line);
    }
  };

  const parseTable = (): TableValue => {
    const open = expect("{", "'{'");
    const table: TableValue = { kind: "table", list: [], map: {} };
    for (;;) {
      const t = peek();
      if (t.kind === "}") {
        next();
        return table;
      }
      if (t.kind === "eof") throw new ManifestSyntaxError("unterminated_table", "Unterminated table.", open.line);
      if (t.kind === "ident" && tokens[pos + 1]?.kind === "=") {
        next();
        next();
        table.map[t.value as string] = parseValue();
      } else if (t.kind === "[") {
        next();
        const key = expect("string", "a string key");
        expect("]", "']'");
        expect("=", "'='");
        table.map[key.value as string] = parseValue();
      } else {
        table.list.push(parseValue());
      }
      const sep = peek();
      if (sep.kind === "," || sep.kind === ";") {
        next();
        continue;
      }
      if (sep.kind !== "}") {
        throw new ManifestSyntaxError("unexpected_token", `Expected ',' or '}', found ${describe(sep)}.`, sep.line);
      }
    }
  };

  const isArgStart = (t: Token): boolean =>
    t.kind === "string" || t.kind === "number" || t.kind === "boolean" || t.kind === "{" || t.kind === "(";

  const directives: RawDirective[] = [];
  for (;;) {
    const t = peek();
    if (t.kind === "eof") break;
    if (t.kind === ";") {
      next();
      continue;
    }
    if (t.kind !== "ident") {
      throw new ManifestSyntaxError("unexpected_token", `Expected a directive name, found ${describe(t)}.`, t.line);
    }
    next();
    const directive: RawDirective = { name: t.value as string, args: [], line: t.line };
    if (!isArgStart(peek())) {
      throw new ManifestSyntaxError("missing_argument", `Directive '${directive.name}' needs a value.`, t.line);
    }
    while (isArgStart(peek())) {
      if (peek().kind === "(") {
        next();
        if (peek().kind !== ")") {
          directive.args.push(parseValue());
          while (peek().kind === ",") {
            next();
            directive.args.push(parseValue());
          }
        }
        expect(")", "')'");
      } else {
        directive.args.push(parseValue());
      }
    }
    directives.push(directive);
  }
  return directives;
}

function describe(t: Token): string {
  switch (t.kind) {
    case "eof":
      return "end of file";
    case "string":
      return `string "${String(t.value).slice(0, 32)}"`;
    case "ident":
      return `'${String(t.value)}'`;
    default:
      return `'${String(t.value)}'`;
  }
}
