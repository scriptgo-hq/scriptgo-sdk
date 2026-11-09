namespace ScriptGo.Host.Tests;

/// <summary>Runaway code is stopped in both languages, and a script cannot catch its way out.</summary>
[TestClass]
public sealed class QuotaTests
{
    private static Sandbox Small() => new(new HostOptions
    {
        Quotas = new Quotas
        {
            LuaInstructions = 200_000,
            LuaMemoryBytes = 8L * 1024 * 1024,
            JsStatements = 200_000,
            JsMemoryBytes = 16L * 1024 * 1024,
        },
    });

    // The JavaScript allocation cap counts the host's own marshalling during the entry too, so the
    // re-entry tests raise it to see the statement budget (the one a nested call could reset) fire.
    private static Sandbox StatementsOnly() => new(new HostOptions
    {
        Quotas = new Quotas { JsStatements = 200_000, LuaInstructions = 200_000, JsMemoryBytes = 1L << 40 },
    });

    private static void AssertSurvivor(Sandbox sb, string res)
    {
        Assert.AreEqual("started", sb.Host.ResourceState(res), sb.Log.ToString());
        CollectionAssert.Contains(sb.Printed, "survivor ran", sb.Log.ToString());
    }

    // Lua -------------------------------------------------------------------------------------------

    [TestMethod]
    public void LuaRunawayAtFileScopeFailsTheStart()
    {
        using var sb = Small();
        sb.Server("q_lua_file", ("server/main.lua", "while true do end"));
        sb.Host.AddResource(Path.Combine(sb.Root, "q_lua_file"));
        var r = sb.Host.Start("q_lua_file");
        Assert.IsFalse(r.Ok);
        StringAssert.Contains(r.Reason, "quota_exceeded:instructions");
    }

    [TestMethod]
    public void LuaRunawayThreadIsKilledAndTheResourceLives()
    {
        using var sb = Small();
        sb.Server("q_lua_thread", ("server/main.lua", """
            CreateThread(function() Wait(0) while true do end end)
            CreateThread(function() Wait(50) print("survivor ran") end)
            """));
        sb.Start("q_lua_thread");
        sb.Host.RunFor(100);
        Assert.IsTrue(sb.Log.Has("quota_exceeded:instructions"), sb.Log.ToString());
        AssertSurvivor(sb, "q_lua_thread");
    }

    [TestMethod]
    public void LuaPcallCannotSwallowTheQuota()
    {
        using var sb = Small();
        sb.Server("q_lua_pcall", ("server/main.lua", """
            CreateThread(function()
                Wait(0)
                local n = 0
                while true do
                    pcall(function() while true do end end)
                    xpcall(function() while true do end end, function() return "swallowed" end)
                    n = n + 1
                    print("escaped", n)
                end
            end)
            CreateThread(function() Wait(50) print("survivor ran") end)
            """));
        sb.Start("q_lua_pcall");
        sb.Host.RunFor(100);
        Assert.IsTrue(sb.Log.Has("quota_exceeded:instructions"), sb.Log.ToString());
        Assert.IsFalse(sb.Printed.Any(l => l.StartsWith("escaped", StringComparison.Ordinal)), sb.Log.ToString());
        AssertSurvivor(sb, "q_lua_pcall");
    }

    [TestMethod]
    public void LuaNestedExportCallsDoNotResetTheBudget()
    {
        using var sb = Small();
        sb.Server("q_lua_reenter", ("server/main.lua", """
            exports("noop", function() return 1 end)
            CreateThread(function()
                Wait(0)
                local n = 0
                while true do n = n + exports.q_lua_reenter:noop() end
            end)
            CreateThread(function() Wait(50) print("survivor ran") end)
            """));
        sb.Start("q_lua_reenter");
        sb.Host.RunFor(100);
        Assert.IsTrue(sb.Log.Has("quota_exceeded:instructions"), sb.Log.ToString());
        AssertSurvivor(sb, "q_lua_reenter");
    }

    [TestMethod]
    public void LuaHeapOverTheCapStopsTheResource()
    {
        using var sb = Small();
        sb.Server("q_lua_mem", ("server/main.lua", """
            hoard = {}
            CreateThread(function()
                Wait(0)
                for i = 1, 1000 do hoard[i] = string.rep("x", 100000) .. i end
                print("hoarded everything")
            end)
            """));
        sb.Start("q_lua_mem");
        sb.Host.RunFor(50);
        Assert.IsTrue(sb.Log.Has("quota_exceeded:memory"), sb.Log.ToString());
        CollectionAssert.DoesNotContain(sb.Printed, "hoarded everything");
        Assert.AreEqual("failed", sb.Host.ResourceState("q_lua_mem"), sb.Log.ToString());
        StringAssert.StartsWith(sb.Host.ResourceFailure("q_lua_mem"), "quota_exceeded:memory");
    }

    [TestMethod]
    public void LuaThreadCountIsCapped()
    {
        using var sb = new Sandbox(new HostOptions { Quotas = new Quotas { Threads = 10 } });
        sb.Server("q_lua_threads", ("server/main.lua", """
            local made = 0
            for i = 1, 20 do
                local ok = pcall(CreateThread, function() Wait(1000) end)
                if ok then made = made + 1 end
            end
            print("made", made)
            """));
        sb.Start("q_lua_threads");
        CollectionAssert.Contains(sb.Printed, "made\t10", sb.Log.ToString());
    }

    // JavaScript ------------------------------------------------------------------------------------

    [TestMethod]
    public void JsRunawayAtFileScopeFailsTheStart()
    {
        using var sb = Small();
        sb.Server("q_js_file", ("server/main.js", "while (true) {}"));
        sb.Host.AddResource(Path.Combine(sb.Root, "q_js_file"));
        var r = sb.Host.Start("q_js_file");
        Assert.IsFalse(r.Ok);
        StringAssert.Contains(r.Reason, "quota_exceeded:instructions");
    }

    [TestMethod]
    public void JsRunawayThreadIsKilledEvenThroughTryCatch()
    {
        using var sb = Small();
        sb.Server("q_js_thread", ("server/main.js", """
            CreateThread(async () => {
              await Wait(0);
              let n = 0;
              while (true) {
                try { while (true) {} } catch (e) { n++; print('escaped', n); }
                finally { print('finally ran'); }
              }
            });
            CreateThread(async () => { await Wait(50); print('survivor ran'); });
            """));
        sb.Start("q_js_thread");
        sb.Host.RunFor(100);
        Assert.IsTrue(sb.Log.Has("quota_exceeded:instructions"), sb.Log.ToString());
        Assert.IsFalse(sb.Printed.Any(l => l.StartsWith("escaped", StringComparison.Ordinal) || l == "finally ran"), sb.Log.ToString());
        AssertSurvivor(sb, "q_js_thread");
    }

    [TestMethod]
    public void JsRunawayHandlerIsStoppedAndLaterEventsStillRun()
    {
        using var sb = Small();
        sb.Server("q_js_handler", ("server/main.js", """
            AddEventHandler('spin', () => { for (;;) {} });
            AddEventHandler('after', () => print('survivor ran'));
            CreateThread(() => { TriggerEvent('spin'); });
            CreateThread(async () => { await Wait(20); TriggerEvent('after'); });
            """));
        sb.Start("q_js_handler");
        sb.Host.RunFor(100);
        Assert.IsTrue(sb.Log.Has("quota_exceeded:instructions"), sb.Log.ToString());
        AssertSurvivor(sb, "q_js_handler");
    }

    [TestMethod]
    public void JsNestedExportCallsDoNotResetTheBudget()
    {
        using var sb = StatementsOnly();
        sb.Server("q_js_reenter", ("server/main.js", """
            exports('noop', () => 1);
            CreateThread(async () => {
              await Wait(0);
              let n = 0;
              while (true) n += exports.q_js_reenter.noop();
            });
            CreateThread(async () => { await Wait(50); print('survivor ran'); });
            """));
        sb.Start("q_js_reenter");
        sb.Host.RunFor(100);
        Assert.IsTrue(sb.Log.Has("quota_exceeded:instructions"), sb.Log.ToString());
        AssertSurvivor(sb, "q_js_reenter");
    }

    [TestMethod]
    public void JsCrossLanguageRoundTripsDoNotResetTheBudget()
    {
        using var sb = StatementsOnly();
        sb.Server("q_x_lua", ("server/main.lua", "exports('back', function(n) return n + 1 end)"));
        sb.Resource("q_x_js", Sandbox.Manifest("q_x_js", ["server/main.js"], ["q_x_lua"]), ("server/main.js", """
            CreateThread(async () => {
              await Wait(0);
              let n = 0;
              while (true) n = exports.q_x_lua.back(n);
            });
            CreateThread(async () => { await Wait(50); print('survivor ran'); });
            """));
        sb.Start("q_x_lua", "q_x_js");
        sb.Host.RunFor(100);
        Assert.IsTrue(sb.Log.Has("quota_exceeded:instructions"), sb.Log.ToString());
        AssertSurvivor(sb, "q_x_js");
    }

    // A resource that calls another resource's export in a loop must not hand the callee a fresh
    // budget on every call: the callee's budget is per host-level entry, like the caller's.
    [TestMethod]
    [DataRow("lua", "lua")]
    [DataRow("lua", "js")]
    [DataRow("js", "lua")]
    [DataRow("js", "js")]
    public void ExportPingPongBetweenResourcesIsBounded(string caller, string callee)
    {
        using var sb = StatementsOnly();
        var work = callee == "lua"
            ? ("server/main.lua", "exports('work', function() local n = 0 for i = 1, 150000 do n = n + 1 end return n end)")
            : ("server/main.js", "exports('work', () => { let n = 0; for (let i = 0; i < 150000; i++) n++; return n; });");
        var loop = caller == "lua"
            ? ("server/main.lua", """
                CreateThread(function()
                    Wait(0)
                    local calls = 0
                    while true do pcall(function() return exports.pp_callee:work() end) calls = calls + 1 end
                end)
                CreateThread(function() Wait(50) print("survivor ran") end)
                """)
            : ("server/main.js", """
                CreateThread(async () => {
                  await Wait(0);
                  let calls = 0;
                  while (true) { try { exports.pp_callee.work(); } catch (e) {} calls++; }
                });
                CreateThread(async () => { await Wait(50); print('survivor ran'); });
                """);
        sb.Server("pp_callee", work);
        sb.Resource("pp_caller", Sandbox.Manifest("pp_caller", [loop.Item1], ["pp_callee"]), loop);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        sb.Start("pp_callee", "pp_caller");
        sb.Host.RunFor(100);
        watch.Stop();
        Assert.IsTrue(sb.Log.Lines.Any(l => l.Origin.StartsWith("pp_callee", StringComparison.Ordinal) && l.Message.Contains("quota_exceeded:instructions")), sb.Log.ToString());
        Assert.IsTrue(sb.Log.Lines.Any(l => l.Origin.StartsWith("pp_caller", StringComparison.Ordinal) && l.Message.Contains("quota_exceeded:instructions")), sb.Log.ToString());
        Assert.IsTrue(watch.Elapsed < TimeSpan.FromSeconds(10), $"took {watch.Elapsed}");
        Assert.IsTrue(sb.Log.Lines.Count(l => l.Message.Contains("quota_exceeded")) < 20, "quota failures are logged once per budget, not per call: " + sb.Log);
        AssertSurvivor(sb, "pp_caller");
        Assert.AreEqual("started", sb.Host.ResourceState("pp_callee"));
    }

    [TestMethod]
    public void JsAllocationOverTheCapIsStopped()
    {
        using var sb = Small();
        sb.Server("q_js_mem", ("server/main.js", """
            const hoard = [];
            CreateThread(async () => {
              await Wait(0);
              for (let i = 0; i < 100000; i++) hoard.push('x'.repeat(10000) + i);
              print('hoarded everything');
            });
            CreateThread(async () => { await Wait(50); print('survivor ran'); });
            """));
        sb.Start("q_js_mem");
        sb.Host.RunFor(100);
        Assert.IsTrue(sb.Log.Has("quota_exceeded:memory"), sb.Log.ToString());
        CollectionAssert.DoesNotContain(sb.Printed, "hoarded everything");
        AssertSurvivor(sb, "q_js_mem");
    }

    [TestMethod]
    public void JsWallClockLimitStopsSlowEntries()
    {
        using var sb = new Sandbox(new HostOptions
        {
            Quotas = new Quotas { JsStatements = int.MaxValue, JsTimeout = TimeSpan.FromMilliseconds(200) },
        });
        sb.Server("q_js_time", ("server/main.js", """
            CreateThread(async () => { await Wait(0); for (;;) {} });
            CreateThread(async () => { await Wait(50); print('survivor ran'); });
            """));
        sb.Start("q_js_time");
        sb.Host.RunFor(100);
        Assert.IsTrue(sb.Log.Has("quota_exceeded:time"), sb.Log.ToString());
        AssertSurvivor(sb, "q_js_time");
    }

    [TestMethod]
    public void JsDeepRecursionIsStopped()
    {
        using var sb = Small();
        sb.Server("q_js_rec", ("server/main.js", """
            const deep = (n) => deep(n + 1);
            CreateThread(async () => { await Wait(0); try { deep(0); } catch (e) { print('caught', e.name); } });
            CreateThread(async () => { await Wait(50); print('survivor ran'); });
            """));
        sb.Start("q_js_rec");
        sb.Host.RunFor(100);
        Assert.IsTrue(sb.Log.Has("recursion limit"), sb.Log.ToString());
        AssertSurvivor(sb, "q_js_rec");
    }
}
