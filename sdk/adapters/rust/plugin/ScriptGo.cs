// Reference: ScriptGo.Bridge
//
// SCRIPT//GO for Rust: an Oxide (uMod) / Carbon plugin that runs SCRIPT//GO Lua packages on the dedicated
// server through an embedded Lua 5.4 VM (KeraLua). The same file loads under Oxide and Carbon.
//
// Install (see sdk/adapters/rust/SETUP.md):
//   RustDedicated_Data/Managed/ScriptGo.Bridge.dll, KeraLua.dll   (the "// Reference:" above loads them)
//   RustDedicated_Data/Plugins/x86_64/lua54.dll (Windows) or liblua54.so (Linux)
//   oxide/plugins/ScriptGo.cs  or  carbon/plugins/ScriptGo.cs
//   packages in <data>/ScriptGo/resources/<name>/   (oxide/data or carbon/data)
//
// Host interface mapping: timers drive the scheduler, data files hold storage, BasePlayer is the player
// list, Oxide permissions answer privileges (scriptgo.<privilege>), the plugin config holds resource
// config and convars, web requests carry HTTP and licensing, chat shows notifications, and the console
// command `scriptgo` administers resources. Written for C# 7.3 so that both frameworks' compilers take it.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Oxide.Core;
using Oxide.Core.Libraries;
using SgRuntime = ScriptGo.Bridge.ScriptGoRuntime;
using SgOptions = ScriptGo.Bridge.RuntimeOptions;
using SgServices = ScriptGo.Bridge.HostServices;
using SgNotification = ScriptGo.Bridge.Notification;
using SgLogLevel = ScriptGo.Bridge.LogLevel;
using SgHttpRequest = ScriptGo.Bridge.HttpRequestData;
using SgHttpResponse = ScriptGo.Bridge.HttpResponseData;
using SgNativeLua = ScriptGo.Bridge.NativeLua;

namespace Oxide.Plugins
{
    [Info("ScriptGo", "SCRIPT//GO", "0.1.0")]
    [Description("Runs SCRIPT//GO Lua packages on the server through an embedded Lua 5.4 VM (KeraLua).")]
    public class ScriptGo : RustPlugin
    {
        private const string PermAdmin = "scriptgo.admin";
        private const string AdapterVersion = "rust-0.1.0";

        private PluginConfig _config;
        private SgRuntime _runtime;
        private Timer _tick;
        private DateTime _bootedAt;
        private readonly Dictionary<string, int> _ids = new Dictionary<string, int>();
        private readonly Dictionary<int, BasePlayer> _players = new Dictionary<int, BasePlayer>();
        private readonly HashSet<string> _registered = new HashSet<string>();
        private int _nextId = 1;

        // Configuration ----------------------------------------------------------------------------------
        private sealed class VerifyConfig
        {
            [JsonProperty("resource")] public string Resource;
            [JsonProperty("with")] public string With;
            [JsonProperty("reportPath")] public string ReportPath;
            [JsonProperty("runSeconds")] public float RunSeconds = 15f;
            [JsonProperty("quit")] public bool Quit = true;
        }

        private sealed class PluginConfig
        {
            [JsonProperty("tickIntervalSeconds")] public float TickIntervalSeconds = 0.02f;
            [JsonProperty("budgetMs")] public int BudgetMs = 250;
            [JsonProperty("httpTimeoutSeconds")] public float HttpTimeoutSeconds = 15f;
            [JsonProperty("httpAllowedHosts")] public List<string> HttpAllowedHosts = new List<string>();
            [JsonProperty("resourceFolders")] public List<string> ResourceFolders = new List<string>();
            [JsonProperty("start")] public List<string> Start;
            [JsonProperty("nativeLibraryFolder")] public string NativeLibraryFolder;
            [JsonProperty("debug")] public bool Debug;
            [JsonProperty("convars")] public Dictionary<string, JToken> Convars = new Dictionary<string, JToken>();
            [JsonProperty("resources")] public Dictionary<string, JObject> Resources = new Dictionary<string, JObject>();
            [JsonProperty("verify")] public VerifyConfig Verify;
        }

        protected override void LoadDefaultConfig()
        {
            _config = new PluginConfig();
        }

        protected override void LoadConfig()
        {
            base.LoadConfig();
            try
            {
                _config = Config.ReadObject<PluginConfig>();
                if (_config == null) throw new JsonException("empty configuration");
            }
            catch (Exception e)
            {
                PrintError("Configuration is invalid, using defaults (the file is left as it is): " + e.Message);
                _config = new PluginConfig();
                return;
            }
            SaveConfig();
        }

        protected override void SaveConfig()
        {
            Config.WriteObject(_config, true);
        }

        // Lifecycle -------------------------------------------------------------------------------------
        private void Init()
        {
            permission.RegisterPermission(PermAdmin, this);
        }

        private void OnServerInitialized()
        {
            if (_runtime != null) return;
            Boot();
        }

        private void Unload()
        {
            Shutdown();
        }

        private void OnServerShutdown()
        {
            Shutdown();
        }

        private void Boot()
        {
            _bootedAt = DateTime.UtcNow;
            var dataRoot = Path.Combine(Interface.Oxide.DataDirectory, "ScriptGo");
            var resources = Path.Combine(dataRoot, "resources");
            Directory.CreateDirectory(resources);

            var services = new SgServices
            {
                Log = new OxideLog(this),
                Storage = new DataFileStorage(),
                Players = new RustPlayers(this),
                Permissions = new OxidePermissions(this),
                Config = new PluginConfigValues(this),
                Ui = new ChatUi(this),
                Http = new OxideWebRequests(this),
            };
            var options = new SgOptions
            {
                AdapterVersion = AdapterVersion,
                BudgetMs = _config.BudgetMs > 0 ? (int?)_config.BudgetMs : null,
                HttpTimeout = TimeSpan.FromSeconds(Math.Max(1f, _config.HttpTimeoutSeconds)),
                Start = _config.Start,
                NativeSearchDirs = NativeFolders(),
            };
            options.SearchDirs.Add(resources);
            foreach (var extra in _config.ResourceFolders ?? new List<string>())
            {
                if (!string.IsNullOrEmpty(extra)) options.SearchDirs.Add(Path.IsPathRooted(extra) ? extra : Path.Combine(dataRoot, extra));
            }
            var verify = _config.Verify;
            if (verify != null && !string.IsNullOrEmpty(verify.Resource))
            {
                options.VerifyResource = verify.Resource;
                options.VerifyWith = verify.With;
            }

            try
            {
                _runtime = new SgRuntime(services, options);
                _runtime.Boot();
            }
            catch (Exception e)
            {
                PrintError("SCRIPT//GO did not start: " + e.Message);
                if (_runtime != null) _runtime.Dispose();
                _runtime = null;
                if (verify != null && !string.IsNullOrEmpty(verify.Resource)) FinishVerify(BootFailureReport(verify.Resource, e.Message));
                return;
            }

            Puts(string.Format("SCRIPT//GO {0} on {1} {2}: {3} from {4}", AdapterVersion, FrameworkName(), FrameworkVersion(),
                _runtime.LuaVersion, _runtime.NativeLibrary ?? "the runtime's default search"));
            foreach (var player in BasePlayer.activePlayerList.ToList())
            {
                if (player != null && player.IsConnected) _runtime.PlayerJoin(PlayerId(player), player.displayName);
            }
            SyncCommandPermissions();
            _tick = timer.Every(Math.Max(0.01f, _config.TickIntervalSeconds), OnTick);

            if (verify != null && !string.IsNullOrEmpty(verify.Resource))
            {
                Puts("verify mode: " + verify.Resource + " for " + verify.RunSeconds + " s");
                timer.Once(Math.Max(1f, verify.RunSeconds), () =>
                {
                    string json = _runtime == null ? null : _runtime.VerifyReport(RuntimeVersion(), Evidence()).Json;
                    FinishVerify(json ?? BootFailureReport(verify.Resource, "no verify report"));
                });
            }
        }

        private void Shutdown()
        {
            if (_tick != null) { _tick.Destroy(); _tick = null; }
            if (_runtime == null) return;
            try { _runtime.Dispose(); }
            catch (Exception e) { PrintError("stopping SCRIPT//GO: " + e.Message); }
            _runtime = null;
        }

        private void OnTick()
        {
            if (_runtime == null) return;
            try { _runtime.Tick(); }
            catch (Exception e) { PrintError("tick: " + e); }
        }

        // lua54 is resolved by full path before KeraLua's first call (see sdk/adapters/rust/README.md).
        private List<string> NativeFolders()
        {
            var root = Directory.GetCurrentDirectory();
            var folders = new List<string>();
            if (!string.IsNullOrEmpty(_config.NativeLibraryFolder)) folders.Add(_config.NativeLibraryFolder);
            folders.Add(Path.Combine(root, "RustDedicated_Data", "Plugins", "x86_64"));
            folders.Add(root);
            folders.Add(Path.Combine(root, "RustDedicated_Data", "Managed"));
            folders.Add(Path.Combine(root, "RustDedicated_Data", "Managed", "x64"));
            return folders;
        }

        // Verify mode -----------------------------------------------------------------------------------
        private void FinishVerify(string json)
        {
            var verify = _config.Verify;
            var path = string.IsNullOrEmpty(verify.ReportPath)
                ? Path.Combine(Interface.Oxide.DataDirectory, "ScriptGo", "verify-report.json")
                : verify.ReportPath;
            try
            {
                SgRuntime.WriteText(path, json);
                Puts("verify report written to " + path);
            }
            catch (Exception e)
            {
                PrintError("cannot write the verify report: " + e.Message);
            }
            if (verify.Quit) ConsoleSystem.Run(ConsoleSystem.Option.Server, "quit");
        }

        private string BootFailureReport(string resource, string message)
        {
            var report = new JObject
            {
                ["package"] = resource,
                ["version"] = "",
                ["environment"] = "rust",
                ["status"] = "failing",
                ["runtimeVersion"] = RuntimeVersion(),
                ["adapterVersion"] = AdapterVersion,
                ["luaVersion"] = "",
                ["durationMs"] = (long)(DateTime.UtcNow - _bootedAt).TotalMilliseconds,
                ["checks"] = new JArray(new JObject { ["name"] = "bridge_boot", ["status"] = "failed", ["message"] = message ?? "" }),
                ["log"] = message ?? "",
                ["evidence"] = JObject.Parse(Evidence()),
            };
            return report.ToString(Formatting.None);
        }

        private string RuntimeVersion()
        {
            return "Rust " + RustBuild() + " on " + FrameworkName() + " " + FrameworkVersion();
        }

        private string Evidence()
        {
            var e = new JObject
            {
                ["framework"] = FrameworkName(),
                ["frameworkVersion"] = FrameworkVersion(),
                ["rustProtocol"] = RustBuild(),
                ["monoRuntime"] = MonoVersion(),
                ["os"] = Environment.OSVersion.ToString(),
                ["nativeLibrary"] = _runtime == null ? null : _runtime.NativeLibrary,
                ["luaVersion"] = _runtime == null ? "" : _runtime.LuaVersion,
            };
            return e.ToString(Formatting.None);
        }

        private static string FrameworkName()
        {
            foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
            {
                var name = a.GetName().Name;
                if (name == "Carbon" || name == "Carbon.Common") return "carbon";
            }
            return "oxide";
        }

        private static string FrameworkVersion()
        {
            var asm = typeof(RustPlugin).Assembly;
            var info = asm.GetCustomAttributes(typeof(AssemblyInformationalVersionAttribute), false)
                .OfType<AssemblyInformationalVersionAttribute>().FirstOrDefault();
            return info != null && !string.IsNullOrEmpty(info.InformationalVersion) ? info.InformationalVersion : asm.GetName().Version.ToString();
        }

        // Read by reflection so a Rust update that moves the field degrades to "unknown" instead of breaking the build.
        private static string RustBuild()
        {
            try
            {
                var t = Type.GetType("Rust.Protocol, Assembly-CSharp");
                var f = t == null ? null : t.GetField("printable", BindingFlags.Public | BindingFlags.Static);
                var v = f == null ? null : f.GetValue(null) as string;
                if (!string.IsNullOrEmpty(v)) return v;
            }
            catch (Exception) { }
            return "unknown";
        }

        private static string MonoVersion()
        {
            try
            {
                var t = Type.GetType("Mono.Runtime");
                var m = t == null ? null : t.GetMethod("GetDisplayName", BindingFlags.NonPublic | BindingFlags.Static);
                var v = m == null ? null : m.Invoke(null, null) as string;
                if (!string.IsNullOrEmpty(v)) return v;
            }
            catch (Exception) { }
            return "not mono";
        }

        // Players -----------------------------------------------------------------------------------------
        // SCRIPT//GO player ids are small integers; a Steam id keeps its number for the plugin's lifetime.
        private int PlayerId(BasePlayer player)
        {
            int id;
            if (!_ids.TryGetValue(player.UserIDString, out id))
            {
                id = _nextId++;
                _ids[player.UserIDString] = id;
            }
            _players[id] = player;
            return id;
        }

        private BasePlayer PlayerById(int id)
        {
            BasePlayer player;
            return _players.TryGetValue(id, out player) && player != null && player.IsConnected ? player : null;
        }

        private void OnPlayerConnected(BasePlayer player)
        {
            if (_runtime == null || player == null) return;
            _runtime.PlayerJoin(PlayerId(player), player.displayName);
        }

        private void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            if (_runtime == null || player == null) return;
            int id;
            if (!_ids.TryGetValue(player.UserIDString, out id)) return;
            _runtime.PlayerDrop(id, reason);
            _players.Remove(id);
        }

        // Commands ------------------------------------------------------------------------------------------
        // A chat line "/name args" reaches a resource command of that name; restricted ones need
        // scriptgo.command.<name> (or scriptgo.admin).
        private object OnPlayerCommand(BasePlayer player, string command, string[] args)
        {
            if (_runtime == null || player == null || string.IsNullOrEmpty(command)) return null;
            if (string.Equals(command, "scriptgo", StringComparison.OrdinalIgnoreCase)) return null;
            if (!_runtime.HasCommand(command)) return null;
            var line = args == null || args.Length == 0 ? command : command + " " + string.Join(" ", args);
            var result = _runtime.ExecuteCommand(PlayerId(player), line);
            if (!result.Ok) player.ChatMessage("SCRIPT//GO: " + (result.Reason == "not_allowed" ? "you may not use /" + command : result.Reason));
            return true;
        }

        [ConsoleCommand("scriptgo")]
        private void ConsoleScriptGo(ConsoleSystem.Arg arg)
        {
            // The server console and RCON have no connection; a client's F1 console has one.
            var player = arg.Connection == null ? null : arg.Connection.player as BasePlayer;
            if (player != null && !permission.UserHasPermission(player.UserIDString, PermAdmin))
            {
                arg.ReplyWith("SCRIPT//GO: you need " + PermAdmin);
                return;
            }
            arg.ReplyWith(Admin(player == null ? 0 : PlayerId(player), Words(arg.FullString.ToString())));
        }

        [ChatCommand("scriptgo")]
        private void ChatScriptGo(BasePlayer player, string command, string[] args)
        {
            if (!permission.UserHasPermission(player.UserIDString, PermAdmin))
            {
                player.ChatMessage("SCRIPT//GO: you need " + PermAdmin);
                return;
            }
            player.ChatMessage(Admin(PlayerId(player), args ?? new string[0]));
        }

        private static string[] Words(string line)
        {
            return (line ?? "").Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
        }

        private string Admin(int source, string[] args)
        {
            if (_runtime == null) return "SCRIPT//GO is not running (see the server log).";
            var verb = args.Length > 0 ? args[0].ToLowerInvariant() : "status";
            switch (verb)
            {
                case "status":
                    return _runtime.Status();
                case "commands":
                    var list = _runtime.Commands();
                    return list.Count == 0 ? "No resource commands." : string.Join("\n", list.Select(c => c.Key + (c.Value ? "  (scriptgo.command." + c.Key + ")" : "")).ToArray());
                case "start":
                case "stop":
                case "restart":
                    if (args.Length < 2) return "usage: scriptgo " + verb + " <resource>";
                    var r = _runtime.Control(verb, args[1]);
                    SyncCommandPermissions();
                    return r.Reason;
                case "run":
                    if (args.Length < 2) return "usage: scriptgo run <command line>";
                    var result = _runtime.ExecuteCommand(source, string.Join(" ", args.Skip(1).ToArray()));
                    return result.Ok ? "ok" : result.Reason;
                default:
                    return "usage: scriptgo [status | commands | start <res> | stop <res> | restart <res> | run <command line>]";
            }
        }

        // Registers scriptgo.command.<name> for every restricted resource command so that `oxide.grant`
        // (or Carbon's `c.grant`) knows it.
        private void SyncCommandPermissions()
        {
            if (_runtime == null) return;
            foreach (var c in _runtime.Commands())
            {
                if (c.Value) EnsurePermission("command." + c.Key);
            }
        }

        private string EnsurePermission(string privilege)
        {
            var name = PermissionName(privilege);
            if (_registered.Add(name) && !permission.PermissionExists(name, this)) permission.RegisterPermission(name, this);
            return name;
        }

        private static string PermissionName(string privilege)
        {
            var sb = new StringBuilder("scriptgo.");
            foreach (var ch in (privilege ?? "").ToLowerInvariant())
            {
                sb.Append((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-' ? ch : '_');
            }
            return sb.ToString();
        }

        // Host services -----------------------------------------------------------------------------------
        private sealed class OxideLog : global::ScriptGo.Bridge.IHostLog
        {
            private readonly ScriptGo _p;
            public OxideLog(ScriptGo p) { _p = p; }

            public void Write(SgLogLevel level, string origin, string message)
            {
                var line = "[" + origin + "] " + message;
                switch (level)
                {
                    case SgLogLevel.Error: _p.PrintError("{0}", line); break;
                    case SgLogLevel.Warn: _p.PrintWarning("{0}", line); break;
                    case SgLogLevel.Debug: if (_p._config.Debug) _p.Puts("{0}", line); break;
                    default: _p.Puts("{0}", line); break;
                }
            }
        }

        private sealed class StoredDocument
        {
            [JsonProperty("json")] public string Json;
        }

        // One data file per storage key: <data>/ScriptGo/storage/<key>.json holding the document's JSON text.
        private sealed class DataFileStorage : global::ScriptGo.Bridge.IHostStorage
        {
            private static string FileName(string key)
            {
                var sb = new StringBuilder("ScriptGo/storage/");
                foreach (var ch in key ?? "")
                {
                    sb.Append(char.IsLetterOrDigit(ch) || ch == '_' || ch == '-' || ch == '.' ? ch : '_');
                }
                return sb.ToString();
            }

            public string Load(string key)
            {
                var name = FileName(key);
                if (!Interface.Oxide.DataFileSystem.ExistsDatafile(name)) return null;
                var doc = Interface.Oxide.DataFileSystem.ReadObject<StoredDocument>(name);
                return doc == null ? null : doc.Json;
            }

            public void Save(string key, string json)
            {
                Interface.Oxide.DataFileSystem.WriteObject(FileName(key), new StoredDocument { Json = json });
            }
        }

        private sealed class RustPlayers : global::ScriptGo.Bridge.IHostPlayers
        {
            private readonly ScriptGo _p;
            public RustPlayers(ScriptGo p) { _p = p; }

            public IReadOnlyList<int> List()
            {
                return _p._players.Where(kv => kv.Value != null && kv.Value.IsConnected).Select(kv => kv.Key).OrderBy(id => id).ToList();
            }

            public string Name(int id)
            {
                var player = _p.PlayerById(id);
                return player == null ? null : player.displayName;
            }

            public string Identifier(int id)
            {
                var player = _p.PlayerById(id);
                return player == null ? null : "steam:" + player.UserIDString;
            }
        }

        // privilege -> scriptgo.<privilege>, registered on first use; scriptgo.admin holds every privilege.
        private sealed class OxidePermissions : global::ScriptGo.Bridge.IHostPermissions
        {
            private readonly ScriptGo _p;
            public OxidePermissions(ScriptGo p) { _p = p; }

            public bool Has(int playerId, string privilege)
            {
                var player = _p.PlayerById(playerId);
                if (player == null) return false;
                var name = _p.EnsurePermission(privilege);
                return _p.permission.UserHasPermission(player.UserIDString, PermAdmin)
                    || _p.permission.UserHasPermission(player.UserIDString, name);
            }
        }

        // Per-resource values from "resources": { "<name>": { ... } }, convars from "convars": { ... }.
        // Rust's own server convars are deliberately not exposed (rcon.password lives there).
        private sealed class PluginConfigValues : global::ScriptGo.Bridge.IHostConfig
        {
            private readonly ScriptGo _p;
            public PluginConfigValues(ScriptGo p) { _p = p; }

            public string GetJson(string resource, string key)
            {
                JToken value = null;
                if (resource == null)
                {
                    if (_p._config.Convars != null) _p._config.Convars.TryGetValue(key, out value);
                }
                else
                {
                    JObject section;
                    if (_p._config.Resources != null && _p._config.Resources.TryGetValue(resource, out section) && section != null)
                        value = section[key];
                }
                return value == null || value.Type == JTokenType.Null ? null : value.ToString(Formatting.None);
            }
        }

        private sealed class ChatUi : global::ScriptGo.Bridge.IHostUi
        {
            private readonly ScriptGo _p;
            public ChatUi(ScriptGo p) { _p = p; }

            // A zero-width space after '<' keeps a resource's text from opening rich-text tags.
            private static string Plain(string s)
            {
                return (s ?? "").Replace("<", "<​");
            }

            public void Notify(int target, SgNotification n)
            {
                string color;
                switch (n.Type)
                {
                    case "success": color = "#8be28b"; break;
                    case "warning":
                    case "warn": color = "#ffd166"; break;
                    case "error": color = "#ff6b6b"; break;
                    default: color = "#9ad1ff"; break;
                }
                var text = "<color=" + color + ">[" + Plain(n.Title) + "]</color> " + Plain(n.Message);
                if (target == -1)
                {
                    foreach (var player in BasePlayer.activePlayerList.ToList())
                    {
                        if (player != null && player.IsConnected) player.ChatMessage(text);
                    }
                    return;
                }
                var one = _p.PlayerById(target);
                if (one != null) one.ChatMessage(text);
            }
        }

        // HTTP through Oxide/Carbon web requests. Their callback carries the status and body only, so
        // response headers are empty on this environment.
        private sealed class OxideWebRequests : global::ScriptGo.Bridge.IHostHttp
        {
            private readonly ScriptGo _p;
            public OxideWebRequests(ScriptGo p) { _p = p; }

            public Task<SgHttpResponse> SendAsync(SgHttpRequest request, System.Threading.CancellationToken cancellation)
            {
                RequestMethod method;
                if (!Enum.TryParse(request.Method, true, out method))
                    throw new NotSupportedException("method " + request.Method + " is not available through web requests");
                var allowed = _p._config.HttpAllowedHosts;
                if (allowed != null && allowed.Count > 0)
                {
                    var host = new Uri(request.Url).Host;
                    if (!allowed.Any(h => string.Equals(h, host, StringComparison.OrdinalIgnoreCase)))
                        throw new InvalidOperationException("host " + host + " is not in httpAllowedHosts");
                }
                var headers = new Dictionary<string, string>();
                foreach (var h in request.Headers) headers[h.Key] = h.Value;
                var done = new TaskCompletionSource<SgHttpResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
                cancellation.Register(() => done.TrySetCanceled());
                _p.webrequest.Enqueue(request.Url, request.Body, (code, body) =>
                {
                    done.TrySetResult(new SgHttpResponse(code, null, body));
                }, _p, method, headers, Math.Max(1f, _p._config.HttpTimeoutSeconds));
                return done.Task;
            }
        }
    }
}
