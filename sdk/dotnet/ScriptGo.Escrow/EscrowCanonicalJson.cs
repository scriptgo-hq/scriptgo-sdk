using System.Globalization;
using System.Text;
using System.Text.Json;

namespace ScriptGo.Escrow;

/// <summary>
/// The bytes an escrow manifest's Ed25519 signature covers: what JavaScript's
/// <c>JSON.stringify</c> yields for the manifest once its object keys have been
/// sorted at every level and its top-level <c>signature</c> replaced by <c>""</c>.
///
/// <para>The packer that signs a release is JavaScript, so "canonical" here means
/// "byte for byte what that runtime writes", not a JSON canonicalisation standard.
/// Three places differ from what <see cref="Utf8JsonWriter"/> would emit, and each
/// is reproduced on purpose:</para>
/// <list type="bullet">
/// <item>strings escape only <c>"</c>, <c>\</c>, the control characters below U+0020
/// (short forms for \b \t \n \f \r, <c>\u00xx</c> in lowercase hex for the rest) and
/// lone surrogates; everything else, non-ASCII included, is written as is;</item>
/// <item>an object's keys that are array indices (<c>"0"</c>, <c>"12"</c>) come first,
/// in numeric order, whatever their sorted position: that is how a JavaScript object
/// enumerates, and the packer rebuilds an object from its sorted keys;</item>
/// <item>numbers are accepted only as plain safe integers, which JavaScript prints
/// exactly as written. The format has no other number; anything else is refused
/// rather than guessed at.</item>
/// </list>
/// <para>Nothing secret passes through here: the manifest is a clear file. Public so another
/// implementation can compare its own canonicaliser against this one.</para>
/// </summary>
public static class EscrowCanonicalJson
{
    private const long MaximumSafeInteger = 9007199254740991;

    /// <exception cref="InvalidDataException">The document is not an object, repeats a
    /// key, has no string <c>signature</c>, or contains a number this format never uses.</exception>
    public static byte[] ForSignature(ReadOnlyMemory<byte> utf8Manifest)
    {
        try
        {
            using var document = JsonDocument.Parse(utf8Manifest, new JsonDocumentOptions { MaxDepth = 32 });
            return ForSignature(document.RootElement);
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("escrow.json is not valid JSON: " + exception.Message, exception);
        }
    }

    public static byte[] ForSignature(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("escrow.json must be a JSON object.");
        if (!root.TryGetProperty("signature", out var signature) || signature.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("escrow.json has no signature.");
        var builder = new StringBuilder(2048);
        try
        {
            Write(builder, root, emptySignature: true);
        }
        catch (InvalidOperationException exception)
        {
            // System.Text.Json refuses to decode a string that is not valid UTF-16.
            throw new InvalidDataException("escrow.json contains a malformed string.", exception);
        }
        return Encoding.UTF8.GetBytes(builder.ToString());
    }

    private static void Write(StringBuilder builder, JsonElement element, bool emptySignature = false)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                WriteObject(builder, element, emptySignature);
                break;
            case JsonValueKind.Array:
                builder.Append('[');
                var first = true;
                foreach (var item in element.EnumerateArray())
                {
                    if (!first) builder.Append(',');
                    first = false;
                    Write(builder, item);
                }
                builder.Append(']');
                break;
            case JsonValueKind.String:
                WriteString(builder, element.GetString()!);
                break;
            case JsonValueKind.Number:
                WriteNumber(builder, element.GetRawText());
                break;
            case JsonValueKind.True:
                builder.Append("true");
                break;
            case JsonValueKind.False:
                builder.Append("false");
                break;
            case JsonValueKind.Null:
                builder.Append("null");
                break;
            default:
                throw new InvalidDataException("escrow.json contains an unsupported value.");
        }
    }

    private static void WriteObject(StringBuilder builder, JsonElement element, bool emptySignature)
    {
        var properties = new List<JsonProperty>();
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
        {
            if (!names.Add(property.Name))
                throw new InvalidDataException($"escrow.json repeats the key '{property.Name}'.");
            properties.Add(property);
        }
        properties.Sort(static (left, right) => CompareKeys(left.Name, right.Name));
        builder.Append('{');
        for (var index = 0; index < properties.Count; index++)
        {
            if (index > 0) builder.Append(',');
            WriteString(builder, properties[index].Name);
            builder.Append(':');
            if (emptySignature && properties[index].Name == "signature") builder.Append("\"\"");
            else Write(builder, properties[index].Value);
        }
        builder.Append('}');
    }

    // JavaScript property order: array-index keys ascending, then the rest in the
    // order they were inserted -- which for the packer is UTF-16 code unit order,
    // i.e. ordinal.
    private static int CompareKeys(string left, string right)
    {
        var leftIndex = ArrayIndex(left);
        var rightIndex = ArrayIndex(right);
        if (leftIndex >= 0 && rightIndex >= 0) return leftIndex.CompareTo(rightIndex);
        if (leftIndex >= 0) return -1;
        if (rightIndex >= 0) return 1;
        return string.CompareOrdinal(left, right);
    }

    // A canonical array index: "0", or digits with no leading zero, below 2^32 - 1.
    private static long ArrayIndex(string key)
    {
        if (key.Length is 0 or > 10 || (key.Length > 1 && key[0] == '0')) return -1;
        long value = 0;
        foreach (var character in key)
        {
            if (character is < '0' or > '9') return -1;
            value = value * 10 + (character - '0');
        }
        return value < 4294967295 ? value : -1;
    }

    private static void WriteNumber(StringBuilder builder, string raw)
    {
        var digits = raw.AsSpan(raw.StartsWith('-') ? 1 : 0);
        var plain = digits.Length is > 0 and <= 16 && (digits.Length == 1 || digits[0] != '0');
        foreach (var character in digits) plain &= character is >= '0' and <= '9';
        if (!plain || raw == "-0" ||
            !long.TryParse(raw, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var value) ||
            value is > MaximumSafeInteger or < -MaximumSafeInteger)
            throw new InvalidDataException("escrow.json contains a number that is not a plain integer.");
        builder.Append(raw);
    }

    private static void WriteString(StringBuilder builder, string value)
    {
        builder.Append('"');
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            switch (character)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\b': builder.Append("\\b"); break;
                case '\t': builder.Append("\\t"); break;
                case '\n': builder.Append("\\n"); break;
                case '\f': builder.Append("\\f"); break;
                case '\r': builder.Append("\\r"); break;
                default:
                    if (character < 0x20)
                    {
                        AppendEscape(builder, character);
                    }
                    else if (char.IsHighSurrogate(character) && index + 1 < value.Length &&
                             char.IsLowSurrogate(value[index + 1]))
                    {
                        builder.Append(character).Append(value[++index]);
                    }
                    else if (char.IsSurrogate(character))
                    {
                        // Well-formed JSON.stringify: a lone surrogate is escaped.
                        AppendEscape(builder, character);
                    }
                    else
                    {
                        builder.Append(character);
                    }
                    break;
            }
        }
        builder.Append('"');
    }

    private static void AppendEscape(StringBuilder builder, char character) =>
        builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
}
