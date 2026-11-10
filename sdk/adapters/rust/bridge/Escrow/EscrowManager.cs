// Code escrow for the Rust bridge: an encrypted release stays encrypted on disk, the master releases
// its content key only to a licensed server bound to this server's X25519 identity, and the native
// library (libscriptgo) unwraps the key, decrypts in its own guarded memory and compiles each script
// straight into the Lua VM. No key and no plaintext script ever becomes a managed string or byte[].
//
// HONEST CEILING (docs/plan/CREATOR-PROTECTION.md, section 1). This is deterrence, licence binding,
// revocation and traceability. The operator of the machine can ultimately recover what their own
// process runs: a debugger, a memory dump or a replaced lua54 library sees the script the moment it
// is compiled. Nothing here claims otherwise.
//
// One resource goes through these states (docs: sdk/adapters/rust/README.md, "Escrow"):
//
//   start asked -> folder checked -> key asked -> PENDING KEY -> answer on a later tick:
//                        |                                          granted: bundle opened -> READY, it runs
//                        |                                          refused: not_licensed, unbound, revoked, expired
//                        |                                          no answer: unreachable (or the earlier grant's grace)
//                        +- refused at once: escrow_disabled, invalid_manifest, native_missing, signature,
//                           tampered, token_missing
//
//   while it runs: renewed before expiresAt. A refusal or a silent master leaves it running until
//   the offlineGraceUntil of the last valid answer; then it is stopped and the log says why.
//
// Oxide/Carbon web requests are asynchronous, so the key never arrives inside the call that asked
// for it. Begin() therefore answers "pending" and the answer comes back through Pump(), on the
// server's main thread, as an event the Lua glue (lua/runtime.lua) turns into a start or a failure.
// Every member is called from that one thread.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using KeraLua;
using LuaState = KeraLua.Lua;

namespace ScriptGo.Bridge.Escrow
{
    /// <summary>The stable refusal codes shown by `scriptgo status` and in the log.</summary>
    public static class EscrowReason
    {
        public const string Disabled = "escrow_disabled";
        public const string NativeMissing = "native_missing";
        public const string InvalidManifest = "invalid_manifest";
        public const string Signature = "signature";
        public const string Tampered = "tampered";
        public const string TokenMissing = "token_missing";
        public const string NotLicensed = "not_licensed";
        public const string Unbound = "unbound";
        public const string Revoked = "revoked";
        public const string Expired = "expired";
        public const string Unreachable = "unreachable";
    }

    internal struct BeginResult
    {
        /// <summary>"ready", "pending" or "refused".</summary>
        public string Verdict;
        public string Code;
        public string Detail;
    }

    internal sealed class EscrowEvent
    {
        public string Resource;
        /// <summary>"ready" (the key arrived: start it), "refused" (the start failed) or "stop" (the grace ended).</summary>
        public string Kind;
        public string Code;
        public string Detail;
    }

    internal sealed class EscrowManager : IDisposable
    {
        internal delegate void SendHttp(HttpRequestData request, Action<HttpResponseData, string> done);

        private sealed class Refusal : Exception
        {
            public readonly string Code;
            public Refusal(string code, string detail) : base(detail) { Code = code; }
        }

        // What the master granted. The wrapped key is useless without the identity's private key, which
        // never leaves the native library, so keeping it here lets a restart skip the network.
        private sealed class Grant
        {
            public string PayloadSha256Hex;
            public byte[] Epk, Nonce, Wrapped;
            public string Watermark;
            public long GrantedAt, ExpiresAt, GraceUntil;
        }

        // A folder that passed every check, as it was read.
        private sealed class Checked
        {
            public EscrowManifest Manifest;
            public byte[] Payload;
            public string Token;
            public List<string> Edited;
        }

        private sealed class Entry
        {
            public string Name, Root;
            public bool Pending;
            public Checked Asked;        // the folder a pending request was made for
            public int Sequence;         // answers to an older request are dropped
            public bool InFlight;
            public Grant Grant;
            public SgBundle Bundle;      // open: the resource may run
            public EscrowManifest Manifest;
            public string Token;
            public string FailingCode, FailingDetail;   // the last renewal failed; the grace is running
            public long NextAttempt;
            public string RefusedCode, RefusedDetail;   // why the last start or run ended
        }

        private readonly IHostServices _s;
        private readonly EscrowOptions _o;
        private readonly string _adapterVersion;
        private readonly List<string> _nativeDirs;
        private readonly SendHttp _send;
        private readonly Dictionary<string, Entry> _entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        private readonly List<EscrowEvent> _events = new List<EscrowEvent>();
        private readonly List<Action> _deferred = new List<Action>();
        private readonly List<byte[]> _trusted = new List<byte[]>();
        private readonly string _disabledWhy;
        private readonly string _keyUrl;

        private bool _nativeTried;
        private string _nativeFailure;
        private bool _identityFailed;
        private SgIdentity _identity;
        private string _publicKey;
        private IntPtr _loadBufferX;
        private string _loadBufferXError;
        private string _luaModule;

        public EscrowManager(IHostServices services, EscrowOptions options, string adapterVersion, IEnumerable<string> nativeDirs, SendHttp send)
        {
            _s = services;
            _o = options ?? new EscrowOptions();
            _adapterVersion = adapterVersion ?? "";
            _nativeDirs = nativeDirs == null ? new List<string>() : new List<string>(nativeDirs);
            _send = send;
            if (!_o.Enabled)
            {
                _disabledWhy = "this folder is escrowed (it holds escrow.json) and escrow.enabled is false";
                return;
            }
            _disabledWhy = CheckConfig(out _keyUrl);
            if (_disabledWhy != null)
            {
                _s.Log.Write(LogLevel.Error, "escrow", "escrow.enabled is true but escrow stays off: " + _disabledWhy);
                return;
            }
            foreach (var signer in _o.TrustedSigners ?? new List<string>())
            {
                byte[] key;
                if (Base64Url.TryDecode((signer ?? "").Trim(), EscrowNative.PublicKeyBytes, out key)) _trusted.Add(key);
                else _s.Log.Write(LogLevel.Warn, "escrow", "escrow.trustedSigners: ignored an entry that is not a 32-byte base64url key");
            }
        }

        /// <summary>Escrow is on and its configuration is usable.</summary>
        public bool Enabled => _disabledWhy == null;

        /// <summary>One line for the boot log.</summary>
        public string Summary
        {
            get
            {
                if (!_o.Enabled) return "off";
                if (_disabledWhy != null) return "off (" + _disabledWhy + ")";
                return "on, key service " + _keyUrl + ", environment " + _o.Environment
                    + (_trusted.Count > 0 ? ", " + _trusted.Count + " trusted signer(s)" : ", signer named by the key service");
            }
        }

        private string CheckConfig(out string keyUrl)
        {
            keyUrl = null;
            Uri master;
            if (string.IsNullOrEmpty(_o.Master) || !Uri.TryCreate(_o.Master, UriKind.Absolute, out master))
                return "escrow.master must be the https URL of the key service";
            // The deployment token travels in the request: plain http is for a loopback test service only.
            if (master.Scheme != "https" && !(master.Scheme == "http" && master.IsLoopback))
                return "escrow.master must be https (http is accepted for a loopback address only)";
            if (string.IsNullOrEmpty(_o.Environment)) return "escrow.environment must not be empty";
            if (string.IsNullOrEmpty(_o.IdentityFile)) return "escrow.identityFile is not set";
            if (string.IsNullOrEmpty(_o.TokensDirectory)) return "escrow.tokensDirectory is not set";
            keyUrl = _o.Master.TrimEnd('/') + "/v1/licenses/key";
            return null;
        }

        /// <summary>The address of luaL_loadbufferx in the VM's own Lua library (resolved at boot), or why it is missing.</summary>
        public void AttachLua(IntPtr loadBufferX, string module, string error)
        {
            _loadBufferX = loadBufferX;
            _luaModule = module;
            _loadBufferXError = error;
        }

        private long Now()
        {
            return _s.Clock.UnixSeconds() ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        }

        private static string Iso(long unixSeconds)
        {
            try { return DateTimeOffset.FromUnixTimeSeconds(unixSeconds).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture); }
            catch (ArgumentOutOfRangeException) { return unixSeconds.ToString(CultureInfo.InvariantCulture); }
        }

        // Native library ------------------------------------------------------------------------------------
        // Loaded on the first escrowed start, never before: a server with no escrowed resource loads nothing.
        private void EnsureNative()
        {
            if (!_nativeTried)
            {
                _nativeTried = true;
                _nativeFailure = LoadNative();
                if (_nativeFailure == null)
                    _s.Log.Write(LogLevel.Info, "escrow", "native library " + EscrowNative.Version() + " loaded, compiling through luaL_loadbufferx of "
                        + (_luaModule ?? "the VM's Lua library") + "; this server's public key is " + _publicKey);
            }
            if (_nativeFailure != null) throw new Refusal(_identityFailed ? EscrowReason.Unbound : EscrowReason.NativeMissing, _nativeFailure);
        }

        private string LoadNative()
        {
            try
            {
                if (!string.IsNullOrEmpty(_o.NativeLibrary) || _nativeDirs.Count > 0)
                {
                    string why;
                    if (NativeLua.PreloadEscrow(_nativeDirs, _o.NativeLibrary, out why) == null) return why;
                }
                uint abi = EscrowNative.sg_abi_version();
                if (abi != EscrowNative.AbiVersion)
                    return NativeLua.EscrowFileName + " has ABI version " + abi + ", this bridge needs " + EscrowNative.AbiVersion;
                int rc = EscrowNative.sg_init();
                if (rc == EscrowNative.ErrNoAes) return "this CPU has no hardware AES (AES-NI and PCLMUL are needed): " + EscrowNative.Error(rc);
                if (rc != EscrowNative.Ok) return "the native library did not initialise: " + EscrowNative.Error(rc);
                if (_loadBufferX == IntPtr.Zero) return _loadBufferXError ?? "luaL_loadbufferx was not located in the VM's Lua library";

                var directory = Path.GetDirectoryName(Path.GetFullPath(_o.IdentityFile));
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                bool created;
                rc = EscrowNative.LoadOrCreateIdentity(_o.IdentityFile, out _identity, out created);
                // The library is fine but this server cannot prove who it is: a licence cannot be bound to it.
                _identityFailed = rc != EscrowNative.Ok;
                if (rc != EscrowNative.Ok)
                    return "identity file " + _o.IdentityFile + " cannot be used (" + EscrowNative.Error(rc)
                        + "): it is damaged, or it belongs to another account or machine. This server has no identity a licence could be bound to";
                _publicKey = Base64Url.Encode(EscrowNative.PublicKey(_identity));
                if (created) _s.Log.Write(LogLevel.Info, "escrow", "created this server's identity in " + _o.IdentityFile + " (back it up: licences are bound to it)");
                return null;
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
            {
                _identityFailed = true;
                return "identity file " + _o.IdentityFile + " cannot be created: " + e.Message;
            }
            catch (DllNotFoundException e)
            {
                return NativeLua.EscrowFileName + " is not installed: " + e.Message;
            }
            catch (EntryPointNotFoundException e)
            {
                return NativeLua.EscrowFileName + " is not the library this bridge expects: " + e.Message;
            }
            catch (BadImageFormatException e)
            {
                return NativeLua.EscrowFileName + " is not a 64-bit library for this platform: " + e.Message;
            }
        }

        // Start -----------------------------------------------------------------------------------------------
        /// <summary>
        /// Asks to start an escrowed resource. <paramref name="scripts"/> are the scripts the core is
        /// about to run for it (globs expanded). "ready": the release is open in native memory, start
        /// now. "pending": the key was asked for; an event follows. "refused": code and detail say why.
        /// </summary>
        public BeginResult Begin(string name, string root, IList<string> scripts)
        {
            Entry e;
            if (!_entries.TryGetValue(name, out e)) _entries[name] = e = new Entry { Name = name };
            e.Root = root;
            if (_disabledWhy != null) return Refuse(e, EscrowReason.Disabled, _disabledWhy);
            if (e.Pending) return new BeginResult { Verdict = "pending" };

            Checked folder;
            try
            {
                folder = Check(e, scripts);
                long now = Now();
                bool sameRelease = e.Grant != null && e.Grant.PayloadSha256Hex == folder.Manifest.PayloadSha256Hex;
                if (e.Bundle != null && !sameRelease) Close(e);
                if (e.Bundle == null && sameRelease && e.FailingCode == null && now < e.Grant.ExpiresAt)
                {
                    // An answer from earlier in this server run is still valid: no need to ask again.
                    Open(e, folder, e.Grant);
                    Schedule(e, now);
                }
                if (e.Bundle != null)
                {
                    e.Manifest = folder.Manifest;
                    e.Token = folder.Token;
                    e.RefusedCode = e.RefusedDetail = null;
                    if (folder.Edited.Count > 0)
                        _s.Log.Write(LogLevel.Warn, "escrow", name + ": " + folder.Edited.Count
                            + " clear file(s) differ from the signed release (allowed; escrow.strictClearFiles refuses them): " + string.Join(", ", folder.Edited));
                    return new BeginResult { Verdict = "ready" };
                }
            }
            catch (Refusal r)
            {
                Close(e);
                return Refuse(e, r.Code, r.Message);
            }
            catch (Exception x) when (x is IOException || x is UnauthorizedAccessException)
            {
                // A folder that cannot be read cannot be shown to match the signed release.
                Close(e);
                return Refuse(e, EscrowReason.Tampered, "the resource folder cannot be read: " + x.Message);
            }
            catch (InvalidOperationException x)
            {
                Close(e);
                return Refuse(e, EscrowReason.NativeMissing, "the native library failed: " + x.Message);
            }

            e.Pending = true;
            e.Asked = folder;
            e.RefusedCode = e.RefusedDetail = null;
            Ask(e, folder.Manifest, folder.Token, false);
            return new BeginResult { Verdict = "pending" };
        }

        private static BeginResult Refuse(Entry e, string code, string detail)
        {
            e.RefusedCode = code;
            e.RefusedDetail = detail;
            return new BeginResult { Verdict = "refused", Code = code, Detail = detail };
        }

        // Everything that can be checked without the key, in the order an operator would want to hear it.
        private Checked Check(Entry e, IList<string> scripts)
        {
            var files = _s.Files;
            var raw = files.Read(e.Root, EscrowManifest.FileName);
            if (raw == null) throw new Refusal(EscrowReason.InvalidManifest, "escrow.json cannot be read");
            EscrowManifest m;
            try { m = EscrowManifest.Parse(raw); }
            catch (JsonError x) { throw new Refusal(EscrowReason.InvalidManifest, x.Message); }

            EnsureNative();

            // Signature: who signed it, then that it is intact. A signature that verifies under the key
            // the bundle itself names proves integrity only; provenance comes from the pinned list here
            // or, when it is empty, from the signer the key service names with the key (OnAnswer).
            if (_trusted.Count > 0)
            {
                bool trusted = false;
                foreach (var key in _trusted) trusted |= EscrowManifest.SameBytes(key, m.SignerPublicKey);
                if (!trusted) throw new Refusal(EscrowReason.Signature, "the release is signed by " + m.SignerPublicKeyText + ", which is not in escrow.trustedSigners");
            }
            if (!EscrowNative.VerifyManifest(m.Canonical, m.Signature, m.SignerPublicKey))
                throw new Refusal(EscrowReason.Signature, "the signature of escrow.json does not verify");

            var payload = files.Read(e.Root, EscrowManifest.PayloadFileName);
            if (payload == null) throw new Refusal(EscrowReason.Tampered, "payload.enc is missing");
            if (payload.LongLength != m.PayloadBytes)
                throw new Refusal(EscrowReason.Tampered, "payload.enc is " + payload.LongLength + " bytes, the signed release says " + m.PayloadBytes);
            if (!EscrowManifest.SameBytes(EscrowNative.Sha256(payload), m.PayloadSha256))
                throw new Refusal(EscrowReason.Tampered, "payload.enc does not match the signed release");

            // The resource manifest decides what runs, so it is always the signed one, byte for byte. The
            // core takes the first of these names it finds: an extra one would replace the signed one.
            bool hasManifest = false;
            foreach (var candidate in EscrowManifest.ResourceManifests)
            {
                var bytes = files.Read(e.Root, candidate);
                ClearFile signed;
                if (!m.Clear.TryGetValue(candidate, out signed))
                {
                    if (bytes != null) throw new Refusal(EscrowReason.Tampered, candidate + " is not part of the signed release");
                    continue;
                }
                if (bytes == null || !EscrowManifest.SameBytes(EscrowNative.Sha256(bytes), signed.Sha256))
                    throw new Refusal(EscrowReason.Tampered, candidate + " is missing or differs from the signed release");
                hasManifest = true;
            }
            if (!hasManifest) throw new Refusal(EscrowReason.InvalidManifest, "the release has no clear resource manifest (scriptgo.lua)");

            // Other clear files are left clear so that an operator can edit them (a config, a locale).
            var edited = new List<string>();
            foreach (var path in m.ClearOrder)
            {
                if (Array.IndexOf(EscrowManifest.ResourceManifests, path) >= 0) continue;
                var bytes = files.Read(e.Root, path);
                if (bytes != null && EscrowManifest.SameBytes(EscrowNative.Sha256(bytes), m.Clear[path].Sha256)) continue;
                if (_o.StrictClearFiles)
                    throw new Refusal(EscrowReason.Tampered, path + " is missing or differs from the signed release (escrow.strictClearFiles)");
                edited.Add(path);
            }

            // What sits at the path of an encrypted file is its stub, or nothing.
            foreach (var path in m.EncryptedOrder)
            {
                var bytes = files.Read(e.Root, path);
                if (bytes != null && !m.IsStub(path, bytes))
                    throw new Refusal(EscrowReason.Tampered, path + " is an encrypted file of the release, and what is on disk is not its stub");
            }

            // Every script the core is about to run belongs to the release: nothing can be added to an
            // escrowed resource, not even through a glob of its manifest.
            foreach (var script in scripts)
            {
                if (m.Encrypted.Contains(script))
                {
                    if (files.Read(e.Root, script) == null) throw new Refusal(EscrowReason.Tampered, "the stub of " + script + " is missing");
                    continue;
                }
                if (!m.Clear.ContainsKey(script)) throw new Refusal(EscrowReason.Tampered, script + " would run but is not part of the signed release");
                if (files.Read(e.Root, script) == null) throw new Refusal(EscrowReason.Tampered, script + " is missing");
            }

            return new Checked { Manifest = m, Payload = payload, Token = ReadToken(e.Name), Edited = edited };
        }

        // <tokensDirectory>/<resource>.token: one line, the deployment token of this resource on this server.
        private string ReadToken(string resource)
        {
            foreach (var ch in resource)
            {
                bool ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' || ch == '.';
                if (!ok) throw new Refusal(EscrowReason.TokenMissing, "the resource name cannot name a token file");
            }
            var path = Path.Combine(_o.TokensDirectory, resource + ".token");
            string token = null;
            try
            {
                if (File.Exists(path))
                {
                    foreach (var line in File.ReadAllLines(path))
                    {
                        var t = line.Trim().TrimStart((char)0xFEFF).Trim();
                        if (t.Length > 0) { token = t; break; }
                    }
                }
            }
            catch (IOException x) { throw new Refusal(EscrowReason.TokenMissing, path + " cannot be read: " + x.Message); }
            catch (UnauthorizedAccessException x) { throw new Refusal(EscrowReason.TokenMissing, path + " cannot be read: " + x.Message); }
            if (token == null) throw new Refusal(EscrowReason.TokenMissing, "no deployment token in " + path);
            if (token.Length > 512 || token.IndexOf(' ') >= 0) throw new Refusal(EscrowReason.TokenMissing, path + " does not hold one token on one line");
            return token;
        }

        // Unwraps the key and decrypts the payload, inside the native library.
        private void Open(Entry e, Checked folder, Grant grant)
        {
            var m = folder.Manifest;
            SgBundle bundle;
            int rc = EscrowNative.OpenBundle(_identity, folder.Payload, m.PayloadNonce, Encoding.UTF8.GetBytes(m.Aad),
                grant.Epk, grant.Nonce, grant.Wrapped, m.PayloadSha256, out bundle);
            switch (rc)
            {
                case EscrowNative.Ok:
                    break;
                case EscrowNative.ErrUnwrap:
                    throw new Refusal(EscrowReason.Unbound, "the key was not released to this server's identity, or it is the key of another release");
                case EscrowNative.ErrPayloadHash:
                case EscrowNative.ErrDecrypt:
                case EscrowNative.ErrBadArchive:
                case EscrowNative.ErrUnsafePath:
                case EscrowNative.ErrTooLarge:
                case EscrowNative.ErrUnsupported:
                    throw new Refusal(EscrowReason.Tampered, "the payload cannot be opened: " + EscrowNative.Error(rc));
                case EscrowNative.ErrNoAes:
                case EscrowNative.ErrInit:
                    throw new Refusal(EscrowReason.NativeMissing, EscrowNative.Error(rc));
                default:
                    throw new Refusal(EscrowReason.NativeMissing, "the native library failed: " + EscrowNative.Error(rc));
            }
            foreach (var path in m.EncryptedOrder)
            {
                if (EscrowNative.HasEntry(bundle, path)) continue;
                bundle.Dispose();
                throw new Refusal(EscrowReason.Tampered, "the payload has no " + path + ", which escrow.json lists");
            }
            // The per-delivery marker names the licence and deployment this key went to. It sits next to
            // the plaintext in native memory: traceability if that memory is dumped, not prevention.
            if (!string.IsNullOrEmpty(grant.Watermark)) EscrowNative.SetMarker(bundle, Encoding.UTF8.GetBytes(grant.Watermark));
            e.Bundle = bundle;
            e.Manifest = m;
            e.Token = folder.Token;
        }

        private static void Close(Entry e)
        {
            if (e.Bundle == null) return;
            e.Bundle.Dispose();
            e.Bundle = null;
        }

        /// <summary>The resource stopped, or its start failed or was cancelled: wipe the plaintext, drop a pending request.</summary>
        public void Release(string name)
        {
            Entry e;
            if (!_entries.TryGetValue(name, out e)) return;
            e.Sequence++;
            e.InFlight = false;
            e.Pending = false;
            e.Asked = null;
            Close(e);
        }

        // Key service ---------------------------------------------------------------------------------------
        private void Ask(Entry e, EscrowManifest m, string token, bool renewal)
        {
            int sequence = ++e.Sequence;
            e.InFlight = true;
            var body = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                ["deploymentToken"] = token,
                ["package"] = m.Package,
                ["version"] = m.Version,
                ["environment"] = _o.Environment,
                ["adapterVersion"] = _adapterVersion,
                ["serverPublicKey"] = _publicKey,
            };
            var headers = new Dictionary<string, string> { ["content-type"] = "application/json", ["accept"] = "application/json" };
            var request = new HttpRequestData("POST", _keyUrl, headers, Json.Canonical(body, false));
            Action<HttpResponseData, string> done = (response, error) => OnAnswer(e, sequence, renewal, response, error);
            if (_send == null)
            {
                // No HTTP service in this host: answered on the next tick, like any other failure to reach the master.
                _deferred.Add(() => done(null, "this host has no HTTP service"));
                return;
            }
            try { _send(request, done); }
            catch (Exception x) { _deferred.Add(() => done(null, "request_failed: " + x.Message)); }
        }

        private enum AnswerKind { Granted, Refused, Unreachable }

        private sealed class Answer
        {
            public AnswerKind Kind;
            public string Code, Detail, Signer;
            public Grant Grant;
        }

        // HTTP 200 with valid:false is a definitive refusal. Anything else (no answer, another status, a
        // body that cannot be read) means the master could not answer: the offline grace applies.
        private Answer Read(HttpResponseData response, string error, long now)
        {
            if (response == null || response.Status == 0)
                return new Answer { Kind = AnswerKind.Unreachable, Code = EscrowReason.Unreachable, Detail = "the key service did not answer (" + (error ?? "request_failed") + ")" };
            if (response.Status != 200)
                return new Answer { Kind = AnswerKind.Unreachable, Code = EscrowReason.Unreachable, Detail = "the key service answered HTTP " + response.Status };
            try
            {
                if (response.Body.Length > 1024 * 1024) throw new JsonError("the answer is larger than 1 MiB");
                var root = Json.Object(Json.Parse(response.Body), "the answer");
                object valid;
                if (!root.TryGetValue("valid", out valid) || !(valid is bool)) throw new JsonError("\"valid\" must be a boolean");
                if (!(bool)valid)
                {
                    var reason = Json.OptionalString(root, "reason") ?? "refused";
                    return new Answer { Kind = AnswerKind.Refused, Code = RefusalCode(reason), Detail = "the key service refused: " + reason };
                }
                var wrapped = Json.Object(root.ContainsKey("wrappedKey") ? root["wrappedKey"] : null, "\"wrappedKey\"");
                var grant = new Grant { GrantedAt = now, Watermark = Json.OptionalString(root, "deliveryWatermark") };
                if (!Base64Url.TryDecode(Json.String(wrapped, "epk"), EscrowNative.PublicKeyBytes, out grant.Epk)
                    || !Base64Url.TryDecode(Json.String(wrapped, "nonce"), EscrowNative.NonceBytes, out grant.Nonce)
                    || !Base64Url.TryDecode(Json.String(wrapped, "wrapped"), EscrowNative.WrappedKeyBytes, out grant.Wrapped))
                    throw new JsonError("\"wrappedKey\" does not hold a 32-byte epk, a 12-byte nonce and a 48-byte wrapped key");
                if (!Time(Json.OptionalString(root, "expiresAt"), out grant.ExpiresAt)) throw new JsonError("\"expiresAt\" is not a date");
                // No grace given: the answer is good until it expires, and no longer.
                if (!Time(Json.OptionalString(root, "offlineGraceUntil"), out grant.GraceUntil)) grant.GraceUntil = grant.ExpiresAt;
                if (grant.GraceUntil < grant.ExpiresAt) grant.GraceUntil = grant.ExpiresAt;
                return new Answer { Kind = AnswerKind.Granted, Grant = grant, Signer = Json.OptionalString(root, "signerPublicKey") };
            }
            catch (JsonError x)
            {
                return new Answer { Kind = AnswerKind.Unreachable, Code = EscrowReason.Unreachable, Detail = "the key service's answer cannot be read (" + x.Message + ")" };
            }
        }

        private static bool Time(string text, out long unixSeconds)
        {
            unixSeconds = 0;
            DateTimeOffset when;
            if (string.IsNullOrEmpty(text)
                || !DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out when))
                return false;
            unixSeconds = when.ToUnixTimeSeconds();
            return true;
        }

        // The master's reasons (packages/licensing) folded into this adapter's stable codes.
        private static string RefusalCode(string reason)
        {
            switch (reason)
            {
                case "unbound": return EscrowReason.Unbound;
                case "revoked":
                case "refunded":
                case "deactivated": return EscrowReason.Revoked;
                case "expired": return EscrowReason.Expired;
                default: return EscrowReason.NotLicensed;   // unknown_key, environment_not_covered, deployment_limit, not_escrowed
            }
        }

        private void OnAnswer(Entry e, int sequence, bool renewal, HttpResponseData response, string error)
        {
            if (sequence != e.Sequence) return;   // released, or superseded by a newer request
            e.InFlight = false;
            long now = Now();
            var answer = Read(response, error, now);
            if (renewal) OnRenewal(e, answer, now);
            else OnFirstAnswer(e, answer, now);
        }

        private void OnFirstAnswer(Entry e, Answer answer, long now)
        {
            var folder = e.Asked;
            e.Asked = null;
            if (!e.Pending || folder == null) return;
            e.Pending = false;
            try
            {
                if (answer.Kind == AnswerKind.Refused) throw new Refusal(answer.Code, answer.Detail);
                if (answer.Kind == AnswerKind.Unreachable)
                {
                    // An earlier answer for this same release may still be inside its offline grace.
                    bool grace = e.Grant != null && e.Grant.PayloadSha256Hex == folder.Manifest.PayloadSha256Hex && now < e.Grant.GraceUntil;
                    if (!grace) throw new Refusal(EscrowReason.Unreachable, answer.Detail + "; there is no earlier answer still inside its offline grace");
                    Open(e, folder, e.Grant);
                    Fail(e, EscrowReason.Unreachable, answer.Detail, now);
                }
                else
                {
                    if (_trusted.Count == 0)
                    {
                        // Nobody is pinned in the config: the signer must be the one the key service names for this licence.
                        byte[] named;
                        if (!Base64Url.TryDecode(answer.Signer, EscrowNative.PublicKeyBytes, out named) || !EscrowManifest.SameBytes(named, folder.Manifest.SignerPublicKey))
                            throw new Refusal(EscrowReason.Signature, "the release is signed by " + folder.Manifest.SignerPublicKeyText
                                + ", which is not the signer the key service names for this licence");
                    }
                    answer.Grant.PayloadSha256Hex = folder.Manifest.PayloadSha256Hex;
                    Open(e, folder, answer.Grant);
                    e.Grant = answer.Grant;
                    e.FailingCode = e.FailingDetail = null;
                    Schedule(e, now);
                }
                _events.Add(new EscrowEvent { Resource = e.Name, Kind = "ready" });
            }
            catch (Exception x)
            {
                // Whatever went wrong, the waiting start must hear about it: it would wait for ever otherwise.
                var refusal = x as Refusal;
                var code = refusal != null ? refusal.Code : EscrowReason.NativeMissing;
                var detail = refusal != null ? refusal.Message : "the native library failed: " + x.GetType().Name + ": " + x.Message;
                Close(e);
                e.RefusedCode = code;
                e.RefusedDetail = detail;
                _events.Add(new EscrowEvent { Resource = e.Name, Kind = "refused", Code = code, Detail = detail });
            }
        }

        private void OnRenewal(Entry e, Answer answer, long now)
        {
            if (e.Bundle == null || e.Grant == null) return;
            if (answer.Kind == AnswerKind.Granted)
            {
                if (e.FailingCode != null) _s.Log.Write(LogLevel.Info, "escrow", e.Name + ": the key service answers again, the licence is renewed");
                answer.Grant.PayloadSha256Hex = e.Grant.PayloadSha256Hex;
                e.Grant = answer.Grant;
                e.FailingCode = e.FailingDetail = null;
                Schedule(e, now);
                return;
            }
            Fail(e, answer.Code, answer.Detail, now);
        }

        // A renewal failed. The resource keeps running until the grace of its last valid answer ends.
        private void Fail(Entry e, string code, string detail, long now)
        {
            if (e.FailingCode != code)
                _s.Log.Write(LogLevel.Warn, "escrow", e.Name + ": " + code + ": " + detail + ". It keeps running until "
                    + Iso(e.Grant.GraceUntil) + " (the offline grace of its last valid answer), then it is stopped");
            e.FailingCode = code;
            e.FailingDetail = detail;
            e.NextAttempt = now + Math.Max(5, _o.RenewRetrySeconds);
        }

        // Renew before the answer expires: a fifth of its lifetime ahead, at least 5 s, at most 2 minutes.
        private void Schedule(Entry e, long now)
        {
            long lifetime = Math.Max(0, e.Grant.ExpiresAt - e.Grant.GrantedAt);
            long lead = Math.Min(120, Math.Max(5, lifetime / 5));
            e.NextAttempt = Math.Max(now + 5, e.Grant.ExpiresAt - lead);
        }

        /// <summary>Called once per tick: renewals, the end of a grace, and the events of answers that arrived.</summary>
        public void Pump(List<EscrowEvent> events)
        {
            if (_deferred.Count > 0)
            {
                var run = _deferred.ToArray();
                _deferred.Clear();
                foreach (var action in run) action();
            }
            if (_entries.Count > 0 && _disabledWhy == null)
            {
                long now = Now();
                foreach (var e in _entries.Values)
                {
                    if (e.Bundle == null || e.Grant == null) continue;
                    if (e.FailingCode != null && now >= e.Grant.GraceUntil)
                    {
                        // Only a failed renewal ends a run: an answer that is still valid never does, whatever the clocks say.
                        var detail = e.FailingDetail + ", and the offline grace ended at " + Iso(e.Grant.GraceUntil);
                        e.Sequence++;
                        e.InFlight = false;
                        Close(e);
                        e.RefusedCode = e.FailingCode;
                        e.RefusedDetail = detail;
                        _events.Add(new EscrowEvent { Resource = e.Name, Kind = "stop", Code = e.FailingCode, Detail = detail });
                        continue;
                    }
                    if (!e.InFlight && now >= e.NextAttempt) Ask(e, e.Manifest, e.Token, true);
                }
            }
            if (_events.Count == 0) return;
            events.AddRange(_events);
            _events.Clear();
        }

        // Script loading ------------------------------------------------------------------------------------
        /// <summary>
        /// H.escrowLoad(resource, path, chunkName, env, own, source): decides how one chunk of an escrowed
        /// resource is compiled. Returns the compiled function (an encrypted script, from native memory),
        /// true (a clear file of the release: the caller compiles the source it read), or nil and a message.
        /// </summary>
        public int Load(LuaState l)
        {
            var name = Text(l, 1) ?? "";
            var path = Text(l, 2) ?? "";
            Entry e;
            if (!_entries.TryGetValue(name, out e) || e.Bundle == null || e.Manifest == null)
                return LoadFailed(l, "escrow: " + name + " has no open release");
            if (e.Manifest.Encrypted.Contains(path))
            {
                // An encrypted script only ever runs in the environment of the resource it belongs to.
                if (!l.ToBoolean(5) || l.Type(4) != LuaType.Table)
                    return LoadFailed(l, "escrow: " + path + " is an encrypted script of " + name + " and loads only into that resource");
                int luaStatus;
                int rc = EscrowNative.LuaLoad(e.Bundle, path, l.Handle, _loadBufferX, Text(l, 3) ?? ("@" + name + "/" + path), out luaStatus);
                if (rc == EscrowNative.Ok)
                {
                    // What load(chunk, name, "t", env) does: the chunk's first upvalue is its _ENV.
                    l.PushCopy(4);
                    if (l.SetUpValue(-2, 1) == null) l.Pop(1);
                    return 1;
                }
                if (rc == EscrowNative.ErrLuaLoad)
                {
                    var message = Text(l, -1) ?? "syntax error";
                    l.Pop(1);
                    return LoadFailed(l, message);
                }
                return LoadFailed(l, "escrow: " + path + ": " + EscrowNative.Error(rc));
            }
            ClearFile clear;
            if (!e.Manifest.Clear.TryGetValue(path, out clear))
                return LoadFailed(l, "escrow: " + path + " is not part of the signed release of " + name);
            if (_o.StrictClearFiles)
            {
                var source = l.Type(6) == LuaType.String ? l.ToBuffer(6, false) : null;
                if (source == null || !EscrowManifest.SameBytes(EscrowNative.Sha256(source), clear.Sha256))
                    return LoadFailed(l, "escrow: " + path + " differs from the signed release (escrow.strictClearFiles)");
            }
            l.PushBoolean(true);
            return 1;
        }

        /// <summary>The stub of an encrypted file of a release that is open, or null.</summary>
        public byte[] Stub(string root, string path)
        {
            foreach (var e in _entries.Values)
            {
                if (e.Bundle == null || e.Manifest == null || !string.Equals(e.Root, root, StringComparison.Ordinal)) continue;
                return e.Manifest.Encrypted.Contains(path) ? Encoding.UTF8.GetBytes(e.Manifest.StubLine(path) + "\n") : null;
            }
            return null;
        }

        private static int LoadFailed(LuaState l, string message)
        {
            l.PushNil();
            l.PushBuffer(Encoding.UTF8.GetBytes(message));
            return 2;
        }

        private static string Text(LuaState l, int index)
        {
            if (l.Type(index) != LuaType.String) return null;
            var bytes = l.ToBuffer(index, false);
            return bytes == null ? null : Encoding.UTF8.GetString(bytes);
        }

        // Status ----------------------------------------------------------------------------------------------
        /// <summary>One phrase for `scriptgo status`, or null for a resource escrow never saw.</summary>
        public string Status(string name)
        {
            Entry e;
            if (!_entries.TryGetValue(name, out e)) return null;
            if (e.Pending) return "pending_key: waiting for the key service";
            if (e.Bundle != null && e.Grant != null)
            {
                if (e.FailingCode != null) return e.FailingCode + ": " + e.FailingDetail + "; keeps running until " + Iso(e.Grant.GraceUntil);
                return "licensed, answer valid until " + Iso(e.Grant.ExpiresAt) + ", offline grace until " + Iso(e.Grant.GraceUntil);
            }
            if (e.RefusedCode != null) return e.RefusedCode + ": " + e.RefusedDetail;
            return "not running";
        }

        public void Dispose()
        {
            foreach (var e in _entries.Values)
            {
                e.Sequence++;
                Close(e);
            }
            _entries.Clear();
            if (_identity != null)
            {
                _identity.Dispose();
                _identity = null;
            }
        }
    }
}
