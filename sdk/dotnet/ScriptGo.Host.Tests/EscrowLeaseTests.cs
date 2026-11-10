using System.Net;
using System.Text;
using System.Text.Json;
using KeraLua;
using ScriptGo.Escrow;

namespace ScriptGo.Host.Tests;

/// <summary>
/// The lease: re-verification before expiresAt, offline grace on a refusal or an unreachable
/// service, and revocation (stop the resource, wipe the content) when grace runs out. Time is a
/// clock the test moves.
/// </summary>
[TestClass]
public sealed class EscrowLeaseTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 10, 12, 0, 0, TimeSpan.Zero);
    private static readonly Lazy<LuaChunkLoader> Lua54 = new(() => LuaChunkLoader.FromLibraryName("lua54", typeof(Lua).Assembly));

    /// <summary>A key service the test steers: grant (15 minute lease, one hour of grace, as the
    /// master does), refuse with a reason, or be unreachable.</summary>
    private sealed class SteeredKeyService(EscrowVector v, TimeProvider time) : IEscrowKeyService
    {
        public string? Refuse { get; set; }
        public bool Offline { get; set; }
        public int Requests { get; private set; }

        public Task<EscrowKeyResult> RequestKeyAsync(EscrowManifest manifest, EscrowIdentity identity, CancellationToken cancellation = default)
        {
            Requests++;
            if (Offline) return Task.FromResult(EscrowKeyResult.Unreachable("http_503"));
            if (Refuse is not null) return Task.FromResult(EscrowKeyResult.Refused(Refuse));
            var now = time.GetUtcNow();
            return Task.FromResult(EscrowKeyResult.Granted(v.wrappedKey, "delivery", now.AddMinutes(15), now.AddMinutes(60)));
        }
    }

    private static async Task<(EscrowContent Content, SteeredKeyService Keys, ManualTimeProvider Time, EscrowIdentity Identity)> Open(EscrowBackend backend = EscrowBackend.Native)
    {
        if (backend == EscrowBackend.Native) EscrowKit.RequireNative();
        var v = EscrowVector.Load();
        var time = new ManualTimeProvider(T0);
        var keys = new SteeredKeyService(v, time);
        var identity = v.ServerIdentity(backend);
        var content = await EscrowSession.OpenAsync(v.Bundle, identity, keys, v.signerPublicKeyB64Url, new EscrowOpenOptions { TimeProvider = time });
        return (content, keys, time, identity);
    }

    private static bool CanLoad(EscrowContent content)
    {
        using var lua = new Lua();
        return content.LoadLuaChunk(lua.Handle, "server/secret.lua", "=secret", Lua54.Value).Ok;
    }

    [TestMethod]
    public async Task ARenewalBeforeExpiryExtendsTheLease()
    {
        var (content, keys, time, identity) = await Open();
        using (identity) using (content)
        {
            Assert.AreEqual(EscrowLeaseState.Active, content.State);
            Assert.AreEqual(T0.AddMinutes(15), content.ExpiresAt, "expiresAt comes from the key answer.");
            Assert.AreEqual(T0.AddMinutes(60), content.OfflineGraceUntil, "offlineGraceUntil comes from the key answer.");

            time.Advance(TimeSpan.FromMinutes(10));
            var renewal = await content.RenewAsync();
            Assert.AreEqual(EscrowLeaseState.Active, renewal.State);
            Assert.IsNull(renewal.Reason);
            Assert.AreEqual(T0.AddMinutes(25), content.ExpiresAt);
            Assert.AreEqual(T0.AddMinutes(70), content.OfflineGraceUntil);
            Assert.AreEqual(2, keys.Requests);
        }
    }

    [TestMethod]
    public async Task ARevokedLicenseRunsUntilTheEndOfGraceThenStopsAndIsWiped()
    {
        foreach (var backend in new[] { EscrowBackend.Native, EscrowBackend.Managed })
        {
            var (content, keys, time, identity) = await Open(backend);
            using (identity) using (content)
            {
                var revocations = new List<string>();
                content.Revoked += (_, e) => revocations.Add(e.Reason);

                // The license is revoked (a refund). The next key request is refused...
                keys.Refuse = "revoked";
                time.Advance(TimeSpan.FromMinutes(14));
                var refused = await content.RenewAsync();
                // ...and the resource keeps running on offline grace, as the spec says.
                Assert.AreEqual(EscrowLeaseState.Grace, refused.State, backend.ToString());
                Assert.AreEqual("refused:revoked", refused.Reason);
                Assert.AreEqual(T0.AddMinutes(60), refused.OfflineGraceUntil, "a refusal never extends the grace.");
                Assert.IsTrue(CanLoad(content), "within grace the content is still usable.");
                Assert.AreEqual(0, revocations.Count);

                time.Advance(TimeSpan.FromMinutes(40)); // 54 minutes in: still inside grace
                Assert.AreEqual(EscrowLeaseState.Grace, (await content.RenewAsync()).State);
                Assert.AreEqual(0, revocations.Count);

                time.Advance(TimeSpan.FromMinutes(7)); // 61 minutes in: grace is over
                var ended = await content.RenewAsync();
                Assert.AreEqual(EscrowLeaseState.Revoked, ended.State, backend.ToString());
                CollectionAssert.AreEqual(new[] { "refused:revoked" }, revocations, "Revoked is raised once, with the license reason.");
                Assert.AreEqual("refused:revoked", content.RevocationReason);

                // The content is gone: no chunk, no copy, no size.
                using var lua = new Lua();
                var e = Assert.Throws<EscrowException>(() => content.LoadLuaChunk(lua.Handle, "server/secret.lua", "=secret", Lua54.Value));
                Assert.AreEqual(EscrowFailure.Revoked, e.Failure);
                Assert.Throws<EscrowException>(() => content.ReadAllBytes("server/secret.lua"));
                Assert.IsFalse(content.TryGetSize("server/secret.lua", out _));

                // A later attempt does not resurrect it, and does not raise the event again.
                keys.Refuse = null;
                Assert.AreEqual(EscrowLeaseState.Revoked, (await content.RenewAsync()).State);
                Assert.AreEqual(1, revocations.Count);
            }
        }
    }

    [TestMethod]
    public async Task AnUnreachableKeyServiceIsCoveredByOfflineGraceAndRecovers()
    {
        var (content, keys, time, identity) = await Open();
        using (identity) using (content)
        {
            var revocations = new List<string>();
            content.Revoked += (_, e) => revocations.Add(e.Reason);

            keys.Offline = true;
            time.Advance(TimeSpan.FromMinutes(20)); // past expiresAt, inside grace
            Assert.AreEqual(EscrowLeaseState.Grace, content.State, "past expiresAt without a renewal is grace, not revocation.");
            var offline = await content.RenewAsync();
            Assert.AreEqual(EscrowLeaseState.Grace, offline.State);
            Assert.AreEqual("key_service_unreachable:http_503", offline.Reason);
            Assert.IsTrue(CanLoad(content), "a short master outage must not break a paying server.");

            // The service comes back: the lease is whole again.
            keys.Offline = false;
            var back = await content.RenewAsync();
            Assert.AreEqual(EscrowLeaseState.Active, back.State);
            Assert.AreEqual(T0.AddMinutes(35), content.ExpiresAt);
            Assert.AreEqual(T0.AddMinutes(80), content.OfflineGraceUntil);

            // Offline for longer than the grace: the content is revoked, and the reason says it was an outage.
            keys.Offline = true;
            time.Advance(TimeSpan.FromMinutes(61));
            Assert.AreEqual(EscrowLeaseState.Revoked, (await content.RenewAsync()).State);
            CollectionAssert.AreEqual(new[] { "offline_grace_exhausted:key_service_unreachable:http_503" }, revocations);
        }
    }

    [TestMethod]
    public async Task TheLeaseEndsByTheClockEvenIfTheHostNeverRenews()
    {
        var (content, keys, time, identity) = await Open();
        using (identity) using (content)
        {
            var revocations = new List<string>();
            content.Revoked += (_, e) => revocations.Add(e.Reason);
            time.Advance(TimeSpan.FromMinutes(59));
            Assert.IsTrue(CanLoad(content));
            time.Advance(TimeSpan.FromMinutes(2));
            using var lua = new Lua();
            Assert.Throws<EscrowException>(() => content.LoadLuaChunk(lua.Handle, "server/secret.lua", "=secret", Lua54.Value));
            CollectionAssert.AreEqual(new[] { "offline_grace_exhausted:not_renewed" }, revocations);
            Assert.AreEqual(1, keys.Requests, "only the opening request was ever made.");
        }
    }

    [TestMethod]
    public async Task TheBackgroundLoopRenewsBeforeExpiryAndRevokesAtTheEndOfGrace()
    {
        var (content, keys, time, identity) = await Open();
        using (identity) using (content)
        {
            var revoked = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            var attempts = new List<EscrowRenewal>();
            content.Revoked += (_, e) => revoked.TrySetResult(e.Reason);
            content.StartRenewal(new EscrowRenewalOptions
            {
                RetryInterval = TimeSpan.FromSeconds(30),
                OnRenewal = r => { lock (attempts) attempts.Add(r); },
            });
            Assert.Throws<InvalidOperationException>(() => content.StartRenewal());

            // While the license is good, the loop renews on its own before each expiry.
            await Step(time, TimeSpan.FromMinutes(1), () => keys.Requests >= 3, "two background renewals");
            Assert.AreEqual(EscrowLeaseState.Active, content.State);
            Assert.IsTrue(content.ExpiresAt > time.GetUtcNow(), "the loop renewed before the lease ran out.");

            // The license is revoked: the loop keeps asking, the resource keeps running until grace ends...
            keys.Refuse = "revoked";
            var graceEnd = content.OfflineGraceUntil;
            await Step(time, TimeSpan.FromSeconds(30), () => content.State != EscrowLeaseState.Active, "the first refusal");
            Assert.AreEqual(EscrowLeaseState.Grace, content.State);
            Assert.IsFalse(revoked.Task.IsCompleted);

            // ...then it is revoked, at the end of grace and not before.
            await Step(time, TimeSpan.FromSeconds(30), () => revoked.Task.IsCompleted, "the revocation");
            Assert.AreEqual("refused:revoked", await revoked.Task);
            Assert.IsTrue(time.GetUtcNow() >= graceEnd, "revocation waits for the end of grace.");
            Assert.IsTrue(time.GetUtcNow() < graceEnd.AddMinutes(10), "and happens promptly once grace is over.");
            Assert.AreEqual(EscrowLeaseState.Revoked, content.State);
            Assert.IsNull(content.RenewalFault);
            lock (attempts) Assert.AreEqual(EscrowLeaseState.Revoked, attempts[^1].State);
        }
    }

    /// <summary>Moves the manual clock in steps, letting the renewal task run between them, until the
    /// condition holds.</summary>
    private static async Task Step(ManualTimeProvider time, TimeSpan step, Func<bool> done, string what)
    {
        for (var i = 0; i < 2000 && !done(); i++)
        {
            time.Advance(step);
            SpinWait.SpinUntil(done, TimeSpan.FromMilliseconds(5));
            await Task.Yield();
        }
        Assert.IsTrue(done(), "timed out waiting for " + what);
    }

    // ------------------------------------------------------------------ the HTTP key service

    private sealed class StubHandler(Func<HttpRequestMessage, string, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public string? LastBody { get; private set; }
        public string? LastPath { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastPath = request.RequestUri!.AbsolutePath;
            LastBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            return respond(request, LastBody);
        }
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    [TestMethod]
    public async Task TheHttpKeyServiceSpeaksTheMasterContract()
    {
        var v = EscrowVector.Load();
        using var identity = v.ServerIdentity(EscrowBackend.Managed);
        var manifest = EscrowBundle.Read(v.Bundle).Manifest;
        var options = new HttpEscrowKeyService.Options("sg_dep_test_token", v.package, "acme-engine", "acme/1.2.3");

        // Granted: wrappedKey, watermark, expiresAt and offlineGraceUntil are all carried through.
        var granted = new StubHandler((_, _) => Json(JsonSerializer.Serialize(new
        {
            valid = true,
            reason = (string?)null,
            wrappedKey = new { v.wrappedKey.Epk, v.wrappedKey.Nonce, v.wrappedKey.Wrapped }.ToLowerKeys(),
            aad = v.aad,
            signerPublicKey = v.signerPublicKeyB64Url,
            deliveryWatermark = "wm-123",
            offlineGraceUntil = "2026-11-13T12:00:00.000Z",
            expiresAt = "2026-11-10T12:15:00.000Z",
        })));
        using (var http = new HttpClient(granted) { BaseAddress = new Uri("https://master.example") })
        {
            var result = await new HttpEscrowKeyService(http, options).RequestKeyAsync(manifest, identity);
            Assert.IsTrue(result.Valid);
            Assert.AreEqual(v.wrappedKey, result.WrappedKey);
            Assert.AreEqual("wm-123", result.DeliveryWatermark);
            Assert.AreEqual(new DateTimeOffset(2026, 11, 10, 12, 15, 0, TimeSpan.Zero), result.ExpiresAt);
            Assert.AreEqual(new DateTimeOffset(2026, 11, 13, 12, 0, 0, TimeSpan.Zero), result.OfflineGraceUntil);

            Assert.AreEqual("/v1/licenses/key", granted.LastPath);
            using var sent = JsonDocument.Parse(granted.LastBody!);
            Assert.AreEqual("sg_dep_test_token", sent.RootElement.GetProperty("deploymentToken").GetString());
            Assert.AreEqual(v.package, sent.RootElement.GetProperty("package").GetString());
            Assert.AreEqual("1.0.0", sent.RootElement.GetProperty("version").GetString());
            Assert.AreEqual("acme-engine", sent.RootElement.GetProperty("environment").GetString());
            Assert.AreEqual("acme/1.2.3", sent.RootElement.GetProperty("adapterVersion").GetString());
            Assert.AreEqual(identity.PublicKeyBase64Url, sent.RootElement.GetProperty("serverPublicKey").GetString());
        }

        // A definitive refusal is HTTP 200 with valid:false.
        using (var http = new HttpClient(new StubHandler((_, _) => Json("""{"valid":false,"reason":"unbound","wrappedKey":null,"aad":null,"signerPublicKey":null,"deliveryWatermark":null,"offlineGraceUntil":null,"expiresAt":null}"""))) { BaseAddress = new Uri("https://master.example") })
        {
            var result = await new HttpEscrowKeyService(http, options).RequestKeyAsync(manifest, identity);
            Assert.IsFalse(result.Valid);
            Assert.IsFalse(result.TransportError);
            Assert.AreEqual("unbound", result.Reason);
        }

        // 4xx/5xx and garbage mean "could not answer": offline grace applies, it is not a refusal.
        foreach (var handler in new[]
        {
            new StubHandler((_, _) => Json("""{"error":"rate_limited"}""", HttpStatusCode.TooManyRequests)),
            new StubHandler((_, _) => Json("oops", HttpStatusCode.BadGateway)),
            new StubHandler((_, _) => Json("<html>not json</html>")),
            new StubHandler((_, _) => throw new HttpRequestException("connection refused")),
        })
        {
            using var http = new HttpClient(handler) { BaseAddress = new Uri("https://master.example") };
            var result = await new HttpEscrowKeyService(http, options).RequestKeyAsync(manifest, identity);
            Assert.IsFalse(result.Valid);
            Assert.IsTrue(result.TransportError, result.Reason);
        }
    }
}

internal static class AnonymousJson
{
    /// <summary>{ Epk, Nonce, Wrapped } as { epk, nonce, wrapped }, the wire names.</summary>
    public static Dictionary<string, string> ToLowerKeys(this object value) =>
        value.GetType().GetProperties().ToDictionary(p => char.ToLowerInvariant(p.Name[0]) + p.Name[1..], p => (string)p.GetValue(value)!);
}
