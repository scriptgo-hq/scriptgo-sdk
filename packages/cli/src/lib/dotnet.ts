// The `dotnet` environment: the console host of the .NET kit (sdk/dotnet/ScriptGo.Host.Standalone).
// It needs the .NET SDK 10 (`dotnet`); the host is built on first use into its bin/Release folder.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot } from "./sdk.ts";

export const DOTNET_PROJECT = join(repoRoot, "sdk", "dotnet", "ScriptGo.Host.Standalone", "ScriptGo.Host.Standalone.csproj");
export const DOTNET_HOST_DLL = join(repoRoot, "sdk", "dotnet", "ScriptGo.Host.Standalone", "bin", "Release", "net10.0", "scriptgo-dotnet.dll");

/** The dotnet executable: --dotnet, SCRIPTGO_DOTNET, DOTNET_ROOT, the default install folder, then the PATH. */
export function findDotnet(flag?: string): string | null {
  const exe = process.platform === "win32" ? "dotnet.exe" : "dotnet";
  const candidates = [
    flag,
    process.env.SCRIPTGO_DOTNET,
    process.env.DOTNET_ROOT ? join(process.env.DOTNET_ROOT, exe) : undefined,
    process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "dotnet", exe) : "/usr/share/dotnet/dotnet",
    process.platform === "win32" ? undefined : "/usr/lib/dotnet/dotnet",
  ];
  for (const c of candidates) if (c && existsSync(c)) return resolve(c);
  const probe = spawnSync("dotnet", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "dotnet" : null;
}

/**
 * The host DLL, built with `dotnet build -c Release` when missing (or when `rebuild` is set).
 * Answers the path, or an error message.
 */
export function ensureDotnetHost(dotnet: string, rebuild = false): { dll: string } | { error: string } {
  if (existsSync(DOTNET_HOST_DLL) && !rebuild) return { dll: DOTNET_HOST_DLL };
  const r = spawnSync(dotnet, ["build", DOTNET_PROJECT, "-c", "Release", "-nologo", "-v", "quiet"], { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(DOTNET_HOST_DLL)) {
    const tail = ((r.stdout ?? "") + (r.stderr ?? "")).split(/\r?\n/).filter((l) => /error/i.test(l)).slice(0, 3).join(" | ");
    return { error: `dotnet build failed (exit ${r.status}): ${tail}` };
  }
  return { dll: DOTNET_HOST_DLL };
}
