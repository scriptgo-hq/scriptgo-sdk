using System.Text;
using ScriptGo.Escrow;

namespace ScriptGo.Host.Tests;

/// <summary>
/// Escrow inside the SCRIPT//GO sandbox: an escrow-mounted Lua resource is compiled from native
/// memory (no managed plaintext), a JavaScript guest goes through the managed door, a revocation
/// stops the resource, and the disk fallback (Option A) still works.
/// </summary>
[TestClass]
public sealed class EscrowHostTests
{
    private static async Task<(EscrowLoadResult Result, ScriptGoHost Host, EscrowResourceFiles Files, CaptureLog Log)> Load(
        byte[] bundle, IEscrowKeyService service, EscrowIdentity identity, EscrowOpenOptions? options = null)
    {
        var v = EscrowVector.Load();
        var files = new EscrowResourceFiles();
        var log = new CaptureLog();
        var services = new HostServices { Log = log, Files = files };
        var host = new ScriptGoHost(services, new HostOptions { Environment = "dotnet" });
        var result = await EscrowLoader.LoadAsync(bundle, files, identity, service, v.signerPublicKeyB64Url, options);
        return (result, host, files, log);
    }

    [TestMethod]
    public async Task AnEscrowedLuaResourceRunsFromNativeMemoryWithoutAManagedCopy()
    {
        EscrowKit.RequireNative();
        var v = EscrowVector.Load();
        using var identity = EscrowIdentity.Generate();
        var (result, host, files, log) = await Load(v.Bundle, EscrowKit.MasterLike(v.ContentKey), identity);
        using (host)
        {
            Assert.IsTrue(result.Ok, "the bound host must load the escrowed resource: " + result.Reason);
            using var content = result.Content!;
            Assert.AreEqual(EscrowBackend.Native, content.Backend);

            var name = host.AddResource(result.ResourceRoot!, checkFolderName: false);
            Assert.AreEqual("demo", name);
            var started = host.Start(name);
            Assert.IsTrue(started.Ok, started.Reason + "\n" + log);
            host.RunFor(50);

            // server/main.lua ran, and it required server/secret.lua: both came from the encrypted payload.
            Assert.IsTrue(log.Has("escrow secret ok 42"), "the decrypted server script must have run and required its module.\n" + log);
            Assert.IsTrue(log.Has("escrow handler ok"), "the handler it registered must have fired.\n" + log);

            // The proof this path exists for: neither the entry script nor the required module was
            // ever copied into managed memory. Both went from libscriptgo straight into the Lua VM.
            Assert.AreEqual(0, content.ManagedCopies, "the native Lua path must never go through the managed copy door.");

            // The per-delivery watermark marker is part of the mounted resource (it is not creator code).
            Assert.IsNotNull(files.Read(result.ResourceRoot!, EscrowFormat.DeliveryMarker));
            CollectionAssert.Contains(files.List(result.ResourceRoot!).ToList(), "server/main.lua");
            Assert.AreEqual(0, content.ManagedCopies);

            // A resource reading one of its own encrypted files as data is the managed door, and it is counted.
            Assert.IsNotNull(files.Read(result.ResourceRoot!, "data/notes.txt"));
            Assert.AreEqual(1, content.ManagedCopies);
        }
    }

    [TestMethod]
    public async Task TheManagedFallbackRunsTheSameResource()
    {
        var v = EscrowVector.Load();
        using var identity = EscrowIdentity.Generate(EscrowBackend.Managed);
        var (result, host, _, log) = await Load(v.Bundle, EscrowKit.MasterLike(v.ContentKey), identity);
        using (host)
        {
            Assert.IsTrue(result.Ok, result.Reason);
            using var content = result.Content!;
            Assert.AreEqual(EscrowBackend.Managed, content.Backend);
            var name = host.AddResource(result.ResourceRoot!, checkFolderName: false);
            Assert.IsTrue(host.Start(name).Ok, log.ToString());
            host.RunFor(50);
            Assert.IsTrue(log.Has("escrow secret ok 42"), log.ToString());
            // Honest accounting: on this backend the scripts were read as managed bytes.
            Assert.IsTrue(content.ManagedCopies >= 2, "the managed backend serves scripts through the managed door.");
        }
    }

    [TestMethod]
    public async Task AJavaScriptGuestUsesTheManagedDoorAndLuaStillDoesNot()
    {
        EscrowKit.RequireNative();
        var v = EscrowVector.Load();
        var bundle = EscrowKit.Pack(v,
            clear: [("scriptgo.lua", "resource \"mixed\"\nversion \"1.0.0\"\nserver_script \"server/main.lua\"\nserver_script \"server/extra.js\"\n")],
            encrypted:
            [
                ("server/main.lua", "print('lua from escrow')\n"),
                ("server/extra.js", "console.log('js from escrow');\n"),
            ]);
        using var identity = EscrowIdentity.Generate();
        var (result, host, _, log) = await Load(bundle, EscrowKit.MasterLike(v.ContentKey), identity);
        using (host)
        {
            Assert.IsTrue(result.Ok, result.Reason);
            using var content = result.Content!;
            var name = host.AddResource(result.ResourceRoot!, checkFolderName: false);
            Assert.IsTrue(host.Start(name).Ok, log.ToString());
            host.RunFor(50);
            Assert.IsTrue(log.Has("lua from escrow") && log.Has("js from escrow"), log.ToString());
            // Jint takes managed source: exactly one file crossed into managed memory, the JavaScript one.
            Assert.AreEqual(1, content.ManagedCopies);
        }
    }

    [TestMethod]
    public async Task ALuaErrorInAnEscrowedScriptIsReportedWithItsChunkName()
    {
        EscrowKit.RequireNative();
        var v = EscrowVector.Load();
        var bundle = EscrowKit.Pack(v,
            clear: [("scriptgo.lua", "resource \"broken\"\nversion \"1.0.0\"\nserver_script \"server/main.lua\"\n")],
            encrypted: [("server/main.lua", "local x = = 1\n")]);
        using var identity = EscrowIdentity.Generate();
        var (result, host, _, log) = await Load(bundle, EscrowKit.MasterLike(v.ContentKey), identity);
        using (host)
        {
            Assert.IsTrue(result.Ok, result.Reason);
            using var content = result.Content!;
            var name = host.AddResource(result.ResourceRoot!, checkFolderName: false);
            var started = host.Start(name);
            Assert.IsFalse(started.Ok);
            StringAssert.Contains(started.Reason, "broken/server/main.lua:1");
            Assert.AreEqual(0, content.ManagedCopies);
        }
    }

    [TestMethod]
    public async Task RefusesOnAnUnlicensedOrRevokedKey()
    {
        var v = EscrowVector.Load();
        using var identity = EscrowIdentity.Generate(EscrowBackend.Managed);
        var (result, host, _, _) = await Load(v.Bundle, new EscrowKit.ScriptedKeyService((_, _) => EscrowKeyResult.Refused("revoked")), identity);
        using (host)
        {
            Assert.IsFalse(result.Ok);
            Assert.AreEqual("refused:revoked", result.Reason);
            Assert.IsNull(result.ResourceRoot);
        }
    }

    [TestMethod]
    public async Task RefusesWhenTheKeyWasWrappedToAnotherServer()
    {
        EscrowKit.RequireNative();
        var v = EscrowVector.Load();
        // The master wrapped the key to the bound server; this server only has a copy of everything else.
        using var thisServer = EscrowIdentity.Generate();
        var (result, host, _, _) = await Load(v.Bundle, EscrowKit.VectorKeys(v), thisServer);
        using (host)
        {
            Assert.IsFalse(result.Ok, "a key wrapped to another server must not unwrap here.");
            StringAssert.StartsWith(result.Reason, "unwrap_failed");
        }
    }

    [TestMethod]
    public async Task ARevocationStopsTheResourceOnTheHostThread()
    {
        EscrowKit.RequireNative();
        var v = EscrowVector.Load();
        var time = new ManualTimeProvider(new DateTimeOffset(2026, 11, 10, 12, 0, 0, TimeSpan.Zero));
        var refuse = false;
        var keys = new EscrowKit.ScriptedKeyService((manifest, identity) => refuse
            ? EscrowKeyResult.Refused("refunded")
            : EscrowKeyResult.Granted(EscrowKit.Wrap(v.ContentKey, identity.PublicKey, Encoding.UTF8.GetBytes(manifest.Aad)), null,
                time.GetUtcNow().AddMinutes(15), time.GetUtcNow().AddMinutes(30)));
        using var identity = EscrowIdentity.Generate();
        var (result, host, files, log) = await Load(v.Bundle, keys, identity, new EscrowOpenOptions { TimeProvider = time });
        using (host)
        {
            Assert.IsTrue(result.Ok, result.Reason);
            using var content = result.Content!;
            var name = host.AddResource(result.ResourceRoot!, checkFolderName: false);
            Assert.IsTrue(host.Start(name).Ok, log.ToString());
            EscrowLoader.BindLease(host, name, content, new EscrowRenewalOptions { RetryInterval = TimeSpan.FromSeconds(30) });
            host.RunFor(20);
            Assert.AreEqual("started", host.ResourceState(name));

            // The buyer is refunded. The resource runs to the end of offline grace, then is stopped.
            refuse = true;
            for (var i = 0; i < 400 && content.State != EscrowLeaseState.Revoked; i++)
            {
                time.Advance(TimeSpan.FromSeconds(30));
                SpinWait.SpinUntil(() => content.State == EscrowLeaseState.Revoked, TimeSpan.FromMilliseconds(5));
                host.Tick();
                if (content.State != EscrowLeaseState.Revoked) Assert.AreEqual("started", host.ResourceState(name), "it must keep running until grace ends.");
            }
            Assert.AreEqual(EscrowLeaseState.Revoked, content.State);
            Assert.IsTrue(time.GetUtcNow() >= content.OfflineGraceUntil);

            host.Tick(); // the stop was queued by the renewal task; the host applies it on its own thread
            Assert.AreEqual("stopped", host.ResourceState(name));
            Assert.IsTrue(log.Has("escrow_revoked:refused:refunded"), log.ToString());

            // The decrypted files are gone: the resource cannot be started again from this content.
            Assert.IsNull(files.Read(result.ResourceRoot!, "server/main.lua"));
            Assert.IsFalse(host.Start(name).Ok);
        }
    }

    // ---------------- Option A: materialize to a resources root and run from disk (as OPEN//77 does).
    // The license-only-grade fallback: the plaintext lands on the operator's disk.

    [TestMethod]
    public async Task MaterializesAndRunsFromDiskLikeOpen77()
    {
        EscrowKit.RequireNative();
        var v = EscrowVector.Load();
        using var identity = EscrowIdentity.Generate();
        var resourcesRoot = Path.Combine(Path.GetTempPath(), "sg-escrow-materialize", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(resourcesRoot);
        try
        {
            var (ok, reason, dir) = await EscrowMaterializer.MaterializeAsync(
                v.Bundle, resourcesRoot, identity, EscrowKit.MasterLike(v.ContentKey), v.signerPublicKeyB64Url);
            Assert.IsTrue(ok, "materialize must succeed: " + reason);
            Assert.AreEqual("demo", Path.GetFileName(dir));
            Assert.IsTrue(File.Exists(Path.Combine(dir!, "scriptgo.lua")), "the manifest must be on disk for a disk-reading host.");
            Assert.IsTrue(File.Exists(Path.Combine(dir!, "server", "main.lua")), "the decrypted script is on disk: this path makes no secrecy claim.");
            Assert.IsTrue(File.Exists(Path.Combine(dir!, EscrowFormat.DeliveryMarker)), "the copy carries the delivery marker.");

            // A fresh host with the default FolderFiles loads the materialized folder from disk and runs it
            // — the same path OPEN//77's ServerResourceHost.Discover/ReadFromDisk uses. No core change.
            var log = new CaptureLog();
            using var host = new ScriptGoHost(new HostServices { Log = log }, new HostOptions { Environment = "dotnet" });
            var name = host.AddResource(dir!);
            Assert.IsTrue(host.Start(name).Ok, log.ToString());
            host.RunFor(50);
            Assert.IsTrue(log.Has("escrow secret ok 42"), "the decrypted script must run from the materialized folder.\n" + log);

            // A refused key writes nothing.
            var refusedRoot = Path.Combine(resourcesRoot, "refused");
            Directory.CreateDirectory(refusedRoot);
            var refused = await EscrowMaterializer.MaterializeAsync(v.Bundle, refusedRoot, identity,
                new EscrowKit.ScriptedKeyService((_, _) => EscrowKeyResult.Refused("unbound")), v.signerPublicKeyB64Url);
            Assert.IsFalse(refused.Ok);
            Assert.AreEqual("refused:unbound", refused.Reason);
            Assert.AreEqual(0, Directory.GetFileSystemEntries(refusedRoot).Length);
        }
        finally { try { Directory.Delete(resourcesRoot, recursive: true); } catch (IOException) { } }
    }
}
