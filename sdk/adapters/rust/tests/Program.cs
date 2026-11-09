// Tests of the SCRIPT//GO bridge (sdk/adapters/rust/bridge) in a plain .NET process.
//
// NOT THE REAL ENVIRONMENT. Nothing here is a Rust server, Oxide, Carbon or Unity's Mono: the host
// services are fakes standing in for the plugin's (data files, BasePlayer, permissions, config, chat,
// web requests). What is real: the KeraLua Lua 5.4 VM, the portable core, the Rust glue, the
// conformance probe and the official kits. Passing here never makes the `rust` environment verified.
//
//   dotnet run --project sdk/adapters/rust/tests -- [<repo root>]
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using ScriptGo.Bridge;

internal static class Program
{
    private static string _repo = "";
    private static string _tmp = "";
    private static int _passed;
    private static readonly List<string> Failures = new();

    private static int Main(string[] args)
    {
        _repo = args.Length > 0 ? Path.GetFullPath(args[0]) : FindRepo();
        _tmp = Path.Combine(Path.GetTempPath(), "scriptgo-bridge-tests-" + Environment.ProcessId);
        Directory.CreateDirectory(_tmp);
        Console.WriteLine("SCRIPT//GO bridge tests: plain .NET " + Environment.Version + " host with fake services (not a Rust server)");
        try
        {
            // First: nothing may have loaded lua54 yet.
            Test("native.preload_by_full_path", NativePreload);
            Test("boot.core_in_lua54", BootCore);
            Test("sandbox.globals_and_clock", Sandbox);
            Test("config.resource_and_convars", ConfigValues);
            Test("files.confined_and_utf8", Files);
            Test("ui.notify_payload", UiNotify);
            Test("players.join_identify_drop", PlayersJoinDrop);
            Test("commands.console_player_restricted", Commands);
            Test("storage.persists_across_restart", StoragePersists);
            Test("control.stop_start_status", Control);
            Test("http.async_answer_on_tick", HttpAsync);
            Test("http.unavailable_refused", HttpUnavailable);
            Test("budget.runaway_thread_stopped", Budget);
            Test("errors.failed_start_reported", FailedStart);
            Test("conformance.sg_probe", Probe);
            Test("kits.sg_eventbus", () => Kit("sg_eventbus"));
            Test("kits.sg_permissions", () => Kit("sg_permissions"));
            Test("kits.sg_inventory", () => Kit("sg_inventory"));
            Test("kits.sg_inventory_giveitem_permission", InventoryGive);
            Test("verify.report_shape", ReportShape);
        }
        finally
        {
            try { Directory.Delete(_tmp, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
        Console.WriteLine();
        foreach (var f in Failures) Console.WriteLine("FAIL " + f);
        Console.WriteLine($"{_passed} passed, {Failures.Count} failed");
        return Failures.Count == 0 ? 0 : 1;
    }

    // Harness -----------------------------------------------------------------------------------------
    private static void Test(string name, Action body)
    {
        var watch = Stopwatch.StartNew();
        try
        {
            body();
            _passed++;
            Console.WriteLine($"ok   {name} ({watch.ElapsedMilliseconds} ms)");
        }
        catch (Exception e)
        {
            Failures.Add(name + ": " + e.Message);
            Console.WriteLine($"FAIL {name}: {e.Message}");
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static string FindRepo()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "pnpm-workspace.yaml"))) dir = dir.Parent;
        if (dir == null) throw new Exception("repository root not found: pass it as the first argument");
        return dir.FullName;
    }

    private sealed class CaptureLog : IHostLog
    {
        public readonly List<string> Lines = new();
        public readonly bool Echo = Environment.GetEnvironmentVariable("SCRIPTGO_TEST_ECHO") == "1";
        public void Write(LogLevel level, string origin, string message)
        {
            var line = $"[{level.ToString().ToLowerInvariant()}] {origin} {message}";
            lock (Lines) Lines.Add(line);
            if (Echo) Console.WriteLine("     " + line);
        }
        public bool Has(string needle) { lock (Lines) return Lines.Any(l => l.Contains(needle, StringComparison.Ordinal)); }
        public string Dump() { lock (Lines) return string.Join("\n", Lines); }
    }

    private sealed class FakePlayers : IHostPlayers
    {
        public readonly SortedDictionary<int, string> Online = new();
        public IReadOnlyList<int> List() => Online.Keys.ToList();
        public string Name(int id) => Online.TryGetValue(id, out var n) ? n : null;
        public string Identifier(int id) => Online.ContainsKey(id) ? "steam:7656119800000000" + id : null;
    }

    private sealed class FakePermissions : IHostPermissions
    {
        public readonly HashSet<string> Grants = new();
        public readonly List<string> Asked = new();
        public bool Has(int playerId, string privilege)
        {
            Asked.Add(playerId + ":" + privilege);
            return Grants.Contains(playerId + ":" + privilege);
        }
    }

    private sealed class FakeConfig : IHostConfig
    {
        public readonly Dictionary<string, string> Values = new();
        public string GetJson(string resource, string key) => Values.TryGetValue((resource ?? "<convar>") + "/" + key, out var v) ? v : null;
    }

    private sealed class CaptureUi : IHostUi
    {
        public readonly List<(int target, Notification n)> Sent = new();
        public void Notify(int target, Notification notification) => Sent.Add((target, notification));
    }

    private sealed class FakeHttp : IHostHttp
    {
        public readonly ConcurrentQueue<HttpRequestData> Seen = new();
        public Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation)
        {
            Seen.Enqueue(request);
            if (request.Url.StartsWith("http://slow.test", StringComparison.Ordinal)) return new TaskCompletionSource<HttpResponseData>().Task;
            return Task.Run(async () =>
            {
                await Task.Delay(20);
                if (request.Url.EndsWith("/v1/licenses/verify", StringComparison.Ordinal))
                    return new HttpResponseData(200, new Dictionary<string, string>(), "{\"valid\":true,\"status\":\"active\"}");
                return new HttpResponseData(200, new Dictionary<string, string> { ["X-Test"] = "yes" }, "pong");
            });
        }
    }

    private sealed class Rig : IDisposable
    {
        public readonly HostServices Services = new();
        public readonly CaptureLog Log = new();
        public readonly ManualClock Manual = new();
        public readonly FakePlayers Players = new();
        public readonly FakePermissions Permissions = new();
        public readonly FakeConfig Config = new();
        public readonly CaptureUi Ui = new();
        public readonly RuntimeOptions Options = new();
        public ScriptGoRuntime Runtime;

        public Rig(bool realClock = false)
        {
            Services.Clock = realClock ? new SystemClock() : Manual;
            Services.Log = Log;
            Services.Storage = new MemoryStorage();
            Services.Players = Players;
            Services.Permissions = Permissions;
            Services.Config = Config;
            Services.Ui = Ui;
        }

        public ScriptGoRuntime Boot()
        {
            Runtime = new ScriptGoRuntime(Services, Options);
            Runtime.Boot();
            return Runtime;
        }

        // Simulated time: advances the manual clock in steps and ticks.
        public void Run(int ms, int step = 10)
        {
            for (int t = 0; t < ms; t += step)
            {
                Manual.Now += step;
                Runtime.Tick();
            }
        }

        // Real time: ticks every few milliseconds until the log holds `needle` or the time is up.
        public bool RunUntil(string needle, int timeoutMs)
        {
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < timeoutMs)
            {
                Manual.Now = watch.Elapsed.TotalMilliseconds;
                Runtime.Tick();
                if (Log.Has(needle)) return true;
                Thread.Sleep(3);
            }
            return false;
        }

        public void Dispose() => Runtime?.Dispose();
    }

    // Writes a resource folder under <tmp>/<set>/<name>/ and returns <tmp>/<set>.
    private static string Fixture(string set, string name, string manifestExtra, string serverCode, Dictionary<string, string> files = null)
    {
        var root = Path.Combine(_tmp, set, name);
        Directory.CreateDirectory(Path.Combine(root, "server"));
        File.WriteAllText(Path.Combine(root, "scriptgo.lua"),
            $"resource \"{name}\"\nversion \"1.0.0\"\nlua {{ \"5.4\" }}\nenvironments {{ \"rust\" }}\n{manifestExtra}\nserver_script \"server/main.lua\"\n",
            new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(root, "server", "main.lua"), serverCode, new UTF8Encoding(false));
        foreach (var f in files ?? new Dictionary<string, string>())
        {
            var p = Path.Combine(root, f.Key.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(p)!);
            File.WriteAllText(p, f.Value, new UTF8Encoding(false));
        }
        return Path.Combine(_tmp, set);
    }

    private static string NativeSource()
    {
        var rid = OperatingSystem.IsWindows() ? "win-x64" : OperatingSystem.IsMacOS() ? "osx" : "linux-x64";
        var file = NativeLua.FileName;
        foreach (var p in new[] { Path.Combine(AppContext.BaseDirectory, "runtimes", rid, "native", file), Path.Combine(AppContext.BaseDirectory, file) })
            if (File.Exists(p)) return p;
        throw new Exception("KeraLua's native " + file + " is not in the test output");
    }

    private static JsonElement Check(JsonElement report, string name)
    {
        foreach (var c in report.GetProperty("checks").EnumerateArray())
            if (c.GetProperty("name").GetString() == name) return c;
        throw new Exception("no check " + name);
    }

    private static string Status(JsonElement report, string name) => Check(report, name).GetProperty("status").GetString();

    // Tests -------------------------------------------------------------------------------------------
    private static void NativePreload()
    {
        var dir = Path.Combine(_tmp, "native");
        Directory.CreateDirectory(dir);
        File.Copy(NativeSource(), Path.Combine(dir, NativeLua.FileName));
        var loaded = NativeLua.Preload(new[] { Path.Combine(_tmp, "missing"), dir }, out var err);
        Assert(loaded != null, "preload failed: " + err);
        Assert(loaded.EndsWith(NativeLua.FileName, StringComparison.Ordinal), loaded);
        Assert(NativeLua.Preload(new[] { Path.Combine(_tmp, "elsewhere") }, out _) == loaded, "second preload should be a no-op");
        using var rig = new Rig();
        rig.Options.NativeSearchDirs = new List<string> { dir };
        var rt = rig.Boot();
        Assert(rt.NativeLibrary == loaded, "runtime reports " + rt.NativeLibrary);
    }

    private static void BootCore()
    {
        using var rig = new Rig();
        var rt = rig.Boot();
        Assert(rt.Booted, "not booted");
        Assert(rt.LuaVersion == "Lua 5.4", "lua version " + rt.LuaVersion);
        Assert(rt.Status() == "No resources.", rt.Status());
        rig.Run(50);
    }

    private static void Sandbox()
    {
        var dir = Fixture("sandbox", "rt_sandbox", "capabilities { \"events\" }", """
            local function ok(name, cond, detail) print((cond and "OK " or "BAD ") .. name .. " " .. tostring(detail)) end
            ok("io", io == nil)
            ok("os.execute", os.execute == nil)
            ok("os.exit", os.exit == nil)
            ok("os.getenv", os.getenv == nil)
            ok("debug", debug == nil)
            ok("package", package == nil)
            ok("load", load == nil and loadstring == nil and dofile == nil and loadfile == nil)
            ok("coroutine", coroutine == nil)
            ok("clock", type(os.clock()) == "number", os.clock())
            ok("time", type(ScriptGo.time.now()) == "number" and ScriptGo.time.now() > 1700000000)
            ok("env", ScriptGo.runtime.environment() == "rust", ScriptGo.runtime.environment())
            ok("side", ScriptGo.runtime.side() == "server")
            ok("adapter", ScriptGo.runtime.adapterVersion() == "rust-0.1.0", ScriptGo.runtime.adapterVersion())
            ok("lua", ScriptGo.runtime.luaVersion() == "Lua 5.4", ScriptGo.runtime.luaVersion())
            ok("caps", ScriptGo.capabilities.has("storage") and ScriptGo.capabilities.has("players") and not ScriptGo.capabilities.has("http"))
            print("SANDBOX DONE")
            """);
        using var rig = new Rig();
        rig.Options.SearchDirs.Add(dir);
        rig.Boot();
        rig.Run(50);
        Assert(rig.Log.Has("SANDBOX DONE"), "resource did not run:\n" + rig.Log.Dump());
        Assert(!rig.Log.Has("BAD "), "sandbox:\n" + rig.Log.Dump());
        Assert(rig.Log.Lines.Count(l => l.Contains("OK ")) == 15, "expected 15 OK lines:\n" + rig.Log.Dump());
    }

    private static void ConfigValues()
    {
        var dir = Fixture("config", "rt_config", "capabilities { \"events\", \"config\" }", """
            local shop = ScriptGo.config.get("shop")
            print("CFG " .. tostring(ScriptGo.config.get("slots", 1)) .. " " .. tostring(shop and shop.open) .. " " .. tostring(shop and shop.items[2]))
            print("CONVAR " .. GetConvar("scriptgo_api", "none") .. " " .. GetConvar("missing", "fallback"))
            print("MISSING " .. tostring(ScriptGo.config.get("nothing", "dflt")))
            """);
        using var rig = new Rig();
        rig.Config.Values["rt_config/slots"] = "30";
        rig.Config.Values["rt_config/shop"] = "{\"open\":true,\"items\":[\"a\",\"b\"]}";
        rig.Config.Values["<convar>/scriptgo_api"] = "\"http://api.test\"";
        rig.Options.SearchDirs.Add(dir);
        rig.Boot();
        rig.Run(20);
        Assert(rig.Log.Has("CFG 30 true b"), rig.Log.Dump());
        Assert(rig.Log.Has("CONVAR http://api.test fallback"), rig.Log.Dump());
        Assert(rig.Log.Has("MISSING dflt"), rig.Log.Dump());
    }

    private static void Files()
    {
        var dir = Fixture("files", "rt_files", "capabilities { \"events\" }\nfiles { \"data/*.txt\" }", """
            print("READ " .. tostring(ScriptGo.resource.readFile("data/hello.txt")))
            print("ESCAPE " .. tostring(ScriptGo.resource.readFile("../secret.txt")))
            print("ABS " .. tostring(ScriptGo.resource.readFile("/etc/hostname")))
            """, new Dictionary<string, string> { ["data/hello.txt"] = "héllo ✓ ünïcode" });
        File.WriteAllText(Path.Combine(dir, "secret.txt"), "secret");
        using var rig = new Rig();
        rig.Options.SearchDirs.Add(dir);
        rig.Boot();
        rig.Run(20);
        Assert(rig.Log.Has("READ héllo ✓ ünïcode"), "UTF-8 read:\n" + rig.Log.Dump());
        Assert(rig.Log.Has("ESCAPE nil"), rig.Log.Dump());
        Assert(rig.Log.Has("ABS nil"), rig.Log.Dump());
    }

    private static void UiNotify()
    {
        var dir = Fixture("ui", "rt_ui", "capabilities { \"events\", \"ui\" }", """
            ScriptGo.ui.notify(-1, { type = "success", title = "Hi", message = "Started ✓", durationMs = 1500 })
            ScriptGo.ui.notify(4, { message = "just you" })
            """);
        using var rig = new Rig();
        rig.Options.SearchDirs.Add(dir);
        rig.Boot();
        rig.Run(20);
        Assert(rig.Ui.Sent.Count == 2, "notifications: " + rig.Ui.Sent.Count + "\n" + rig.Log.Dump());
        var (target, n) = rig.Ui.Sent[0];
        Assert(target == -1 && n.Type == "success" && n.Title == "Hi" && n.Message == "Started ✓" && n.DurationMs == 1500 && n.Resource == "rt_ui",
            $"first: {target} {n.Type} {n.Title} {n.Message} {n.DurationMs} {n.Resource}");
        Assert(rig.Ui.Sent[1].target == 4 && rig.Ui.Sent[1].n.Title == "rt_ui", "second: " + rig.Ui.Sent[1].n.Title);
    }

    private static void PlayersJoinDrop()
    {
        var dir = Fixture("players", "rt_players", "capabilities { \"events\", \"players\" }", """
            AddEventHandler("playerJoining", function()
                print("JOINED " .. tostring(source) .. " " .. tostring(ScriptGo.players.name(source)) .. " " .. tostring(ScriptGo.players.identifier(source)))
                print("LIST " .. table.concat(ScriptGo.players.list(), ","))
            end)
            AddEventHandler("playerDropped", function(reason) print("DROPPED " .. tostring(source) .. " " .. tostring(reason)) end)
            print("INVALID " .. tostring(ScriptGo.players.name(0)) .. " " .. tostring(ScriptGo.players.identifier(-3)) .. " " .. tostring(ScriptGo.players.name(1.5)))
            """);
        using var rig = new Rig();
        rig.Options.SearchDirs.Add(dir);
        rig.Boot();
        rig.Players.Online[3] = "Ada";
        rig.Players.Online[7] = "Bob";
        rig.Runtime.PlayerJoin(3, "Ada");
        rig.Run(20);
        Assert(rig.Log.Has("JOINED 3 Ada steam:76561198000000003"), rig.Log.Dump());
        Assert(rig.Log.Has("LIST 3,7"), rig.Log.Dump());
        Assert(rig.Log.Has("INVALID nil nil nil"), rig.Log.Dump());
        rig.Players.Online.Remove(3);
        rig.Runtime.PlayerDrop(3, "disconnect: closing");
        rig.Run(20);
        Assert(rig.Log.Has("DROPPED 3 disconnect: closing"), rig.Log.Dump());
    }

    private static void Commands()
    {
        var dir = Fixture("commands", "rt_cmd", "capabilities { \"events\", \"commands\" }", """
            RegisterCommand("hello", function(src, args, raw) print("HELLO " .. tostring(src) .. " " .. raw .. " n=" .. args.n) end, false)
            RegisterCommand("give", function(src, args) print("GIVE " .. tostring(src) .. " " .. tostring(args[1])) end, true)
            """);
        using var rig = new Rig();
        rig.Options.SearchDirs.Add(dir);
        var rt = rig.Boot();
        Assert(rt.HasCommand("HELLO") && rt.HasCommand("give") && !rt.HasCommand("nope"), "HasCommand");
        var list = rt.Commands();
        Assert(list.Count == 2 && list.Any(c => c.Key == "give" && c.Value) && list.Any(c => c.Key == "hello" && !c.Value), "commands: " + string.Join(",", list));
        var r = rt.ExecuteCommand(2, "/Hello  a  b ");
        Assert(r.Ok, "hello: " + r.Reason);
        r = rt.ExecuteCommand(2, "give water");
        Assert(!r.Ok && r.Reason == "not_allowed", "give without grant: " + r.Reason);
        Assert(rig.Permissions.Asked.Contains("2:command.give"), "asked: " + string.Join(",", rig.Permissions.Asked));
        rig.Permissions.Grants.Add("2:command.give");
        r = rt.ExecuteCommand(2, "give water");
        Assert(r.Ok, "give with grant: " + r.Reason);
        r = rt.ExecuteCommand(0, "give rock");
        Assert(r.Ok, "console give: " + r.Reason);
        r = rt.ExecuteCommand(2, "unknowncmd");
        Assert(!r.Ok && r.Reason == "unknown_command:unknowncmd", "unknown: " + r.Reason);
        Assert(!rig.Log.Has("HELLO"), "commands must run on the next tick");
        rig.Run(20);
        Assert(rig.Log.Has("HELLO 2 hello a b n=2"), rig.Log.Dump());
        Assert(rig.Log.Has("GIVE 2 water") && rig.Log.Has("GIVE 0 rock"), rig.Log.Dump());
    }

    private static void StoragePersists()
    {
        var dir = Fixture("storage", "rt_store", "capabilities { \"events\", \"storage\" }", """
            CreateThread(function()
                local n = (ScriptGo.storage.get("visits") or 0) + 1
                ScriptGo.storage.set("visits", n)
                ScriptGo.storage.set("text", { s = "héllo ✓", list = { 1, 2, 3 } })
                local t = ScriptGo.storage.get("text")
                print("VISITS " .. n .. " " .. t.s .. " " .. #t.list .. " keys=" .. table.concat(ScriptGo.storage.keys(), ","))
            end)
            """);
        var storage = new FolderStorage(Path.Combine(_tmp, "storage-data"));
        using (var rig = new Rig())
        {
            rig.Services.Storage = storage;
            rig.Options.SearchDirs.Add(dir);
            rig.Boot();
            rig.Run(20);
            Assert(rig.Log.Has("VISITS 1 héllo ✓ 3 keys=text,visits"), rig.Log.Dump());
        }
        using (var rig = new Rig())
        {
            rig.Services.Storage = storage;
            rig.Options.SearchDirs.Add(dir);
            rig.Boot();
            rig.Run(20);
            Assert(rig.Log.Has("VISITS 2 héllo ✓ 3"), "second boot:\n" + rig.Log.Dump());
        }
        var text = File.ReadAllText(Path.Combine(_tmp, "storage-data", "rt_store.json"));
        Assert(text.Contains("\"visits\":2", StringComparison.Ordinal), text);
    }

    private static void Control()
    {
        var dir = Fixture("control", "rt_ctl", "capabilities { \"events\" }", """
            AddEventHandler("onResourceStop", function(name) if name == GetCurrentResourceName() then print("STOPPING") end end)
            print("STARTED")
            """);
        using var rig = new Rig();
        rig.Options.SearchDirs.Add(dir);
        var rt = rig.Boot();
        Assert(rt.Status() == "rt_ctl 1.0.0  started", rt.Status());
        var r = rt.Control("stop", "rt_ctl");
        Assert(r.Ok && r.Reason == "rt_ctl: stopped", "stop: " + r.Reason);
        Assert(rig.Log.Has("STOPPING"), rig.Log.Dump());
        r = rt.Control("restart", "rt_ctl");
        Assert(r.Ok && r.Reason == "rt_ctl: started", "restart: " + r.Reason);
        r = rt.Control("start", "nope");
        Assert(!r.Ok && r.Reason.Contains("unknown resource", StringComparison.Ordinal), "unknown: " + r.Reason);
    }

    private static void HttpAsync()
    {
        var dir = Fixture("http", "rt_http", "capabilities { \"events\", \"http\", \"licensing\" }", """
            CreateThread(function()
                local r, err = ScriptGo.http.request({ method = "GET", url = "http://api.test/v1/ping", headers = { accept = "text/plain" } })
                print("HTTP " .. tostring(r and r.status) .. " " .. tostring(r and r.body) .. " " .. tostring(r and r.headers["x-test"]) .. " " .. tostring(err))
                local v, code = ScriptGo.licensing.verify({ licenseKey = "sg_test_key", package = "rt_http" })
                print("LICENSE " .. tostring(v and v.valid) .. " " .. tostring(v and v.status) .. " " .. tostring(code))
                local bad = ScriptGo.http.request({ url = "file:///etc/passwd" })
                print("BADURL " .. tostring(bad and bad.status) .. " " .. tostring(bad and bad.error))
                local t = ScriptGo.http.request({ url = "http://slow.test/" })
                print("SLOW " .. tostring(t and t.status) .. " " .. tostring(t and t.error))
            end)
            """);
        using var rig = new Rig(realClock: true);
        var http = new FakeHttp();
        rig.Services.Http = http;
        rig.Config.Values["<convar>/scriptgo_api"] = "\"http://api.test\"";
        rig.Options.HttpTimeout = TimeSpan.FromMilliseconds(300);
        rig.Options.SearchDirs.Add(dir);
        var rt = rig.Boot();
        Assert(rig.RunUntil("SLOW", 5000), "no answer:\n" + rig.Log.Dump());
        Assert(rig.Log.Has("HTTP 200 pong yes nil"), rig.Log.Dump());
        Assert(rig.Log.Has("LICENSE true active nil"), rig.Log.Dump());
        Assert(rig.Log.Has("BADURL 0 invalid_url"), rig.Log.Dump());
        Assert(rig.Log.Has("SLOW 0 timeout"), rig.Log.Dump());
        var verify = http.Seen.FirstOrDefault(r => r.Url == "http://api.test/v1/licenses/verify");
        Assert(verify != null && verify.Method == "POST", "no licensing request");
        using var body = JsonDocument.Parse(verify.Body);
        Assert(body.RootElement.GetProperty("environment").GetString() == "rust", verify.Body);
        Assert(body.RootElement.GetProperty("adapterVersion").GetString() == "rust-0.1.0", verify.Body);
        Assert(verify.Headers.TryGetValue("content-type", out var ct) && ct == "application/json", "content-type");
        Assert(rt.PendingHttp == 0, "pending " + rt.PendingHttp);
    }

    private static void HttpUnavailable()
    {
        var dir = Fixture("nohttp", "rt_nohttp", "capabilities { \"events\" }", """
            local ok, err = pcall(function() return ScriptGo.http.request({ url = "http://x.test/" }) end)
            print("REFUSED " .. tostring(ok) .. " " .. tostring(err))
            """);
        using var rig = new Rig();
        rig.Options.SearchDirs.Add(dir);
        rig.Boot();
        rig.Run(20);
        Assert(rig.Log.Has("REFUSED false") && rig.Log.Has("capability_unavailable:http@rust"), rig.Log.Dump());
    }

    private static void Budget()
    {
        var dir = Fixture("budget", "rt_loop", "capabilities { \"events\" }", """
            CreateThread(function() Wait(0) while true do end end)
            CreateThread(function() Wait(300) print("STILL ALIVE") end)
            """);
        using var rig = new Rig(realClock: true);
        rig.Options.BudgetMs = 100;
        rig.Options.SearchDirs.Add(dir);
        rig.Boot();
        Assert(rig.RunUntil("STILL ALIVE", 5000), "host froze or the second thread never ran:\n" + rig.Log.Dump());
        Assert(rig.Log.Has("budget exceeded"), "no budget error:\n" + rig.Log.Dump());
    }

    private static void FailedStart()
    {
        var dir = Fixture("broken", "rt_broken", "capabilities { \"events\" }", "error(\"boom at load\")\n");
        using var rig = new Rig();
        rig.Options.SearchDirs.Add(dir);
        rig.Options.VerifyResource = "rt_broken";
        var rt = rig.Boot();
        rig.Run(50);
        var report = rt.VerifyReport("test host", "{}");
        Assert(report.Json != null, "no report");
        using var doc = JsonDocument.Parse(report.Json);
        var root = doc.RootElement;
        Assert(root.GetProperty("status").GetString() == "failing", "status");
        Assert(Status(root, "starts") == "failed", "starts should fail");
        Assert(Status(root, "no_runtime_errors") == "failed", "errors should be reported");
        Assert(Check(root, "no_runtime_errors").GetProperty("message").GetString().Contains("boom at load", StringComparison.Ordinal), "message");
        rig.Run(20);
    }

    private static JsonElement RunVerify(string resource, int ms, params string[] searchDirs)
    {
        using var rig = new Rig();
        rig.Services.Storage = new MemoryStorage();
        foreach (var d in searchDirs) rig.Options.SearchDirs.Add(d);
        rig.Options.VerifyResource = resource;
        var rt = rig.Boot();
        rig.Run(ms);
        var r = rt.VerifyReport("plain .NET test host (not a Rust server)", "{\"framework\":\"none\"}");
        Assert(r.Json != null, "no report");
        return JsonDocument.Parse(r.Json).RootElement.Clone();
    }

    private static void AllPassedExceptDeclared(JsonElement report)
    {
        var bad = report.GetProperty("checks").EnumerateArray()
            .Where(c => c.GetProperty("status").GetString() != "passed" && c.GetProperty("name").GetString() != "environment_declared")
            .Select(c => c.GetProperty("name").GetString() + " " + c.GetProperty("message").GetString()).ToList();
        Assert(bad.Count == 0, "failed checks: " + string.Join("; ", bad) + "\n" + report.GetProperty("log").GetString());
    }

    private static void Probe()
    {
        var report = RunVerify("sg_probe", 3000, Path.Combine(_repo, "sdk", "conformance"), Path.Combine(_repo, "sdk", "packages"));
        AllPassedExceptDeclared(report);
        var self = report.GetProperty("checks").EnumerateArray().Count(c => c.GetProperty("name").GetString()!.StartsWith("self:", StringComparison.Ordinal));
        Assert(self == 25, "self-checks: " + self);
        Assert(report.GetProperty("log").GetString()!.Contains("SGCHECK DONE env=rust lua=Lua 5.4 pass=25 fail=0", StringComparison.Ordinal), "DONE line");
        Console.WriteLine("     sg_probe: 25/25 SGCHECK on KeraLua Lua 5.4; environment_declared " + Status(report, "environment_declared") + " (the probe does not list rust)");
    }

    private static void Kit(string name)
    {
        var report = RunVerify(name, 1000, Path.Combine(_repo, "sdk", "packages"));
        AllPassedExceptDeclared(report);
        Assert(Status(report, "starts") == "passed", "starts");
    }

    private static void InventoryGive()
    {
        using var rig = new Rig();
        rig.Options.SearchDirs.Add(Path.Combine(_repo, "sdk", "packages"));
        rig.Options.Start = new List<string> { "sg_inventory" };
        var rt = rig.Boot();
        rig.Players.Online[1] = "Ada";
        rt.PlayerJoin(1, "Ada");
        rig.Run(50);
        var r = rt.ExecuteCommand(1, "giveitem 1 water 2");
        Assert(r.Ok, "giveitem: " + r.Reason);
        rig.Run(50);
        Assert(rig.Ui.Sent.Any(s => s.target == 1 && s.n.Message == "You may not give items."), "refusal: " + string.Join(" | ", rig.Ui.Sent.Select(s => s.n.Message)));
        rig.Permissions.Grants.Add("1:inventory.give");
        rt.ExecuteCommand(1, "giveitem 1 water 2");
        rig.Run(50);
        Assert(rig.Ui.Sent.Any(s => s.target == 1 && s.n.Message.Contains("Gave 2 x water to 1", StringComparison.Ordinal)),
            "give: " + string.Join(" | ", rig.Ui.Sent.Select(s => s.n.Message)) + "\n" + rig.Log.Dump());
    }

    private static void ReportShape()
    {
        var report = RunVerify("sg_eventbus", 200, Path.Combine(_repo, "sdk", "packages"));
        Assert(report.GetProperty("package").GetString() == "sg_eventbus", "package");
        Assert(report.GetProperty("environment").GetString() == "rust", "environment");
        Assert(report.GetProperty("adapterVersion").GetString() == "rust-0.1.0", "adapterVersion");
        Assert(report.GetProperty("luaVersion").GetString() == "Lua 5.4", "luaVersion");
        Assert(report.GetProperty("runtimeVersion").GetString()!.Contains("not a Rust server", StringComparison.Ordinal), "runtimeVersion");
        Assert(report.GetProperty("evidence").GetProperty("framework").GetString() == "none", "evidence");
        Assert(report.GetProperty("evidence").GetProperty("ticks").GetInt32() > 0, "ticks");
        Assert(report.GetProperty("durationMs").GetInt32() >= 0, "durationMs");
        var status = report.GetProperty("status").GetString();
        Assert(status == "verified" || status == "failing", "status " + status);
    }
}
