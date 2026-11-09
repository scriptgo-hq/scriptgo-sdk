// A FAKE FXServer for the runner's unit tests (packages/cli/test/fivem.test.ts). It is not FiveM:
// it runs no Lua and proves nothing about a package. It only prints the console lines the real
// server prints (strings taken from the FXServer build 38435 binaries) so that the runner's
// process handling and console parsing can be tested without a licence key. A report it leads to
// is never written to verification/reports.
//
//   node fake-fxserver.mjs +set sv_licenseKey <key> +exec server.cfg
//
// FAKE_FX_SCRIPT_ERROR=<resource> prints a script error for that resource;
// FAKE_FX_SGCHECK=<resource> prints two self-checks and DONE for it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
let key = "";
let cfg = "";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "+set" && argv[i + 1] === "sv_licenseKey") key = argv[i + 2] ?? "";
  if (argv[i] === "+exec") cfg = argv[i + 1] ?? "";
}
const pad = (channel) => `[${channel.padStart(20)}]`;
const out = (channel, text) => process.stdout.write(`${pad(channel)} ${text}\n`);

const names = [];
for (const line of readFileSync(join(process.cwd(), cfg), "utf8").split(/\r?\n/)) {
  const m = /^ensure (\S+)/.exec(line);
  if (m) names.push(m[1]);
}
out("resources", "Scanning resources.");
out("resources", `Found ${names.length} resources.`);
if (!key) {
  const msg = "This server does not have a license key specified. Please set the sv_licenseKey console variable to a key from https://portal.cfx.re/servers/registration-keys.";
  out("svadhesive", `Error: ${msg}`);
  process.stderr.write(`Fatal Error: ${msg}\n`);
  process.exit(1);
}
out("svadhesive", "Authenticating server license key...");
out("svadhesive", "Server license key authentication succeeded. Welcome!");
for (const name of names) {
  if (existsSync(join(process.cwd(), "resources", name, "fxmanifest.lua"))) out("resources", `Started resource ${name}`);
  else out("citizen-server-impl", `\u001b[33mCouldn't start resource ${name}.\u001b[0m`);
}
if (process.env.FAKE_FX_SCRIPT_ERROR) {
  const r = process.env.FAKE_FX_SCRIPT_ERROR;
  out(`script:${r}`, `^1SCRIPT ERROR: @${r}/server.lua:1: boom^7`);
}
if (process.env.FAKE_FX_SGCHECK) {
  const r = process.env.FAKE_FX_SGCHECK;
  out(`script:${r}`, "SGCHECK PASS runtime.side");
  out(`script:${r}`, "SGCHECK FAIL storage.roundtrip nope");
  out(`script:${r}`, "SGCHECK DONE env=fivem pass=1 fail=1");
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (/^quit\b/m.test(chunk)) process.exit(0);
});
setTimeout(() => process.exit(2), 30000);
