// Native modules: the integrator describes its natives once (name, parameters, results, side,
// required permission), binds a handler to each, and the kit exposes them to every guest language
// as ScriptGo.natives.<module>.<function> (and as a global <module> when "global" is set). The same
// description generates the typings (TypeScript .d.ts and LuaLS annotations). Schema:
// docs/spec/native-module.schema.json.
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ScriptGo.Host;

/// <summary>A value type in a native signature: nil, boolean, integer, number, string, table, any, T[], T?.</summary>
public sealed partial record NativeType(string Expression)
{
    [GeneratedRegex(@"^(nil|boolean|integer|number|string|table|any)(\[\])?(\?)?$")]
    private static partial Regex Grammar();

    public static bool IsValid(string expression) => Grammar().IsMatch(expression);

    public bool Optional => Expression.EndsWith('?');
    private string Core => Expression.TrimEnd('?');
    public bool IsList => Core.EndsWith("[]", StringComparison.Ordinal);
    public string Element => Core.Replace("[]", "", StringComparison.Ordinal);

    /// <summary>Checks a value against the type.</summary>
    public bool Accepts(SgValue v)
    {
        if (v.IsNil) return Optional || Element is "nil" or "any";
        if (IsList)
        {
            if (v.Kind != SgKind.Table) return false;
            var t = v.AsTable();
            if (t.Count == 0) return true;
            if (!t.IsSequence(out _)) return false;
            var element = new NativeType(Element);
            return t.SequenceValues().All(element.Accepts);
        }
        return Element switch
        {
            "any" => true,
            "boolean" => v.Kind == SgKind.Boolean,
            "integer" => v.Kind == SgKind.Integer,
            "number" => v.IsNumber,
            "string" => v.Kind == SgKind.String,
            "table" => v.Kind == SgKind.Table,
            _ => false,
        };
    }

    public string ToTypeScript()
    {
        var element = Element switch
        {
            "nil" => "undefined", "boolean" => "boolean", "integer" or "number" => "number", "string" => "string",
            "table" => "SgTable", _ => "unknown",
        };
        var ts = IsList ? $"{element}[]" : element;
        return Optional && Element != "nil" ? $"{ts} | undefined" : ts;
    }

    public string ToLua()
    {
        var element = Element switch { "any" => "any", "table" => "table", _ => Element };
        return (IsList ? element + "[]" : element) + (Optional ? "?" : "");
    }
}

public sealed record NativeParam(string Name, NativeType Type, string? Description = null);

/// <summary>What a handler receives: the calling resource and side, and the copied arguments.</summary>
public sealed class NativeCall
{
    internal NativeCall(ScriptGoHost host, string resource, string side, string language, SgValue[] args)
    {
        Host = host; Resource = resource; Side = side; Language = language; Args = args;
    }

    public ScriptGoHost Host { get; }
    public string Resource { get; }
    public string Side { get; }
    /// <summary>"lua" or "js".</summary>
    public string Language { get; }
    public SgValue[] Args { get; }
    public SgValue Arg(int index) => index < Args.Length ? Args[index] : SgValue.Nil;
}

public delegate SgValue[] NativeHandler(NativeCall call);

/// <summary>A refusal a handler raises on purpose; the guest sees <c>Code</c> (Lua error / JS ScriptGoError).</summary>
public sealed class NativeException(string code, string? detail = null) : Exception(detail is null ? code : $"{code}: {detail}")
{
    public string Code { get; } = code;
}

public sealed class NativeFunction
{
    public required string Name { get; init; }
    public string? Description { get; init; }
    /// <summary>"server", "client" or "both".</summary>
    public string Side { get; init; } = "both";
    /// <summary>A permission the resource must declare (and the operator grant) to call it.</summary>
    public string? Permission { get; init; }
    public IReadOnlyList<NativeParam> Params { get; init; } = [];
    public IReadOnlyList<NativeType> Returns { get; init; } = [];
    public NativeHandler? Handler { get; set; }

    public bool AvailableOn(string side) => Side == "both" || Side == side;
}

public sealed partial class NativeModule
{
    [GeneratedRegex("^[A-Za-z][A-Za-z0-9_]{0,63}$")]
    private static partial Regex NamePattern();

    public required string Name { get; init; }
    public string? Description { get; init; }
    /// <summary>Also expose the module as a global of that name (when it does not collide with the runtime).</summary>
    public bool Global { get; init; }
    /// <summary>An extension capability ("x-...") the host gains by registering this module.</summary>
    public string? Capability { get; init; }
    public List<NativeFunction> Functions { get; init; } = [];

    public NativeFunction? Find(string name) => Functions.FirstOrDefault(f => f.Name == name);

    /// <summary>Binds a handler to a declared function (fluent).</summary>
    public NativeModule Bind(string function, NativeHandler handler)
    {
        (Find(function) ?? throw new ArgumentException($"native module {Name} has no function '{function}'")).Handler = handler;
        return this;
    }

    /// <summary>Problems that make the module unusable (checked at registration).</summary>
    public IReadOnlyList<string> Validate()
    {
        var problems = new List<string>();
        if (!NamePattern().IsMatch(Name)) problems.Add($"module name '{Name}' must match ^[A-Za-z][A-Za-z0-9_]{{0,63}}$");
        if (Capability is not null && !Regex.IsMatch(Capability, "^x-[a-z0-9-]+$")) problems.Add($"capability '{Capability}' must be an x- extension");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var f in Functions)
        {
            if (!NamePattern().IsMatch(f.Name)) problems.Add($"function name '{f.Name}' is invalid");
            if (!seen.Add(f.Name)) problems.Add($"function '{f.Name}' is declared twice");
            if (f.Side is not ("server" or "client" or "both")) problems.Add($"{f.Name}: side must be server, client or both");
            if (f.Handler is null) problems.Add($"{f.Name}: no handler bound");
            var optionalSeen = false;
            foreach (var p in f.Params)
            {
                if (!NativeType.IsValid(p.Type.Expression)) problems.Add($"{f.Name}({p.Name}): unknown type '{p.Type.Expression}'");
                if (p.Type.Optional) optionalSeen = true;
                else if (optionalSeen) problems.Add($"{f.Name}({p.Name}): a required parameter cannot follow an optional one");
            }
            foreach (var r in f.Returns) if (!NativeType.IsValid(r.Expression)) problems.Add($"{f.Name}: unknown result type '{r.Expression}'");
        }
        return problems;
    }

    /// <summary>Reads a module description (docs/spec/native-module.schema.json); bind handlers after.</summary>
    public static NativeModule FromJson(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        string? Str(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var module = new NativeModule
        {
            Name = Str(root, "name") ?? throw new FormatException("native module: 'name' is required"),
            Description = Str(root, "description"),
            Global = root.TryGetProperty("global", out var g) && g.ValueKind == JsonValueKind.True,
            Capability = Str(root, "capability"),
        };
        if (root.TryGetProperty("functions", out var fns))
        {
            foreach (var f in fns.EnumerateArray())
            {
                var parameters = new List<NativeParam>();
                if (f.TryGetProperty("params", out var ps))
                    foreach (var p in ps.EnumerateArray())
                        parameters.Add(new(Str(p, "name") ?? "arg", new NativeType(Str(p, "type") ?? "any"), Str(p, "description")));
                var returns = new List<NativeType>();
                if (f.TryGetProperty("returns", out var rs))
                {
                    if (rs.ValueKind == JsonValueKind.String) returns.Add(new NativeType(rs.GetString()!));
                    else if (rs.ValueKind == JsonValueKind.Array) foreach (var r in rs.EnumerateArray()) returns.Add(new NativeType(r.GetString() ?? "any"));
                }
                module.Functions.Add(new NativeFunction
                {
                    Name = Str(f, "name") ?? throw new FormatException("native function: 'name' is required"),
                    Description = Str(f, "description"),
                    Side = Str(f, "side") ?? "both",
                    Permission = Str(f, "permission"),
                    Params = parameters,
                    Returns = returns,
                });
            }
        }
        return module;
    }

    /// <summary>TypeScript declarations for this module (ambient, next to @scriptgo/types).</summary>
    public string ToTypeScript()
    {
        var sb = new StringBuilder();
        sb.AppendLine($"// Generated by ScriptGo.Host from the native module '{Name}'. Do not edit.");
        sb.AppendLine("declare namespace ScriptGoNatives {");
        if (Description is not null) sb.AppendLine($"  /** {Description} */");
        sb.AppendLine($"  namespace {Name} {{");
        foreach (var f in Functions)
        {
            sb.AppendLine($"    /** {Doc(f)} */");
            var ps = string.Join(", ", f.Params.Select(p => $"{p.Name}{(p.Type.Optional ? "?" : "")}: {p.Type.ToTypeScript().Replace(" | undefined", "", StringComparison.Ordinal)}"));
            var ret = f.Returns.Count switch
            {
                0 => "void",
                1 => f.Returns[0].ToTypeScript(),
                _ => "[" + string.Join(", ", f.Returns.Select(r => r.ToTypeScript())) + "]",
            };
            sb.AppendLine($"    function {f.Name}({ps}): {ret};");
        }
        sb.AppendLine("  }");
        sb.AppendLine("}");
        if (Global) sb.AppendLine($"declare const {Name}: typeof ScriptGoNatives.{Name};");
        return sb.ToString();
    }

    /// <summary>LuaLS annotations for this module.</summary>
    public string ToLuaAnnotations()
    {
        var sb = new StringBuilder();
        sb.AppendLine($"---@meta");
        sb.AppendLine($"-- Generated by ScriptGo.Host from the native module '{Name}'. Do not edit.");
        sb.AppendLine($"---@class ScriptGoNative.{Name}");
        sb.AppendLine($"local {Name} = {{}}");
        foreach (var f in Functions)
        {
            sb.AppendLine($"--- {Doc(f)}");
            foreach (var p in f.Params) sb.AppendLine($"---@param {p.Name} {p.Type.ToLua()}{(p.Description is null ? "" : " " + p.Description)}");
            foreach (var r in f.Returns) sb.AppendLine($"---@return {r.ToLua()}");
            sb.AppendLine($"function {Name}.{f.Name}({string.Join(", ", f.Params.Select(p => p.Name))}) end");
        }
        if (Global) sb.AppendLine($"_G.{Name} = {Name}");
        return sb.ToString();
    }

    private static string Doc(NativeFunction f)
    {
        var parts = new List<string>();
        if (f.Description is not null) parts.Add(f.Description);
        parts.Add($"Side: {f.Side}.");
        if (f.Permission is not null) parts.Add($"Permission: {f.Permission}.");
        return string.Join(" ", parts);
    }
}
