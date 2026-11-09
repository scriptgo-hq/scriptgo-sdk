namespace ScriptGo.Host.Tests;

/// <summary>A Lua resource and a JavaScript resource calling each other: exports both ways, events both ways.</summary>
[TestClass]
public sealed class CrossLanguageTests
{
    private const string JsProvider = """
        exports('add', (a, b) => a + b);
        exports('echo', (v) => v);
        exports('pair', () => ScriptGo.values(1, 'two'));
        exports('types', (i, f, big) => [typeof i, Number.isInteger(i), f, big > 2 ** 52]);
        exports('slow', async (n) => { await Wait(50); return n * 2; });
        exports('fail', () => { throw new Error('nope'); });
        exports('waits', async () => { await Wait(10); return 1; });
        exports('whoCalls', () => GetInvokingResource());
        AddEventHandler('from_lua', (payload) => {
          print('ts got', JSON.stringify(payload));
          TriggerEvent('from_ts', { reply: payload.x + 1, list: [1, 2, 3] });
        });
        CreateThread(async () => {
          await Wait(300);
          print('lsum', exports.xl_lua.lsum([1, 2, 3]));
          print('lmulti', JSON.stringify(ScriptGo.exports.invoke('xl_lua', 'lmulti')));
          const r = await ScriptGo.exports.call('xl_lua', 'lwait', 3);
          print('lwait', JSON.stringify(r));
          try { exports.xl_lua.lfail(); } catch (e) { print('lfail', e.code === undefined ? 'no code' : 'code', e.message); }
          try { await ScriptGo.exports.call('xl_lua', 'missing'); } catch (e) { print('missing', e.code); }
          print('ltypes', JSON.stringify(exports.xl_lua.ltypes()));
        });
        """;

    private const string LuaConsumer = """
        exports("lsum", function(list) local s = 0 for _, v in ipairs(list) do s = s + v end return s end)
        exports("lmulti", function() return 1, "b", true end)
        exports("lwait", function(n) Wait(20) return n * 2 end)
        exports("lfail", function() error("lua says no") end)
        exports("ltypes", function() return { int = 3, float = 1.5, map = { [1] = "a", [3] = "c" }, empty = {} } end)
        AddEventHandler("from_ts", function(p) print("lua got", p.reply, #p.list, math.type(p.reply)) end)
        CreateThread(function()
            Wait(0)
            print("add", exports.xl_ts:add(2, 3))
            local e = exports.xl_ts:echo({ a = { b = { "x", "y" } }, n = 1.25, s = "é" })
            print("echo", e.a.b[2], e.n, e.s)
            print("pair", exports.xl_ts:pair())
            local t = exports.xl_ts:types(3, 1.5, 2 ^ 60)
            print("types", t[1], t[2], t[3], t[4])
            print("slow", ScriptGo.exports.call("xl_ts", "slow", 4):await())
            local ok, err = pcall(function() return exports.xl_ts:fail() end)
            print("fail", ok, err)
            local ok2, err2 = pcall(function() return exports.xl_ts:waits() end)
            print("waits", ok2, err2)
            print("who", exports.xl_ts:whoCalls())
            TriggerEvent("from_lua", { x = 41 })
        end)
        """;

    [TestMethod]
    public void LuaAndJavaScriptCallEachOther()
    {
        using var sb = new Sandbox();
        sb.Resource("xl_ts", Sandbox.Manifest("xl_ts", ["server/main.ts.js"], []), ("server/main.ts.js", JsProvider));
        sb.Resource("xl_lua", Sandbox.Manifest("xl_lua", ["server/main.lua"], ["xl_ts"]), ("server/main.lua", LuaConsumer));
        sb.Start("xl_ts", "xl_lua");
        sb.Host.RunFor(600);
        var p = sb.Printed;
        var log = sb.Log.ToString();
        // Lua → JavaScript
        CollectionAssert.Contains(p, "add\t5", log);
        CollectionAssert.Contains(p, "echo\ty\t1.25\té", log);
        CollectionAssert.Contains(p, "pair\t1\ttwo", log);
        CollectionAssert.Contains(p, "types\tnumber\ttrue\t1.5\ttrue", log);
        CollectionAssert.Contains(p, "slow\t8", log);
        Assert.IsTrue(p.Any(l => l.StartsWith("fail\tfalse\t", StringComparison.Ordinal) && l.Contains("export xl_ts:fail nope")), log);
        Assert.IsTrue(p.Any(l => l.StartsWith("waits\tfalse\t", StringComparison.Ordinal) && l.Contains("export xl_ts:waits export_yielded")), log);
        CollectionAssert.Contains(p, "who\txl_lua", log);
        // Events both ways
        CollectionAssert.Contains(p, "ts got	{\"x\":41}", log);
        CollectionAssert.Contains(p, "lua got\t42\t3\tinteger", log);
        // JavaScript → Lua
        CollectionAssert.Contains(p, "lsum	6", log);
        CollectionAssert.Contains(p, "lmulti	[1,\"b\",true]", log);
        CollectionAssert.Contains(p, "lwait	[6]", log);
        Assert.IsTrue(p.Any(l => l.StartsWith("lfail	code	export xl_lua:lfail ", StringComparison.Ordinal) && l.Contains("lua says no")), log);
        CollectionAssert.Contains(p, "missing	export_not_found", log);
        CollectionAssert.Contains(p, "ltypes	{\"empty\":[],\"float\":1.5,\"int\":3,\"map\":{\"1\":\"a\",\"3\":\"c\"}}", log);
    }

    [TestMethod]
    public void OneResourceMayMixLanguages()
    {
        using var sb = new Sandbox();
        sb.Resource("mixed_res", Sandbox.Manifest("mixed_res", ["server/a.lua", "server/b.js"], []),
            ("server/a.lua", """
                exports("fromLua", function() return "lua" end)
                AddEventHandler("hello", function(who) print("lua handler", who) end)
                """),
            ("server/b.js", """
                exports('fromJs', () => 'js');
                AddEventHandler('hello', (who) => print('js handler', who));
                CreateThread(async () => {
                  await Wait(0);
                  print('own export', exports.mixed_res.fromLua());
                  TriggerEvent('hello', 'bus');
                });
                """));
        sb.Start("mixed_res");
        sb.Host.RunFor(50);
        CollectionAssert.Contains(sb.Printed, "own export	lua", sb.Log.ToString());
        var lua = sb.Printed.IndexOf("lua handler\tbus");
        var js = sb.Printed.IndexOf("js handler	bus");
        Assert.IsTrue(lua >= 0 && js > lua, "handlers run in registration order across languages\n" + sb.Log);
    }

    [TestMethod]
    public void HostCallsExportsInEitherLanguage()
    {
        using var sb = new Sandbox();
        sb.Server("host_js", ("server/main.js", "exports('mul', (a, b) => a * b);"));
        sb.Server("host_lua", ("server/main.lua", "exports('concat', function(a, b) return a .. b, #a end)"));
        sb.Start("host_js", "host_lua");
        var js = sb.Host.CallExportSync("host_js", "mul", args: [SgValue.Of(6), SgValue.Of(7)]);
        Assert.IsTrue(js.Ok, js.Reason);
        Assert.AreEqual(42, js.Values[0].AsInteger());
        var lua = sb.Host.CallExportSync("host_lua", "concat", args: [SgValue.Of("ab"), SgValue.Of("cd")]);
        Assert.IsTrue(lua.Ok, lua.Reason);
        Assert.AreEqual("abcd", lua.Values[0].AsText());
        Assert.AreEqual(2, lua.Values[1].AsInteger());
        Assert.AreEqual("export_not_found", sb.Host.CallExportSync("host_lua", "nope").Reason);
    }
}
