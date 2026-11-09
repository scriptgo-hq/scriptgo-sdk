// A JavaScript guest: one Jint engine per resource side. TypeScript reaches it compiled to
// JavaScript by `scriptgo pack` / `scriptgo verify` (esbuild, one IIFE bundle per entry).
//
// Quotas: an EntryBudget constraint counts statements, wall time and allocation per host-level
// entry (Jint resets its own constraints on every nested call, which a script could exploit
// through a synchronous export round trip, so the budget is reset only when Guest.FreshBudget says). Past the budget it
// throws a .NET exception that JavaScript try/catch cannot intercept; the whole entry is abandoned
// and the remaining promise jobs run on the next entry. eval and new Function are disabled; there
// is no CLR access.
using System.Diagnostics;
using System.Text;
using Jint;
using Jint.Native;
using Jint.Native.Array;
using Jint.Native.Object;
using Jint.Runtime;
using Jint.Runtime.Interop;

namespace ScriptGo.Host;

/// <summary>A JavaScript entry went over its budget.</summary>
internal sealed class JsQuotaException(string kind, string detail) : Exception($"quota_exceeded:{kind} ({detail})")
{
    public string Kind { get; } = kind;
}

internal sealed class EntryBudget : Constraint
{
    private long _statements;
    private long _limit = long.MaxValue;
    private long _deadline = long.MaxValue;
    private long _allocationStart;
    private long _allocationLimit = long.MaxValue;
    private string _timeout = "";
    public bool Exceeded { get; private set; }
    /// <summary>The failure was logged (once per budget).</summary>
    public bool Reported { get; set; }
    private JsQuotaException? _failure;

    public void Begin(Quotas q)
    {
        _statements = 0;
        _limit = q.JsStatements;
        _deadline = Stopwatch.GetTimestamp() + (long)(q.JsTimeout.TotalSeconds * Stopwatch.Frequency);
        _timeout = $"{q.JsTimeout.TotalMilliseconds:0} ms per entry";
        _allocationStart = GC.GetAllocatedBytesForCurrentThread();
        _allocationLimit = q.JsMemoryBytes;
        Exceeded = false;
        Reported = false;
        _failure = null;
    }

    /// <summary>The counters, saved so the recovery code can run on a temporary budget.</summary>
    public object Save() => (_statements, _limit, _deadline, _allocationStart, _allocationLimit, _timeout, Exceeded, Reported, _failure);

    public void Restore(object saved) =>
        (_statements, _limit, _deadline, _allocationStart, _allocationLimit, _timeout, Exceeded, Reported, _failure) =
            ((long, long, long, long, long, string, bool, bool, JsQuotaException?))saved;

    public override void Check()
    {
        if (_failure is not null) throw _failure;
        if (++_statements > _limit) Fail("instructions", $"{_limit} statements per entry");
        if ((_statements & 1023) == 0)
        {
            if (Stopwatch.GetTimestamp() > _deadline) Fail("time", _timeout);
            if (GC.GetAllocatedBytesForCurrentThread() - _allocationStart > _allocationLimit)
                Fail("memory", $"{_allocationLimit / (1024 * 1024)} MiB allocated per entry");
        }
    }

    private void Fail(string kind, string detail)
    {
        Exceeded = true;
        _failure = new JsQuotaException(kind, detail);
        throw _failure;
    }

    /// <summary>Jint calls this on every Invoke/Execute, nested ones included: entries are reset by the guest instead.</summary>
    public override void Reset() { }
}

internal sealed class JsGuest(SideRuntime side) : Guest(side, "js")
{
    private static readonly Lazy<string> Prelude = new(() => Encoding.UTF8.GetString(LuaGuest.Embedded("ScriptGo.Host.prelude.js")));

    private readonly EntryBudget _budget = new();
    private Engine? _engine;
    private JsValue _loading = JsValue.Undefined, _recover = JsValue.Undefined, _publish = JsValue.Undefined, _tick = JsValue.Undefined,
        _settle = JsValue.Undefined, _handler = JsValue.Undefined, _exportSync = JsValue.Undefined, _exportAsync = JsValue.Undefined,
        _command = JsValue.Undefined;

    public override long MemoryBytes => 0;

    public override void Initialize()
    {
        var q = Host.Options.Quotas;
        _engine = new Engine(options =>
        {
            options.LimitRecursion(q.JsRecursion);
            options.DisableStringCompilation();
            options.Constraint(_budget);
            options.Constraints.RegexTimeout = q.JsTimeout;
            options.Constraints.MaxArraySize = 16_000_000;
        });
        var engine = _engine;
        var sg = new JsObject(engine);
        sg.CreateDataProperty(new JsString("call"), new ClrFunction(engine, "call", BridgeCall));
        var res = Side.Res;
        var ctx = new SgTable()
            .Add("resource", SgValue.Of(res.Name))
            .Add("version", SgValue.Of(res.Manifest.Version))
            .Add("side", SgValue.Of(Side.Name))
            .Add("environment", SgValue.Of(Host.Environment))
            .Add("runtimeVersion", SgValue.Of(ScriptGoHost.RuntimeVersion))
            .Add("adapterVersion", SgValue.Of(Host.Options.AdapterVersion))
            .Add("threads", SgValue.Of(q.Threads))
            .Add("now", SgValue.Of(Host.Now))
            .Add("capabilities", SgValue.Of(SgTable.FromList(Host.Capabilities.Select(SgValue.Of))))
            .Add("permissions", SgValue.Of(SgTable.FromList(res.Manifest.Permissions.Select(SgValue.Of))))
            .Add("natives", SgValue.Of(Host.NativeDescriptor()));
        _budget.Begin(q);
        var factory = engine.Evaluate(Prelude.Value, "scriptgo/prelude.js");
        // Empty tables would arrive as arrays; the prelude expects objects for these two.
        var ctxValue = JsValues.Write(engine, SgValue.Of(ctx)).AsObject();
        if (Host.NativeDescriptor().Count == 0) ctxValue.CreateDataProperty(new JsString("natives"), new JsObject(engine));
        var entry = engine.Invoke(factory, JsValue.Undefined, [sg, ctxValue]).AsObject();
        _loading = entry.Get(new JsString("loading"));
        _recover = entry.Get(new JsString("recover"));
        _publish = entry.Get(new JsString("publish"));
        _tick = entry.Get(new JsString("tick"));
        _settle = entry.Get(new JsString("settle"));
        _handler = entry.Get(new JsString("handler"));
        _exportSync = entry.Get(new JsString("exportSync"));
        _exportAsync = entry.Get(new JsString("exportAsync"));
        _command = entry.Get(new JsString("command"));
    }

    protected override void CheckMemory() { }

    /// <summary>
    /// Runs an entry: the outermost one gets a fresh budget and then runs the promise jobs. Answers
    /// the entry's array ([true, ...] / [false, reason]) as codec values, or a failure token.
    /// </summary>
    private (bool Ok, SgValue[] Values) Run(Func<Engine, JsValue> body)
    {
        if (_engine is null || Disposed) return (false, [SgValue.Of("resource_stopped")]);
        var engine = _engine;
        return Enter(outermost =>
        {
            if (FreshBudget()) _budget.Begin(Host.Options.Quotas);
            try
            {
                var result = body(engine);
                if (outermost) engine.Advanced.ProcessTasks();
                return Answer(engine, result);
            }
            catch (JsQuotaException e) { return Abandon(engine, outermost, e.Message, quota: true); }
            catch (JavaScriptException e)
            {
                Side.Log(LogLevel.Error, e.JavaScriptStackTrace ?? e.Message);
                return (false, [SgValue.Of(e.Message)]);
            }
            catch (RecursionDepthOverflowException e) { return Abandon(engine, outermost, "recursion limit: " + e.Message, quota: false); }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                Side.Log(LogLevel.Error, e.Message);
                return (false, [SgValue.Of(e.Message)]);
            }
        });
    }

    /// <summary>
    /// The entry is abandoned: a quota failure is logged once per budget (it stays exhausted until the
    /// next host-level entry, so every later entry in the same one fails at its first statement); the
    /// outermost entry also clears the engine's call stack and resets the prelude's scheduler context,
    /// on a temporary budget, then puts the real one back.
    /// </summary>
    private (bool, SgValue[]) Abandon(Engine engine, bool outermost, string message, bool quota)
    {
        if (!quota || !_budget.Reported) Side.Log(LogLevel.Error, message);
        if (quota) _budget.Reported = true;
        if (outermost)
        {
            engine.Advanced.ResetCallStack();
            var saved = _budget.Save();
            _budget.Begin(Host.Options.Quotas);
            try { engine.Invoke(_recover, JsValue.Undefined, []); }
            catch (Exception e) { Side.Log(LogLevel.Error, "recover: " + e.Message); }
            finally { _budget.Restore(saved); }
        }
        return (false, [SgValue.Of(message.Split(' ')[0])]);
    }

    private static (bool, SgValue[]) Answer(Engine engine, JsValue result)
    {
        if (result is not ArrayInstance array) return (true, []);
        var all = array.ToArray();
        if (all.Length == 0) return (true, []);
        var ok = all[0].IsBoolean() && all[0].AsBoolean();
        var items = all[1..];
        try { return (ok, JsValues.ReadRange(engine, items, 0)); }
        catch (CodecException e) { return (false, [SgValue.Of("codec_error"), SgValue.Of(e.Message)]); }
    }

    private JsValue Call(Engine engine, JsValue fn, params JsValue[] args) => engine.Invoke(fn, JsValue.Undefined, args);

    public override void RunScript(string path, byte[] source)
    {
        if (_engine is null) throw new GuestScriptException("resource_stopped");
        var engine = _engine;
        string? failure = null;
        Enter(outermost =>
        {
            if (FreshBudget()) _budget.Begin(Host.Options.Quotas);
            try
            {
                Call(engine, _loading, JsBoolean.True);
                try { engine.Execute(Encoding.UTF8.GetString(source), Side.Res.Name + "/" + path); }
                finally { if (!_budget.Exceeded) Call(engine, _loading, JsBoolean.False); }
                if (outermost) engine.Advanced.ProcessTasks();
            }
            catch (JsQuotaException e)
            {
                failure = e.Message;
                Abandon(engine, outermost, e.Message, quota: true);
            }
            catch (JavaScriptException e)
            {
                failure = e.Message;
                Side.Log(LogLevel.Error, e.JavaScriptStackTrace is { } st ? e.Message + "\n" + st : e.Message);
            }
            catch (RecursionDepthOverflowException e)
            {
                failure = "recursion limit: " + e.Message;
                Abandon(engine, outermost, failure, quota: false);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                failure = e.Message;
                Side.Log(LogLevel.Error, e.Message);
            }
        });
        if (failure is not null) throw new GuestScriptException(failure);
    }

    public override bool PublishGlobal(string name)
    {
        if (!Alive) return false;
        var (ok, values) = Run(e => Call(e, _publish, new JsString(name)));
        return ok && values.Length > 0 && values[0].Kind == SgKind.Boolean && values[0].AsBoolean();
    }

    protected override void RunTick(double now, long tickCount) =>
        Run(e => Call(e, _tick, JsNumber.Create(now), JsNumber.Create((double)tickCount)));

    protected override void ApplySettlement(int promiseId, bool ok, SgValue[] values, string? reason) =>
        Run(e =>
        {
            var args = new List<JsValue> { JsNumber.Create(promiseId), ok ? JsBoolean.True : JsBoolean.False };
            if (ok) args.AddRange(JsValues.WriteAll(e, values));
            else args.Add(new JsString(reason ?? "promise_rejected"));
            return Call(e, _settle, args.ToArray());
        });

    private static JsValue Optional(int? v) => v is { } i ? JsNumber.Create(i) : JsValue.Undefined;
    private static JsValue Optional(string? v) => v is null ? JsValue.Undefined : new JsString(v);

    public override void RunHandler(int handlerId, CallContext context, SgValue[] args)
    {
        if (!Alive) return;
        Run(e => Call(e, _handler, [JsNumber.Create(handlerId), Optional(context.Source), Optional(context.Invoking), .. JsValues.WriteAll(e, args)]));
    }

    public override SgValue[] CallExportSync(string name, string invoking, SgValue[] args)
    {
        if (!Alive) throw new ExportFailure("export_resource_unavailable");
        var (ok, values) = Run(e => Call(e, _exportSync, [new JsString(name), new JsString(invoking), .. JsValues.WriteAll(e, args)]));
        if (ok) return values;
        var reason = values.Length > 0 ? values[0].ToString() : "export_failed";
        if (reason == "codec_error") reason = "export_result_not_serializable";
        throw new ExportFailure(reason);
    }

    public override void CallExportAsync(int callId, string name, string invoking, SgValue[] args)
    {
        if (!Alive) return;
        Run(e => Call(e, _exportAsync, [JsNumber.Create(callId), new JsString(name), new JsString(invoking), .. JsValues.WriteAll(e, args)]));
    }

    public override void RunCommand(string name, int source, SgValue[] args, string raw)
    {
        if (!Alive) return;
        Run(e => Call(e, _command, [new JsString(name), JsNumber.Create(source), new JsString(raw), .. JsValues.WriteAll(e, args)]));
    }

    // sg.call(op, ...args) → [true, ...values] | [false, reason, detail]
    private JsValue BridgeCall(JsValue thisObj, JsValue[] args)
    {
        var engine = _engine!;
        BridgeResult result;
        try
        {
            var op = args.Length > 0 && args[0].IsString() ? args[0].AsString() : null;
            if (op is null) result = BridgeResult.Fail("invalid_op");
            else
            {
                SgValue[]? values = null;
                try { values = JsValues.ReadRange(engine, args, 1); }
                catch (CodecException e) { result = BridgeResult.Fail(ScriptGoHost.CodecFailure(op), e.Message); return Pack(engine, result); }
                result = Host.Call(this, op, values);
            }
        }
        catch (JsQuotaException) { throw; }
        catch (Exception e) when (e is not OutOfMemoryException) { result = BridgeResult.Fail("host_error", e.Message); }
        return Pack(engine, result);
    }

    private static JsValue Pack(Engine engine, BridgeResult r)
    {
        if (r.Ok)
        {
            try { return new JsArray(engine, [JsBoolean.True, .. JsValues.WriteAll(engine, r.Values)]); }
            catch (CodecException e) { return new JsArray(engine, [JsBoolean.False, new JsString("codec_error"), new JsString(e.Message)]); }
        }
        return r.Detail is null
            ? new JsArray(engine, [JsBoolean.False, new JsString(r.Reason ?? "error")])
            : new JsArray(engine, [JsBoolean.False, new JsString(r.Reason ?? "error"), new JsString(r.Detail)]);
    }

    protected override void Release()
    {
        _engine?.Dispose();
        _engine = null;
    }
}
