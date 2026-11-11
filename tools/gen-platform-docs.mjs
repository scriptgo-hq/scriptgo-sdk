// Writes one documentation page per platform, docs/site/platforms/<slug>.md, from
// sdk/environments.json and each adapter's SETUP.md. The website keeps a platform's page short and
// links here for the detail: how it runs, setup, capabilities, protection, limits and the real runs
// behind its status.
//
//   node tools/gen-platform-docs.mjs [--check]
//
// --check exits 1 when a page is out of date or missing (for CI). Platforms with no adapter code
// yet (no integration in the registry) get no page.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "docs", "site", "platforms");
const { environments } = JSON.parse(readFileSync(join(root, "sdk", "environments.json"), "utf8"));

const STATUS = {
  available: "Available: stable, every conformance check passing",
  beta: "Beta: usable, tested on a real runtime, conformance partial",
  experimental: "Experimental: first real runs passed, more to measure",
  planned: "Planned: not usable yet",
};
const SUPPORT = { supported: "Supported", partial: "Partial", fallback: "Fallback", unavailable: "Not available" };
const TIER = { escrow: "Code escrow", license: "Licence check and signed releases", none: "No licence check; releases are signed" };
const DIALECT = { LuaJIT: "LuaJIT" };
const CAP_ORDER = ["events", "logging", "storage", "players", "permissions", "commands", "config", "ui", "http", "licensing", "perks", "presence"];

/** Registry text inside markdown: `<resource>` would be read as an HTML tag. */
const text = (s) => String(s ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cell = (s) => text(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const date = (iso) => (iso ? iso.slice(0, 10) : "");
const sides = (s) => (s.includes("server") && s.includes("client") ? "Server and client" : s.includes("server") ? "Server only" : s.includes("client") ? "Client only" : "Not declared");
const languages = (e) => {
  const lua = (e.luaDialects ?? []).map((d) => (DIALECT[d] ?? `Lua ${d}`)).join(", ");
  const others = (e.languages ?? []).filter((l) => l !== "lua").map((l) => ({ ts: "TypeScript", js: "JavaScript" })[l] ?? l);
  return [lua || "Lua", ...others].join("; ");
};
const isProbe = (pkg) => /^sg_probe(_|$)/.test(pkg) || /^sg_xlang_/.test(pkg);

/** SETUP.md as a section of this page: its own headings one level down. */
function setupOf(e) {
  const md = (e.setupMarkdown ?? "").trim();
  if (!md) return e.status === "planned" ? "Planned: there are no setup steps for it." : "There are no setup steps for this platform.";
  let fence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) fence = !fence;
      return !fence && /^#{1,5} /.test(line) ? `#${line}` : line;
    })
    .join("\n");
}

function page(e) {
  const i = e.integration;
  const p = e.protection;
  const out = [];
  out.push("---");
  out.push(`title: ${e.name}`);
  out.push(`description: How SCRIPT//GO scripts run on ${e.name}: setup, capabilities, protection, limits and the real runs behind its status.`);
  out.push("---", "");
  out.push(`${e.summary}`, "");
  out.push(`This page is generated from the SDK's platform registry (\`sdk/environments.json\`) and the adapter's \`SETUP.md\`. The [${e.name} page](/environments/${e.slug}) on the site is the short version.`, "");
  out.push("| | |", "|---|---|");
  out.push(`| Status | ${cell(STATUS[e.status] ?? e.status)} |`);
  out.push(`| Runs on | ${cell(sides(e.sides ?? []))} |`);
  out.push(`| Languages | ${cell(languages(e))} |`);
  out.push(`| Protection | ${cell(TIER[p.tier])}${p.tier !== "none" ? (p.state === "available" ? (p.optIn ? ", an opt-in server feature" : "") : ", planned") : ""} |`);
  if (i) out.push(`| Runtime | ${cell(i.runtime)} |`);
  out.push("");

  if (i) {
    const code = e.slug === "dotnet" ? "sdk/dotnet" : `sdk/adapters/${e.slug}`;
    out.push("## How it runs", "", i.summary, "", `The adapter's code and README: [\`${code}\`](https://github.com/scriptgo-hq/scriptgo-sdk/tree/main/${code}).`, "");
  }

  out.push("## Set up", "", setupOf(e), "");

  const caps = CAP_ORDER.filter((c) => e.capabilities?.[c]).concat(Object.keys(e.capabilities ?? {}).filter((c) => !CAP_ORDER.includes(c)));
  if (caps.length) {
    out.push("## Capabilities", "", "What the adapter provides. See [SDK and capabilities](/docs/sdk/capabilities) for what each one is.", "");
    out.push("| Capability | Support | Note |", "|---|---|---|");
    for (const c of caps) out.push(`| \`${c}\` | ${SUPPORT[e.capabilities[c]] ?? e.capabilities[c]} | ${cell(e.capabilityNotes?.[c] ?? "")} |`);
    out.push("");
  }

  out.push("## Protection", "", text(p.note || TIER[p.tier]), "", "See [Protect your work](/docs/protect-your-work) for what protection does and does not do.", "");

  if (e.platformRulesNote) {
    out.push(
      "## The platform's own rules",
      "",
      text(e.platformRulesNote),
      "",
      "This is the platform's rule, shown as information: whoever runs a script there answers for following it. It does not change what can be sold on SCRIPT//GO. See [the rules](/docs/selling#the-rules).",
      "",
    );
  }

  if (e.limitations?.length) {
    out.push("## Limits", "", ...e.limitations.map((l) => `- ${text(l)}`), "");
  }

  out.push("## Real runs", "");
  if (!e.proof?.length) {
    out.push(e.blockedOn ? `No real run yet. ${text(e.blockedOn)}` : "No real run yet.", "");
  } else {
    out.push(
      `Each row is a \`scriptgo verify\` run on ${e.name} itself, not on a mock or an emulator: the package started there and its own tests reported back. Rows marked *probe* are SCRIPT//GO's conformance probes, which exercise the runtime and are never published as packages. See [how a status is earned](/docs/environments#how-a-status-is-earned).`,
      "",
    );
    out.push("| Script | Version | Ran on | Adapter | Checks passed | Date |", "|---|---|---|---|---|---|");
    const rows = [...e.proof].sort((a, b) => Number(isProbe(a.package)) - Number(isProbe(b.package)) || a.package.localeCompare(b.package) || a.runtime.localeCompare(b.runtime));
    for (const r of rows) {
      const ran = r.lua && !r.runtime.includes(r.lua) ? `${r.runtime} · ${r.lua}` : r.runtime;
      out.push(`| \`${r.package}\`${isProbe(r.package) ? " *probe*" : ""} | ${cell(r.version)} | ${cell(ran)} | ${cell(r.adapterVersion)} | ${r.checksPassed}/${r.checks} | ${date(r.ranAt)} |`);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

const pages = Object.fromEntries(environments.filter((e) => e.integration).map((e) => [`${e.slug}.md`, page(e)]));

if (process.argv.includes("--check")) {
  const stale = [];
  for (const [file, text] of Object.entries(pages)) {
    const f = join(outDir, file);
    if (!existsSync(f) || readFileSync(f, "utf8") !== text) stale.push(file);
  }
  const extra = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".md") && !pages[f]) : [];
  if (stale.length || extra.length) {
    console.error(`docs/site/platforms is out of date (${[...stale, ...extra].join(", ")}): run node tools/gen-platform-docs.mjs`);
    process.exit(1);
  }
  console.log(`docs/site/platforms is up to date (${Object.keys(pages).length} pages)`);
} else {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [file, text] of Object.entries(pages)) writeFileSync(join(outDir, file), text);
  console.log(`wrote docs/site/platforms (${Object.keys(pages).length} pages)`);
}
