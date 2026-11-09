// Minimal argument parsing shared by the commands: positionals, `--flag value`, boolean flags and
// repeatable flags.
export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
  bools: Set<string>;
  multi: Record<string, string[]>;
}

export function parseArgs(
  args: string[],
  opts: { booleans?: string[]; repeatable?: string[] } = {},
): ParsedArgs {
  const booleans = new Set(opts.booleans ?? []);
  const repeatable = new Set(opts.repeatable ?? []);
  const out: ParsedArgs = { positional: [], flags: {}, bools: new Set(), multi: {} };
  for (const r of repeatable) out.multi[r] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const [rawName, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (booleans.has(rawName)) {
        out.bools.add(rawName);
        continue;
      }
      const value = inline ?? args[++i];
      if (value === undefined) throw new Error(`--${rawName} needs a value`);
      if (repeatable.has(rawName)) out.multi[rawName]!.push(value);
      else out.flags[rawName] = value;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}
