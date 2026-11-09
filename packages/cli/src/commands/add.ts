// scriptgo add <creator//name[@version]> [--dir resources] [--force]
//
// Downloads a published release, checks its SHA-256 against the registry, and extracts it into
// ./resources/<resource>. Paths are re-checked locally: nothing is written outside that folder.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { parseIdentifier } from "@scriptgo/shared";
import { parseArgs } from "../lib/args.ts";
import { ApiClient, describeError } from "./_api-client.ts";

export const summary = "Download a package into ./resources, verifying its SHA-256";

interface PackageDetail {
  resourceName: string | null;
  latestVersion: string | null;
  licensed?: boolean;
  pricing?: { kind: string };
  versions: { version: string; status: string; sha256: string; restricted: boolean }[];
}

/** Same rules as the registry: relative, no '..', no drive letters, no backslashes or NUL. */
export function unsafeEntry(name: string): string | null {
  if (name.includes("\\")) return "backslash in path";
  if (name.includes("\0")) return "NUL in path";
  if (name.startsWith("/")) return "absolute path";
  if (/^[A-Za-z]:/.test(name)) return "drive letter";
  if (name.split("/").some((p) => p === "..")) return "parent directory reference";
  return null;
}

/** Strips the single top-level folder the archive is packed under. */
export function stripTopFolder(entries: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const names = Object.keys(entries).filter((n) => !n.endsWith("/"));
  const tops = new Set(names.map((n) => n.split("/")[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes("/"));
  const out: Record<string, Uint8Array> = {};
  for (const n of names) out[strip ? n.slice(n.indexOf("/") + 1) : n] = entries[n]!;
  return out;
}

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help", "force"] });
  const target = a.positional[0];
  if (a.bools.has("help") || !target) {
    console.log("scriptgo add <creator//name[@version]> [--dir resources] [--force]");
    return a.bools.has("help") ? 0 : 2;
  }
  const ident = parseIdentifier(target);
  if (!ident) {
    console.error(`scriptgo add: '${target}' is not creator//name[@version]`);
    return 2;
  }
  const api = ApiClient.fromEnvironment();
  try {
    const q = ident.version ? `?version=${encodeURIComponent(ident.version)}` : "";
    const pkg = (await api.get<PackageDetail>(`/v1/packages/${ident.creator}/${ident.name}${q}`)).data;
    const version = ident.version ?? pkg.latestVersion;
    if (!version) throw new Error(`${ident.creator}//${ident.name} has no published version`);
    if (!pkg.resourceName) throw new Error(`${ident.creator}//${ident.name} has no resource name yet`);

    const res = await api.raw("GET", `/v1/packages/${ident.creator}/${ident.name}/versions/${encodeURIComponent(version)}/download`);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new Error(`${body?.error?.code ?? `http_${res.status}`}: ${body?.error?.message ?? "download refused"}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    const announced = res.headers.get("x-sha256");
    const listed = pkg.versions.find((v) => v.version === version)?.sha256;
    if (!announced || actual !== announced || (listed && listed !== actual)) {
      throw new Error(`SHA-256 mismatch for ${ident.creator}//${ident.name}@${version}: got ${actual}, registry says ${listed ?? announced ?? "nothing"}. Nothing was written.`);
    }

    const entries = stripTopFolder(unzipSync(bytes));
    for (const name of Object.keys(entries)) {
      const why = unsafeEntry(name);
      if (why) throw new Error(`refusing archive entry '${name}': ${why}. Nothing was written.`);
    }
    const root = resolve(a.flags.dir ?? "resources");
    const dest = join(root, pkg.resourceName);
    if (existsSync(dest)) {
      if (!a.bools.has("force")) throw new Error(`${dest} already exists; pass --force to replace it`);
      rmSync(dest, { recursive: true, force: true });
    }
    for (const [name, data] of Object.entries(entries)) {
      const file = resolve(dest, name);
      if (!file.startsWith(dest + sep)) throw new Error(`refusing '${name}': outside ${dest}`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
    }
    console.log(`added ${ident.creator}//${ident.name}@${version} -> ${dest} (${Object.keys(entries).length} files, sha256 ${actual})`);
    if (pkg.pricing?.kind === "paid") console.log("this package is sold under license: activate it with `scriptgo license activate`");
    return 0;
  } catch (e) {
    console.error(`scriptgo add: ${describeError(e)}`);
    return 1;
  }
}
