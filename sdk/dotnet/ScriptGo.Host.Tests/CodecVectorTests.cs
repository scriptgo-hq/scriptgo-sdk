using System.Globalization;
using System.Text;
using System.Text.Json;

namespace ScriptGo.Host.Tests;

/// <summary>
/// The language-neutral codec vectors (sdk/conformance/vectors/codec.json) through the real guests:
/// each Lua and JavaScript expression is handed to a native, whose handler sees the value the codec
/// produced. Every accepted value then crosses again into both languages and back.
/// </summary>
[TestClass]
public sealed class CodecVectorTests
{
    private sealed record Case(string Name, string? Lua, string? Js, string? Typed, string? Error, bool Accepted, string? ViaJs, string[]? LuaVersions, bool Guest);

    private const string VectorFile = "sdk/conformance/vectors/codec.json";

    private static string FindVectors()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var path = Path.Combine(dir.FullName, VectorFile.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(path)) return path;
        }
        throw new FileNotFoundException(VectorFile + " not found above " + AppContext.BaseDirectory);
    }

    private static List<Case> LoadCases()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(FindVectors()));
        string? Str(JsonElement e, string k) => e.TryGetProperty(k, out var v) ? v.GetString() : null;
        return doc.RootElement.GetProperty("cases").EnumerateArray().Select(e => new Case(
            Str(e, "name")!, Str(e, "lua"), Str(e, "js"), Str(e, "typed"), Str(e, "error"),
            e.TryGetProperty("accepted", out var a) && a.GetBoolean(), Str(e, "viaJs"),
            e.TryGetProperty("luaVersions", out var lv) ? lv.EnumerateArray().Select(x => x.GetString()!).ToArray() : null,
            !e.TryGetProperty("guest", out var g) || g.GetBoolean())).ToList();
    }

    /// <summary>The vectors' rendering (see the file's "rendering" field).</summary>
    internal static string Render(SgValue v) => v.Kind switch
    {
        SgKind.Nil => "nil",
        SgKind.Boolean => v.AsBoolean() ? "true" : "false",
        SgKind.Integer => "i:" + v.AsInteger().ToString(CultureInfo.InvariantCulture),
        SgKind.Number => "f:" + v.AsDouble().ToString("R", CultureInfo.InvariantCulture).ToLowerInvariant(),
        SgKind.String => Quote(v.AsBytes()),
        _ => RenderTable(v.AsTable()),
    };

    private static string Quote(byte[] bytes)
    {
        var o = new List<byte>(bytes.Length + 2) { (byte)'"' };
        foreach (var b in bytes)
        {
            if (b == '"' || b == '\\') o.AddRange([(byte)'\\', b]);
            else if (b < 0x20) o.AddRange(Encoding.ASCII.GetBytes("\\u" + b.ToString("x4", CultureInfo.InvariantCulture)));
            else o.Add(b);
        }
        o.Add((byte)'"');
        return Encoding.UTF8.GetString(o.ToArray());
    }

    private static string RenderTable(SgTable t)
    {
        if (t.Count == 0) return "[]";
        if (t.IsSequence(out _)) return "[" + string.Join(",", t.SequenceValues().Select(Render)) + "]";
        var ints = t.Entries.Where(e => e.Key.Kind == SgKind.Integer).OrderBy(e => e.Key.AsInteger()).Select(e => Render(e.Key) + "=" + Render(e.Value));
        var strs = t.Entries.Where(e => e.Key.Kind == SgKind.String).OrderBy(e => e.Key.AsText(), StringComparer.Ordinal).Select(e => Render(e.Key) + "=" + Render(e.Value));
        return "{" + string.Join(",", ints.Concat(strs)) + "}";
    }

    private const string Module = """
        {
          "name": "vec",
          "global": true,
          "functions": [
            { "name": "take", "params": [{ "name": "name", "type": "string" }, { "name": "value", "type": "any" }] },
            { "name": "give", "params": [{ "name": "from", "type": "string" }, { "name": "name", "type": "string" }], "returns": "any" },
            { "name": "back", "params": [{ "name": "from", "type": "string" }, { "name": "name", "type": "string" }, { "name": "value", "type": "any" }] }
          ]
        }
        """;

    private static string LuaString(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    [TestMethod]
    public void EveryVectorCrossesTheCodecAsSpecified()
    {
        var cases = LoadCases();
        Assert.IsTrue(cases.Count >= 40, "codec.json has too few cases");
        var luaVersion = KitInfo.Lua.Replace("Lua ", "", StringComparison.Ordinal);
        bool RunsInLua(Case c) => c.Lua is not null && c.Guest && (c.LuaVersions is null || c.LuaVersions.Contains(luaVersion));

        var taken = new Dictionary<(string Lang, string Name), SgValue>();
        var crossed = new Dictionary<(string Reader, string From, string Name), SgValue>();
        var vec = NativeModule.FromJson(Module);
        vec.Bind("take", c => { taken[(c.Language, c.Arg(0).AsText())] = c.Arg(1); return []; });
        vec.Bind("give", c => [taken.TryGetValue((c.Arg(0).AsText(), c.Arg(1).AsText()), out var v) ? v : SgValue.Nil]);
        vec.Bind("back", c => { crossed[(c.Language, c.Arg(0).AsText(), c.Arg(1).AsText())] = c.Arg(2); return []; });

        using var sb = new Sandbox();
        sb.Host.RegisterNativeModule(vec);

        // 1. Each language hands every expression to vec.take.
        var lua = new StringBuilder("""
            local function try(name, f)
                local ok, v = pcall(f)
                if not ok then print("VEC\tthrew\t" .. name .. "\t" .. tostring(v)) return end
                local r, code, detail = vec.take(name, v)
                if r == nil then print("VEC\trefused\t" .. name .. "\t" .. tostring(code) .. "\t" .. tostring(detail)) end
            end

            """);
        foreach (var c in cases.Where(RunsInLua)) lua.Append($"try({LuaString(c.Name)}, function() return {c.Lua} end)\n");
        var js = new StringBuilder("""
            const tryCase = (name, f) => {
              let v;
              try { v = f(); } catch (e) { print('VEC', 'threw', name, String(e)); return; }
              try { vec.take(name, v); } catch (e) { print('VEC', 'refused', name, e.code, e.detail); }
            };

            """);
        foreach (var c in cases.Where(c => c.Js is not null && c.Guest)) js.Append($"tryCase({JsonSerializer.Serialize(c.Name)}, () => ({c.Js}));\n");
        sb.Server("vec_lua", ("server/main.lua", lua.ToString()));
        sb.Server("vec_js", ("server/main.js", js.ToString()));
        sb.Start("vec_lua", "vec_js");

        // 2. Every accepted value crosses again into each language, which hands it back.
        var accepted = taken.Keys.Select(k => (k.Lang, k.Name)).OrderBy(k => k.Lang).ThenBy(k => k.Name).ToList();
        var luaBack = new StringBuilder();
        var jsBack = new StringBuilder();
        foreach (var (from, name) in accepted)
        {
            luaBack.Append($"vec.back({LuaString(from)}, {LuaString(name)}, vec.give({LuaString(from)}, {LuaString(name)}))\n");
            jsBack.Append($"vec.back({JsonSerializer.Serialize(from)}, {JsonSerializer.Serialize(name)}, vec.give({JsonSerializer.Serialize(from)}, {JsonSerializer.Serialize(name)}));\n");
        }
        sb.Server("vec_lua_back", ("server/main.lua", luaBack.ToString()));
        sb.Server("vec_js_back", ("server/main.js", jsBack.ToString()));
        sb.Start("vec_lua_back", "vec_js_back");

        var printed = sb.Printed;
        var failures = new List<string>();
        var checkedCount = 0;
        foreach (var c in cases)
        {
            foreach (var lang in new[] { "lua", "js" })
            {
                if (lang == "lua" ? !RunsInLua(c) : c.Js is null || !c.Guest) continue;
                checkedCount++;
                var key = (lang, c.Name);
                if (c.Error is not null)
                {
                    var want = $"VEC\trefused\t{c.Name}\tnative_arguments_not_serializable\t{c.Error}";
                    if (taken.ContainsKey(key)) failures.Add($"{lang} {c.Name}: accepted, expected refusal '{c.Error}'");
                    else if (!printed.Contains(want)) failures.Add($"{lang} {c.Name}: expected '{want}', got {string.Join(" | ", printed.Where(p => p.Contains("\t" + c.Name + "\t", StringComparison.Ordinal)))}");
                    continue;
                }
                if (!taken.TryGetValue(key, out var value))
                {
                    failures.Add($"{lang} {c.Name}: refused: {string.Join(" | ", printed.Where(p => p.Contains("\t" + c.Name + "\t", StringComparison.Ordinal)))}");
                    continue;
                }
                var rendered = Render(value);
                if (c.Typed is not null && rendered != c.Typed) failures.Add($"{lang} {c.Name}: got {rendered}, expected {c.Typed}");
                foreach (var reader in new[] { "lua", "js" })
                {
                    if (!crossed.TryGetValue((reader, lang, c.Name), out var back)) { failures.Add($"{lang}->{reader} {c.Name}: never came back"); continue; }
                    var expected = lang == "lua" && reader == "js" && c.ViaJs is not null ? c.ViaJs : c.Typed ?? rendered;
                    var got = Render(back);
                    if (got != expected) failures.Add($"{lang}->{reader} {c.Name}: got {Shorten(got)}, expected {Shorten(expected)}");
                }
            }
        }
        Assert.IsTrue(checkedCount >= 80, $"only {checkedCount} language cases ran");
        Assert.AreEqual(0, failures.Count, string.Join("\n", failures) + "\n--- log ---\n" + Shorten(sb.Log.ToString(), 4000));
    }

    private static string Shorten(string s, int max = 200) => s.Length <= max ? s : s[..max] + $"... ({s.Length} chars)";
}
