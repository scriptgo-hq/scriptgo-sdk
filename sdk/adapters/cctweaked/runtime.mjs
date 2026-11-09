// The pinned runtime for the CC: Tweaked (Minecraft) environment, in tools/runtimes/minecraft/
// (gitignored): a portable JDK, Fabric's server launcher, Fabric API and CC: Tweaked, each checked
// against a SHA-256 written here.
//
//   node sdk/adapters/cctweaked/runtime.mjs            download what is missing, then check
//   node sdk/adapters/cctweaked/runtime.mjs --check    check only (exit 1 when something is wrong)
//
// Minecraft itself is never downloaded by this script. The Minecraft EULA says that downloading or
// using the game means agreeing to it, and only the machine's owner can agree. Fabric's launcher
// fetches the vanilla server jar from Mojang the first time the server starts, and the server only
// starts once the owner has written `eula=true` into tools/runtimes/minecraft/server/eula.txt
// (see sdk/adapters/cctweaked/SETUP.md). Nothing in this repository writes that file.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..", "..");

export const EULA_URL = "https://www.minecraft.net/en-us/eula";
export const MINECRAFT_VERSION = "1.20.1";
export const CC_TWEAKED_VERSION = "1.121.0";
export const FABRIC_LOADER_VERSION = "0.20.1";

/**
 * The vanilla server Fabric's launcher downloads at the first start (from Mojang's version
 * manifest for 1.20.1). Recorded so a run can check what it ran; never fetched by this script.
 */
export const VANILLA_SERVER = { version: MINECRAFT_VERSION, sha1: "84194a2f286ef7c14ed7ce0090dba59902951553", size: 47791053 };

const platform = `${process.platform}-${process.arch}`;

/**
 * Every file the runtime needs. `dest` is relative to tools/runtimes/minecraft. Archives are
 * unpacked into `dest`. Digests: the JDK's from the Adoptium API, the mods' SHA-512 from Modrinth
 * (checked once, by hand) and their SHA-256 computed from the same bytes.
 */
export const PINS = [
  {
    id: "jdk", platforms: ["win32-x64"], version: "Temurin 21.0.13+9", license: "GPL-2.0-only WITH Classpath-exception-2.0",
    url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip",
    sha256: "a4dbaa05fca4bd89d84584e58c459bd732efebb1722af80ab13c6516832004f9", archive: "zip", dest: "jdk",
  },
  {
    id: "jdk", platforms: ["linux-x64"], version: "Temurin 21.0.13+9", license: "GPL-2.0-only WITH Classpath-exception-2.0",
    url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz",
    sha256: "d7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c", archive: "tar.gz", dest: "jdk",
  },
  {
    id: "fabric-server-launcher", version: `Fabric loader ${FABRIC_LOADER_VERSION}, installer 1.1.2, Minecraft ${MINECRAFT_VERSION}`, license: "Apache-2.0",
    url: `https://meta.fabricmc.net/v2/versions/loader/${MINECRAFT_VERSION}/${FABRIC_LOADER_VERSION}/1.1.2/server/jar`,
    sha256: "91bc2142c1fc9ddfac4819612dc74c5759a4c8ef4bb4897f70d289b70ba8787d", dest: "server/fabric-server-launch.jar",
  },
  {
    id: "fabric-api", version: "0.92.12+1.20.1", license: "Apache-2.0",
    url: "https://cdn.modrinth.com/data/P7dR8mSH/versions/rvI2dfzR/fabric-api-0.92.12%2B1.20.1.jar",
    sha256: "4197ff4fbdac13cffccd267c1bc59e9fbabb2b5683a9d5f8023f4b5ea16a1c1e", dest: "server/mods/fabric-api-0.92.12+1.20.1.jar",
  },
  {
    id: "cc-tweaked", version: CC_TWEAKED_VERSION, license: "MPL-2.0, original ComputerCraft parts under the ComputerCraft Public License",
    url: "https://cdn.modrinth.com/data/gu7yAYhd/versions/LFj8qZ7a/cc-tweaked-1.20.1-fabric-1.121.0.jar",
    sha256: "74ea3efd7aa5a2f5b0b53832dc5cb480a195d2979d95b150b7b60c0d299ad3c1", dest: `server/mods/cc-tweaked-${MINECRAFT_VERSION}-fabric-${CC_TWEAKED_VERSION}.jar`,
  },
];

export function runtimeDir(root = repoRoot) {
  return join(root, "tools", "runtimes", "minecraft");
}

/** The server folder: Fabric's launcher, mods/, and (once the owner accepted it) eula.txt. */
export function serverDir(root = repoRoot) {
  return join(runtimeDir(root), "server");
}

export function ccTweakedJar(root = repoRoot) {
  return join(runtimeDir(root), PINS.find((p) => p.id === "cc-tweaked").dest);
}

/** The pins that apply to this machine. */
export function pinsFor(plat = platform) {
  return PINS.filter((p) => !p.platforms || p.platforms.includes(plat));
}

/** java(.exe) of the pinned JDK, or null. */
export function findJava(root = repoRoot, tool = "java") {
  const jdk = join(runtimeDir(root), "jdk");
  if (!existsSync(jdk)) return null;
  const exe = process.platform === "win32" ? `${tool}.exe` : tool;
  for (const d of readdirSync(jdk)) {
    const p = join(jdk, d, "bin", exe);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Whether the machine's owner accepted the Minecraft EULA: `eula=true` in server/eula.txt, written
 * by the owner. Nothing in SCRIPT//GO writes it.
 */
export function eulaState(root = repoRoot) {
  const file = join(serverDir(root), "eula.txt");
  if (!existsSync(file)) return { accepted: false, file, reason: "missing" };
  const text = readFileSync(file, "utf8");
  return /^\s*eula\s*=\s*true\s*$/im.test(text) ? { accepted: true, file, reason: "" } : { accepted: false, file, reason: "eula is not true" };
}

export function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

export function sha1File(p) {
  return createHash("sha1").update(readFileSync(p)).digest("hex");
}

async function download(url, to) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
  mkdirSync(dirname(to), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(to));
}

function unpack(archive, kind, dest) {
  mkdirSync(dest, { recursive: true });
  const r = kind === "zip" && process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`], { encoding: "utf8" })
    : kind === "zip" ? spawnSync("unzip", ["-q", "-o", archive, "-d", dest], { encoding: "utf8" })
    : spawnSync("tar", ["-xzf", archive, "-C", dest], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cannot unpack ${archive}: ${(r.stderr || r.stdout || "").trim()}`);
}

/** Pins of archives remember their digest in a marker file next to what they unpacked. */
function markerOf(dir) {
  return join(dir, ".scriptgo-sha256");
}

/** One line per pin: ok, missing or wrong digest. */
export function checkRuntime(root = repoRoot) {
  const base = runtimeDir(root);
  return pinsFor().map((p) => {
    const target = join(base, p.dest);
    if (!existsSync(target)) return { pin: p, ok: false, state: "missing" };
    if (p.archive) {
      const marker = markerOf(target);
      const got = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
      return { pin: p, ok: got === p.sha256, state: got === p.sha256 ? "ok" : "unpacked without a matching digest" };
    }
    const got = sha256File(target);
    return { pin: p, ok: got === p.sha256, state: got === p.sha256 ? "ok" : `sha256 ${got}` };
  });
}

/** Downloads every missing or wrong pin, refusing any byte that does not match its digest. */
export async function ensureRuntime(root = repoRoot, log = console.log) {
  const base = runtimeDir(root);
  for (const c of checkRuntime(root)) {
    if (c.ok) continue;
    const p = c.pin;
    const target = join(base, p.dest);
    const tmp = join(base, ".download", p.url.split("/").pop().replace(/[^A-Za-z0-9._+-]/g, "_"));
    log(`downloading ${p.id} ${p.version}`);
    rmSync(tmp, { force: true });
    await download(p.url, tmp);
    const got = sha256File(tmp);
    if (got !== p.sha256) {
      rmSync(tmp, { force: true });
      throw new Error(`${p.id}: SHA-256 ${got} does not match the pinned ${p.sha256}; nothing was installed`);
    }
    if (p.archive) {
      rmSync(target, { recursive: true, force: true });
      unpack(tmp, p.archive, target);
      writeFileSync(markerOf(target), p.sha256 + "\n");
      rmSync(tmp, { force: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      rmSync(target, { force: true });
      renameSync(tmp, target);
    }
  }
  rmSync(join(base, ".download"), { recursive: true, force: true });
  return checkRuntime(root);
}

function printState(results, root) {
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.pin.id.padEnd(22)} ${r.pin.version}  ${r.ok ? "" : r.state}`);
  const java = findJava(root);
  console.log(`java: ${java ? java.replace(root, "<repo>") : "not found"}`);
  const e = eulaState(root);
  if (e.accepted) {
    console.log("Minecraft EULA: accepted by this machine's owner (server/eula.txt)");
  } else {
    console.log(`Minecraft EULA: not accepted on this machine (${e.reason}). No Minecraft server runs until the owner`);
    console.log(`reads ${EULA_URL} and, if they agree, writes eula=true to tools/runtimes/minecraft/server/eula.txt.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkOnly = process.argv.includes("--check");
  try {
    const results = checkOnly ? checkRuntime() : await ensureRuntime();
    printState(results, repoRoot);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
