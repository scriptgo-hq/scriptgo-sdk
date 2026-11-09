// The conformance probe in TypeScript: the checks of sdk/conformance/sg_probe/server/probe.lua,
// same names, same order, same output. Prints one line per check, `SGCHECK PASS <name>` or
// `SGCHECK FAIL <name> <detail>`, then `SGCHECK DONE env=<environment> lang=ts pass=<n> fail=<n>`.
// The export `results` returns the same data. The packages it calls (sg_inventory, sg_eventbus,
// sg_permissions) are Lua: every export call and event here crosses languages.
//
// Lua answers several values where JavaScript answers one: `exports.res.fn()` gives the first,
// `ScriptGo.exports.invoke(res, fn, ...)` gives them all as an array (used for `ok, why`).

type Check = boolean | [boolean, unknown?];

const results = { pass: 0, fail: 0, lines: [] as string[], done: false };

function record(name: string, ok: boolean, detail?: unknown): void {
  let line: string;
  if (ok) {
    results.pass++;
    line = `SGCHECK PASS ${name}`;
  } else {
    results.fail++;
    line = `SGCHECK FAIL ${name}${detail !== undefined ? ` ${String(detail)}` : ""}`;
  }
  results.lines.push(line);
  print(line);
}

// Runs one check; an exception inside it is a failure, not a crash of the probe.
async function check(name: string, fn: () => Check | Promise<Check>): Promise<void> {
  try {
    const verdict = await fn();
    if (Array.isArray(verdict)) record(name, verdict[0] === true, verdict[1]);
    else record(name, verdict === true);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    record(name, false, `raised: ${err.code ?? err.message ?? String(e)}`);
  }
}

interface Named { name?: string; owner?: string }
const contains = (list: unknown, pred: (v: Named) => boolean): boolean => Array.isArray(list) && list.some((v) => pred(v as Named));

const bus: { n?: number; seq?: number; publisher?: string }[] = [];
AddEventHandler("sgbus:probe.ping", (payload: { n?: number } | undefined, meta: { seq?: number; publisher?: string } | undefined) => {
  bus.push({ n: payload?.n, seq: meta?.seq, publisher: meta?.publisher });
});

async function run(): Promise<void> {
  const env = ScriptGo.runtime.environment();

  await check("runtime.side", () => [ScriptGo.runtime.side() === "server", ScriptGo.runtime.side()]);
  await check("resource.name", () => ScriptGo.resource.name() === "sg_probe_ts" && GetCurrentResourceName() === "sg_probe_ts");

  await check("storage.roundtrip", () => {
    const ok = ScriptGo.storage.set("probe:value", { a: 1, list: ["x", "y"], flag: true });
    const v = ScriptGo.storage.get("probe:value") as { a?: number; list?: string[]; flag?: boolean } | undefined;
    return [ok !== false && typeof v === "object" && v !== null && v.a === 1 && v.list?.[1] === "y" && v.flag === true, ok];
  });
  await check("storage.delete", () => {
    ScriptGo.storage.delete("probe:value");
    return ScriptGo.storage.get("probe:value") == null;
  });

  await check("time.now", () => {
    const t = ScriptGo.time.now();
    return [typeof t === "number" && t > 1700000000, t];
  });
  await check("time.monotonic", async () => {
    const a = ScriptGo.time.monotonic();
    await Wait(50);
    const b = ScriptGo.time.monotonic();
    return [typeof a === "number" && b >= a, `${a} -> ${b}`];
  });

  await check("capabilities.declared", () => {
    for (const c of ["events", "logging", "storage", "players", "permissions", "config"]) {
      if (!ScriptGo.capabilities.has(c)) return [false, c];
    }
    return true;
  });
  await check("capabilities.refusal", () => {
    if (ScriptGo.capabilities.has("http")) return [true, "http available here"];
    // A host may refuse when the member is read or when it is called: both are inside the try.
    try {
      ScriptGo.http.request({ url: "http://127.0.0.1/" });
      return [false, "no refusal"];
    } catch (e) {
      const code = (e as { code?: string }).code ?? String(e);
      return [code.startsWith("capability_unavailable:http@"), code];
    }
  });

  await check("players.list", () => Array.isArray(ScriptGo.players.list()));
  await check("players.invalid_id", () => ScriptGo.players.name(0) == null && ScriptGo.players.identifier(-3) == null);
  await check("permissions.console", () => ScriptGo.permissions.has(0, "anything.at.all") === true);
  await check("config.default", () => ScriptGo.config.get("probe_missing_key", 42) === 42);

  await check("promise.local", async () => {
    const late = await new Promise<string>((resolve) => SetTimeout(10, () => resolve("late")));
    return late === "late";
  });

  // Cross-resource exports, synchronous proxy.
  await check("exports.sync", () => {
    const items = exports.sg_inventory.items();
    return [contains(items, (d) => d.name === "water"), typeof items];
  });
  await check("exports.define_item", () => {
    const [ok, why] = ScriptGo.exports.invoke("sg_inventory", "defineItem", { name: "probe_gem", label: "Probe gem", weight: 0.1, stack: 5 });
    const items = exports.sg_inventory.items();
    return [ok === true && contains(items, (d) => d.name === "probe_gem"), why];
  });
  await check("exports.refusal", () => {
    const [ok, why] = ScriptGo.exports.invoke("sg_inventory", "add", 0, "water", 1);
    return [ok === false && typeof why === "string", why];
  });

  // Cross-resource exports, asynchronous.
  await check("exports.async", async () => {
    const [stats] = (await ScriptGo.exports.call("sg_eventbus", "stats")) as [{ topics?: unknown } | undefined];
    return [typeof stats === "object" && stats !== null && typeof stats.topics === "number", typeof stats];
  });

  // EventBus: definition, validation, delivery on the host bus, retained value, ownership.
  await check("bus.define", () =>
    exports.sg_eventbus.defineTopic("probe.ping", {
      schema: { type: "table", fields: { n: { type: "number", integer: true } } }, retain: true,
    }) === true);
  await check("bus.publish", () => {
    const [ok, seq] = ScriptGo.exports.invoke("sg_eventbus", "publish", "probe.ping", { n: 7 });
    return [ok === true && seq === 1, seq];
  });
  await check("bus.reject", () => {
    const [ok, why] = ScriptGo.exports.invoke("sg_eventbus", "publish", "probe.ping", { n: "seven" });
    return [ok === false && typeof why === "string", why];
  });
  await check("bus.delivery", async () => {
    await Wait(100);
    return [bus.length === 1 && bus[0]!.n === 7 && bus[0]!.publisher === "sg_probe_ts", `${bus.length} ${bus[0]?.publisher}`];
  });
  await check("bus.retained", () => {
    const [payload, meta] = ScriptGo.exports.invoke("sg_eventbus", "last", "probe.ping") as [{ n?: number } | undefined, { seq?: number } | undefined];
    return payload?.n === 7 && meta?.seq === 1;
  });
  await check("bus.owner", () => contains(exports.sg_eventbus.topics(), (t) => t.name === "probe.ping" && t.owner === "sg_probe_ts"));

  // Permissions kit: runtime role definition with inheritance, and cycle refusal.
  await check("perms.define_role", () => {
    const [ok, why] = ScriptGo.exports.invoke("sg_permissions", "defineRole", "probe_role", { inherits: ["user"], privileges: ["probe.use"] });
    const roles = exports.sg_permissions.listRoles();
    return [ok === true && contains(roles, (r) => r.name === "probe_role"), why];
  });
  await check("perms.cycle", () => {
    const [ok, why] = ScriptGo.exports.invoke("sg_permissions", "defineRole", "user", { inherits: ["probe_role"], privileges: [] });
    return [ok === false && typeof why === "string", why];
  });

  results.done = true;
  print(`SGCHECK DONE env=${env} lang=ts pass=${results.pass} fail=${results.fail}`);
}

exports("results", () => results);

CreateThread(async () => {
  await Wait(200); // let the dependencies finish their own start-up work
  await run();
});
