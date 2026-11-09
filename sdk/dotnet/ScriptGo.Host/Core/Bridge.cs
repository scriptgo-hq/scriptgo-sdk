// The bridge: every call a guest makes into the host goes through Call(guest, op, args), with its
// arguments already copied by the codec. Results are values or a failure token; the guest prelude
// turns a failure into its language's idiom (Lua: nil/false plus the token, or an error where the
// Lua core raises; JavaScript: a thrown ScriptGoError). Op names are internal, not API.
using System.Text;
using ScriptGo.Host.Manifest;

namespace ScriptGo.Host;

public sealed partial class ScriptGoHost
{
    /// <summary>The token a guest reports when an op's payload is refused by the codec.</summary>
    internal static string CodecFailure(string op) => op switch
    {
        "trigger" or "triggerServer" or "triggerClient" => "event_payload_not_serializable",
        "exportSync" or "exportAsync" => "export_arguments_not_serializable",
        "asyncDone" => "export_result_not_serializable",
        "native" => "native_arguments_not_serializable",
        "uiNotify" => "invalid_payload",
        _ => "codec_error",
    };

    private static string? Text(SgValue[] a, int i) => i < a.Length ? a[i].TextOrNull : null;

    private static long? Integer(SgValue[] a, int i) =>
        i < a.Length && a[i].IsNumber && Math.Floor(a[i].AsDouble()) == a[i].AsDouble() ? a[i].AsInteger() : null;

    private static bool Truthy(SgValue[] a, int i) => i < a.Length && !a[i].IsNil && !(a[i].Kind == SgKind.Boolean && !a[i].AsBoolean());

    private static SgValue[] Rest(SgValue[] a, int from) => from >= a.Length ? [] : a[from..];

    private BridgeResult NeedCapability(string cap) => BridgeResult.Fail(Unavailable(cap, Environment));

    internal BridgeResult Call(Guest g, string op, SgValue[] a)
    {
        var side = g.Side;
        var res = side.Res;
        if (!side.Alive || !g.Alive) return BridgeResult.Fail("resource_stopped");
        switch (op)
        {
            case "log":
            {
                var level = Text(a, 0) switch { "debug" => LogLevel.Debug, "warn" => LogLevel.Warn, "error" => LogLevel.Error, _ => LogLevel.Info };
                side.Log(level, Text(a, 1) ?? (a.Length > 1 ? a[1].ToString() : ""));
                return BridgeResult.Empty;
            }

            // Events -----------------------------------------------------------------------------
            case "addHandler":
            {
                var name = Text(a, 0);
                if (string.IsNullOrEmpty(name)) return BridgeResult.Fail("invalid_event_name");
                if (side.HandlerById.Count >= Options.Quotas.Handlers) return BridgeResult.Fail("quota_exceeded:handlers");
                var entry = new HandlerEntry(side.NextId(), name, g);
                if (!side.Handlers.TryGetValue(name, out var list)) side.Handlers[name] = list = [];
                list.Add(entry);
                side.HandlerById[entry.Id] = entry;
                if (Truthy(a, 1)) side.NetEvents.Add(name);
                return BridgeResult.Of(SgValue.Of(entry.Id));
            }
            case "removeHandler":
            {
                var id = Integer(a, 0);
                if (id is null || !side.HandlerById.TryGetValue((int)id, out var h) || h.Guest != g) return BridgeResult.Of(SgValue.False);
                side.HandlerById.Remove(h.Id);
                if (side.Handlers.TryGetValue(h.Name, out var list)) list.Remove(h);
                return BridgeResult.Of(SgValue.True);
            }
            case "registerNet":
            {
                var name = Text(a, 0);
                if (string.IsNullOrEmpty(name)) return BridgeResult.Fail("invalid_event_name");
                side.NetEvents.Add(name);
                return BridgeResult.Empty;
            }
            case "trigger":
            {
                // OPEN//77: on the client TriggerEvent stays in the resource and runs now; on the server it
                // is the host-wide bus, queued to the next tick and delivered without `source`.
                var name = Text(a, 0);
                if (string.IsNullOrEmpty(name) || name.Length > 128) return BridgeResult.Fail("invalid_event_name");
                var args = Rest(a, 1);
                if (side.Name == "server") return Result(Queue("bus", "server", name, args, default));
                Dispatch(side, name, args, default, false);
                return BridgeResult.Of(SgValue.True);
            }
            case "triggerServer":
            {
                if (side.Name != "client") return BridgeResult.Fail("client_only");
                if (!Options.ServerSide) return BridgeResult.Fail("network_unavailable");
                var name = Text(a, 0);
                if (string.IsNullOrEmpty(name) || name.Length > 128) return BridgeResult.Fail("invalid_event_name");
                return Result(Queue("net", "server", name, Rest(a, 1), new CallContext(Options.LocalPlayerId, null)));
            }
            case "triggerClient":
            {
                if (side.Name != "server") return BridgeResult.Fail("server_only");
                var name = Text(a, 0);
                if (string.IsNullOrEmpty(name) || name.Length > 128) return BridgeResult.Fail("invalid_event_name");
                var target = Integer(a, 1);
                if (target is null || (target < 1 && target != -1)) return BridgeResult.Fail("invalid_target");
                if (!Options.ClientSide) return BridgeResult.Fail("network_unavailable");
                // Single-process hosts have one local client; other targets are simply not connected.
                if (target == -1 || target == Options.LocalPlayerId) return Result(Queue("net", "client", name, Rest(a, 2), default));
                return BridgeResult.Of(SgValue.True);
            }

            // Exports ----------------------------------------------------------------------------
            case "exportRegister":
            {
                var name = Text(a, 0);
                if (string.IsNullOrEmpty(name) || name.Length > 64) return BridgeResult.Fail("invalid_export_name");
                if (!side.Exports.ContainsKey(name) && side.Exports.Count >= Options.Quotas.Exports) return BridgeResult.Fail("quota_exceeded:exports");
                side.Exports[name] = new ExportEntry(name, g);
                return BridgeResult.Of(SgValue.True);
            }
            case "exportSync":
            {
                var target = Text(a, 0);
                var name = Text(a, 1);
                if (target is null || name is null) return BridgeResult.Fail("invalid_export_name");
                if (!_resources.TryGetValue(target, out var tr) || tr.State != "started" || !tr.Sides.TryGetValue(side.Name, out var ts))
                    return BridgeResult.Fail("export_resource_unavailable");
                if (!ts.Exports.TryGetValue(name, out var ex)) return BridgeResult.Fail("export_not_found");
                if (_syncDepth >= Options.Quotas.SyncExportDepth) return BridgeResult.Fail("export_recursion_limit");
                _syncDepth++;
                try { return BridgeResult.Of(ex.Guest.CallExportSync(name, res.Name, Rest(a, 2))); }
                catch (ExportFailure f) { return BridgeResult.Fail(f.Reason); }
                finally { _syncDepth--; }
            }
            case "exportAsync":
            {
                var promiseId = Integer(a, 0);
                var target = Text(a, 1);
                var name = Text(a, 2);
                if (promiseId is null || target is null || name is null) return BridgeResult.Fail("invalid_export_name");
                var pid = (int)promiseId;
                return Result(StartAsyncExport(res.Name, side.Name, target, name, Rest(a, 3), (ok, values, reason) => g.Settle(pid, ok, values, reason)));
            }
            case "asyncDone":
            {
                var callId = Integer(a, 0);
                if (callId is null || !_asyncCalls.Remove((int)callId, out var call)) return BridgeResult.Empty;
                if (Truthy(a, 1)) call.Complete(true, Rest(a, 2), null);
                else call.Complete(false, [], Text(a, 2) ?? "export_failed");
                return BridgeResult.Empty;
            }

            // Commands ---------------------------------------------------------------------------
            case "registerCommand":
            {
                if (!_capabilities.Contains("commands")) return NeedCapability("commands");
                var name = Text(a, 0)?.ToLowerInvariant();
                if (string.IsNullOrEmpty(name)) return BridgeResult.Fail("invalid_command_name");
                if (!_commands.TryGetValue(name, out var list)) _commands[name] = list = [];
                if (list.Any(c => c.Side.Name == side.Name)) return BridgeResult.Fail($"duplicate command '{name}'");
                list.Add(new CommandEntry(name, side, g, Truthy(a, 1)));
                return BridgeResult.Of(SgValue.True);
            }

            // Resource ---------------------------------------------------------------------------
            case "resourceState":
                return BridgeResult.Of(SgValue.Of(ResourceState(Text(a, 0) ?? res.Name)));
            case "resourceGeneration":
            {
                var name = Text(a, 0) ?? res.Name;
                return BridgeResult.Of(_resources.TryGetValue(name, out var r) ? SgValue.Of(r.Generation) : SgValue.Nil);
            }
            case "resourceFile":
            {
                var rel = Text(a, 0);
                if (rel is null || ManifestParser.UnsafePathReason(rel) is not null) return BridgeResult.Fail("invalid_path");
                var bytes = Services.Files.Read(res.Root, rel);
                return bytes is null ? BridgeResult.Fail("not_found") : BridgeResult.Of(SgValue.OfBytes(bytes));
            }
            case "dependencyFile":
            {
                var lib = Text(a, 0);
                var rel = Text(a, 1);
                if (lib is null || rel is null || ManifestParser.UnsafePathReason(rel) is not null) return BridgeResult.Fail("invalid_path");
                if (!res.Manifest.Dependencies.Any(d => d.Name == lib) || !_resources.TryGetValue(lib, out var dr))
                    return BridgeResult.Fail("dependency_not_declared:" + lib);
                var bytes = Services.Files.Read(dr.Root, rel);
                return bytes is null ? BridgeResult.Fail("not_found") : BridgeResult.Of(SgValue.OfBytes(bytes));
            }
            case "manifest":
                return BridgeResult.Of(SgValue.Of(ManifestTable(res.Manifest)));
            case "convar":
            {
                var key = Text(a, 0);
                return BridgeResult.Of(key is null ? SgValue.Nil : Services.Config?.Get(null, key) ?? SgValue.Nil);
            }
            case "configGet":
            {
                if (!_capabilities.Contains("config")) return NeedCapability("config");
                var key = Text(a, 0);
                return BridgeResult.Of(key is null ? SgValue.Nil : Services.Config?.Get(res.Name, key) ?? SgValue.Nil);
            }

            // Storage ----------------------------------------------------------------------------
            case "storageGet":
            {
                if (!_capabilities.Contains("storage")) return NeedCapability("storage");
                var data = StorageData(side);
                return BridgeResult.Of(data.TryGetValue(KeyText(a, 0), out var v) ? v : SgValue.Nil);
            }
            case "storageSet":
            {
                if (!_capabilities.Contains("storage")) return NeedCapability("storage");
                var data = StorageData(side);
                var key = KeyText(a, 0);
                var value = a.Length > 1 ? a[1] : SgValue.Nil;
                if (value.IsNil) data.Remove(key); else data[key] = value;
                StorageSave(side);
                return BridgeResult.Of(SgValue.True);
            }
            case "storageDelete":
            {
                if (!_capabilities.Contains("storage")) return NeedCapability("storage");
                StorageData(side).Remove(KeyText(a, 0));
                StorageSave(side);
                return BridgeResult.Of(SgValue.True);
            }
            case "storageKeys":
            {
                if (!_capabilities.Contains("storage")) return NeedCapability("storage");
                var prefix = Text(a, 0);
                var keys = StorageData(side).Keys.Where(k => prefix is null || k.StartsWith(prefix, StringComparison.Ordinal)).Order(StringComparer.Ordinal);
                return BridgeResult.Of(SgValue.Of(SgTable.FromList(keys.Select(SgValue.Of))));
            }

            // Players and permissions ------------------------------------------------------------
            case "playersList":
                if (!_capabilities.Contains("players")) return NeedCapability("players");
                return BridgeResult.Of(SgValue.Of(SgTable.FromList(PlayerList().Select(SgValue.Of))));
            case "playerName":
            {
                if (!_capabilities.Contains("players")) return NeedCapability("players");
                var id = Integer(a, 0);
                return BridgeResult.Of(id is null or < 1 ? SgValue.Nil : SgValue.Of(PlayerName((int)id)));
            }
            case "playerIdentifier":
            {
                if (!_capabilities.Contains("players")) return NeedCapability("players");
                var id = Integer(a, 0);
                return BridgeResult.Of(id is null or < 1 ? SgValue.Nil : SgValue.Of(PlayerIdentifier((int)id)));
            }
            case "permissionsHas":
            {
                if (!_capabilities.Contains("permissions")) return NeedCapability("permissions");
                var id = Integer(a, 0);
                var privilege = Text(a, 1) ?? "";
                if (id == 0) return BridgeResult.Of(SgValue.True);
                return BridgeResult.Of(SgValue.Of(id is not null && Services.Permissions?.Has((int)id, privilege) == true));
            }

            // UI ---------------------------------------------------------------------------------
            case "uiNotify":
            {
                if (!_capabilities.Contains("ui") || Services.Ui is null) return NeedCapability("ui");
                var target = side.Name == "client" ? Options.LocalPlayerId : (int)(Integer(a, 0) ?? -1);
                if (a.Length < 2 || a[1].Kind != SgKind.Table) return BridgeResult.Fail("invalid_payload");
                var payload = new SgTable();
                foreach (var e in a[1].AsTable().Entries) if (!(e.Key.TextOrNull == "resource")) payload.Add(e.Key, e.Value);
                payload.Add("resource", SgValue.Of(res.Name));
                Services.Ui.Notify(target, payload);
                return BridgeResult.Of(SgValue.True);
            }

            // HTTP and licensing -----------------------------------------------------------------
            case "http":
            {
                if (!_capabilities.Contains("http") || Services.Http is null) return NeedCapability("http");
                if (side.Name != "server") return BridgeResult.Fail("http is server-side only");
                var promiseId = Integer(a, 0);
                if (promiseId is null || a.Length < 2 || a[1].Kind != SgKind.Table) return BridgeResult.Fail("invalid_request");
                var request = HttpRequestFrom(a[1].AsTable(), out var why);
                if (request is null) return BridgeResult.Fail(why!);
                var pid = (int)promiseId;
                SendHttp(request, response => g.Settle(pid, true, [SgValue.Of(ResponseTable(response))], null), error => g.Settle(pid, false, [], error));
                return BridgeResult.Empty;
            }
            case "licensing":
            {
                if (!_capabilities.Contains("licensing") || Services.Http is null) return NeedCapability("licensing");
                if (side.Name != "server") return BridgeResult.Fail("licensing is server-side only");
                var promiseId = Integer(a, 0);
                var kind = Text(a, 1);
                if (promiseId is null || kind is not ("activate" or "verify") || a.Length < 3 || a[2].Kind != SgKind.Table) return BridgeResult.Fail("invalid_request");
                var pid = (int)promiseId;
                StartLicensing(kind, a[2].AsTable(), (values) => g.Settle(pid, true, values, null), error => g.Settle(pid, false, [], error));
                return BridgeResult.Empty;
            }

            // Native modules ---------------------------------------------------------------------
            case "native":
                return CallNative(g, Text(a, 0) ?? "", Text(a, 1) ?? "", Rest(a, 2));

            case "time":
                return BridgeResult.Of(Services.Clock.UnixSeconds() is { } t ? SgValue.Of(t) : SgValue.Nil);
        }
        return BridgeResult.Fail("unknown_op:" + op);
    }

    private static BridgeResult Result(Outcome o) => o.Ok ? BridgeResult.Of(SgValue.True) : BridgeResult.Fail(o.Reason!);

    private static string KeyText(SgValue[] a, int i) => i < a.Length && !a[i].IsNil ? a[i].ToString() : "nil";

    // Async exports ---------------------------------------------------------------------------------------

    /// <summary>Starts an export in its own thread; <paramref name="complete"/> gets values or a failure token.</summary>
    internal Outcome StartAsyncExport(string invoking, string sideName, string target, string name, SgValue[] args, Action<bool, SgValue[], string?> complete)
    {
        if (!_resources.TryGetValue(target, out var tr) || tr.State != "started") return Outcome.Failure("export_resource_unavailable");
        if (!tr.Sides.TryGetValue(sideName, out var ts) || !ts.Exports.TryGetValue(name, out var ex)) return Outcome.Failure("export_not_found");
        var id = ++_nextCallId;
        _asyncCalls[id] = new AsyncCall(id, ts, complete);
        ex.Guest.CallExportAsync(id, name, invoking, args);
        return Outcome.Success;
    }

    // Storage ------------------------------------------------------------------------------------------

    private static string StorageKey(SideRuntime side) => side.Name == "client" ? side.Res.Name + ".client" : side.Res.Name;

    private Dictionary<string, SgValue> StorageData(SideRuntime side)
    {
        var key = StorageKey(side);
        if (_storage.TryGetValue(key, out var cached)) return cached;
        var data = new Dictionary<string, SgValue>(StringComparer.Ordinal);
        var text = Services.Storage?.Load(key);
        if (!string.IsNullOrEmpty(text))
        {
            try
            {
                var decoded = SgJson.Decode(text);
                if (decoded.Kind != SgKind.Table) throw new CodecException("storage: not an object");
                foreach (var e in decoded.AsTable().Entries) data[e.Key.ToString()] = e.Value;
            }
            catch (CodecException)
            {
                data.Clear();
                Log(LogLevel.Warn, "host", $"storage for {key} is unreadable and was reset");
            }
        }
        _storage[key] = data;
        return data;
    }

    private void StorageSave(SideRuntime side)
    {
        var key = StorageKey(side);
        Services.Storage?.Save(key, SgJson.EncodeObject(_storage[key]));
    }

    // Manifest as a table (ScriptGo.resource.manifest) ---------------------------------------------------

    internal static SgTable ManifestTable(ResourceManifest m)
    {
        static SgValue List(IEnumerable<string> items) => SgValue.Of(SgTable.FromList(items.Select(SgValue.Of)));
        var t = new SgTable()
            .Add("format", SgValue.Of(m.Format)).Add("name", SgValue.Of(m.Name)).Add("version", SgValue.Of(m.Version))
            .Add("title", SgValue.Of(m.Title)).Add("description", SgValue.Of(m.Description)).Add("author", SgValue.Of(m.Author))
            .Add("license", SgValue.Of(m.License)).Add("repository", SgValue.Of(m.Repository)).Add("category", SgValue.Of(m.Category))
            .Add("scriptgoVersion", SgValue.Of(m.ScriptgoVersion)).Add("open77Version", SgValue.Of(m.Open77Version))
            .Add("autoStart", SgValue.Of(m.AutoStart)).Add("licensed", SgValue.Of(m.Licensed))
            .Add("lua", List(m.Lua)).Add("environments", List(m.Environments)).Add("capabilities", List(m.Capabilities))
            .Add("optionalCapabilities", List(m.OptionalCapabilities)).Add("sharedScripts", List(m.SharedScripts))
            .Add("serverScripts", List(m.ServerScripts)).Add("clientScripts", List(m.ClientScripts))
            .Add("testScripts", List(m.TestScripts)).Add("permissions", List(m.Permissions)).Add("files", List(m.Files))
            .Add("exports", List(m.Exports)).Add("serverExports", List(m.ServerExports))
            .Add("webUiPage", SgValue.Of(m.WebUiPage)).Add("webFiles", List(m.WebFiles));
        var env = new SgTable();
        foreach (var (k, v) in m.EnvironmentScripts) env.Add(k, List(v));
        t.Add("environmentScripts", SgValue.Of(env));
        t.Add("dependencies", SgValue.Of(SgTable.FromList(m.Dependencies.Select(d =>
            SgValue.Of(new SgTable().Add("name", SgValue.Of(d.Name)).Add("range", SgValue.Of(d.Range)))))));
        return t;
    }

    // HTTP ---------------------------------------------------------------------------------------------

    private static HttpRequestData? HttpRequestFrom(SgTable opts, out string? why)
    {
        why = null;
        var url = opts.Get("url").TextOrNull;
        if (url is null || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
        {
            why = "invalid_url";
            return null;
        }
        var method = (opts.Get("method").TextOrNull ?? "GET").ToUpperInvariant();
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (opts.Get("headers") is { Kind: SgKind.Table } h)
            foreach (var e in h.AsTable().Entries) headers[e.Key.ToString()] = e.Value.ToString();
        var body = opts.Get("body");
        return new HttpRequestData(method, url, headers, body.IsNil ? null : body.ToString());
    }

    private static SgTable ResponseTable(HttpResponseData r)
    {
        var headers = new SgTable();
        foreach (var (k, v) in r.Headers.OrderBy(h => h.Key, StringComparer.Ordinal)) headers.Add(k, SgValue.Of(v));
        return new SgTable().Add("status", SgValue.Of(r.Status)).Add("headers", SgValue.Of(headers)).Add("body", SgValue.Of(r.Body));
    }

    private void SendHttp(HttpRequestData request, Action<HttpResponseData> onResponse, Action<string> onError)
    {
        var http = Services.Http!;
        Interlocked.Increment(ref _pendingIo);
        Task.Run(async () =>
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                var response = await http.SendAsync(request, cts.Token).ConfigureAwait(false);
                _completions.Enqueue(() => onResponse(response));
            }
            catch (Exception e)
            {
                _completions.Enqueue(() => onError("http_failed: " + e.Message));
            }
            finally
            {
                Interlocked.Decrement(ref _pendingIo);
            }
        });
    }

    private string ApiBase() => Services.Config?.Get(null, "scriptgo_api")?.TextOrNull ?? Options.DefaultApi;

    /// <summary>POST {api}/v1/licenses/activate|verify. Settles with (decoded) or (nil, code, decoded), as the Lua core.</summary>
    private void StartLicensing(string kind, SgTable opts, Action<SgValue[]> done, Action<string> fail)
    {
        var body = new SgTable().Add("licenseKey", opts.Get("licenseKey")).Add("package", opts.Get("package"))
            .Add("environment", SgValue.Of(Environment)).Add("adapterVersion", SgValue.Of(Options.AdapterVersion));
        if (kind == "activate") body.Add("deploymentName", opts.Get("deploymentName"));
        else body.Add("deploymentToken", opts.Get("deploymentToken"));
        var request = new HttpRequestData("POST", ApiBase().TrimEnd('/') + "/v1/licenses/" + kind,
            new Dictionary<string, string> { ["content-type"] = "application/json" }, SgJson.EncodeObject(body.Entries.Select(e => new KeyValuePair<string, SgValue>(e.Key.ToString(), e.Value))));
        SendHttp(request, response =>
        {
            SgValue decoded;
            try { decoded = SgJson.Decode(response.Body); }
            catch (CodecException) { done([SgValue.Nil, SgValue.Of($"invalid_response ({response.Status})")]); return; }
            if (response.Status >= 400)
            {
                var code = decoded.Kind == SgKind.Table && decoded.AsTable().Get("error") is { Kind: SgKind.Table } err && err.AsTable().Get("code").TextOrNull is { } c
                    ? c : $"http_{response.Status}";
                done([SgValue.Nil, SgValue.Of(code), decoded]);
                return;
            }
            done([decoded]);
        }, fail);
    }

    // Natives ------------------------------------------------------------------------------------------

    private BridgeResult CallNative(Guest g, string moduleName, string functionName, SgValue[] args)
    {
        var res = g.Side.Res;
        if (!_natives.TryGetValue(moduleName, out var module) || module.Find(functionName) is not { } f)
            return BridgeResult.Fail($"native_not_found:{moduleName}.{functionName}");
        if (!f.AvailableOn(g.Side.Name)) return BridgeResult.Fail("native_unavailable_on_side:" + g.Side.Name);
        if (f.Permission is { } permission)
        {
            var declared = res.Manifest.Permissions.Contains(permission);
            var granted = declared && (Options.GrantPermission?.Invoke(res.Name, permission) ?? true);
            if (!granted) return BridgeResult.Fail("permission_denied:" + permission);
        }
        if (args.Length > f.Params.Count && args.Skip(f.Params.Count).Any(v => !v.IsNil))
            return BridgeResult.Fail("invalid_argument_count", $"{moduleName}.{functionName} takes {f.Params.Count} arguments");
        for (var i = 0; i < f.Params.Count; i++)
        {
            var p = f.Params[i];
            var v = i < args.Length ? args[i] : SgValue.Nil;
            if (!p.Type.Accepts(v)) return BridgeResult.Fail("invalid_argument:" + p.Name, $"expected {p.Type.Expression}, got {v.TypeName}");
        }
        try
        {
            return BridgeResult.Of(f.Handler!(new NativeCall(this, res.Name, g.Side.Name, g.Language, args)) ?? []);
        }
        catch (NativeException e) { return BridgeResult.Fail(e.Code, e.Message); }
        catch (CodecException e) { return BridgeResult.Fail("native_result_not_serializable", e.Message); }
        catch (Exception e)
        {
            Log(LogLevel.Error, g.Origin, $"native {moduleName}.{functionName} failed: {e.Message}");
            return BridgeResult.Fail("native_failed", e.Message);
        }
    }

    /// <summary>What a guest needs to build ScriptGo.natives: module → (global, function names).</summary>
    internal SgTable NativeDescriptor()
    {
        var t = new SgTable();
        foreach (var m in _natives.Values.OrderBy(m => m.Name, StringComparer.Ordinal))
        {
            var fns = SgTable.FromList(m.Functions.Select(f => SgValue.Of(f.Name)));
            t.Add(m.Name, SgValue.Of(new SgTable().Add("global", SgValue.Of(m.Global)).Add("functions", SgValue.Of(fns))));
        }
        return t;
    }

    internal static string Utf8(byte[] bytes) => Encoding.UTF8.GetString(bytes);
}
