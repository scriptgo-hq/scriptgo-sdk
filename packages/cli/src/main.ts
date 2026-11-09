// Command dispatcher. Each command lives in src/commands/<name>.ts and exports
// `summary: string` and `run(args: string[]): Promise<number>` (the exit code). Adding a command is
// adding a file: nothing here needs to change.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface CommandModule {
  summary: string;
  run(args: string[]): Promise<number>;
}

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), "commands");

function listCommands(): string[] {
  if (!existsSync(commandsDir)) return [];
  return readdirSync(commandsDir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && !f.endsWith(".test.ts"))
    .map((f) => f.slice(0, -3))
    .sort();
}

async function load(name: string): Promise<CommandModule | null> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
  const file = join(commandsDir, `${name}.ts`);
  if (!existsSync(file)) return null;
  return (await import(`./commands/${name}.ts`)) as CommandModule;
}

async function help(): Promise<number> {
  console.log("scriptgo <command> [options]\n");
  for (const name of listCommands()) {
    const mod = await load(name);
    console.log(`  ${name.padEnd(10)} ${mod?.summary ?? ""}`);
  }
  console.log("\nRun `scriptgo <command> --help` for the options of one command.");
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") return help();
  if (name === "--version" || name === "-v") {
    console.log("scriptgo 0.1.0");
    return 0;
  }
  const mod = await load(name);
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
