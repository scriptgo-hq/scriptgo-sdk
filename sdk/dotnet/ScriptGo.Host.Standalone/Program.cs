// scriptgo-dotnet: the console host of the SCRIPT//GO .NET kit, the `dotnet` environment.
//
//   scriptgo-dotnet verify <resourceDir> [--search dir]... [--with dir] [--report out.json]
//                          [--settle ms] [--config file.json] [--environment id] [--lang lua|ts|js]
//   scriptgo-dotnet run    <resourceDir>... [--search dir]... [--for ms] [--realtime] [--config file.json]
//   scriptgo-dotnet version
//
// `verify` is what `scriptgo verify --env dotnet` drives: it loads the resource and its
// dependencies (found by folder name in the search paths), starts it, ticks simulated time, and
// writes a report in the shape of the Lua standalone host's (sdk/adapters/standalone/main.lua), so
// the CLI turns both into the same CompatibilityRun. TypeScript must already be compiled next to
// each entry (x.ts.js): the CLI stages a compiled copy before it calls this host.
//
// --config takes the standalone config shape: { "resources": { "<name>": { key: value } },
// "convars": { key: value }, "permissions": { "<playerId>": ["privilege" | "*"] } }. With it, HTTP
// is real (HttpClient); without it, every request answers 599, as in the Lua standalone verify.
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ScriptGo.Host;
using ScriptGo.Host.Manifest;

return Cli.Run(args);

internal static class Cli
{
    public static int Run(string[] argv)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (argv.Length == 0 || argv[0] is "-h" or "--help" or "help")
        {
            Console.WriteLine("usage: scriptgo-dotnet verify|run|version <resourceDir> [...]");
            return argv.Length == 0 ? 2 : 0;
        }
        var a = Args.Parse(argv.Skip(1));
        try
        {
            return argv[0] switch
            {
                "verify" => Verify.Run(a),
                "run" => RunCommand.Run(a),
                "version" => PrintVersion(),
                _ => Usage(argv[0]),
            };
        }
        catch (UsageException e)
        {
            Console.Error.WriteLine("scriptgo-dotnet: " + e.Message);
            return 2;
        }
    }

    private static int PrintVersion()
    {
        Console.WriteLine($"scriptgo-dotnet {KitInfo.Kit} (spec {ScriptGoHost.SpecVersion}); {KitInfo.Runtime}");
        return 0;
    }

    private static int Usage(string verb)
    {
        Console.Error.WriteLine($"scriptgo-dotnet: unknown command '{verb}' (verify, run, version)");
        return 2;
    }
}

internal sealed class UsageException(string message) : Exception(message);

internal sealed class Args
{
    public List<string> Positional { get; } = [];
    public Dictionary<string, string> Flags { get; } = new(StringComparer.Ordinal);
    public List<string> Search { get; } = [];
    public HashSet<string> Switches { get; } = new(StringComparer.Ordinal);

    private static readonly HashSet<string> Booleans = ["realtime", "quiet"];

    public static Args Parse(IEnumerable<string> argv)
    {
        var a = new Args();
        var list = argv.ToList();
        for (var i = 0; i < list.Count; i++)
        {
            var s = list[i];
            if (!s.StartsWith("--", StringComparison.Ordinal)) { a.Positional.Add(s); continue; }
            var name = s[2..];
            if (Booleans.Contains(name)) { a.Switches.Add(name); continue; }
            if (i + 1 >= list.Count) throw new UsageException($"--{name} needs a value");
            var value = list[++i];
            if (name == "search") a.Search.Add(value); else a.Flags[name] = value;
        }
        return a;
    }

    public string? Flag(string name) => Flags.TryGetValue(name, out var v) ? v : null;
}

/// <summary>The standalone config file: per-resource values, convars, privileges.</summary>
internal sealed class ConfigFile : IHostConfig, IHostPermissions
{
    private readonly Dictionary<string, Dictionary<string, SgValue>> _resources = new(StringComparer.Ordinal);
    private readonly Dictionary<string, SgValue> _convars = new(StringComparer.Ordinal);
    private readonly Dictionary<int, HashSet<string>> _privileges = [];

    /// <summary>The verifier's simulated address ("verifierAddress"), for a player-match probe.</summary>
    public string? VerifierAddress { get; private set; }

    public static ConfigFile Load(string? path)
    {
        var c = new ConfigFile();
        if (path is null) return c;
        JsonNode? root;
        try { root = JsonNode.Parse(File.ReadAllText(path)); }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException) { throw new UsageException($"cannot read config {path}: {e.Message}"); }
        if (root?["resources"] is JsonObject res)
        {
            foreach (var (name, values) in res)
            {
                if (values is not JsonObject obj) continue;
                var map = c._resources[name] = new Dictionary<string, SgValue>(StringComparer.Ordinal);
                foreach (var (k, v) in obj) map[k] = SgJson.Decode(v?.ToJsonString() ?? "null");
            }
        }
        if (root?["convars"] is JsonObject convars)
        {
            foreach (var (k, v) in convars) c._convars[k] = SgJson.Decode(v?.ToJsonString() ?? "null");
        }
        if (root?["verifierAddress"] is JsonValue address && address.TryGetValue<string>(out var addressText)) c.VerifierAddress = addressText;
        if (root?["permissions"] is JsonObject perms)
        {
            foreach (var (id, privs) in perms)
            {
                if (!int.TryParse(id, out var pid) || privs is not JsonArray arr) continue;
                c._privileges[pid] = new HashSet<string>(arr.Select(p => p?.GetValue<string>() ?? "").Where(p => p.Length > 0), StringComparer.Ordinal);
            }
        }
        return c;
    }

    public SgValue? Get(string? resource, string key)
    {
        if (resource is null) return _convars.TryGetValue(key, out var cv) ? cv : null;
        return _resources.TryGetValue(resource, out var map) && map.TryGetValue(key, out var v) ? v : null;
    }

    public bool Has(int playerId, string privilege) =>
        playerId == 0 || (_privileges.TryGetValue(playerId, out var p) && (p.Contains(privilege) || p.Contains("*")));
}

/// <summary>Verify without --config: every HTTP request answers 599 (no route), like the Lua verify.</summary>
internal sealed class NoRouteHttp : IHostHttp
{
    public Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation) =>
        Task.FromResult(new HttpResponseData(599, new Dictionary<string, string>(), """{"error":{"code":"no_route"}}"""));
}

/// <summary>Notifications go to the log ("ui" falls back to text, as in the Lua standalone host).</summary>
internal sealed class LogUi(Func<IHostLog> log) : IHostUi
{
    public void Notify(int target, SgTable payload) =>
        log().Write(LogLevel.Info, "ui", $"notify {target}: {SgJson.Encode(SgValue.Of(payload))}");
}

/// <summary>Keeps every line for the report and echoes to the console unless quiet.</summary>
internal sealed class RecordingLog(bool echo, LogLevel minimum = LogLevel.Info) : IHostLog
{
    public List<(LogLevel Level, string Origin, string Message)> Lines { get; } = [];

    public void Write(LogLevel level, string origin, string message)
    {
        Lines.Add((level, origin, message));
        if (echo && level >= minimum) Console.WriteLine($"[{Name(level)}] {origin} {message}");
    }

    public static string Name(LogLevel l) => l switch { LogLevel.Debug => "debug", LogLevel.Info => "info", LogLevel.Warn => "warn", _ => "error" };
}

internal static class Resources
{
    /// <summary>Finds a resource folder by name in the search paths (folder name = resource name).</summary>
    public static string? Locate(string name, IEnumerable<string> search)
    {
        foreach (var dir in search)
        {
            var root = Path.Combine(dir, name);
            if (ManifestParser.ManifestFiles.Any(f => File.Exists(Path.Combine(root, f)))) return root;
        }
        return null;
    }

    /// <summary>Adds a resource and, recursively, the dependencies found in the search paths.</summary>
    public static string? AddWithDependencies(ScriptGoHost host, string root, IReadOnlyList<string> search, out string? error)
    {
        if (!host.TryAddResource(root, out var name, out error))
        {
            return error is not null && error.Contains("already loaded", StringComparison.Ordinal) ? name : null;
        }
        foreach (var dep in host.ResourceManifest(name!)!.Dependencies)
        {
            if (host.ResourceNames.Contains(dep.Name)) continue;
            var depRoot = Locate(dep.Name, search);
            if (depRoot is null) continue; // the start reports the missing dependency
            if (AddWithDependencies(host, depRoot, search, out var depError) is null)
            {
                error = depError;
                return null;
            }
        }
        return name;
    }

    /// <summary>Simulated time, but real waits while HTTP is in flight (bounded by a wall-clock limit).</summary>
    public static void Settle(ScriptGoHost host, double ms)
    {
        var target = host.Now + ms / 1000;
        var wallLimit = DateTime.UtcNow.AddSeconds(30);
        while (host.Now < target || (host.PendingIo > 0 && DateTime.UtcNow < wallLimit))
        {
            if (host.PendingIo > 0 && DateTime.UtcNow < wallLimit)
            {
                Thread.Sleep(2);
                host.Tick(host.Now + 0.001);
            }
            else host.Tick(host.Now + 0.01);
        }
    }
}

internal static class Verify
{
    private sealed record Check(string Name, string Status, string Message);

    public static int Run(Args a)
    {
        if (a.Positional.Count == 0) throw new UsageException("verify: give a resource folder");
        var root = Path.GetFullPath(a.Positional[0]);
        var environment = a.Flag("environment") ?? "dotnet";
        var settle = double.TryParse(a.Flag("settle"), out var s) ? s : 2000;
        var search = a.Search.Select(Path.GetFullPath).ToList();
        var watch = Stopwatch.StartNew();
        var checks = new List<Check>();
        void Add(string name, bool ok, string message = "") => checks.Add(new Check(name, ok ? "passed" : "failed", message));

        var log = new RecordingLog(echo: false);
        var clock = new ManualClock();
        var config = ConfigFile.Load(a.Flag("config"));
        var services = new HostServices
        {
            Clock = clock,
            Log = log,
            Storage = new MemoryStorage(),
            Permissions = config,
            Config = config,
            Http = a.Flag("config") is null ? new NoRouteHttp() : new ClientHttp(),
        };
        services.Ui = new LogUi(() => services.Log);

        ResourceManifest? manifest = null;
        var manifestFile = ManifestParser.ManifestFiles.FirstOrDefault(f => File.Exists(Path.Combine(root, f)));
        if (manifestFile is not null)
        {
            var parsed = ManifestParser.Parse(File.ReadAllText(Path.Combine(root, manifestFile)), manifestFile);
            manifest = parsed.Manifest;
            Add("manifest_valid", manifest is not null, manifest is not null ? $"{manifest.Name} {manifest.Version}" : string.Join("; ", parsed.Errors.Select(e => e.Code)));
        }
        else Add("manifest_valid", false, "manifest missing");

        var languages = manifest is null ? [] : ScriptLanguages(manifest);
        // Languages of every resource the run loaded (dependencies and the README example too).
        var ranLanguages = new SortedSet<string>(languages, StringComparer.Ordinal);
        if (manifest is not null)
        {
            Add("environment_declared", manifest.Environments.Count == 0 || manifest.Environments.Contains(environment), environment);
            if (a.Flag("lang") is { } lang)
            {
                var guest = lang == "ts" ? "ts" : lang;
                Add("language", languages.Contains(guest), $"{lang}: the resource's scripts are {(languages.Count > 0 ? string.Join(", ", languages) : "none")}");
            }
            using var host = new ScriptGoHost(services, new HostOptions { Environment = environment });
            var name = Resources.AddWithDependencies(host, root, search, out var addError);
            Add("dependencies_resolved", name is not null, addError ?? "");
            if (name is not null)
            {
                var started = host.Start(name);
                Add("starts", started.Ok, started.Reason ?? "started");
                if (started.Ok)
                {
                    var registered = host.ExportNames(name);
                    foreach (var e in manifest.ServerExports) Add("export:" + e, registered.Contains(e));
                    if (a.Flag("with") is { } with)
                    {
                        var wname = Resources.AddWithDependencies(host, Path.GetFullPath(with), search, out var wError);
                        var w = wname is null ? Outcome.Failure(wError ?? "not loaded") : host.Start(wname);
                        Add("readme_example", w.Ok, w.Ok ? $"{wname} started" : w.Reason ?? "");
                    }
                    foreach (var n in host.ResourceNames) ranLanguages.UnionWith(ScriptLanguages(host.ResourceManifest(n)!));
                    host.PlayerJoin(2, "Verifier", config.VerifierAddress);
                    // Simulated time: long enough for start-up threads and self-checks (SGCHECK lines).
                    Resources.Settle(host, settle);
                    host.PlayerDrop(2, "verify_done");
                    host.StopAll();
                    host.Tick(host.Now);
                    var errors = log.Lines.Where(l => l.Level == LogLevel.Error).ToList();
                    Add("no_runtime_errors", errors.Count == 0, errors.Count > 0 ? errors[0].Message : "");
                }
            }
        }

        var failed = checks.Count(c => c.Status != "passed");
        var report = new JsonObject
        {
            ["package"] = manifest?.Name ?? root,
            ["version"] = manifest?.Version ?? "",
            ["environment"] = environment,
            ["status"] = failed == 0 ? "verified" : "failing",
            ["runtimeVersion"] = KitInfo.Runtime,
            ["adapterVersion"] = "dotnet-" + KitInfo.Kit,
            ["luaVersion"] = ranLanguages.Contains("lua") ? KitInfo.Lua : "",
            ["durationMs"] = watch.ElapsedMilliseconds,
            ["log"] = string.Join("\n", log.Lines.Select(l => $"[{RecordingLog.Name(l.Level)}] {l.Origin} {l.Message}")),
            ["checks"] = new JsonArray(checks.Select(c => (JsonNode)new JsonObject { ["name"] = c.Name, ["status"] = c.Status, ["message"] = c.Message }).ToArray()),
            ["evidence"] = new JsonObject
            {
                ["kit"] = "ScriptGo.Host " + KitInfo.Kit,
                ["languages"] = string.Join(",", languages),
                ["ranLanguages"] = string.Join(",", ranLanguages),
            },
        };
        var text = report.ToJsonString(new JsonSerializerOptions { WriteIndented = false, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        if (a.Flag("report") is { } reportPath) File.WriteAllText(reportPath, text, new UTF8Encoding(false));
        foreach (var c in checks) Console.WriteLine($"  {(c.Status == "passed" ? "ok    " : "FAIL  ")}{c.Name} {c.Message}");
        Console.WriteLine($"{report["package"]}: {report["status"]}");
        return failed == 0 ? 0 : 1;
    }

    /// <summary>Languages of the scripts as a developer names them: lua, ts, js.</summary>
    public static List<string> ScriptLanguages(ResourceManifest m)
    {
        var all = m.SharedScripts.Concat(m.ServerScripts).Concat(m.ClientScripts).Concat(m.EnvironmentScripts.Values.SelectMany(v => v));
        var set = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var p in all)
        {
            if (p.EndsWith(".lua", StringComparison.Ordinal)) set.Add("lua");
            else if (p.EndsWith(".ts", StringComparison.Ordinal)) set.Add("ts");
            else if (p.EndsWith(".js", StringComparison.Ordinal)) set.Add("js");
        }
        return [.. set];
    }
}

internal static class RunCommand
{
    public static int Run(Args a)
    {
        if (a.Positional.Count == 0) throw new UsageException("run: give at least one resource folder");
        var search = a.Search.Select(Path.GetFullPath).ToList();
        var realtime = a.Switches.Contains("realtime");
        var config = ConfigFile.Load(a.Flag("config"));
        var clock = new ManualClock();
        var services = new HostServices
        {
            Clock = realtime ? new SystemClock() : clock,
            Log = new RecordingLog(echo: !a.Switches.Contains("quiet")),
            Storage = a.Flag("data") is { } data ? new FolderStorage(data) : new MemoryStorage(),
            Permissions = config,
            Config = config,
            Http = new ClientHttp(),
        };
        services.Ui = new LogUi(() => services.Log);
        using var host = new ScriptGoHost(services);
        var names = new List<string>();
        foreach (var p in a.Positional)
        {
            var name = Resources.AddWithDependencies(host, Path.GetFullPath(p), search, out var error)
                ?? throw new UsageException(error ?? $"cannot load {p}");
            names.Add(name);
        }
        var failed = host.StartAll().Count(kv => kv.Value != "started");
        host.PlayerJoin(1, "Player");
        var ms = double.TryParse(a.Flag("for"), out var f) ? f : 1000;
        if (realtime)
        {
            var end = DateTime.UtcNow.AddMilliseconds(ms);
            while (DateTime.UtcNow < end) { host.Tick(); Thread.Sleep(5); }
        }
        else Resources.Settle(host, ms);
        host.StopAll();
        host.Tick(host.Now);
        return failed == 0 ? 0 : 1;
    }
}
