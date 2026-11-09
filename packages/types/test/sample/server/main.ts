// A server script written against @scriptgo/types. It only has to type-check: no DOM, no Node.
const items = new Map<string, Item>();

exports("count", (id: string) => items.get(id)?.count ?? 0);
exports("pair", () => ScriptGo.values(1, "two"));
exports("slow", async (n: number) => {
  await Wait(50);
  return n * 2;
});

AddEventHandler("onResourceStart", (resource) => {
  const name: string = resource;
  print("started", name, GetCurrentResourceName());
});

AddEventHandler("playerDropped", (reason) => {
  const who: number | undefined = source;
  ScriptGo.log.info(`player ${who} left: ${reason.toUpperCase()}`);
});

RegisterNetEvent("inventory:add", (id: string, count: number) => {
  const player = source;
  const item = addItem(items, id, count);
  TriggerClientEvent("inventory:changed", player ?? -1, item);
});

RegisterCommand("give", (src, args, raw) => {
  const [id] = args;
  print(src, id ?? "nothing", raw);
}, true);

CreateThread(async () => {
  await Wait(0);
  const n: number = exports.other_res.count("a");
  const all: unknown[] = ScriptGo.exports.invoke("other_res", "pair");
  const later = await ScriptGo.exports.call("other_res", "slow", 4);
  try {
    exports.other_res.missing();
  } catch (e) {
    if (e instanceof ScriptGoError) print(e.code, e.message, n, all.length, later[0]);
  }
  if (ScriptGo.capabilities.has("storage")) ScriptGo.storage.set("k", { a: 1, list: ["x", "y"] });
  const stored = ScriptGo.storage.get("k");
  print(ScriptGo.json.encode(stored), ScriptGo.json.null === null);
  const res = await ScriptGo.http.request({ url: "https://example.invalid/", method: "POST", headers: { "content-type": "text/plain" } });
  const status: number = res.status;
  ScriptGo.ui.notify(-1, { title: "Hi", message: "there", type: "info" });
  const pets: number = ScriptGo.natives.pets.count("me");
  ScriptGo.natives.pets.rename(1, "Rex");
  const [count]: unknown[] = ScriptGo.natives.invoke("pets", "count", "me");
  print(pets, count);
  const state: "missing" | "stopped" | "starting" | "started" | "failed" = GetResourceState("other_res");
  console.log(ScriptGo.runtime.language(), ScriptGo.runtime.side(), ScriptGo.time.monotonic(), status, pets, state);
  const timer = setTimeout(() => print("later"), 100);
  clearTimeout(timer);
  const id = SetTimeout(10, () => print("later too"));
  ClearTimeout(id);
  const manifest = ScriptGo.resource.manifest();
  print(manifest?.name, manifest?.serverScripts.length, GetConvar("sv_hostname", "local"));
  const licence = await ScriptGo.licensing.verify({ licenseKey: "k", package: "creator/pkg", deploymentToken: "t" });
  print(licence);
});
