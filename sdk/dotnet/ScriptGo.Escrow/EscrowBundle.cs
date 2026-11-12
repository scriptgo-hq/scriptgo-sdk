// The outer escrow bundle: a zip with escrow.json (the clear manifest), payload.enc (the encrypted
// inner zip) and the clear-text allowlist files. Nothing in it is secret, so it is read in managed
// memory by both backends. The ed25519 release signature covers the canonical JSON of the manifest
// with its signature field emptied: the same bytes packages/escrow/src/escrow.ts signs.
// CanonicalManifest below reproduces JS JSON.stringify of recursively sorted keys so the two agree.
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
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

    /// <summary>Parses a bundle. Throws <see cref="InvalidDataException"/> on a malformed archive, on a
    /// path that would escape the resource root, on an entry the manifest does not list (anything but
    /// <c>escrow.json</c>, <c>payload.enc</c> and its <c>clearFiles</c>: the signature covers the
    /// manifest, not the zip, so an added <c>server/evil.lua</c> would otherwise be served as a clear
    /// file) and on a path listed both clear and encrypted.</summary>
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
        if (EntryProblem(manifest, clear.Keys) is { } problem) throw new InvalidDataException(problem);
        return new EscrowBundle(manifest, escrowJson, payload, clear);
    }

    /// <summary>The first entry of a bundle the signed manifest does not account for, or a path listed both
    /// clear and encrypted; null when the bundle holds exactly <c>escrow.json</c>, <c>payload.enc</c> and
    /// the manifest's clear files.</summary>
    internal static string? EntryProblem(EscrowManifest manifest, IEnumerable<string> clearEntries)
    {
        var listed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var file in manifest.ClearFiles ?? []) if (file?.Path is { } path) listed.Add(path);
        foreach (var path in manifest.EncryptedFiles ?? [])
            if (path is not null && listed.Contains(path)) return $"{EscrowPaths.Printable(path)} is listed both clear and encrypted.";
        foreach (var path in clearEntries)
            if (!listed.Contains(path)) return $"{EscrowPaths.Printable(path)} is in the bundle but not in escrow.json.";
        return null;
    }

    // ---------------- a release installed as a folder (docs/spec/escrow.md, "On disk")

    /// <summary>The largest <c>escrow.json</c> read from a folder.</summary>
    public const int MaximumManifestBytes = 4 * 1024 * 1024;

    /// <summary>The native library's own ceiling for <c>payload.enc</c>.</summary>
    public const long MaximumPayloadBytes = 256L * 1024 * 1024;

    /// <summary>
    /// Reads a release that is installed, still encrypted, as a folder: <c>escrow.json</c>,
    /// <c>payload.enc</c>, the clear files at their paths and a one-line stub at the path of each
    /// encrypted file (what <c>scriptgo escrow install</c> writes). This is how a host that discovers
    /// resources on disk keeps a release encrypted at rest.
    /// <para>The manifest's shape is validated strictly and <c>payload.enc</c> is checked against
    /// the signed size and hash here, before any key is asked for. Clear files are read as they are
    /// on disk: an operator may have edited one, so compare them with
    /// <see cref="EditedClearFiles"/> and decide (see <see cref="EscrowOpenOptions.AllowEditedClearFile"/>).
    /// Nothing is decrypted and no stub is read: check the stubs your host would otherwise execute
    /// with <see cref="IsStub"/>.</para>
    /// </summary>
    /// <exception cref="EscrowException"><c>invalid_bundle:</c> the folder is not an installed
    /// release or its manifest is malformed; <c>decrypt_failed:</c> <c>payload.enc</c> is not the
    /// signed one.</exception>
    public static EscrowBundle ReadFolder(string directory)
    {
        ArgumentException.ThrowIfNullOrEmpty(directory);
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory)) + Path.DirectorySeparatorChar;

        var escrowJson = ReadFile(Path.Combine(root, EscrowFormat.EscrowJson), MaximumManifestBytes, "escrow.json");
        // A byte-order mark is not JSON; a packer never writes one, an editor might.
        if (escrowJson.Length >= 3 && escrowJson[0] == 0xEF && escrowJson[1] == 0xBB && escrowJson[2] == 0xBF) escrowJson = escrowJson[3..];
        EscrowManifest? manifest;
        try { manifest = JsonSerializer.Deserialize<EscrowManifest>(escrowJson, EscrowFormat.Json); }
        catch (JsonException e) { throw Invalid("escrow.json is not valid JSON: " + e.Message, e); }
        if (manifest is null) throw Invalid("escrow.json is not a valid manifest.");
        if (ShapeProblem(manifest) is { } problem) throw Invalid(problem);
        // What the signature covers must be reproducible exactly; a manifest that is not is
        // refused by name here rather than as a bad signature later.
        try { EscrowCanonicalJson.ForSignature(escrowJson); }
        catch (InvalidDataException e) { throw Invalid(e.Message, e); }

        byte[] payload;
        try
        {
            using var stream = File.OpenRead(Path.Combine(root, EscrowFormat.Payload));
            if (stream.Length != manifest.Payload.Bytes)
                throw new EscrowException(EscrowFailure.DecryptFailed, "decrypt_failed:payload.enc does not have the signed size");
            payload = new byte[checked((int)stream.Length)];
            stream.ReadExactly(payload);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new EscrowException(EscrowFailure.DecryptFailed, "decrypt_failed:payload.enc could not be read: " + e.Message, e);
        }
        if (!FixedTimeHexEquals(SHA256.HashData(payload), manifest.Payload.Sha256))
            throw new EscrowException(EscrowFailure.DecryptFailed, "decrypt_failed:payload.enc does not match the signed hash");

        var clear = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (var file in manifest.ClearFiles)
        {
            var full = Path.GetFullPath(Path.Combine(root, file.Path.Replace('/', Path.DirectorySeparatorChar)));
            if (!full.StartsWith(root, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                throw Invalid($"clear file {EscrowPaths.Printable(file.Path)} escapes the folder.");
            try
            {
                var info = new FileInfo(full);
                // A missing or oversized file is simply absent: EditedClearFiles reports it.
                if (info.Exists && info.Length <= EscrowFormat.MaxEntryBytes) clear[file.Path] = File.ReadAllBytes(full);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }
        return new EscrowBundle(manifest, escrowJson, payload, clear);
    }

    private static byte[] ReadFile(string path, int maximum, string label)
    {
        try
        {
            using var stream = File.OpenRead(path);
            if (stream.Length > maximum) throw Invalid($"{label} is too large.");
            var bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
            return bytes;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw Invalid($"{label} could not be read: {e.Message}", e);
        }
    }

    private static EscrowException Invalid(string detail, Exception? inner = null) =>
        new(EscrowFailure.InvalidBundle, "invalid_bundle:" + detail, inner);

    /// <summary>
    /// The first thing wrong with a manifest's shape, or null. Stricter than what a signature check
    /// alone needs: a host that reads releases from disk refuses, by name, a manifest it would
    /// otherwise have to trust in part (a path that escapes the folder, a file listed twice, a size
    /// outside the format's limits).
    /// </summary>
    public static string? ShapeProblem(EscrowManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        if (manifest.Format != EscrowFormat.Format)
            return $"unsupported escrow format '{EscrowPaths.Printable(manifest.Format ?? "")}' (this loader reads {EscrowFormat.Format})";
        if (manifest.Cipher != EscrowFormat.Cipher || manifest.Kdf != EscrowFormat.Kdf) return "unsupported cipher or kdf";
        if (!Bounded(manifest.Package, 200)) return "package is empty, too long or holds a control character";
        if (!Bounded(manifest.Version, 64)) return "version is empty, too long or holds a control character";
        if (manifest.Aad != $"{manifest.Package}@{manifest.Version}") return "aad does not name this package and version";
        if (manifest.Payload is null) return "payload is missing";
        if (!Decodes(manifest.Payload.Nonce, 12)) return "payload.nonce is not 12 bytes of base64url";
        if (!IsLowerSha256(manifest.Payload.Sha256)) return "payload.sha256 is not a lowercase SHA-256";
        if (manifest.Payload.Bytes < 16 || manifest.Payload.Bytes > MaximumPayloadBytes) return "payload.bytes is out of range";
        if (manifest.ClearFiles is null || manifest.EncryptedFiles is null) return "clearFiles or encryptedFiles is missing";
        if (manifest.ClearFiles.Count + manifest.EncryptedFiles.Count > 32768) return "too many files";
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var file in manifest.ClearFiles)
        {
            if (file is null || !EscrowPaths.IsSafe(file.Path)) return "clearFiles[].path is not a safe relative path";
            if (!IsLowerSha256(file.Sha256)) return "clearFiles[].sha256 is not a lowercase SHA-256";
            if (file.Bytes < 0) return "clearFiles[].bytes is out of range";
            if (!seen.Add(file.Path)) return $"'{EscrowPaths.Printable(file.Path)}' is listed twice";
        }
        foreach (var path in manifest.EncryptedFiles)
        {
            if (path is null || !EscrowPaths.IsSafe(path)) return "encryptedFiles[] is not a safe relative path";
            if (!seen.Add(path)) return $"'{EscrowPaths.Printable(path)}' is listed twice";
        }
        if (!Decodes(manifest.SignerPublicKey, 32)) return "signerPublicKey is not 32 bytes of base64url";
        if (!Decodes(manifest.Signature, 64)) return "signature is not 64 bytes of base64url";
        if (manifest.Watermark is { } mark && (mark.Length > 256 || mark.Any(char.IsControl))) return "watermark is too long or holds a control character";
        return null;

        static bool Bounded(string? value, int maximum) => value is { Length: > 0 } && value.Length <= maximum && !value.Any(char.IsControl);
        static bool IsLowerSha256(string? value) => value is { Length: 64 } && value.All(static c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
        // No padding: the packer never writes it, and one spelling per value keeps a signer
        // comparison a plain string comparison.
        static bool Decodes(string? value, int length)
        {
            if (value is null || value.Length > 4096 || value.Any(static c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))) return false;
            try { return Base64Url.Decode(value).Length == length; }
            catch (FormatException) { return false; }
        }
    }

    /// <summary>The clear files that are missing or differ from the signed release, in manifest
    /// order. Empty when the folder (or the archive) holds exactly what was signed.</summary>
    public IReadOnlyList<string> EditedClearFiles()
    {
        var edited = new List<string>();
        foreach (var file in Manifest.ClearFiles)
            if (!_clear.TryGetValue(file.Path, out var bytes) || !FixedTimeHexEquals(SHA256.HashData(bytes), file.Sha256))
                edited.Add(file.Path);
        return edited;
    }

    /// <summary>The one line an installed folder holds at the path of an encrypted file, without
    /// its line ending. A stub names the release and the payload, so replacing the payload changes
    /// every stub (and with them whatever digest a host computes over the folder).</summary>
    public string StubLine(string path) =>
        $"-- {EscrowFormat.Format} {Manifest.Package}@{Manifest.Version} sha256={Manifest.Payload.Sha256} path={path}";

    /// <summary>True when <paramref name="fileBytes"/> is exactly the stub of <paramref name="path"/>
    /// for this release (a byte-order mark and surrounding blank space are ignored). A host that
    /// loads scripts from disk must never execute the file at an encrypted path; checking it is the
    /// stub tells an operator early that the folder was altered.</summary>
    public bool IsStub(string path, ReadOnlySpan<byte> fileBytes)
    {
        if (fileBytes.Length > 4096) return false;
        string text;
        try { text = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(fileBytes); }
        catch (ArgumentException) { return false; }
        return text.Trim('﻿', ' ', '\t', '\r', '\n') == StubLine(path);
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
        catch (Exception e) when (e is JsonException or InvalidDataException) { return (false, "escrow.json is not canonicalisable: " + e.Message); }
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
    public string CanonicalManifestWithoutSignature() => CanonicalManifest(_escrowJsonRaw);

    /// <summary>The text a release signature covers, for the bytes of an <c>escrow.json</c>: keys
    /// sorted recursively, no insignificant white space, the top-level <c>signature</c> emptied.
    /// A packer written in .NET signs exactly this.</summary>
    /// <exception cref="InvalidDataException">The bytes are not a JSON object with a string
    /// <c>signature</c>, or hold something JavaScript would not write back identically (a repeated
    /// key, a number that is not a plain integer): see <see cref="EscrowCanonicalJson"/>.</exception>
    public static string CanonicalManifest(ReadOnlyMemory<byte> escrowJson) =>
        Encoding.UTF8.GetString(EscrowCanonicalJson.ForSignature(escrowJson));

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
