using System.Security.Cryptography;
using System.Text;
using KeraLua;
using ScriptGo.Escrow;
using ScriptGo.Escrow.Managed;

namespace ScriptGo.Host.Tests;

/// <summary>
/// ScriptGo.Escrow against the cross-language vector: the TypeScript packer, the managed loader and
/// the native loader (libscriptgo) must agree byte for byte, refuse the same things, and the native
/// path must get a Lua chunk into a VM without the plaintext entering managed memory.
/// </summary>
[TestClass]
public sealed class EscrowTests
{
    private static readonly Lazy<LuaChunkLoader> Lua54 = new(() => LuaChunkLoader.FromLibraryName("lua54", typeof(Lua).Assembly));

    private static async Task<EscrowContent> OpenVector(EscrowBackend backend, EscrowKit.ScriptedKeyService? keys = null)
    {
        var v = EscrowVector.Load();
        var identity = v.ServerIdentity(backend);
        return await EscrowSession.OpenAsync(v.Bundle, identity, keys ?? EscrowKit.VectorKeys(v), v.signerPublicKeyB64Url);
    }

    private static async Task<EscrowException> Refused(byte[] bundle, EscrowIdentity identity, IEscrowKeyService keys, string? trustedSigner)
    {
        try
        {
            using var content = await EscrowSession.OpenAsync(bundle, identity, keys, trustedSigner);
            Assert.Fail("the bundle must be refused, but it opened.");
            throw new InvalidOperationException();
        }
        catch (EscrowException e) { return e; }
    }

    // ------------------------------------------------------------------ the vector, managed primitives

    [TestMethod]
    public void X25519AgreesWithNodeOnTheVector()
    {
        var v = EscrowVector.Load();
        var shared = ManagedCrypto.X25519Agree(Convert.FromHexString(v.x25519Probe.probePrivateHex), v.ServerPublic);
        Assert.AreEqual(v.x25519Probe.sharedHex, Convert.ToHexStringLower(shared), "NSec X25519 must match Node's diffieHellman.");
    }

    [TestMethod]
    public void CanonicalManifestIsTheBytesTheTypeScriptPackerSigned()
    {
        var v = EscrowVector.Load();
        var bundle = EscrowBundle.Read(v.Bundle);
        Assert.AreEqual(v.canonicalManifest, bundle.CanonicalManifestWithoutSignature());
        Assert.AreEqual(v.signerPublicKeyB64Url, bundle.Manifest.SignerPublicKey);
        Assert.IsNull(bundle.FirstTamperedClearFile());
    }

    [TestMethod]
    public void ManagedBackendDecryptsTheVectorWithTheContentKey()
    {
        var v = EscrowVector.Load();
        var bundle = EscrowBundle.Read(v.Bundle);
        Assert.IsTrue(bundle.Verify(v.signerPublicKeyB64Url).Ok, "the ed25519 signature must verify (canonical JSON parity).");
        var files = bundle.DecryptManaged(v.ContentKey);
        CollectionAssert.AreEquivalent(v.encryptedFiles, files.Keys.ToList());
        foreach (var path in v.encryptedFiles)
            Assert.AreEqual(v.expectedFiles[path], Encoding.UTF8.GetString(files[path]), $"decrypted {path} must match the TS plaintext.");
        // A wrong content key fails the AEAD tag.
        Assert.Throws<CryptographicException>(() => bundle.DecryptManaged(new byte[32]));
    }

    [TestMethod]
    public void ManagedBackendUnwrapsTheVectorKey()
    {
        var v = EscrowVector.Load();
        using var identity = v.ServerIdentity(EscrowBackend.Managed);
        var contentKey = identity.UnwrapManaged(v.wrappedKey, Encoding.UTF8.GetBytes(v.aad));
        Assert.AreEqual(v.contentKeyHex, Convert.ToHexStringLower(contentKey), "the unwrapped key must be the vector content key.");
        CollectionAssert.AreEqual(v.ServerPublic, identity.PublicKey);
    }

    // ------------------------------------------------------------------ the native backend

    [TestMethod]
    public void NativeLibraryIsLoadedFromThePackageLayout()
    {
        EscrowKit.RequireNative();
        Assert.IsNotNull(EscrowNativeLibrary.Version);
        Assert.IsNotNull(EscrowNativeLibrary.LoadedFrom, "the library must come from an absolute path this package chose, not from a PATH search.");
        StringAssert.EndsWith(EscrowNativeLibrary.LoadedFrom, EscrowNativeLibrary.FileName);
        StringAssert.Contains(EscrowNativeLibrary.LoadedFrom.Replace('\\', '/'), $"runtimes/{EscrowNativeLibrary.RuntimeIdentifier}/native/");
    }

    [TestMethod]
    public async Task NativeBackendOpensTheVector()
    {
        EscrowKit.RequireNative();
        var v = EscrowVector.Load();
        using var content = await OpenVector(EscrowBackend.Native);
        Assert.AreEqual(EscrowBackend.Native, content.Backend);
        Assert.AreEqual("kestrel//demo", content.Manifest.Package);
        CollectionAssert.AreEqual(v.encryptedFiles.Order(StringComparer.Ordinal).ToList(), content.EncryptedEntries.Select(e => e.Path).ToList());
        foreach (var entry in content.EncryptedEntries)
            Assert.AreEqual(Encoding.UTF8.GetByteCount(v.expectedFiles[entry.Path]), entry.Size);
        // Clear files are public and checked against the signed manifest.
        Assert.AreEqual(v.expectedFiles["scriptgo.lua"], Encoding.UTF8.GetString(content.ClearFiles["scriptgo.lua"]));
        Assert.IsFalse(content.ContainsEncrypted("scriptgo.lua"));
        Assert.IsTrue(content.ContainsEncrypted("server/main.lua"));
        // Both watermarks: the release one from the signed manifest, the delivery one from the key answer.
        Assert.AreEqual(v.watermark, content.Manifest.Watermark);
        Assert.AreEqual("{\"token\":\"delivery-abc\"}", content.DeliveryWatermark);
        Assert.AreEqual("{\"token\":\"delivery-abc\"}\n", Encoding.UTF8.GetString(content.ReadAllBytes(EscrowFormat.DeliveryMarker)));
        Assert.AreEqual(0, content.ManagedCopies, "reading the delivery marker is not a copy of creator code.");
    }

    [TestMethod]
    public async Task NativeBackendRunsADecryptedChunkInKeraLuaWithoutAManagedCopy()
    {
        EscrowKit.RequireNative();
        using var content = await OpenVector(EscrowBackend.Native);
        using var lua = new Lua();

        // server/secret.lua is `return { answer = 42 }`: compiled from native memory, then run.
        var loaded = content.LoadLuaChunk(lua.Handle, "server/secret.lua", "@demo/server/secret.lua", Lua54.Value);
        Assert.AreEqual(LuaChunkStatus.Loaded, loaded.Status);
        Assert.AreEqual(LuaType.Function, lua.Type(-1));
        Assert.AreEqual(LuaStatus.OK, lua.PCall(0, 1, 0));
        lua.GetField(-1, "answer");
        Assert.AreEqual(42, lua.ToInteger(-1));
        lua.SetTop(0);

        // Not Lua: Lua's own message is left on the stack and names the chunk.
        var broken = content.LoadLuaChunk(lua.Handle, "data/notes.txt", "@demo/data/notes.txt", Lua54.Value);
        Assert.AreEqual(LuaChunkStatus.LuaError, broken.Status);
        Assert.AreEqual((int)LuaStatus.ErrSyntax, broken.LuaStatus);
        StringAssert.Contains(lua.ToString(-1), "demo/data/notes.txt");
        lua.SetTop(0);

        // Precompiled bytecode is refused: the loader always passes mode "t".
        var bytecode = content.LoadLuaChunk(lua.Handle, "data/precompiled.luac", "=precompiled", Lua54.Value);
        Assert.AreEqual(LuaChunkStatus.LuaError, bytecode.Status);
        StringAssert.Contains(lua.ToString(-1), "binary");
        lua.SetTop(0);

        // A missing file and a clear file push nothing.
        Assert.AreEqual(LuaChunkStatus.NotFound, content.LoadLuaChunk(lua.Handle, "server/missing.lua", "=x", Lua54.Value).Status);
        Assert.AreEqual(LuaChunkStatus.NotFound, content.LoadLuaChunk(lua.Handle, "config.lua", "=x", Lua54.Value).Status);
        Assert.AreEqual(0, lua.GetTop());

        Assert.AreEqual(0, content.ManagedCopies, "the native Lua path must never go through the managed copy door.");
    }

    [TestMethod]
    public async Task TheCopyDoorIsCountedAndExplicit()
    {
        EscrowKit.RequireNative();
        var v = EscrowVector.Load();
        using var content = await OpenVector(EscrowBackend.Native);
        Assert.AreEqual(0, content.ManagedCopies);
        Assert.AreEqual(v.expectedFiles["data/notes.txt"], Encoding.UTF8.GetString(content.ReadAllBytes("data/notes.txt")));
        Assert.AreEqual(1, content.ManagedCopies);
        var buffer = new byte[64];
        var written = content.CopyTo("server/secret.lua", buffer);
        Assert.AreEqual(v.expectedFiles["server/secret.lua"], Encoding.UTF8.GetString(buffer, 0, written));
        Assert.AreEqual(2, content.ManagedCopies);
        Assert.Throws<ArgumentException>(() => content.CopyTo("server/secret.lua", new byte[3]));
        Assert.Throws<FileNotFoundException>(() => content.ReadAllBytes("server/missing.lua"));
        Assert.IsTrue(content.TryGetSize("server/secret.lua", out var size));
        Assert.AreEqual(23, size);
    }

    [TestMethod]
    public async Task ManagedFallbackAgreesWithNativeOnTheVector()
    {
        EscrowKit.RequireNative();
        using var native = await OpenVector(EscrowBackend.Native);
        using var managed = await OpenVector(EscrowBackend.Managed);
        Assert.AreEqual(EscrowBackend.Managed, managed.Backend);
        Assert.IsFalse(managed.MemoryLocked, "the managed backend never claims locked memory.");

        CollectionAssert.AreEqual(native.EncryptedEntries.ToList(), managed.EncryptedEntries.ToList(), "same files, same sizes, same order.");
        foreach (var entry in native.EncryptedEntries)
            CollectionAssert.AreEqual(native.ReadAllBytes(entry.Path), managed.ReadAllBytes(entry.Path), $"{entry.Path} must be byte-identical.");
        CollectionAssert.AreEquivalent(native.ClearFiles.Keys.ToList(), managed.ClearFiles.Keys.ToList());
        CollectionAssert.AreEqual(native.ReadAllBytes(EscrowFormat.DeliveryMarker), managed.ReadAllBytes(EscrowFormat.DeliveryMarker));

        // The same chunk gives the same value in a real Lua through either backend.
        foreach (var content in new[] { native, managed })
        {
            using var lua = new Lua();
            Assert.AreEqual(LuaChunkStatus.Loaded, content.LoadLuaChunk(lua.Handle, "server/secret.lua", "@demo/server/secret.lua", Lua54.Value).Status);
            Assert.AreEqual(LuaStatus.OK, lua.PCall(0, 1, 0));
            lua.GetField(-1, "answer");
            Assert.AreEqual(42, lua.ToInteger(-1), content.Backend.ToString());
            lua.SetTop(0);
            Assert.AreEqual(LuaChunkStatus.LuaError, content.LoadLuaChunk(lua.Handle, "data/precompiled.luac", "=precompiled", Lua54.Value).Status, content.Backend.ToString());
        }
    }

    // ------------------------------------------------------------------ refusals, on both backends

    [TestMethod]
    public async Task RefusesATamperedPayload()
    {
        var v = EscrowVector.Load();
        // One flipped bit in payload.enc: it no longer matches the hash in the signed manifest.
        var tampered = EscrowKit.Tamper(v, files => files["payload.enc"][5] ^= 0x01);
        foreach (var backend in EscrowKit.AvailableBackends())
        {
            using var identity = v.ServerIdentity(backend);
            var e = await Refused(tampered, identity, EscrowKit.VectorKeys(v), v.signerPublicKeyB64Url);
            Assert.AreEqual(EscrowFailure.DecryptFailed, e.Failure, backend.ToString());
            StringAssert.StartsWith(e.Reason, "decrypt_failed:", backend.ToString());
        }

        // An attacker who also re-signs the manifest (they would need the signing key) still fails:
        // the AEAD tag does not verify.
        var payload = EscrowKit.Unzip(v.Bundle)["payload.enc"];
        payload[^1] ^= 0x01;
        var resigned = EscrowKit.Signed(v, payload, Base64Url.Decode(EscrowBundle.Read(v.Bundle).Manifest.Payload.Nonce));
        foreach (var backend in EscrowKit.AvailableBackends())
        {
            using var identity = v.ServerIdentity(backend);
            var e = await Refused(resigned, identity, EscrowKit.VectorKeys(v), v.signerPublicKeyB64Url);
            Assert.AreEqual(EscrowFailure.DecryptFailed, e.Failure, backend.ToString());
        }
    }

    [TestMethod]
    public async Task RefusesAnUnboundServer()
    {
        var v = EscrowVector.Load();
        foreach (var backend in EscrowKit.AvailableBackends())
        {
            // This server holds the bundle and even the wrapped key, but not the bound private key.
            using var stranger = EscrowIdentity.Generate(backend);
            var e = await Refused(v.Bundle, stranger, EscrowKit.VectorKeys(v), v.signerPublicKeyB64Url);
            Assert.AreEqual(EscrowFailure.UnwrapFailed, e.Failure, backend.ToString());
            StringAssert.StartsWith(e.Reason, "unwrap_failed:", backend.ToString());
        }
    }

    [TestMethod]
    public async Task RefusesABadSignatureBeforeAskingForAKey()
    {
        var v = EscrowVector.Load();
        // The manifest claims another version: the signature no longer covers it.
        var forged = EscrowKit.Tamper(v, files =>
            files["escrow.json"] = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(files["escrow.json"]).Replace("\"1.0.0\"", "\"9.9.9\"")));
        // A README changed after signing.
        var readme = EscrowKit.Tamper(v, files => files["README.md"] = "# demo\nedited after signing\n"u8.ToArray());

        foreach (var backend in EscrowKit.AvailableBackends())
        {
            using var identity = v.ServerIdentity(backend);
            var keys = EscrowKit.VectorKeys(v);

            var e = await Refused(forged, identity, keys, v.signerPublicKeyB64Url);
            Assert.AreEqual(EscrowFailure.Signature, e.Failure, backend.ToString());
            Assert.AreEqual("signature:bad signature", e.Reason);

            // A correct signature by a key we do not trust is refused too (provenance, not just integrity).
            e = await Refused(v.Bundle, identity, keys, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            Assert.AreEqual("signature:signer is not the trusted release key", e.Reason);

            e = await Refused(readme, identity, keys, v.signerPublicKeyB64Url);
            StringAssert.Contains(e.Reason, "clear file README.md is missing or tampered");

            e = await Refused("not a zip at all"u8.ToArray(), identity, keys, v.signerPublicKeyB64Url);
            Assert.AreEqual(EscrowFailure.InvalidBundle, e.Failure);

            Assert.AreEqual(0, keys.Requests, "a bundle that fails verification must never cause a key request.");
        }
    }

    [TestMethod]
    public async Task RefusesHostileArchivesBehindAValidSignatureAndKey()
    {
        var v = EscrowVector.Load();
        // Each payload authenticates under the real content key and sits behind a valid signature:
        // only the archive checks stand between it and the host.
        foreach (var (name, hostile) in v.hostile)
        {
            var bundle = EscrowKit.Signed(v, Convert.FromHexString(hostile.payloadHex), Convert.FromHexString(hostile.nonceHex));
            foreach (var backend in EscrowKit.AvailableBackends())
            {
                using var identity = v.ServerIdentity(backend);
                var e = await Refused(bundle, identity, EscrowKit.VectorKeys(v), v.signerPublicKeyB64Url);
                Assert.AreEqual(EscrowFailure.InvalidBundle, e.Failure, $"{name} on {backend}: {e.Reason}");
            }
        }
        Assert.IsTrue(v.hostile.ContainsKey("traversal") && v.hostile.ContainsKey("badCrc") && v.hostile.ContainsKey("notAZip"));
    }

    [TestMethod]
    public void UnsafePathsAreRefusedTheSameWayEverywhere()
    {
        foreach (var path in new[] { "../escape.lua", "server/../../escape.lua", "/etc/escape.lua", "..\\escape.lua", "C:/escape.lua", "a//b.lua", "./a.lua", "a/./b.lua", "", "a\0b" })
            Assert.IsFalse(EscrowPaths.IsSafe(path), path);
        foreach (var path in new[] { "server/main.lua", "a.lua", "stream/deep/file.name.yft", ".scriptgo-escrow", "a..b/c" })
            Assert.IsTrue(EscrowPaths.IsSafe(path), path);
    }

    [TestMethod]
    public async Task ReportsALicenseRefusalAndAnUnreachableServiceDifferently()
    {
        var v = EscrowVector.Load();
        foreach (var backend in EscrowKit.AvailableBackends())
        {
            using var identity = v.ServerIdentity(backend);
            foreach (var reason in new[] { "revoked", "expired", "refunded", "unbound", "not_escrowed", "unknown_key" })
            {
                var e = await Refused(v.Bundle, identity, new EscrowKit.ScriptedKeyService((_, _) => EscrowKeyResult.Refused(reason)), v.signerPublicKeyB64Url);
                Assert.AreEqual(EscrowFailure.Refused, e.Failure);
                Assert.AreEqual("refused:" + reason, e.Reason);
                Assert.IsFalse(e.IsTransient);
            }
            var offline = await Refused(v.Bundle, identity, new EscrowKit.ScriptedKeyService((_, _) => EscrowKeyResult.Unreachable("http_503")), v.signerPublicKeyB64Url);
            Assert.AreEqual(EscrowFailure.KeyServiceUnreachable, offline.Failure);
            Assert.AreEqual("key_service_unreachable:http_503", offline.Reason);
            Assert.IsTrue(offline.IsTransient, "an unreachable key service is something to retry, not a refusal.");
        }
    }

    // ------------------------------------------------------------------ backend choice

    [TestMethod]
    public void TheDefaultBackendIsNativeAndItFailsClosed()
    {
        // (requested, caller opted in to the fallback, native library present) -> backend, or null = refuse.
        Assert.AreEqual(EscrowBackend.Native, EscrowIdentity.ChooseBackend(EscrowBackend.Native, allowManagedFallback: false, nativeAvailable: true));
        Assert.AreEqual(EscrowBackend.Native, EscrowIdentity.ChooseBackend(EscrowBackend.Native, allowManagedFallback: true, nativeAvailable: true));
        Assert.IsNull(EscrowIdentity.ChooseBackend(EscrowBackend.Native, allowManagedFallback: false, nativeAvailable: false),
            "a missing native library must never silently become managed decryption.");
        Assert.AreEqual(EscrowBackend.Managed, EscrowIdentity.ChooseBackend(EscrowBackend.Native, allowManagedFallback: true, nativeAvailable: false));
        Assert.AreEqual(EscrowBackend.Managed, EscrowIdentity.ChooseBackend(EscrowBackend.Managed, allowManagedFallback: false, nativeAvailable: true));
    }

    // ------------------------------------------------------------------ identity

    private static string TempFile(string name) => Path.Combine(Path.GetTempPath(), "sg-escrow-identity", Guid.NewGuid().ToString("N"), name);

    private static void Cleanup(string path)
    {
        try { Directory.Delete(Path.GetDirectoryName(path)!, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    [TestMethod]
    public async Task IdentityPersistsAcrossRunsWithoutLeavingNativeMemory()
    {
        EscrowKit.RequireNative();
        var v = EscrowVector.Load();
        var path = TempFile("server.identity");
        try
        {
            byte[] publicKey;
            using (var first = EscrowIdentity.LoadOrCreate(path))
            {
                Assert.IsTrue(first.Created, "the first run creates the identity.");
                Assert.AreEqual(EscrowBackend.Native, first.Backend);
                publicKey = first.PublicKey;
                Assert.AreEqual(32, publicKey.Length);
            }
            using (var second = EscrowIdentity.LoadOrCreate(path))
            {
                Assert.IsFalse(second.Created, "later runs load it.");
                CollectionAssert.AreEqual(publicKey, second.PublicKey, "the server keeps the public key its deployment knows.");
                Assert.Throws<IOException>(() => second.Save(path), "an identity is never overwritten unless asked.");
            }

            // The private key itself survives the file: an identity saved and loaded back opens the vector.
            var vectorPath = TempFile("vector.identity");
            try
            {
                using (var imported = v.ServerIdentity(EscrowBackend.Native)) imported.Save(vectorPath);
                var file = File.ReadAllBytes(vectorPath);
                Assert.IsTrue(file.AsSpan().StartsWith("SGIDENT1"u8));
                if (OperatingSystem.IsWindows())
                    Assert.IsTrue(file.AsSpan().IndexOf(v.ServerPrivate) < 0, "on Windows the private key is DPAPI-sealed, never stored raw.");
                using var restored = EscrowIdentity.LoadOrCreate(vectorPath);
                CollectionAssert.AreEqual(v.ServerPublic, restored.PublicKey);
                using var content = await EscrowSession.OpenAsync(v.Bundle, restored, EscrowKit.VectorKeys(v), v.signerPublicKeyB64Url);
                Assert.AreEqual(4, content.EncryptedEntries.Count);
            }
            finally { Cleanup(vectorPath); }
        }
        finally { Cleanup(path); }
    }

    [TestMethod]
    public async Task TheIdentityFileIsTheSameForBothBackends()
    {
        EscrowKit.RequireNative();
        var v = EscrowVector.Load();
        var fromNative = TempFile("native.identity");
        var fromManaged = TempFile("managed.identity");
        try
        {
            using (var identity = v.ServerIdentity(EscrowBackend.Native)) identity.Save(fromNative);
            using (var identity = v.ServerIdentity(EscrowBackend.Managed)) identity.Save(fromManaged);

            // A server that starts on the managed fallback keeps its identity when the native library arrives, and back.
            using var managedReadsNative = EscrowIdentity.LoadOrCreate(fromNative, EscrowBackend.Managed);
            using var nativeReadsManaged = EscrowIdentity.LoadOrCreate(fromManaged);
            Assert.AreEqual(EscrowBackend.Managed, managedReadsNative.Backend);
            Assert.AreEqual(EscrowBackend.Native, nativeReadsManaged.Backend);
            Assert.IsFalse(managedReadsNative.Created || nativeReadsManaged.Created);
            CollectionAssert.AreEqual(v.ServerPublic, managedReadsNative.PublicKey);
            CollectionAssert.AreEqual(v.ServerPublic, nativeReadsManaged.PublicKey);
            foreach (var identity in new[] { managedReadsNative, nativeReadsManaged })
            {
                using var content = await EscrowSession.OpenAsync(v.Bundle, identity, EscrowKit.VectorKeys(v), v.signerPublicKeyB64Url);
                Assert.AreEqual(identity.Backend, content.Backend);
            }
        }
        finally { Cleanup(fromNative); Cleanup(fromManaged); }
    }

    [TestMethod]
    public void ADamagedIdentityFileIsAnErrorNeverANewIdentity()
    {
        foreach (var backend in EscrowKit.AvailableBackends())
        {
            var path = TempFile("damaged.identity");
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var junk = Encoding.ASCII.GetBytes("this is not an identity file, though it is long enough to be read as one");
                File.WriteAllBytes(path, junk);
                // Minting a new identity here would silently unbind the server from its license.
                Assert.Throws<CryptographicException>(() => EscrowIdentity.LoadOrCreate(path, backend), backend.ToString());
                CollectionAssert.AreEqual(junk, File.ReadAllBytes(path), "the file must be left exactly as it was.");
            }
            finally { Cleanup(path); }
        }
    }
}
