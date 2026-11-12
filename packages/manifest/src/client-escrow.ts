// Which scripts client code escrow covers, and whether a release can use it (docs/spec/client-escrow.md).
// One verdict for `scriptgo publish --client-escrow` and the platform's upload check.
//
// v1 covers the files `client_scripts` names, in Lua. Shared scripts run on the server too and stay
// clear; so do web_files. Client escrow runs on OPEN//77 only (the one host with a SCRIPT//GO client
// VM), so a release that marks it must target OPEN//77 alone: any other host would get the stubs.
import { expandGlob } from "./files.ts";
import { scriptLanguage, type ParsedManifest } from "./manifest.ts";

/** The container of a copy with client code escrow, at the resource root. */
export const CLIENT_ESCROW_CONTAINER = "clientcode.sgce";

export interface ClientEscrowIssue {
  code: string;
  message: string;
}

/** The resource-relative client scripts client escrow covers: `client_scripts`, expanded and sorted. */
export function clientEscrowScripts(m: ParsedManifest, files: string[]): string[] {
  const out = new Set<string>();
  for (const p of m.clientScripts) for (const f of expandGlob(p, files)) out.add(f);
  return [...out].sort();
}

/** Why a release cannot use client escrow; empty when it can. */
export function clientEscrowIssues(m: ParsedManifest, files: string[]): ClientEscrowIssue[] {
  const issues: ClientEscrowIssue[] = [];
  const scripts = clientEscrowScripts(m, files);
  if (scripts.length === 0) issues.push({ code: "client_escrow_no_scripts", message: "client escrow needs at least one client_scripts file" });
  for (const p of scripts) {
    if (scriptLanguage(p) !== "lua") issues.push({ code: "client_escrow_lua_only", message: `${p}: client escrow compiles Lua client scripts only` });
  }
  const others = m.environments.filter((e) => e !== "open77");
  if (m.environments.length === 0 || others.length > 0) {
    issues.push({
      code: "client_escrow_open77_only",
      message:
        "client escrow runs on OPEN//77 only: set environments = { \"open77\" } " +
        (others.length > 0 ? `(this release also targets ${others.join(", ")}, which would receive the stubs instead of the scripts)` : "(the manifest lists no environment)"),
    });
  }
  if (files.includes(CLIENT_ESCROW_CONTAINER)) {
    issues.push({ code: "client_escrow_reserved_path", message: `${CLIENT_ESCROW_CONTAINER} is the name of the encrypted container each copy gets: a release cannot ship its own` });
  }
  return issues;
}
