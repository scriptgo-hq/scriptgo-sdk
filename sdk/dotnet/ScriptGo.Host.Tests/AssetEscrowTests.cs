using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using ScriptGo.Escrow;

namespace ScriptGo.Host.Tests;

/// <summary>Asset escrow (scriptgo-asset-escrow/1) through the .NET kit, against the vector the
/// TypeScript packer wrote (packages/escrow/test/vectors/asset-vectors.json): the path a licensed
/// OPEN//77 server takes (unwrap the API's key, re-wrap it per player session) and the path a client
/// takes (unwrap its session wrap, open, bind, read in memory).</summary>
[TestClass]
public sealed class AssetEscrowTests
{
    private static readonly Lazy<JsonNode> Vector = new(() =>
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ScriptGo.Host.Tests.asset-vectors.json")
            ?? throw new InvalidOperationException("asset-vectors.json is missing (run packages/escrow/tools/gen-asset-vectors.ts).");
        return JsonNode.Parse(stream)!["assetEscrow"]!;
    });

    private static JsonNode V => Vector.Value;
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static WrappedKey Wrap(JsonNode n) => new(S(n["epk"]), S(n["nonce"]), S(n["wrapped"]));
    private static string Sha(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));
    private const string Package = "kestrel//night-market";
    private const string Version = "2.0.0";

    private static AssetKey ServerKey()
    {
        using var server = EscrowIdentity.ImportPrivateKey(Base64Url.Decode(S(V["server"]!["privateKey"])));
        return AssetKey.UnwrapForServer(server, Wrap(V["server"]!["wrapped"]!), S(V["server"]!["aad"]));
    }

    [TestMethod]
    public void TheAadsAreTheOnesThePackerUses()
    {
        Assert.AreEqual(S(V["server"]!["aad"]), AssetEscrowFormat.ServerAad(Package, Version, "dep_7"));
        Assert.AreEqual(S(V["client"]!["aad"]), AssetEscrowFormat.ClientAad(Package, Version, S(V["keyId"])));
    }

    [TestMethod]
    public void ALicensedServerUnwrapsRewrapsAndAPlayerReadsInMemory()
    {
        using var key = ServerKey();
        Assert.AreEqual(S(V["keyId"]), key.KeyId);

        // One player's session: a fresh identity, the key wrapped to it.
        using var session = EscrowIdentity.Generate();
        var aad = AssetEscrowFormat.ClientAad(Package, Version, key.KeyId);
        var first = key.WrapForClient(session.PublicKey, aad);
        var second = key.WrapForClient(session.PublicKey, aad);
        Assert.AreNotEqual(first.Epk, second.Epk, "a fresh ephemeral key per wrap");
        Assert.AreNotEqual(first.Wrapped, second.Wrapped);

        using var clientKey = AssetKey.UnwrapForClient(session, first, aad);
        Assert.AreEqual(key.KeyId, clientKey.KeyId);

        using var container = AssetContainer.Open(Convert.FromBase64String(S(V["containerBase64"])), Base64Url.Decode(S(V["signerPublicKey"])));
        Assert.AreEqual(Package, container.Package);
        Assert.AreEqual("dep_7", container.Deployment);
        Assert.AreEqual(key.KeyId, container.KeyId);
        Assert.IsNotNull(container.Fingerprint);
        container.Bind(clientKey);
        var files = V["files"]!.AsArray();
        Assert.HasCount(files.Count, container.Files);
        foreach (var f in files)
        {
            var data = container.ReadAll(S(f!["path"]));
            Assert.AreEqual(f["bytes"]!.GetValue<long>(), data.LongLength);
            Assert.AreEqual(S(f["sha256"]), Sha(data), S(f["path"]));
        }

        // A ranged read across a chunk boundary (chunks of 4096 bytes).
        using var reader = container.OpenReader();
        var span = new byte[100];
        Assert.AreEqual(100, reader.Read("archive/pc/mod/night_market.archive", 4050, span));
        Assert.AreEqual(4, reader.Read("archive/pc/mod/night_market.archive", 9000, span), "clamped to the file");
        Assert.AreEqual(0, reader.Read("archive/pc/mod/night_market.archive", 9004, span));
    }

    [TestMethod]
    public void TheClientVectorUnwrapsWithTheSessionKey()
    {
        using var session = EscrowIdentity.ImportPrivateKey(Base64Url.Decode(S(V["client"]!["privateKey"])));
        using var key = AssetKey.UnwrapForClient(session, Wrap(V["client"]!["wrapped"]!), S(V["client"]!["aad"]));
        Assert.AreEqual(S(V["keyId"]), key.KeyId);
    }

    [TestMethod]
    public void AWrapOnlyOpensForItsIdentityKindAndAad()
    {
        using var server = EscrowIdentity.ImportPrivateKey(Base64Url.Decode(S(V["server"]!["privateKey"])));
        var wrapped = Wrap(V["server"]!["wrapped"]!);
        var aad = S(V["server"]!["aad"]);
        // Another deployment's aad, the client kind, another server.
        Assert.AreEqual(EscrowFailure.UnwrapFailed, Assert.ThrowsExactly<EscrowException>(() =>
            AssetKey.UnwrapForServer(server, wrapped, AssetEscrowFormat.ServerAad(Package, Version, "dep_8"))).Failure);
        Assert.AreEqual(EscrowFailure.UnwrapFailed, Assert.ThrowsExactly<EscrowException>(() =>
            AssetKey.UnwrapForClient(server, wrapped, aad)).Failure);
        using var other = EscrowIdentity.Generate();
        Assert.AreEqual(EscrowFailure.UnwrapFailed, Assert.ThrowsExactly<EscrowException>(() =>
            AssetKey.UnwrapForServer(other, wrapped, aad)).Failure);
    }

    [TestMethod]
    public void AnotherDeploymentsKeyDoesNotBind()
    {
        using var session = EscrowIdentity.ImportPrivateKey(Base64Url.Decode(S(V["client"]!["privateKey"])));
        using var other = AssetKey.UnwrapForClient(session, Wrap(V["client"]!["otherWrapped"]!), S(V["client"]!["aad"]));
        Assert.AreNotEqual(S(V["keyId"]), other.KeyId);
        using var container = AssetContainer.Open(Convert.FromBase64String(S(V["containerBase64"])));
        Assert.AreEqual("key_mismatch", Assert.ThrowsExactly<EscrowException>(() => container.Bind(other)).Reason);
        Assert.ThrowsExactly<InvalidOperationException>(() => container.OpenReader());
    }

    [TestMethod]
    public void AnUntrustedSignerOrAChangedByteIsRefusedBeforeAnyKey()
    {
        var bytes = Convert.FromBase64String(S(V["containerBase64"]));
        using var stranger = EscrowIdentity.Generate(); // any 32 bytes that are not the signer
        Assert.AreEqual(EscrowFailure.Signature, Assert.ThrowsExactly<EscrowException>(() =>
            AssetContainer.Open(bytes, stranger.PublicKey)).Failure);
        var tampered = (byte[])bytes.Clone();
        tampered[^10] ^= 1; // in the body: the signed ciphertext hash no longer matches
        Assert.ThrowsExactly<EscrowException>(() => AssetContainer.Open(tampered));
        Assert.ThrowsExactly<EscrowException>(() => AssetContainer.Open(bytes.AsSpan(0, 40)));
    }

    [TestMethod]
    public void TheEscrowedOpen77PreloadOpensWithTheDeploymentKey()
    {
        var copy = V["escrowedCopy"]!;
        using var outer = new ZipArchive(new MemoryStream(Convert.FromBase64String(S(copy["zipBase64"]))));
        using var preloadStream = new MemoryStream();
        using (var s = outer.GetEntry("night_market/dist/night_market.zip")!.Open()) s.CopyTo(preloadStream);
        preloadStream.Position = 0;
        using var preload = new ZipArchive(preloadStream);
        // The container and the per-buyer fingerprint entry; no plaintext archive left beside them.
        CollectionAssert.AreEquivalent(
            new[] { S(copy["preloadEntry"]), "archive/pc/mod/night_market.scriptgo-fingerprint.json" },
            preload.Entries.Select(e => e.FullName).ToArray());
        var entry = preload.GetEntry(S(copy["preloadEntry"]))!;
        Assert.EndsWith(AssetEscrowFormat.Extension, entry.FullName);
        using var containerBytes = new MemoryStream();
        using (var s = entry.Open()) s.CopyTo(containerBytes);

        using var container = AssetContainer.Open(containerBytes.ToArray(), Base64Url.Decode(S(copy["signerPublicKey"])));
        Assert.AreEqual("dep_7", container.Deployment);
        using var key = ServerKey();
        container.Bind(key);
        foreach (var f in copy["preloadFiles"]!.AsArray())
            Assert.AreEqual(S(f!["sha256"]), Sha(container.ReadAll(S(f["path"]))), S(f["path"]));
    }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public string? LastBody { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return answer(request);
        }
    }

    [TestMethod]
    public async Task TheKeyServiceAsksForAssetsAndReadsTheKeyId()
    {
        var server = V["server"]!;
        var body = new JsonObject
        {
            ["valid"] = true,
            ["wrappedKey"] = new JsonObject { ["epk"] = S(server["wrapped"]!["epk"]), ["nonce"] = S(server["wrapped"]!["nonce"]), ["wrapped"] = S(server["wrapped"]!["wrapped"]) },
            ["aad"] = S(server["aad"]),
            ["keyId"] = S(V["keyId"]),
            ["version"] = Version,
        }.ToJsonString();
        var handler = new Handler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://master.invalid/") };
        var service = new HttpEscrowKeyService(http, new HttpEscrowKeyService.Options("sg_dep_token", Package, "open77"));
        using var identity = EscrowIdentity.ImportPrivateKey(Base64Url.Decode(S(server["privateKey"])));

        var answer = await service.RequestAssetKeyAsync(Version, identity);
        Assert.IsTrue(answer.Valid);
        Assert.AreEqual(S(V["keyId"]), answer.KeyId);
        Assert.AreEqual(Version, answer.Version);
        var sent = JsonNode.Parse(handler.LastBody!)!;
        Assert.AreEqual("assets", S(sent["kind"]));
        Assert.AreEqual(Version, S(sent["version"]));
        Assert.AreEqual(identity.PublicKeyBase64Url, S(sent["serverPublicKey"]));
        Assert.AreEqual(AssetEscrowFormat.ServerAad(Package, Version, "dep_7"), answer.Aad);
        using var key = AssetKey.UnwrapForServer(identity, answer.WrappedKey!, answer.Aad!);
        Assert.AreEqual(answer.KeyId, key.KeyId);
    }

    [TestMethod]
    public void TheManagedBackendIsRefusedRatherThanHoldingAKeyInTheHeap()
    {
        using var managed = EscrowIdentity.Generate(EscrowBackend.Managed);
        Assert.AreEqual(EscrowFailure.NativeLibraryUnavailable, Assert.ThrowsExactly<EscrowException>(() =>
            AssetKey.UnwrapForServer(managed, Wrap(V["server"]!["wrapped"]!), S(V["server"]!["aad"]))).Failure);
    }
}
