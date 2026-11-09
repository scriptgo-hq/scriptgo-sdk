using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ScriptGo.Host.Escrow;

namespace ScriptGo.Host.Tests;

/// <summary>Proves the .NET loader agrees with the TypeScript packer (cross-language vector) and runs
/// an escrowed resource end to end: content key wrapped to a bound server, decrypted only in memory,
/// refused on an unbound server and on a revoked/refused key.</summary>
[TestClass]
public sealed class EscrowTests
{
    private sealed record Vector(
        string package, string version, string aad, string signerPublicKeyB64Url,
        string contentKeyHex, string serverPublicHex, string serverPrivateHex,
        WrappedKey wrappedKey, string bundleB64, string? watermark,
        Dictionary<string, string> expectedFiles, X25519Probe x25519Probe);

    private sealed record X25519Probe(string probePrivateHex, string probePublicHex, string sharedHex);

    private static Vector Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ScriptGo.Host.Tests.escrow-vector.json")
            ?? throw new InvalidOperationException("escrow-vector.json fixture is missing (run packages/escrow/tools/gen-vectors.ts).");
        return JsonSerializer.Deserialize<Vector>(stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    }

    [TestMethod]
    public void X25519AgreesWithNodeOnTheVector()
    {
        var v = Load();
        var shared = EscrowCrypto.X25519Agree(Convert.FromHexString(v.x25519Probe.probePrivateHex), Convert.FromHexString(v.serverPublicHex));
        Assert.AreEqual(v.x25519Probe.sharedHex, Convert.ToHexStringLower(shared), "NSec X25519 must match Node's diffieHellman.");
    }

    [TestMethod]
    public void DecryptsTheVectorBundleWithTheContentKey()
    {
        var v = Load();
        var bundle = EscrowBundle.Read(Convert.FromBase64String(v.bundleB64));
        Assert.AreEqual(v.signerPublicKeyB64Url, bundle.Manifest.SignerPublicKey);
        Assert.IsTrue(bundle.Verify(v.signerPublicKeyB64Url).Ok, "the ed25519 signature must verify (canonical JSON parity).");

        var files = bundle.Open(Convert.FromHexString(v.contentKeyHex), v.signerPublicKeyB64Url);
        foreach (var (path, content) in v.expectedFiles)
            Assert.AreEqual(content, Encoding.UTF8.GetString(files[path]), $"decrypted {path} must match the TS plaintext.");
    }

    [TestMethod]
    public void UnwrapsTheVectorKeyWithTheServerIdentity()
    {
        var v = Load();
        using var identity = EscrowServerIdentity.FromRaw(Convert.FromHexString(v.serverPrivateHex), Convert.FromHexString(v.serverPublicHex));
        var contentKey = identity.Unwrap(v.wrappedKey, Encoding.UTF8.GetBytes(v.aad));
        Assert.AreEqual(v.contentKeyHex, Convert.ToHexStringLower(contentKey), "the unwrapped key must be the vector content key.");
    }

    [TestMethod]
    public void RefusesAnUntrustedSignerAndTamperedPayload()
    {
        var v = Load();
        var bundle = EscrowBundle.Read(Convert.FromBase64String(v.bundleB64));
        // A different pinned trusted key is refused (provenance, not just integrity).
        Assert.IsFalse(bundle.Verify("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").Ok);
        // A wrong content key fails the AEAD tag (AuthenticationTagMismatchException : CryptographicException).
        Assert.Throws<CryptographicException>(() => bundle.Open(new byte[32], v.signerPublicKeyB64Url));
    }

    // ---------------- end-to-end through the host via a fake key service

    private sealed class FakeKeyService(byte[] contentKey, bool valid, string? reason = null, bool transport = false) : IEscrowKeyService
    {
        public Task<EscrowKeyResult> RequestKeyAsync(EscrowManifest manifest, EscrowServerIdentity identity, CancellationToken ct = default)
        {
            if (transport) return Task.FromResult(EscrowKeyResult.Unreachable("api_unreachable"));
            if (!valid) return Task.FromResult(EscrowKeyResult.Refused(reason ?? "revoked"));
            // The master wraps the stored content key to the server's registered public key.
            var wrapped = TsLikeWrap(contentKey, identity.PublicKey, Encoding.UTF8.GetBytes(manifest.Aad));
            return Task.FromResult(EscrowKeyResult.Granted(wrapped, "{\"token\":\"delivery-abc\"}"));
        }
    }

    /// <summary>Wraps a content key to an X25519 public key the same way packages/escrow does
    /// (ECIES: ephemeral X25519 + HKDF-SHA256 + AES-256-GCM), to drive the loader without the master.</summary>
    private static WrappedKey TsLikeWrap(byte[] contentKey, byte[] serverPublic, byte[] aad)
    {
        using var eph = NSec.Cryptography.Key.Create(NSec.Cryptography.KeyAgreementAlgorithm.X25519,
            new NSec.Cryptography.KeyCreationParameters { ExportPolicy = NSec.Cryptography.KeyExportPolicies.AllowPlaintextExport });
        var ephPublic = eph.PublicKey.Export(NSec.Cryptography.KeyBlobFormat.RawPublicKey);
        var ephPrivate = eph.Export(NSec.Cryptography.KeyBlobFormat.RawPrivateKey);
        var shared = EscrowCrypto.X25519Agree(ephPrivate, serverPublic);
        var salt = ephPublic.Concat(serverPublic).ToArray();
        var kek = Hkdf(shared, salt, "scriptgo.escrow.keywrap.v1"u8.ToArray(), 32);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var ct = new byte[contentKey.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(kek, 16);
        aes.Encrypt(nonce, contentKey, ct, tag, aad);
        return new WrappedKey(Base64Url.Encode(ephPublic), Base64Url.Encode(nonce), Base64Url.Encode(ct.Concat(tag).ToArray()));
    }

    private static byte[] Hkdf(byte[] ikm, byte[] salt, byte[] info, int length)
    {
        using var hmac = new HMACSHA256(salt);
        var prk = hmac.ComputeHash(ikm);
        using var expand = new HMACSHA256(prk);
        var okm = new List<byte>();
        byte[] t = [];
        for (byte i = 1; okm.Count < length; i++)
        {
            expand.Initialize();
            t = expand.ComputeHash(t.Concat(info).Append(i).ToArray());
            okm.AddRange(t);
        }
        return okm.Take(length).ToArray();
    }

    private static async Task<(EscrowLoadResult result, ScriptGoHost host, EscrowResourceFiles files, CaptureLog log)> RunLoader(IEscrowKeyService service, EscrowServerIdentity identity)
    {
        var v = Load();
        var files = new EscrowResourceFiles();
        var log = new CaptureLog();
        var services = new HostServices { Log = log, Files = files };
        var host = new ScriptGoHost(services, new HostOptions { Environment = "dotnet" });
        var result = await EscrowLoader.LoadAsync(Convert.FromBase64String(v.bundleB64), files, identity, service, v.signerPublicKeyB64Url);
        return (result, host, files, log);
    }

    [TestMethod]
    public async Task RunsAnEscrowedResourceOnABoundHost()
    {
        var v = Load();
        using var identity = EscrowServerIdentity.Generate();
        var (result, host, files, log) = await RunLoader(new FakeKeyService(Convert.FromHexString(v.contentKeyHex), valid: true), identity);
        using (host)
        {
            Assert.IsTrue(result.Ok, "the bound host must load the escrowed resource: " + result.Reason);
            var name = host.AddResource(result.ResourceRoot!, checkFolderName: false);
            Assert.AreEqual("demo", name);
            var started = host.Start(name);
            Assert.IsTrue(started.Ok, started.Reason + "\n" + log);
            host.RunFor(50);
            Assert.IsTrue(log.Has("escrow secret ok"), "the decrypted server script must have run.\n" + log);
            // The per-delivery watermark marker is present in the materialized resource.
            Assert.IsNotNull(files.Read(result.ResourceRoot!, EscrowFormat.DeliveryMarker));
        }
    }

    [TestMethod]
    public async Task RefusesOnAnUnlicensedOrRevokedKey()
    {
        using var identity = EscrowServerIdentity.Generate();
        var (result, host, _, _) = await RunLoader(new FakeKeyService([], valid: false, reason: "revoked"), identity);
        using (host)
        {
            Assert.IsFalse(result.Ok);
            StringAssert.Contains(result.Reason, "refused:revoked");
        }
    }

    [TestMethod]
    public async Task RefusesWhenTheKeyUnwrapsToTheWrongServer()
    {
        var v = Load();
        // The master wrapped the key to a DIFFERENT server's public key; this server cannot unwrap it.
        using var boundServer = EscrowServerIdentity.Generate();
        var serviceForBound = new FakeKeyService(Convert.FromHexString(v.contentKeyHex), valid: true);
        using var thisServer = EscrowServerIdentity.Generate();
        var files = new EscrowResourceFiles();
        // Build a grant wrapped to boundServer, then try to load it with thisServer's identity.
        var grant = await serviceForBound.RequestKeyAsync(new EscrowBundleManifestProbe(v).Manifest, boundServer);
        var mismatched = new ConstantKeyService(grant);
        var result = await EscrowLoader.LoadAsync(Convert.FromBase64String(v.bundleB64), files, thisServer, mismatched, v.signerPublicKeyB64Url);
        Assert.IsFalse(result.Ok, "a key wrapped to another server must not unwrap here.");
        StringAssert.Contains(result.Reason, "unwrap_failed");
    }

    private sealed class ConstantKeyService(EscrowKeyResult result) : IEscrowKeyService
    {
        public Task<EscrowKeyResult> RequestKeyAsync(EscrowManifest manifest, EscrowServerIdentity identity, CancellationToken ct = default) => Task.FromResult(result);
    }

    // ---------------- Option A: materialize to a resources root and run from disk (as OPEN//77 does)

    [TestMethod]
    public async Task MaterializesAndRunsFromDiskLikeOpen77()
    {
        var v = Load();
        using var identity = EscrowServerIdentity.Generate();
        var resourcesRoot = Path.Combine(Path.GetTempPath(), "sg-escrow-materialize", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(resourcesRoot);
        try
        {
            var (ok, reason, dir) = await EscrowMaterializer.MaterializeAsync(
                Convert.FromBase64String(v.bundleB64), resourcesRoot, identity,
                new FakeKeyService(Convert.FromHexString(v.contentKeyHex), valid: true), v.signerPublicKeyB64Url);
            Assert.IsTrue(ok, "materialize must succeed: " + reason);
            Assert.AreEqual("demo", Path.GetFileName(dir));
            Assert.IsTrue(File.Exists(Path.Combine(dir!, "scriptgo.lua")), "the manifest must be on disk for a disk-reading host.");

            // A fresh host with the default FolderFiles loads the materialized folder from disk and runs it
            // — the same path OPEN//77's ServerResourceHost.Discover/ReadFromDisk uses. No core change.
            var log = new CaptureLog();
            using var host = new ScriptGoHost(new HostServices { Log = log }, new HostOptions { Environment = "dotnet" });
            var name = host.AddResource(dir!);
            Assert.IsTrue(host.Start(name).Ok, log.ToString());
            host.RunFor(50);
            Assert.IsTrue(log.Has("escrow secret ok"), "the decrypted script must run from the materialized folder.\n" + log);
        }
        finally { try { Directory.Delete(resourcesRoot, recursive: true); } catch (IOException) { } }
    }

    private sealed class EscrowBundleManifestProbe
    {
        public EscrowManifest Manifest { get; }
        public EscrowBundleManifestProbe(Vector v) => Manifest = EscrowBundle.Read(Convert.FromBase64String(v.bundleB64)).Manifest;
    }
}
