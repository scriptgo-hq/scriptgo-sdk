// A small JSON reader and the canonical writer the escrow signature needs. The bridge targets
// netstandard2.0 for Unity's Mono and carries no JSON package, and the signature covers exact bytes:
// JSON.stringify of the manifest with keys sorted at every level and `signature` set to ""
// (docs/spec/escrow.md, packages/escrow/src/canonical.ts). So this file is deliberately strict:
// anything it could not write back byte for byte the way JavaScript does is refused, and the manifest
// is then reported as invalid instead of being checked against the wrong bytes.
//
// Values: Dictionary<string, object> (object), List<object> (array), string, long (integer),
// double (any other number), bool, null.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace ScriptGo.Bridge.Escrow
{
    internal sealed class JsonError : Exception
    {
        public JsonError(string message) : base(message) { }
    }

    internal static class Json
    {
        private const int MaxDepth = 32;
        // JavaScript's safe integers: larger ones do not survive JSON.parse unchanged.
        private const long MaxSafeInteger = 9007199254740991L;

        public static object Parse(string text)
        {
            if (text == null) throw new JsonError("no JSON text");
            int i = 0;
            var value = ReadValue(text, ref i, 0);
            SkipSpace(text, ref i);
            if (i != text.Length) throw new JsonError("unexpected text after the JSON value at " + i);
            return value;
        }

        /// <summary>Strict UTF-8 (no byte order mark, no invalid sequence), then <see cref="Parse(string)"/>.</summary>
        public static object Parse(byte[] utf8)
        {
            string text;
            try { text = new UTF8Encoding(false, true).GetString(utf8 ?? new byte[0]); }
            catch (ArgumentException) { throw new JsonError("not valid UTF-8"); }
            return Parse(text);
        }

        private static void SkipSpace(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
        }

        private static object ReadValue(string s, ref int i, int depth)
        {
            if (depth > MaxDepth) throw new JsonError("nested deeper than " + MaxDepth);
            SkipSpace(s, ref i);
            if (i >= s.Length) throw new JsonError("unexpected end of JSON");
            char c = s[i];
            if (c == '{')
            {
                i++;
                var obj = new Dictionary<string, object>(StringComparer.Ordinal);
                SkipSpace(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return obj; }
                while (true)
                {
                    SkipSpace(s, ref i);
                    if (i >= s.Length || s[i] != '"') throw new JsonError("expected a key at " + i);
                    var key = ReadString(s, ref i);
                    SkipSpace(s, ref i);
                    if (i >= s.Length || s[i] != ':') throw new JsonError("expected ':' at " + i);
                    i++;
                    // A duplicate key means two readers could see two different documents.
                    if (obj.ContainsKey(key)) throw new JsonError("duplicate key \"" + key + "\"");
                    obj[key] = ReadValue(s, ref i, depth + 1);
                    SkipSpace(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == '}') { i++; return obj; }
                    throw new JsonError("expected ',' or '}' at " + i);
                }
            }
            if (c == '[')
            {
                i++;
                var list = new List<object>();
                SkipSpace(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(ReadValue(s, ref i, depth + 1));
                    SkipSpace(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == ']') { i++; return list; }
                    throw new JsonError("expected ',' or ']' at " + i);
                }
            }
            if (c == '"') return ReadString(s, ref i);
            if (c == 't') { Expect(s, ref i, "true"); return true; }
            if (c == 'f') { Expect(s, ref i, "false"); return false; }
            if (c == 'n') { Expect(s, ref i, "null"); return null; }
            if (c == '-' || (c >= '0' && c <= '9')) return ReadNumber(s, ref i);
            throw new JsonError("unexpected character at " + i);
        }

        private static void Expect(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) throw new JsonError("unexpected token at " + i);
            i += word.Length;
        }

        private static object ReadNumber(string s, ref int i)
        {
            int start = i;
            if (s[i] == '-') i++;
            if (i >= s.Length) throw new JsonError("bad number at " + start);
            if (s[i] == '0') i++;
            else if (s[i] >= '1' && s[i] <= '9') { while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++; }
            else throw new JsonError("bad number at " + start);
            bool integer = true;
            if (i < s.Length && s[i] == '.')
            {
                integer = false;
                i++;
                int digits = i;
                while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
                if (i == digits) throw new JsonError("bad number at " + start);
            }
            if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
            {
                integer = false;
                i++;
                if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++;
                int digits = i;
                while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
                if (i == digits) throw new JsonError("bad number at " + start);
            }
            var token = s.Substring(start, i - start);
            long whole;
            if (integer && long.TryParse(token, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out whole)
                && whole >= -MaxSafeInteger && whole <= MaxSafeInteger)
                return whole;
            double real;
            if (!double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out real)) throw new JsonError("bad number at " + start);
            return real;
        }

        private static string ReadString(string s, ref int i)
        {
            i++; // opening quote
            var sb = new StringBuilder();
            while (true)
            {
                if (i >= s.Length) throw new JsonError("unterminated string");
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c < 0x20) throw new JsonError("control character in a string at " + (i - 1));
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) throw new JsonError("unterminated escape");
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new JsonError("bad \\u escape");
                        int code = 0;
                        for (int k = 0; k < 4; k++)
                        {
                            int d = Hex(s[i + k]);
                            if (d < 0) throw new JsonError("bad \\u escape at " + i);
                            code = code * 16 + d;
                        }
                        i += 4;
                        sb.Append((char)code);
                        break;
                    default: throw new JsonError("bad escape at " + (i - 1));
                }
            }
        }

        private static int Hex(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }

        // Canonical output ----------------------------------------------------------------------------------
        /// <summary>
        /// JSON.stringify of the value with object keys sorted at every level. With
        /// <paramref name="emptyRootSignature"/>, the top-level "signature" is written as "".
        /// Throws <see cref="JsonError"/> for a value JavaScript would write differently than this does.
        /// </summary>
        public static string Canonical(object value, bool emptyRootSignature)
        {
            var sb = new StringBuilder();
            Write(sb, value, emptyRootSignature, 0);
            return sb.ToString();
        }

        private static void Write(StringBuilder sb, object value, bool emptySignature, int depth)
        {
            if (depth > MaxDepth) throw new JsonError("nested deeper than " + MaxDepth);
            if (value == null) { sb.Append("null"); return; }
            var text = value as string;
            if (text != null) { WriteString(sb, text); return; }
            if (value is bool) { sb.Append((bool)value ? "true" : "false"); return; }
            if (value is long) { sb.Append(((long)value).ToString(CultureInfo.InvariantCulture)); return; }
            if (value is int) { sb.Append(((int)value).ToString(CultureInfo.InvariantCulture)); return; }
            var obj = value as Dictionary<string, object>;
            if (obj != null)
            {
                var keys = new List<string>(obj.Keys);
                // Array.prototype.sort() on strings compares UTF-16 code units: ordinal order.
                keys.Sort(string.CompareOrdinal);
                sb.Append('{');
                bool first = true;
                foreach (var key in keys)
                {
                    // A JavaScript object lists integer-like keys first, whatever order they were added
                    // in, and drops "__proto__" on assignment. The escrow manifest has neither.
                    if (IsArrayIndex(key) || key == "__proto__") throw new JsonError("key \"" + key + "\" cannot be canonicalised");
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, key);
                    sb.Append(':');
                    if (emptySignature && depth == 0 && key == "signature") sb.Append("\"\"");
                    else Write(sb, obj[key], false, depth + 1);
                }
                sb.Append('}');
                return;
            }
            var list = value as List<object>;
            if (list != null)
            {
                sb.Append('[');
                for (int k = 0; k < list.Count; k++)
                {
                    if (k > 0) sb.Append(',');
                    Write(sb, list[k], false, depth + 1);
                }
                sb.Append(']');
                return;
            }
            // Fractions and exponents: JavaScript's number formatting is not reproduced here.
            throw new JsonError("only integers are supported as numbers");
        }

        private static bool IsArrayIndex(string key)
        {
            if (key.Length == 0 || key.Length > 10) return false;
            foreach (var ch in key) if (ch < '0' || ch > '9') return false;
            return key.Length == 1 || key[0] != '0';
        }

        // QuoteJSONString (ECMA-262): ", \ and control characters are escaped, lone surrogates become
        // \uXXXX, everything else is written as it is.
        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            for (int k = 0; k < s.Length; k++)
            {
                char c = s[k];
                switch (c)
                {
                    case '"': sb.Append("\\\""); continue;
                    case '\\': sb.Append("\\\\"); continue;
                    case '\b': sb.Append("\\b"); continue;
                    case '\f': sb.Append("\\f"); continue;
                    case '\n': sb.Append("\\n"); continue;
                    case '\r': sb.Append("\\r"); continue;
                    case '\t': sb.Append("\\t"); continue;
                }
                if (c < 0x20) { AppendUnicodeEscape(sb, c); continue; }
                if (char.IsHighSurrogate(c))
                {
                    if (k + 1 < s.Length && char.IsLowSurrogate(s[k + 1])) { sb.Append(c).Append(s[++k]); continue; }
                    AppendUnicodeEscape(sb, c);
                    continue;
                }
                if (char.IsLowSurrogate(c)) { AppendUnicodeEscape(sb, c); continue; }
                sb.Append(c);
            }
            sb.Append('"');
        }

        private static void AppendUnicodeEscape(StringBuilder sb, char c)
        {
            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
        }

        // Typed access ------------------------------------------------------------------------------------
        public static Dictionary<string, object> Object(object value, string what)
        {
            var obj = value as Dictionary<string, object>;
            if (obj == null) throw new JsonError(what + " must be an object");
            return obj;
        }

        public static string String(Dictionary<string, object> obj, string key)
        {
            object v;
            if (!obj.TryGetValue(key, out v) || !(v is string)) throw new JsonError("\"" + key + "\" must be a string");
            return (string)v;
        }

        /// <summary>A string, or null when the key is missing or null.</summary>
        public static string OptionalString(Dictionary<string, object> obj, string key)
        {
            object v;
            if (!obj.TryGetValue(key, out v) || v == null) return null;
            if (!(v is string)) throw new JsonError("\"" + key + "\" must be a string or null");
            return (string)v;
        }

        public static long Integer(Dictionary<string, object> obj, string key)
        {
            object v;
            if (!obj.TryGetValue(key, out v) || !(v is long)) throw new JsonError("\"" + key + "\" must be an integer");
            return (long)v;
        }

        public static List<object> Array(Dictionary<string, object> obj, string key)
        {
            object v;
            if (!obj.TryGetValue(key, out v) || !(v is List<object>)) throw new JsonError("\"" + key + "\" must be an array");
            return (List<object>)v;
        }
    }

    /// <summary>base64url without padding, as Node writes it.</summary>
    internal static class Base64Url
    {
        public static bool TryDecode(string text, out byte[] bytes)
        {
            bytes = null;
            if (text == null) return false;
            foreach (var c in text)
            {
                bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
                if (!ok) return false;
            }
            if (text.Length % 4 == 1) return false;
            var padded = text.Replace('-', '+').Replace('_', '/');
            switch (padded.Length % 4)
            {
                case 2: padded += "=="; break;
                case 3: padded += "="; break;
            }
            try { bytes = Convert.FromBase64String(padded); }
            catch (FormatException) { return false; }
            return true;
        }

        public static bool TryDecode(string text, int length, out byte[] bytes)
        {
            return TryDecode(text, out bytes) && bytes.Length == length;
        }

        public static string Encode(byte[] bytes)
        {
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
    }
}
