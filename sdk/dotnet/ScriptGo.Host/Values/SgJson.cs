// JSON for codec values (storage files, config, HTTP bodies). Same shape as the Lua core's
// json.lua: sequences and empty tables encode as arrays, other tables as objects with sorted keys.
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace ScriptGo.Host;

public static class SgJson
{
    private static readonly JsonWriterOptions WriterOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, Indented = false };

    public static string Encode(SgValue value)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, WriterOptions)) Write(writer, value, 0);
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    /// <summary>Encodes entries as a JSON object (sorted keys), even when empty: storage documents.</summary>
    public static string EncodeObject(IEnumerable<KeyValuePair<string, SgValue>> entries)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, WriterOptions))
        {
            writer.WriteStartObject();
            foreach (var e in entries.Where(e => !e.Value.IsNil).OrderBy(e => e.Key, StringComparer.Ordinal))
            {
                writer.WritePropertyName(e.Key);
                Write(writer, e.Value, 1);
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void Write(Utf8JsonWriter w, SgValue v, int depth)
    {
        if (depth > SgValue.MaxDepth) throw new CodecException($"codec: value nested deeper than {SgValue.MaxDepth}");
        switch (v.Kind)
        {
            case SgKind.Nil: w.WriteNullValue(); break;
            case SgKind.Boolean: w.WriteBooleanValue(v.AsBoolean()); break;
            case SgKind.Integer: w.WriteNumberValue(v.AsInteger()); break;
            case SgKind.Number: w.WriteNumberValue(v.AsDouble()); break;
            case SgKind.String: w.WriteStringValue(v.AsText()); break;
            default:
                var t = v.AsTable();
                if (t.Count == 0 || t.IsSequence(out _))
                {
                    w.WriteStartArray();
                    foreach (var item in t.Count == 0 ? [] : t.SequenceValues()) Write(w, item, depth + 1);
                    w.WriteEndArray();
                }
                else
                {
                    w.WriteStartObject();
                    foreach (var e in t.Entries.OrderBy(e => KeyText(e.Key), StringComparer.Ordinal))
                    {
                        w.WritePropertyName(KeyText(e.Key));
                        Write(w, e.Value, depth + 1);
                    }
                    w.WriteEndObject();
                }
                break;
        }
    }

    private static string KeyText(SgValue key) => key.Kind == SgKind.Integer ? key.AsInteger().ToString(CultureInfo.InvariantCulture) : key.AsText();

    /// <summary>Decodes JSON text; throws <see cref="CodecException"/> on invalid input.</summary>
    public static SgValue Decode(string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = SgValue.MaxDepth + 1 });
            return Read(doc.RootElement);
        }
        catch (JsonException e) { throw new CodecException("json: " + e.Message.Split('\n')[0]); }
    }

    public static SgValue Read(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => SgValue.Nil,
        JsonValueKind.True => SgValue.True,
        JsonValueKind.False => SgValue.False,
        JsonValueKind.String => SgValue.Of(e.GetString()),
        JsonValueKind.Number => ReadNumber(e),
        JsonValueKind.Array => SgValue.Of(SgTable.FromList(e.EnumerateArray().Select(Read).ToList())),
        _ => SgValue.Of(SgTable.FromPairs(e.EnumerateObject().Select(p => (SgValue.Of(p.Name), Read(p.Value))))),
    };

    private static SgValue ReadNumber(JsonElement e)
    {
        var raw = e.GetRawText();
        if (raw.IndexOfAny(['.', 'e', 'E']) < 0 && e.TryGetInt64(out var i)) return SgValue.Of(i);
        return SgValue.Of(e.GetDouble());
    }
}
