// A Lua guest: one KeraLua state (Lua 5.4) per resource side. The prelude (prelude.lua) builds the
// sandbox and the scheduler in Lua; this class only enters it and answers its bridge calls.
//
// Safety rules for the native boundary:
// - no managed exception ever crosses into Lua: the bridge function catches everything and answers
//   `false, reason` (Lua raises errors itself, in the prelude);
// - the memory cap is enforced by the allocator, which refuses growth only while Lua code runs
//   under a protected call made from here (never inside a bridge callback, where a refusal would
//   unwind through managed frames, and never at top level, where it would panic);
// - the instruction budget is a Lua count hook (in the prelude), so a runaway loop raises an
//   ordinary Lua error and nothing longjmps over managed code.
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using KeraLua;

namespace ScriptGo.Host;

internal sealed unsafe class LuaGuest(SideRuntime side) : Guest(side, "lua")
{
    private static readonly Lazy<byte[]> Prelude = new(() => Embedded("ScriptGo.Host.prelude.lua"));
    private static readonly Lazy<string> JsonSource = new(() => Encoding.UTF8.GetString(Embedded("ScriptGo.Host.json.lua")));
    private static readonly Lazy<string> CompatSource = new(() => Encoding.UTF8.GetString(Embedded("ScriptGo.Host.compat.lua")));
    // The portable core's perks module: the one implementation of ScriptGo.perks (ADR-0038).
    private static readonly Lazy<string> PerksSource = new(() => Encoding.UTF8.GetString(Embedded("ScriptGo.Host.perks.lua")));
    // The portable core's presence module: player match (docs/spec/player-match.md).
    private static readonly Lazy<string> PresenceSource = new(() => Encoding.UTF8.GetString(Embedded("ScriptGo.Host.presence.lua")));

    private Lua? _lua;
    private LuaAlloc? _alloc;
    private LuaFunction? _bridge;
    private LuaFunction? _fresh;
    private LuaFunction? _chunk;
    private int _entryRef;
    private readonly Stack<IntPtr> _running = new();
    private long _allocated;
    private long _limit;
    private bool _refuseOk;
    private bool _memoryHit;

    internal static byte[] Embedded(string name)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)
            ?? throw new InvalidOperationException("missing embedded resource " + name);
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    public override long MemoryBytes => _allocated;

    public override void Initialize()
    {
        _limit = Host.Options.Quotas.LuaMemoryBytes;
        _alloc = Allocate;
        _bridge = BridgeCall;
        _fresh = FreshCall;
        _chunk = ChunkCall;
        _lua = new Lua(_alloc, IntPtr.Zero);
        _lua.OpenLibs();
        _lua.NewTable();
        _lua.PushCFunction(_bridge);
        _lua.SetField(-2, "call");
        _lua.PushCFunction(_fresh);
        _lua.SetField(-2, "fresh");
        _lua.PushCFunction(_chunk);
        _lua.SetField(-2, "chunk");
        _lua.SetGlobal("__sg");

        var res = Side.Res;
        var q = Host.Options.Quotas;
        var ctx = new SgTable()
            .Add("resource", SgValue.Of(res.Name))
            .Add("version", SgValue.Of(res.Manifest.Version))
            .Add("side", SgValue.Of(Side.Name))
            .Add("environment", SgValue.Of(Host.Environment))
            .Add("runtimeVersion", SgValue.Of(ScriptGoHost.RuntimeVersion))
            .Add("adapterVersion", SgValue.Of(Host.Options.AdapterVersion))
            .Add("instructions", SgValue.Of(q.LuaInstructions))
            .Add("threads", SgValue.Of(q.Threads))
            .Add("now", SgValue.Of(Host.Now))
            .Add("localPlayer", SgValue.Of(Host.Options.LocalPlayerId))
            .Add("capabilities", SgValue.Of(SgTable.FromList(Host.CapabilitiesFor("lua").Select(SgValue.Of))))
            .Add("permissions", SgValue.Of(SgTable.FromList(res.Manifest.Permissions.Select(SgValue.Of))))
            .Add("natives", SgValue.Of(Host.NativeDescriptor()))
            .Add("modules", SgValue.Of(new SgTable().Add("compat", SgValue.Of(CompatSource.Value)).Add("json", SgValue.Of(JsonSource.Value)).Add("perks", SgValue.Of(PerksSource.Value)).Add("presence", SgValue.Of(PresenceSource.Value))));

        var l = _lua;
        if (l.LoadBuffer(Prelude.Value, "=scriptgo/prelude") != LuaStatus.OK)
            throw new InvalidOperationException("prelude: " + l.ToString(-1, false));
        LuaValues.Push(l, SgValue.Of(ctx));
        if (Protected(l, 1, 1) != LuaStatus.OK) throw new InvalidOperationException("prelude: " + l.ToString(-1, false));
        _entryRef = l.Ref(LuaRegistry.Index);
    }

    // Memory ------------------------------------------------------------------------------------

    private IntPtr Allocate(IntPtr ud, IntPtr ptr, UIntPtr osize, UIntPtr nsize)
    {
        var oldSize = ptr == IntPtr.Zero ? 0L : (long)(ulong)osize;
        var newSize = (long)(ulong)nsize;
        if (newSize == 0)
        {
            if (ptr != IntPtr.Zero) NativeMemory.Free((void*)ptr);
            _allocated -= oldSize;
            return IntPtr.Zero;
        }
        if (newSize > oldSize && _allocated + (newSize - oldSize) > _limit)
        {
            _memoryHit = true;
            if (_refuseOk) return IntPtr.Zero;
        }
        var p = NativeMemory.Realloc((void*)ptr, (nuint)newSize);
        if (p == null) return IntPtr.Zero;
        _allocated += newSize - oldSize;
        return (IntPtr)p;
    }

    protected override void CheckMemory()
    {
        if (_lua is null) return;
        if (_allocated > _limit)
        {
            _lua.GarbageCollector(LuaGC.Collect, 0);
        }
        if (_memoryHit || _allocated > _limit)
        {
            Side.Log(LogLevel.Error, $"quota_exceeded:memory ({_limit / (1024 * 1024)} MiB)");
            Host.RequestStop(Side.Res.Name, "quota_exceeded:memory");
        }
    }

    // Calls into the prelude ---------------------------------------------------------------------

    private LuaStatus Protected(Lua l, int nargs, int nresults)
    {
        var prev = _refuseOk;
        _refuseOk = true;
        try { return l.PCall(nargs, nresults, 0); }
        finally { _refuseOk = prev; }
    }

    /// <summary>The state to call into: the running coroutine during a re-entrant call, else the main state.</summary>
    private Lua Current() => _running.Count > 0 ? Lua.FromIntPtr(_running.Peek()) : _lua!;

    /// <summary>
    /// Calls entry.&lt;name&gt;(args...). Entries answer `true, values...` or `false, reason, detail`.
    /// Returns (ok, values) where a failed entry gives ok=false and values = [reason, detail].
    /// </summary>
    private (bool Ok, SgValue[] Values) Invoke(string name, Func<Lua, int> pushArgs)
    {
        if (_lua is null || Disposed) return (false, [SgValue.Of("resource_stopped")]);
        var l = Current();
        var top = l.GetTop();
        try
        {
            if (!l.CheckStack(8)) return (false, [SgValue.Of("lua_stack_exhausted")]);
            l.RawGetInteger(LuaRegistry.Index, _entryRef);
            l.GetField(-1, name);
            l.Remove(-2);
            int nargs;
            try { nargs = pushArgs(l); }
            catch (CodecException e) { return (false, [SgValue.Of("codec_error"), SgValue.Of(e.Message)]); }
            if (Protected(l, nargs, -1) != LuaStatus.OK)
            {
                var message = l.ToString(-1, false) ?? "error";
                Side.Log(LogLevel.Error, message);
                return (false, [SgValue.Of(message.Split('\n')[0])]);
            }
            var resultTop = l.GetTop();
            if (resultTop <= top) return (true, []);
            var ok = l.ToBoolean(top + 1);
            try { return (ok, LuaValues.ReadRange(l, top + 2, resultTop)); }
            catch (CodecException e) { return (false, [SgValue.Of("codec_error"), SgValue.Of(e.Message)]); }
        }
        finally { l.SetTop(top); }
    }

    private static int PushAll(Lua l, IReadOnlyList<SgValue> values, int already = 0)
    {
        if (!l.CheckStack(values.Count + 4)) throw new CodecException("codec: too many values");
        foreach (var v in values) LuaValues.Push(l, v);
        return already + values.Count;
    }

    private static void PushContext(Lua l, CallContext ctx)
    {
        if (ctx.Source is { } s) l.PushInteger(s); else l.PushNil();
        if (ctx.Invoking is { } i) l.PushString(i); else l.PushNil();
    }

    public override void RunScript(string path, byte[] source)
    {
        var chunk = "@" + Side.Res.Name + "/" + path;
        var (ok, values) = Enter(_ => Invoke("load", l =>
        {
            l.PushBuffer(source);
            l.PushString(chunk);
            return 2;
        }));
        if (ok) return;
        var first = values.Length > 0 ? values[0].ToString() : "error";
        if (values.Length > 1) Side.Log(LogLevel.Error, values[1].ToString());
        throw new GuestScriptException(first);
    }

    /// <summary>Runs a script the file provider compiles itself (an escrowed resource): the prelude
    /// asks <c>__sg.chunk</c> for the function, so the source never passes through managed memory.</summary>
    public override bool TryRunNativeScript(string path)
    {
        var chunk = "@" + Side.Res.Name + "/" + path;
        var (ok, values) = Enter(_ => Invoke("loadNative", l =>
        {
            l.PushString(path);
            l.PushString(chunk);
            return 2;
        }));
        if (ok) return true;
        var first = values.Length > 0 ? values[0].ToString() : "error";
        if (first == "native_chunk_unavailable") return false;
        if (values.Length > 1) Side.Log(LogLevel.Error, values[1].ToString());
        throw new GuestScriptException(first);
    }

    public override bool PublishGlobal(string name)
    {
        if (!Alive) return false;
        var (ok, values) = Enter(_ => Invoke("publish", l => { l.PushString(name); return 1; }));
        return ok && values.Length > 0 && values[0].Kind == SgKind.Boolean && values[0].AsBoolean();
    }

    protected override void RunTick(double now, long tickCount) =>
        Enter(_ => Invoke("tick", l => { l.PushNumber(now); l.PushInteger(tickCount); return 2; }));

    protected override void ApplySettlement(int promiseId, bool ok, SgValue[] values, string? reason) =>
        Enter(_ => Invoke("settle", l =>
        {
            l.PushInteger(promiseId);
            l.PushBoolean(ok);
            if (!ok)
            {
                l.PushString(reason ?? "promise_rejected");
                return 3;
            }
            return PushAll(l, values, 2);
        }));

    public override void RunHandler(int handlerId, CallContext context, SgValue[] args)
    {
        if (!Alive) return;
        Enter(_ => Invoke("handler", l =>
        {
            l.PushInteger(handlerId);
            PushContext(l, context);
            return PushAll(l, args, 3);
        }));
    }

    public override SgValue[] CallExportSync(string name, string invoking, SgValue[] args)
    {
        if (!Alive) throw new ExportFailure("export_resource_unavailable");
        var (ok, values) = Enter(_ => Invoke("exportSync", l =>
        {
            l.PushString(name);
            l.PushString(invoking);
            return PushAll(l, args, 2);
        }));
        if (ok) return values;
        var reason = values.Length > 0 ? values[0].ToString() : "export_failed";
        if (reason == "codec_error") reason = values.Length > 1 && values[1].ToString().Contains("argument", StringComparison.Ordinal)
            ? "export_arguments_not_serializable" : "export_result_not_serializable";
        throw new ExportFailure(reason);
    }

    public override void CallExportAsync(int callId, string name, string invoking, SgValue[] args)
    {
        if (!Alive) return;
        Enter(_ => Invoke("exportAsync", l =>
        {
            l.PushInteger(callId);
            l.PushString(name);
            l.PushString(invoking);
            return PushAll(l, args, 3);
        }));
    }

    public override void RunCommand(string name, int source, SgValue[] args, string raw)
    {
        if (!Alive) return;
        Enter(_ => Invoke("command", l =>
        {
            l.PushString(name);
            l.PushInteger(source);
            l.PushString(raw);
            return PushAll(l, args, 3);
        }));
    }

    // __sg.fresh() → true once per host-level entry (the prelude then resets its instruction budget).
    private int FreshCall(IntPtr state)
    {
        Lua.FromIntPtr(state).PushBoolean(FreshBudget());
        return 1;
    }

    // __sg.chunk(library | nil, path, chunkname) answers function | false | nil, message.
    // Asks the file provider to compile a script of this resource (or of a declared dependency)
    // straight into this state. `false` means the provider does not serve that file natively and
    // the prelude falls back to reading its text. No managed exception crosses into Lua, and the
    // allocator does not refuse here (a refusal would surface as an ordinary load error anyway).
    private int ChunkCall(IntPtr state)
    {
        var prevRefuse = _refuseOk;
        _refuseOk = false;
        var l = Lua.FromIntPtr(state);
        var top = l.GetTop();
        try
        {
            var library = top >= 1 && l.Type(1) == LuaType.String ? l.ToString(1, false) : null;
            var path = top >= 2 && l.Type(2) == LuaType.String ? l.ToString(2, false) : null;
            var chunkName = top >= 3 && l.Type(3) == LuaType.String ? l.ToString(3, false) : null;
            if (path is null || chunkName is null || Manifest.ManifestParser.UnsafePathReason(path) is not null
                || Host.Services.Files is not INativeLuaChunks provider
                || Host.ChunkRoot(this, library) is not { } root
                || !provider.HasNativeChunk(root, path))
            {
                l.PushBoolean(false);
                return 1;
            }
            switch (provider.LoadChunk(root, path, state, chunkName))
            {
                case NativeChunkStatus.Loaded:
                    return 1; // the compiled function is on top of the stack
                case NativeChunkStatus.LuaError:
                    l.PushNil(); // Lua's message is on top: answer nil, message
                    l.Insert(-2);
                    return 2;
                default:
                    l.PushBoolean(false);
                    return 1;
            }
        }
        catch (Exception e)
        {
            l.SetTop(top);
            l.PushNil();
            l.PushString("native_chunk_failed: " + e.Message);
            return 2;
        }
        finally { _refuseOk = prevRefuse; }
    }

    // The bridge function the prelude calls: __sg.call(op, ...) → true, values... | false, reason, detail.
    private int BridgeCall(IntPtr state)
    {
        var prevRefuse = _refuseOk;
        _refuseOk = false;
        _running.Push(state);
        var l = Lua.FromIntPtr(state);
        var n = l.GetTop();
        try
        {
            if (n < 1 || l.Type(1) != LuaType.String) return Answer(l, n, BridgeResult.Fail("invalid_op"));
            var op = l.ToString(1, false);
            SgValue[] args;
            try { args = LuaValues.ReadRange(l, 2, n); }
            catch (CodecException e) { return Answer(l, n, BridgeResult.Fail(ScriptGoHost.CodecFailure(op), e.Message)); }
            return Answer(l, n, Host.Call(this, op, args));
        }
        catch (Exception e)
        {
            return Answer(l, n, BridgeResult.Fail("host_error", e.Message));
        }
        finally
        {
            _running.Pop();
            _refuseOk = prevRefuse;
        }
    }

    private static int Answer(Lua l, int top, BridgeResult r)
    {
        l.SetTop(top);
        if (r.Ok)
        {
            if (!l.CheckStack(r.Values.Length + 2))
            {
                l.PushBoolean(false);
                l.PushString("too_many_values");
                return 2;
            }
            l.PushBoolean(true);
            try { foreach (var v in r.Values) LuaValues.Push(l, v); }
            catch (CodecException e)
            {
                l.SetTop(top);
                l.PushBoolean(false);
                l.PushString("codec_error");
                l.PushString(e.Message);
                return 3;
            }
            return 1 + r.Values.Length;
        }
        l.PushBoolean(false);
        l.PushString(r.Reason ?? "error");
        if (r.Detail is null) return 2;
        l.PushString(r.Detail);
        return 3;
    }

    protected override void Release()
    {
        _lua?.Close();
        _lua = null;
    }
}
