using System.Text;

namespace ScriptGo.Host.Tests;

/// <summary>Collects log lines (and echoes errors to the test output).</summary>
internal sealed class CaptureLog : IHostLog
{
    public List<(LogLevel Level, string Origin, string Message)> Lines { get; } = [];

    public void Write(LogLevel level, string origin, string message) => Lines.Add((level, origin, message));

    public IEnumerable<string> Messages => Lines.Select(l => l.Message);

    public bool Has(string fragment) => Lines.Any(l => l.Message.Contains(fragment, StringComparison.Ordinal));

    public override string ToString() => string.Join("\n", Lines.Select(l => $"[{l.Level}] {l.Origin} {l.Message}"));
}

/// <summary>Resource folders in a temporary directory, and a host over them with simulated time.</summary>
internal sealed class Sandbox : IDisposable
{
    public Sandbox(HostOptions? options = null, Action<HostServices>? configure = null)
    {
        Root = Path.Combine(Path.GetTempPath(), "sg-dotnet-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Root);
        Services = new HostServices { Clock = Clock, Log = Log, Storage = new MemoryStorage() };
        configure?.Invoke(Services);
        Options = options ?? new HostOptions();
    }

    public string Root { get; }
    public ManualClock Clock { get; } = new();
    public CaptureLog Log { get; } = new();
    public HostServices Services { get; }
    public HostOptions Options { get; }

    private ScriptGoHost? _host;
    public ScriptGoHost Host => _host ??= new ScriptGoHost(Services, Options);

    /// <summary>Writes a resource folder: the manifest file and the given files.</summary>
    public string Resource(string name, string manifest, params (string Path, string Content)[] files)
    {
        var dir = Path.Combine(Root, name);
        Directory.CreateDirectory(dir);
        var manifestName = manifest.TrimStart().StartsWith('{') ? "scriptgo.json" : "scriptgo.lua";
        File.WriteAllText(Path.Combine(dir, manifestName), manifest, new UTF8Encoding(false));
        foreach (var (path, content) in files)
        {
            var full = Path.Combine(dir, path.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content, new UTF8Encoding(false));
        }
        return dir;
    }

    /// <summary>A resource whose server scripts are given inline (language from the extension).</summary>
    public string Server(string name, params (string Path, string Content)[] scripts) =>
        Resource(name, Manifest(name, scripts.Select(s => s.Path), deps: []), scripts);

    public static string Manifest(string name, IEnumerable<string> serverScripts, string[] deps, string extra = "")
    {
        var sb = new StringBuilder();
        sb.AppendLine($"resource \"{name}\"");
        sb.AppendLine("version \"1.0.0\"");
        sb.AppendLine("scriptgo_version \">=0.1.0\"");
        foreach (var d in deps) sb.AppendLine($"dependency \"{d}\"");
        foreach (var s in serverScripts) sb.AppendLine($"server_script \"{(s.EndsWith(".ts.js", StringComparison.Ordinal) ? s[..^3] : s)}\"");
        sb.Append(extra);
        return sb.ToString();
    }

    public void Start(params string[] names)
    {
        foreach (var n in names) Host.AddResource(Path.Combine(Root, n));
        foreach (var n in names)
        {
            var r = Host.Start(n);
            Assert.IsTrue(r.Ok, $"start {n}: {r.Reason}\n{Log}");
        }
    }

    /// <summary>Lines the resources printed (print / console.log / ScriptGo.log.info).</summary>
    public List<string> Printed => Log.Lines.Where(l => l.Level == LogLevel.Info && l.Origin.Contains(':')).Select(l => l.Message).ToList();

    public void Dispose()
    {
        _host?.Dispose();
        try { Directory.Delete(Root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}
