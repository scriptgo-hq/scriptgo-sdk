// Copies values between Jint and the codec model. JavaScript side of the codec rules
// (docs/spec/multi-language.md): undefined and null are nil; integral numbers within ±2^53 are
// integers; arrays are sequences (1-based); plain objects are tables, and their keys that are
// canonical integers ("1", "-2") become integer keys; functions, symbols, bigints, class
// instances, Map, Date, Promise and proxies are refused. Only own data properties are read, so no
// script code runs during a copy. Tables become arrays when they are sequences (and when empty),
// objects otherwise (integer keys as decimal strings).
using System.Globalization;
using System.Text;
using Jint;
using Jint.Native;
using Jint.Native.Array;
using Jint.Native.Object;
using Jint.Runtime;

namespace ScriptGo.Host;

internal static class JsValues
{
    public static SgValue[] ReadRange(Engine engine, JsValue[] args, int from)
    {
        if (from >= args.Length) return [];
        var budget = new CodecBudget();
        var values = new SgValue[args.Length - from];
        for (var i = from; i < args.Length; i++) values[i - from] = Read(engine, args[i], 0, budget, null);
        return values;
    }

    public static SgValue Read(Engine engine, JsValue v) => Read(engine, v, 0, new CodecBudget(), null);

    private static SgValue Read(Engine engine, JsValue v, int depth, CodecBudget budget, HashSet<ObjectInstance>? seen)
    {
        switch (v.Type)
        {
            case Types.Undefined:
            case Types.Null:
            case Types.Empty:
                return SgValue.Nil;
            case Types.Boolean:
                return SgValue.Of(v.AsBoolean());
            case Types.Number:
                budget.Charge(8);
                return SgValue.FromJsNumber(v.AsNumber());
            case Types.String:
            {
                var s = v.AsString();
                budget.Charge(Encoding.UTF8.GetByteCount(s));
                return SgValue.Of(s);
            }
            case Types.Symbol:
                throw new CodecException("codec: cannot transfer a symbol");
            case Types.BigInt:
                throw new CodecException("codec: cannot transfer a bigint");
        }
        var obj = v.AsObject();
        if (v.IsCallable()) throw new CodecException("codec: cannot transfer a function");
        CodecBudget.CheckDepth(depth);
        seen ??= new HashSet<ObjectInstance>(ReferenceEqualityComparer.Instance);
        if (!seen.Add(obj)) throw new CodecException("codec: cyclic table");
        try
        {
            if (obj is ArrayInstance array && obj.GetType().Name != "JsProxy")
            {
                var length = (long)array.GetOwnProperty(new JsString("length")).Value.AsNumber();
                var items = new List<SgValue>((int)Math.Min(length, 4096));
                for (long i = 0; i < length; i++)
                {
                    var desc = array.GetOwnProperty(JsNumber.Create(i));
                    if (desc == Jint.Runtime.Descriptors.PropertyDescriptor.Undefined) { items.Add(SgValue.Nil); continue; }
                    if (!desc.IsDataDescriptor()) throw new CodecException("codec: cannot transfer an accessor property");
                    items.Add(Read(engine, desc.Value, depth + 1, budget, seen));
                    budget.Charge(8);
                }
                return SgValue.Of(SgTable.FromList(items));
            }
            if (!IsPlain(engine, obj)) throw new CodecException("codec: cannot transfer a " + KindOf(obj));
            var table = new SgTable();
            foreach (var (key, desc) in obj.GetOwnProperties())
            {
                if (key.IsSymbol() || !desc.Enumerable) continue;
                if (!desc.IsDataDescriptor()) throw new CodecException("codec: cannot transfer an accessor property");
                var value = Read(engine, desc.Value, depth + 1, budget, seen);
                if (value.IsNil) continue;
                var name = key.ToString();
                budget.Charge(8);
                table.Add(CanonicalInteger(name) is { } n ? SgValue.Of(n) : SgValue.Of(name), value);
            }
            return SgValue.Of(table);
        }
        finally
        {
            seen.Remove(obj);
        }
    }

    // Object literals and Object.create(null) are JsObject; proxies are checked by type before any
    // trap could run.
    private static bool IsPlain(Engine engine, ObjectInstance obj)
    {
        if (obj.GetType() != typeof(JsObject)) return false;
        var proto = obj.Prototype;
        return proto is null || ReferenceEquals(proto, engine.Intrinsics.Object.PrototypeObject);
    }

    private static string KindOf(ObjectInstance obj)
    {
        var name = obj.GetType().Name;
        if (name == nameof(JsObject)) return "class instance";
        return name.StartsWith("Js", StringComparison.Ordinal) ? name[2..] : name;
    }

    /// <summary>"0", "17", "-3" (no leading zeros, within ±2^53) → the integer; anything else → null.</summary>
    internal static long? CanonicalInteger(string s)
    {
        if (s.Length == 0 || s.Length > 17) return null;
        if (!long.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n)) return null;
        if (Math.Abs(n) > SgValue.MaxSafeInteger) return null;
        return n.ToString(CultureInfo.InvariantCulture) == s ? n : null;
    }

    public static JsValue Write(Engine engine, SgValue v)
    {
        switch (v.Kind)
        {
            case SgKind.Nil: return JsValue.Undefined;
            case SgKind.Boolean: return v.AsBoolean() ? JsBoolean.True : JsBoolean.False;
            case SgKind.Integer: return JsNumber.Create((double)v.AsInteger());
            case SgKind.Number: return JsNumber.Create(v.AsDouble());
            case SgKind.String: return new JsString(v.AsText());
        }
        var t = v.AsTable();
        if (t.Count == 0) return new JsArray(engine);
        if (t.IsSequence(out _)) return new JsArray(engine, t.SequenceValues().Select(x => Write(engine, x)).ToArray());
        // Lua tables have no key order; writing keys sorted (integers ascending, then strings
        // ordinal) gives JavaScript a deterministic property order.
        var obj = new JsObject(engine);
        foreach (var e in t.Entries.OrderBy(e => e.Key.Kind == SgKind.Integer ? 0 : 1)
                     .ThenBy(e => e.Key.Kind == SgKind.Integer ? e.Key.AsInteger() : 0)
                     .ThenBy(e => e.Key.Kind == SgKind.Integer ? "" : e.Key.AsText(), StringComparer.Ordinal))
        {
            var key = e.Key.Kind == SgKind.Integer ? e.Key.AsInteger().ToString(CultureInfo.InvariantCulture) : e.Key.AsText();
            obj.CreateDataProperty(new JsString(key), Write(engine, e.Value));
        }
        return obj;
    }

    public static JsValue[] WriteAll(Engine engine, IEnumerable<SgValue> values) => values.Select(v => Write(engine, v)).ToArray();
}
