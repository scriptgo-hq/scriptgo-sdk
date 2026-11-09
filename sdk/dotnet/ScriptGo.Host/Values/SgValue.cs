// The value codec's data model. Every value that crosses a boundary (an event, an export call, a
// native call, storage) is copied into an SgValue and copied out again: guests never share objects.
// Rules (docs/spec/multi-language.md, "Value codec"): nil, booleans, integers, finite numbers,
// strings (bytes; text as UTF-8) and acyclic tables with string or integer keys, depth <= 32,
// encoded size <= 1 MiB.
using System.Globalization;
using System.Text;

namespace ScriptGo.Host;

public enum SgKind { Nil, Boolean, Integer, Number, String, Table }

/// <summary>An immutable transferable value.</summary>
public sealed class SgValue : IEquatable<SgValue>
{
    public const int MaxDepth = 32;
    public const int MaxBytes = 1024 * 1024;
    /// <summary>Integers beyond this magnitude reach JavaScript as the nearest double.</summary>
    public const long MaxSafeInteger = 9007199254740991;

    public static readonly SgValue Nil = new(SgKind.Nil);
    public static readonly SgValue True = new(SgKind.Boolean) { _bool = true };
    public static readonly SgValue False = new(SgKind.Boolean) { _bool = false };

    private bool _bool;
    private long _int;
    private double _number;
    private byte[]? _bytes;
    private string? _text;
    private SgTable? _table;

    private SgValue(SgKind kind) { Kind = kind; }

    public SgKind Kind { get; }
    public bool IsNil => Kind == SgKind.Nil;

    public static SgValue Of(bool b) => b ? True : False;
    public static SgValue Of(long i) => new(SgKind.Integer) { _int = i };
    public static SgValue Of(int i) => Of((long)i);

    /// <summary>A float. Non-finite numbers are refused (<see cref="CodecException"/>).</summary>
    public static SgValue Of(double d)
    {
        if (!double.IsFinite(d)) throw new CodecException("codec: non-finite number");
        return new(SgKind.Number) { _number = d };
    }

    public static SgValue Of(string? s) => s is null ? Nil : new(SgKind.String) { _text = s };
    public static SgValue OfBytes(byte[] bytes) => new(SgKind.String) { _bytes = bytes };
    public static SgValue Of(SgTable t) => new(SgKind.Table) { _table = t };

    /// <summary>A number from JavaScript: integral values within ±2^53 become integers.</summary>
    public static SgValue FromJsNumber(double d)
    {
        if (!double.IsFinite(d)) throw new CodecException("codec: non-finite number");
        if (Math.Floor(d) == d && Math.Abs(d) <= MaxSafeInteger) return Of((long)d);
        return Of(d);
    }

    public bool AsBoolean() => Kind == SgKind.Boolean ? _bool : throw new InvalidOperationException("not a boolean");
    public long AsInteger() => Kind == SgKind.Integer ? _int : Kind == SgKind.Number && Math.Floor(_number) == _number ? (long)_number : throw new InvalidOperationException("not an integer");
    public double AsDouble() => Kind switch { SgKind.Integer => _int, SgKind.Number => _number, _ => throw new InvalidOperationException("not a number") };
    public bool IsNumber => Kind is SgKind.Integer or SgKind.Number;
    public SgTable AsTable() => _table ?? throw new InvalidOperationException("not a table");

    /// <summary>The string's bytes (UTF-8 for text that came from JavaScript or .NET).</summary>
    public byte[] AsBytes()
    {
        if (Kind != SgKind.String) throw new InvalidOperationException("not a string");
        return _bytes ??= Encoding.UTF8.GetBytes(_text!);
    }

    /// <summary>The string as text: UTF-8, invalid sequences replaced by U+FFFD.</summary>
    public string AsText()
    {
        if (Kind != SgKind.String) throw new InvalidOperationException("not a string");
        return _text ??= Encoding.UTF8.GetString(_bytes!);
    }

    /// <summary>Text, or null when this is not a string.</summary>
    public string? TextOrNull => Kind == SgKind.String ? AsText() : null;

    public string TypeName => Kind switch
    {
        SgKind.Nil => "nil", SgKind.Boolean => "boolean", SgKind.Integer => "integer", SgKind.Number => "number",
        SgKind.String => "string", _ => "table",
    };

    public override string ToString() => Kind switch
    {
        SgKind.Nil => "nil",
        SgKind.Boolean => _bool ? "true" : "false",
        SgKind.Integer => _int.ToString(CultureInfo.InvariantCulture),
        SgKind.Number => _number.ToString("R", CultureInfo.InvariantCulture),
        SgKind.String => AsText(),
        _ => SgJson.Encode(this),
    };

    public bool Equals(SgValue? other)
    {
        if (other is null) return false;
        if (ReferenceEquals(this, other)) return true;
        if (Kind != other.Kind) return false;
        return Kind switch
        {
            SgKind.Nil => true,
            SgKind.Boolean => _bool == other._bool,
            SgKind.Integer => _int == other._int,
            SgKind.Number => _number.Equals(other._number),
            SgKind.String => AsBytes().AsSpan().SequenceEqual(other.AsBytes()),
            _ => _table!.ContentEquals(other._table!),
        };
    }

    public override bool Equals(object? obj) => obj is SgValue v && Equals(v);

    public override int GetHashCode() => Kind switch
    {
        SgKind.Boolean => _bool.GetHashCode(),
        SgKind.Integer => _int.GetHashCode(),
        SgKind.Number => _number.GetHashCode(),
        SgKind.String => AsText().GetHashCode(StringComparison.Ordinal),
        SgKind.Table => _table!.Count,
        _ => 0,
    };

    /// <summary>Converts plain .NET values (bool, numbers, string, lists, dictionaries) for integrators.</summary>
    public static SgValue From(object? value) => value switch
    {
        null => Nil,
        SgValue v => v,
        bool b => Of(b),
        int i => Of(i),
        long l => Of(l),
        float f => Of((double)f),
        double d => Of(d),
        string s => Of(s),
        byte[] bytes => OfBytes(bytes),
        SgTable t => Of(t),
        IDictionary<string, object?> dict => Of(SgTable.FromPairs(dict.Select(kv => (Of(kv.Key), From(kv.Value))))),
        System.Collections.IEnumerable e => Of(SgTable.FromList(e.Cast<object?>().Select(From))),
        _ => throw new CodecException($"codec: cannot transfer a {value.GetType().Name}"),
    };
}

/// <summary>A table: ordered entries with string or integer keys and non-nil values.</summary>
public sealed class SgTable
{
    private readonly List<KeyValuePair<SgValue, SgValue>> _entries = [];

    public IReadOnlyList<KeyValuePair<SgValue, SgValue>> Entries => _entries;
    public int Count => _entries.Count;

    public static SgTable FromList(IEnumerable<SgValue> values)
    {
        var t = new SgTable();
        long i = 1;
        foreach (var v in values)
        {
            if (!v.IsNil) t._entries.Add(new(SgValue.Of(i), v));
            i++;
        }
        return t;
    }

    public static SgTable FromPairs(IEnumerable<(SgValue Key, SgValue Value)> pairs)
    {
        var t = new SgTable();
        foreach (var (k, v) in pairs) t.Add(k, v);
        return t;
    }

    /// <summary>Adds an entry. Keys must be strings or integers; nil values are skipped.</summary>
    public SgTable Add(SgValue key, SgValue value)
    {
        if (key.Kind is not (SgKind.String or SgKind.Integer)) throw new CodecException("codec: table keys must be strings or integers");
        if (!value.IsNil) _entries.Add(new(key, value));
        return this;
    }

    public SgTable Add(string key, SgValue value) => Add(SgValue.Of(key), value);
    public SgTable Add(string key, object? value) => Add(SgValue.Of(key), SgValue.From(value));

    public SgValue Get(string key)
    {
        foreach (var e in _entries) if (e.Key.Kind == SgKind.String && e.Key.AsText() == key) return e.Value;
        return SgValue.Nil;
    }

    public SgValue Get(long index)
    {
        foreach (var e in _entries) if (e.Key.Kind == SgKind.Integer && e.Key.AsInteger() == index) return e.Value;
        return SgValue.Nil;
    }

    /// <summary>True when the keys are exactly the integers 1..n (n >= 1): an array in JavaScript.</summary>
    public bool IsSequence(out int length)
    {
        length = _entries.Count;
        if (length == 0) return false;
        var seen = new bool[length + 1];
        foreach (var e in _entries)
        {
            if (e.Key.Kind != SgKind.Integer) return false;
            var k = e.Key.AsInteger();
            if (k < 1 || k > length || seen[k]) return false;
            seen[k] = true;
        }
        return true;
    }

    /// <summary>The values in key order 1..n; call only when <see cref="IsSequence"/> is true.</summary>
    public SgValue[] SequenceValues()
    {
        IsSequence(out var n);
        var arr = new SgValue[n];
        foreach (var e in _entries) arr[e.Key.AsInteger() - 1] = e.Value;
        return arr;
    }

    internal bool ContentEquals(SgTable other)
    {
        if (Count != other.Count) return false;
        foreach (var e in _entries)
        {
            var found = false;
            foreach (var o in other._entries)
            {
                if (e.Key.Equals(o.Key)) { found = e.Value.Equals(o.Value); break; }
            }
            if (!found) return false;
        }
        return true;
    }
}

/// <summary>A value was refused by the codec; the message is the reason ("codec: ...").</summary>
public sealed class CodecException(string message) : Exception(message);

/// <summary>Counts depth and encoded size while a guest value is read, as the Lua core's codec does.</summary>
internal sealed class CodecBudget
{
    private long _bytes;

    public void Charge(long bytes)
    {
        _bytes += bytes;
        if (_bytes > SgValue.MaxBytes) throw new CodecException("codec: value exceeds 1 MiB");
    }

    public static void CheckDepth(int depth)
    {
        if (depth >= SgValue.MaxDepth) throw new CodecException($"codec: value nested deeper than {SgValue.MaxDepth}");
    }
}
