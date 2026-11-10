// A guest engine: one isolated VM for one language on one side of one resource. The core calls
// these entry points; the guest calls back through ScriptGoHost.Bridge. A guest gets a fresh budget
// once per host-level entry (ScriptGoHost.BudgetEpoch); every nested entry in the same epoch (an
// export calling back, another resource calling its exports in a loop) draws on the same budget.
namespace ScriptGo.Host;

internal abstract class Guest(SideRuntime side, string language) : IDisposable
{
    private readonly List<(int Id, bool Ok, SgValue[] Values, string? Reason)> _settlements = [];

    public SideRuntime Side { get; } = side;
    public ScriptGoHost Host => Side.Host;
    public string Language { get; } = language;
    public bool Alive { get; private set; } = true;
    public bool Disposed { get; private set; }
    /// <summary>Entries currently on the stack (re-entrant calls through synchronous exports).</summary>
    protected int Depth { get; private set; }

    private long _budgetEpoch = -1;

    /// <summary>True once per host-level entry: the guest should reset its budget now.</summary>
    protected bool FreshBudget()
    {
        if (_budgetEpoch == Host.BudgetEpoch) return false;
        _budgetEpoch = Host.BudgetEpoch;
        return true;
    }

    public string Origin => Side.Origin;

    /// <summary>Creates the VM and runs the prelude.</summary>
    public abstract void Initialize();

    /// <summary>Runs a script at file scope. Throws <see cref="GuestScriptException"/> on failure.</summary>
    public abstract void RunScript(string path, byte[] source);

    /// <summary>Runs a script at file scope, compiled by the file provider straight into the VM (see
    /// <see cref="INativeLuaChunks"/>). False when this guest has no such path; the host then reads
    /// the source and calls <see cref="RunScript"/>. Throws <see cref="GuestScriptException"/> on failure.</summary>
    public virtual bool TryRunNativeScript(string path) => false;

    /// <summary>A global function of that name exists (declarative manifest exports).</summary>
    public abstract bool PublishGlobal(string name);

    public abstract void RunHandler(int handlerId, CallContext context, SgValue[] args);

    /// <summary>Runs an export to completion without waiting. Throws <see cref="ExportFailure"/>.</summary>
    public abstract SgValue[] CallExportSync(string name, string invoking, SgValue[] args);

    /// <summary>Starts an export in a thread; completes through the bridge op asyncDone.</summary>
    public abstract void CallExportAsync(int callId, string name, string invoking, SgValue[] args);

    public abstract void RunCommand(string name, int source, SgValue[] args, string raw);

    /// <summary>Heap in use, in bytes.</summary>
    public abstract long MemoryBytes { get; }

    /// <summary>Applies queued settlements, then resumes the threads that are due.</summary>
    public void Tick(double now, long tickCount)
    {
        if (!Alive) return;
        if (_settlements.Count > 0)
        {
            var batch = _settlements.ToArray();
            _settlements.Clear();
            foreach (var s in batch) if (Alive) ApplySettlement(s.Id, s.Ok, s.Values, s.Reason);
        }
        if (Alive) RunTick(now, tickCount);
    }

    protected abstract void RunTick(double now, long tickCount);

    /// <summary>Settles a guest promise (export call, HTTP) on the guest's next tick.</summary>
    public void Settle(int promiseId, bool ok, SgValue[] values, string? reason)
    {
        if (Alive) _settlements.Add((promiseId, ok, values, reason));
    }

    protected abstract void ApplySettlement(int promiseId, bool ok, SgValue[] values, string? reason);

    /// <summary>Marks the guest dead; the VM is released by <see cref="Dispose"/> once nothing runs in it.</summary>
    public void Kill()
    {
        Alive = false;
        _settlements.Clear();
    }

    /// <summary>Wraps an entry: depth tracking, the host's re-entrancy guard, and the memory check after.</summary>
    protected T Enter<T>(Func<bool, T> body)
    {
        var outermost = Depth == 0;
        Depth++;
        Host.EnterGuest();
        try { return body(outermost); }
        finally
        {
            Depth--;
            Host.LeaveGuest();
            if (outermost && Alive) CheckMemory();
        }
    }

    protected void Enter(Action<bool> body) => Enter(outermost => { body(outermost); return 0; });

    protected abstract void CheckMemory();

    protected virtual void Release() { }

    public void Dispose()
    {
        if (Disposed) return;
        Disposed = true;
        Alive = false;
        Release();
        GC.SuppressFinalize(this);
    }
}
