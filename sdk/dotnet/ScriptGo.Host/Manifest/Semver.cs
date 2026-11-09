// Minimal semantic versioning, the same rules as packages/manifest/src/semver.ts and
// sdk/lua/scriptgo/semver.lua: parse, compare, ranges ("^1.2.0", ">=0.1.0 <2.0.0", "1.x || 2.x").
using System.Globalization;
using System.Text.RegularExpressions;

namespace ScriptGo.Host.Manifest;

public static partial class Semver
{
    private sealed record Version(long Major, long Minor, long Patch, object[] Prerelease);

    private enum Op { Ge, Gt, Le, Lt, Eq }

    private readonly record struct Comparator(Op Op, Version V);

    [GeneratedRegex(@"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")]
    private static partial Regex SemverPattern();

    [GeneratedRegex(@"^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$")]
    private static partial Regex PartialPattern();

    [GeneratedRegex(@"^(>=|<=|>|<|=|\^|~)?(.+)$")]
    private static partial Regex ComparatorPattern();

    [GeneratedRegex(@"(>=|<=|>|<|=|\^|~)\s+")]
    private static partial Regex OperatorSpace();

    private static Version? Parse(string v)
    {
        var m = SemverPattern().Match(v.Trim());
        if (!m.Success) return null;
        var pre = m.Groups[4].Success
            ? m.Groups[4].Value.Split('.').Select(p => p.All(char.IsAsciiDigit) ? (object)long.Parse(p, CultureInfo.InvariantCulture) : p).ToArray()
            : [];
        return new Version(long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture), long.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture),
            long.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture), pre);
    }

    public static bool IsValid(string v) => Parse(v) is not null;

    private static int Compare(Version a, Version b)
    {
        if (a.Major != b.Major) return a.Major < b.Major ? -1 : 1;
        if (a.Minor != b.Minor) return a.Minor < b.Minor ? -1 : 1;
        if (a.Patch != b.Patch) return a.Patch < b.Patch ? -1 : 1;
        if (a.Prerelease.Length == 0 || b.Prerelease.Length == 0) return b.Prerelease.Length - a.Prerelease.Length;
        for (var i = 0; i < Math.Max(a.Prerelease.Length, b.Prerelease.Length); i++)
        {
            if (i >= a.Prerelease.Length) return -1;
            if (i >= b.Prerelease.Length) return 1;
            var x = a.Prerelease[i];
            var y = b.Prerelease[i];
            if (x.Equals(y)) continue;
            if (x is long xn && y is long yn) return xn < yn ? -1 : 1;
            if (x is long) return -1;
            if (y is long) return 1;
            return string.CompareOrdinal((string)x, (string)y) < 0 ? -1 : 1;
        }
        return 0;
    }

    public static int CompareVersions(string a, string b)
    {
        var x = Parse(a) ?? throw new ArgumentException($"Invalid version: {a}");
        var y = Parse(b) ?? throw new ArgumentException($"Invalid version: {b}");
        return Compare(x, y);
    }

    private static Version Sv(long major, long minor = 0, long patch = 0) => new(major, minor, patch, []);

    private static (List<long> Parts, Version? Full)? Partial(string text)
    {
        var t = text.StartsWith('v') ? text[1..] : text;
        var full = Parse(t);
        if (full is not null) return ([full.Major, full.Minor, full.Patch], full);
        var m = PartialPattern().Match(t);
        if (!m.Success) return null;
        var parts = new List<long>();
        foreach (var g in new[] { m.Groups[1], m.Groups[2], m.Groups[3] })
        {
            if (!g.Success || g.Value is "x" or "X" or "*") break;
            parts.Add(long.Parse(g.Value, CultureInfo.InvariantCulture));
        }
        return (parts, null);
    }

    private static List<Comparator>? Comparators(string token)
    {
        if (token is "*" or "x" or "X") return [];
        var m = ComparatorPattern().Match(token);
        if (!m.Success) return null;
        var op = m.Groups[1].Success ? m.Groups[1].Value : "";
        var p = Partial(m.Groups[2].Value);
        if (p is null) return null;
        var parts = p.Value.Parts;
        long? maj = parts.Count > 0 ? parts[0] : null, min = parts.Count > 1 ? parts[1] : null, pat = parts.Count > 2 ? parts[2] : null;
        var lower = p.Value.Full ?? Sv(maj ?? 0, min ?? 0, pat ?? 0);
        if (op == "^")
        {
            if (maj is null) return [];
            Version upper = maj > 0 || min is null ? Sv(maj.Value + 1)
                : min > 0 || pat is null ? Sv(0, min.Value + 1)
                : Sv(0, 0, pat.Value + 1);
            return [new(Op.Ge, lower), new(Op.Lt, upper)];
        }
        if (op == "~")
        {
            if (maj is null) return [];
            var upper = min is null ? Sv(maj.Value + 1) : Sv(maj.Value, min.Value + 1);
            return [new(Op.Ge, lower), new(Op.Lt, upper)];
        }
        if (op is "" or "=")
        {
            if (p.Value.Full is not null) return [new(Op.Eq, p.Value.Full)];
            if (maj is null) return [];
            var upper = min is null ? Sv(maj.Value + 1) : pat is null ? Sv(maj.Value, min.Value + 1) : Sv(maj.Value, min.Value, pat.Value + 1);
            return [new(Op.Ge, lower), new(Op.Lt, upper)];
        }
        if (maj is null) return null;
        return [new(op switch { ">=" => Op.Ge, ">" => Op.Gt, "<=" => Op.Le, _ => Op.Lt }, lower)];
    }

    private static List<List<Comparator>>? ParseRange(string range)
    {
        var sets = new List<List<Comparator>>();
        foreach (var alt in range.Split("||"))
        {
            var tokens = OperatorSpace().Replace(alt.Trim(), "$1").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            var set = new List<Comparator>();
            foreach (var tok in tokens)
            {
                var c = Comparators(tok);
                if (c is null) return null;
                set.AddRange(c);
            }
            sets.Add(set);
        }
        return sets;
    }

    public static bool IsValidRange(string range) => range.Trim().Length > 0 && ParseRange(range) is not null;

    public static bool Satisfies(string version, string range)
    {
        var v = Parse(version);
        var sets = ParseRange(range);
        if (v is null || sets is null) return false;
        return sets.Any(set => set.All(c =>
        {
            var r = Compare(v, c.V);
            return c.Op switch { Op.Ge => r >= 0, Op.Gt => r > 0, Op.Le => r <= 0, Op.Lt => r < 0, _ => r == 0 };
        }));
    }
}
