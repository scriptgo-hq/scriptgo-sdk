// What a game plugin implements: the engine's side of SCRIPT//GO. The names follow the planned
// ScriptGo.Host kit (docs/plan/MULTI-LANGUAGE-SANDBOX.md, "host interface") so that a plugin's
// service classes move to the kit with little more than a namespace change. Differences, kept on
// purpose until the kit is merged: config values and notification payloads cross as JSON text and a
// small class instead of the kit's SgValue/SgTable, and IResourceFiles adds Directories() for discovery.
//
// Every member except Clock, Files and Log is optional: a missing service turns its capability off,
// and ScriptGo.<capability> then raises capability_unavailable:<capability>@<environment>.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace ScriptGo.Bridge
{
    /// <summary>Time. Monotonic milliseconds drive the scheduler; Unix seconds are the wall clock.</summary>
    public interface IHostClock
    {
        double MonotonicMilliseconds();
        long? UnixSeconds();
    }

    /// <summary>Read access to resource folders. Paths are resource-relative with '/'.</summary>
    public interface IResourceFiles
    {
        byte[] Read(string root, string relativePath);
        /// <summary>Every file of the resource, relative with '/' (used to expand script globs).</summary>
        IReadOnlyList<string> List(string root);
        /// <summary>The immediate sub-folders of a search folder (resource discovery).</summary>
        IReadOnlyList<string> Directories(string root);
    }

    /// <summary>Per-resource persistent storage: one JSON document per key ("res" or "res.client").</summary>
    public interface IHostStorage
    {
        string Load(string key);
        void Save(string key, string json);
    }

    /// <summary>Players of the engine. Ids are integers >= 1; invalid ids answer null.</summary>
    public interface IHostPlayers
    {
        IReadOnlyList<int> List();
        string Name(int id);
        string Identifier(int id);
    }

    public interface IHostPermissions
    {
        /// <summary>Does a player hold a host privilege? The console (0) is answered by the core itself.</summary>
        bool Has(int playerId, string privilege);
    }

    public interface IHostConfig
    {
        /// <summary>A per-resource value (<paramref name="resource"/> set) or a convar (null), as JSON text; null when unset.</summary>
        string GetJson(string resource, string key);
    }

    public sealed class Notification
    {
        public string Type = "info";
        public string Title = "";
        public string Message = "";
        public int DurationMs;
        public string Resource = "";
    }

    public interface IHostUi
    {
        /// <summary>Shows a notification: target is a player id or -1 for everyone.</summary>
        void Notify(int target, Notification notification);
    }

    public enum LogLevel { Debug, Info, Warn, Error }

    public interface IHostLog
    {
        void Write(LogLevel level, string origin, string message);
    }

    public sealed class HttpRequestData
    {
        public HttpRequestData(string method, string url, IReadOnlyDictionary<string, string> headers, string body)
        {
            Method = method;
            Url = url;
            Headers = headers ?? new Dictionary<string, string>();
            Body = body;
        }

        public string Method { get; }
        public string Url { get; }
        public IReadOnlyDictionary<string, string> Headers { get; }
        public string Body { get; }
    }

    public sealed class HttpResponseData
    {
        public HttpResponseData(int status, IReadOnlyDictionary<string, string> headers, string body)
        {
            Status = status;
            Headers = headers ?? new Dictionary<string, string>();
            Body = body ?? "";
        }

        /// <summary>The HTTP status; 0 when the request never got an answer.</summary>
        public int Status { get; }
        public IReadOnlyDictionary<string, string> Headers { get; }
        public string Body { get; }
    }

    public interface IHostHttp
    {
        /// <summary>Performs a request off the Lua thread. The bridge delivers the answer on a later tick.</summary>
        Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation);
    }

    /// <summary>The bundle of services a runtime is built with.</summary>
    public interface IHostServices
    {
        IHostClock Clock { get; }
        IResourceFiles Files { get; }
        IHostLog Log { get; }
        IHostStorage Storage { get; }
        IHostPlayers Players { get; }
        IHostPermissions Permissions { get; }
        IHostConfig Config { get; }
        IHostUi Ui { get; }
        IHostHttp Http { get; }
    }

    /// <summary>A mutable <see cref="IHostServices"/> with working defaults for the required members.</summary>
    public sealed class HostServices : IHostServices
    {
        public IHostClock Clock { get; set; } = new SystemClock();
        public IResourceFiles Files { get; set; } = new FolderFiles();
        public IHostLog Log { get; set; } = new ConsoleLog();
        public IHostStorage Storage { get; set; }
        public IHostPlayers Players { get; set; }
        public IHostPermissions Permissions { get; set; }
        public IHostConfig Config { get; set; }
        public IHostUi Ui { get; set; }
        public IHostHttp Http { get; set; }
    }

    public sealed class SystemClock : IHostClock
    {
        private readonly Stopwatch _watch = Stopwatch.StartNew();
        public double MonotonicMilliseconds() => _watch.Elapsed.TotalMilliseconds;
        public long? UnixSeconds() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    }

    /// <summary>A clock the caller advances (tests): simulated monotonic time, real wall clock.</summary>
    public sealed class ManualClock : IHostClock
    {
        public double Now { get; set; }
        public double MonotonicMilliseconds() => Now;
        public long? UnixSeconds() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    }

    /// <summary>Resource folders on disk. Reads are confined to the resource root.</summary>
    public sealed class FolderFiles : IResourceFiles
    {
        internal static bool UnsafeRelative(string relativePath)
        {
            if (string.IsNullOrEmpty(relativePath)) return true;
            var p = relativePath.Replace('\\', '/');
            if (p.StartsWith("/", StringComparison.Ordinal) || p.Contains(":")) return true;
            return p.Split('/').Any(seg => seg == "..");
        }

        public byte[] Read(string root, string relativePath)
        {
            if (UnsafeRelative(relativePath)) return null;
            var baseDir = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var full = Path.GetFullPath(Path.Combine(baseDir, relativePath.Replace('/', Path.DirectorySeparatorChar)));
            if (!full.StartsWith(baseDir, StringComparison.OrdinalIgnoreCase)) return null;
            return File.Exists(full) ? File.ReadAllBytes(full) : null;
        }

        public IReadOnlyList<string> List(string root)
        {
            if (!Directory.Exists(root)) return new string[0];
            var baseDir = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return Directory.EnumerateFiles(baseDir, "*", SearchOption.AllDirectories)
                .Select(f => f.Substring(baseDir.Length + 1).Replace(Path.DirectorySeparatorChar, '/'))
                .Where(f => !f.Split('/').Any(seg => seg.StartsWith(".", StringComparison.Ordinal) || seg == "node_modules"))
                .OrderBy(f => f, StringComparer.Ordinal).ToList();
        }

        public IReadOnlyList<string> Directories(string root)
        {
            if (!Directory.Exists(root)) return new string[0];
            return Directory.EnumerateDirectories(root)
                .Select(Path.GetFileName)
                .Where(n => !n.StartsWith(".", StringComparison.Ordinal))
                .OrderBy(n => n, StringComparer.Ordinal).ToList();
        }
    }

    public sealed class MemoryStorage : IHostStorage
    {
        private readonly Dictionary<string, string> _data = new Dictionary<string, string>(StringComparer.Ordinal);
        public string Load(string key) => _data.TryGetValue(key, out var v) ? v : null;
        public void Save(string key, string json) => _data[key] = json;
    }

    /// <summary>JSON files under a folder: &lt;dir&gt;/&lt;key&gt;.json.</summary>
    public sealed class FolderStorage : IHostStorage
    {
        private readonly string _directory;
        public FolderStorage(string directory) { _directory = directory; }

        public string Load(string key)
        {
            var p = Path.Combine(_directory, key + ".json");
            return File.Exists(p) ? File.ReadAllText(p) : null;
        }

        public void Save(string key, string json)
        {
            Directory.CreateDirectory(_directory);
            File.WriteAllText(Path.Combine(_directory, key + ".json"), json);
        }
    }

    public sealed class ConsoleLog : IHostLog
    {
        public LogLevel Minimum { get; set; } = LogLevel.Info;

        public void Write(LogLevel level, string origin, string message)
        {
            if (level < Minimum) return;
            var line = "[" + level.ToString().ToLowerInvariant() + "] " + origin + " " + message;
            if (level == LogLevel.Error) Console.Error.WriteLine(line); else Console.WriteLine(line);
        }
    }

    /// <summary>HTTP through <see cref="HttpClient"/> (redirects are not followed). For hosts without their own HTTP API.</summary>
    public sealed class ClientHttp : IHostHttp, IDisposable
    {
        private readonly HttpClient _client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(15) };

        public async Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation)
        {
            using (var message = new HttpRequestMessage(new HttpMethod(request.Method), request.Url))
            {
                string contentType = null;
                foreach (var h in request.Headers)
                {
                    if (string.Equals(h.Key, "content-type", StringComparison.OrdinalIgnoreCase)) { contentType = h.Value; continue; }
                    message.Headers.TryAddWithoutValidation(h.Key, h.Value);
                }
                if (request.Body != null)
                {
                    message.Content = new StringContent(request.Body);
                    if (contentType != null) message.Content.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse(contentType);
                }
                using (var response = await _client.SendAsync(message, cancellation).ConfigureAwait(false))
                {
                    var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                    var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var h in response.Headers.Concat(response.Content.Headers)) headers[h.Key.ToLowerInvariant()] = string.Join(", ", h.Value);
                    return new HttpResponseData((int)response.StatusCode, headers, body);
                }
            }
        }

        public void Dispose() => _client.Dispose();
    }
}
