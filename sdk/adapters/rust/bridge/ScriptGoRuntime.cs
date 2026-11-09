// One KeraLua (Lua 5.4) state running the portable SCRIPT//GO core (sdk/lua/scriptgo, embedded in this
// assembly) and the Rust glue (sdk/adapters/rust/lua). The plugin owns the loop: it calls Tick() from
// a timer on the server's main thread, and every call into this class must come from that thread.
//
// Boundary rules, because Lua errors are longjmps and C# exceptions must never cross native frames:
// - every host function the Lua side calls catches its exceptions and answers nil, reason;
// - host functions never call back into Lua;
// - C# calls into Lua always go through lua_pcall with debug.traceback as the message handler.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using KeraLua;
using LuaState = KeraLua.Lua;

namespace ScriptGo.Bridge
{
    public sealed class RuntimeOptions
    {
        /// <summary>The adapter version reported to resources, the licensing API and verify reports.</summary>
        public string AdapterVersion = "rust-0.1.0";
        /// <summary>Folders that hold resource folders, searched in order.</summary>
        public List<string> SearchDirs = new List<string>();
        /// <summary>Resources to start; null starts every resource whose manifest has auto_start (the default).</summary>
        public List<string> Start;
        /// <summary>Wall-clock budget of one resume of a resource thread; a runaway loop raises instead of freezing the server.</summary>
        public int? BudgetMs = 250;
        /// <summary>Verify mode: start only this resource (and its dependencies).</summary>
        public string VerifyResource;
        /// <summary>Verify mode: then start this one (the package's README example).</summary>
        public string VerifyWith;
        public TimeSpan HttpTimeout = TimeSpan.FromSeconds(15);
        /// <summary>Folders searched for lua54.dll / liblua54.so before the VM starts; null leaves it to the runtime.</summary>
        public List<string> NativeSearchDirs;
    }

    public struct CommandResult
    {
        public bool Ok;
        public string Reason;
    }

    public struct VerifyResult
    {
        public string Json;
        public int Failed;
        public int Checks;
    }

    public sealed class BridgeException : Exception
    {
        public BridgeException(string message) : base(message) { }
    }

    public sealed class ScriptGoRuntime : IDisposable
    {
        public const string Version = "0.1.0";

        private readonly IHostServices _s;
        private readonly RuntimeOptions _o;
        private readonly List<string> _roots;
        private readonly List<LuaFunction> _keepAlive = new List<LuaFunction>();
        private readonly ConcurrentQueue<HttpCompletion> _completions = new ConcurrentQueue<HttpCompletion>();
        private readonly bool _ignoreCase = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
        private LuaState _lua;
        private int _rtRef = -1;
        private int _tracebackRef = -1;
        private int _pendingHttp;

        private sealed class HttpCompletion
        {
            public long Id;
            public HttpResponseData Response;
            public string Error;
        }

        public ScriptGoRuntime(IHostServices services, RuntimeOptions options)
        {
            _s = services ?? throw new ArgumentNullException(nameof(services));
            _o = options ?? new RuntimeOptions();
            if (_s.Clock == null || _s.Files == null || _s.Log == null) throw new ArgumentException("Clock, Files and Log are required services");
            _roots = _o.SearchDirs.Where(d => !string.IsNullOrEmpty(d)).Select(Normalize).ToList();
        }

        public bool Booted => _rtRef >= 0;
        /// <summary>The native library loaded by <see cref="RuntimeOptions.NativeSearchDirs"/>, if any.</summary>
        public string NativeLibrary { get; private set; }
        /// <summary>"Lua 5.4" once booted.</summary>
        public string LuaVersion { get; private set; } = "";
        /// <summary>HTTP requests not answered yet.</summary>
        public int PendingHttp => Volatile.Read(ref _pendingHttp);
        public string Environment => "rust";

        // Boot -------------------------------------------------------------------------------------------
        /// <summary>Creates the VM, loads the core and the glue, discovers and starts resources.</summary>
        public void Boot()
        {
            if (_lua != null) throw new InvalidOperationException("already booted");
            if (_o.NativeSearchDirs != null)
            {
                string err;
                NativeLibrary = NativeLua.Preload(_o.NativeSearchDirs, out err);
                if (NativeLibrary == null) throw new BridgeException("native Lua library: " + err);
            }
            try
            {
                _lua = new LuaState(true);
            }
            catch (DllNotFoundException e)
            {
                throw new BridgeException("native Lua library " + NativeLua.FileName + " not found: " + e.Message);
            }
            _lua.Encoding = Encoding.UTF8;

            // Keep debug.traceback for error messages before anything can touch it.
            _lua.GetGlobal("debug");
            _lua.GetField(-1, "traceback");
            _tracebackRef = _lua.Ref(LuaRegistry.Index);
            _lua.Pop(1);

            // The host table the glue calls (H).
            _lua.NewTable();
            Register("now", l => { l.PushNumber(_s.Clock.MonotonicMilliseconds() / 1000.0); return 1; });
            Register("log", HostLog);
            Register("readFile", ReadFile);
            Register("isFile", IsFile);
            Register("listFiles", ListFiles);
            Register("listDirs", ListDirs);
            Register("storageLoad", StorageLoad);
            Register("storageSave", StorageSave);
            Register("players", Players);
            Register("playerName", PlayerName);
            Register("playerIdentifier", PlayerIdentifier);
            Register("permission", Permission);
            Register("config", Config);
            Register("notify", Notify);
            Register("httpRequest", HttpRequest);
            int hostIndex = _lua.GetTop();

            // Narrow the VM's globals before any Lua runs. Resources never see _G (the core builds their
            // environments), but nothing in this process needs these: files go through IResourceFiles.
            // os.clock becomes the bridge's monotonic clock: on Linux, C's clock() counts the CPU time of
            // every thread of the game server, which would spend execution budgets on the game's work.
            _lua.PushCopy(hostIndex);
            _lua.SetGlobal("__sg_host");
            DoChunk("@scriptgo/rust-sandbox.lua", @"
                local H = __sg_host
                __sg_host = nil
                io, dofile, loadfile, require, package = nil, nil, nil, nil, nil
                for _, k in ipairs({ 'execute', 'exit', 'remove', 'rename', 'tmpname', 'getenv', 'setlocale' }) do os[k] = nil end
                os.clock = H.now
            ");

            // The core: every module chunk in a preload table, then init.lua(nil, nil, preload).
            _lua.NewTable();
            int preloadIndex = _lua.GetTop();
            foreach (var module in CoreModules())
            {
                if (module.Key == "init") continue;
                LoadChunk("@scriptgo/" + module.Key + ".lua", module.Value);
                _lua.SetField(preloadIndex, module.Key);
            }
            LoadChunk("@scriptgo/init.lua", Resource("scriptgo/init.lua"));
            _lua.PushNil();
            _lua.PushNil();
            _lua.PushCopy(preloadIndex);
            CallOrThrow(3, 1, "core");
            int coreIndex = _lua.GetTop();

            LoadChunk("@rust/adapter.lua", Resource("rust/adapter.lua"));
            CallOrThrow(0, 1, "adapter");
            int adapterIndex = _lua.GetTop();

            LoadChunk("@rust/runtime.lua", Resource("rust/runtime.lua"));
            _lua.PushCopy(coreIndex);
            _lua.PushCopy(adapterIndex);
            _lua.PushCopy(hostIndex);
            PushOptions();
            CallOrThrow(4, 1, "runtime");
            _rtRef = _lua.Ref(LuaRegistry.Index);
            _lua.SetTop(0);

            if (BeginRt("luaVersion"))
            {
                string err;
                if (EndRt(0, 1, out err)) { LuaVersion = Str(_lua, -1) ?? ""; _lua.Pop(1); }
            }
        }

        private void PushOptions()
        {
            _lua.NewTable();
            int t = _lua.GetTop();
            PushString(_lua, _o.AdapterVersion);
            _lua.SetField(t, "adapterVersion");
            if (_o.BudgetMs.HasValue && _o.BudgetMs.Value > 0)
            {
                _lua.PushInteger(_o.BudgetMs.Value);
                _lua.SetField(t, "budgetMs");
            }
            _lua.NewTable();
            SetFlag("storage", _s.Storage != null);
            SetFlag("players", _s.Players != null);
            SetFlag("permissions", _s.Permissions != null);
            SetFlag("config", _s.Config != null);
            SetFlag("ui", _s.Ui != null);
            SetFlag("http", _s.Http != null);
            _lua.SetField(t, "caps");
            PushList(_roots);
            _lua.SetField(t, "searchDirs");
            if (_o.Start != null)
            {
                PushList(_o.Start);
                _lua.SetField(t, "start");
            }
            if (!string.IsNullOrEmpty(_o.VerifyResource))
            {
                _lua.NewTable();
                PushString(_lua, _o.VerifyResource);
                _lua.SetField(-2, "resource");
                if (!string.IsNullOrEmpty(_o.VerifyWith))
                {
                    PushString(_lua, _o.VerifyWith);
                    _lua.SetField(-2, "with");
                }
                _lua.SetField(t, "verify");
            }
        }

        private void SetFlag(string name, bool value)
        {
            _lua.PushBoolean(value);
            _lua.SetField(-2, name);
        }

        private void PushList(IEnumerable<string> items)
        {
            _lua.NewTable();
            long i = 0;
            foreach (var item in items)
            {
                PushString(_lua, item);
                _lua.RawSetInteger(-2, ++i);
            }
        }

        // The loop ----------------------------------------------------------------------------------------
        /// <summary>Delivers finished HTTP requests, then runs one scheduler tick. Main thread only.</summary>
        public void Tick()
        {
            if (!Booted) return;
            HttpCompletion c;
            while (_completions.TryDequeue(out c))
            {
                Interlocked.Decrement(ref _pendingHttp);
                if (!BeginRt("httpDone")) continue;
                _lua.PushInteger(c.Id);
                int n = 4;
                if (c.Response != null)
                {
                    _lua.PushInteger(c.Response.Status);
                    PushString(_lua, c.Response.Body);
                    _lua.PushNil();
                    foreach (var h in c.Response.Headers)
                    {
                        PushString(_lua, h.Key);
                        PushString(_lua, h.Value);
                        n += 2;
                    }
                }
                else
                {
                    _lua.PushInteger(0);
                    PushString(_lua, "");
                    PushString(_lua, c.Error ?? "request_failed");
                }
                CallRtLogged("httpDone", n, 0);
            }
            if (BeginRt("tick")) CallRtLogged("tick", 0, 0);
        }

        public void PlayerJoin(int id, string name)
        {
            if (!BeginRt("join")) return;
            _lua.PushInteger(id);
            PushString(_lua, name ?? ("Player " + id));
            CallRtLogged("join", 2, 0);
        }

        public void PlayerDrop(int id, string reason)
        {
            if (!BeginRt("drop")) return;
            _lua.PushInteger(id);
            PushString(_lua, reason ?? "disconnected");
            CallRtLogged("drop", 2, 0);
        }

        public bool HasCommand(string name)
        {
            if (!BeginRt("hasCommand")) return false;
            PushString(_lua, name);
            string err;
            if (!EndRt(1, 1, out err)) return false;
            bool result = _lua.ToBoolean(-1);
            _lua.Pop(1);
            return result;
        }

        /// <summary>Runs a resource command as <paramref name="source"/> (0 = console). It runs on the next tick.</summary>
        public CommandResult ExecuteCommand(int source, string line)
        {
            if (!BeginRt("command")) return new CommandResult { Ok = false, Reason = "not_booted" };
            _lua.PushInteger(source);
            PushString(_lua, line ?? "");
            return TwoResults(2);
        }

        /// <summary>Every resource command: (name, restricted).</summary>
        public IReadOnlyList<KeyValuePair<string, bool>> Commands()
        {
            var list = new List<KeyValuePair<string, bool>>();
            if (!BeginRt("commands")) return list;
            string err;
            if (!EndRt(0, 1, out err)) return list;
            var text = Str(_lua, -1) ?? "";
            _lua.Pop(1);
            foreach (var line in text.Split('\n'))
            {
                if (line.Length == 0) continue;
                var parts = line.Split(' ');
                list.Add(new KeyValuePair<string, bool>(parts[0], parts.Length > 1 && parts[1] == "restricted"));
            }
            return list;
        }

        public string Status()
        {
            if (!BeginRt("status")) return "not booted";
            string err;
            if (!EndRt(0, 1, out err)) return err;
            var text = Str(_lua, -1);
            _lua.Pop(1);
            return text;
        }

        /// <summary>action: start, stop or restart.</summary>
        public CommandResult Control(string action, string resource)
        {
            if (!BeginRt("control")) return new CommandResult { Ok = false, Reason = "not_booted" };
            PushString(_lua, action);
            PushString(_lua, resource);
            return TwoResults(2);
        }

        /// <summary>The verify report (CompatibilityRun-shaped JSON) for <see cref="RuntimeOptions.VerifyResource"/>.</summary>
        public VerifyResult VerifyReport(string runtimeVersion, string evidenceJson)
        {
            var result = new VerifyResult { Json = null, Failed = -1, Checks = 0 };
            if (!BeginRt("verifyReport")) return result;
            PushString(_lua, runtimeVersion ?? "");
            PushString(_lua, evidenceJson ?? "");
            string err;
            if (!EndRt(2, 3, out err))
            {
                _s.Log.Write(LogLevel.Error, "scriptgo", "verify report: " + err);
                return result;
            }
            result.Json = Str(_lua, -3);
            result.Failed = (int)_lua.ToInteger(-2);
            result.Checks = (int)_lua.ToInteger(-1);
            _lua.Pop(3);
            return result;
        }

        /// <summary>Writes a text file (verify reports), creating its folder.</summary>
        public static void WriteText(string path, string text)
        {
            var dir = Path.GetDirectoryName(Path.GetFullPath(path));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(path, text, new UTF8Encoding(false));
        }

        public void StopAll()
        {
            if (BeginRt("stopAll")) CallRtLogged("stopAll", 0, 0);
        }

        public void Dispose()
        {
            if (_lua == null) return;
            try { if (Booted) StopAll(); } catch (Exception) { /* the VM is closed below either way */ }
            _rtRef = -1;
            _lua.Close();
            _lua = null;
        }

        // Host functions (H.*) -----------------------------------------------------------------------------
        private void Register(string name, Func<LuaState, int> body)
        {
            LuaFunction fn = L =>
            {
                var l = LuaState.FromIntPtr(L);
                try
                {
                    return body(l);
                }
                catch (Exception e)
                {
                    l.PushNil();
                    PushString(l, name + ": " + e.GetType().Name + ": " + e.Message);
                    return 2;
                }
            };
            _keepAlive.Add(fn);
            _lua.PushCFunction(fn);
            _lua.SetField(-2, name);
        }

        private int HostLog(LuaState l)
        {
            var level = Str(l, 1);
            var lv = level == "error" ? LogLevel.Error : level == "warn" ? LogLevel.Warn : level == "debug" ? LogLevel.Debug : LogLevel.Info;
            _s.Log.Write(lv, Str(l, 2) ?? "", Str(l, 3) ?? "");
            return 0;
        }

        private int ReadFile(LuaState l)
        {
            string root, rel;
            if (!TryResolve(Str(l, 1), out root, out rel) || rel.Length == 0) { l.PushNil(); return 1; }
            var bytes = _s.Files.Read(root, rel);
            if (bytes == null) { l.PushNil(); return 1; }
            l.PushBuffer(bytes);
            return 1;
        }

        private int IsFile(LuaState l)
        {
            string root, rel;
            l.PushBoolean(TryResolve(Str(l, 1), out root, out rel) && rel.Length > 0 && _s.Files.Read(root, rel) != null);
            return 1;
        }

        private int ListFiles(LuaState l)
        {
            string root, rel;
            if (!TryResolve(Str(l, 1), out root, out rel) || rel.Length != 0) return 0;
            var files = _s.Files.List(root);
            l.CheckStack(files.Count + 1);
            foreach (var f in files) PushString(l, f);
            return files.Count;
        }

        private int ListDirs(LuaState l)
        {
            var dir = Normalize(Str(l, 1) ?? "");
            if (!_roots.Any(r => SamePath(r, dir))) return 0;
            var dirs = _s.Files.Directories(dir);
            l.CheckStack(dirs.Count + 1);
            foreach (var d in dirs) PushString(l, d);
            return dirs.Count;
        }

        private int StorageLoad(LuaState l)
        {
            if (_s.Storage == null) { l.PushNil(); return 1; }
            PushString(l, _s.Storage.Load(Str(l, 1) ?? ""));
            return 1;
        }

        private int StorageSave(LuaState l)
        {
            if (_s.Storage == null) return 0;
            _s.Storage.Save(Str(l, 1) ?? "", Str(l, 2) ?? "{}");
            return 0;
        }

        private int Players(LuaState l)
        {
            if (_s.Players == null) return 0;
            var ids = _s.Players.List();
            l.CheckStack(ids.Count + 1);
            foreach (var id in ids) l.PushInteger(id);
            return ids.Count;
        }

        private int PlayerName(LuaState l)
        {
            PushString(l, _s.Players == null ? null : _s.Players.Name((int)l.ToInteger(1)));
            return 1;
        }

        private int PlayerIdentifier(LuaState l)
        {
            PushString(l, _s.Players == null ? null : _s.Players.Identifier((int)l.ToInteger(1)));
            return 1;
        }

        private int Permission(LuaState l)
        {
            l.PushBoolean(_s.Permissions != null && _s.Permissions.Has((int)l.ToInteger(1), Str(l, 2) ?? ""));
            return 1;
        }

        private int Config(LuaState l)
        {
            if (_s.Config == null) { l.PushNil(); return 1; }
            var resource = l.IsNoneOrNil(1) ? null : Str(l, 1);
            PushString(l, _s.Config.GetJson(resource, Str(l, 2) ?? ""));
            return 1;
        }

        private int Notify(LuaState l)
        {
            if (_s.Ui == null) return 0;
            _s.Ui.Notify((int)l.ToInteger(1), new Notification
            {
                Type = Str(l, 2) ?? "info",
                Title = Str(l, 3) ?? "",
                Message = Str(l, 4) ?? "",
                DurationMs = (int)l.ToInteger(5),
                Resource = Str(l, 6) ?? "",
            });
            return 0;
        }

        // H.httpRequest(id, method, url, body | nil, k1, v1, k2, v2, ...) -> true | false, reason
        private int HttpRequest(LuaState l)
        {
            if (_s.Http == null) { l.PushBoolean(false); PushString(l, "http unavailable"); return 2; }
            long id = l.ToInteger(1);
            var method = (Str(l, 2) ?? "GET").ToUpperInvariant();
            var url = Str(l, 3) ?? "";
            string body = l.IsNoneOrNil(4) ? null : Str(l, 4);
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            int top = l.GetTop();
            for (int i = 5; i + 1 <= top; i += 2) headers[Str(l, i) ?? ""] = Str(l, i + 1) ?? "";
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || (uri.Scheme != "http" && uri.Scheme != "https"))
            {
                l.PushBoolean(false);
                PushString(l, "invalid_url");
                return 2;
            }
            StartHttp(id, new HttpRequestData(method, url, headers, body));
            l.PushBoolean(true);
            return 1;
        }

        private void StartHttp(long id, HttpRequestData request)
        {
            Interlocked.Increment(ref _pendingHttp);
            Task<HttpResponseData> send;
            var cts = new CancellationTokenSource(_o.HttpTimeout);
            try
            {
                send = _s.Http.SendAsync(request, cts.Token) ?? Task.FromResult<HttpResponseData>(null);
            }
            catch (Exception e)
            {
                cts.Dispose();
                _completions.Enqueue(new HttpCompletion { Id = id, Error = "request_failed: " + e.Message });
                return;
            }
            var timeout = Task.Delay(_o.HttpTimeout);
            Task.WhenAny(send, timeout).ContinueWith(winner =>
            {
                var c = new HttpCompletion { Id = id };
                if (winner.Result != send) c.Error = "timeout";
                else if (send.IsFaulted) c.Error = "request_failed: " + send.Exception.GetBaseException().Message;
                else if (send.IsCanceled) c.Error = "timeout";
                else if (send.Result == null || send.Result.Status == 0) c.Error = "request_failed";
                else c.Response = send.Result;
                _completions.Enqueue(c);
                cts.Dispose();
            }, TaskScheduler.Default);
        }

        // Paths ---------------------------------------------------------------------------------------------
        private static string Normalize(string path)
        {
            if (string.IsNullOrEmpty(path)) return "";
            return Path.GetFullPath(path).Replace('\\', '/').TrimEnd('/');
        }

        private bool SamePath(string a, string b) =>
            string.Equals(a, b, _ignoreCase ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

        // path = <search dir>/<resource folder>[/<relative>] -> (resource root, relative); anything else is refused.
        private bool TryResolve(string path, out string root, out string rel)
        {
            root = null;
            rel = null;
            if (string.IsNullOrEmpty(path)) return false;
            var p = path.Replace('\\', '/');
            foreach (var dir in _roots)
            {
                var prefix = dir + "/";
                if (!p.StartsWith(prefix, _ignoreCase ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)) continue;
                var rest = p.Substring(prefix.Length);
                int slash = rest.IndexOf('/');
                var folder = slash < 0 ? rest : rest.Substring(0, slash);
                if (folder.Length == 0 || folder == "." || folder == "..") return false;
                rel = slash < 0 ? "" : rest.Substring(slash + 1);
                if (rel.Length > 0 && FolderFiles.UnsafeRelative(rel)) return false;
                root = dir + "/" + folder;
                return true;
            }
            return false;
        }

        // Lua plumbing --------------------------------------------------------------------------------------
        private static IEnumerable<KeyValuePair<string, byte[]>> CoreModules()
        {
            var asm = typeof(ScriptGoRuntime).GetTypeInfo().Assembly;
            foreach (var name in asm.GetManifestResourceNames().OrderBy(n => n, StringComparer.Ordinal))
            {
                if (!name.StartsWith("scriptgo/", StringComparison.Ordinal) || !name.EndsWith(".lua", StringComparison.Ordinal)) continue;
                yield return new KeyValuePair<string, byte[]>(name.Substring(9, name.Length - 13), Resource(name));
            }
        }

        private static byte[] Resource(string name)
        {
            var asm = typeof(ScriptGoRuntime).GetTypeInfo().Assembly;
            using (var stream = asm.GetManifestResourceStream(name))
            {
                if (stream == null) throw new BridgeException("embedded Lua file missing: " + name);
                using (var ms = new MemoryStream())
                {
                    stream.CopyTo(ms);
                    var bytes = ms.ToArray();
                    // Strip a UTF-8 byte order mark: Lua would read it as code.
                    if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) bytes = bytes.Skip(3).ToArray();
                    return bytes;
                }
            }
        }

        private void LoadChunk(string chunkName, byte[] code)
        {
            var status = _lua.LoadBuffer(code, chunkName, "t");
            if (status != LuaStatus.OK)
            {
                var msg = Str(_lua, -1);
                _lua.Pop(1);
                throw new BridgeException("cannot load " + chunkName + ": " + msg);
            }
        }

        private void DoChunk(string chunkName, string code)
        {
            LoadChunk(chunkName, Encoding.UTF8.GetBytes(code));
            CallOrThrow(0, 0, chunkName);
        }

        private void CallOrThrow(int nargs, int nresults, string what)
        {
            string err;
            if (!PCall(nargs, nresults, out err)) throw new BridgeException(what + ": " + err);
        }

        // Calls the function below its nargs arguments with debug.traceback as the message handler.
        private bool PCall(int nargs, int nresults, out string error)
        {
            error = null;
            int fnIndex = _lua.GetTop() - nargs;
            _lua.RawGetInteger(LuaRegistry.Index, _tracebackRef);
            _lua.Insert(fnIndex);
            var status = _lua.PCall(nargs, nresults, fnIndex);
            _lua.Remove(fnIndex);
            if (status == LuaStatus.OK) return true;
            error = Str(_lua, -1) ?? status.ToString();
            _lua.Pop(1);
            return false;
        }

        // Pushes rt[name]; false when the runtime is not booted.
        private bool BeginRt(string name)
        {
            if (_lua == null || _rtRef < 0) return false;
            _lua.RawGetInteger(LuaRegistry.Index, _rtRef);
            _lua.GetField(-1, name);
            _lua.Remove(-2);
            return true;
        }

        private bool EndRt(int nargs, int nresults, out string error) => PCall(nargs, nresults, out error);

        private void CallRtLogged(string name, int nargs, int nresults)
        {
            string err;
            if (!PCall(nargs, nresults, out err)) _s.Log.Write(LogLevel.Error, "scriptgo", name + ": " + err);
            else if (nresults > 0) _lua.Pop(nresults);
        }

        private CommandResult TwoResults(int nargs)
        {
            string err;
            if (!EndRt(nargs, 2, out err)) return new CommandResult { Ok = false, Reason = err };
            var result = new CommandResult { Ok = _lua.ToBoolean(-2), Reason = Str(_lua, -1) };
            _lua.Pop(2);
            return result;
        }

        // Strings cross as UTF-8 bytes (KeraLua's default encoding is ASCII, and thread wrappers copy it).
        private static string Str(LuaState l, int index)
        {
            var t = l.Type(index);
            if (t != LuaType.String && t != LuaType.Number) return null;
            var bytes = l.ToBuffer(index, false);
            return bytes == null ? null : Encoding.UTF8.GetString(bytes);
        }

        private static void PushString(LuaState l, string s)
        {
            if (s == null) l.PushNil();
            else l.PushBuffer(Encoding.UTF8.GetBytes(s));
        }
    }
}
