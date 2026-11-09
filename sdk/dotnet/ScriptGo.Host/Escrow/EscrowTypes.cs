// Escrow value types shared by the loader, the key service and the manifest parser.
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ScriptGo.Host.Escrow;

/// <summary>A content key wrapped to a server's X25519 public key. base64url fields, as in transit.</summary>
public sealed record WrappedKey(
    [property: JsonPropertyName("epk")] string Epk,
    [property: JsonPropertyName("nonce")] string Nonce,
    [property: JsonPropertyName("wrapped")] string Wrapped);

/// <summary>base64url without padding, matching Node's Buffer base64url.</summary>
public static class Base64Url
{
    public static byte[] Decode(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        switch (t.Length % 4) { case 2: t += "=="; break; case 3: t += "="; break; }
        return Convert.FromBase64String(t);
    }

    public static string Encode(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>The clear-text escrow.json. Mirrors packages/escrow/src/format.ts EscrowManifest.</summary>
public sealed class EscrowManifest
{
    [JsonPropertyName("format")] public string Format { get; set; } = "";
    [JsonPropertyName("package")] public string Package { get; set; } = "";
    [JsonPropertyName("version")] public string Version { get; set; } = "";
    [JsonPropertyName("cipher")] public string Cipher { get; set; } = "";
    [JsonPropertyName("kdf")] public string Kdf { get; set; } = "";
    [JsonPropertyName("aad")] public string Aad { get; set; } = "";
    [JsonPropertyName("payload")] public EscrowPayload Payload { get; set; } = new();
    [JsonPropertyName("clearFiles")] public List<EscrowClearFile> ClearFiles { get; set; } = [];
    [JsonPropertyName("encryptedFiles")] public List<string> EncryptedFiles { get; set; } = [];
    [JsonPropertyName("allowlist")] public List<string> Allowlist { get; set; } = [];
    [JsonPropertyName("signerPublicKey")] public string SignerPublicKey { get; set; } = "";
    [JsonPropertyName("watermark")] public string? Watermark { get; set; }
    [JsonPropertyName("signature")] public string Signature { get; set; } = "";
}

public sealed class EscrowPayload
{
    [JsonPropertyName("nonce")] public string Nonce { get; set; } = "";
    [JsonPropertyName("sha256")] public string Sha256 { get; set; } = "";
    [JsonPropertyName("bytes")] public int Bytes { get; set; }
}

public sealed class EscrowClearFile
{
    [JsonPropertyName("path")] public string Path { get; set; } = "";
    [JsonPropertyName("sha256")] public string Sha256 { get; set; } = "";
    [JsonPropertyName("bytes")] public int Bytes { get; set; }
}

public static class EscrowFormat
{
    public const string Format = "scriptgo-escrow/1";
    public const string Cipher = "AES-256-GCM";
    public const string Kdf = "HKDF-SHA256+X25519";
    public const string EscrowJson = "escrow.json";
    public const string Payload = "payload.enc";
    public const string DeliveryMarker = ".scriptgo-escrow";

    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = null };
}
