// Command dispatcher. Each command lives in src/commands/<name>.ts and exports
// `summary: string` and `run(args: string[]): Promise<number>` (the exit code). Adding a command is
// adding a file: nothing here needs to change. Run from the sources, the commands are the files of
// src/commands; the installed bundle passes the same list, written out by packages/cli/build.mjs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandModule {
  summary: string;
  run(args: string[]): Promise<number>;
}

/** Command name -> its module, loaded on first use. */
export type CommandTable = Record<string, () => Promise<CommandModule>>;

const here = dirname(fileURLToPath(import.meta.url));

/** A file of src/commands that is a command: `_` files are helpers, tests are not commands. */
export function isCommandFile(file: string): boolean {
  return file.endsWith(".ts") && !file.startsWith("_") && !file.endsWith(".test.ts");
}

/** The commands of src/commands, when running from the sources. */
export function sourceCommands(): CommandTable {
  const dir = join(here, "commands");
  const table: CommandTable = {};
  if (!existsSync(dir)) return table;
  for (const f of readdirSync(dir).filter(isCommandFile)) {
    const name = f.slice(0, -3);
    table[name] = () => import(`./commands/${name}.ts`) as Promise<CommandModule>;
  }
  return table;
}

/** The CLI's version: package.json is one level up from src/ and from dist/ alike. */
function version(): string {
  try {
    return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function load(commands: CommandTable, name: string): Promise<CommandModule | null> {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || !Object.hasOwn(commands, name)) return null;
  return commands[name]!();
}

async function help(commands: CommandTable): Promise<number> {
  console.log("scriptgo <command> [options]\n");
  for (const name of Object.keys(commands).sort()) {
    const mod = await load(commands, name);
    console.log(`  ${name.padEnd(10)} ${mod?.summary ?? ""}`);
  }
  console.log("\nRun `scriptgo <command> --help` for the options of one command.");
  return 0;
}

export async function main(argv: string[], commands: CommandTable = sourceCommands()): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") return help(commands);
  if (name === "--version" || name === "-v") {
    console.log(`scriptgo ${version()}`);
    return 0;
  }
  const mod = await load(commands, name);
  if (!mod) {
    console.error(`scriptgo: unknown command '${name}'. Run 'scriptgo help'.`);
    return 2;
  }
  try {
    return await mod.run(rest);
  } catch (err) {
    console.error(`scriptgo ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
