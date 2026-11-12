using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using KeraLua;
using ScriptGo.Escrow;

namespace ScriptGo.Host.Tests;

/// <summary>Client code escrow (scriptgo-client-escrow/1) through the .NET kit, against the vector the
/// TypeScript packer wrote (packages/escrow/test/vectors/client-vectors.json): the licensed server's
/// path (unwrap the API's client-code key, re-wrap it per session) and the client's (unwrap, open,
/// check the VM, bind, compile stripped bytecode into KeraLua's Lua 5.4 and run it).</summary>
[TestClass]
public sealed class ClientEscrowTests
{
    private static readonly Lazy<JsonNode> Vector = new(() =>
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ScriptGo.Host.Tests.client-vectors.json")
            ?? throw new InvalidOperationException("client-vectors.json is missing (run packages/escrow/tools/gen-client-vectors.ts).");
        return JsonNode.Parse(stream)!;
    });
    private static readonly Lazy<LuaChunkLoader> Lua54 = new(() => LuaChunkLoader.FromLibraryName("lua54", typeof(Lua).Assembly));

    private static JsonNode V => Vector.Value;
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static WrappedKey Wrap(JsonNode n) => new(S(n["epk"]), S(n["nonce"]), S(n["wrapped"]));
    private static byte[] B64(string name) => Convert.FromBase64String(S(V[name]));
    private static byte[] Signer => Base64Url.Decode(S(V["signerPublicKey"]));
    private const string Package = "kestrel//night-market";
    private const string Version = "2.0.0";

    private static AssetKey SessionKey(string wrap = "wrapped")
    {
        using var session = EscrowIdentity.ImportPrivateKey(Base64Url.Decode(S(V["session"]!["privateKey"])));
        return AssetKey.UnwrapClientCodeForSession(session, Wrap(V["session"]![wrap]!), S(V["session"]!["aad"]));
    }

    /// <summary>The host VM's LUAC header, read the way a host reads it: dump a function, keep 31 bytes.</summary>
    private static byte[] HostHeader(Lua lua)
    {
        Assert.AreEqual(LuaStatus.OK, lua.LoadString("return 0"));
        var bytes = new List<byte>();
        LuaWriter writer = (_, p, size, _) =>
        {
            var chunk = new byte[(int)size];
            Marshal.Copy(p, chunk, 0, chunk.Length);
            bytes.AddRange(chunk);
            return 0;
        };
        lua.Dump(writer, IntPtr.Zero, true);
        lua.SetTop(0);
        GC.KeepAlive(writer);
        return bytes.Take(ClientEscrowFormat.LuacHeaderBytes).ToArray();
    }

    [TestMethod]
    public void TheAadsAreTheOnesThePackerUses()
    {
        Assert.AreEqual(S(V["server"]!["aad"]), ClientEscrowFormat.ServerAad(Package, Version, "dep_7"));
        Assert.AreEqual(S(V["session"]!["aad"]), ClientEscrowFormat.SessionAad(Package, Version, S(V["keyId"])));
    }

    [TestMethod]
    public void ALicensedServerUnwrapsAndRewrapsAClientCodeKey()
    {
        EscrowKit.RequireNative();
        using var server = EscrowIdentity.ImportPrivateKey(Base64Url.Decode(S(V["server"]!["privateKey"])));
        using var key = AssetKey.UnwrapClientCodeForServer(server, Wrap(V["server"]!["wrapped"]!), S(V["server"]!["aad"]));
        Assert.AreEqual(S(V["keyId"]), key.KeyId);
        // Read as an asset key, the same wrap gives another id: the two domains never mix.
        using var asAsset = AssetKey.UnwrapForServer(server, Wrap(V["server"]!["wrapped"]!), S(V["server"]!["aad"]));
        Assert.AreNotEqual(key.KeyId, asAsset.KeyId);

        using var session = EscrowIdentity.Generate();
        var aad = ClientEscrowFormat.SessionAad(Package, Version, key.KeyId);
        var wrapped = key.WrapForClient(session.PublicKey, aad);
        using var again = AssetKey.UnwrapClientCodeForSession(session, wrapped, aad);
        Assert.AreEqual(key.KeyId, again.KeyId);
        var asAssetSession = Assert.ThrowsExactly<EscrowException>(() => AssetKey.UnwrapForClient(session, wrapped, aad));
        StringAssert.StartsWith(asAssetSession.Reason, "unwrap_failed");
    }

    [TestMethod]
    public void AClientRunsEscrowedBytecodeInKeraLua()
    {
        EscrowKit.RequireNative();
        using var key = SessionKey();
        using var container = ClientCodeContainer.Open(B64("containerBase64"), Signer);
        Assert.AreEqual("full", container.Strip);
        Assert.AreEqual("5.4.8", container.Lua);
        CollectionAssert.AreEqual(new[] { "client/fail.lua", "client/main.lua" }, container.Chunks.Select(c => c.Path).ToArray());
        container.Bind(key);

        using var lua = new Lua();
        Assert.ThrowsExactly<InvalidOperationException>(() => container.LoadLuaChunk("client/main.lua", lua.Handle, Lua54.Value));
        Assert.IsTrue(container.CheckTarget(HostHeader(lua)));

        var loaded = container.LoadLuaChunk("client/main.lua", lua.Handle, Lua54.Value);
        Assert.AreEqual(LuaChunkStatus.Loaded, loaded.Status);
        Assert.AreEqual(LuaStatus.OK, lua.PCall(0, 1, 0));
        lua.GetField(-1, "answer");
        Assert.AreEqual(42, lua.ToInteger(-1));
        lua.SetTop(0);
        lua.GetGlobal("SGCE_LOADED");
        Assert.AreEqual(1, lua.ToInteger(-1));
        lua.SetTop(0);

        // A runtime error names the chunk and a position, never a source line.
        Assert.AreEqual(LuaChunkStatus.Loaded, container.LoadLuaChunk("client/fail.lua", lua.Handle, Lua54.Value).Status);
        Assert.AreEqual(LuaStatus.OK, lua.PCall(0, 1, 0));
        lua.NewTable();
        Assert.AreEqual(LuaStatus.ErrRun, lua.PCall(1, 0, 0));
        StringAssert.Contains(lua.ToString(-1), "night-market@2.0.0/client/fail.lua:pos:");
        lua.SetTop(0);

        Assert.AreEqual(LuaChunkStatus.NotFound, container.LoadLuaChunk("client/none.lua", lua.Handle, Lua54.Value).Status);
        Assert.AreEqual(0, lua.GetTop());
    }

    [TestMethod]
    public void TheContainerRefusesOtherKeysTargetsAndGenerations()
    {
        EscrowKit.RequireNative();
        using (var container = ClientCodeContainer.Open(B64("containerBase64"), Signer))
        using (var other = SessionKey("otherWrapped"))
        using (var asset = SessionKey("assetKeyWrapped"))
        {
            Assert.AreEqual("key_mismatch", Assert.ThrowsExactly<EscrowException>(() => container.Bind(other)).Reason);
            Assert.AreEqual("key_mismatch", Assert.ThrowsExactly<EscrowException>(() => container.Bind(asset)).Reason);
        }
        using (var foreign = ClientCodeContainer.Open(B64("foreignTargetBase64"), Signer))
        using (var lua = new Lua())
            Assert.IsFalse(foreign.CheckTarget(HostHeader(lua)));
        using (var lying = ClientCodeContainer.Open(B64("lyingBase64"), Signer))
        using (var key = SessionKey())
        using (var lua = new Lua())
        {
            lying.Bind(key);
            Assert.IsTrue(lying.CheckTarget(HostHeader(lua)));
            StringAssert.StartsWith(Assert.ThrowsExactly<EscrowException>(() => lying.LoadLuaChunk("client/main.lua", lua.Handle, Lua54.Value)).Reason, "target_mismatch");
        }
        StringAssert.StartsWith(Assert.ThrowsExactly<EscrowException>(() => ClientCodeContainer.Open(B64("permutedBase64"), Signer)).Reason, "bad_container");
        var unpinned = new byte[32];
        Assert.AreEqual(EscrowFailure.Signature, Assert.ThrowsExactly<EscrowException>(() => ClientCodeContainer.Open(B64("containerBase64"), unpinned)).Failure);
        // A flipped ciphertext byte: the signed ciphertext hash refuses it at open, before any key ...
        var tampered = B64("containerBase64");
        tampered[^3] ^= 1;
        StringAssert.StartsWith(Assert.ThrowsExactly<EscrowException>(() => ClientCodeContainer.Open(tampered, Signer)).Reason, "payload_hash");
        // ... and in a legacy container (plaintext sha256 per chunk) the AEAD tag refuses the load.
        var legacyTampered = B64("legacyContainerBase64");
        legacyTampered[^3] ^= 1;
        using (var bad = ClientCodeContainer.Open(legacyTampered, Signer))
        using (var key = SessionKey())
        using (var lua = new Lua())
        {
            bad.Bind(key);
            Assert.IsTrue(bad.CheckTarget(HostHeader(lua)));
            StringAssert.StartsWith(Assert.ThrowsExactly<EscrowException>(() => bad.LoadLuaChunk("client/main.lua", lua.Handle, Lua54.Value)).Reason, "decrypt_failed");
        }
    }

    [TestMethod]
    public void LoadingNeedsAPinnedSignerAndLegacyContainersStillLoad()
    {
        EscrowKit.RequireNative();
        // Whoever holds the content key (a game server does) can seal bytecode of its choice and sign the
        // header with its own key; it verifies under that key, so only the pin refuses it.
        var stranger = B64("strangerContainerBase64");
        Assert.ThrowsExactly<ArgumentException>(() => ClientCodeContainer.Open(B64("containerBase64"), ReadOnlySpan<byte>.Empty));
        Assert.AreEqual(EscrowFailure.Signature, Assert.ThrowsExactly<EscrowException>(() => ClientCodeContainer.Open(stranger, Signer)).Failure);
        using (var inspected = ClientCodeContainer.Inspect(stranger))
        using (var key = SessionKey())
        {
            Assert.IsTrue(inspected.IsInspectOnly);
            Assert.AreNotEqual(S(V["signerPublicKey"]), inspected.SignerPublicKey);
            StringAssert.StartsWith(Assert.ThrowsExactly<EscrowException>(() => inspected.Bind(key)).Reason, "untrusted_signer");
        }
        // A container sealed before SDK 0.1.12 (each chunk's plaintext sha256) opens, binds and runs.
        using (var legacy = ClientCodeContainer.Open(B64("legacyContainerBase64"), Signer))
        using (var key = SessionKey())
        using (var lua = new Lua())
        {
            legacy.Bind(key);
            Assert.IsTrue(legacy.CheckTarget(HostHeader(lua)));
            Assert.AreEqual(LuaChunkStatus.Loaded, legacy.LoadLuaChunk("client/main.lua", lua.Handle, Lua54.Value).Status);
        }
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
    public async Task TheKeyServiceAsksForClientCodeAndTheServerUnwrapsIt()
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

        var answer = await service.RequestClientKeyAsync(Version, identity);
        Assert.IsTrue(answer.Valid);
        Assert.AreEqual(S(V["keyId"]), answer.KeyId);
        var sent = JsonNode.Parse(handler.LastBody!)!;
        Assert.AreEqual("client", S(sent["kind"]));
        Assert.AreEqual(Version, S(sent["version"]));
        Assert.AreEqual(ClientEscrowFormat.ServerAad(Package, Version, "dep_7"), answer.Aad);
        using var key = AssetKey.UnwrapClientCodeForServer(identity, answer.WrappedKey!, answer.Aad!);
        Assert.AreEqual(answer.KeyId, key.KeyId);
    }
}
