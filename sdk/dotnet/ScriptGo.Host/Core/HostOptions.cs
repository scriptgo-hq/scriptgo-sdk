namespace ScriptGo.Host;

/// <summary>Per-resource limits. The Lua figures are OPEN//77's (instructions per entry, 64 MiB heap).</summary>
public sealed class Quotas
{
    /// <summary>Lua VM instructions per entry (a scheduler pass, a delivery, an export call, a script load).</summary>
    public long LuaInstructions { get; init; } = 1_000_000;
    /// <summary>Lua heap per resource side and language, checked after each entry (after a full collection).</summary>
    public long LuaMemoryBytes { get; init; } = 64L * 1024 * 1024;
    /// <summary>JavaScript statements per entry (counted by the guest's own Jint constraint, not reset by nested calls).</summary>
    public int JsStatements { get; init; } = 1_000_000;
    /// <summary>Wall-clock time per JavaScript entry (also the regular-expression timeout).</summary>
    public TimeSpan JsTimeout { get; init; } = TimeSpan.FromSeconds(2);
    /// <summary>JavaScript call depth (Jint LimitRecursion).</summary>
    public int JsRecursion { get; init; } = 256;
    /// <summary>
    /// Bytes a JavaScript entry may allocate, measured as .NET allocations on the host thread during
    /// the entry. Jint has no per-engine heap, so this bounds the growth per entry, not the live heap.
    /// </summary>
    public long JsMemoryBytes { get; init; } = 64L * 1024 * 1024;
    /// <summary>Live threads (Lua coroutines; pending Wait/SetTimeout in JavaScript) per resource side and language.</summary>
    public int Threads { get; init; } = 1024;
    /// <summary>Event handlers per resource side.</summary>
    public int Handlers { get; init; } = 2048;
    /// <summary>Exports per resource side.</summary>
    public int Exports { get; init; } = 256;
    /// <summary>Queued event deliveries for the next tick, host-wide.</summary>
    public int EventQueue { get; init; } = 4096;
    /// <summary>Nested synchronous export calls (A calls B calls C ...).</summary>
    public int SyncExportDepth { get; init; } = 32;
}

public sealed class HostOptions
{
    /// <summary>The environment slug this host reports (runtime.environment()).</summary>
    public string Environment { get; init; } = "dotnet";
    /// <summary>The adapter version sent to the licensing API and written in reports.</summary>
    public string AdapterVersion { get; init; } = "dotnet-" + ScriptGoHost.KitVersion;
    /// <summary>Run server scripts (the authoritative side).</summary>
    public bool ServerSide { get; init; } = true;
    /// <summary>Run client scripts (single-process hosts: one local client, events looped back).</summary>
    public bool ClientSide { get; init; } = true;
    /// <summary>The local player of the client side.</summary>
    public int LocalPlayerId { get; init; } = 1;
    /// <summary>Guest languages this host runs ("lua", "js").</summary>
    public IReadOnlyCollection<string> Languages { get; init; } = ["lua", "js"];
    /// <summary>Restricts the capabilities (null: everything the services provide).</summary>
    public IReadOnlyCollection<string>? Capabilities { get; init; }
    /// <summary>RegisterCommand is available.</summary>
    public bool Commands { get; init; } = true;
    public Quotas Quotas { get; init; } = new();
    /// <summary>
    /// The operator's grant for a permission a resource declares (resource, permission). A native that
    /// needs a permission runs only when the manifest declares it AND this returns true. Default: grant.
    /// </summary>
    public Func<string, string, bool>? GrantPermission { get; init; }
    /// <summary>Default SCRIPT//GO API for ScriptGo.licensing when the convar scriptgo_api is not set.</summary>
    public string DefaultApi { get; init; } = "https://api.scriptgo.dev";
}
