// scriptgo login --token <sg_pat_...> [--api http://localhost:4100]
//
// Checks a personal access token against GET /v1/me and saves it to ~/.scriptgo/credentials.json
// (mode 0600). Create tokens in the web app under Account > Tokens. `--token -` reads it from
// stdin so it stays out of the shell history.
import { readFileSync } from "node:fs";
import { parseArgs } from "../lib/args.ts";
import { ApiClient, describeError, loadCredentials, saveCredentials } from "./_api-client.ts";

export const summary = "Save a personal access token for publish/add/license";

export async function run(args: string[]): Promise<number> {
  const a = parseArgs(args, { booleans: ["help"] });
  if (a.bools.has("help")) {
    console.log("scriptgo login --token <sg_pat_...|-> [--api <url>]");
    return 0;
  }
  let token = a.flags.token ?? process.env.SCRIPTGO_TOKEN ?? "";
  if (token === "-") token = readFileSync(0, "utf8");
  token = token.trim();
  if (!token) {
    console.error("scriptgo login: pass --token <sg_pat_...> (or --token - to read it from stdin)");
    return 2;
  }
  if (!token.startsWith("sg_pat_")) {
    console.error("scriptgo login: personal access tokens start with sg_pat_");
    return 2;
  }
  const api = (a.flags.api ?? loadCredentials().api).replace(/\/$/, "");
  try {
    const me = await new ApiClient(api, token).get<{ user: { id: string; email: string; name: string }; creatorProfile: { username: string } | null }>("/v1/me");
    const file = saveCredentials({ api, token });
    const who = me.data.creatorProfile ? `${me.data.user.name} (creator ${me.data.creatorProfile.username})` : me.data.user.name;
    console.log(`logged in to ${api} as ${who}; token saved to ${file}`);
    console.log(`account id: ${me.data.user.id}   (give it to a creator who wants to grant you a free license)`);
    if (!me.data.creatorProfile) console.log("note: this account has no creator profile yet, so `scriptgo publish` will be refused");
    return 0;
  } catch (e) {
    console.error(`scriptgo login: ${describeError(e)}`);
    return 1;
  }
}
