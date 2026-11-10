// The SCRIPT//GO host for .NET: loads resources (scriptgo.lua / scriptgo.json / open77.lua), runs
// each resource side in one guest VM per language (Lua through KeraLua, JavaScript through Jint),
// and routes events, exports, commands and storage between them. Same semantics as the portable
// Lua core (sdk/lua/scriptgo/host.lua); the cross-language rules are docs/spec/multi-language.md.
using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;
using ScriptGo.Host.Manifest;

namespace ScriptGo.Host;

/// <summary>Success, or a failure token.</summary>
public readonly record struct Outcome(bool Ok, string? Reason)
{
    public static readonly Outcome Success = new(true, null);
    public static Outcome Failure(string reason) => new(false, reason);
}

/// <summary>An export call made from outside any resource (tests, tools, the integrator).</summary>
public sealed class ExportCall
{
    public bool IsSettled { get; internal set; }
    public bool Ok { get; internal set; }
    public SgValue[] Values { get; internal set; } = [];
    public string? Reason { get; internal set; }
}

public sealed partial class ScriptGoHost : IDisposable
{
    /// <summary>The version of this kit.</summary>
    public const string KitVersion = "0.1.0";
    /// <summary>The runtime API version resources see (ScriptGo.runtime.version), shared with the Lua core.</summary>
    public const string RuntimeVersion = "0.1.0";
    /// <summary>The runtime IDL this kit implements (docs/spec/runtime-idl.json).</summary>
    public const int SpecVersion = 1;

    private static readonly string[] SideOrder = ["server", "client"];

    private readonly Dictionary<string, Resource> _resources = new(StringComparer.Ordinal);
    private readonly List<string> _order = [];
    private List<QueuedEvent> _queue = [];
    private readonly Dictionary<string, List<CommandEntry>> _commands = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Dictionary<string, SgValue>> _storage = new(StringComparer.Ordinal);
    private readonly SortedDictionary<int, string> _players = [];
    private readonly Dictionary<string, NativeModule> _natives = new(StringComparer.Ordinal);
    private readonly HashSet<string> _capabilities = new(StringComparer.Ordinal);
    private readonly Dictionary<int, AsyncCall> _asyncCalls = [];
    private readonly ConcurrentQueue<Action> _completions = new();
    private readonly List<LogEntry> _logs = [];
    private readonly List<Guest> _disposeLater = [];
    private readonly List<(string Name, string Reason)> _pendingStops = [];
    private int _guestDepth, _nextCallId, _syncDepth, _pendingIo;
    private bool _disposed;

    public ScriptGoHost(IHostServices services, HostOptions? options = null)
    {
        Services = services ?? throw new ArgumentNullException(nameof(services));
        Options = options ?? new HostOptions();
        var provided = new List<string> { "events", "logging", "players" };
        if (services.Storage is not null) provided.Add("storage");
        if (services.Permissions is not null) provided.Add("permissions");
        if (Options.Commands) provided.Add("commands");
        if (services.Config is not null) provided.Add("config");
        if (services.Ui is not null) provided.Add("ui");
        if (services.Http is not null) { provided.Add("http"); provided.Add("licensing"); provided.Add("perks"); }
        foreach (var c in provided)
        {
            if (c is "events" or "logging" || Options.Capabilities is null || Options.Capabilities.Contains(c)) _capabilities.Add(c);
        }
        // Player perks are the portable core's module, running over the kit's HTTP: no HTTP, no perks.
        if (!_capabilities.Contains("http")) _capabilities.Remove("perks");
        Now = services.Clock.MonotonicMilliseconds() / 1000.0;
    }

    public IHostServices Services { get; }
    public HostOptions Options { get; }
    public string Environment => Options.Environment;
    /// <summary>Scheduler time in seconds (the last tick's).</summary>
    public double Now { get; private set; }
    public long TickCount { get; private set; }
    public IReadOnlyList<LogEntry> Logs => _logs;
    /// <summary>Requests (HTTP) still in flight.</summary>
    public int PendingIo => Volatile.Read(ref _pendingIo);

    /// <summary>Capabilities resources can rely on here (standard ones, then x- extensions).</summary>
    public IReadOnlyList<string> Capabilities =>
        ManifestParser.Capabilities.Where(_capabilities.Contains)
            .Concat(_capabilities.Where(c => c.StartsWith("x-", StringComparison.Ordinal)).Order(StringComparer.Ordinal)).ToList();

    public bool HasCapability(string capability) => _capabilities.Contains(capability);

    /// <summary>
    /// Capabilities a guest of that language can rely on. Player perks are implemented once, in Lua
    /// (the portable core's perks module, which the Lua guest runs): JavaScript and TypeScript guests
    /// do not have them yet, and are told so (<c>capability_unavailable:perks@&lt;environment&gt;</c>).
    /// </summary>
    internal IEnumerable<string> CapabilitiesFor(string language) => language == "lua" ? Capabilities : Capabilities.Where(c => c != "perks");

    internal static string Unavailable(string capability, string environment) => $"capability_unavailable:{capability}@{environment}";

    // Logging ----------------------------------------------------------------------------------------

    public void Log(LogLevel level, string origin, string message)
    {
        _logs.Add(new LogEntry(level, origin, message, Now));
        if (_logs.Count > 2000) _logs.RemoveAt(0);
        Services.Log.Write(level, origin, message);
    }

    // Native modules -----------------------------------------------------------------------------------

    private static readonly HashSet<string> ReservedGlobals = new(StringComparer.Ordinal)
    {
        "ScriptGo", "Open77", "exports", "source", "print", "console", "promise", "Citizen", "json", "string", "table",
        "math", "os", "utf8", "bit", "require", "globalThis", "JSON", "Math", "Promise", "Object", "Array",
    };

    /// <summary>Registers a native module; every guest started after this sees ScriptGo.natives.&lt;name&gt;.</summary>
    public void RegisterNativeModule(NativeModule module)
    {
        var problems = module.Validate().ToList();
        if (module.Global && ReservedGlobals.Contains(module.Name)) problems.Add($"'{module.Name}' cannot be a global: the runtime uses that name");
        if (_natives.ContainsKey(module.Name)) problems.Add($"a native module named '{module.Name}' is already registered");
        if (problems.Count > 0) throw new ArgumentException($"native module {module.Name}: {string.Join("; ", problems)}");
        _natives[module.Name] = module;
        if (module.Capability is not null) _capabilities.Add(module.Capability);
    }

    public IReadOnlyCollection<NativeModule> NativeModules => _natives.Values;

    // Resources -------------------------------------------------------------------------------------

    /// <summary>Adds a resource folder. Returns its name; throws <see cref="InvalidOperationException"/> with the reason.</summary>
    public string AddResource(string root, bool checkFolderName = true)
    {
        if (!TryAddResource(root, out var name, out var error, checkFolderName)) throw new InvalidOperationException(error);
        return name!;
    }

    public bool TryAddResource(string root, out string? name, out string? error, bool checkFolderName = true)
    {
        name = null;
        root = root.TrimEnd('/', '\\');
        string? source = null, fileName = null;
        foreach (var candidate in ManifestParser.ManifestFiles)
        {
            var bytes = Services.Files.Read(root, candidate);
            if (bytes is null) continue;
            source = Encoding.UTF8.GetString(bytes);
            fileName = candidate;
            break;
        }
        if (source is null) { error = $"no scriptgo.lua, scriptgo.json or open77.lua in {root}"; return false; }
        var parsed = ManifestParser.Parse(source, fileName!);
        if (!parsed.Ok)
        {
            error = $"invalid manifest in {root}: " + string.Join("; ", parsed.Errors.Select(e => $"{e.Code}: {e.Message}"));
            return false;
        }
        var m = parsed.Manifest!;
        var folder = Path.GetFileName(root);
        if (checkFolderName && folder != m.Name) { error = $"resource name '{m.Name}' must match its folder '{folder}'"; return false; }
        if (_resources.ContainsKey(m.Name)) { name = m.Name; error = $"resource '{m.Name}' is already loaded"; return false; }
        _resources[m.Name] = new Resource(m.Name, m, root, parsed.Warnings);
        _order.Add(m.Name);
        name = m.Name;
        error = null;
        return true;
    }

    public IReadOnlyList<string> ResourceNames => _order;

    public string ResourceState(string name) => _resources.TryGetValue(name, out var r) ? r.State : "missing";

    public string? ResourceFailure(string name) => _resources.TryGetValue(name, out var r) ? r.Failure : null;

    public ResourceManifest? ResourceManifest(string name) => _resources.TryGetValue(name, out var r) ? r.Manifest : null;

    public IReadOnlyList<Diagnostic> ResourceWarnings(string name) => _resources.TryGetValue(name, out var r) ? r.Warnings : [];

    /// <summary>Starts a resource and its dependencies.</summary>
    public Outcome Start(string name)
    {
        var result = StartInternal(name, new HashSet<string>(StringComparer.Ordinal));
        FlushDeferred();
        return result;
    }

    private Outcome Fail(Resource res, string why)
    {
        res.State = "failed";
        res.Failure = why;
        Log(LogLevel.Error, "host", $"{res.Name}: {why}");
        return Outcome.Failure(why);
    }

    private Outcome StartInternal(string name, HashSet<string> visiting)
    {
        if (!_resources.TryGetValue(name, out var res)) return Outcome.Failure("missing");
        if (res.State == "started") return Outcome.Success;
        if (!visiting.Add(name)) return Outcome.Failure("dependency cycle through " + name);
        var m = res.Manifest;
        foreach (var dep in m.Dependencies)
        {
            if (!_resources.TryGetValue(dep.Name, out var d)) return Fail(res, "missing dependency " + dep.Name);
            if (dep.Range is not null && !Semver.Satisfies(d.Manifest.Version, dep.Range))
                return Fail(res, $"dependency {dep.Name} {d.Manifest.Version} does not satisfy {dep.Range}");
            var started = StartInternal(dep.Name, visiting);
            if (!started.Ok) return Fail(res, $"dependency {dep.Name} failed: {started.Reason}");
        }
        if (m.ScriptgoVersion is not null && !Semver.Satisfies(RuntimeVersion, m.ScriptgoVersion))
            return Fail(res, $"requires scriptgo {m.ScriptgoVersion}, host is {RuntimeVersion}");
        foreach (var c in m.Capabilities)
            if (!_capabilities.Contains(c)) return Fail(res, Unavailable(c, Environment));
        // A resource that requires perks and brings a JavaScript or TypeScript server script cannot
        // have them here: only Lua guests run the perks module.
        if (m.Capabilities.Contains("perks"))
        {
            var own = m.EnvironmentScripts.TryGetValue(Environment, out var envScripts) ? envScripts : [];
            if (m.SharedScripts.Concat(m.ServerScripts).Concat(own).Any(p => ManifestParser.LanguageOf(p) is { } lang && lang != "lua"))
                return Fail(res, Unavailable("perks", Environment));
        }
        // Only the scripts this host would run count: its sides and its own environment scripts.
        var env = m.EnvironmentScripts.TryGetValue(Environment, out var e) ? e : [];
        var runs = new List<IReadOnlyList<string>> { m.SharedScripts, env };
        if (Options.ServerSide) runs.Add(m.ServerScripts);
        if (Options.ClientSide) runs.Add(m.ClientScripts);
        foreach (var path in runs.SelectMany(p => p))
        {
            var lang = ManifestParser.LanguageOf(path);
            if (lang is not null && !Options.Languages.Contains(lang)) return Fail(res, $"language_unavailable:{lang}@{Environment}");
        }
        if (m.Environments.Count > 0 && !m.Environments.Contains(Environment))
            Log(LogLevel.Warn, "host", $"{name}: environment_undeclared ({Environment})");

        res.State = "starting";
        res.Generation++;
        res.Sides.Clear();
        foreach (var sideName in SideOrder)
        {
            var enabled = sideName == "server" ? Options.ServerSide : Options.ClientSide;
            var own = sideName == "server" ? m.ServerScripts : m.ClientScripts;
            if (enabled && (m.SharedScripts.Count > 0 || own.Count > 0)) res.Sides[sideName] = new SideRuntime(this, res, sideName);
        }
        Outcome FailStart(string why)
        {
            KillSides(res);
            return Fail(res, why);
        }
        IReadOnlyList<string>? listing = null;
        foreach (var sideName in SideOrder)
        {
            if (!res.Sides.TryGetValue(sideName, out var side)) continue;
            var entries = m.SharedScripts.Concat(sideName == "server" ? m.ServerScripts : m.ClientScripts).Concat(env);
            var scripts = new List<string>();
            foreach (var p in entries)
            {
                if (ManifestParser.IsGlob(p))
                {
                    listing ??= Services.Files.List(res.Root);
                    // A compiled TypeScript output (x.ts.js next to x.ts) is not a script of its own.
                    var known = listing;
                    scripts.AddRange(ManifestParser.ExpandGlob(p, listing)
                        .Where(f => !(f.EndsWith(".ts.js", StringComparison.Ordinal) && known.Contains(f[..^3]))));
                }
                else scripts.Add(p);
            }
            foreach (var rel in scripts)
            {
                var lang = ManifestParser.LanguageOf(rel)!;
                // TypeScript runs as the JavaScript `scriptgo pack` compiled next to it (<entry>.js).
                var file = rel.EndsWith(".ts", StringComparison.Ordinal) ? rel + ".js" : rel;
                // A provider that holds the source in native memory (an escrowed resource) compiles
                // Lua itself: the plaintext then never becomes a managed array on its way to the VM.
                var native = lang == "lua" && Services.Files is INativeLuaChunks chunks && chunks.HasNativeChunk(res.Root, file);
                var bytes = native ? null : Services.Files.Read(res.Root, file);
                if (!native && bytes is null)
                    return FailStart(file == rel ? $"cannot read {rel}" : $"typescript_not_compiled:{rel} (run scriptgo pack or scriptgo verify)");
                Guest guest;
                try { guest = GuestFor(side, lang); }
                catch (Exception ex) { return FailStart($"{lang} guest failed to start: {ex.Message}"); }
                try
                {
                    if (native)
                    {
                        if (!guest.TryRunNativeScript(rel)) return FailStart($"cannot read {rel}");
                    }
                    else guest.RunScript(rel, bytes!);
                }
                catch (GuestScriptException ex) { return FailStart($"{rel}: {ex.Message}"); }
                if (!side.Alive || !guest.Alive) return FailStart(res.Failure ?? $"{rel}: stopped while loading");
            }
            // Declarative exports (OPEN//77): global functions published after the side's last script.
            foreach (var exportName in sideName == "server" ? m.ServerExports : m.Exports)
            {
                if (!side.Guests.Any(g => g.PublishGlobal(exportName))) return FailStart("manifest_export_missing:" + exportName);
            }
        }
        res.State = "started";
        res.Failure = null;
        Log(LogLevel.Info, "host", $"started {name} {m.Version}");
        Broadcast("server", "onResourceStart", Sv(name));
        Broadcast("client", "onClientResourceStart", Sv(name));
        return Outcome.Success;
    }

    private Guest GuestFor(SideRuntime side, string language)
    {
        var existing = side.GuestFor(language);
        if (existing is not null) return existing;
        Guest guest = language switch
        {
            "lua" => new LuaGuest(side),
            "js" => new JsGuest(side),
            _ => throw new NotSupportedException("no guest for " + language),
        };
        side.Guests.Add(guest);
        guest.Initialize();
        return guest;
    }

    private void KillSides(Resource res)
    {
        foreach (var side in res.Sides.Values)
        {
            side.Kill();
            _disposeLater.AddRange(side.Guests);
            foreach (var call in _asyncCalls.Values.Where(c => c.Target == side).ToList())
            {
                _asyncCalls.Remove(call.Id);
                call.Complete(false, [], "export_target_stopped");
            }
        }
        DropCommands(res.Name);
        res.Sides.Clear();
    }

    /// <summary>Stops a resource (its dependents first).</summary>
    public bool Stop(string name, string? reason = null)
    {
        if (_guestDepth > 0)
        {
            _pendingStops.Add((name, reason ?? "stopped"));
            return true;
        }
        var stopped = StopInternal(name, reason ?? "stopped");
        FlushDeferred();
        return stopped;
    }

    /// <summary>
    /// Stops a resource from any thread: the stop is queued and applied by the next <see cref="Tick"/>,
    /// on the host's own thread. For callbacks that do not run there, such as an escrow revocation.
    /// </summary>
    public void StopOnNextTick(string name, string reason) => _completions.Enqueue(() => Stop(name, reason));

    /// <summary>The root of the resource a guest may compile a chunk from: its own, or a declared
    /// dependency's. Null when the dependency is not declared or not loaded.</summary>
    internal string? ChunkRoot(Guest guest, string? library)
    {
        var res = guest.Side.Res;
        if (library is null) return res.Root;
        return res.Manifest.Dependencies.Any(d => d.Name == library) && _resources.TryGetValue(library, out var dependency)
            ? dependency.Root
            : null;
    }

    private bool StopInternal(string name, string reason)
    {
        if (!_resources.TryGetValue(name, out var res) || res.State != "started") return false;
        foreach (var other in _order.ToArray())
        {
            var r = _resources[other];
            if (r.State == "started" && r.Manifest.Dependencies.Any(d => d.Name == name)) StopInternal(other, "dependency_stopped");
        }
        Broadcast("server", "onResourceStop", Sv(name), Sv(reason));
        Broadcast("client", "onClientResourceStop", Sv(name), Sv(reason));
        KillSides(res);
        res.State = reason.StartsWith("quota_exceeded", StringComparison.Ordinal) ? "failed" : "stopped";
        if (res.State == "failed") res.Failure = reason;
        Log(LogLevel.Info, "host", $"stopped {name}" + (reason == "stopped" ? "" : $" ({reason})"));
        return true;
    }

    /// <summary>Starts every auto_start resource in load order. Returns the outcome per resource.</summary>
    public IReadOnlyDictionary<string, string> StartAll()
    {
        var results = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var name in _order.ToArray())
        {
            var res = _resources[name];
            if (res.Manifest.AutoStart && res.State != "started" && res.State != "failed")
            {
                var o = Start(name);
                results[name] = o.Ok ? "started" : o.Reason!;
            }
        }
        return results;
    }

    public void StopAll()
    {
        for (var i = _order.Count - 1; i >= 0; i--) Stop(_order[i], "host_shutdown");
    }

    /// <summary>Called by a guest that went over a quota: the resource stops once no guest is executing.</summary>
    internal void RequestStop(string resource, string reason)
    {
        if (!_pendingStops.Any(p => p.Name == resource)) _pendingStops.Add((resource, reason));
    }

    /// <summary>
    /// Counts host-level entries (a guest entered while no guest runs). Budgets are per epoch: a guest
    /// gets a fresh budget the first time it runs in an epoch, so a resource calling another resource's
    /// export in a loop cannot hand the callee a fresh budget on every call.
    /// </summary>
    internal long BudgetEpoch { get; private set; }

    internal void EnterGuest()
    {
        if (_guestDepth == 0) BudgetEpoch++;
        _guestDepth++;
    }

    internal void LeaveGuest() => _guestDepth--;

    private void FlushDeferred()
    {
        if (_guestDepth > 0) return;
        while (_pendingStops.Count > 0)
        {
            var (name, reason) = _pendingStops[0];
            _pendingStops.RemoveAt(0);
            if (_resources.TryGetValue(name, out var res) && res.State is "started")
            {
                Log(LogLevel.Error, "host", $"{name}: {reason}");
                StopInternal(name, reason);
            }
            else if (res is not null && res.State == "starting")
            {
                KillSides(res);
                Fail(res, reason);
            }
        }
        if (_disposeLater.Count > 0)
        {
            var batch = _disposeLater.ToArray();
            _disposeLater.Clear();
            foreach (var g in batch) g.Dispose();
        }
    }

    // Events --------------------------------------------------------------------------------------------

    private static SgValue Sv(string s) => SgValue.Of(s);

    /// <summary>A host event to every started resource on a side (lifecycle, players, engine events).</summary>
    public void Emit(string side, string name, params SgValue[] args)
    {
        Broadcast(side, name, args);
        FlushDeferred();
    }

    internal void Broadcast(string side, string name, params SgValue[] args) => Fanout(side, name, default, args);

    /// <summary>Resource names in name order: the order the server bus fans out in (as OPEN//77).</summary>
    private string[] ByName() => _order.Order(StringComparer.Ordinal).ToArray();

    internal void Fanout(string sideName, string name, CallContext ctx, SgValue[] args)
    {
        foreach (var rname in ByName())
        {
            var r = _resources[rname];
            if ((r.State == "started" || r.State == "starting") && r.Sides.TryGetValue(sideName, out var side)) Dispatch(side, name, args, ctx, false);
        }
    }

    internal int Dispatch(SideRuntime side, string name, SgValue[] args, CallContext ctx, bool netOnly)
    {
        if (!side.Alive) return 0;
        if (netOnly && !side.NetEvents.Contains(name)) return 0;
        if (!side.Handlers.TryGetValue(name, out var list)) return 0;
        var snapshot = list.ToArray();
        foreach (var h in snapshot)
        {
            if (side.Alive && h.Guest.Alive) h.Guest.RunHandler(h.Id, ctx, args);
        }
        return snapshot.Length;
    }

    internal Outcome Queue(string kind, string target, string name, SgValue[] args, CallContext ctx)
    {
        if (_queue.Count >= Options.Quotas.EventQueue) return Outcome.Failure("event_queue_limit");
        _queue.Add(new QueuedEvent(kind, target, name, args, ctx));
        return Outcome.Success;
    }

    private void Drain()
    {
        var queue = _queue;
        _queue = [];
        if (queue.Count == 0) return;
        var names = ByName();
        foreach (var msg in queue)
        {
            foreach (var rname in names)
            {
                var r = _resources[rname];
                if (r.State == "started" && r.Sides.TryGetValue(msg.Target, out var side)) Dispatch(side, msg.Name, msg.Args, msg.Context, msg.Kind == "net");
            }
        }
    }

    // Players -------------------------------------------------------------------------------------------

    /// <summary>A player joined: playerJoining (source = id) and onPlayerConnected(id) on the server side.</summary>
    public void PlayerJoin(int id, string? name = null)
    {
        _players[id] = name ?? $"Player {id}";
        Fanout("server", "playerJoining", new CallContext(id, null), [SgValue.Of(id)]);
        Fanout("server", "onPlayerConnected", default, [SgValue.Of(id)]);
        FlushDeferred();
    }

    public void PlayerDrop(int id, string? reason = null)
    {
        if (!_players.ContainsKey(id)) return;
        reason ??= "disconnected";
        Fanout("server", "playerDropped", new CallContext(id, null), [SgValue.Of(reason)]);
        Fanout("server", "onPlayerDisconnected", default, [SgValue.Of(id), SgValue.Of(reason)]);
        _players.Remove(id);
        FlushDeferred();
    }

    public IReadOnlyList<int> PlayerList() => Services.Players?.List() ?? _players.Keys.ToList();

    public string? PlayerName(int id)
    {
        if (Services.Players is { } p) return p.Name(id);
        return _players.TryGetValue(id, out var n) ? n : null;
    }

    /// <summary>A stable identifier for storage keys (the engine's account id when the integrator provides one).</summary>
    public string? PlayerIdentifier(int id)
    {
        if (Services.Players is { } p) return p.Identifier(id);
        if (!_players.TryGetValue(id, out var n)) return null;
        return "local:" + Regex.Replace(n.ToLowerInvariant(), "[^a-z0-9_-]", "_");
    }

    // Commands ------------------------------------------------------------------------------------------

    private void DropCommands(string resource)
    {
        foreach (var (name, list) in _commands.ToArray())
        {
            list.RemoveAll(c => c.Side.Res.Name == resource);
            if (list.Count == 0) _commands.Remove(name);
        }
    }

    public IReadOnlyList<string> CommandList() => _commands.Keys.Order(StringComparer.Ordinal).ToList();

    /// <summary>
    /// Runs a command line as <paramref name="source"/> (0 = console). Names are case-insensitive; the
    /// handler gets (source, args, raw) and runs on the next tick. A player's line reaches a client
    /// command of that name first, then the server's.
    /// </summary>
    public Outcome ExecuteCommand(int source, string line)
    {
        var match = Regex.Match(line, @"^\s*/?(\S+)\s*(.*?)\s*$", RegexOptions.Singleline);
        if (!match.Success) return Outcome.Failure("empty_command");
        var name = match.Groups[1].Value.ToLowerInvariant();
        if (!_commands.TryGetValue(name, out var list) || list.Count == 0) return Outcome.Failure("unknown_command:" + name);
        CommandEntry? entry = null;
        if (source != 0) entry = list.LastOrDefault(c => c.Side.Name == "client");
        entry ??= list.LastOrDefault(c => c.Side.Name == "server");
        if (entry is null) return Outcome.Failure("unknown_command:" + name);
        if (entry.Restricted && source != 0 && Services.Permissions?.Has(source, "command." + name) != true) return Outcome.Failure("not_allowed");
        var words = Regex.Split(match.Groups[2].Value, @"\s+").Where(w => w.Length > 0).ToArray();
        var raw = words.Length > 0 ? name + " " + string.Join(' ', words) : name;
        entry.Guest.RunCommand(entry.Name, source, words.Select(SgValue.Of).ToArray(), raw);
        FlushDeferred();
        return Outcome.Success;
    }

    // Exports from outside -------------------------------------------------------------------------------

    /// <summary>Calls an export from outside any resource; the answer arrives on a later tick.</summary>
    public ExportCall CallExport(string resource, string export, string side = "server", params SgValue[] args)
    {
        var call = new ExportCall();
        var r = StartAsyncExport("host", side, resource, export, args, (ok, values, reason) =>
        {
            call.IsSettled = true;
            call.Ok = ok;
            call.Values = values;
            call.Reason = reason;
        });
        if (!r.Ok)
        {
            call.IsSettled = true;
            call.Reason = r.Reason;
        }
        FlushDeferred();
        return call;
    }

    /// <summary>The exports a started resource registered on a side, sorted.</summary>
    public IReadOnlyList<string> ExportNames(string resource, string side = "server") =>
        _resources.TryGetValue(resource, out var r) && r.Sides.TryGetValue(side, out var s)
            ? s.Exports.Keys.Order(StringComparer.Ordinal).ToList()
            : [];

    /// <summary>Same, ticking simulated time until the call settles (synchronous callers only).</summary>
    public ExportCall CallExportSync(string resource, string export, string side = "server", double timeoutMs = 5000, params SgValue[] args)
    {
        var call = CallExport(resource, export, side, args);
        RunUntil(() => call.IsSettled, timeoutMs);
        if (!call.IsSettled)
        {
            call.IsSettled = true;
            call.Reason = "timeout";
        }
        return call;
    }

    // Tick ----------------------------------------------------------------------------------------------

    /// <summary>One scheduler pass. <paramref name="nowSeconds"/> overrides the clock (simulated time).</summary>
    public void Tick(double? nowSeconds = null)
    {
        var now = nowSeconds ?? Services.Clock.MonotonicMilliseconds() / 1000.0;
        if (now > Now) Now = now;
        TickCount++;
        while (_completions.TryDequeue(out var done)) done();
        Drain();
        foreach (var rname in _order.ToArray())
        {
            var r = _resources[rname];
            foreach (var sideName in SideOrder)
            {
                if (!r.Sides.TryGetValue(sideName, out var side) || !side.Alive) continue;
                foreach (var g in side.Guests.ToArray()) if (side.Alive && g.Alive) g.Tick(Now, TickCount);
            }
        }
        FlushDeferred();
    }

    /// <summary>Ticks simulated time for <paramref name="ms"/> milliseconds (tests, verify runs).</summary>
    public void RunFor(double ms, double stepMs = 10)
    {
        var target = Now + ms / 1000;
        while (Now < target) Tick(Now + stepMs / 1000);
    }

    /// <summary>Ticks until <paramref name="done"/> or the timeout (simulated ms); waits for real I/O when some is in flight.</summary>
    public bool RunUntil(Func<bool> done, double timeoutMs, double stepMs = 10)
    {
        var deadline = Now + timeoutMs / 1000;
        var wallDeadline = DateTime.UtcNow.AddMilliseconds(Math.Max(timeoutMs, 15000));
        while (!done())
        {
            if (PendingIo > 0)
            {
                if (DateTime.UtcNow > wallDeadline) return false;
                Thread.Sleep(2);
                Tick(Now + 0.001);
                continue;
            }
            if (Now >= deadline) return false;
            Tick(Now + stepMs / 1000);
        }
        return true;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        foreach (var r in _resources.Values) KillSides(r);
        foreach (var g in _disposeLater) g.Dispose();
        _disposeLater.Clear();
    }
}
