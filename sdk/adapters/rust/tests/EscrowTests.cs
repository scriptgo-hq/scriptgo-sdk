// Escrow tests of the bridge, in the same plain .NET process as Program.cs.
//
// NOT THE REAL ENVIRONMENT. No Rust server, no Oxide or Carbon, no Unity Mono: the clock, the files,
// the log and the key service are fakes. What is real when the native library is present: libscriptgo
// (the X25519 identity, the unwrap, AES-256-GCM, the ed25519 check, the guarded memory), KeraLua's
// Lua 5.4 VM, the portable core and the Rust glue. Tests marked "native" are SKIPPED, with a message,
// when scriptgo.dll / libscriptgo.so is not found: a skip is not a pass.
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using NSec.Cryptography;
using ScriptGo.Bridge;
using ScriptGo.Bridge.Escrow;

internal static partial class Program
{
    private static string _nativeEscrow;
    private static int _skipped;
    private static int _nativeTests;

    private static void RunEscrowTests()
    {
        _nativeEscrow = FindNativeEscrow();
        Console.WriteLine();
        Console.WriteLine(_nativeEscrow != null
            ? "escrow: native library " + _nativeEscrow
            : "escrow: " + NativeLua.EscrowFileName + " not found (set SCRIPTGO_NATIVE_DIR, or copy it to sdk/adapters/rust/native/<rid>/): native tests are skipped");

        Test("escrow.canonical_json_matches_reference", CanonicalJson);
        Test("escrow.canonical_json_matches_ts_vector", CanonicalVector);
        Test("escrow.disabled_refuses_escrowed_folder", EscrowDisabled);
        Test("escrow.bad_master_url_keeps_escrow_off", EscrowBadMaster);
        Test("escrow.invalid_manifest", EscrowInvalidManifest);
        Test("escrow.native_missing", EscrowNativeMissing);
        Test("escrow.ordinary_stub_never_compiled", OrdinaryStubRefused);
        Test("escrow.enabled_keeps_conformance", EscrowKeepsConformance);

        Native("escrow.good_path_pending_then_runs", EscrowGoodPath);
        Native("escrow.ts_packed_vector_runs", EscrowVectorRuns);
        Native("escrow.second_identity_unbound", EscrowUnbound);
        Native("escrow.key_for_another_server_unbound", EscrowWrongWrap);
        Native("escrow.flipped_payload_byte_tampered", EscrowTamperedPayload);
        Native("escrow.bad_signature", EscrowBadSignature);
        Native("escrow.signer_not_trusted", EscrowSigner);
        Native("escrow.token_missing", EscrowTokenMissing);
        Native("escrow.refusal_codes_from_the_key_service", EscrowRefusalCodes);
        Native("escrow.revoked_at_renewal_stops_at_grace_end", EscrowRevokedAtRenewal);
        Native("escrow.unreachable_without_grant", EscrowUnreachableNoGrant);
        Native("escrow.unreachable_with_grant_grace_then_stop", EscrowUnreachableWithGrant);
        Native("escrow.unreachable_then_recovers", EscrowUnreachableRecovers);
        Native("escrow.stub_and_folder_tampering", EscrowStubTampering);
        Native("escrow.shared_vm_isolation", EscrowSharedVm);
        Native("escrow.dependent_waits_for_key", EscrowDependentWaits);
        Native("escrow.restart_reuses_grant_and_clear_edits", EscrowRestartAndEdits);
    }

    private static void Native(string name, Action body)
    {
        if (_nativeEscrow == null)
        {
            _skipped++;
            Console.WriteLine($"skip {name}: the native escrow library is not installed here");
            return;
        }
        _nativeTests++;
        Test(name, body);
    }

    // SCRIPTGO_NATIVE_DIR, then the adapter's gitignored native/ folder, then sdk/native's own dist.
    private static string FindNativeEscrow()
    {
        var rid = OperatingSystem.IsWindows() ? "win-x64" : OperatingSystem.IsMacOS() ? "osx" : "linux-x64";
        var file = NativeLua.EscrowFileName;
        var dirs = new List<string>();
        var env = Environment.GetEnvironmentVariable("SCRIPTGO_NATIVE_DIR");
        if (!string.IsNullOrEmpty(env)) { dirs.Add(env); dirs.Add(Path.Combine(env, rid)); }
        dirs.Add(Path.Combine(_repo, "sdk", "adapters", "rust", "native", rid));
        dirs.Add(Path.Combine(_repo, "sdk", "adapters", "rust", "native"));
        dirs.Add(Path.Combine(_repo, "sdk", "native", "dist", rid));
        return dirs.Select(d => Path.Combine(d, file)).FirstOrDefault(File.Exists);
    }

    // Rig -----------------------------------------------------------------------------------------------
    private sealed class EscrowRig : IDisposable
    {
        public readonly HostServices Services = new();
        public readonly CaptureLog Log = new();
        public readonly FakeClock Clock = new();
        public readonly FakeMaster Master;
        public readonly RuntimeOptions Options = new();
        public readonly string Resources, Tokens;
        public ScriptGoRuntime Runtime;

        public EscrowRig(string id, bool enabled = true, string identity = "a", bool http = true)
        {
            var home = Path.Combine(_tmp, "escrow", id);
            Resources = Path.Combine(home, "resources");
            Tokens = Path.Combine(home, "tokens");
            Directory.CreateDirectory(Resources);
            Directory.CreateDirectory(Tokens);
            Master = new FakeMaster(Clock);
            Services.Clock = Clock;
            Services.Log = Log;
            Services.Storage = new MemoryStorage();
            Services.Players = new FakePlayers();
            Services.Permissions = new FakePermissions();
            Services.Config = new FakeConfig();
            Services.Ui = new CaptureUi();
            if (http) Services.Http = Master;
            Options.SearchDirs.Add(Resources);
            Options.HttpTimeout = TimeSpan.FromSeconds(5);
            Options.Escrow = new EscrowOptions
            {
                Enabled = enabled,
                Master = "https://keys.test",
                IdentityFile = Path.Combine(_tmp, "escrow", "identity-" + identity + ".key"),
                TokensDirectory = Tokens,
                NativeLibrary = _nativeEscrow,
                RenewRetrySeconds = 30,
            };
        }

        /// <summary>Installs a release and its licence: the folder, the token file and the fake master's record.</summary>
        public FakeMaster.License Install(EscrowRelease release, string token = null)
        {
            release.Install(Resources);
            token ??= "sg_dep_" + release.Resource;
            File.WriteAllText(Path.Combine(Tokens, release.Resource + ".token"), token + "\n");
            return Master.Grant(token, release);
        }

        public string Folder(string resource) => Path.Combine(Resources, resource);

        public ScriptGoRuntime Boot()
        {
            Runtime = new ScriptGoRuntime(Services, Options);
            Runtime.Boot();
            return Runtime;
        }

        public void Tick(int times = 1)
        {
            for (int i = 0; i < times; i++)
            {
                Clock.Mono += 10;
                Runtime.Tick();
            }
        }

        // The key service answers from another thread; ticks until the condition holds or time is up.
        public bool Until(Func<bool> condition, int timeoutMs = 5000)
        {
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < timeoutMs)
            {
                Tick();
                if (condition()) return true;
                Thread.Sleep(2);
            }
            return condition();
        }

        public bool UntilLog(string needle, int timeoutMs = 5000) => Until(() => Log.Has(needle), timeoutMs);

        /// <summary>Ticks until no request is in flight and every answer has been handled.</summary>
        public void Settle()
        {
            Until(() => Runtime.PendingHttp == 0);
            Tick(3);
        }

        public string Line(string resource) =>
            Runtime.Status().Split('\n').FirstOrDefault(l => l.StartsWith(resource + " ", StringComparison.Ordinal)) ?? "";

        public void Dispose() => Runtime?.Dispose();
    }

    private const string PaidManifest = "resource \"paid\"\nversion \"1.2.0\"\nlua { \"5.4\" }\nenvironments { \"rust\" }\ncapabilities { \"events\" }\nshared_script \"config.lua\"\nserver_script \"server/main.lua\"\n";

    // A paid resource: its manifest, a README and a config stay clear; server/main.lua and a module are encrypted.
    private static EscrowRelease Paid(string main = null, string manifest = null, byte[] seed = null, string version = "1.2.0")
    {
        return EscrowRelease.Build("paid", "kestrel//paid", version,
            new Dictionary<string, string>
            {
                ["scriptgo.lua"] = manifest ?? PaidManifest.Replace("1.2.0", version),
                ["README.md"] = "# paid\nAn escrowed test resource.\n",
                ["config.lua"] = "Config = { rate = 7 }\n",
            },
            new Dictionary<string, string>
            {
                ["server/main.lua"] = main ?? """
                    local formula = require("lib.formula")
                    local secret = "kept in a local"
                    print("SECRET RAN " .. tostring(formula.answer(Config.rate)))
                    exports("price", function(n) return formula.answer(n) end)
                    function Quote(n) return formula.answer(n) end
                    function Reveal() return secret end
                    AddEventHandler("onResourceStop", function(name) if name == GetCurrentResourceName() then print("SECRET STOPPING") end end)
                    """,
                ["lib/formula.lua"] = "return { answer = function(n) return n * 6 end }\n",
            }, seed);
    }

    private static void Ordinary(string searchDir, string name, string code, string extra = "")
    {
        var root = Path.Combine(searchDir, name);
        Directory.CreateDirectory(Path.Combine(root, "server"));
        File.WriteAllText(Path.Combine(root, "scriptgo.lua"),
            $"resource \"{name}\"\nversion \"1.0.0\"\nlua {{ \"5.4\" }}\nenvironments {{ \"rust\" }}\ncapabilities {{ \"events\" }}\n{extra}\nserver_script \"server/main.lua\"\n", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(root, "server", "main.lua"), code, new UTF8Encoding(false));
    }

    private static void AssertRefused(EscrowRig rig, string resource, string code)
    {
        var line = rig.Line(resource);
        Assert(line.Contains("  failed  [escrow " + code + ": ", StringComparison.Ordinal), "status should refuse with " + code + ": " + line + "\n" + rig.Log.Dump());
        Assert(rig.Log.Has("[error] host " + resource + ": " + code + ": "), "no log line for " + code + ":\n" + rig.Log.Dump());
        Assert(!rig.Log.Has("started " + resource + " "), resource + " must not have started:\n" + rig.Log.Dump());
        Assert(!rig.Log.Has("SECRET RAN"), "the encrypted script ran:\n" + rig.Log.Dump());
    }

    // Tests that need no native library -------------------------------------------------------------------
    private static void CanonicalJson()
    {
        // Sorted keys at every level, integers, the emptied top-level signature: against an independent writer.
        const string plain = "{ \"b\": [1, 20, {\"z\": null, \"a\": true}], \"signature\": \"abc\", \"a\": \"kestrel//demo\", \"nested\": {\"signature\": \"kept\", \"B\": 2, \"a\": 1} }";
        var mine = Json.Canonical(Json.Parse(plain), true);
        Assert(mine == ReferenceCanonical.Of(plain, true), "canonical differs:\n" + mine + "\n" + ReferenceCanonical.Of(plain, true));
        Assert(mine == "{\"a\":\"kestrel//demo\",\"b\":[1,20,{\"a\":true,\"z\":null}],\"nested\":{\"B\":2,\"a\":1,\"signature\":\"kept\"},\"signature\":\"\"}", mine);
        // JavaScript's own rules, written out: -0 is 0, a control character is \u00XX or its short
        // form, '/' and non-ASCII text stay as they are, a surrogate pair stays a pair.
        var eAcute = ((char)0xE9).ToString();
        var emoji = char.ConvertFromUtf32(0x1F600);
        const string tricky = "{ \"t\": \"q\\\"\\\\\\/\\u0001\\n\\u00e9\\ud83d\\ude00 x\", \"n\": [-0, 9007199254740991], \"signature\": \"s\" }";
        var expected = "{\"n\":[0,9007199254740991],\"signature\":\"\",\"t\":\"q\\\"\\\\/\\u0001\\n" + eAcute + emoji + " x\"}";
        Assert(Json.Canonical(Json.Parse(tricky), true) == expected, Json.Canonical(Json.Parse(tricky), true));
        foreach (var bad in new[] { "{\"a\":1,\"a\":2}", "{\"a\":1.5}", "{\"7\":1}", "[1,]", "{\"a\":1} x", "\"\\x\"", "" })
        {
            bool refused = false;
            try { Json.Canonical(Json.Parse(bad), true); }
            catch (JsonError) { refused = true; }
            Assert(refused, "should be refused: " + bad);
        }
    }

    // The manifest of a bundle packed by the TypeScript packer: the bridge's canonical bytes must be the
    // bytes that packer signed. Checked here with NSec, so it runs without the native library too.
    private static void CanonicalVector()
    {
        var vector = Vector();
        var escrowJson = vector.Files["escrow.json"];
        var manifest = EscrowManifest.Parse(escrowJson);
        Assert(manifest.Package == "kestrel//demo" && manifest.Version == "1.0.0", manifest.Package);
        Assert(manifest.Encrypted.Contains("server/main.lua") && manifest.Clear.ContainsKey("scriptgo.lua"), "files");
        var signer = PublicKey.Import(SignatureAlgorithm.Ed25519, manifest.SignerPublicKey, KeyBlobFormat.RawPublicKey);
        Assert(SignatureAlgorithm.Ed25519.Verify(signer, manifest.Canonical, manifest.Signature), "the TypeScript packer's signature does not verify over the bridge's canonical JSON");
        Assert(Encoding.UTF8.GetString(manifest.Canonical) == ReferenceCanonical.Of(Encoding.UTF8.GetString(escrowJson), true), "canonical differs from the reference");
    }

    private sealed class VectorData
    {
        public Dictionary<string, byte[]> Files = new();
        public byte[] ServerPrivate, ServerPublic;
        public string Epk, Nonce, Wrapped, Signer;
    }

    // sdk/dotnet/ScriptGo.Host.Tests/Fixtures/escrow-vector.json: a release built by packages/escrow.
    private static VectorData Vector()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(_repo, "sdk", "dotnet", "ScriptGo.Host.Tests", "Fixtures", "escrow-vector.json")));
        var root = doc.RootElement;
        var v = new VectorData
        {
            ServerPrivate = Convert.FromHexString(root.GetProperty("serverPrivateHex").GetString()!),
            ServerPublic = Convert.FromHexString(root.GetProperty("serverPublicHex").GetString()!),
            Epk = root.GetProperty("wrappedKey").GetProperty("epk").GetString(),
            Nonce = root.GetProperty("wrappedKey").GetProperty("nonce").GetString(),
            Wrapped = root.GetProperty("wrappedKey").GetProperty("wrapped").GetString(),
            Signer = root.GetProperty("signerPublicKeyB64Url").GetString(),
        };
        using var zip = new System.IO.Compression.ZipArchive(new MemoryStream(Convert.FromBase64String(root.GetProperty("bundleB64").GetString()!)));
        foreach (var entry in zip.Entries)
        {
            using var s = entry.Open();
            using var ms = new MemoryStream();
            s.CopyTo(ms);
            v.Files[entry.FullName] = ms.ToArray();
        }
        return v;
    }

    private static void EscrowDisabled()
    {
        using var rig = new EscrowRig("disabled", enabled: false);
        rig.Install(Paid());
        Ordinary(rig.Resources, "plain", "print(\"PLAIN RAN dump=\" .. type(string.dump) .. \" meta=\" .. type(getmetatable(\"\")))\n");
        Ordinary(rig.Resources, "needs_paid", "print(\"NEEDS RAN\")\n", "dependency \"paid\"");
        rig.Boot();
        rig.Tick(5);
        AssertRefused(rig, "paid", "escrow_disabled");
        Assert(rig.Log.Lines.Count(l => l.Contains("escrow_disabled") && l.Contains(" paid: ")) == 1, "one clear line expected:\n" + rig.Log.Dump());
        // Ordinary resources are untouched: they run, and the VM is not narrowed for them.
        Assert(rig.Log.Has("PLAIN RAN dump=function meta=table"), rig.Log.Dump());
        Assert(rig.Line("plain") == "plain 1.0.0  started", rig.Line("plain"));
        Assert(rig.Line("needs_paid").Contains("failed", StringComparison.Ordinal) && !rig.Log.Has("NEEDS RAN"), rig.Runtime.Status());
        Assert(rig.Master.Requests == 0, "no request may leave while escrow is off");
        Assert(rig.Runtime.EscrowSummary == "off", rig.Runtime.EscrowSummary);
        // Asking again changes nothing.
        var r = rig.Runtime.Control("start", "paid");
        Assert(!r.Ok && r.Reason.Contains("escrow_disabled", StringComparison.Ordinal), r.Reason);
    }

    private static void EscrowBadMaster()
    {
        using var rig = new EscrowRig("badmaster");
        rig.Options.Escrow.Master = "http://keys.example.net";
        rig.Install(Paid());
        rig.Boot();
        rig.Tick(3);
        AssertRefused(rig, "paid", "escrow_disabled");
        Assert(rig.Log.Has("escrow.master must be https"), rig.Log.Dump());
        Assert(rig.Master.Requests == 0, "a deployment token must not travel over plain http");
    }

    private static void EscrowInvalidManifest()
    {
        using var rig = new EscrowRig("invalid");
        rig.Install(Paid());
        var path = Path.Combine(rig.Folder("paid"), "escrow.json");
        File.WriteAllText(path, File.ReadAllText(path).Replace("scriptgo-escrow/1", "scriptgo-escrow/9"));
        rig.Boot();
        rig.Tick(3);
        AssertRefused(rig, "paid", "invalid_manifest");
        Assert(rig.Line("paid").Contains("unsupported format", StringComparison.Ordinal), rig.Line("paid"));
        File.WriteAllText(path, "{ not json");
        var r = rig.Runtime.Control("start", "paid");
        Assert(!r.Ok && r.Reason.Contains("invalid_manifest", StringComparison.Ordinal), r.Reason);
        Assert(rig.Master.Requests == 0, "no request for a manifest that cannot be read");
    }

    private static void EscrowNativeMissing()
    {
        using var rig = new EscrowRig("nonative");
        rig.Options.Escrow.NativeLibrary = Path.Combine(_tmp, "escrow", "nowhere", NativeLua.EscrowFileName);
        rig.Install(Paid());
        Ordinary(rig.Resources, "plain", "print(\"PLAIN RAN\")\n");
        rig.Boot();
        rig.Tick(3);
        AssertRefused(rig, "paid", "native_missing");
        Assert(rig.Log.Has("PLAIN RAN"), rig.Log.Dump());
        Assert(rig.Master.Requests == 0, "no request without the native library");
    }

    // A script that starts like a stub is never compiled, in any resource, with or without escrow.
    private static void OrdinaryStubRefused()
    {
        using var rig = new EscrowRig("ordinarystub", enabled: false);
        Ordinary(rig.Resources, "looks_like", "-- scriptgo-escrow/1 x@1 sha256=00 path=server/main.lua\nprint(\"STUB RAN\")\n");
        rig.Boot();
        rig.Tick(3);
        Assert(!rig.Log.Has("STUB RAN"), "a stub was executed:\n" + rig.Log.Dump());
        Assert(rig.Log.Has("is the stub of an encrypted script and is never run"), rig.Log.Dump());
        Assert(rig.Line("looks_like").Contains("failed", StringComparison.Ordinal), rig.Runtime.Status());
    }

    // Turning escrow on narrows the VM for every resource (no string.dump, a sealed string metatable).
    // The conformance probe and the kits must not notice. No escrowed resource here: nothing native loads.
    private static void EscrowKeepsConformance()
    {
        using var rig = new EscrowRig("conformance", http: false);
        rig.Options.SearchDirs.Clear();
        rig.Options.SearchDirs.Add(Path.Combine(_repo, "sdk", "conformance"));
        rig.Options.SearchDirs.Add(Path.Combine(_repo, "sdk", "packages"));
        rig.Options.VerifyResource = "sg_probe";
        var rt = rig.Boot();
        for (int i = 0; i < 300; i++) rig.Tick();
        var report = rt.VerifyReport("plain .NET test host (not a Rust server)", "{}");
        using var doc = JsonDocument.Parse(report.Json);
        AllPassedExceptDeclared(doc.RootElement);
        Assert(doc.RootElement.GetProperty("log").GetString()!.Contains("SGCHECK DONE env=rust lua=Lua 5.4 pass=25 fail=0", StringComparison.Ordinal), "DONE line");
        Assert(rt.EscrowSummary.StartsWith("on, key service https://keys.test/v1/licenses/key, environment rust", StringComparison.Ordinal), rt.EscrowSummary);
        Assert(!rig.Log.Has("native library"), "the native library must not load while no escrowed resource starts");
    }

    // Tests with the real native library -----------------------------------------------------------------
    private static void EscrowGoodPath()
    {
        using var rig = new EscrowRig("good");
        var release = Paid();
        rig.Install(release);
        // A module only `require` reaches needs no stub on disk; a script the manifest lists does.
        File.Delete(Path.Combine(rig.Folder("paid"), "lib", "formula.lua"));
        Ordinary(rig.Resources, "plain", "print(\"PLAIN RAN\")\n");
        rig.Master.Hold = true;
        var rt = rig.Boot();
        rig.Tick(5);

        // The key is asked for through the host's HTTP service and has not arrived: pending, not failed.
        Assert(rig.Line("paid") == "paid 1.2.0  pending_key  [escrow pending_key: waiting for the key service]", rig.Line("paid"));
        Assert(rig.Log.Has("PLAIN RAN") && rig.Line("plain") == "plain 1.0.0  started", "ordinary resources do not wait:\n" + rig.Log.Dump());
        Assert(!rig.Log.Has("SECRET RAN") && !rig.Log.Has("[error]"), rig.Log.Dump());
        Assert(rig.Master.Requests == 1, "requests: " + rig.Master.Requests);

        rig.Master.Release();
        Assert(rig.UntilLog("started paid 1.2.0"), "paid never started:\n" + rig.Log.Dump());
        // The visible side effect of the encrypted script, with its encrypted module and its clear config.
        Assert(rig.Log.Has("SECRET RAN 42"), rig.Log.Dump());
        Assert(rig.Line("paid").StartsWith("paid 1.2.0  started  [escrow licensed, answer valid until ", StringComparison.Ordinal), rig.Line("paid"));
        Assert(!rig.Log.Has("[error]") && !rig.Log.Has("[warn]"), rig.Log.Dump());

        // What went to the key service.
        Assert(rig.Master.Seen.TryPeek(out var request), "no request");
        Assert(request.Method == "POST" && request.Url == "https://keys.test/v1/licenses/key", request.Url);
        using var body = JsonDocument.Parse(request.Body);
        var b = body.RootElement;
        Assert(b.GetProperty("deploymentToken").GetString() == "sg_dep_paid", request.Body);
        Assert(b.GetProperty("package").GetString() == "kestrel//paid" && b.GetProperty("version").GetString() == "1.2.0", request.Body);
        Assert(b.GetProperty("environment").GetString() == "rust" && b.GetProperty("adapterVersion").GetString() == "rust-0.1.0", request.Body);
        Assert(B64.FromUrl(b.GetProperty("serverPublicKey").GetString()!).Length == 32, request.Body);
        Assert(b.EnumerateObject().Count() == 6, "exactly six fields: " + request.Body);

        // On disk the script is still its stub, and the plaintext is nowhere in the folder.
        Assert(File.ReadAllText(Path.Combine(rig.Folder("paid"), "server", "main.lua")) == release.Stub("server/main.lua"), "stub changed");
        foreach (var f in Directory.EnumerateFiles(rig.Folder("paid"), "*", SearchOption.AllDirectories))
            Assert(!File.ReadAllText(f, Encoding.Latin1).Contains("SECRET RAN", StringComparison.Ordinal), "plaintext on disk in " + f);

        // Stop wipes the release; start asks nothing new while the answer is still valid.
        var r = rt.Control("stop", "paid");
        Assert(r.Ok && rig.Log.Has("SECRET STOPPING"), r.Reason + "\n" + rig.Log.Dump());
        Assert(rig.Line("paid") == "paid 1.2.0  stopped  [escrow not running]", rig.Line("paid"));
        r = rt.Control("start", "paid");
        Assert(r.Ok && r.Reason == "paid: started", r.Reason);
        Assert(rig.Master.Requests == 1, "a restart inside the answer's lifetime must not ask again: " + rig.Master.Requests);
        Assert(rig.Log.Lines.Count(l => l.Contains("SECRET RAN 42")) == 2, rig.Log.Dump());
    }

    // A release packed by the TypeScript packer (the cross-language fixture), its key wrapped by Node,
    // opened by the native library with the fixture's server key and run by this bridge.
    private static void EscrowVectorRuns()
    {
        var vector = Vector();
        using var rig = new EscrowRig("vector", identity: "vector");
        var root = rig.Folder("demo");
        foreach (var f in vector.Files)
        {
            var p = Path.Combine(root, f.Key.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(p)!);
            File.WriteAllBytes(p, f.Value);
        }
        var manifest = EscrowManifest.Parse(vector.Files["escrow.json"]);
        Directory.CreateDirectory(Path.Combine(root, "server"));
        File.WriteAllText(Path.Combine(root, "server", "main.lua"), manifest.StubLine("server/main.lua") + "\n");
        File.WriteAllText(Path.Combine(rig.Tokens, "demo.token"), "sg_dep_vector\n");

        string why;
        Assert(NativeLua.PreloadEscrow(null, _nativeEscrow, out why) != null, "preload: " + why);
        NativeIdentity.Save(vector.ServerPrivate, rig.Options.Escrow.IdentityFile);
        var answer = "{\"valid\":true,\"reason\":null,\"wrappedKey\":{\"epk\":\"" + vector.Epk + "\",\"nonce\":\"" + vector.Nonce + "\",\"wrapped\":\"" + vector.Wrapped
            + "\"},\"aad\":\"kestrel//demo@1.0.0\",\"signerPublicKey\":\"" + vector.Signer + "\",\"deliveryWatermark\":\"wm\",\"offlineGraceUntil\":\"2099-01-01T00:00:00.000Z\",\"expiresAt\":\"2098-01-01T00:00:00.000Z\"}";
        var http = new CannedHttp(answer);
        rig.Services.Http = http;
        rig.Boot();
        Assert(rig.UntilLog("escrow secret ok"), "the TypeScript-packed script did not run:\n" + rig.Log.Dump());
        Assert(rig.Line("demo").StartsWith("demo 1.0.0  started", StringComparison.Ordinal), rig.Line("demo"));
        using var body = JsonDocument.Parse(http.Bodies[0]);
        Assert(body.RootElement.GetProperty("serverPublicKey").GetString() == B64.Url(vector.ServerPublic), "public key of the imported identity");
    }

    private sealed class CannedHttp : IHostHttp
    {
        private readonly string _answer;
        public readonly List<string> Bodies = new();
        public CannedHttp(string answer) { _answer = answer; }
        public Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation)
        {
            lock (Bodies) Bodies.Add(request.Body);
            return Task.FromResult(new HttpResponseData(200, null, _answer));
        }
    }

    private static void EscrowUnbound()
    {
        var release = Paid();
        string firstKey;
        FakeMaster.License license;
        using (var first = new EscrowRig("bound-a", identity: "a"))
        {
            license = first.Install(release);
            first.Boot();
            Assert(first.UntilLog("SECRET RAN 42"), "the bound server must run it:\n" + first.Log.Dump());
            firstKey = license.BoundKey;
        }
        // The same folder and the same token, copied to a server with another identity.
        using var second = new EscrowRig("bound-b", identity: "b");
        release.Install(second.Resources);
        File.WriteAllText(Path.Combine(second.Tokens, "paid.token"), "sg_dep_paid\n");
        second.Master.Licenses["sg_dep_paid"] = license;
        second.Boot();
        second.Settle();
        AssertRefused(second, "paid", "unbound");
        using var body = JsonDocument.Parse(second.Master.Seen.Last().Body);
        Assert(body.RootElement.GetProperty("serverPublicKey").GetString() != firstKey, "the second identity must differ from the first");
    }

    // The answer is "valid" but its key is wrapped for another server: the native unwrap refuses it.
    private static void EscrowWrongWrap()
    {
        using var rig = new EscrowRig("wrongwrap");
        var license = rig.Install(Paid());
        using (var other = Key.Create(KeyAgreementAlgorithm.X25519)) license.WrapTo = other.PublicKey.Export(KeyBlobFormat.RawPublicKey);
        rig.Boot();
        rig.Settle();
        AssertRefused(rig, "paid", "unbound");
        Assert(rig.Line("paid").Contains("not released to this server's identity", StringComparison.Ordinal), rig.Line("paid"));
    }

    private static void EscrowTamperedPayload()
    {
        using var rig = new EscrowRig("payload");
        rig.Install(Paid());
        var path = Path.Combine(rig.Folder("paid"), "payload.enc");
        var bytes = File.ReadAllBytes(path);
        bytes[bytes.Length / 2] ^= 0x01;
        File.WriteAllBytes(path, bytes);
        rig.Boot();
        rig.Settle();
        AssertRefused(rig, "paid", "tampered");
        Assert(rig.Master.Requests == 0, "a tampered folder must not get a key");
        // Truncated: the signed size no longer matches either.
        File.WriteAllBytes(path, bytes.Take(bytes.Length - 1).ToArray());
        var r = rig.Runtime.Control("start", "paid");
        Assert(!r.Ok && r.Reason.Contains("tampered: payload.enc is ", StringComparison.Ordinal), r.Reason);
    }

    private static void EscrowBadSignature()
    {
        using var rig = new EscrowRig("signature");
        rig.Install(Paid());
        var path = Path.Combine(rig.Folder("paid"), "escrow.json");
        var original = File.ReadAllText(path);
        // A signed field changed: one more "encrypted" file.
        File.WriteAllText(path, original.Replace("\"lib/formula.lua\"", "\"lib/formula.lua\", \"lib/extra.lua\""));
        rig.Boot();
        rig.Settle();
        AssertRefused(rig, "paid", "signature");
        Assert(rig.Master.Requests == 0, "no key for a manifest whose signature does not verify");
        // The signature itself replaced by another well-formed one.
        using var doc = JsonDocument.Parse(original);
        var signature = doc.RootElement.GetProperty("signature").GetString();
        File.WriteAllText(path, original.Replace(signature, B64.Url(new byte[64])));
        var r = rig.Runtime.Control("start", "paid");
        Assert(!r.Ok && r.Reason.Contains("signature: ", StringComparison.Ordinal), r.Reason);
        // The untouched manifest verifies.
        File.WriteAllText(path, original);
        rig.Runtime.Control("start", "paid");
        Assert(rig.UntilLog("SECRET RAN 42"), rig.Log.Dump());
    }

    private static void EscrowSigner()
    {
        // Pinned: a release signed by somebody else is refused before any request.
        using (var rig = new EscrowRig("signer-pinned"))
        {
            using var trusted = Key.Import(SignatureAlgorithm.Ed25519, EscrowRelease.Seed(1), KeyBlobFormat.RawPrivateKey);
            rig.Options.Escrow.TrustedSigners.Add(B64.Url(trusted.PublicKey.Export(KeyBlobFormat.RawPublicKey)));
            rig.Install(Paid(seed: EscrowRelease.Seed(9)));
            rig.Boot();
            rig.Settle();
            AssertRefused(rig, "paid", "signature");
            Assert(rig.Line("paid").Contains("not in escrow.trustedSigners", StringComparison.Ordinal) && rig.Master.Requests == 0, rig.Line("paid"));
        }
        // Pinned to the right key: runs.
        using (var rig = new EscrowRig("signer-ok"))
        {
            var release = Paid();
            rig.Options.Escrow.TrustedSigners.Add(release.SignerPublicKey);
            rig.Install(release).SignerOverride = B64.Url(new byte[32]);   // what the service names is not consulted then
            rig.Boot();
            Assert(rig.UntilLog("SECRET RAN 42"), rig.Log.Dump());
        }
        // Nobody pinned: the signer must be the one the key service names for the licence.
        using (var rig = new EscrowRig("signer-named"))
        {
            using var real = Key.Import(SignatureAlgorithm.Ed25519, EscrowRelease.Seed(1), KeyBlobFormat.RawPrivateKey);
            // A re-signed copy: valid signature, somebody else's key.
            rig.Install(Paid(seed: EscrowRelease.Seed(9))).SignerOverride = B64.Url(real.PublicKey.Export(KeyBlobFormat.RawPublicKey));
            rig.Boot();
            rig.Settle();
            AssertRefused(rig, "paid", "signature");
            Assert(rig.Line("paid").Contains("not the signer the key service names", StringComparison.Ordinal), rig.Line("paid"));
        }
    }

    private static void EscrowTokenMissing()
    {
        using var rig = new EscrowRig("token");
        rig.Install(Paid());
        File.Delete(Path.Combine(rig.Tokens, "paid.token"));
        rig.Boot();
        rig.Settle();
        AssertRefused(rig, "paid", "token_missing");
        Assert(rig.Master.Requests == 0, "nothing to ask without a token");
        File.WriteAllText(Path.Combine(rig.Tokens, "paid.token"), "\n  \n");
        var r = rig.Runtime.Control("start", "paid");
        Assert(!r.Ok && r.Reason.Contains("token_missing", StringComparison.Ordinal), r.Reason);
        // The token arrives: an operator's start asks again.
        File.WriteAllText(Path.Combine(rig.Tokens, "paid.token"), "sg_dep_paid\n");
        r = rig.Runtime.Control("start", "paid");
        Assert(r.Ok && r.Reason.Contains("pending_key", StringComparison.Ordinal), r.Reason);
        Assert(rig.UntilLog("SECRET RAN 42"), rig.Log.Dump());
    }

    private static void EscrowRefusalCodes()
    {
        foreach (var (state, code) in new[]
        {
            ("unknown_key", "not_licensed"), ("environment_not_covered", "not_licensed"), ("deployment_limit", "not_licensed"), ("not_escrowed", "not_licensed"),
            ("revoked", "revoked"), ("refunded", "revoked"), ("deactivated", "revoked"), ("expired", "expired"), ("unbound", "unbound"),
        })
        {
            using var rig = new EscrowRig("code-" + state);
            rig.Install(Paid()).State = state;
            rig.Boot();
            rig.Settle();
            AssertRefused(rig, "paid", code);
            Assert(rig.Line("paid").Contains("the key service refused: " + state, StringComparison.Ordinal), rig.Line("paid"));
        }
        // A token the service does not know at all.
        using (var rig = new EscrowRig("code-stranger"))
        {
            rig.Install(Paid(), token: "sg_dep_known");
            File.WriteAllText(Path.Combine(rig.Tokens, "paid.token"), "sg_dep_stranger\n");
            rig.Boot();
            rig.Settle();
            AssertRefused(rig, "paid", "not_licensed");
        }
    }

    private static void EscrowRevokedAtRenewal()
    {
        using var rig = new EscrowRig("revoked");
        var license = rig.Install(Paid());
        rig.Master.TtlSeconds = 900;
        rig.Master.GraceSeconds = 3600;
        long start = rig.Clock.Unix;
        rig.Boot();
        Assert(rig.UntilLog("SECRET RAN 42"), rig.Log.Dump());
        Assert(rig.Master.Requests == 1, "one request to start");

        // Nothing is asked before the renewal is due (a fifth of the lifetime ahead, capped at 2 minutes).
        rig.Clock.Unix = start + 700;
        rig.Tick(5);
        Assert(rig.Master.Requests == 1, "renewed too early");

        // Renewal before expiresAt: the licence was revoked in the meantime.
        license.State = "revoked";
        rig.Clock.Unix = start + 790;
        Assert(rig.Until(() => rig.Master.Requests == 2), "no renewal before expiresAt");
        rig.Settle();
        Assert(rig.Log.Has("[warn] escrow paid: revoked: the key service refused: revoked. It keeps running until "), rig.Log.Dump());
        Assert(rig.Line("paid").StartsWith("paid 1.2.0  started  [escrow revoked: ", StringComparison.Ordinal), rig.Line("paid"));

        // It keeps running through the offline grace of the last valid answer...
        rig.Clock.Unix = start + 3599;
        rig.Settle();
        Assert(rig.Line("paid").StartsWith("paid 1.2.0  started", StringComparison.Ordinal) && !rig.Log.Has("SECRET STOPPING"), rig.Line("paid"));
        Assert(rig.Master.Requests > 2, "it keeps asking during the grace");
        Assert(rig.Log.Lines.Count(l => l.Contains("It keeps running until")) == 1, "the refusal is logged once:\n" + rig.Log.Dump());

        // ...and is stopped when it ends, with the reason.
        rig.Clock.Unix = start + 3600;
        rig.Tick(2);
        Assert(rig.Log.Has("SECRET STOPPING"), "the resource was not stopped:\n" + rig.Log.Dump());
        Assert(rig.Log.Has("[error] host paid: stopped: revoked: the key service refused: revoked, and the offline grace ended at "), rig.Log.Dump());
        Assert(rig.Line("paid").StartsWith("paid 1.2.0  failed  [escrow revoked: ", StringComparison.Ordinal), rig.Line("paid"));

        // It does not come back on its own, and an operator's start is refused while the licence is revoked.
        int asked = rig.Master.Requests;
        rig.Clock.Unix = start + 9000;
        rig.Settle();
        Assert(rig.Master.Requests == asked, "a stopped resource must not keep asking");
        var r = rig.Runtime.Control("start", "paid");
        Assert(r.Ok && r.Reason.Contains("pending_key", StringComparison.Ordinal), r.Reason);
        rig.Settle();
        Assert(rig.Line("paid").StartsWith("paid 1.2.0  failed  [escrow revoked: ", StringComparison.Ordinal), rig.Line("paid"));
        Assert(rig.Log.Lines.Count(l => l.Contains("SECRET RAN")) == 1, "it ran again after the revocation:\n" + rig.Log.Dump());
    }

    private static void EscrowUnreachableNoGrant()
    {
        foreach (var fault in new[] { 503, 404, -1 })
        {
            using var rig = new EscrowRig("unreachable-" + fault);
            rig.Install(Paid());
            Ordinary(rig.Resources, "plain", "print(\"PLAIN RAN\")\n");
            rig.Master.Fault = fault;
            rig.Boot();
            rig.Settle();
            AssertRefused(rig, "paid", "unreachable");
            Assert(rig.Line("paid").Contains("no earlier answer still inside its offline grace", StringComparison.Ordinal), rig.Line("paid"));
            Assert(rig.Log.Has("PLAIN RAN"), rig.Log.Dump());
        }
        // No HTTP service at all in the host.
        using (var rig = new EscrowRig("unreachable-nohttp", http: false))
        {
            rig.Install(Paid());
            rig.Boot();
            rig.Tick(5);
            AssertRefused(rig, "paid", "unreachable");
        }
        // A 200 whose body is not an answer is not a refusal either.
        using (var rig = new EscrowRig("unreachable-garbage"))
        {
            rig.Install(Paid());
            rig.Services.Http = new CannedHttp("<html>maintenance</html>");
            rig.Boot();
            rig.Settle();
            AssertRefused(rig, "paid", "unreachable");
        }
    }

    private static void EscrowUnreachableWithGrant()
    {
        using var rig = new EscrowRig("grace");
        rig.Install(Paid());
        long start = rig.Clock.Unix;
        rig.Boot();
        Assert(rig.UntilLog("SECRET RAN 42"), rig.Log.Dump());

        // The key service goes silent: the renewal fails, the earlier answer's grace applies.
        rig.Master.Fault = 503;
        rig.Clock.Unix = start + 800;
        Assert(rig.UntilLog("[warn] escrow paid: unreachable: the key service answered HTTP 503. It keeps running until "), rig.Log.Dump());
        Assert(rig.Line("paid").StartsWith("paid 1.2.0  started  [escrow unreachable: ", StringComparison.Ordinal), rig.Line("paid"));

        // A restart inside that grace still works without the key service: the earlier grant is reused.
        var r = rig.Runtime.Control("restart", "paid");
        Assert(r.Ok, r.Reason);
        Assert(rig.Until(() => rig.Log.Lines.Count(l => l.Contains("SECRET RAN 42")) == 2), "restart inside the grace:\n" + rig.Log.Dump());

        // The grace ends with no valid answer: stopped, reason unreachable.
        rig.Clock.Unix = start + 3601;
        Assert(rig.UntilLog("[error] host paid: stopped: unreachable: "), rig.Log.Dump());
        Assert(rig.Line("paid").StartsWith("paid 1.2.0  failed  [escrow unreachable: ", StringComparison.Ordinal), rig.Line("paid"));
        // After the grace there is nothing to fall back on.
        r = rig.Runtime.Control("start", "paid");
        rig.Settle();
        Assert(rig.Line("paid").Contains("failed  [escrow unreachable: ", StringComparison.Ordinal), rig.Line("paid"));
        Assert(rig.Log.Lines.Count(l => l.Contains("SECRET RAN 42")) == 2, rig.Log.Dump());
    }

    private static void EscrowUnreachableRecovers()
    {
        using var rig = new EscrowRig("recovers");
        rig.Install(Paid());
        long start = rig.Clock.Unix;
        rig.Boot();
        Assert(rig.UntilLog("SECRET RAN 42"), rig.Log.Dump());
        rig.Master.Fault = -1;
        rig.Clock.Unix = start + 800;
        Assert(rig.UntilLog("[warn] escrow paid: unreachable: "), rig.Log.Dump());
        // The service answers again inside the grace: nothing happens to the resource.
        rig.Master.Fault = 0;
        rig.Clock.Unix = start + 900;
        Assert(rig.UntilLog("the key service answers again, the licence is renewed"), rig.Log.Dump());
        rig.Clock.Unix = start + 3700;   // past the first answer's grace, inside the renewed one's
        rig.Settle();
        Assert(rig.Line("paid").StartsWith("paid 1.2.0  started  [escrow licensed, ", StringComparison.Ordinal), rig.Line("paid"));
        Assert(!rig.Log.Has("SECRET STOPPING") && !rig.Log.Has("[error]"), rig.Log.Dump());
    }

    private static void EscrowStubTampering()
    {
        // 1. Code appended to a stub: refused, and neither the code nor the real script runs.
        using (var rig = new EscrowRig("stub-code"))
        {
            var release = Paid();
            rig.Install(release);
            File.WriteAllText(Path.Combine(rig.Folder("paid"), "server", "main.lua"), release.Stub("server/main.lua") + "print(\"STUB RAN\")\n");
            rig.Boot();
            rig.Settle();
            AssertRefused(rig, "paid", "tampered");
            Assert(!rig.Log.Has("STUB RAN") && rig.Master.Requests == 0, rig.Log.Dump());
        }
        // 2. A script added next to the encrypted ones, picked up by a glob of the signed manifest.
        using (var rig = new EscrowRig("stub-added"))
        {
            rig.Install(Paid(manifest: PaidManifest.Replace("server_script \"server/main.lua\"", "server_scripts { \"server/*.lua\" }")));
            File.WriteAllText(Path.Combine(rig.Folder("paid"), "server", "zz_added.lua"), "print(\"ADDED RAN \" .. tostring(Config.rate))\n");
            rig.Boot();
            rig.Settle();
            AssertRefused(rig, "paid", "tampered");
            Assert(rig.Line("paid").Contains("server/zz_added.lua would run but is not part of the signed release", StringComparison.Ordinal), rig.Line("paid"));
            Assert(!rig.Log.Has("ADDED RAN"), rig.Log.Dump());
            // Without the added file, the same glob runs the encrypted script.
            File.Delete(Path.Combine(rig.Folder("paid"), "server", "zz_added.lua"));
            rig.Runtime.Control("start", "paid");
            Assert(rig.UntilLog("SECRET RAN 42"), rig.Log.Dump());
        }
        // 3. The resource manifest edited, or a second manifest slipped in front of the signed one.
        using (var rig = new EscrowRig("stub-manifest"))
        {
            rig.Install(Paid());
            var manifest = Path.Combine(rig.Folder("paid"), "scriptgo.lua");
            var original = File.ReadAllText(manifest);
            File.WriteAllText(manifest, original + "server_script \"server/extra.lua\"\n");
            File.WriteAllText(Path.Combine(rig.Folder("paid"), "server", "extra.lua"), "print(\"EXTRA RAN\")\n");
            rig.Boot();
            rig.Settle();
            AssertRefused(rig, "paid", "tampered");
            Assert(!rig.Log.Has("EXTRA RAN"), rig.Log.Dump());
        }
        // 4. The stub of a script the manifest runs is missing.
        using (var rig = new EscrowRig("stub-missing"))
        {
            rig.Install(Paid());
            File.Delete(Path.Combine(rig.Folder("paid"), "server", "main.lua"));
            rig.Boot();
            rig.Settle();
            AssertRefused(rig, "paid", "tampered");
        }
        // 5. A valid stub is a comment; with the release open it is dropped and the real chunk runs
        //    instead (escrow.good_path). The stub text itself reaches no compiler: see
        //    escrow.ordinary_stub_never_compiled for the refusal outside an escrowed resource.
    }

    // What another resource in the same VM can and cannot do to an escrowed one (README, "Escrow").
    private static void EscrowSharedVm()
    {
        using var rig = new EscrowRig("sharedvm");
        rig.Install(Paid());
        Ordinary(rig.Resources, "operator", """
            CreateThread(function()
                Wait(0)
                print("OP dump=" .. tostring(string.dump) .. " viamethod=" .. tostring(("x").dump))
                print("OP meta=" .. tostring(getmetatable("")))
                local patched = pcall(function() getmetatable("").__index.upper = function() return "HACKED" end end)
                print("OP patched=" .. tostring(patched) .. " upper=" .. ("abc"):upper())
                local module, why = require("@paid/lib.formula")
                print("OP require=" .. tostring(module) .. " why=" .. tostring(why))
                local main, why2 = require("@paid/server.main")
                print("OP requiremain=" .. tostring(main) .. " why=" .. tostring(why2))
                print("OP globals=" .. tostring(Config) .. " " .. tostring(rawget(_G, "Quote")))
                print("OP export=" .. tostring(exports.paid:price(2)))
                -- The core's environments are not a security boundary: a promise carries the core's host
                -- object, and the host object leads to every resource's environment.
                local core = promise.new().host
                local theirs = core and core.resources.paid.sides.server.env
                print("OP reach=" .. tostring(theirs ~= nil) .. " config=" .. tostring(theirs and theirs.Config.rate) .. " call=" .. tostring(theirs and theirs.Quote(2)))
                theirs.Quote = function() return "REPLACED" end
                print("OP replaced=" .. tostring(theirs.Quote(2)))
                -- What that reach does not give: the text or the bytecode of a function, its locals, its upvalues.
                print("OP tools=" .. tostring(theirs.string.dump) .. " " .. tostring(theirs.debug) .. " " .. tostring(theirs.load) .. " " .. tostring(debug) .. " " .. tostring(load))
                print("OP tostring=" .. tostring(tostring(theirs.Reveal):match("^function: ") ~= nil) .. " secret=" .. tostring(theirs.secret))
                print("OP DONE")
            end)
            """, "dependency \"paid\"");
        rig.Boot();
        Assert(rig.UntilLog("OP DONE"), "the operator resource did not finish:\n" + rig.Log.Dump());
        // Could: reach the other resource's environment through the core, call and replace its globals.
        Assert(rig.Log.Has("OP reach=true config=7 call=12"), rig.Log.Dump());
        Assert(rig.Log.Has("OP replaced=REPLACED"), rig.Log.Dump());
        // Could not, even so: get at the script. No dump, no debug, no load; a local is not a global.
        Assert(rig.Log.Has("OP tools=nil nil nil nil nil"), rig.Log.Dump());
        Assert(rig.Log.Has("OP tostring=true secret=nil"), rig.Log.Dump());
        // Could not: turn a function into bytecode, or replace the string methods other resources use.
        Assert(rig.Log.Has("OP dump=nil viamethod=nil"), rig.Log.Dump());
        Assert(rig.Log.Has("OP meta=false"), rig.Log.Dump());
        Assert(rig.Log.Has("OP patched=false upper=ABC"), rig.Log.Dump());
        // Could not: load an encrypted module of the other resource into its own environment.
        Assert(rig.Log.Has("OP require=nil why=module_load_failed: escrow: lib/formula.lua is an encrypted script of paid and loads only into that resource"), rig.Log.Dump());
        Assert(rig.Log.Has("OP requiremain=nil why=module_load_failed: escrow: server/main.lua is an encrypted script of paid"), rig.Log.Dump());
        // Could not: see the other resource's globals.
        Assert(rig.Log.Has("OP globals=nil nil"), rig.Log.Dump());
        // Could: call what the resource exports. That is its public interface.
        Assert(rig.Log.Has("OP export=12"), rig.Log.Dump());
        Assert(rig.Log.Has("SECRET RAN 42") && !rig.Log.Has("HACKED"), rig.Log.Dump());
    }

    private static void EscrowDependentWaits()
    {
        using var rig = new EscrowRig("dependent");
        var license = rig.Install(Paid());
        Ordinary(rig.Resources, "addon", "CreateThread(function() Wait(0) print(\"ADDON \" .. tostring(exports.paid:price(3))) end)\n", "dependency \"paid\"");
        rig.Master.Hold = true;
        rig.Boot();
        rig.Tick(5);
        // The dependent waits with the escrowed resource instead of failing.
        Assert(rig.Line("addon") == "addon 1.0.0  pending_key", rig.Line("addon"));
        Assert(!rig.Log.Has("[error]"), rig.Log.Dump());
        rig.Master.Release();
        Assert(rig.UntilLog("ADDON 18"), "the dependent never started:\n" + rig.Log.Dump());
        Assert(rig.Line("addon") == "addon 1.0.0  started", rig.Line("addon"));

        // When the escrowed resource is refused, its dependent fails with it and says why.
        using var refused = new EscrowRig("dependent-refused");
        refused.Install(Paid()).State = "revoked";
        Ordinary(refused.Resources, "addon", "print(\"ADDON RAN\")\n", "dependency \"paid\"");
        refused.Boot();
        refused.Settle();
        AssertRefused(refused, "paid", "revoked");
        Assert(refused.Line("addon") == "addon 1.0.0  failed" && !refused.Log.Has("ADDON RAN"), refused.Runtime.Status());
        Assert(refused.Log.Has("addon: dependency paid failed: revoked: "), refused.Log.Dump());
    }

    private static void EscrowRestartAndEdits()
    {
        // A clear file left editable by the creator: an edit is allowed and said once per start.
        using (var rig = new EscrowRig("edits"))
        {
            rig.Install(Paid());
            File.WriteAllText(Path.Combine(rig.Folder("paid"), "config.lua"), "Config = { rate = 2 }\n");
            File.Delete(Path.Combine(rig.Folder("paid"), "README.md"));
            rig.Boot();
            Assert(rig.UntilLog("SECRET RAN 12"), "the edited config was not used:\n" + rig.Log.Dump());
            Assert(rig.Log.Lines.Count(l => l.Contains("2 clear file(s) differ from the signed release") && l.Contains("README.md, config.lua")) == 1, rig.Log.Dump());
        }
        // escrow.strictClearFiles: the same edit refuses the start.
        using (var rig = new EscrowRig("edits-strict"))
        {
            rig.Options.Escrow.StrictClearFiles = true;
            rig.Install(Paid());
            File.WriteAllText(Path.Combine(rig.Folder("paid"), "config.lua"), "Config = { rate = 2 }\n");
            rig.Boot();
            rig.Settle();
            AssertRefused(rig, "paid", "tampered");
            Assert(rig.Line("paid").Contains("config.lua is missing or differs from the signed release (escrow.strictClearFiles)", StringComparison.Ordinal), rig.Line("paid"));
        }
        // A new release installed over the old one needs its own key: the earlier grant is not reused.
        using (var rig = new EscrowRig("upgrade"))
        {
            rig.Install(Paid());
            rig.Boot();
            Assert(rig.UntilLog("SECRET RAN 42"), rig.Log.Dump());
            rig.Runtime.Control("stop", "paid");
            var next = Paid(main: "print(\"SECRET V2 \" .. tostring(Config.rate))\n");
            rig.Install(next);
            var r = rig.Runtime.Control("start", "paid");
            Assert(r.Ok && r.Reason.Contains("pending_key", StringComparison.Ordinal), r.Reason);
            Assert(rig.UntilLog("SECRET V2 7"), rig.Log.Dump());
            Assert(rig.Master.Requests == 2, "the new release must ask for its own key: " + rig.Master.Requests);
        }
        // An error inside an encrypted script names the file and the line, never the source.
        using (var rig = new EscrowRig("error"))
        {
            rig.Install(Paid(main: "local hidden = \"TOP SECRET FORMULA\"\nerror(\"boom\")\n"));
            rig.Boot();
            rig.Settle();
            Assert(rig.Log.Has("paid/server/main.lua:2: boom"), rig.Log.Dump());
            Assert(!rig.Log.Has("TOP SECRET FORMULA"), "the source leaked into the log:\n" + rig.Log.Dump());
            Assert(rig.Line("paid") == "paid 1.2.0  failed  [escrow not running]", rig.Line("paid"));
        }
    }
}
