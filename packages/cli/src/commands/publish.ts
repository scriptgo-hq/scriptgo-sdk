// scriptgo publish [dir] [--package <slug>] --owns-code [--targets-proprietary-game] [--dry-run]
//                  [--escrow [--escrow-ignore <glob>]...]
// scriptgo publish --bundle <file.escrow.zip> --escrow-key <file.json> --package <slug> --owns-code
//
// --escrow publishes a PROTECTED release: the CLI builds the encrypted bundle here, signs its
// escrow.json with your key, uploads the bundle and hands the per-release content key to the master
// over the authenticated API. The master checks the key opens the bundle, validates the plaintext in
// memory, seals the key and stores the bundle only. The key is never written to disk by this command.
// --bundle/--escrow-key publish a pair written earlier by `scriptgo pack --escrow`.
// Protection is deterrence and traceability: a licensed operator can still read what their own host
// decrypts. It makes a copy useless on an unlicensed or unbound server, and a leak attributable.
//
// Packs the resource (manifest, every referenced file, test scripts, README/CHANGELOG/LICENSE),
// uploads it as a new release, waits for validation, declares rights and publishes. The package is
// created on first publish (slug = resource name with '_' turned into '-', or --package).
// Rights are never assumed: without --owns-code the release is left validated but unpublished.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readBundle } from "@scriptgo/escrow";
import { Category } from "@scriptgo/shared";
import { parseArgs } from "../lib/args.ts";
import { buildEscrow } from "../lib/escrow-pack.ts";
import { keyIdOf } from "../lib/release-signature.ts";
import { listFiles, readResource } from "../lib/sdk.ts";
import { scriptgoArchive } from "./pack.ts";
import { ApiClient, ApiError, describeError } from "./_api-client.ts";

export const summary = "Upload a resource as a new release and publish it (needs login)";

interface Check {
  stage: string;
  name: string;
  status: string;
  required: boolean;
  message: string | null;
}
interface Release {
  id: string;
  version: string;
  status: string;
  sha256: string;
  checks: Check[];
  blockers: string[];
}

/** The upload archive: deterministic, so the same sources always give the same SHA-256. */
export async function buildArchive(dir: string) {
  const res = readResource(dir);
  if (!res.result.ok) throw new Error(res.result.errors.map((e) => `${e.code}: ${e.message}`).join("\n"));
  const m = res.result.manifest;
  const { zip, files, errors } = await scriptgoArchive(m, listFiles(res.root), res.root, res.manifestFile);
  if (errors.length > 0) throw new Error(errors.map((e) => `${e.code}: ${e.message}`).join("\n"));
  return { zip, name: m.name, version: m.version, title: m.title, description: m.description, category: m.category, license: m.license, files, manifest: m, manifestFile: res.manifestFile };
}

interface Upload {
  /** The bytes uploaded as `archive`: the plain zip, or the escrow bundle. */
  bytes: Uint8Array;
  fileName: string;
  /** base64 content key of an escrow bundle; sent once, in the upload request. */
  contentKey: string | null;
  escrowSummary: string | null;
}

function printChecks(r: Release): void {
  for (const c of r.checks) {
    const mark = c.status === "passed" ? "ok  " : c.status === "failed" ? (c.required ? "FAIL" : "warn") : c.status.padEnd(4).slice(0, 4);
    console.log(`  ${mark} ${c.name}${c.message ? ` — ${c.message}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help", "owns-code", "targets-proprietary-game", "dry-run", "escrow"], repeatable: ["escrow-ignore"] });
  if (a.bools.has("help")) {
    console.log(
      "scriptgo publish [resourceDir] [--package <slug>] --owns-code [--targets-proprietary-game] [--dry-run] [--timeout <seconds>]\n" +
        "                 [--escrow [--escrow-ignore <glob>]...]   protect the release: encrypted bundle, key handed to the master\n" +
        "scriptgo publish --bundle <file.escrow.zip> --escrow-key <file.json> --package <slug> --owns-code",
    );
    return 0;
  }
  const prebuilt = a.flags.bundle || a.flags["escrow-key"];
  if (prebuilt && !(a.flags.bundle && a.flags["escrow-key"] && a.flags.package)) {
    console.error("scriptgo publish: --bundle needs --escrow-key and --package (the registry slug the bundle was built for)");
    return 2;
  }
  const dir = a.positional[0] ?? ".";
  if (!prebuilt && !existsSync(dir)) {
    console.error(`scriptgo publish: ${dir} does not exist`);
    return 2;
  }
  const pack = prebuilt ? null : await buildArchive(dir);
  const slug = a.flags.package ?? pack!.name.replace(/_/g, "-");
  if (pack) {
    const plainSha = createHash("sha256").update(pack.zip).digest("hex");
    console.log(`packed ${pack.name} ${pack.version}: ${pack.files.length} files, ${pack.zip.byteLength} bytes, sha256 ${plainSha}`);
    if (a.bools.has("dry-run") && !a.bools.has("escrow")) return 0;
  }

  const api = ApiClient.fromEnvironment({ requireToken: !a.bools.has("dry-run") });
  try {
    // What gets uploaded: the plain archive, a bundle built now, or a bundle packed earlier.
    let upload: Upload;
    if (prebuilt) {
      for (const f of [a.flags.bundle!, a.flags["escrow-key"]!]) if (!existsSync(f)) throw new Error(`${f} does not exist`);
      const bytes = readFileSync(a.flags.bundle!);
      const key = JSON.parse(readFileSync(a.flags["escrow-key"]!, "utf8")) as { contentKeyBase64?: string };
      if (!key.contentKeyBase64) throw new Error(`${a.flags["escrow-key"]} has no contentKeyBase64: it is not a key file written by scriptgo pack --escrow`);
      const m = readBundle(bytes).manifest;
      upload = { bytes, fileName: `${slug}-${m.version}.escrow.zip`, contentKey: key.contentKeyBase64, escrowSummary: `${m.encryptedFiles.length} encrypted, ${m.clearFiles.length} clear, signer ${keyIdOf(m.signerPublicKey)}` };
    } else if (a.bools.has("escrow")) {
      // The bundle's identity is the registry identifier, so the master and every loader agree on it.
      const username = a.bools.has("dry-run") ? (pack!.manifest.author ?? "creator") : (await api.get<{ creatorProfile: { username: string } | null }>("/v1/me")).data.creatorProfile?.username;
      if (!username) throw new Error("you have no creator profile yet: create one on the website (Dashboard) before publishing");
      const built = buildEscrow({ archive: pack!.zip, manifest: pack!.manifest, manifestFile: pack!.manifestFile, identifier: `${username}//${slug}`, allowlist: a.multi["escrow-ignore"] ?? [] });
      console.log(`escrow bundle for ${username}//${slug}@${pack!.version}: ${built.bundle.length} bytes`);
      console.log(`  clear:     ${built.clearFiles.join(", ")}`);
      console.log(`  encrypted: ${built.encryptedFiles.join(", ")}`);
      console.log(`  escrow.json signed by your key ${keyIdOf(built.manifest.signerPublicKey)}`);
      upload = {
        bytes: built.bundle,
        fileName: `${pack!.name}-${pack!.version}.escrow.zip`,
        contentKey: built.contentKey.toString("base64"),
        escrowSummary: `${built.encryptedFiles.length} encrypted, ${built.clearFiles.length} clear, signer ${keyIdOf(built.manifest.signerPublicKey)}`,
      };
      built.contentKey.fill(0);
      if (a.bools.has("dry-run")) return 0;
    } else {
      upload = { bytes: pack!.zip, fileName: `${pack!.name}-${pack!.version}.zip`, contentKey: null, escrowSummary: null };
    }
    const sha256 = createHash("sha256").update(upload.bytes).digest("hex");

    try {
      await api.get(`/v1/creator/packages/${encodeURIComponent(slug)}`);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
      if (!pack) throw new Error(`you have no package named ${slug}: create it on the website, or publish its folder once with --escrow`);
      const category = Category.safeParse(pack.category).success ? pack.category : "other";
      await api.post("/v1/creator/packages", {
        name: slug,
        title: pack.title ?? pack.name,
        summary: (pack.description ?? "").slice(0, 300),
        category,
        license: pack.license ?? "NOASSERTION",
      });
      console.log(`created package ${slug}`);
    }

    const form = new FormData();
    form.append("archive", new Blob([new Uint8Array(upload.bytes)], { type: "application/zip" }), upload.fileName);
    // The content key travels once, in this authenticated request; the master seals it at rest.
    if (upload.contentKey) form.append("contentKey", upload.contentKey);
    let release = (await api.request<Release>("POST", `/v1/creator/packages/${encodeURIComponent(slug)}/releases`, { form })).data;
    upload.contentKey = null;
    // A release that failed validation stores nothing, so its hash is only checked when it is kept.
    if (release.status !== "validation_failed" && release.sha256 !== sha256) throw new Error(`the API stored sha256 ${release.sha256}, expected ${sha256}`);

    const deadline = Date.now() + Number(a.flags.timeout ?? 120) * 1000;
    while (release.status === "validating" && Date.now() < deadline) {
      await sleep(1000);
      release = (await api.get<Release>(`/v1/creator/releases/${release.id}`)).data;
    }
    console.log(`release ${release.version} (${release.id}): ${release.status}`);
    printChecks(release);
    if (release.status === "validating") {
      console.error("validation is still running: is the worker up? (corepack pnpm --filter @scriptgo/worker dev)");
      return 1;
    }
    if (release.status !== "ready") {
      console.error("validation failed; fix the errors above and publish again");
      return 1;
    }
    if (!a.bools.has("owns-code")) {
      console.error(
        "rights not declared: rerun with --owns-code (you wrote this code or hold the rights to sell it),\n" +
          "adding --targets-proprietary-game if it targets or includes content from a proprietary game.",
      );
      return 1;
    }
    await api.post(`/v1/creator/releases/${release.id}/rights`, { ownsCode: true, targetsProprietaryGame: a.bools.has("targets-proprietary-game"), thirdPartyAssets: [] });
    const published = (await api.post<Release>(`/v1/creator/releases/${release.id}/publish`)).data;
    const me = (await api.get<{ creatorProfile: { username: string } | null }>("/v1/me")).data;
    console.log(`published ${me.creatorProfile?.username ?? "?"}//${slug}@${published.version} (sha256 ${published.sha256})`);
    if (upload.escrowSummary) {
      console.log(`protected release: ${upload.escrowSummary}; the content key is sealed on the master and was not written to disk here`);
      console.log("buyers get the encrypted bundle; a server gets the key only when licensed and bound. This is deterrence and traceability, not a guarantee against the operator of a licensed host.");
    }
    return 0;
  } catch (e) {
    console.error(`scriptgo publish: ${describeError(e)}`);
    return 1;
  }
}
