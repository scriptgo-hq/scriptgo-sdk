namespace ScriptGo.Host.Tests;

[TestClass]
public sealed class LuaGuestTests
{
    [TestMethod]
    public void RunsAScriptAndAThread()
    {
        using var sb = new Sandbox();
        sb.Server("lua_basic", ("server/main.lua", """
            print("loaded", GetCurrentResourceName(), ScriptGo.runtime.side(), ScriptGo.runtime.language())
            CreateThread(function()
                Wait(100)
                print("after wait", ScriptGo.runtime.environment())
            end)
            """));
        sb.Start("lua_basic");
        CollectionAssert.Contains(sb.Printed, "loaded\tlua_basic\tserver\tlua");
        sb.Host.RunFor(50);
        CollectionAssert.DoesNotContain(sb.Printed, "after wait\tdotnet");
        sb.Host.RunFor(100);
        CollectionAssert.Contains(sb.Printed, "after wait\tdotnet");
    }

    [TestMethod]
    public void SandboxHasNoIoOrLoad()
    {
        using var sb = new Sandbox();
        sb.Server("lua_sandbox", ("server/main.lua", """
            print(type(io), type(load), type(loadstring), type(dofile), type(require), type(debug), type(coroutine), type(string.dump), type(os.execute), type(os.time))
            local ok, err = pcall(setmetatable, {}, { __gc = function() end })
            print("gc", ok)
            print("strmeta", getmetatable(""))
            """));
        sb.Start("lua_sandbox");
        CollectionAssert.Contains(sb.Printed, "nil\tnil\tnil\tnil\tfunction\tnil\tnil\tnil\tnil\tfunction");
        CollectionAssert.Contains(sb.Printed, "gc\tfalse");
        CollectionAssert.Contains(sb.Printed, "strmeta\tstring");
    }

    [TestMethod]
    public void WaitAtFileScopeFailsTheStart()
    {
        using var sb = new Sandbox();
        sb.Server("lua_filewait", ("server/main.lua", "Wait(10)"));
        sb.Host.AddResource(Path.Combine(sb.Root, "lua_filewait"));
        var r = sb.Host.Start("lua_filewait");
        Assert.IsFalse(r.Ok);
        StringAssert.Contains(r.Reason, "must be called from a thread");
    }

    [TestMethod]
    public void ServerBusIsQueuedToTheNextTick()
    {
        using var sb = new Sandbox();
        sb.Server("lua_bus", ("server/main.lua", """
            AddEventHandler("ping", function(n) print("got", n, source) end)
            CreateThread(function()
                TriggerEvent("ping", 7)
                print("after trigger")
            end)
            """));
        sb.Start("lua_bus");
        CollectionAssert.AreEqual(new[] { "after trigger" }, sb.Printed.ToArray());
        sb.Host.Tick(sb.Host.Now + 0.01);
        CollectionAssert.Contains(sb.Printed, "got\t7\tnil");
    }

    [TestMethod]
    public void StorageRoundTrip()
    {
        using var sb = new Sandbox();
        sb.Server("lua_store", ("server/main.lua", """
            ScriptGo.storage.set("k", { a = 1, list = { "x", "y" } })
            local v = ScriptGo.storage.get("k")
            print(v.a, v.list[2], #ScriptGo.storage.keys())
            print(ScriptGo.storage.set("bad", function() end))
            """));
        sb.Start("lua_store");
        CollectionAssert.Contains(sb.Printed, "1\ty\t1");
        CollectionAssert.Contains(sb.Printed, "false\tcodec: cannot transfer a function");
        Assert.AreEqual("""{"k":{"a":1,"list":["x","y"]}}""", ((MemoryStorage)sb.Services.Storage!).Load("lua_store"));
    }

    [TestMethod]
    public void CommandsRunOnTheNextTick()
    {
        using var sb = new Sandbox();
        sb.Server("lua_cmd", ("server/main.lua", """
            RegisterCommand("Hello", function(src, args, raw) print("cmd", src, args.n, args[1], raw) end)
            """));
        sb.Start("lua_cmd");
        Assert.IsTrue(sb.Host.ExecuteCommand(0, "/hello  a b").Ok);
        Assert.AreEqual(0, sb.Printed.Count);
        sb.Host.Tick(sb.Host.Now + 0.01);
        CollectionAssert.Contains(sb.Printed, "cmd\t0\t2\ta\thello a b");
        Assert.AreEqual("unknown_command:nope", sb.Host.ExecuteCommand(0, "nope").Reason);
    }

    [TestMethod]
    public void RequireLoadsModulesOfTheResourceAndOfDependencies()
    {
        using var sb = new Sandbox();
        sb.Resource("lua_lib", Sandbox.Manifest("lua_lib", ["server/main.lua"], []),
            ("server/main.lua", ""), ("init.lua", "return { hello = function() return 'from lib' end }"));
        sb.Resource("lua_app", Sandbox.Manifest("lua_app", ["server/main.lua"], ["lua_lib"]),
            ("server/main.lua", """
                local util = require("shared.util")
                local lib = require("@lua_lib")
                print(util.twice(4), lib.hello(), select(2, require("missing")))
                """),
            ("shared/util.lua", "return { twice = function(n) return n * 2 end }"));
        sb.Start("lua_lib", "lua_app");
        CollectionAssert.Contains(sb.Printed, "8\tfrom lib\tmodule_not_found:missing");
    }
}

[TestClass]
public sealed class JsGuestTests
{
    [TestMethod]
    public void RunsAScriptAndAnAsyncThread()
    {
        using var sb = new Sandbox();
        sb.Server("js_basic", ("server/main.js", """
            console.log('loaded', GetCurrentResourceName(), ScriptGo.runtime.side(), ScriptGo.runtime.language());
            CreateThread(async () => {
              await Wait(100);
              print('after wait', ScriptGo.runtime.environment());
            });
            """));
        sb.Start("js_basic");
        CollectionAssert.Contains(sb.Printed, "loaded js_basic server js");
        sb.Host.RunFor(50);
        CollectionAssert.DoesNotContain(sb.Printed, "after wait\tdotnet");
        sb.Host.RunFor(100);
        CollectionAssert.Contains(sb.Printed, "after wait\tdotnet");
    }

    [TestMethod]
    public void EvalAndFunctionAreDisabled()
    {
        using var sb = new Sandbox();
        sb.Server("js_noeval", ("server/main.js", """
            let a = 'ok', b = 'ok';
            try { eval('1'); a = 'eval ran'; } catch (e) { a = 'refused'; }
            try { new Function('return 1')(); b = 'function ran'; } catch (e) { b = 'refused'; }
            print(a, b, typeof require, typeof process);
            """));
        sb.Start("js_noeval");
        CollectionAssert.Contains(sb.Printed, "refused\trefused\tundefined\tundefined");
    }

    [TestMethod]
    public void ErrorsInHandlersAreLoggedNotFatal()
    {
        using var sb = new Sandbox();
        sb.Server("js_err", ("server/main.js", """
            AddEventHandler('boom', () => { throw new Error('kaboom'); });
            AddEventHandler('boom', () => { print('second handler ran'); });
            CreateThread(() => { TriggerEvent('boom'); });
            """));
        sb.Start("js_err");
        sb.Host.Tick(sb.Host.Now + 0.01);
        Assert.IsTrue(sb.Log.Has("kaboom"), sb.Log.ToString());
        CollectionAssert.Contains(sb.Printed, "second handler ran");
    }

    [TestMethod]
    public void StorageAndCommands()
    {
        using var sb = new Sandbox();
        sb.Server("js_misc", ("server/main.js", """
            ScriptGo.storage.set('k', { a: 1, list: ['x', 'y'] });
            const v = ScriptGo.storage.get('k');
            print(v.a, v.list[1], ScriptGo.storage.keys().length);
            try { ScriptGo.storage.set('bad', () => 1); } catch (e) { print(e.name, e.code); }
            RegisterCommand('hi', (src, args, raw) => print('cmd', src, args.length, args[0], raw));
            """));
        sb.Start("js_misc");
        CollectionAssert.Contains(sb.Printed, "1\ty\t1");
        CollectionAssert.Contains(sb.Printed, "ScriptGoError\tcodec: cannot transfer a function");
        sb.Host.ExecuteCommand(0, "hi there");
        sb.Host.Tick(sb.Host.Now + 0.01);
        CollectionAssert.Contains(sb.Printed, "cmd\t0\t1\tthere\thi there");
    }
}
