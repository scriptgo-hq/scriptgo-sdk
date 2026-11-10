using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ScriptGo.Escrow;
using ScriptGo.Escrow.Managed;

namespace ScriptGo.Host.Tests;

/// <summary>The cross-language escrow vector (packages/escrow/tools/gen-vectors.ts): one bundle built
/// by the TypeScript packer that the managed loader, the native loader and these tests all open.</summary>
internal sealed record EscrowVector(
    string package, string version, string aad, string signingSeedHex, string signerPublicKeyB64Url,
    string contentKeyHex, string serverPublicHex, string serverPrivateHex,
    WrappedKey wrappedKey, string bundleB64, string? watermark,
    Dictionary<string, string> expectedFiles, List<string> encryptedFiles, string canonicalManifest,
    Dictionary<string, EscrowVector.HostilePayload> hostile, EscrowVector.X25519Probe x25519Probe)
{
    internal sealed record X25519Probe(string probePrivateHex, string probePublicHex, string sharedHex);
    internal sealed record HostilePayload(string nonceHex, string payloadHex, string sha256Hex);

    private static readonly Lazy<EscrowVector> Loaded = new(() =>
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ScriptGo.Host.Tests.escrow-vector.json")
            ?? throw new InvalidOperationException("escrow-vector.json fixture is missing (run packages/escrow/tools/gen-vectors.ts).");
        return JsonSerializer.Deserialize<EscrowVector>(stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    });

    public static EscrowVector Load() => Loaded.Value;

    public byte[] Bundle => Convert.FromBase64String(bundleB64);
    public byte[] ContentKey => Convert.FromHexString(contentKeyHex);
    public byte[] ServerPrivate => Convert.FromHexString(serverPrivateHex);
    public byte[] ServerPublic => Convert.FromHexString(serverPublicHex);

    /// <summary>The identity the vector's wrapped key was made for.</summary>
    public EscrowIdentity ServerIdentity(EscrowBackend backend) => EscrowIdentity.ImportPrivateKey(ServerPrivate, backend);
}

internal static class EscrowKit
{
    public static readonly EscrowBackend[] Backends = [EscrowBackend.Native, EscrowBackend.Managed];

    /// <summary>On Windows x64 the native library is part of the build and its absence is a failure.
    /// Elsewhere it has not been built yet (sdk/native/README.md), so native tests are inconclusive.</summary>
    public static void RequireNative()
    {
        if (EscrowNativeLibrary.IsAvailable) return;
        var message = "libscriptgo is not available: " + EscrowNativeLibrary.UnavailableReason;
        if (OperatingSystem.IsWindows() && System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture == System.Runtime.InteropServices.Architecture.X64)
            Assert.Fail(message + " Build it with sdk/native/build.ps1, then rebuild.");
        Assert.Inconclusive(message);
    }

    // ------------------------------------------------------------------ key services for tests

    /// <summary>Answers every request with the same result and counts the requests.</summary>
    public sealed class ScriptedKeyService(Func<EscrowManifest, EscrowIdentity, EscrowKeyResult> answer) : IEscrowKeyService
    {
        public int Requests { get; private set; }
        public Task<EscrowKeyResult> RequestKeyAsync(EscrowManifest manifest, EscrowIdentity identity, CancellationToken cancellation = default)
        {
            Requests++;
            return Task.FromResult(answer(manifest, identity));
        }
    }

    /// <summary>The vector's own wrapped key: only the vector's server identity can unwrap it.</summary>
    public static ScriptedKeyService VectorKeys(EscrowVector v, DateTimeOffset? expiresAt = null, DateTimeOffset? graceUntil = null) =>
        new((_, _) => EscrowKeyResult.Granted(v.wrappedKey, "{\"token\":\"delivery-abc\"}", expiresAt, graceUntil));

    /// <summary>What the master does: wraps the stored content key to whatever identity asks.</summary>
    public static ScriptedKeyService MasterLike(byte[] contentKey) =>
        new((manifest, identity) => EscrowKeyResult.Granted(Wrap(contentKey, identity.PublicKey, Encoding.UTF8.GetBytes(manifest.Aad)), "{\"token\":\"delivery-abc\"}"));

    /// <summary>Wraps a content key to an X25519 public key the same way packages/escrow does
    /// (ECIES: ephemeral X25519 + HKDF-SHA256 + AES-256-GCM), to drive a loader without the master.</summary>
    public static WrappedKey Wrap(byte[] contentKey, byte[] serverPublic, byte[] aad)
    {
        using var eph = NSec.Cryptography.Key.Create(NSec.Cryptography.KeyAgreementAlgorithm.X25519,
            new NSec.Cryptography.KeyCreationParameters { ExportPolicy = NSec.Cryptography.KeyExportPolicies.AllowPlaintextExport });
        var ephPublic = eph.PublicKey.Export(NSec.Cryptography.KeyBlobFormat.RawPublicKey);
        var ephPrivate = eph.Export(NSec.Cryptography.KeyBlobFormat.RawPrivateKey);
        var shared = ManagedCrypto.X25519Agree(ephPrivate, serverPublic);
        var salt = ephPublic.Concat(serverPublic).ToArray();
        var kek = HKDF.DeriveKey(HashAlgorithmName.SHA256, shared, 32, salt, "scriptgo.escrow.keywrap.v1"u8.ToArray());
        var nonce = RandomNumberGenerator.GetBytes(12);
        var ct = new byte[contentKey.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(kek, 16);
        aes.Encrypt(nonce, contentKey, ct, tag, aad);
        return new WrappedKey(Base64Url.Encode(ephPublic), Base64Url.Encode(nonce), Base64Url.Encode(ct.Concat(tag).ToArray()));
    }

    // ------------------------------------------------------------------ building bundles in tests

    public static byte[] Zip(IEnumerable<(string Path, byte[] Data)> entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (path, data) in entries)
            {
                var entry = archive.CreateEntry(path, CompressionLevel.Optimal);
                using var stream = entry.Open();
                stream.Write(data);
            }
        }
        return buffer.ToArray();
    }

    public static Dictionary<string, byte[]> Unzip(byte[] zip)
    {
        var files = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        using var archive = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read);
        foreach (var entry in archive.Entries)
        {
            using var stream = entry.Open();
            using var copy = new MemoryStream();
            stream.CopyTo(copy);
            files[entry.FullName] = copy.ToArray();
        }
        return files;
    }

    /// <summary>The vector bundle with some outer entries replaced, NOT re-signed (a tampering test).</summary>
    public static byte[] Tamper(EscrowVector v, Action<Dictionary<string, byte[]>> change)
    {
        var files = Unzip(v.Bundle);
        change(files);
        return Zip(files.Select(f => (f.Key, f.Value)));
    }

    /// <summary>
    /// A new, correctly signed bundle under the vector's keys: <paramref name="payload"/> is the
    /// ciphertext to ship, described by <paramref name="payloadNonce"/>; the manifest is re-signed with
    /// the vector's signing seed. This is how the hostile payloads of the vector (authentic ciphertext
    /// over a bad archive) reach a loader with a valid signature in front of them.
    /// </summary>
    public static byte[] Signed(EscrowVector v, byte[] payload, byte[] payloadNonce, IEnumerable<string>? encryptedFiles = null,
        IEnumerable<(string Path, byte[] Data)>? clearFiles = null)
    {
        var original = Unzip(v.Bundle);
        var clear = clearFiles?.ToList() ?? original.Where(f => f.Key is not ("escrow.json" or "payload.enc")).Select(f => (f.Key, f.Value)).ToList();
        var manifest = JsonNode.Parse(original["escrow.json"])!.AsObject();
        manifest["payload"] = new JsonObject
        {
            ["nonce"] = Base64Url.Encode(payloadNonce),
            ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(payload)),
            ["bytes"] = payload.Length,
        };
        manifest["clearFiles"] = new JsonArray(clear.Select(f => (JsonNode)new JsonObject
        {
            ["path"] = f.Path,
            ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(f.Data)),
            ["bytes"] = f.Data.Length,
        }).ToArray());
        if (encryptedFiles is not null) manifest["encryptedFiles"] = new JsonArray(encryptedFiles.Select(p => (JsonNode)p).ToArray());
        manifest["signature"] = "";

        byte[] Assemble() => Zip(clear.Append(("escrow.json", Encoding.UTF8.GetBytes(manifest.ToJsonString()))).Append(("payload.enc", payload)));
        // Sign exactly the bytes the loader will canonicalise from this manifest.
        var canonical = EscrowBundle.Read(Assemble()).CanonicalManifestWithoutSignature();
        using var key = NSec.Cryptography.Key.Import(NSec.Cryptography.SignatureAlgorithm.Ed25519,
            Convert.FromHexString(v.signingSeedHex), NSec.Cryptography.KeyBlobFormat.RawPrivateKey);
        manifest["signature"] = Base64Url.Encode(NSec.Cryptography.SignatureAlgorithm.Ed25519.Sign(key, Encoding.UTF8.GetBytes(canonical)));
        return Assemble();
    }

    /// <summary>A signed bundle whose encrypted payload holds <paramref name="encrypted"/>.</summary>
    public static byte[] Pack(EscrowVector v, IEnumerable<(string Path, string Content)> clear, IEnumerable<(string Path, string Content)> encrypted)
    {
        var inner = Zip(encrypted.Select(f => (f.Path, Encoding.UTF8.GetBytes(f.Content))));
        var nonce = RandomNumberGenerator.GetBytes(12);
        var ciphertext = new byte[inner.Length];
        var tag = new byte[16];
        using (var aes = new AesGcm(v.ContentKey, 16)) aes.Encrypt(nonce, inner, ciphertext, tag, Encoding.UTF8.GetBytes(v.aad));
        return Signed(v, ciphertext.Concat(tag).ToArray(), nonce, encrypted.Select(f => f.Path),
            clear.Select(f => (f.Path, Encoding.UTF8.GetBytes(f.Content))));
    }
}

/// <summary>A clock the test moves, with working timers, so the renewal loop can be driven without
/// waiting for real time.</summary>
internal sealed class ManualTimeProvider(DateTimeOffset start) : TimeProvider
{
    private readonly object _gate = new();
    private readonly List<ManualTimer> _timers = [];
    private DateTimeOffset _now = start;

    public override DateTimeOffset GetUtcNow() { lock (_gate) return _now; }

    public override long GetTimestamp() { lock (_gate) return _now.UtcTicks; }

    public override long TimestampFrequency => TimeSpan.TicksPerSecond;

    public void Advance(TimeSpan by)
    {
        DateTimeOffset target;
        lock (_gate) target = _now + by;
        while (true)
        {
            ManualTimer? due;
            lock (_gate)
            {
                due = _timers.Where(t => t.Due <= target).OrderBy(t => t.Due).FirstOrDefault();
                if (due is null) { _now = target; return; }
                if (due.Due > _now) _now = due.Due;
                due.Due = DateTimeOffset.MaxValue; // one-shot: Task.Delay never asks for a period
            }
            due.Fire();
        }
    }

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = new ManualTimer(this, callback, state);
        timer.Change(dueTime, period);
        lock (_gate) _timers.Add(timer);
        return timer;
    }

    private sealed class ManualTimer(ManualTimeProvider owner, TimerCallback callback, object? state) : ITimer
    {
        public DateTimeOffset Due = DateTimeOffset.MaxValue;

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            lock (owner._gate) Due = dueTime == Timeout.InfiniteTimeSpan ? DateTimeOffset.MaxValue : owner._now + dueTime;
            return true;
        }

        public void Fire() => callback(state);

        public void Dispose() { lock (owner._gate) owner._timers.Remove(this); }

        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
