// Tokenizer and directive parser for the manifest DSL (`scriptgo.lua` / `open77.lua`): the same
// grammar as packages/manifest (TypeScript) and sdk/lua/scriptgo/manifest.lua. The manifest is
// parsed, never executed. See docs/spec/manifest.md.
using System.Globalization;
using System.Text;

namespace ScriptGo.Host.Manifest;

internal sealed class ManifestSyntaxException(string code, string message, int line) : Exception(message)
{
    public string Code { get; } = code;
    public int Line { get; } = line;
}

/// <summary>A manifest value: string, double, bool, null (nil) or <see cref="ManifestTable"/>.</summary>
internal sealed class ManifestTable
{
    public List<object?> List { get; } = [];
    public Dictionary<string, object?> Map { get; } = new(StringComparer.Ordinal);
    /// <summary>Insertion order of <see cref="Map"/> keys.</summary>
    public List<string> MapOrder { get; } = [];

    public void Set(string key, object? value)
    {
        if (!Map.ContainsKey(key)) MapOrder.Add(key);
        Map[key] = value;
    }
}

internal sealed record RawDirective(string Name, List<object?> Args, int Line);

internal static class ManifestSyntax
{
    private enum Kind { Ident, String, Number, Boolean, Nil, LBrace, RBrace, LParen, RParen, Comma, Semicolon, Equals, LBracket, RBracket, Eof }

    private readonly record struct Token(Kind Kind, object? Value, int Line);

    private static bool IsIdentStart(char c) => c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or '_';
    private static bool IsIdentPart(char c) => IsIdentStart(c) || c is >= '0' and <= '9';
    private static bool IsDigit(char c) => c is >= '0' and <= '9';

    private static int LongBracketLevel(string src, int pos)
    {
        if (pos >= src.Length || src[pos] != '[') return -1;
        var i = pos + 1;
        var level = 0;
        while (i < src.Length && src[i] == '=') { level++; i++; }
        return i < src.Length && src[i] == '[' ? level : -1;
    }

    private static List<Token> Tokenize(string src)
    {
        var tokens = new List<Token>();
        var i = 0;
        var line = 1;
        var n = src.Length;

        string ReadLong(int level, int startLine)
        {
            i += level + 2;
            if (i < n && src[i] == '\r') i++;
            if (i < n && src[i] == '\n') { i++; line++; }
            var close = "]" + new string('=', level) + "]";
            var end = src.IndexOf(close, i, StringComparison.Ordinal);
            if (end < 0) throw new ManifestSyntaxException("unterminated_long_string", "Unterminated long string or comment.", startLine);
            var text = src[i..end];
            foreach (var ch in text) if (ch == '\n') line++;
            i = end + close.Length;
            return text;
        }

        while (i < n)
        {
            var c = src[i];
            if (c == '\n') { line++; i++; continue; }
            if (c is ' ' or '\t' or '\r' or '\f' or '\v') { i++; continue; }
            if (c == '-' && i + 1 < n && src[i + 1] == '-')
            {
                i += 2;
                var level = LongBracketLevel(src, i);
                if (level >= 0) ReadLong(level, line);
                else while (i < n && src[i] != '\n') i++;
                continue;
            }
            if (IsIdentStart(c))
            {
                var j = i + 1;
                while (j < n && IsIdentPart(src[j])) j++;
                var word = src[i..j];
                i = j;
                if (word is "true" or "false") tokens.Add(new(Kind.Boolean, word == "true", line));
                else if (word == "nil") tokens.Add(new(Kind.Nil, null, line));
                else tokens.Add(new(Kind.Ident, word, line));
                continue;
            }
            if (IsDigit(c) || (c == '.' && i + 1 < n && IsDigit(src[i + 1])))
            {
                var j = i;
                if (c == '0' && i + 1 < n && src[i + 1] is 'x' or 'X')
                {
                    j += 2;
                    while (j < n && Uri.IsHexDigit(src[j])) j++;
                    var hex = src[(i + 2)..j];
                    tokens.Add(new(Kind.Number, hex.Length == 0 ? double.NaN : (double)long.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture), line));
                }
                else
                {
                    while (j < n && (IsDigit(src[j]) || src[j] == '.')) j++;
                    if (j < n && src[j] is 'e' or 'E')
                    {
                        j++;
                        if (j < n && src[j] is '+' or '-') j++;
                        while (j < n && IsDigit(src[j])) j++;
                    }
                    var text = src[i..j];
                    if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) || !double.IsFinite(value))
                        throw new ManifestSyntaxException("invalid_number", $"Invalid number '{text}'.", line);
                    tokens.Add(new(Kind.Number, value, line));
                }
                i = j;
                continue;
            }
            if (c == '-' && i + 1 < n && IsDigit(src[i + 1]))
            {
                var j = i + 1;
                while (j < n && (IsDigit(src[j]) || src[j] == '.')) j++;
                double.TryParse(src[i..j], NumberStyles.Float, CultureInfo.InvariantCulture, out var value);
                tokens.Add(new(Kind.Number, value, line));
                i = j;
                continue;
            }
            if (c is '"' or '\'')
            {
                var quote = c;
                var startLine = line;
                var j = i + 1;
                var sb = new StringBuilder();
                for (; ; )
                {
                    if (j >= n) throw new ManifestSyntaxException("unterminated_string", "Unterminated string.", startLine);
                    var ch = src[j];
                    if (ch == quote) { j++; break; }
                    if (ch == '\n') throw new ManifestSyntaxException("unterminated_string", "Unterminated string.", startLine);
                    if (ch == '\\')
                    {
                        if (j + 1 >= n) throw new ManifestSyntaxException("unterminated_string", "Unterminated string.", startLine);
                        var next = src[j + 1];
                        var single = next switch
                        {
                            'n' => "\n", 't' => "\t", 'r' => "\r", 'a' => "\a", 'b' => "\b", 'f' => "\f", 'v' => "\v",
                            '\\' => "\\", '"' => "\"", '\'' => "'", '\n' => "\n", _ => null,
                        };
                        if (single is not null)
                        {
                            sb.Append(single);
                            if (next == '\n') line++;
                            j += 2;
                            continue;
                        }
                        if (IsDigit(next))
                        {
                            var k = j + 1;
                            var digits = "";
                            while (k < n && digits.Length < 3 && IsDigit(src[k])) digits += src[k++];
                            sb.Append((char)int.Parse(digits, CultureInfo.InvariantCulture));
                            j = k;
                            continue;
                        }
                        if (next == 'x')
                        {
                            var hex = j + 4 <= n ? src[(j + 2)..(j + 4)] : "";
                            if (hex.Length != 2 || !Uri.IsHexDigit(hex[0]) || !Uri.IsHexDigit(hex[1]))
                                throw new ManifestSyntaxException("invalid_escape", "Invalid \\x escape.", line);
                            sb.Append((char)Convert.ToInt32(hex, 16));
                            j += 4;
                            continue;
                        }
                        throw new ManifestSyntaxException("invalid_escape", $"Invalid escape '\\{next}'.", line);
                    }
                    sb.Append(ch);
                    j++;
                }
                tokens.Add(new(Kind.String, sb.ToString(), startLine));
                i = j;
                continue;
            }
            if (c == '[')
            {
                var level = LongBracketLevel(src, i);
                if (level >= 0)
                {
                    var startLine = line;
                    tokens.Add(new(Kind.String, ReadLong(level, startLine), startLine));
                    continue;
                }
                tokens.Add(new(Kind.LBracket, "[", line));
                i++;
                continue;
            }
            Kind? kind = c switch
            {
                '{' => Kind.LBrace, '}' => Kind.RBrace, '(' => Kind.LParen, ')' => Kind.RParen,
                ',' => Kind.Comma, ';' => Kind.Semicolon, '=' => Kind.Equals, ']' => Kind.RBracket, _ => null,
            };
            if (kind is not null)
            {
                tokens.Add(new(kind.Value, c.ToString(), line));
                i++;
                continue;
            }
            throw new ManifestSyntaxException("unexpected_character", $"Unexpected character '{c}'.", line);
        }
        tokens.Add(new(Kind.Eof, null, line));
        return tokens;
    }

    private static string Describe(Token t) => t.Kind switch
    {
        Kind.Eof => "end of file",
        Kind.String => $"string \"{Truncate(t.Value as string ?? "", 32)}\"",
        _ => $"'{Convert.ToString(t.Value, CultureInfo.InvariantCulture)}'",
    };

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

    /// <summary>Parses manifest source into an ordered list of directives.</summary>
    public static List<RawDirective> ParseDirectives(string src)
    {
        var tokens = Tokenize(src);
        var pos = 0;
        Token Peek() => tokens[pos];
        Token Next() => tokens[pos++];
        Token Expect(Kind kind, string what)
        {
            var t = Next();
            if (t.Kind != kind) throw new ManifestSyntaxException("unexpected_token", $"Expected {what}, found {Describe(t)}.", t.Line);
            return t;
        }

        object? ParseValue()
        {
            var t = Next();
            switch (t.Kind)
            {
                case Kind.String:
                case Kind.Number:
                case Kind.Boolean:
                    return t.Value;
                case Kind.Nil:
                    return null;
                case Kind.LBrace:
                    pos--;
                    return ParseTable();
                default:
                    throw new ManifestSyntaxException("unexpected_token", $"Expected a value, found {Describe(t)}.", t.Line);
            }
        }

        ManifestTable ParseTable()
        {
            var open = Expect(Kind.LBrace, "'{'");
            var table = new ManifestTable();
            for (; ; )
            {
                var t = Peek();
                if (t.Kind == Kind.RBrace) { Next(); return table; }
                if (t.Kind == Kind.Eof) throw new ManifestSyntaxException("unterminated_table", "Unterminated table.", open.Line);
                if (t.Kind == Kind.Ident && tokens[pos + 1].Kind == Kind.Equals)
                {
                    Next(); Next();
                    table.Set((string)t.Value!, ParseValue());
                }
                else if (t.Kind == Kind.LBracket)
                {
                    Next();
                    var key = Expect(Kind.String, "a string key");
                    Expect(Kind.RBracket, "']'");
                    Expect(Kind.Equals, "'='");
                    table.Set((string)key.Value!, ParseValue());
                }
                else
                {
                    table.List.Add(ParseValue());
                }
                var sep = Peek();
                if (sep.Kind is Kind.Comma or Kind.Semicolon) { Next(); continue; }
                if (sep.Kind != Kind.RBrace)
                    throw new ManifestSyntaxException("unexpected_token", $"Expected ',' or '}}', found {Describe(sep)}.", sep.Line);
            }
        }

        static bool IsArgStart(Token t) => t.Kind is Kind.String or Kind.Number or Kind.Boolean or Kind.LBrace or Kind.LParen;

        var directives = new List<RawDirective>();
        for (; ; )
        {
            var t = Peek();
            if (t.Kind == Kind.Eof) break;
            if (t.Kind == Kind.Semicolon) { Next(); continue; }
            if (t.Kind != Kind.Ident)
                throw new ManifestSyntaxException("unexpected_token", $"Expected a directive name, found {Describe(t)}.", t.Line);
            Next();
            var directive = new RawDirective((string)t.Value!, [], t.Line);
            if (!IsArgStart(Peek()))
                throw new ManifestSyntaxException("missing_argument", $"Directive '{directive.Name}' needs a value.", t.Line);
            while (IsArgStart(Peek()))
            {
                if (Peek().Kind == Kind.LParen)
                {
                    Next();
                    if (Peek().Kind != Kind.RParen)
                    {
                        directive.Args.Add(ParseValue());
                        while (Peek().Kind == Kind.Comma) { Next(); directive.Args.Add(ParseValue()); }
                    }
                    Expect(Kind.RParen, "')'");
                }
                else
                {
                    directive.Args.Add(ParseValue());
                }
            }
            directives.Add(directive);
        }
        return directives;
    }
}
