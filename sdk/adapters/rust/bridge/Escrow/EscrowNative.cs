// P/Invoke declarations for libscriptgo (sdk/native/include/scriptgo/escrow.h), ABI version 1.
//
// DllImport, cdecl, no LibraryImport: the bridge is netstandard2.0 and runs on Unity's Mono. The
// library is loaded by full path first (NativeLua.PreloadEscrow), so "scriptgo" resolves to the
// module already in the process.
//
// Deliberately NOT declared: sg_bundle_read and sg_bundle_copy. They are the two doors through
// which plaintext leaves native memory, and this bridge has no use for either: a script is compiled
// by sg_bundle_lua_load straight from native memory into the lua_State. Not declaring them means no
// code in this assembly can pull an encrypted file into a managed string or byte[] by accident.
// The server's private key never leaves the library either (sg_identity_* returns only the public half).
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace ScriptGo.Bridge.Escrow
{
    internal sealed class SgIdentity : SafeHandle
    {
        public SgIdentity(IntPtr handle) : base(IntPtr.Zero, true) { SetHandle(handle); }
        public override bool IsInvalid => handle == IntPtr.Zero;
        protected override bool ReleaseHandle()
        {
            EscrowNative.sg_identity_free(handle);
            return true;
        }
    }

    /// <summary>A decrypted release in native memory. Disposing wipes and frees it.</summary>
    internal sealed class SgBundle : SafeHandle
    {
        public SgBundle(IntPtr handle) : base(IntPtr.Zero, true) { SetHandle(handle); }
        public override bool IsInvalid => handle == IntPtr.Zero;
        protected override bool ReleaseHandle()
        {
            EscrowNative.sg_bundle_free(handle);
            return true;
        }
    }

    internal static class EscrowNative
    {
        private const string Lib = "scriptgo";

        public const uint AbiVersion = 1;
        public const int PublicKeyBytes = 32, NonceBytes = 12, SignatureBytes = 64, Sha256Bytes = 32, WrappedKeyBytes = 48;

        public const int Ok = 0;
        public const int ErrInit = -2;
        public const int ErrNoAes = -3;
        public const int ErrBadSignature = -5;
        public const int ErrPayloadHash = -6;
        public const int ErrUnwrap = -7;
        public const int ErrDecrypt = -8;
        public const int ErrBadArchive = -9;
        public const int ErrUnsafePath = -10;
        public const int ErrTooLarge = -11;
        public const int ErrNotFound = -12;
        public const int ErrLuaLoad = -17;
        public const int ErrUnsupported = -18;

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        public static extern uint sg_abi_version();

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern IntPtr sg_version_string();

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        public static extern int sg_init();

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern IntPtr sg_strerror(int code);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern int sg_sha256(byte[] data, UIntPtr length, [Out] byte[] digest);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern int sg_identity_load_or_create(byte[] pathUtf8, out IntPtr identity, out int created);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern int sg_identity_public_key(SgIdentity identity, [Out] byte[] publicKey);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        internal static extern void sg_identity_free(IntPtr identity);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern int sg_verify_manifest(byte[] canonicalJson, UIntPtr length, byte[] signature, byte[] signerPublicKey);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern int sg_bundle_open(SgIdentity identity, byte[] payload, UIntPtr payloadLength, byte[] payloadNonce,
            byte[] aad, UIntPtr aadLength, byte[] epk, byte[] wrapNonce, byte[] wrapped, UIntPtr wrappedLength,
            byte[] expectedPayloadSha256, out IntPtr bundle);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern int sg_bundle_entry_size(SgBundle bundle, byte[] pathUtf8, out UIntPtr size);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern int sg_bundle_set_marker(SgBundle bundle, byte[] marker, UIntPtr length);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern int sg_bundle_memory_locked(SgBundle bundle);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern int sg_bundle_lua_load(SgBundle bundle, byte[] pathUtf8, IntPtr luaState, IntPtr loadBufferX,
            byte[] chunkNameUtf8, out int luaStatus);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        internal static extern void sg_bundle_free(IntPtr bundle);

        // Wrappers ------------------------------------------------------------------------------------------
        /// <summary>NUL-terminated UTF-8, the string form the library takes.</summary>
        public static byte[] Utf8Z(string text)
        {
            var bytes = Encoding.UTF8.GetBytes(text ?? "");
            var z = new byte[bytes.Length + 1];
            Buffer.BlockCopy(bytes, 0, z, 0, bytes.Length);
            return z;
        }

        private static string Text(IntPtr utf8)
        {
            return utf8 == IntPtr.Zero ? "" : Marshal.PtrToStringAnsi(utf8) ?? "";
        }

        public static string Version() => Text(sg_version_string());

        /// <summary>"SG_ERR code: description", for logs.</summary>
        public static string Error(int code) => Text(sg_strerror(code)) + " (code " + code + ")";

        public static byte[] Sha256(byte[] data)
        {
            var digest = new byte[Sha256Bytes];
            // An empty array may be marshalled as a null pointer; one spare byte keeps the pointer valid.
            var input = data.Length == 0 ? new byte[1] : data;
            int rc = sg_sha256(input, (UIntPtr)(ulong)data.Length, digest);
            if (rc != Ok) throw new InvalidOperationException("sg_sha256: " + Error(rc));
            return digest;
        }

        public static int LoadOrCreateIdentity(string path, out SgIdentity identity, out bool created)
        {
            identity = null;
            IntPtr handle;
            int wasCreated;
            int rc = sg_identity_load_or_create(Utf8Z(path), out handle, out wasCreated);
            created = wasCreated != 0;
            if (rc == Ok) identity = new SgIdentity(handle);
            return rc;
        }

        public static byte[] PublicKey(SgIdentity identity)
        {
            var key = new byte[PublicKeyBytes];
            int rc = sg_identity_public_key(identity, key);
            if (rc != Ok) throw new InvalidOperationException("sg_identity_public_key: " + Error(rc));
            return key;
        }

        public static bool VerifyManifest(byte[] canonicalJson, byte[] signature, byte[] signerPublicKey)
        {
            if (signature == null || signature.Length != SignatureBytes || signerPublicKey == null || signerPublicKey.Length != PublicKeyBytes) return false;
            return sg_verify_manifest(canonicalJson, (UIntPtr)(ulong)canonicalJson.Length, signature, signerPublicKey) == Ok;
        }

        public static int OpenBundle(SgIdentity identity, byte[] payload, byte[] payloadNonce, byte[] aad, byte[] epk, byte[] wrapNonce,
            byte[] wrapped, byte[] payloadSha256, out SgBundle bundle)
        {
            bundle = null;
            IntPtr handle;
            var aadInput = aad.Length == 0 ? new byte[1] : aad;
            int rc = sg_bundle_open(identity, payload, (UIntPtr)(ulong)payload.Length, payloadNonce, aadInput, (UIntPtr)(ulong)aad.Length,
                epk, wrapNonce, wrapped, (UIntPtr)(ulong)wrapped.Length, payloadSha256, out handle);
            if (rc == Ok) bundle = new SgBundle(handle);
            return rc;
        }

        public static bool HasEntry(SgBundle bundle, string path)
        {
            UIntPtr size;
            return sg_bundle_entry_size(bundle, Utf8Z(path), out size) == Ok;
        }

        public static int SetMarker(SgBundle bundle, byte[] marker)
        {
            var input = marker.Length == 0 ? new byte[1] : marker;
            return sg_bundle_set_marker(bundle, input, (UIntPtr)(ulong)marker.Length);
        }

        public static bool MemoryLocked(SgBundle bundle) => sg_bundle_memory_locked(bundle) == 1;

        /// <summary>
        /// Compiles one encrypted entry into <paramref name="luaState"/> from native memory. On Ok the
        /// function is on top of the Lua stack; on ErrLuaLoad the Lua message is; otherwise nothing was pushed.
        /// </summary>
        public static int LuaLoad(SgBundle bundle, string path, IntPtr luaState, IntPtr loadBufferX, string chunkName, out int luaStatus)
        {
            return sg_bundle_lua_load(bundle, Utf8Z(path), luaState, loadBufferX, Utf8Z(chunkName), out luaStatus);
        }
    }
}
