// The pinned runtime for the CC: Tweaked (Minecraft) environment, in tools/runtimes/minecraft/
// (gitignored): a portable JDK, Fabric's server launcher, Fabric API and CC: Tweaked, each checked
// against a SHA-256 written here.
//
//   node sdk/adapters/cctweaked/runtime.mjs            download what is missing, then check
//   node sdk/adapters/cctweaked/runtime.mjs --check    check only (exit 1 when something is wrong)
//   node sdk/adapters/cctweaked/runtime.mjs --harness  also set up the cc-core harness (fast tests
//                                                      without Minecraft; see SETUP.md)
//
// Minecraft itself is never downloaded by this script. The Minecraft EULA says that downloading or
// using the game means agreeing to it, and the operator must accept it themselves. Fabric's
// launcher fetches the vanilla server jar from Mojang the first time the server starts, and the
// server only starts once server/eula.txt says eula=true: written by the operator, by hand or with
// `scriptgo verify --env cctweaked --accept-minecraft-eula` (see SETUP.md). Never a tracked file.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/**
 * tools/runtimes/minecraft (gitignored), or SCRIPTGO_MINECRAFT_DIR for this repository's own runs:
 * the JDK, server and worlds take several hundred MB, so they may live on another disk.
 */
export function runtimeDir(root = repoRoot) {
  const override = process.env.SCRIPTGO_MINECRAFT_DIR;
  if (override && root === repoRoot) return resolve(override);
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
 * Whether the operator accepted the Minecraft EULA: `eula=true` in server/eula.txt, written by the
 * operator (by hand, or with `scriptgo verify --accept-minecraft-eula`).
 */
export function eulaState(root = repoRoot) {
  const file = join(serverDir(root), "eula.txt");
  if (!existsSync(file)) return { accepted: false, file, reason: "missing" };
  const text = readFileSync(file, "utf8");
  return /^\s*eula\s*=\s*true\s*$/im.test(text) ? { accepted: true, file, reason: "" } : { accepted: false, file, reason: "eula is not true" };
}

/** A path for messages: relative to the repository when inside it. */
export function shown(p, root = repoRoot) {
  const r = relative(root, p);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r.split(sep).join("/") : p;
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

// The cc-core harness -----------------------------------------------------------------------------
// CC: Tweaked's own core classes and Lua VM, run by harness/CcCoreRun.java without Minecraft. The
// libraries Minecraft would otherwise provide come from Maven Central (SHA-1 checked against Maven
// Central's .sha1 files once, by hand; SHA-256 pinned here); the rest are the jars nested in the
// pinned CC: Tweaked jar, so covered by its digest, and checked again here.
const MAVEN = "https://repo1.maven.org/maven2";
export const HARNESS_LIBS = [
  { file: "guava-31.1-jre.jar", path: "com/google/guava/guava/31.1-jre", sha256: "a42edc9cab792e39fe39bb94f3fca655ed157ff87a8af78e1d6ba5b07c4a00ab", license: "Apache-2.0" },
  { file: "failureaccess-1.0.1.jar", path: "com/google/guava/failureaccess/1.0.1", sha256: "a171ee4c734dd2da837e4b16be9df4661afab72a41adaf31eb84dfdaf936ca26", license: "Apache-2.0" },
  { file: "fastutil-8.5.9.jar", path: "it/unimi/dsi/fastutil/8.5.9", sha256: "9578bf2a1700cf20d21746a2ee89e57ba1abbd37fa9feda68ff5e9a28473a7f9", license: "Apache-2.0" },
  { file: "netty-buffer-4.1.82.Final.jar", path: "io/netty/netty-buffer/4.1.82.Final", sha256: "a7ce7f6d8c1e82b044cd56765dab4338251596416de03b1f9a05d7402429c29d", license: "Apache-2.0" },
  { file: "netty-codec-4.1.82.Final.jar", path: "io/netty/netty-codec/4.1.82.Final", sha256: "170c0ce091c2e1cc1d952d87a6a30deb773922507bbc609b962b539f03f53407", license: "Apache-2.0" },
  { file: "netty-common-4.1.82.Final.jar", path: "io/netty/netty-common/4.1.82.Final", sha256: "d5923db1cc68b26baf5368f1f76ec2c6100d12db8406c6de00eb6dbc08052550", license: "Apache-2.0" },
  { file: "netty-handler-4.1.82.Final.jar", path: "io/netty/netty-handler/4.1.82.Final", sha256: "31015505983dc57eec491ad4873411ba51f0f3beb24d22d509336c72511019cb", license: "Apache-2.0" },
  { file: "netty-resolver-4.1.82.Final.jar", path: "io/netty/netty-resolver/4.1.82.Final", sha256: "4cfeba7ec535964a35722178aeecc87ec186dba0203d04389a850e8e62575383", license: "Apache-2.0" },
  { file: "netty-transport-4.1.82.Final.jar", path: "io/netty/netty-transport/4.1.82.Final", sha256: "c210069be4ab4120f5ac7cb5e4a126d3a007e78a64fd44c9971220e013dbaef1", license: "Apache-2.0" },
  { file: "slf4j-api-2.0.17.jar", path: "org/slf4j/slf4j-api/2.0.17", sha256: "7b751d952061954d5abfed7181c1f645d336091b679891591d63329c622eb832", license: "MIT" },
  { file: "slf4j-nop-2.0.17.jar", path: "org/slf4j/slf4j-nop/2.0.17", sha256: "3716f83649ec66161a2edefd4f49df34d1dd1c51cdcf941996c6987260f0a829", license: "MIT" },
];
/** Jars nested in the CC: Tweaked jar (META-INF/jars/), extracted for the harness. */
export const HARNESS_NESTED = [
  { file: "cobalt-0.9.9.jar", sha256: "eba454ea243d5dffed25fcad177a1e86aa6383a953efaec826a8c315ab924454", license: "MIT (Cobalt, a LuaJ fork)" },
  { file: "jzlib-1.1.3.jar", sha256: "8bcce4d82593a740816de5fd591b713954c38c9bd4cba970388bf80d8a35786f", license: "BSD-3-Clause" },
  { file: "netty-codec-http-4.1.82.Final.jar", sha256: "dc174d831df57254d2fbae1ec7c6654ee50f5d6a573a91cc0ecdc8d28b71026d", license: "Apache-2.0" },
  { file: "netty-codec-socks-4.1.82.Final.jar", sha256: "2be42028e601f65eb1fc0bfc340cd9ba140f6881261f98caff8d550f7fc7ec23", license: "Apache-2.0" },
  { file: "netty-handler-proxy-4.1.82.Final.jar", sha256: "c554c0904e9d037b264d614dd22caa8fecf791585465da1a394ea386be2b27f1", license: "Apache-2.0" },
];

export function harnessDir(root = repoRoot) {
  return join(runtimeDir(root), "harness");
}

const SEP = process.platform === "win32" ? ";" : ":";

function harnessJars(root) {
  const lib = join(harnessDir(root), "lib");
  return [ccTweakedJar(root), ...[...HARNESS_LIBS, ...HARNESS_NESTED].map((l) => join(lib, l.file))];
}

/** The harness's classpath (CC: Tweaked jar, its libraries, the compiled runner), or null when not set up. */
export function harnessClasspath(root = repoRoot) {
  const classes = join(harnessDir(root), "classes");
  const parts = [...harnessJars(root), classes];
  if (!parts.every((p) => existsSync(p)) || !existsSync(join(classes, "CcCoreRun.class"))) return null;
  return parts.join(SEP);
}

/** Downloads and checks the harness libraries, extracts the nested jars and compiles the runner. */
export async function ensureHarness(root = repoRoot, log = console.log) {
  if (!checkRuntime(root).every((r) => r.ok)) throw new Error("the runtime is incomplete: run node sdk/adapters/cctweaked/runtime.mjs first");
  const javac = findJava(root, "javac");
  const jarTool = findJava(root, "jar");
  if (!javac || !jarTool) throw new Error("javac or jar missing from the pinned JDK");
  const lib = join(harnessDir(root), "lib");
  mkdirSync(lib, { recursive: true });
  for (const l of HARNESS_LIBS) {
    const target = join(lib, l.file);
    if (existsSync(target) && sha256File(target) === l.sha256) continue;
    log(`downloading ${l.file}`);
    const tmp = target + ".part";
    rmSync(tmp, { force: true });
    await download(`${MAVEN}/${l.path}/${l.file}`, tmp);
    const got = sha256File(tmp);
    if (got !== l.sha256) {
      rmSync(tmp, { force: true });
      throw new Error(`${l.file}: SHA-256 ${got} does not match the pinned ${l.sha256}`);
    }
    rmSync(target, { force: true });
    renameSync(tmp, target);
  }
  const nestedMissing = HARNESS_NESTED.filter((n) => !existsSync(join(lib, n.file)) || sha256File(join(lib, n.file)) !== n.sha256);
  if (nestedMissing.length > 0) {
    const unpack = join(harnessDir(root), ".unpack");
    rmSync(unpack, { recursive: true, force: true });
    mkdirSync(unpack, { recursive: true });
    const x = spawnSync(jarTool, ["xf", ccTweakedJar(root), ...nestedMissing.map((n) => `META-INF/jars/${n.file}`)], { cwd: unpack, encoding: "utf8" });
    if (x.status !== 0) throw new Error(`cannot extract the nested jars: ${(x.stderr || x.stdout || "").trim()}`);
    for (const n of nestedMissing) {
      const from = join(unpack, "META-INF", "jars", n.file);
      const got = existsSync(from) ? sha256File(from) : "missing";
      if (got !== n.sha256) throw new Error(`${n.file}: SHA-256 ${got} does not match the pinned ${n.sha256}`);
      rmSync(join(lib, n.file), { force: true });
      renameSync(from, join(lib, n.file));
    }
    rmSync(unpack, { recursive: true, force: true });
  }
  const classes = join(harnessDir(root), "classes");
  rmSync(classes, { recursive: true, force: true });
  mkdirSync(classes, { recursive: true });
  const c = spawnSync(javac, ["-d", classes, "-cp", harnessJars(root).join(SEP), join(here, "harness", "CcCoreRun.java")], { encoding: "utf8" });
  if (c.status !== 0) throw new Error(`javac failed: ${(c.stderr || c.stdout || "").trim()}`);
  return harnessClasspath(root);
}

function printState(results, root) {
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.pin.id.padEnd(22)} ${r.pin.version}  ${r.ok ? "" : r.state}`);
  const java = findJava(root);
  console.log(`runtime: ${shown(runtimeDir(root), root)}`);
  console.log(`java: ${java ? shown(java, root) : "not found"}`);
  const e = eulaState(root);
  if (e.accepted) {
    console.log(`Minecraft EULA: accepted by the operator (${shown(e.file, root)})`);
  } else {
    console.log(`Minecraft EULA: not accepted on this machine (${e.reason}). No Minecraft server runs until the operator`);
    console.log(`reads ${EULA_URL} and accepts it themselves: scriptgo verify --env cctweaked --accept-minecraft-eula,`);
    console.log(`or eula=true written to ${shown(e.file, root)}.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkOnly = process.argv.includes("--check");
  try {
    const results = checkOnly ? checkRuntime() : await ensureRuntime();
    printState(results, repoRoot);
    if (process.argv.includes("--harness") && results.every((r) => r.ok)) {
      if (!checkOnly) await ensureHarness();
      console.log(`cc-core harness (no Minecraft, fast tests only): ${harnessClasspath() ? "ready" : "not set up (run with --harness)"}`);
    }
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
