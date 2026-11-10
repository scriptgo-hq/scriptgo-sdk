// The outer escrow bundle: a zip with escrow.json (the clear manifest), payload.enc (the encrypted
// inner zip) and the clear-text allowlist files. Nothing in it is secret, so it is read in managed
// memory by both backends. The ed25519 release signature covers the canonical JSON of the manifest
// with its signature field emptied: the same bytes packages/escrow/src/escrow.ts signs.
// CanonicalManifest below reproduces JS JSON.stringify of recursively sorted keys so the two agree.
using System.Buffers;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using ScriptGo.Escrow.Managed;
using ScriptGo.Escrow.Native;

namespace ScriptGo.Escrow;

/// <summary>A parsed, not yet decrypted escrow bundle. Reading and verifying it needs no key, so a
/// host can inspect a release (package, version, clear files, signer) before asking for one.</summary>
public sealed class EscrowBundle
{
    public EscrowManifest Manifest { get; }

    /// <summary>The clear-text files of the bundle (manifest, docs, creator-named config).</summary>
    public IReadOnlyDictionary<string, byte[]> ClearFiles => _clear;

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

    /// <summary>payload.enc: AES-256-GCM ciphertext with the 16-byte tag appended.</summary>
    internal byte[] Payload => _payload;

    /// <summary>Parses a bundle. Throws <see cref="InvalidDataException"/> on a malformed archive or
    /// on a path that would escape the resource root.</summary>
    public static EscrowBundle Read(ReadOnlyMemory<byte> bundle)
    {
        byte[]? escrowJson = null, payload = null;
        var clear = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        using (var archive = OpenZip(new ReadOnlyMemoryStream(bundle), bundle.Length))
        {
            foreach (var entry in archive.Entries)
            {
                if (entry.FullName.EndsWith('/')) continue;
                if (!EscrowPaths.IsSafe(entry.FullName)) throw new InvalidDataException($"unsafe path in the bundle: {EscrowPaths.Printable(entry.FullName)}");
                var bytes = ReadEntry(entry);
                if (entry.FullName == EscrowFormat.EscrowJson) escrowJson = bytes;
                else if (entry.FullName == EscrowFormat.Payload) payload = bytes;
                else if (!clear.TryAdd(entry.FullName, bytes)) throw new InvalidDataException($"duplicate entry {entry.FullName}.");
            }
        }
        if (escrowJson is null) throw new InvalidDataException("not an escrow bundle: escrow.json is missing.");
        if (payload is null) throw new InvalidDataException("escrow bundle has no payload.enc.");
        EscrowManifest? manifest;
        try { manifest = JsonSerializer.Deserialize<EscrowManifest>(escrowJson, EscrowFormat.Json); }
        catch (JsonException e) { throw new InvalidDataException("escrow.json is not valid JSON: " + e.Message, e); }
        if (manifest is null) throw new InvalidDataException("escrow.json is not a valid manifest.");
        return new EscrowBundle(manifest, escrowJson, payload, clear);
    }

    /// <summary>Opens a zip, turning every way the reader can choke on hostile bytes into the one
    /// exception callers handle.</summary>
    private static ZipArchive OpenZip(Stream stream, long length)
    {
        if (length < 22) throw new InvalidDataException("not a zip archive (shorter than its end record).");
        try { return new ZipArchive(stream, ZipArchiveMode.Read); }
        catch (Exception e) when (e is ArgumentException or IOException or NotSupportedException)
        {
            throw new InvalidDataException("not a zip archive: " + e.Message, e);
        }
    }

    internal static byte[] ReadEntry(ZipArchiveEntry entry)
    {
        if (entry.Length > EscrowFormat.MaxEntryBytes) throw new InvalidDataException($"escrow entry {entry.FullName} is too large.");
        using var buffer = new MemoryStream();
        try
        {
            using var stream = entry.Open();
            stream.CopyTo(buffer);
        }
        catch (Exception e) when (e is ArgumentException or IOException or NotSupportedException)
        {
            throw new InvalidDataException($"escrow entry {entry.FullName} cannot be read: {e.Message}", e);
        }
        if (buffer.Length > EscrowFormat.MaxEntryBytes) throw new InvalidDataException($"escrow entry {entry.FullName} is too large.");
        return buffer.ToArray();
    }

    /// <summary>Checks format, cipher, the trusted signer (when pinned) and the ed25519 signature.
    /// Pin <paramref name="trustedSignerPublicKey"/> in production: without it the check proves the
    /// bundle was not modified after signing, not who signed it.</summary>
    public (bool Ok, string? Reason) Verify(string? trustedSignerPublicKey, EscrowBackend backend = EscrowBackend.Managed)
    {
        if (Manifest.Format != EscrowFormat.Format) return (false, $"unsupported format {Manifest.Format}");
        if (Manifest.Cipher != EscrowFormat.Cipher || Manifest.Kdf != EscrowFormat.Kdf) return (false, "unsupported cipher/kdf");
        if (trustedSignerPublicKey is not null && trustedSignerPublicKey != Manifest.SignerPublicKey)
            return (false, "signer is not the trusted release key");
        byte[] signed, signature, publicKey;
        try { signed = Encoding.UTF8.GetBytes(CanonicalManifestWithoutSignature()); }
        catch (JsonException e) { return (false, "escrow.json is not canonicalisable: " + e.Message); }
        try
        {
            signature = Base64Url.Decode(Manifest.Signature);
            publicKey = Base64Url.Decode(Manifest.SignerPublicKey);
        }
        catch (FormatException) { return (false, "bad signature"); }
        if (signature.Length != 64 || publicKey.Length != 32) return (false, "bad signature");

        bool verified;
        if (backend == EscrowBackend.Native)
        {
            EscrowNativeLibrary.EnsureAvailable();
            unsafe
            {
                fixed (byte* m = signed, s = signature, k = publicKey)
                    verified = EscrowNative.sg_verify_manifest(m, (nuint)signed.Length, s, k) == EscrowNative.Ok;
            }
        }
        else verified = ManagedCrypto.Ed25519Verify(signed, signature, publicKey);
        return verified ? (true, null) : (false, "bad signature");
    }

    /// <summary>Checks every clear file against the hash the signed manifest records for it. Returns
    /// the path of the first file that is missing or modified, or null when all match.</summary>
    public string? FirstTamperedClearFile()
    {
        foreach (var file in Manifest.ClearFiles)
        {
            if (!_clear.TryGetValue(file.Path, out var bytes) || !FixedTimeHexEquals(SHA256.HashData(bytes), file.Sha256))
                return file.Path;
        }
        return null;
    }

    /// <summary>The managed backend's whole decryption: checks the payload hash, decrypts with the
    /// content key and returns the files of the inner zip. Throws <see cref="CryptographicException"/>
    /// on an integrity failure and <see cref="InvalidDataException"/> on a bad inner archive.</summary>
    internal Dictionary<string, byte[]> DecryptManaged(ReadOnlySpan<byte> contentKey)
    {
        if (!FixedTimeHexEquals(SHA256.HashData(_payload), Manifest.Payload.Sha256))
            throw new CryptographicException("escrow payload hash mismatch (tampered).");
        var aad = Encoding.UTF8.GetBytes(Manifest.Aad);
        byte[] nonce;
        try { nonce = Base64Url.Decode(Manifest.Payload.Nonce); }
        catch (FormatException e) { throw new CryptographicException("the payload nonce is not base64url.", e); }
        var innerZip = ManagedCrypto.AeadDecrypt(contentKey, nonce, _payload, aad);
        var files = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        try
        {
            using var archive = OpenZip(new MemoryStream(innerZip, writable: false), innerZip.Length);
            foreach (var entry in archive.Entries)
            {
                // The same path rules as the native library: nothing that could escape the resource root.
                var name = entry.FullName.EndsWith('/') ? entry.FullName[..^1] : entry.FullName;
                if (!EscrowPaths.IsSafe(name)) throw new InvalidDataException($"unsafe path in the payload: {EscrowPaths.Printable(entry.FullName)}");
                if (entry.FullName.EndsWith('/')) continue;
                var bytes = ReadEntry(entry);
                // ZipArchive does not check CRCs on every runtime; the native library always does.
                if (Crc32(bytes) != entry.Crc32) throw new InvalidDataException($"CRC mismatch in {entry.FullName}.");
                if (!files.TryAdd(entry.FullName, bytes)) throw new InvalidDataException($"duplicate entry {entry.FullName}.");
            }
        }
        finally { CryptographicOperations.ZeroMemory(innerZip); }
        return files;
    }

    // CRC-32 (IEEE 802.3), the checksum of the zip format. An integrity check against corruption,
    // not a security primitive: the AEAD tag is what authenticates the payload.
    private static readonly uint[] CrcTable = BuildCrcTable();

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            var c = i;
            for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[i] = c;
        }
        return table;
    }

    private static uint Crc32(ReadOnlySpan<byte> data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var b in data) crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        return ~crc;
    }

    internal static bool FixedTimeHexEquals(byte[] digest, string expectedHex)
    {
        if (expectedHex.Length != 64) return false;
        byte[] expected;
        try { expected = Convert.FromHexString(expectedHex); }
        catch (FormatException) { return false; }
        return CryptographicOperations.FixedTimeEquals(digest, expected);
    }

    // ---------------- canonical JSON (matches JS JSON.stringify of recursively sorted keys)

    /// <summary>The exact text the release signature covers. Public so another implementation can
    /// compare its own canonicaliser against this one.</summary>
    public string CanonicalManifestWithoutSignature()
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

    /// <summary>A read-only stream over memory the caller owns (no copy of the bundle).</summary>
    private sealed class ReadOnlyMemoryStream(ReadOnlyMemory<byte> memory) : Stream
    {
        private long _position;
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => memory.Length;
        public override long Position { get => _position; set => _position = value; }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer)
        {
            var remaining = memory.Length - _position;
            if (remaining <= 0) return 0;
            var n = (int)Math.Min(remaining, buffer.Length);
            memory.Span.Slice((int)_position, n).CopyTo(buffer);
            _position += n;
            return n;
        }
        public override long Seek(long offset, SeekOrigin origin)
        {
            _position = origin switch { SeekOrigin.Begin => offset, SeekOrigin.Current => _position + offset, _ => memory.Length + offset };
            return _position;
        }
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}

/// <summary>The path rules both backends apply to every entry of a bundle: resource-relative, '/'
/// separated, nothing that could leave the resource root once joined onto a directory.</summary>
public static class EscrowPaths
{
    public const int MaxPathBytes = 1024;

    /// <summary>True for a safe resource-relative path: not absolute, no drive or stream separator,
    /// no backslash, no control character, no empty, "." or ".." segment.</summary>
    public static bool IsSafe(string path)
    {
        if (string.IsNullOrEmpty(path) || Encoding.UTF8.GetByteCount(path) > MaxPathBytes) return false;
        if (path[0] == '/') return false;
        foreach (var c in path)
            if (c < 0x20 || c == 0x7f || c == '\\' || c == ':') return false;
        foreach (var segment in path.Split('/'))
            if (segment.Length == 0 || segment == "." || segment == "..") return false;
        return true;
    }

    /// <summary>A path made safe to print in an error message (control characters replaced).</summary>
    internal static string Printable(string path) =>
        new(path.Take(120).Select(c => c < 0x20 || c == 0x7f ? '?' : c).ToArray());
}
