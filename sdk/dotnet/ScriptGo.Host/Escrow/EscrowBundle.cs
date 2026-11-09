// Reads an escrow bundle (zip: escrow.json + clear files + payload.enc), verifies the ed25519
// release signature and the payload hash, and decrypts the payload in memory with a content key.
// The signature covers the canonical JSON of the manifest with its signature field emptied — the
// same bytes packages/escrow/src/escrow.ts signs; CanonicalJson below reproduces JS JSON.stringify
// of recursively sorted keys so the two agree.
using System.Buffers;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace ScriptGo.Host.Escrow;

public sealed class EscrowBundle
{
    public EscrowManifest Manifest { get; }
    private readonly byte[] _escrowJsonRaw;
    private readonly byte[] _payload;
    private readonly Dictionary<string, byte[]> _clear;

    private EscrowBundle(EscrowManifest manifest, byte[] escrowJsonRaw, byte[] payload, Dictionary<string, byte[]> clear)
    {
        Manifest = manifest;
        _escrowJsonRaw = escrowJsonRaw;
        _payload = payload;
        _clear = clear;
    }

    /// <summary>Parses a bundle. Throws <see cref="InvalidDataException"/> on a malformed archive.</summary>
    public static EscrowBundle Read(byte[] bundle)
    {
        using var archive = new ZipArchive(new MemoryStream(bundle, writable: false), ZipArchiveMode.Read);
        byte[]? escrowJson = null, payload = null;
        var clear = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (var entry in archive.Entries)
        {
            if (entry.FullName.EndsWith('/')) continue;
            var bytes = ReadEntry(entry);
            if (entry.FullName == EscrowFormat.EscrowJson) escrowJson = bytes;
            else if (entry.FullName == EscrowFormat.Payload) payload = bytes;
            else clear[entry.FullName] = bytes;
        }
        if (escrowJson is null) throw new InvalidDataException("not an escrow bundle: escrow.json is missing.");
        if (payload is null) throw new InvalidDataException("escrow bundle has no payload.enc.");
        var manifest = JsonSerializer.Deserialize<EscrowManifest>(escrowJson, EscrowFormat.Json)
            ?? throw new InvalidDataException("escrow.json is not a valid manifest.");
        return new EscrowBundle(manifest, escrowJson, payload, clear);
    }

    private static byte[] ReadEntry(ZipArchiveEntry entry)
    {
        if (entry.Length > 64L * 1024 * 1024) throw new InvalidDataException($"escrow entry {entry.FullName} is too large.");
        using var stream = entry.Open();
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }

    /// <summary>Checks format, cipher, the trusted signer (when pinned) and the ed25519 signature.</summary>
    public (bool Ok, string? Reason) Verify(string? trustedSignerPublicKey)
    {
        if (Manifest.Format != EscrowFormat.Format) return (false, $"unsupported format {Manifest.Format}");
        if (Manifest.Cipher != EscrowFormat.Cipher || Manifest.Kdf != EscrowFormat.Kdf) return (false, "unsupported cipher/kdf");
        if (trustedSignerPublicKey is not null && trustedSignerPublicKey != Manifest.SignerPublicKey)
            return (false, "signer is not the trusted release key");
        byte[] signed;
        try { signed = Encoding.UTF8.GetBytes(CanonicalManifestWithoutSignature()); }
        catch (JsonException e) { return (false, "escrow.json is not canonicalisable: " + e.Message); }
        var signature = Base64Url.Decode(Manifest.Signature);
        var publicKey = Base64Url.Decode(Manifest.SignerPublicKey);
        return EscrowCrypto.Ed25519Verify(signed, signature, publicKey) ? (true, null) : (false, "bad signature");
    }

    /// <summary>Verifies, checks the payload+clear hashes, decrypts the payload with the content key,
    /// and returns every file (clear + decrypted) in memory. Throws on any integrity failure.</summary>
    public Dictionary<string, byte[]> Open(ReadOnlySpan<byte> contentKey, string? trustedSignerPublicKey)
    {
        var (ok, reason) = Verify(trustedSignerPublicKey);
        if (!ok) throw new CryptographicException($"escrow verify failed: {reason}");
        if (!FixedTimeHexEquals(SHA256.HashData(_payload), Manifest.Payload.Sha256))
            throw new CryptographicException("escrow payload hash mismatch (tampered).");
        foreach (var file in Manifest.ClearFiles)
        {
            if (!_clear.TryGetValue(file.Path, out var bytes) || !FixedTimeHexEquals(SHA256.HashData(bytes), file.Sha256))
                throw new CryptographicException($"clear file {file.Path} is missing or tampered.");
        }
        var aad = Encoding.UTF8.GetBytes(Manifest.Aad);
        var nonce = Base64Url.Decode(Manifest.Payload.Nonce);
        var innerZip = EscrowCrypto.AeadDecrypt(contentKey, nonce, _payload, aad);
        var files = new Dictionary<string, byte[]>(_clear, StringComparer.Ordinal);
        using (var archive = new ZipArchive(new MemoryStream(innerZip, writable: false), ZipArchiveMode.Read))
        {
            foreach (var entry in archive.Entries)
            {
                if (entry.FullName.EndsWith('/')) continue;
                files[entry.FullName] = ReadEntry(entry);
            }
        }
        CryptographicOperations.ZeroMemory(innerZip);
        return files;
    }

    private static bool FixedTimeHexEquals(byte[] digest, string expectedHex)
    {
        if (expectedHex.Length != 64) return false;
        byte[] expected;
        try { expected = Convert.FromHexString(expectedHex); }
        catch (FormatException) { return false; }
        return CryptographicOperations.FixedTimeEquals(digest, expected);
    }

    // ---------------- canonical JSON (matches JS JSON.stringify of recursively sorted keys)

    private string CanonicalManifestWithoutSignature()
    {
        using var doc = JsonDocument.Parse(_escrowJsonRaw);
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Indented = false, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            WriteCanonical(writer, doc.RootElement, isRoot: true);
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement element, bool isRoot = false)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    // Empty the top-level signature, as the TS signer does before signing.
                    if (isRoot && property.Name == "signature") writer.WriteStringValue("");
                    else WriteCanonical(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray()) WriteCanonical(writer, item);
                writer.WriteEndArray();
                break;
            default:
                element.WriteTo(writer);
                break;
        }
    }
}
