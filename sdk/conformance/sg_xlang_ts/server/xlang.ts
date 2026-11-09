// The TypeScript half of the cross-language pair: exports and an event handler sg_xlang_lua calls,
// then, on "xlang:go", its own checks against the Lua half. Same SGCHECK line format as sg_probe;
// the Lua half prints the final DONE line once this one reports back on "xlang:tsDone".
let pass = 0;
let fail = 0;

function record(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass++;
    print(`SGCHECK PASS ${name}`);
  } else {
    fail++;
    print(`SGCHECK FAIL ${name}${detail !== undefined ? ` ${String(detail)}` : ""}`);
  }
}

async function check(name: string, fn: () => boolean | [boolean, unknown?] | Promise<boolean | [boolean, unknown?]>): Promise<void> {
  try {
    const v = await fn();
    if (Array.isArray(v)) record(name, v[0] === true, v[1]);
    else record(name, v === true);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    record(name, false, `raised: ${err.code ?? err.message ?? String(e)}`);
  }
}

// Exports Lua calls.
exports("add", (a: number, b: number) => a + b);
exports("echo", (v: unknown) => v);
exports("pair", () => ScriptGo.values(1, "two"));
exports("types", (i: number, f: number, big: number) => ScriptGo.values(typeof i, Number.isInteger(i), f, big > 2 ** 52));
exports("slow", async (n: number) => {
  await Wait(50);
  return n * 2;
});
exports("fail", () => {
  throw new Error("nope");
});
exports("whoCalls", () => GetInvokingResource());

// Event Lua sends: answer on another event.
AddEventHandler("xlang:ping", (p: { x: number }) => {
  TriggerEvent("xlang:pong", { reply: p.x + 1, list: [1, 2, 3] });
});

let tsPong: [number, string] | undefined;
AddEventHandler("xlang:tsPong", (n: number, kind: string) => {
  tsPong = [n, kind];
});

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

AddEventHandler("xlang:go", () => {
  CreateThread(async () => {
    const lua = exports.sg_xlang_lua;
    await check("xlang.ts_sync_call", () => {
      const r = lua.sum([1, 2, 3]);
      return [r === 6, r];
    });
    await check("xlang.ts_multi_values", () => {
      const all = ScriptGo.exports.invoke("sg_xlang_lua", "multi");
      return [deepEqual(all, [1, "b", true]), JSON.stringify(all)];
    });
    await check("xlang.ts_async_call", async () => {
      const r = await ScriptGo.exports.call("sg_xlang_lua", "slowDouble", 3);
      return [deepEqual(r, [6]), JSON.stringify(r)];
    });
    await check("xlang.ts_error", () => {
      try {
        lua.fail();
        return [false, "no error"];
      } catch (e) {
        const err = e as { name?: string; code?: string; message?: string };
        // Lua sees the error "export <res>:<fn> <reason>"; JavaScript gets the same text as the
        // message and the reason alone as the code.
        return [
          err.name === "ScriptGoError" && String(err.message).startsWith("export sg_xlang_lua:fail ") && String(err.code).includes("lua says no"),
          err.message,
        ];
      }
    });
    await check("xlang.ts_missing_export", async () => {
      try {
        await ScriptGo.exports.call("sg_xlang_lua", "missing");
        return [false, "resolved"];
      } catch (e) {
        const code = (e as { code?: string }).code;
        return [code === "export_not_found", code];
      }
    });
    await check("xlang.ts_table_shapes", () => {
      const v = lua.sparse() as { map: Record<string, string>; empty: unknown; int: number; float: number };
      return [
        deepEqual(v.map, { 1: "a", 3: "c" }) && Array.isArray(v.empty) && v.empty.length === 0 && v.int === 3 && v.float === 1.5,
        JSON.stringify(v),
      ];
    });
    await check("xlang.ts_event_roundtrip", async () => {
      tsPong = undefined;
      TriggerEvent("xlang:tsPing", 1);
      for (let i = 0; i < 50 && tsPong === undefined; i++) await Wait(10);
      return [tsPong !== undefined && tsPong[0] === 2 && tsPong[1] === "integer", JSON.stringify(tsPong)];
    });
    TriggerEvent("xlang:tsDone", pass, fail);
  });
});
