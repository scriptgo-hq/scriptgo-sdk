// The core's bookkeeping: resources, their sides, and what each side registered (handlers,
// exports). Guests own their functions; the core only knows ids and names, so a handler or an
// export can live in any guest language.
using ScriptGo.Host.Manifest;

namespace ScriptGo.Host;

/// <summary>A log line kept by the host (the last 2000).</summary>
public sealed record LogEntry(LogLevel Level, string Origin, string Message, double At);

/// <summary>Where an event, a command or an export call comes from.</summary>
internal readonly record struct CallContext(int? Source, string? Invoking);

internal sealed class Resource(string name, ResourceManifest manifest, string root, IReadOnlyList<Diagnostic> warnings)
{
    public string Name { get; } = name;
    public ResourceManifest Manifest { get; } = manifest;
    public string Root { get; } = root;
    public IReadOnlyList<Diagnostic> Warnings { get; } = warnings;
    /// <summary>stopped, starting, started, failed.</summary>
    public string State { get; set; } = "stopped";
    public string? Failure { get; set; }
    public int Generation { get; set; }
    public Dictionary<string, SideRuntime> Sides { get; } = new(StringComparer.Ordinal);
}

internal sealed record HandlerEntry(int Id, string Name, Guest Guest);

internal sealed record ExportEntry(string Name, Guest Guest);

internal sealed record CommandEntry(string Name, SideRuntime Side, Guest Guest, bool Restricted);

/// <summary>One side ("server" or "client") of a started resource, with one guest per language.</summary>
internal sealed class SideRuntime(ScriptGoHost host, Resource res, string name)
{
    private int _nextId;

    public ScriptGoHost Host { get; } = host;
    public Resource Res { get; } = res;
    public string Name { get; } = name;
    public bool Alive { get; private set; } = true;

    /// <summary>Guests in creation order (the order the side's scripts first needed them).</summary>
    public List<Guest> Guests { get; } = [];
    public Dictionary<string, List<HandlerEntry>> Handlers { get; } = new(StringComparer.Ordinal);
    public Dictionary<int, HandlerEntry> HandlerById { get; } = [];
    public HashSet<string> NetEvents { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, ExportEntry> Exports { get; } = new(StringComparer.Ordinal);

    public int NextId() => ++_nextId;

    public string Origin => $"{Res.Name}:{Name}";

    public Guest? GuestFor(string language) => Guests.FirstOrDefault(g => g.Language == language);

    public void Log(LogLevel level, string message) => Host.Log(level, Origin, message);

    /// <summary>Stops everything; guests are disposed by the host once no guest is executing.</summary>
    public void Kill()
    {
        Alive = false;
        Handlers.Clear();
        HandlerById.Clear();
        NetEvents.Clear();
        Exports.Clear();
        foreach (var g in Guests) g.Kill();
    }
}

internal sealed record QueuedEvent(string Kind, string Target, string Name, SgValue[] Args, CallContext Context);

/// <summary>An asynchronous export call in flight: completes into the caller (a guest promise or the host).</summary>
internal sealed class AsyncCall(int id, SideRuntime target, Action<bool, SgValue[], string?> complete)
{
    public int Id { get; } = id;
    public SideRuntime Target { get; } = target;
    public Action<bool, SgValue[], string?> Complete { get; } = complete;
}

/// <summary>A sync export failed; <see cref="Reason"/> is the token the caller sees.</summary>
internal sealed class ExportFailure(string reason) : Exception(reason)
{
    public string Reason { get; } = reason;
}

/// <summary>A script failed to load; the message is its first line (the full text is logged).</summary>
internal sealed class GuestScriptException(string message) : Exception(message);

/// <summary>The outcome of a bridge call from a guest: values, or a failure token (and detail).</summary>
internal readonly struct BridgeResult
{
    public bool Ok { get; private init; }
    public SgValue[] Values { get; private init; }
    public string? Reason { get; private init; }
    public string? Detail { get; private init; }

    public static readonly BridgeResult Empty = new() { Ok = true, Values = [] };
    public static BridgeResult Of(params SgValue[] values) => new() { Ok = true, Values = values };
    public static BridgeResult Fail(string reason, string? detail = null) => new() { Ok = false, Values = [], Reason = reason, Detail = detail };
}
