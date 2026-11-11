// The resource manifest, normalized: `scriptgo.lua` (the DSL), `scriptgo.json` (the same schema in
// JSON) or `open77.lua`. Same rules, codes and fixtures as packages/manifest (TypeScript) and
// sdk/lua/scriptgo/manifest.lua. See docs/spec/manifest.md.
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ScriptGo.Host.Manifest;

public sealed record Diagnostic(string Code, string Message, int? Line = null);

public sealed record Dependency(string Name, string? Range);

public sealed record UnknownDirective(string Directive, IReadOnlyList<object?> Args, int Line);

/// <summary>A parsed, validated manifest.</summary>
public sealed class ResourceManifest
{
    /// <summary>"scriptgo" (scriptgo.lua or scriptgo.json) or "open77".</summary>
    public required string Format { get; init; }
    public required string Name { get; init; }
    public required string Version { get; init; }
    public string? Title { get; init; }
    public string? Description { get; init; }
    public string? Author { get; init; }
    public string? License { get; init; }
    public string? Repository { get; init; }
    public string Category { get; init; } = "other";
    public string? ScriptgoVersion { get; init; }
    public string? Open77Version { get; init; }
    public bool AutoStart { get; init; } = true;
    public bool Licensed { get; init; }
    public IReadOnlyList<string> Lua { get; init; } = [];
    public IReadOnlyList<string> Environments { get; init; } = [];
    public IReadOnlyList<string> Capabilities { get; init; } = [];
    public IReadOnlyList<string> OptionalCapabilities { get; init; } = [];
    public IReadOnlyList<string> SharedScripts { get; init; } = [];
    public IReadOnlyList<string> ServerScripts { get; init; } = [];
    public IReadOnlyList<string> ClientScripts { get; init; } = [];
    public IReadOnlyDictionary<string, IReadOnlyList<string>> EnvironmentScripts { get; init; } = new Dictionary<string, IReadOnlyList<string>>();
    public IReadOnlyList<string> TestScripts { get; init; } = [];
    public IReadOnlyList<Dependency> Dependencies { get; init; } = [];
    public IReadOnlyList<string> Permissions { get; init; } = [];
    public IReadOnlyList<string> Files { get; init; } = [];
    public IReadOnlyList<string> Exports { get; init; } = [];
    public IReadOnlyList<string> ServerExports { get; init; } = [];
    public string? WebUiPage { get; init; }
    public IReadOnlyList<string> WebFiles { get; init; } = [];
    /// <summary>Client-delivered assets (docs/spec/assets.md): globs delivered on every environment that can.</summary>
    public IReadOnlyList<string> Assets { get; init; } = [];
    /// <summary>Assets in one environment's native delivery form.</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> EnvironmentAssets { get; init; } = new Dictionary<string, IReadOnlyList<string>>();
    /// <summary>Game or engine builds the assets were made and tested against, per environment.</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> GameBuilds { get; init; } = new Dictionary<string, IReadOnlyList<string>>();
    /// <summary>FiveM-style data files: data file type to paths.</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> DataFiles { get; init; } = new Dictionary<string, IReadOnlyList<string>>();
    public IReadOnlyList<UnknownDirective> Unknown { get; init; } = [];

    /// <summary>Guest languages the scripts need: "lua" for .lua, "js" for .js and .ts (sorted).</summary>
    public IReadOnlyList<string> ScriptLanguages() =>
        SharedScripts.Concat(ServerScripts).Concat(ClientScripts).Concat(EnvironmentScripts.Values.SelectMany(v => v))
            .Select(ManifestParser.LanguageOf).Where(l => l is not null).Select(l => l!).Distinct().Order(StringComparer.Ordinal).ToList();
}

public sealed record ManifestResult(bool Ok, ResourceManifest? Manifest, IReadOnlyList<Diagnostic> Errors, IReadOnlyList<Diagnostic> Warnings);

public static partial class ManifestParser
{
    public static readonly string[] Capabilities = ["events", "logging", "storage", "players", "permissions", "commands", "config", "ui", "http", "licensing", "perks", "presence"];
    public static readonly string[] KnownEnvironments = ["standalone", "love2d", "godot", "luanti", "open77", "openresty", "defold", "neovim", "cctweaked", "dotnet", "garrysmod", "hytale", "rust", "beammp", "fivem"];
    public static readonly string[] LuaDialects = ["5.1", "5.2", "5.3", "5.4", "luajit"];
    public static readonly string[] Categories = ["inventory", "permissions", "economy", "events", "ui", "admin", "framework", "vehicles", "housing", "quests", "library", "other"];
    public const int MaxManifestBytes = 256 * 1024;
    /// <summary>Manifest file names a host looks for, in this order (first found wins).</summary>
    public static readonly string[] ManifestFiles = ["scriptgo.lua", "scriptgo.json", "open77.lua"];

    [GeneratedRegex("^[a-z][a-z0-9_]{2,63}$")]
    public static partial Regex ResourceNamePattern();

    [GeneratedRegex("^[a-z0-9][a-z0-9_-]{0,63}$")]
    public static partial Regex SlugPattern();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")]
    private static partial Regex GameBuildPattern();

    [GeneratedRegex("^[A-Z0-9_]{1,64}$")]
    private static partial Regex DataFileTypePattern();

    /// <summary>Reserved for the per-buyer fingerprint entry of a delivered archive.</summary>
    public const string ReservedAssetPrefix = ".scriptgo/";

    private static readonly Dictionary<string, string> EnvListHint = new(StringComparer.Ordinal)
    {
        ["environment_scripts"] = "an environment and at least one script, e.g. environment_script \"love2d\" \"env/love2d/hud.lua\"",
        ["environment_assets"] = "an environment and at least one asset path, e.g. environment_asset \"open77\" \"dist/map.zip\"",
        ["game_builds"] = "an environment and at least one build, e.g. game_build \"open77\" \"2.5\"",
        ["data_files"] = "a data file type and at least one path, e.g. data_file \"DLC_ITYP_REQUEST\" \"stream/props.ytyp\"",
    };

    [GeneratedRegex("^x-[a-z0-9-]+$")]
    private static partial Regex ExtensionCapability();

    [GeneratedRegex(@"^\s*([a-z0-9][a-z0-9_-]{0,63})\s*(.*)$", RegexOptions.Singleline)]
    private static partial Regex DependencyPattern();

    [GeneratedRegex(@"^[A-Za-z0-9.+-]+(\s+(AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*$")]
    private static partial Regex SpdxPattern();

    private enum Kind { String, Boolean, List, EnvList }

    private static readonly Dictionary<string, (string Key, Kind Kind)> Directives = BuildDirectives();

    private static Dictionary<string, (string, Kind)> BuildDirectives()
    {
        var d = new Dictionary<string, (string, Kind)>(StringComparer.Ordinal);
        void Def(string[] names, string key, Kind kind) { foreach (var n in names) d[n] = (key, kind); }
        Def(["resource"], "resource", Kind.String);
        Def(["version"], "version", Kind.String);
        Def(["title"], "title", Kind.String);
        Def(["description"], "description", Kind.String);
        Def(["author"], "author", Kind.String);
        Def(["license"], "license", Kind.String);
        Def(["repository"], "repository", Kind.String);
        Def(["category"], "category", Kind.String);
        Def(["scriptgo_version"], "scriptgo_version", Kind.String);
        Def(["open77_version"], "open77_version", Kind.String);
        Def(["web_ui_page"], "web_ui_page", Kind.String);
        Def(["auto_start"], "auto_start", Kind.Boolean);
        Def(["licensed"], "licensed", Kind.Boolean);
        Def(["shared_script", "shared_scripts"], "shared_scripts", Kind.List);
        Def(["server_script", "server_scripts"], "server_scripts", Kind.List);
        Def(["client_script", "client_scripts"], "client_scripts", Kind.List);
        Def(["test_script", "test_scripts"], "test_scripts", Kind.List);
        Def(["file", "files"], "files", Kind.List);
        Def(["web_file", "web_files"], "web_files", Kind.List);
        Def(["permission", "permissions"], "permissions", Kind.List);
        Def(["dependency", "dependencies"], "dependencies", Kind.List);
        Def(["export", "exports"], "exports", Kind.List);
        Def(["server_export", "server_exports"], "server_exports", Kind.List);
        Def(["lua"], "lua", Kind.List);
        Def(["environments"], "environments", Kind.List);
        Def(["capability", "capabilities"], "capabilities", Kind.List);
        Def(["optional_capability", "optional_capabilities"], "optional_capabilities", Kind.List);
        Def(["environment_script", "environment_scripts"], "environment_scripts", Kind.EnvList);
        // Client-delivered assets (docs/spec/assets.md).
        Def(["asset", "assets"], "assets", Kind.List);
        Def(["environment_asset", "environment_assets"], "environment_assets", Kind.EnvList);
        Def(["game_build", "game_builds"], "game_builds", Kind.EnvList);
        Def(["data_file", "data_files"], "data_files", Kind.EnvList);
        return d;
    }

    /// <summary>The guest language of a script path: "lua", "js" (for .js and .ts), or null.</summary>
    public static string? LanguageOf(string path) =>
        path.EndsWith(".lua", StringComparison.Ordinal) ? "lua"
        : path.EndsWith(".ts", StringComparison.Ordinal) || path.EndsWith(".js", StringComparison.Ordinal) ? "js"
        : null;

    /// <summary>Returns a reason when <paramref name="p"/> is not a safe resource-relative path.</summary>
    public static string? UnsafePathReason(string p)
    {
        if (p.Length == 0) return "empty path";
        if (p.Contains('\\')) return "use '/' as the path separator";
        if (p.StartsWith('/')) return "absolute path";
        if (p.Length >= 2 && char.IsAsciiLetter(p[0]) && p[1] == ':') return "drive path";
        if (p.Split('/').Any(seg => seg == "..")) return "path escapes the resource";
        if (p.Contains('\0')) return "NUL byte";
        return null;
    }

    /// <summary>Parses a manifest; <paramref name="fileName"/> picks the syntax (".json" = scriptgo.json).</summary>
    public static ManifestResult Parse(string source, string fileName = "scriptgo.lua")
    {
        var warnings = new List<Diagnostic>();
        var format = fileName.EndsWith("open77.lua", StringComparison.Ordinal) ? "open77" : "scriptgo";
        if (Encoding.UTF8.GetByteCount(source) > MaxManifestBytes)
            return new(false, null, [new("manifest_too_large", "The manifest exceeds 256 KiB.")], warnings);
        List<RawDirective> directives;
        if (fileName.EndsWith(".json", StringComparison.Ordinal))
        {
            var errorsJson = new List<Diagnostic>();
            directives = JsonDirectives(source, errorsJson);
            if (errorsJson.Count > 0) return new(false, null, errorsJson, warnings);
        }
        else
        {
            try { directives = ManifestSyntax.ParseDirectives(source); }
            catch (ManifestSyntaxException e) { return new(false, null, [new(e.Code, e.Message, e.Line)], warnings); }
        }
        return Normalize(directives, format, warnings);
    }

    // scriptgo.json: each member is one directive (key = directive name), converted to the same raw
    // directives as the DSL so that both forms share every rule below.
    private static List<RawDirective> JsonDirectives(string source, List<Diagnostic> errors)
    {
        var list = new List<RawDirective>();
        JsonDocument doc;
        try { doc = JsonDocument.Parse(source, new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow }); }
        catch (JsonException e)
        {
            errors.Add(new("invalid_json", $"scriptgo.json is not valid JSON: {e.Message.Split('\n')[0]}"));
            return list;
        }
        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
            {
                errors.Add(new("invalid_json", "scriptgo.json must hold one JSON object."));
                return list;
            }
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                if (prop.Name == "$schema") continue;
                var value = prop.Value;
                // Unknown directives are kept with their value as is (and reported as warnings).
                if (!Directives.TryGetValue(prop.Name, out var spec)) { list.Add(new(prop.Name, [JsonScalarOrTable(value)], 0)); continue; }
                if (value.ValueKind == JsonValueKind.Object)
                {
                    if (spec.Kind != Kind.EnvList)
                    {
                        errors.Add(new("invalid_value", $"'{prop.Name}' takes a string, a boolean or a list, not an object."));
                        continue;
                    }
                    foreach (var env in value.EnumerateObject())
                    {
                        var args = new List<object?> { env.Name };
                        if (env.Value.ValueKind == JsonValueKind.Array) args.Add(JsonList(env.Value, prop.Name, errors));
                        else if (env.Value.ValueKind == JsonValueKind.String) args.Add(env.Value.GetString());
                        else { errors.Add(new("invalid_value", $"'{prop.Name}' maps an environment to a path or a list of paths.")); continue; }
                        list.Add(new(prop.Name, args, 0));
                    }
                    continue;
                }
                switch (value.ValueKind)
                {
                    case JsonValueKind.String: list.Add(new(prop.Name, [value.GetString()], 0)); break;
                    case JsonValueKind.True: list.Add(new(prop.Name, [true], 0)); break;
                    case JsonValueKind.False: list.Add(new(prop.Name, [false], 0)); break;
                    case JsonValueKind.Number: list.Add(new(prop.Name, [value.GetDouble()], 0)); break;
                    case JsonValueKind.Array: list.Add(new(prop.Name, [JsonList(value, prop.Name, errors)], 0)); break;
                    default: errors.Add(new("invalid_value", $"'{prop.Name}' cannot be null.")); break;
                }
            }
        }
        return list;
    }

    private static ManifestTable JsonList(JsonElement array, string directive, List<Diagnostic> errors)
    {
        var t = new ManifestTable();
        foreach (var item in array.EnumerateArray())
        {
            switch (item.ValueKind)
            {
                case JsonValueKind.String: t.List.Add(item.GetString()); break;
                case JsonValueKind.True: t.List.Add(true); break;
                case JsonValueKind.False: t.List.Add(false); break;
                case JsonValueKind.Number: t.List.Add(item.GetDouble()); break;
                default: errors.Add(new("invalid_value", $"'{directive}' entries must be strings.")); break;
            }
        }
        return t;
    }

    // Unknown directives keep their value as is.
    private static object? JsonScalarOrTable(JsonElement e)
    {
        switch (e.ValueKind)
        {
            case JsonValueKind.String: return e.GetString();
            case JsonValueKind.True: return true;
            case JsonValueKind.False: return false;
            case JsonValueKind.Number: return e.GetDouble();
            case JsonValueKind.Array:
                var t = new ManifestTable();
                foreach (var item in e.EnumerateArray()) t.List.Add(JsonScalarOrTable(item));
                return t;
            case JsonValueKind.Object:
                var o = new ManifestTable();
                foreach (var p in e.EnumerateObject()) o.Set(p.Name, JsonScalarOrTable(p.Value));
                return o;
            default: return null;
        }
    }

    private static List<string> FlattenStrings(IEnumerable<object?> args, RawDirective d, List<Diagnostic> errors)
    {
        var output = new List<string>();
        foreach (var a in args)
        {
            if (a is string s) output.Add(s);
            else if (a is ManifestTable t)
            {
                if (t.Map.Count > 0) errors.Add(new("invalid_value", $"'{d.Name}' takes a list of strings, not key = value pairs.", LineOf(d)));
                foreach (var item in t.List)
                {
                    if (item is string si) output.Add(si);
                    else errors.Add(new("invalid_value", $"'{d.Name}' entries must be strings.", LineOf(d)));
                }
            }
            else errors.Add(new("invalid_value", $"'{d.Name}' entries must be strings.", LineOf(d)));
        }
        return output;
    }

    private static int? LineOf(RawDirective d) => d.Line > 0 ? d.Line : null;

    private static object? ToPlain(object? v)
    {
        if (v is ManifestTable t)
        {
            if (t.Map.Count == 0) return t.List.Select(ToPlain).ToList();
            var o = new Dictionary<string, object?>();
            foreach (var k in t.MapOrder) o[k] = ToPlain(t.Map[k]);
            if (t.List.Count > 0) o["_list"] = t.List.Select(ToPlain).ToList();
            return o;
        }
        return v;
    }

    private static ManifestResult Normalize(List<RawDirective> directives, string format, List<Diagnostic> warnings)
    {
        var errors = new List<Diagnostic>();
        var scalars = new Dictionary<string, (object Value, RawDirective D)>();
        var lists = new Dictionary<string, List<string>>();
        // Keyed lists (environment_script, environment_asset, game_build, data_file): key -> paths, in first-seen order.
        var envLists = new Dictionary<string, (Dictionary<string, List<string>> Map, List<string> Order)>(StringComparer.Ordinal)
        {
            ["environment_scripts"] = (new Dictionary<string, List<string>>(), new List<string>()),
        };
        var envScripts = envLists["environment_scripts"].Map;
        var envOrder = envLists["environment_scripts"].Order;
        var unknown = new List<UnknownDirective>();

        foreach (var d in directives)
        {
            if (!Directives.TryGetValue(d.Name, out var spec))
            {
                unknown.Add(new(d.Name, d.Args.Select(ToPlain).ToList(), d.Line));
                warnings.Add(new("unknown_directive", $"Directive '{d.Name}' is not used by SCRIPT//GO and is kept as is.", LineOf(d)));
                continue;
            }
            if (spec.Kind is Kind.String or Kind.Boolean)
            {
                if (d.Args.Count != 1) { errors.Add(new("invalid_value", $"'{d.Name}' takes exactly one value.", LineOf(d))); continue; }
                var v = d.Args[0];
                if (spec.Kind == Kind.String && v is not string) { errors.Add(new("invalid_value", $"'{d.Name}' must be a string.", LineOf(d))); continue; }
                if (spec.Kind == Kind.Boolean && v is not bool) { errors.Add(new("invalid_value", $"'{d.Name}' must be true or false.", LineOf(d))); continue; }
                if (scalars.TryGetValue(spec.Key, out var first))
                {
                    errors.Add(new("duplicate_directive", $"'{d.Name}' is declared more than once (first on line {first.D.Line}).", LineOf(d)));
                    continue;
                }
                scalars[spec.Key] = (v!, d);
                continue;
            }
            if (spec.Kind == Kind.EnvList)
            {
                if (d.Args.Count < 2 || d.Args[0] is not string env)
                {
                    errors.Add(new("invalid_value", $"'{d.Name}' needs {EnvListHint[spec.Key]}.", LineOf(d)));
                    continue;
                }
                if (!envLists.TryGetValue(spec.Key, out var keyed)) { keyed = (new Dictionary<string, List<string>>(), new List<string>()); envLists[spec.Key] = keyed; }
                if (!keyed.Map.TryGetValue(env, out var paths)) { paths = []; keyed.Map[env] = paths; keyed.Order.Add(env); }
                paths.AddRange(FlattenStrings(d.Args.Skip(1), d, errors));
                continue;
            }
            if (!lists.TryGetValue(spec.Key, out var listValues)) { listValues = []; lists[spec.Key] = listValues; }
            listValues.AddRange(FlattenStrings(d.Args, d, errors));
        }

        string? Str(string key) => scalars.TryGetValue(key, out var v) && v.Value is string s ? s : null;
        bool Bool(string key, bool fallback) => scalars.TryGetValue(key, out var v) && v.Value is bool b ? b : fallback;
        List<string> List(string key) => lists.TryGetValue(key, out var l) ? l : [];
        int? KeyLine(string key) => scalars.TryGetValue(key, out var v) ? LineOf(v.D) : null;

        var name = Str("resource");
        if (name is null) errors.Add(new("missing_directive", "Directive 'resource' is required."));
        else if (!ResourceNamePattern().IsMatch(name))
            errors.Add(new("invalid_resource_name", "Resource name must be 3 to 64 lowercase letters, digits or '_', starting with a letter (the OPEN//77 rule).", KeyLine("resource")));

        var version = Str("version");
        if (version is null) errors.Add(new("missing_directive", "Directive 'version' is required."));
        else if (!Semver.IsValid(version)) errors.Add(new("invalid_version", $"Version '{version}' is not valid semantic versioning (e.g. 1.4.0).", KeyLine("version")));

        foreach (var key in new[] { "scriptgo_version", "open77_version" })
        {
            var r = Str(key);
            if (r is not null && !Semver.IsValidRange(r)) errors.Add(new("invalid_range", $"'{key}' range '{r}' is not valid (e.g. \">=0.1.0\").", KeyLine(key)));
        }

        void CheckScript(string p, string where, bool luaOnly)
        {
            if (p.StartsWith('@'))
            {
                errors.Add(new("cross_resource_include", $"'{p}' in {where}: cross-resource includes are refused. Share code through dependencies and exports."));
                return;
            }
            var reason = UnsafePathReason(p);
            if (reason is not null) errors.Add(new("unsafe_path", $"'{p}' in {where}: {reason}."));
            else if (luaOnly ? !p.EndsWith(".lua", StringComparison.Ordinal) : LanguageOf(p) is null)
                errors.Add(new("unsupported_script", luaOnly
                    ? $"'{p}' in {where}: test scripts must be .lua files."
                    : $"'{p}' in {where}: script entries must be .lua, .js or .ts files."));
        }
        foreach (var key in new[] { "shared_scripts", "server_scripts", "client_scripts" })
            foreach (var p in List(key)) CheckScript(p, key, false);
        foreach (var p in List("test_scripts")) CheckScript(p, "test_scripts", true);
        foreach (var env in envOrder)
        {
            if (!SlugPattern().IsMatch(env)) errors.Add(new("invalid_environment", $"Environment '{env}' in environment_script is not a valid slug."));
            foreach (var p in envScripts[env]) CheckScript(p, $"environment_script \"{env}\"", false);
        }
        foreach (var key in new[] { "files", "web_files" })
        {
            foreach (var p in List(key))
            {
                var reason = UnsafePathReason(p);
                if (reason is not null) errors.Add(new("unsafe_path", $"'{p}' in {key}: {reason}."));
            }
        }
        // Assets: safe paths outside the reserved fingerprint folder; keyed lists with valid keys.
        (Dictionary<string, List<string>> Map, List<string> Order) Keyed(string key) =>
            envLists.TryGetValue(key, out var k) ? k : (new Dictionary<string, List<string>>(), new List<string>());
        void CheckAsset(string p, string where)
        {
            var reason = UnsafePathReason(p);
            if (reason is not null) errors.Add(new("unsafe_path", $"'{p}' in {where}: {reason}."));
            else if (p.StartsWith(ReservedAssetPrefix, StringComparison.Ordinal))
                errors.Add(new("reserved_path", $"'{p}' in {where}: {ReservedAssetPrefix} is reserved for the per-buyer fingerprint."));
        }
        var environmentAssets = Keyed("environment_assets");
        var gameBuilds = Keyed("game_builds");
        var dataFiles = Keyed("data_files");
        foreach (var p in List("assets")) CheckAsset(p, "assets");
        foreach (var env in environmentAssets.Order)
        {
            if (!SlugPattern().IsMatch(env)) errors.Add(new("invalid_environment", $"Environment '{env}' in environment_asset is not a valid slug."));
            foreach (var p in environmentAssets.Map[env]) CheckAsset(p, $"environment_asset \"{env}\"");
        }
        foreach (var env in gameBuilds.Order)
        {
            if (!SlugPattern().IsMatch(env)) errors.Add(new("invalid_environment", $"Environment '{env}' in game_build is not a valid slug."));
            foreach (var b in gameBuilds.Map[env])
                if (!GameBuildPattern().IsMatch(b)) errors.Add(new("invalid_game_build", $"Game build '{b}' for {env}: use letters, digits, '.', '_', '+' or '-' (e.g. \"2.5\")."));
        }
        foreach (var t in dataFiles.Order)
        {
            if (!DataFileTypePattern().IsMatch(t)) errors.Add(new("invalid_data_file", $"Data file type '{t}' must be upper-case letters, digits or '_' (e.g. \"DLC_ITYP_REQUEST\")."));
            foreach (var p in dataFiles.Map[t]) CheckAsset(p, $"data_file \"{t}\"");
        }

        var webUiPage = Str("web_ui_page");
        if (webUiPage is not null && UnsafePathReason(webUiPage) is { } wr)
            errors.Add(new("unsafe_path", $"'{webUiPage}' in web_ui_page: {wr}.", KeyLine("web_ui_page")));

        foreach (var key in new[] { "exports", "server_exports" })
            foreach (var e in List(key))
                if (!SlugPattern().IsMatch(e)) errors.Add(new("invalid_export_name", $"'{e}' in {key}: export names are ^[a-z0-9][a-z0-9_-]{{0,63}}$."));

        var dependencies = new List<Dependency>();
        foreach (var entry in List("dependencies"))
        {
            var m = DependencyPattern().Match(entry);
            if (!m.Success) { errors.Add(new("invalid_dependency", $"Dependency '{entry}' must look like \"name\" or \"name >=1.0.0\".")); continue; }
            var range = m.Groups[2].Value.Trim();
            if (range.Length > 0 && !Semver.IsValidRange(range)) { errors.Add(new("invalid_dependency", $"Dependency '{entry}' has an invalid version range.")); continue; }
            dependencies.Add(new(m.Groups[1].Value, range.Length > 0 ? range : null));
        }

        foreach (var d in List("lua"))
            if (!LuaDialects.Contains(d)) errors.Add(new("invalid_lua_dialect", $"Lua dialect '{d}' is unknown. Use {string.Join(", ", LuaDialects.Select(x => $"\"{x}\""))}."));
        foreach (var e in List("environments"))
        {
            if (!SlugPattern().IsMatch(e)) errors.Add(new("invalid_environment", $"Environment '{e}' is not a valid slug."));
            else if (!KnownEnvironments.Contains(e)) warnings.Add(new("unknown_environment", $"Environment '{e}' is not a SCRIPT//GO environment yet; it will show as not tested."));
        }
        foreach (var c in List("capabilities").Concat(List("optional_capabilities")))
            if (!Capabilities.Contains(c) && !ExtensionCapability().IsMatch(c))
                errors.Add(new("unknown_capability", $"Capability '{c}' is unknown. Use one of {string.Join(", ", Capabilities)} or an 'x-' extension."));
        var category = Str("category") ?? "other";
        if (!Categories.Contains(category)) warnings.Add(new("unknown_category", $"Category '{category}' is unknown and will be shown as 'other'.", KeyLine("category")));
        var license = Str("license");
        if (license is not null && !SpdxPattern().IsMatch(license))
            warnings.Add(new("license_not_spdx", $"License '{license}' does not look like an SPDX expression.", KeyLine("license")));
        if (format == "scriptgo" && Str("scriptgo_version") is null)
            warnings.Add(new("missing_scriptgo_version", "Declare scriptgo_version (e.g. \">=0.1.0\") so hosts can check compatibility."));
        var hasCode = new[] { "shared_scripts", "server_scripts", "client_scripts" }.Any(k => List(k).Count > 0) || envScripts.Count > 0;
        var hasAssets = List("assets").Count > 0 || environmentAssets.Order.Count > 0;
        if (!hasCode && List("files").Count == 0 && !hasAssets) errors.Add(new("empty_resource", "The resource declares no scripts, no files and no assets."));

        if (errors.Count > 0) return new(false, null, errors, warnings);

        var manifest = new ResourceManifest
        {
            Format = format,
            Name = name!,
            Version = version!,
            Title = Str("title"),
            Description = Str("description"),
            Author = Str("author"),
            License = license,
            Repository = Str("repository"),
            Category = Categories.Contains(category) ? category : "other",
            ScriptgoVersion = Str("scriptgo_version"),
            Open77Version = Str("open77_version"),
            AutoStart = Bool("auto_start", true),
            Licensed = Bool("licensed", false),
            Lua = List("lua"),
            Environments = List("environments"),
            Capabilities = List("capabilities"),
            OptionalCapabilities = List("optional_capabilities"),
            SharedScripts = List("shared_scripts"),
            ServerScripts = List("server_scripts"),
            ClientScripts = List("client_scripts"),
            EnvironmentScripts = envOrder.ToDictionary(e => e, e => (IReadOnlyList<string>)envScripts[e]),
            TestScripts = List("test_scripts"),
            Dependencies = dependencies,
            Permissions = List("permissions"),
            Files = List("files"),
            Exports = List("exports"),
            ServerExports = List("server_exports"),
            WebUiPage = webUiPage,
            WebFiles = List("web_files"),
            Assets = List("assets"),
            EnvironmentAssets = environmentAssets.Order.ToDictionary(e => e, e => (IReadOnlyList<string>)environmentAssets.Map[e]),
            GameBuilds = gameBuilds.Order.ToDictionary(e => e, e => (IReadOnlyList<string>)gameBuilds.Map[e]),
            DataFiles = dataFiles.Order.ToDictionary(e => e, e => (IReadOnlyList<string>)dataFiles.Map[e]),
            Unknown = unknown,
        };
        return new(true, manifest, errors, warnings);
    }

    /// <summary>True when the pattern holds a glob character.</summary>
    public static bool IsGlob(string pattern) => pattern.IndexOfAny(['*', '?']) >= 0;

    /// <summary>Manifest glob with OPEN//77 semantics: `*`/`?` stay in one segment, `**/` needs one directory.</summary>
    public static Regex GlobToRegex(string glob)
    {
        var sb = new StringBuilder("^");
        for (var i = 0; i < glob.Length; i++)
        {
            var c = glob[i];
            if (c == '*')
            {
                if (i + 1 < glob.Length && glob[i + 1] == '*')
                {
                    i++;
                    if (i + 1 < glob.Length && glob[i + 1] == '/') { i++; sb.Append("(?:[^/]+/)+"); }
                    else sb.Append(".*");
                }
                else sb.Append("[^/]*");
            }
            else if (c == '?') sb.Append("[^/]");
            else sb.Append(Regex.Escape(c.ToString()));
        }
        sb.Append('$');
        return new Regex(sb.ToString(), RegexOptions.CultureInvariant);
    }

    public static List<string> ExpandGlob(string pattern, IEnumerable<string> files)
    {
        var all = files.ToList();
        if (!IsGlob(pattern)) return all.Contains(pattern) ? [pattern] : [];
        var re = GlobToRegex(pattern);
        return all.Where(f => re.IsMatch(f)).Order(StringComparer.Ordinal).ToList();
    }
}
