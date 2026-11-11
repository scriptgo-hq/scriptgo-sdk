// scriptgo add <creator//name[@version]> [--dir resources] [--force] [--trust-new-key] [--allow-unsigned]
//                                         [--deployment-token <sg_dep_...>]
//
// Downloads a published release, checks its SHA-256 and the registry's ed25519 signature (keys
// pinned on first use: see src/lib/release-signature.ts), and extracts it into
// ./resources/<resource>. Paths are re-checked locally: nothing is written outside that folder.
// A tampered archive is refused before a single file is written.
//
// A PROTECTED release arrives as its encrypted bundle, for a licensed customer only (log in as the
// license holder, or pass a deployment token). The bundle is saved as
// ./resources/<resource>-<version>.escrow.zip, never extracted: a loader on your bound server opens
// it (the .NET kit in memory, or `scriptgo escrow load`, the reference loader).
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { parseIdentifier } from "@scriptgo/shared";
import { parseArgs } from "../lib/args.ts";
import { signatureFromHeaders, trustedKeysFor, verifyRelease, type TrustedKey } from "../lib/release-signature.ts";
import { ApiClient, describeError } from "./_api-client.ts";

export const summary = "Download a package into ./resources, verifying its SHA-256 and signature";

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
  const a = parseArgs(args, { booleans: ["help", "force", "trust-new-key", "allow-unsigned"] });
  const target = a.positional[0];
  if (a.bools.has("help") || !target) {
    console.log("scriptgo add <creator//name[@version]> [--dir resources] [--force] [--trust-new-key] [--allow-unsigned] [--deployment-token <sg_dep_...>]");
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

    const deploymentToken = a.flags["deployment-token"] ?? process.env.SCRIPTGO_DEPLOYMENT_TOKEN;
    const res = await api.raw("GET", `/v1/packages/${ident.creator}/${ident.name}/versions/${encodeURIComponent(version)}/download`, {
      headers: deploymentToken ? { "x-scriptgo-deployment-token": deploymentToken } : undefined,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new Error(`${body?.error?.code ?? `http_${res.status}`}: ${body?.error?.message ?? "download refused"}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    const announced = res.headers.get("x-sha256");
    const listed = pkg.versions.find((v) => v.version === version)?.sha256;
    // A release with assets is delivered as a copy built for this licence (docs/spec/assets.md): its
    // hash is the copy's, and the registry's signature names the published archive it came from.
    const fingerprint = res.headers.get("x-scriptgo-fingerprint");
    if (!announced || actual !== announced || (listed && listed !== actual && !fingerprint)) {
      throw new Error(`SHA-256 mismatch for ${ident.creator}//${ident.name}@${version}: got ${actual}, registry says ${listed ?? announced ?? "nothing"}. Nothing was written.`);
    }

    // The registry's signature: the bytes are the ones it published, whoever served them.
    const signature = signatureFromHeaders(res.headers);
    if (!signature && fingerprint) {
      throw new Error(`${ident.creator}//${ident.name}@${version}: a licensed copy came without the registry's signature. Nothing was written.`);
    }
    if (!signature) {
      if (!a.bools.has("allow-unsigned")) {
        throw new Error(`${ident.creator}//${ident.name}@${version} carries no release signature. Nothing was written. (A registry that predates release signing: rerun with --allow-unsigned.)`);
      }
      console.log("warning: this release is not signed; only its SHA-256 was checked");
    } else {
      const served = (await api.get<{ keys: TrustedKey[] }>("/v1/signing-keys")).data.keys;
      const trust = trustedKeysFor(api.base, served, { trustNew: a.bools.has("trust-new-key") });
      for (const n of trust.notes) console.log(n);
      const verdict = verifyRelease(signature, trust.keys, { package: `${ident.creator}//${ident.name}`, version, sha256: actual });
      if (!verdict.ok) throw new Error(`signature check failed for ${ident.creator}//${ident.name}@${version}: ${verdict.reason}. Nothing was written.`);
      if (fingerprint) {
        const att = JSON.parse(signature.payload) as { release?: { sha256?: string }; fingerprint?: string };
        if (att.fingerprint !== fingerprint || (listed && att.release?.sha256 !== listed)) {
          throw new Error(`${ident.creator}//${ident.name}@${version}: the signed copy does not name the published release (${listed ?? "unknown"}). Nothing was written.`);
        }
      }
    }

    const root = resolve(a.flags.dir ?? "resources");
    if (res.headers.get("x-scriptgo-artifact") === "escrow") {
      // A protected release is kept as its encrypted bundle. It is never extracted here.
      const file = join(root, `${pkg.resourceName}-${version}.escrow.zip`);
      if (existsSync(file) && !a.bools.has("force")) throw new Error(`${file} already exists; pass --force to replace it`);
      mkdirSync(root, { recursive: true });
      writeFileSync(file, bytes);
      console.log(`added ${ident.creator}//${ident.name}@${version} -> ${file} (protected release: encrypted bundle, sha256 ${actual}, signature verified)`);
      console.log("it opens only on a licensed, bound server: load it with a host that holds your server key (the .NET kit decrypts in memory),");
      console.log(`or with the reference loader: scriptgo escrow load --bundle "${file}" --package ${ident.creator}//${ident.name} --environment <env> --deployment-token <sg_dep_...> --identity <file>`);
      return 0;
    }

    const entries = stripTopFolder(unzipSync(bytes));
    for (const name of Object.keys(entries)) {
      const why = unsafeEntry(name);
      if (why) throw new Error(`refusing archive entry '${name}': ${why}. Nothing was written.`);
    }
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
    console.log(`added ${ident.creator}//${ident.name}@${version} -> ${dest} (${Object.keys(entries).length} files, sha256 ${actual}${signature ? ", signature verified" : ""})`);
    if (fingerprint) console.log("this copy is licensed to you and fingerprinted: it names your licence, so keep it to your own servers");
    if (pkg.pricing?.kind === "paid") console.log("this package is sold under license: activate it with `scriptgo license activate`");
    return 0;
  } catch (e) {
    console.error(`scriptgo add: ${describeError(e)}`);
    return 1;
  }
}
