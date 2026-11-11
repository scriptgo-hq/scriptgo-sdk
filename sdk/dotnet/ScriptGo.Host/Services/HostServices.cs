// What the integrator implements: the engine's "native link". Every member except Clock, Files and
// Log is optional; a missing service turns its capability off (ScriptGo.<capability> then raises
// capability_unavailable:<capability>@<environment>). See sdk/dotnet/README.md.
namespace ScriptGo.Host;

/// <summary>Time. Monotonic milliseconds drive the scheduler; Unix seconds are the wall clock.</summary>
public interface IHostClock
{
    double MonotonicMilliseconds();
    /// <summary>Unix time in seconds, or null where the side has no wall clock.</summary>
    long? UnixSeconds();
}

/// <summary>Read access to resource folders (or archives). Paths are resource-relative with '/'.</summary>
public interface IResourceFiles
{
    byte[]? Read(string root, string relativePath);
    /// <summary>Every file of the resource, relative with '/' (used to expand script globs).</summary>
    IReadOnlyList<string> List(string root);
}

/// <summary>
/// An optional companion of <see cref="IResourceFiles"/>, for a provider that holds script source in
/// memory it does not want copied into the managed heap (an escrowed resource held by libscriptgo).
/// When the host's <see cref="IHostServices.Files"/> also implements this, a Lua script the provider
/// claims is compiled straight into the guest's <c>lua_State</c> and <see cref="IResourceFiles.Read"/>
/// is not called for it. JavaScript guests have no such path: Jint takes managed source.
/// </summary>
public interface INativeLuaChunks
{
    /// <summary>True when this provider compiles <paramref name="relativePath"/> itself.</summary>
    bool HasNativeChunk(string root, string relativePath);

    /// <summary>Compiles the script into <paramref name="luaState"/> (text mode only). On
    /// <see cref="NativeChunkStatus.Loaded"/> the function is on top of the Lua stack; on
    /// <see cref="NativeChunkStatus.LuaError"/> Lua's message is; otherwise nothing was pushed.</summary>
    NativeChunkStatus LoadChunk(string root, string relativePath, IntPtr luaState, string chunkName);
}

public enum NativeChunkStatus { Loaded, NotFound, LuaError }

/// <summary>Per-resource persistent storage: one JSON document per key ("res" or "res.client").</summary>
public interface IHostStorage
{
    string? Load(string key);
    void Save(string key, string json);
}

/// <summary>Players of the engine. Ids are integers >= 1; invalid ids answer null.</summary>
public interface IHostPlayers
{
    IReadOnlyList<int> List();
    string? Name(int id);
    string? Identifier(int id);
}

/// <summary>
/// Optional, implemented by the <see cref="IHostPlayers"/> object: a connected player's network address
/// ("ip" or "ip:port"), for player match (docs/spec/player-match.md). Null when unknown. The address
/// is turned into a keyed fingerprint inside the guest and is never sent, stored or logged.
/// </summary>
public interface IHostPlayerAddresses
{
    string? Address(int id);
}

public interface IHostPermissions
{
    /// <summary>Does a player hold a host privilege (operators, ACE, privs)? The console (0) always does.</summary>
    bool Has(int playerId, string privilege);
}

public interface IHostConfig
{
    /// <summary>A per-resource value (<paramref name="resource"/> set) or a host convar (null).</summary>
    SgValue? Get(string? resource, string key);
}

public interface IHostUi
{
    /// <summary>Shows a notification: target is a player id or -1; payload has type/title/message/durationMs/resource.</summary>
    void Notify(int target, SgTable payload);
}

public enum LogLevel { Debug, Info, Warn, Error }

public interface IHostLog
{
    void Write(LogLevel level, string origin, string message);
}

public sealed record HttpRequestData(string Method, string Url, IReadOnlyDictionary<string, string> Headers, string? Body);

public sealed record HttpResponseData(int Status, IReadOnlyDictionary<string, string> Headers, string Body);

public interface IHostHttp
{
    /// <summary>Performs a request off the host thread. The kit delivers the answer on the next tick.</summary>
    Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation);
}

/// <summary>The bundle of services a host is built with.</summary>
public interface IHostServices
{
    IHostClock Clock { get; }
    IResourceFiles Files { get; }
    IHostLog Log { get; }
    IHostStorage? Storage { get; }
    IHostPlayers? Players { get; }
    IHostPermissions? Permissions { get; }
    IHostConfig? Config { get; }
    IHostUi? Ui { get; }
    IHostHttp? Http { get; }
}

/// <summary>A mutable <see cref="IHostServices"/> with working defaults for every required member.</summary>
public sealed class HostServices : IHostServices
{
    public IHostClock Clock { get; set; } = new SystemClock();
    public IResourceFiles Files { get; set; } = new FolderFiles();
    public IHostLog Log { get; set; } = new ConsoleLog();
    public IHostStorage? Storage { get; set; } = new MemoryStorage();
    public IHostPlayers? Players { get; set; }
    public IHostPermissions? Permissions { get; set; }
    public IHostConfig? Config { get; set; }
    public IHostUi? Ui { get; set; }
    public IHostHttp? Http { get; set; }
}

public sealed class SystemClock : IHostClock
{
    private readonly System.Diagnostics.Stopwatch _watch = System.Diagnostics.Stopwatch.StartNew();
    public double MonotonicMilliseconds() => _watch.Elapsed.TotalMilliseconds;
    public long? UnixSeconds() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
}

/// <summary>A clock the caller advances (tests, verify runs): simulated monotonic time, real wall clock.</summary>
public sealed class ManualClock : IHostClock
{
    public double Now { get; set; }
    public double MonotonicMilliseconds() => Now;
    public long? UnixSeconds() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
}

/// <summary>Resource folders on disk. Reads are confined to the resource root.</summary>
public sealed class FolderFiles : IResourceFiles
{
    public byte[]? Read(string root, string relativePath)
    {
        if (Manifest.ManifestParser.UnsafePathReason(relativePath) is not null) return null;
        var full = Path.GetFullPath(Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar)));
        var prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
        return File.Exists(full) ? File.ReadAllBytes(full) : null;
    }

    public IReadOnlyList<string> List(string root)
    {
        if (!Directory.Exists(root)) return [];
        var baseDir = Path.GetFullPath(root);
        return Directory.EnumerateFiles(baseDir, "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(baseDir, f).Replace(Path.DirectorySeparatorChar, '/'))
            .Where(f => !f.Split('/').Any(seg => seg.StartsWith('.') || seg == "node_modules"))
            .Order(StringComparer.Ordinal).ToList();
    }
}

public sealed class MemoryStorage : IHostStorage
{
    private readonly Dictionary<string, string> _data = new(StringComparer.Ordinal);
    public string? Load(string key) => _data.TryGetValue(key, out var v) ? v : null;
    public void Save(string key, string json) => _data[key] = json;
}

/// <summary>JSON files under a folder: &lt;dir&gt;/&lt;key&gt;.json.</summary>
public sealed class FolderStorage(string directory) : IHostStorage
{
    public string? Load(string key)
    {
        var p = Path.Combine(directory, key + ".json");
        return File.Exists(p) ? File.ReadAllText(p) : null;
    }

    public void Save(string key, string json)
    {
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, key + ".json"), json);
    }
}

public sealed class ConsoleLog : IHostLog
{
    public LogLevel Minimum { get; set; } = LogLevel.Info;

    public void Write(LogLevel level, string origin, string message)
    {
        if (level < Minimum) return;
        var line = $"[{level.ToString().ToLowerInvariant()}] {origin} {message}";
        if (level == LogLevel.Error) Console.Error.WriteLine(line); else Console.WriteLine(line);
    }
}

/// <summary>HTTP through <see cref="System.Net.Http.HttpClient"/> (redirects are not followed).</summary>
public sealed class ClientHttp : IHostHttp, IDisposable
{
    private readonly HttpClient _client = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(15) };

    public async Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation)
    {
        using var message = new HttpRequestMessage(new HttpMethod(request.Method), request.Url);
        string? contentType = null;
        foreach (var (k, v) in request.Headers)
        {
            if (k.Equals("content-type", StringComparison.OrdinalIgnoreCase)) { contentType = v; continue; }
            message.Headers.TryAddWithoutValidation(k, v);
        }
        if (request.Body is not null)
        {
            message.Content = new StringContent(request.Body);
            if (contentType is not null) message.Content.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse(contentType);
        }
        using var response = await _client.SendAsync(message, cancellation).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(cancellation).ConfigureAwait(false);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var h in response.Headers.Concat(response.Content.Headers)) headers[h.Key.ToLowerInvariant()] = string.Join(", ", h.Value);
        return new HttpResponseData((int)response.StatusCode, headers, body);
    }

    public void Dispose() => _client.Dispose();
}
