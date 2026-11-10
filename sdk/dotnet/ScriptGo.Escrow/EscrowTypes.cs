// Value types of the escrow wire contract (docs/spec/escrow.md), shared by both backends.
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ScriptGo.Escrow;

/// <summary>Where the content key is unwrapped and the plaintext is held.</summary>
public enum EscrowBackend
{
    /// <summary>libscriptgo: the private key, the content key and the plaintext stay in native,
    /// guarded memory; Lua chunks go from there straight into the VM. The default.</summary>
    Native,

    /// <summary>Decrypt in managed memory. Weaker against memory inspection: the private key, the
    /// content key and every decrypted file are ordinary managed arrays that a heap dump shows and
    /// the garbage collector may copy. Same wire format, same refusals. Use it only where the native
    /// library does not exist for the platform, and say so to whoever relies on it.</summary>
    Managed,
}

/// <summary>A content key wrapped to a server's X25519 public key. base64url fields, as in transit.</summary>
public sealed record WrappedKey(
    [property: JsonPropertyName("epk")] string Epk,
    [property: JsonPropertyName("nonce")] string Nonce,
    [property: JsonPropertyName("wrapped")] string Wrapped);

/// <summary>base64url without padding, matching Node's Buffer base64url.</summary>
public static class Base64Url
{
    /// <summary>Decodes; throws <see cref="FormatException"/> on text that is not base64url.</summary>
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

/// <summary>One file inside the encrypted payload: its resource-relative path and its size.</summary>
public readonly record struct EscrowEntry(string Path, long Size);

public static class EscrowFormat
{
    public const string Format = "scriptgo-escrow/1";
    public const string Cipher = "AES-256-GCM";
    public const string Kdf = "HKDF-SHA256+X25519";
    public const string EscrowJson = "escrow.json";
    public const string Payload = "payload.enc";
    /// <summary>The per-delivery marker entry a loader adds to a decrypted resource (traceability).</summary>
    public const string DeliveryMarker = ".scriptgo-escrow";

    /// <summary>The largest single file a loader accepts (the native library has the same limit).</summary>
    public const long MaxEntryBytes = 64L * 1024 * 1024;

    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = null };
}

/// <summary>Why an escrow operation failed. <see cref="EscrowException.Reason"/> carries the detail.</summary>
public enum EscrowFailure
{
    /// <summary>Not an escrow bundle, or a malformed one (including an unsafe path inside it).</summary>
    InvalidBundle,
    /// <summary>The release signature does not verify, or was not made by the trusted key.</summary>
    Signature,
    /// <summary>The key service answered a definitive no: revoked, expired, refunded, unbound, ...</summary>
    Refused,
    /// <summary>The key service could not be reached or could not answer. Not a refusal.</summary>
    KeyServiceUnreachable,
    /// <summary>The key was not wrapped to this server identity and release (an unbound server).</summary>
    UnwrapFailed,
    /// <summary>The payload is not the one the manifest names, or does not decrypt (tampered).</summary>
    DecryptFailed,
    /// <summary>The native library is missing, of another ABI, or cannot run on this CPU.</summary>
    NativeLibraryUnavailable,
    /// <summary>The content was revoked (the license ended and offline grace ran out) or disposed.</summary>
    Revoked,
}

/// <summary>An escrow failure. <see cref="Reason"/> is a stable token followed by detail, for
/// example <c>refused:revoked</c>, <c>unwrap_failed:...</c>, <c>key_service_unreachable:http_503</c>.</summary>
public sealed class EscrowException(EscrowFailure failure, string reason, Exception? inner = null) : Exception(reason, inner)
{
    public EscrowFailure Failure { get; } = failure;
    public string Reason { get; } = reason;

    /// <summary>True when retrying later can succeed without anything changing on this server.</summary>
    public bool IsTransient => Failure == EscrowFailure.KeyServiceUnreachable;
}
