// scriptgo publish [dir] [--package <slug>] --owns-code [--targets-proprietary-game] [--dry-run]
//
// Packs the resource (manifest, every referenced file, test scripts, README/CHANGELOG/LICENSE),
// uploads it as a new release, waits for validation, declares rights and publishes. The package is
// created on first publish (slug = resource name with '_' turned into '-', or --package).
// Rights are never assumed: without --owns-code the release is left validated but unpublished.
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Category } from "@scriptgo/shared";
import { parseArgs } from "../lib/args.ts";
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
export async function buildArchive(dir: string): Promise<{ zip: Uint8Array; name: string; version: string; title: string | null; description: string | null; category: string | null; license: string | null; files: string[] }> {
  const res = readResource(dir);
  if (!res.result.ok) throw new Error(res.result.errors.map((e) => `${e.code}: ${e.message}`).join("\n"));
  const m = res.result.manifest;
  const { zip, files, errors } = await scriptgoArchive(m, listFiles(res.root), res.root, res.manifestFile);
  if (errors.length > 0) throw new Error(errors.map((e) => `${e.code}: ${e.message}`).join("\n"));
  return { zip, name: m.name, version: m.version, title: m.title, description: m.description, category: m.category, license: m.license, files };
}

function printChecks(r: Release): void {
  for (const c of r.checks) {
    const mark = c.status === "passed" ? "ok  " : c.status === "failed" ? (c.required ? "FAIL" : "warn") : c.status.padEnd(4).slice(0, 4);
    console.log(`  ${mark} ${c.name}${c.message ? ` — ${c.message}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help", "owns-code", "targets-proprietary-game", "dry-run"] });
  if (a.bools.has("help")) {
    console.log("scriptgo publish [resourceDir] [--package <slug>] --owns-code [--targets-proprietary-game] [--dry-run] [--timeout <seconds>]");
    return 0;
  }
  const dir = a.positional[0] ?? ".";
  if (!existsSync(dir)) {
    console.error(`scriptgo publish: ${dir} does not exist`);
    return 2;
  }
  const pack = await buildArchive(dir);
  const sha256 = createHash("sha256").update(pack.zip).digest("hex");
  const slug = a.flags.package ?? pack.name.replace(/_/g, "-");
  console.log(`packed ${pack.name} ${pack.version}: ${pack.files.length} files, ${pack.zip.byteLength} bytes, sha256 ${sha256}`);
  if (a.bools.has("dry-run")) return 0;

  const api = ApiClient.fromEnvironment({ requireToken: true });
  try {
    try {
      await api.get(`/v1/creator/packages/${encodeURIComponent(slug)}`);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
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
    form.append("archive", new Blob([new Uint8Array(pack.zip)], { type: "application/zip" }), `${pack.name}-${pack.version}.zip`);
    let release = (await api.request<Release>("POST", `/v1/creator/packages/${encodeURIComponent(slug)}/releases`, { form })).data;
    if (release.sha256 !== sha256) throw new Error(`the API stored sha256 ${release.sha256}, expected ${sha256}`);

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
    return 0;
  } catch (e) {
    console.error(`scriptgo publish: ${describeError(e)}`);
    return 1;
  }
}
