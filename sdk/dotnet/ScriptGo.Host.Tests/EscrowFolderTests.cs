using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using KeraLua;
using ScriptGo.Escrow;

namespace ScriptGo.Host.Tests;

/// <summary>
/// What a host with a main loop and resources on disk needs from the package: a release installed
/// as a folder (<see cref="EscrowBundle.ReadFolder"/>), an open that never waits on the network
/// (<see cref="EscrowSession.Open"/> with <see cref="EscrowKeyCache"/>), a refusal the key service
/// marked final, and the hardened HTTP reading of the key endpoint.
/// </summary>
[TestClass]
public sealed class EscrowFolderTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 10, 12, 0, 0, TimeSpan.Zero);
    private static readonly Lazy<LuaChunkLoader> Lua54 = new(() => LuaChunkLoader.FromLibraryName("lua54", typeof(Lua).Assembly));

    /// <summary>The vector release laid out the way <c>scriptgo escrow install</c> writes it.</summary>
    private sealed class Installed : IDisposable
    {
        public Installed(EscrowVector v, Action<JsonObject>? alterManifest = null)
        {
            Directory = Path.Combine(Path.GetTempPath(), "ScriptGo.Escrow.Tests", Guid.NewGuid().ToString("N"));
            var files = EscrowKit.Unzip(v.Bundle);
            foreach (var (path, bytes) in files)
            {
                var data = bytes;
                if (path == "escrow.json" && alterManifest is not null)
                {
                    var manifest = JsonNode.Parse(bytes)!.AsObject();
                    alterManifest(manifest);
                    data = Encoding.UTF8.GetBytes(manifest.ToJsonString());
                }
                Write(path, data);
            }
            var bundle = EscrowBundle.Read(v.Bundle);
            foreach (var path in bundle.Manifest.EncryptedFiles) Write(path, Encoding.UTF8.GetBytes(bundle.StubLine(path) + "\n"));
        }

        public string Directory { get; }

        public void Write(string relative, byte[] bytes)
        {
            var full = Path.Combine(Directory, relative.Replace('/', Path.DirectorySeparatorChar));
            System.IO.Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllBytes(full, bytes);
        }

        public void Dispose() => System.IO.Directory.Delete(Directory, true);
    }

    private static string Run(EscrowContent content, string path)
    {
        using var lua = new Lua();
        lua.OpenLibs();
        var chunk = content.LoadLuaChunk(lua.Handle, path, "@demo/" + path, Lua54.Value);
        Assert.IsTrue(chunk.Ok, chunk.Status.ToString());
        Assert.AreEqual(LuaStatus.OK, lua.PCall(0, 1, 0), lua.ToString(-1));
        return lua.ToString(-1) ?? "";
    }

    // ------------------------------------------------------------------ the folder

    [TestMethod]
    public async Task AnInstalledFolderOpensLikeTheArchiveAndItsStubsAreNeverTheScripts()
    {
        var v = EscrowVector.Load();
        foreach (var backend in EscrowKit.AvailableBackends())
        {
            using var folder = new Installed(v);
            var bundle = EscrowBundle.ReadFolder(folder.Directory);
            Assert.AreEqual(v.package, bundle.Manifest.Package);
            Assert.AreEqual(v.canonicalManifest, bundle.CanonicalManifestWithoutSignature(), "the folder's escrow.json signs the same bytes as the archive's");
            Assert.AreEqual(0, bundle.EditedClearFiles().Count);
            CollectionAssert.AreEquivalent(new[] { "README.md", "config.lua", "scriptgo.lua" }, bundle.ClearFiles.Keys.ToArray());

            // The file at an encrypted path is the stub, by construction, and is recognised as such.
            var stub = File.ReadAllBytes(Path.Combine(folder.Directory, "server", "main.lua"));
            Assert.IsTrue(bundle.IsStub("server/main.lua", stub));
            Assert.IsFalse(bundle.IsStub("server/secret.lua", stub), "a stub names its own path");
            Assert.IsFalse(bundle.IsStub("server/main.lua", "print('replaced')\n"u8));
            StringAssert.StartsWith(bundle.StubLine("server/main.lua"), $"-- scriptgo-escrow/1 {v.package}@{v.version} sha256=");

            using var identity = v.ServerIdentity(backend);
            using var content = await EscrowSession.OpenAsync(bundle, identity, EscrowKit.VectorKeys(v), v.signerPublicKeyB64Url);
            Assert.AreEqual(backend, content.Backend);
            using var lua = new Lua();
            Assert.IsTrue(content.LoadLuaChunk(lua.Handle, "server/main.lua", "@demo/server/main.lua", Lua54.Value).Ok, backend.ToString());
        }
    }

    [TestMethod]
    public async Task AnEditedClearFileIsRefusedUnlessTheHostAllowsThatPath()
    {
        var v = EscrowVector.Load();
        using var identity = v.ServerIdentity(EscrowBackend.Managed);
        using var folder = new Installed(v);
        folder.Write("config.lua", "Config = { edited = true }\n"u8.ToArray());
        var bundle = EscrowBundle.ReadFolder(folder.Directory);
        CollectionAssert.AreEqual(new[] { "config.lua" }, bundle.EditedClearFiles().ToArray());

        var keys = EscrowKit.VectorKeys(v);
        var strict = await Assert.ThrowsExactlyAsync<EscrowException>(() => EscrowSession.OpenAsync(bundle, identity, keys, v.signerPublicKeyB64Url));
        Assert.AreEqual(EscrowFailure.DecryptFailed, strict.Failure);
        StringAssert.Contains(strict.Reason, "config.lua");
        Assert.AreEqual(0, keys.Requests, "a refused folder never causes a key request");

        // The host lets an operator edit the config, never the resource manifest.
        var lenient = new EscrowOpenOptions { AllowEditedClearFile = static path => path != "scriptgo.lua" };
        using (var content = await EscrowSession.OpenAsync(bundle, identity, keys, v.signerPublicKeyB64Url, lenient))
            Assert.AreEqual("Config = { edited = true }\n", Encoding.UTF8.GetString(content.ClearFiles["config.lua"]), "the host reads what is on disk");

        folder.Write("scriptgo.lua", "resource 'someone_else'\n"u8.ToArray());
        var pinned = await Assert.ThrowsExactlyAsync<EscrowException>(() =>
            EscrowSession.OpenAsync(EscrowBundle.ReadFolder(folder.Directory), identity, keys, v.signerPublicKeyB64Url, lenient));
        StringAssert.Contains(pinned.Reason, "scriptgo.lua");

        // A missing clear file is an edited one.
        File.Delete(Path.Combine(folder.Directory, "README.md"));
        CollectionAssert.Contains(EscrowBundle.ReadFolder(folder.Directory).EditedClearFiles().ToArray(), "README.md");
    }

    [TestMethod]
    public void AFolderWhosePayloadOrManifestIsNotTheSignedOneIsRefusedByName()
    {
        var v = EscrowVector.Load();
        using (var folder = new Installed(v))
        {
            var payload = Path.Combine(folder.Directory, "payload.enc");
            var bytes = File.ReadAllBytes(payload);
            bytes[^1] ^= 0x40;
            File.WriteAllBytes(payload, bytes);
            var flipped = Assert.ThrowsExactly<EscrowException>(() => EscrowBundle.ReadFolder(folder.Directory));
            Assert.AreEqual("decrypt_failed:payload.enc does not match the signed hash", flipped.Reason);

            File.WriteAllBytes(payload, bytes[..^1]);
            Assert.AreEqual("decrypt_failed:payload.enc does not have the signed size",
                Assert.ThrowsExactly<EscrowException>(() => EscrowBundle.ReadFolder(folder.Directory)).Reason);

            File.Delete(payload);
            Assert.AreEqual(EscrowFailure.DecryptFailed, Assert.ThrowsExactly<EscrowException>(() => EscrowBundle.ReadFolder(folder.Directory)).Failure);
        }

        (Action<JsonObject> Change, string Expected)[] shapes =
        [
            (m => m["format"] = "scriptgo-escrow/9", "unsupported escrow format"),
            (m => m["cipher"] = "ROT13", "unsupported cipher or kdf"),
            (m => m["aad"] = "someone//else@1.0.0", "aad does not name this package and version"),
            (m => m["payload"]!["sha256"] = "ABCDEF", "payload.sha256"),
            (m => m["payload"]!["nonce"] = "AAAA", "payload.nonce"),
            (m => m["clearFiles"]!.AsArray().Add(new JsonObject { ["path"] = "../outside.lua", ["sha256"] = new string('a', 64), ["bytes"] = 1 }), "clearFiles[].path"),
            (m => m["encryptedFiles"]!.AsArray().Add("config.lua"), "listed twice"),
            (m => m["encryptedFiles"]!.AsArray().Add("C:/abs.lua"), "encryptedFiles[]"),
            (m => m["signerPublicKey"] = "not-a-key", "signerPublicKey"),
            (m => m["signature"] = "AAAA", "signature"),
        ];
        foreach (var (change, expected) in shapes)
        {
            using var folder = new Installed(v, change);
            var e = Assert.ThrowsExactly<EscrowException>(() => EscrowBundle.ReadFolder(folder.Directory));
            Assert.AreEqual(EscrowFailure.InvalidBundle, e.Failure, expected);
            StringAssert.StartsWith(e.Reason, "invalid_bundle:");
            StringAssert.Contains(e.Reason, expected);
        }

        var nowhere = Path.Combine(Path.GetTempPath(), "ScriptGo.Escrow.Tests", Guid.NewGuid().ToString("N"));
        Assert.AreEqual(EscrowFailure.InvalidBundle, Assert.ThrowsExactly<EscrowException>(() => EscrowBundle.ReadFolder(nowhere)).Failure);
    }

    [TestMethod]
    public async Task AManifestAlteredAfterSigningInAFolderIsABadSignature()
    {
        var v = EscrowVector.Load();
        foreach (var backend in EscrowKit.AvailableBackends())
        {
            using var folder = new Installed(v, m => m["watermark"] = "someone-else");
            using var identity = v.ServerIdentity(backend);
            var keys = EscrowKit.VectorKeys(v);
            var e = await Assert.ThrowsExactlyAsync<EscrowException>(() =>
                EscrowSession.OpenAsync(EscrowBundle.ReadFolder(folder.Directory), identity, keys, v.signerPublicKeyB64Url));
            Assert.AreEqual(EscrowFailure.Signature, e.Failure, backend.ToString());
            Assert.AreEqual(0, keys.Requests);
        }
    }

    // ------------------------------------------------------------------ opening without waiting

    [TestMethod]
    public async Task AHeldAnswerOpensWithoutARequestAndTheCacheSaysHowItStands()
    {
        var v = EscrowVector.Load();
        var time = new ManualTimeProvider(T0);
        using var identity = v.ServerIdentity(EscrowBackend.Managed);
        var bundle = EscrowBundle.Read(v.Bundle);
        var cache = new EscrowKeyCache(time);
        var inner = new EscrowKit.ScriptedKeyService((_, _) => EscrowKeyResult.Granted(v.wrappedKey, "delivery", time.GetUtcNow().AddMinutes(15), time.GetUtcNow().AddMinutes(60)));
        var keys = cache.Recording(inner);
        var options = new EscrowOpenOptions { TimeProvider = time };

        Assert.AreEqual(EscrowKeyFreshness.None, cache.TryGet(bundle.Manifest, identity, out _));

        // The host asks in the background, once...
        var answer = await keys.RequestKeyAsync(bundle.Manifest, identity);
        Assert.AreEqual(1, inner.Requests);
        // ...then opens on its own thread, as often as it restarts the resource, without asking.
        Assert.AreEqual(EscrowKeyFreshness.Fresh, cache.TryGet(bundle.Manifest, identity, out var held));
        Assert.AreSame(answer, held);
        for (var i = 0; i < 3; i++)
        {
            using var content = EscrowSession.Open(bundle, identity, held!, keys, v.signerPublicKeyB64Url, options);
            Assert.AreEqual(EscrowLeaseState.Active, content.State);
            Assert.AreEqual("delivery", content.DeliveryWatermark);
        }
        Assert.AreEqual(1, inner.Requests);

        // Expired but inside its grace: usable for a start during an outage, and the lease says so.
        time.Advance(TimeSpan.FromMinutes(20));
        Assert.AreEqual(EscrowKeyFreshness.Grace, cache.TryGet(bundle.Manifest, identity, out held));
        using (var onGrace = EscrowSession.Open(bundle, identity, held!, keys, v.signerPublicKeyB64Url, options))
        {
            Assert.AreEqual(EscrowLeaseState.Grace, onGrace.State);
            Assert.AreEqual(T0.AddMinutes(60), onGrace.OfflineGraceUntil);
            // A renewal goes to the real service, never to the memory of an older answer.
            Assert.AreEqual(EscrowLeaseState.Active, (await onGrace.RenewAsync()).State);
            Assert.AreEqual(2, inner.Requests);
        }

        // Past the grace nothing is remembered, and an answer that old opens nothing.
        var old = held!;
        time.Advance(TimeSpan.FromMinutes(30));
        Assert.AreEqual(EscrowKeyFreshness.Grace, cache.TryGet(bundle.Manifest, identity, out _), "the renewal above was recorded");
        time.Advance(TimeSpan.FromHours(2));
        Assert.AreEqual(EscrowKeyFreshness.None, cache.TryGet(bundle.Manifest, identity, out _));
        var late = Assert.ThrowsExactly<EscrowException>(() => EscrowSession.Open(bundle, identity, old, keys, v.signerPublicKeyB64Url, options));
        Assert.AreEqual(EscrowFailure.Revoked, late.Failure);

        // A refusal forgets; an outage does not.
        cache.Record(bundle.Manifest, identity, EscrowKeyResult.Granted(v.wrappedKey, null, time.GetUtcNow().AddMinutes(15), time.GetUtcNow().AddMinutes(60)));
        cache.Record(bundle.Manifest, identity, EscrowKeyResult.Unreachable("http_503"));
        Assert.AreEqual(EscrowKeyFreshness.Fresh, cache.TryGet(bundle.Manifest, identity, out _));
        cache.Record(bundle.Manifest, identity, EscrowKeyResult.Refused("revoked"));
        Assert.AreEqual(EscrowKeyFreshness.None, cache.TryGet(bundle.Manifest, identity, out _));

        // A refusal or an outage handed to Open is reported as what it is, after the checks.
        Assert.AreEqual("refused:refunded", Assert.ThrowsExactly<EscrowException>(() =>
            EscrowSession.Open(bundle, identity, EscrowKeyResult.Refused("refunded"), keys, v.signerPublicKeyB64Url, options)).Reason);
        Assert.IsTrue(Assert.ThrowsExactly<EscrowException>(() =>
            EscrowSession.Open(bundle, identity, EscrowKeyResult.Unreachable("network"), keys, v.signerPublicKeyB64Url, options)).IsTransient);
    }

    [TestMethod]
    public async Task AnAnswerForAnotherReleaseOrAnotherSignerIsNotAGrant()
    {
        var v = EscrowVector.Load();
        using var identity = v.ServerIdentity(EscrowBackend.Managed);
        var named = EscrowKeyResult.Granted(v.wrappedKey) with { Aad = v.aad, SignerPublicKey = v.signerPublicKeyB64Url };

        // Named and matching: fine, pinned or not.
        using (await EscrowSession.OpenAsync(v.Bundle, identity, new EscrowKit.ScriptedKeyService((_, _) => named), null)) { }

        var other = await Assert.ThrowsExactlyAsync<EscrowException>(() => EscrowSession.OpenAsync(v.Bundle, identity,
            new EscrowKit.ScriptedKeyService((_, _) => named with { Aad = "kestrel//demo@9.9.9" }), v.signerPublicKeyB64Url));
        Assert.AreEqual("refused:release_mismatch", other.Reason);

        // No signer pinned by the host: the one the key service names for the licence decides.
        var stranger = Base64Url.Encode(new byte[32]);
        var forged = await Assert.ThrowsExactlyAsync<EscrowException>(() => EscrowSession.OpenAsync(v.Bundle, identity,
            new EscrowKit.ScriptedKeyService((_, _) => named with { SignerPublicKey = stranger }), null));
        Assert.AreEqual(EscrowFailure.Signature, forged.Failure);
        StringAssert.Contains(forged.Reason, "not the one the key service names");
        // Pinned by the host: the pin decides, and it matched.
        using (await EscrowSession.OpenAsync(v.Bundle, identity, new EscrowKit.ScriptedKeyService((_, _) => named with { SignerPublicKey = stranger }), v.signerPublicKeyB64Url)) { }
    }

    // ------------------------------------------------------------------ a final refusal

    [TestMethod]
    public async Task ARefusalMarkedFinalStopsAtOnceAndAnOutageNeverDoes()
    {
        var v = EscrowVector.Load();
        foreach (var backend in EscrowKit.AvailableBackends())
        {
            var time = new ManualTimeProvider(T0);
            EscrowKeyResult next = EscrowKeyResult.Granted(v.wrappedKey, "delivery", T0.AddMinutes(15), T0.AddMinutes(60));
            var keys = new EscrowKit.ScriptedKeyService((_, _) => next);
            using var identity = v.ServerIdentity(backend);
            using var content = await EscrowSession.OpenAsync(v.Bundle, identity, keys, v.signerPublicKeyB64Url, new EscrowOpenOptions { TimeProvider = time });
            var revocations = new List<string>();
            content.Revoked += (_, e) => revocations.Add(e.Reason);

            // An outage, however it is dressed up, runs on grace.
            time.Advance(TimeSpan.FromMinutes(5));
            next = EscrowKeyResult.Unreachable("http_503") with { Final = true };
            Assert.AreEqual(EscrowLeaseState.Grace, (await content.RenewAsync()).State, "an outage is grace, never a stop");
            Assert.AreEqual(0, revocations.Count);

            // A refusal the service did not mark final runs on grace too (a binding being fixed).
            next = EscrowKeyResult.Refused("server_key_mismatch");
            var soft = await content.RenewAsync();
            Assert.AreEqual(EscrowLeaseState.Grace, soft.State, backend.ToString());
            Assert.AreEqual(0, revocations.Count);

            // Final: the right to run is over. Minutes into a lease with almost an hour of grace
            // left, the content is revoked now.
            next = EscrowKeyResult.Refused("refunded", final: true);
            var ended = await content.RenewAsync();
            Assert.AreEqual(EscrowLeaseState.Revoked, ended.State, backend.ToString());
            Assert.AreEqual("refused:refunded", ended.Reason);
            CollectionAssert.AreEqual(new[] { "refused:refunded" }, revocations);
            Assert.IsTrue(time.GetUtcNow() < content.OfflineGraceUntil, "well inside the grace");
            using var lua = new Lua();
            Assert.AreEqual(EscrowFailure.Revoked, Assert.ThrowsExactly<EscrowException>(() =>
                content.LoadLuaChunk(lua.Handle, "server/main.lua", "=main", Lua54.Value)).Failure);
        }
    }

    // ------------------------------------------------------------------ the HTTP reading

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public Uri? LastUri { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastUri = request.RequestUri;
            return Task.FromResult(answer(request));
        }
    }

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    [TestMethod]
    public async Task TheHttpKeyServiceReadsFinalNamesTheReleaseAndTrustsNothingRemote()
    {
        var v = EscrowVector.Load();
        using var identity = v.ServerIdentity(EscrowBackend.Managed);
        var manifest = EscrowBundle.Read(v.Bundle).Manifest;
        var options = new HttpEscrowKeyService.Options("sg_dep_secret_token", v.package, "acme");
        Assert.IsFalse(options.ToString().Contains("sg_dep_secret_token", StringComparison.Ordinal), "a deployment token never prints");

        async Task<EscrowKeyResult> Ask(string body, Uri? baseAddress = null)
        {
            var handler = new Handler(_ => Json(body));
            using var http = new HttpClient(handler) { BaseAddress = baseAddress ?? new Uri("https://master.example") };
            var result = await new HttpEscrowKeyService(http, options).RequestKeyAsync(manifest, identity);
            if (baseAddress is not null) Assert.AreEqual(new Uri(baseAddress, "v1/licenses/key"), handler.LastUri);
            return result;
        }

        var final = await Ask("""{"valid":false,"reason":"refunded","final":true}""");
        Assert.IsTrue(final is { Valid: false, TransportError: false, Final: true, Reason: "refunded" });
        var soft = await Ask("""{"valid":false,"reason":"deployment_limit"}""");
        Assert.IsTrue(soft is { Valid: false, Final: false, Reason: "deployment_limit" });

        // A reason is reduced to a token: nothing remote shapes a log line.
        var shaped = await Ask("""{"valid":false,"reason":"revoked\r\nINF forged line <b>"}""");
        Assert.AreEqual("revokedINFforgedlineb", shaped.Reason);

        var wrapped = $$"""{"epk":"{{v.wrappedKey.Epk}}","nonce":"{{v.wrappedKey.Nonce}}","wrapped":"{{v.wrappedKey.Wrapped}}"}""";
        var granted = await Ask($$"""{"valid":true,"wrappedKey":{{wrapped}},"aad":"{{v.aad}}","signerPublicKey":"{{v.signerPublicKeyB64Url}}","expiresAt":"2026-11-10T12:15:00.000Z"}""",
            new Uri("https://master.example/scriptgo/"));
        Assert.IsTrue(granted.Valid);
        Assert.AreEqual(v.aad, granted.Aad);
        Assert.AreEqual(v.signerPublicKeyB64Url, granted.SignerPublicKey);
        Assert.AreEqual(v.wrappedKey, granted.WrappedKey);

        // A valid answer without a well-formed key, a body that is not the contract, and an answer
        // larger than any key answer are all "could not answer", never a grant and never a refusal.
        foreach (var body in new[]
        {
            """{"valid":true}""",
            """{"valid":true,"wrappedKey":{"epk":"AAAA","nonce":"AAAA","wrapped":"AAAA"}}""",
            """{"valid":"yes"}""",
            "[]",
            "{\"valid\":false,\"reason\":\"" + new string('x', HttpEscrowKeyService.MaximumResponseBytes) + "\"}",
        })
        {
            var result = await Ask(body);
            Assert.IsTrue(result is { Valid: false, TransportError: true }, body[..Math.Min(body.Length, 60)]);
        }

        // A token source that fails (a token file removed) is an outage for this request, and the
        // transport's own words never reach the reason.
        using (var http = new HttpClient(new Handler(_ => Json("{}"))) { BaseAddress = new Uri("https://master.example") })
        {
            var noToken = await new HttpEscrowKeyService(http, () => throw new FileNotFoundException("C:/secret/path/token")).RequestKeyAsync(manifest, identity);
            Assert.AreEqual("token_unavailable", noToken.Reason);
            Assert.IsTrue(noToken.TransportError);
        }
        using (var http = new HttpClient(new Handler(_ => throw new HttpRequestException("connection refused by https://master.example/?secret=1"))) { BaseAddress = new Uri("https://master.example") })
        {
            var down = await new HttpEscrowKeyService(http, options).RequestKeyAsync(manifest, identity);
            Assert.AreEqual("network", down.Reason);
        }

        using var client = HttpEscrowKeyService.CreateClient(new Uri("https://master.example/base"), "acme-engine/1.0");
        Assert.AreEqual(new Uri("https://master.example/base/"), client.BaseAddress);

        // The deployment token never crosses the network over plain http: only https, or http to loopback.
        Assert.ThrowsExactly<ArgumentException>(() => HttpEscrowKeyService.CreateClient(new Uri("http://master.example/")));
        using (HttpEscrowKeyService.CreateClient(new Uri("http://127.0.0.1:4100/"))) { }
        using (HttpEscrowKeyService.CreateClient(new Uri("http://localhost:4100/"))) { }
        using (HttpEscrowKeyService.CreateClient(new Uri("http://[::1]:4100/"))) { }
        var sent = false;
        using (var http = new HttpClient(new Handler(_ => { sent = true; return Json("{}"); })) { BaseAddress = new Uri("http://master.example") })
        {
            var insecure = await new HttpEscrowKeyService(http, options).RequestKeyAsync(manifest, identity);
            Assert.AreEqual("insecure_master", insecure.Reason);
            Assert.IsTrue(insecure.TransportError);
            Assert.IsFalse(sent, "nothing is sent to an http master that is not loopback");
        }
    }

    [TestMethod]
    public void ABundleHoldsOnlyWhatItsSignedManifestLists()
    {
        var v = EscrowVector.Load();
        var files = EscrowKit.Unzip(v.Bundle);
        // A file added next to a validly signed manifest is refused, not served as a clear file.
        var added = new Dictionary<string, byte[]>(files) { ["server/evil.lua"] = Encoding.UTF8.GetBytes("os.execute('calc')") };
        var error = Assert.ThrowsExactly<InvalidDataException>(() => EscrowBundle.Read(EscrowKit.Zip(added.Select(static kv => (kv.Key, kv.Value)))));
        StringAssert.Contains(error.Message, "server/evil.lua is in the bundle but not in escrow.json");
        // A path listed both clear and encrypted is refused.
        var manifest = JsonNode.Parse(files["escrow.json"])!.AsObject();
        var encrypted = manifest["encryptedFiles"]!.AsArray()[0]!.GetValue<string>();
        manifest["clearFiles"]!.AsArray().Add(new JsonObject { ["path"] = encrypted, ["bytes"] = 1, ["sha256"] = new string('0', 64) });
        var both = new Dictionary<string, byte[]>(files) { ["escrow.json"] = Encoding.UTF8.GetBytes(manifest.ToJsonString()), [encrypted] = [0x41] };
        StringAssert.Contains(Assert.ThrowsExactly<InvalidDataException>(() => EscrowBundle.Read(EscrowKit.Zip(both.Select(static kv => (kv.Key, kv.Value))))).Message, "listed both clear and encrypted");
        // The genuine bundle reads.
        Assert.IsNotNull(EscrowBundle.Read(v.Bundle).Manifest);
    }
}

/// <summary>
/// The bytes a release signature covers must be, byte for byte, what the JavaScript packer signed:
/// <see cref="EscrowCanonicalJson"/> reproduces <c>JSON.stringify</c> of a key-sorted object, and
/// refuses what it could not reproduce exactly.
/// </summary>
[TestClass]
public sealed class EscrowCanonicalJsonTests
{
    private static string Canonical(string json) => Encoding.UTF8.GetString(EscrowCanonicalJson.ForSignature(Encoding.UTF8.GetBytes(json)));

    [TestMethod]
    public void TheVectorManifestIsWhatTheReferencePackerSigned()
    {
        var v = EscrowVector.Load();
        var escrowJson = EscrowKit.Unzip(v.Bundle)["escrow.json"];
        Assert.AreEqual(v.canonicalManifest, EscrowBundle.CanonicalManifest(escrowJson));
        StringAssert.StartsWith(v.canonicalManifest, "{\"aad\":\"kestrel//demo@1.0.0\",\"allowlist\":[");
        StringAssert.Contains(v.canonicalManifest, "\"signature\":\"\",\"signerPublicKey\":\"" + v.signerPublicKeyB64Url + "\"");
    }

    [TestMethod]
    public void CanonicalJsonFollowsJavaScriptKeyOrderAndEscaping()
    {
        // Keys sorted by UTF-16 code unit at every level, the top-level signature emptied, a
        // nested "signature" left alone, arrays in their own order.
        Assert.AreEqual(
            "{\"B\":[3,1,{\"a\":null,\"z\":true}],\"a\":{\"signature\":\"kept\",\"y\":false},\"signature\":\"\",\"é\":1}",
            Canonical("{ \"signature\": \"abc\", \"é\": 1, \"a\": { \"y\": false, \"signature\": \"kept\" }, \"B\": [3, 1, { \"z\": true, \"a\": null }] }"));

        // A JavaScript object enumerates array-index keys first, numerically.
        Assert.AreEqual("{\"2\":0,\"10\":0,\"01\":0,\"a\":0,\"signature\":\"\"}",
            Canonical("{\"signature\":\"\",\"a\":0,\"10\":0,\"01\":0,\"2\":0}"));

        // JSON.stringify escaping: quote, backslash, the control characters (short forms where they
        // exist, lowercase \u00xx otherwise); nothing else, so non-ASCII, '<', '/' and U+2028 are
        // written as they are.
        Assert.AreEqual("{\"k\":\"\\\"\\\\\\b\\t\\n\\f\\r\\u0001\\u001f</é\u2028\U0001F600\",\"signature\":\"\"}",
            Canonical("{\"signature\":\"\",\"k\":\"\\\"\\\\\\b\\t\\n\\f\\r\\u0001\\u001F\\u003c\\/\\u00e9\\u2028\\ud83d\\ude00\"}"));
    }

    [TestMethod]
    [DataRow("[]")]
    [DataRow("{\"a\":1}")]
    [DataRow("{\"signature\":1}")]
    [DataRow("{\"signature\":\"\",\"a\":1,\"a\":2}")]
    [DataRow("{\"signature\":\"\",\"n\":1.5}")]
    [DataRow("{\"signature\":\"\",\"n\":1e3}")]
    [DataRow("{\"signature\":\"\",\"n\":-0}")]
    [DataRow("{\"signature\":\"\",\"n\":12345678901234567890}")]
    [DataRow("{\"signature\":\"\",\"s\":\"\\ud800\"}")]
    [DataRow("{\"signature\":\"\"")]
    public void CanonicalJsonRefusesWhatItCannotReproduceExactly(string json) =>
        Assert.ThrowsExactly<InvalidDataException>(() => Canonical(json));
}
