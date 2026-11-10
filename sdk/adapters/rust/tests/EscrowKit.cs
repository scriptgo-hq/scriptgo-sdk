// Test-only helpers for the escrow tests: a packer that builds an escrow release the way
// packages/escrow/src/escrow.ts does (docs/spec/escrow.md), the on-disk layout an installer writes,
// and a fake key service answering POST /v1/licenses/key like packages/licensing does.
//
// The crypto here belongs to the TEST project only: NSec (libsodium) for X25519 and ed25519,
// System.Security.Cryptography for AES-256-GCM. The bridge itself carries no managed crypto: every
// key operation of the code under test happens inside the native library.
using System.Buffers;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using NSec.Cryptography;
using ScriptGo.Bridge;

internal static class B64
{
    public static string Url(ReadOnlySpan<byte> bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] FromUrl(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        switch (t.Length % 4) { case 2: t += "=="; break; case 3: t += "="; break; }
        return Convert.FromBase64String(t);
    }
}

/// <summary>Canonical JSON written independently of the bridge (System.Text.Json), after the .NET kit's EscrowBundle.</summary>
internal static class ReferenceCanonical
{
    public static string Of(string json, bool emptyRootSignature)
    {
        using var doc = JsonDocument.Parse(json);
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Indented = false, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
            Write(writer, doc.RootElement, emptyRootSignature);
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void Write(Utf8JsonWriter writer, JsonElement element, bool root)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    if (root && property.Name == "signature") writer.WriteStringValue("");
                    else Write(writer, property.Value, false);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray()) Write(writer, item, false);
                writer.WriteEndArray();
                break;
            default:
                element.WriteTo(writer);
                break;
        }
    }
}

/// <summary>An escrow release built in C#: the signed manifest, the encrypted payload and the clear files.</summary>
internal sealed class EscrowRelease
{
    public string Resource = "", Package = "", Version = "";
    public byte[] ContentKey = Array.Empty<byte>();
    public string SignerPublicKey = "";
    public string EscrowJson = "";
    public byte[] Payload = Array.Empty<byte>();
    public string PayloadSha256 = "";
    public readonly SortedDictionary<string, byte[]> Clear = new(StringComparer.Ordinal);
    public readonly List<string> Encrypted = new();

    public string Aad => Package + "@" + Version;

    public static EscrowRelease Build(string resource, string package, string version,
        Dictionary<string, string> clearFiles, Dictionary<string, string> encryptedFiles, byte[] signingSeed = null)
    {
        var r = new EscrowRelease { Resource = resource, Package = package, Version = version, ContentKey = RandomNumberGenerator.GetBytes(32) };
        signingSeed ??= Seed(1);
        foreach (var f in clearFiles) r.Clear[f.Key] = Encoding.UTF8.GetBytes(f.Value);
        r.Encrypted.AddRange(encryptedFiles.Keys.OrderBy(k => k, StringComparer.Ordinal));

        byte[] inner;
        using (var ms = new MemoryStream())
        {
            using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, true))
            {
                foreach (var path in r.Encrypted)
                {
                    var entry = zip.CreateEntry(path, CompressionLevel.Optimal);
                    using var s = entry.Open();
                    var bytes = Encoding.UTF8.GetBytes(encryptedFiles[path]);
                    s.Write(bytes, 0, bytes.Length);
                }
            }
            inner = ms.ToArray();
        }
        var nonce = RandomNumberGenerator.GetBytes(12);
        var aad = Encoding.UTF8.GetBytes(r.Aad);
        r.Payload = Seal(r.ContentKey, nonce, inner, aad);
        r.PayloadSha256 = Convert.ToHexStringLower(SHA256.HashData(r.Payload));

        using var key = Key.Import(SignatureAlgorithm.Ed25519, signingSeed, KeyBlobFormat.RawPrivateKey);
        r.SignerPublicKey = B64.Url(key.PublicKey.Export(KeyBlobFormat.RawPublicKey));
        var manifest = new JsonObject
        {
            ["format"] = "scriptgo-escrow/1",
            ["package"] = package,
            ["version"] = version,
            ["cipher"] = "AES-256-GCM",
            ["kdf"] = "HKDF-SHA256+X25519",
            ["aad"] = r.Aad,
            ["payload"] = new JsonObject { ["nonce"] = B64.Url(nonce), ["sha256"] = r.PayloadSha256, ["bytes"] = r.Payload.Length },
            ["clearFiles"] = new JsonArray(r.Clear.Select(f => (JsonNode)new JsonObject
            {
                ["path"] = f.Key, ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(f.Value)), ["bytes"] = f.Value.Length,
            }).ToArray()),
            ["encryptedFiles"] = new JsonArray(r.Encrypted.Select(p => (JsonNode)JsonValue.Create(p)).ToArray()),
            ["allowlist"] = new JsonArray("scriptgo.lua", "README.md", "config.lua"),
            ["signerPublicKey"] = r.SignerPublicKey,
            ["watermark"] = null,
            ["signature"] = "",
        };
        var options = new JsonSerializerOptions { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        var unsigned = manifest.ToJsonString(options);
        manifest["signature"] = B64.Url(SignatureAlgorithm.Ed25519.Sign(key, Encoding.UTF8.GetBytes(ReferenceCanonical.Of(unsigned, true))));
        r.EscrowJson = manifest.ToJsonString(options) + "\n";
        return r;
    }

    public static byte[] Seed(byte fill)
    {
        var seed = new byte[32];
        Array.Fill(seed, fill);
        return seed;
    }

    private static byte[] Seal(byte[] key, byte[] nonce, byte[] plaintext, byte[] aad)
    {
        var body = new byte[plaintext.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(nonce, plaintext, body, tag, aad);
        return body.Concat(tag).ToArray();
    }

    /// <summary>The line an installer writes at the path of an encrypted script.</summary>
    public string Stub(string path) => $"-- scriptgo-escrow/1 {Package}@{Version} sha256={PayloadSha256} path={path}\n";

    /// <summary>
    /// Writes the on-disk layout under <paramref name="searchDir"/>/<resource>/: the clear files,
    /// escrow.json, payload.enc and a stub at the path of every encrypted .lua file. Returns the folder.
    /// </summary>
    public string Install(string searchDir)
    {
        var root = Path.Combine(searchDir, Resource);
        void Put(string rel, byte[] bytes)
        {
            var p = Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(p)!);
            File.WriteAllBytes(p, bytes);
        }
        foreach (var f in Clear) Put(f.Key, f.Value);
        Put("escrow.json", Encoding.UTF8.GetBytes(EscrowJson));
        Put("payload.enc", Payload);
        foreach (var path in Encrypted.Where(p => p.EndsWith(".lua", StringComparison.Ordinal))) Put(path, Encoding.UTF8.GetBytes(Stub(path)));
        return root;
    }

    /// <summary>The content key wrapped to a server's X25519 public key (ECIES, docs/spec/escrow.md).</summary>
    public static (string epk, string nonce, string wrapped) Wrap(byte[] contentKey, byte[] serverPublic, string aad)
    {
        var algorithm = KeyAgreementAlgorithm.X25519;
        using var ephemeral = Key.Create(algorithm);
        var epk = ephemeral.PublicKey.Export(KeyBlobFormat.RawPublicKey);
        var server = PublicKey.Import(algorithm, serverPublic, KeyBlobFormat.RawPublicKey);
        using var shared = algorithm.Agree(ephemeral, server) ?? throw new CryptographicException("X25519 agreement failed");
        var kek = KeyDerivationAlgorithm.HkdfSha256.DeriveBytes(shared, epk.Concat(serverPublic).ToArray(), "scriptgo.escrow.keywrap.v1"u8, 32);
        var nonce = RandomNumberGenerator.GetBytes(12);
        return (B64.Url(epk), B64.Url(nonce), B64.Url(Seal(kek, nonce, contentKey, Encoding.UTF8.GetBytes(aad))));
    }
}

/// <summary>A clock the tests move: the wall clock decides renewals and the end of a grace.</summary>
internal sealed class FakeClock : IHostClock
{
    public double Mono;
    public long Unix = 1_800_000_000;
    public double MonotonicMilliseconds() => Mono;
    public long? UnixSeconds() => Unix;
}

/// <summary>
/// The key service, faked after packages/licensing releaseKey: a deployment token names a licence of
/// one package; the first server public key seen is bound; another key is "unbound". Not a network
/// server: it answers through IHostHttp, on a later tick, like Oxide's web requests.
/// </summary>
internal sealed class FakeMaster : IHostHttp
{
    public sealed class License
    {
        public EscrowRelease Release;
        /// <summary>"active", or a refusal reason: revoked, refunded, expired, deactivated, unknown_key...</summary>
        public string State = "active";
        public string BoundKey;
        /// <summary>Wrap the key to this public key instead of the caller's (a key released to another server).</summary>
        public byte[] WrapTo;
        /// <summary>Name this signer instead of the release's own.</summary>
        public string SignerOverride;
    }

    private readonly FakeClock _clock;
    public readonly ConcurrentDictionary<string, License> Licenses = new();
    public readonly ConcurrentQueue<HttpRequestData> Seen = new();
    public long TtlSeconds = 900, GraceSeconds = 3600;
    /// <summary>0: answer normally. Otherwise this HTTP status (503...), or -1 for no answer at all.</summary>
    public volatile int Fault;
    /// <summary>Hold every answer until <see cref="Release"/> is called (to observe "pending_key").</summary>
    public volatile bool Hold;
    private readonly ConcurrentQueue<Action> _held = new();

    public FakeMaster(FakeClock clock) { _clock = clock; }

    public int Requests => Seen.Count;

    public License Grant(string token, EscrowRelease release)
    {
        var license = new License { Release = release };
        Licenses[token] = license;
        return license;
    }

    public void Release()
    {
        Hold = false;
        while (_held.TryDequeue(out var send)) send();
    }

    public Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation)
    {
        Seen.Enqueue(request);
        var done = new TaskCompletionSource<HttpResponseData>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Answer()
        {
            try { done.TrySetResult(Respond(request)); }
            catch (Exception e) { done.TrySetException(e); }
        }
        if (Hold) _held.Enqueue(Answer); else Answer();
        return done.Task;
    }

    private static HttpResponseData Json(string body) => new(200, new Dictionary<string, string>(), body);

    private static string Refuse(string reason) =>
        "{\"valid\":false,\"reason\":\"" + reason + "\",\"wrappedKey\":null,\"aad\":null,\"signerPublicKey\":null,\"deliveryWatermark\":null,\"offlineGraceUntil\":null,\"expiresAt\":null}";

    private HttpResponseData Respond(HttpRequestData request)
    {
        int fault = Fault;
        if (fault == -1) return new HttpResponseData(0, null, "");
        if (fault != 0) return new HttpResponseData(fault, null, "{\"error\":{\"code\":\"unavailable\"}}");
        if (request.Method != "POST" || !request.Url.EndsWith("/v1/licenses/key", StringComparison.Ordinal)) return new HttpResponseData(404, null, "{}");
        using var doc = JsonDocument.Parse(request.Body);
        var body = doc.RootElement;
        var token = body.GetProperty("deploymentToken").GetString() ?? "";
        if (!Licenses.TryGetValue(token, out var license) || license.Release.Package != body.GetProperty("package").GetString())
            return Json(Refuse("unknown_key"));
        if (license.State != "active") return Json(Refuse(license.State));
        if (body.GetProperty("environment").GetString() != "rust") return Json(Refuse("environment_not_covered"));
        var serverKey = body.GetProperty("serverPublicKey").GetString() ?? "";
        if (license.BoundKey == null) license.BoundKey = serverKey;
        else if (license.BoundKey != serverKey) return Json(Refuse("unbound"));
        if (license.Release.Version != body.GetProperty("version").GetString()) return Json(Refuse("not_escrowed"));

        var release = license.Release;
        var (epk, nonce, wrapped) = EscrowRelease.Wrap(release.ContentKey, license.WrapTo ?? B64.FromUrl(license.BoundKey), release.Aad);
        string Iso(long unix) => DateTimeOffset.FromUnixTimeSeconds(unix).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
        long now = _clock.Unix;
        var answer = new JsonObject
        {
            ["valid"] = true,
            ["reason"] = null,
            ["wrappedKey"] = new JsonObject { ["epk"] = epk, ["nonce"] = nonce, ["wrapped"] = wrapped },
            ["aad"] = release.Aad,
            ["signerPublicKey"] = license.SignerOverride ?? release.SignerPublicKey,
            ["deliveryWatermark"] = "wm-" + token,
            ["offlineGraceUntil"] = Iso(now + GraceSeconds),
            ["expiresAt"] = Iso(now + TtlSeconds),
        };
        return Json(answer.ToJsonString());
    }
}

/// <summary>The two native calls the tests need and the bridge deliberately does not declare.</summary>
internal static class NativeIdentity
{
    [DllImport("scriptgo", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sg_identity_import(byte[] privateKey, out IntPtr identity);

    [DllImport("scriptgo", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sg_identity_save(IntPtr identity, byte[] pathUtf8, int replace);

    [DllImport("scriptgo", CallingConvention = CallingConvention.Cdecl)]
    private static extern void sg_identity_free(IntPtr identity);

    /// <summary>Writes an identity file holding a known private key (the cross-language vector's).</summary>
    public static void Save(byte[] privateKey, string path)
    {
        int rc = sg_identity_import(privateKey, out var identity);
        if (rc != 0) throw new Exception("sg_identity_import: " + rc);
        try
        {
            rc = sg_identity_save(identity, Encoding.UTF8.GetBytes(path + "\0"), 1);
            if (rc != 0) throw new Exception("sg_identity_save: " + rc);
        }
        finally { sg_identity_free(identity); }
    }
}
