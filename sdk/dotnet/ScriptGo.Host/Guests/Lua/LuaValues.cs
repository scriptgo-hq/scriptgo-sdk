// Copies values between a Lua stack and the codec model. Reads are raw (no metamethods run) and
// enforce the codec rules: string or integer keys, finite numbers, no functions, userdata or
// threads, depth below 32, at most 1 MiB, no cycles. Lua strings stay bytes.
using KeraLua;

namespace ScriptGo.Host;

internal static class LuaValues
{
    public static SgValue[] ReadRange(Lua l, int from, int to)
    {
        if (to < from) return [];
        var budget = new CodecBudget();
        var values = new SgValue[to - from + 1];
        for (var i = from; i <= to; i++) values[i - from] = Read(l, i, 0, budget, null);
        return values;
    }

    public static SgValue Read(Lua l, int index) => Read(l, l.AbsIndex(index), 0, new CodecBudget(), null);

    private static SgValue Read(Lua l, int index, int depth, CodecBudget budget, HashSet<IntPtr>? seen)
    {
        switch (l.Type(index))
        {
            case LuaType.None:
            case LuaType.Nil:
                return SgValue.Nil;
            case LuaType.Boolean:
                return SgValue.Of(l.ToBoolean(index));
            case LuaType.Number:
                budget.Charge(8);
                if (l.IsInteger(index)) return SgValue.Of(l.ToInteger(index));
                return SgValue.Of(l.ToNumber(index)); // non-finite numbers throw CodecException
            case LuaType.String:
            {
                var bytes = l.ToBuffer(index, false) ?? [];
                budget.Charge(bytes.Length);
                return SgValue.OfBytes(bytes);
            }
            case LuaType.Table:
            {
                CodecBudget.CheckDepth(depth);
                seen ??= [];
                var ptr = l.ToPointer(index);
                if (!seen.Add(ptr)) throw new CodecException("codec: cyclic table");
                if (!l.CheckStack(4)) throw new CodecException("codec: value nested too deeply");
                var table = new SgTable();
                l.PushNil();
                while (l.Next(index))
                {
                    var keyIndex = l.GetTop() - 1;
                    var valueIndex = l.GetTop();
                    SgValue key;
                    switch (l.Type(keyIndex))
                    {
                        case LuaType.Number when l.IsInteger(keyIndex):
                            key = SgValue.Of(l.ToInteger(keyIndex));
                            break;
                        case LuaType.String:
                            // lua_tolstring on a key would confuse lua_next; strings are safe to read raw.
                            key = SgValue.OfBytes(l.ToBuffer(keyIndex, false) ?? []);
                            break;
                        default:
                            throw new CodecException("codec: table keys must be strings or integers");
                    }
                    budget.Charge(8);
                    var value = Read(l, valueIndex, depth + 1, budget, seen);
                    table.Add(key, value);
                    l.Pop(1);
                }
                seen.Remove(ptr);
                return SgValue.Of(table);
            }
            case LuaType.Function:
                throw new CodecException("codec: cannot transfer a function");
            case LuaType.Thread:
                throw new CodecException("codec: cannot transfer a thread");
            default:
                throw new CodecException("codec: cannot transfer a userdata");
        }
    }

    /// <summary>Pushes a value. The caller has checked the stack for one slot; tables check their own.</summary>
    public static void Push(Lua l, SgValue v)
    {
        switch (v.Kind)
        {
            case SgKind.Nil: l.PushNil(); break;
            case SgKind.Boolean: l.PushBoolean(v.AsBoolean()); break;
            case SgKind.Integer: l.PushInteger(v.AsInteger()); break;
            case SgKind.Number: l.PushNumber(v.AsDouble()); break;
            case SgKind.String: l.PushBuffer(v.AsBytes()); break;
            default:
            {
                var t = v.AsTable();
                if (!l.CheckStack(3)) throw new CodecException("codec: value nested too deeply");
                var isSeq = t.IsSequence(out var n);
                l.CreateTable(isSeq ? n : 0, isSeq ? 0 : t.Count);
                foreach (var e in t.Entries)
                {
                    Push(l, e.Key);
                    Push(l, e.Value);
                    l.RawSet(-3);
                }
                break;
            }
        }
    }
}
