using System.Text.Json;
using System.Text.Json.Nodes;
using ScriptGo.Host.Manifest;

namespace ScriptGo.Host.Tests;

/// <summary>
/// The manifest fixtures shared by the TypeScript parser (packages/manifest) and the Lua core
/// (sdk/lua/spec/fixtures): the .NET parser must give the same verdict, the same error and warning
/// codes, and a manifest that matches the expected one (objects as subsets, arrays exactly).
/// </summary>
[TestClass]
public sealed class ManifestFixtureTests
{
    private static string FixtureRoot()
    {
        const string rel = "sdk/lua/spec/fixtures";
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var path = Path.Combine(dir.FullName, rel.Replace('/', Path.DirectorySeparatorChar));
            if (Directory.Exists(path)) return path;
        }
        throw new DirectoryNotFoundException(rel + " not found above " + AppContext.BaseDirectory);
    }

    private static readonly JsonSerializerOptions Camel = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static string? Matches(JsonNode? actual, JsonNode? expected, string path)
    {
        if (expected is null) return actual is null ? null : $"{path}: expected null, got {actual.ToJsonString()}";
        switch (expected)
        {
            case JsonObject eo:
                if (actual is not JsonObject ao) return $"{path}: expected an object, got {actual?.ToJsonString() ?? "null"}";
                foreach (var (k, v) in eo)
                {
                    var why = Matches(ao[k], v, path + "." + k);
                    if (why is not null) return why;
                }
                return null;
            case JsonArray ea:
                if (actual is not JsonArray aa) return $"{path}: expected an array, got {actual?.ToJsonString() ?? "null"}";
                if (aa.Count != ea.Count) return $"{path}: expected {ea.Count} items, got {aa.Count} ({aa.ToJsonString()})";
                for (var i = 0; i < ea.Count; i++)
                {
                    var why = Matches(aa[i], ea[i], $"{path}[{i}]");
                    if (why is not null) return why;
                }
                return null;
            default:
                return JsonNode.DeepEquals(actual, expected) ? null : $"{path}: expected {expected.ToJsonString()}, got {actual?.ToJsonString() ?? "null"}";
        }
    }

    private static List<string> Codes(IEnumerable<Diagnostic> d) => d.Select(x => x.Code).ToList();

    [TestMethod]
    [DataRow("manifests", ".lua", "scriptgo.lua")]
    [DataRow("manifests-json", ".json", "scriptgo.json")]
    public void SharedFixturesGiveTheSameResult(string folder, string extension, string defaultFile)
    {
        var dir = Path.Combine(FixtureRoot(), folder);
        var fixtures = Directory.GetFiles(dir, "*" + extension).Where(f => !f.EndsWith(".expect.json", StringComparison.Ordinal)).Order(StringComparer.Ordinal).ToList();
        Assert.IsTrue(fixtures.Count >= 8, $"only {fixtures.Count} fixtures in {folder}");
        var failures = new List<string>();
        foreach (var file in fixtures)
        {
            var name = Path.GetFileNameWithoutExtension(file);
            var expected = JsonNode.Parse(File.ReadAllText(Path.Combine(dir, name + ".expect.json")))!.AsObject();
            var result = ManifestParser.Parse(File.ReadAllText(file), expected["fileName"]?.GetValue<string>() ?? defaultFile);
            if (result.Ok != expected["ok"]!.GetValue<bool>()) failures.Add($"{name}: ok={result.Ok} ({string.Join(", ", result.Errors.Select(e => e.Code + " " + e.Message))})");
            if (expected["errors"] is JsonArray errors)
            {
                var want = errors.Select(e => e!.GetValue<string>()).ToList();
                if (!want.SequenceEqual(Codes(result.Errors))) failures.Add($"{name}: errors [{string.Join(", ", Codes(result.Errors))}], expected [{string.Join(", ", want)}]");
            }
            if (expected["warnings"] is JsonArray warnings)
            {
                var want = warnings.Select(e => e!.GetValue<string>()).ToList();
                if (!want.SequenceEqual(Codes(result.Warnings))) failures.Add($"{name}: warnings [{string.Join(", ", Codes(result.Warnings))}], expected [{string.Join(", ", want)}]");
            }
            if (expected["manifest"] is JsonObject manifest && result.Ok)
            {
                var actual = JsonSerializer.SerializeToNode(result.Manifest, Camel);
                if (Matches(actual, manifest, "manifest") is { } why) failures.Add($"{name}: {why}");
            }
        }
        Assert.AreEqual(0, failures.Count, string.Join("\n", failures));
    }
}
