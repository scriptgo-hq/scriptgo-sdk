// P/Invoke surface of libscriptgo (sdk/native/include/scriptgo/escrow.h, SG_ABI_VERSION 1).
// Source-generated marshalling (LibraryImport): no runtime IL stubs, blittable signatures, and
// SafeHandles so a bundle cannot be freed while another thread is inside a call on it.
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace ScriptGo.Escrow.Native;

internal static partial class EscrowNative
{
    internal const string Library = "scriptgo";
    internal const uint ExpectedAbi = 1;

    internal const int Ok = 0;
    internal const int ErrNoAes = -3;
    internal const int ErrBadSignature = -5;
    internal const int ErrPayloadHash = -6;
    internal const int ErrUnwrap = -7;
    internal const int ErrDecrypt = -8;
    internal const int ErrBadArchive = -9;
    internal const int ErrUnsafePath = -10;
    internal const int ErrTooLarge = -11;
    internal const int ErrNotFound = -12;
    internal const int ErrBufferTooSmall = -13;
    internal const int ErrLuaLoad = -17;
    internal const int ErrUnsupported = -18;
    internal const int ErrExists = -20;

    // The resolver must be in place before the first call into the library: a static constructor
    // runs before any member of this class is used.
    static EscrowNative() => NativeLibrary.SetDllImportResolver(typeof(EscrowNative).Assembly, EscrowNativeLibrary.Resolve);

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial uint sg_abi_version();

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial IntPtr sg_version_string();

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial int sg_init();

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial IntPtr sg_strerror(int code);

    // ---------------------------------------------------------------- identity

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial int sg_identity_generate(out IntPtr identity);

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static unsafe partial int sg_identity_import(byte* privateKey, out IntPtr identity);

    [LibraryImport(Library, StringMarshalling = StringMarshalling.Utf8), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial int sg_identity_load_or_create(string path, out IntPtr identity, out int created);

    [LibraryImport(Library, StringMarshalling = StringMarshalling.Utf8), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial int sg_identity_save(EscrowIdentityHandle identity, string path, int replace);

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static unsafe partial int sg_identity_public_key(EscrowIdentityHandle identity, byte* publicKey);

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial void sg_identity_free(IntPtr identity);

    // ---------------------------------------------------------------- signature

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static unsafe partial int sg_verify_manifest(byte* canonicalJson, nuint length, byte* signature, byte* signerPublicKey);

    // ---------------------------------------------------------------- bundle

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static unsafe partial int sg_bundle_open(
        EscrowIdentityHandle identity,
        byte* payload, nuint payloadLength, byte* payloadNonce,
        byte* aad, nuint aadLength,
        byte* epk, byte* wrapNonce, byte* wrapped, nuint wrappedLength,
        byte* expectedPayloadSha256,
        out IntPtr bundle);

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial int sg_bundle_entry_count(EscrowBundleHandle bundle, out nuint count);

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial int sg_bundle_entry_at(EscrowBundleHandle bundle, nuint index, out IntPtr path, out nuint size);

    [LibraryImport(Library, StringMarshalling = StringMarshalling.Utf8), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial int sg_bundle_entry_size(EscrowBundleHandle bundle, string path, out nuint size);

    [LibraryImport(Library, StringMarshalling = StringMarshalling.Utf8), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static unsafe partial int sg_bundle_copy(EscrowBundleHandle bundle, string path, byte* buffer, nuint capacity, out nuint length);

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static unsafe partial int sg_bundle_set_marker(EscrowBundleHandle bundle, byte* marker, nuint length);

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial int sg_bundle_memory_locked(EscrowBundleHandle bundle);

    [LibraryImport(Library, StringMarshalling = StringMarshalling.Utf8), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial int sg_bundle_lua_load(EscrowBundleHandle bundle, string path, IntPtr luaState, IntPtr loadBufferX, string chunkName, out int luaStatus);

    [LibraryImport(Library), UnmanagedCallConv(CallConvs = [typeof(CallConvCdecl)])]
    internal static partial void sg_bundle_free(IntPtr bundle);

    internal static string ErrorText(int code) => Marshal.PtrToStringUTF8(sg_strerror(code)) ?? $"error {code}";
}

/// <summary>Owns an sg_identity. The private key behind it never leaves native memory.</summary>
internal sealed class EscrowIdentityHandle : SafeHandle
{
    public EscrowIdentityHandle() : base(IntPtr.Zero, ownsHandle: true) { }
    public EscrowIdentityHandle(IntPtr handle) : base(IntPtr.Zero, ownsHandle: true) => SetHandle(handle);
    public override bool IsInvalid => handle == IntPtr.Zero;
    protected override bool ReleaseHandle()
    {
        EscrowNative.sg_identity_free(handle); // wipes the key, then frees it
        return true;
    }
}

/// <summary>Owns an sg_bundle. Releasing it wipes the decrypted files. A SafeHandle is reference
/// counted across P/Invoke calls, so a Dispose on one thread waits for calls in flight on others.</summary>
internal sealed class EscrowBundleHandle : SafeHandle
{
    public EscrowBundleHandle() : base(IntPtr.Zero, ownsHandle: true) { }
    public EscrowBundleHandle(IntPtr handle) : base(IntPtr.Zero, ownsHandle: true) => SetHandle(handle);
    public override bool IsInvalid => handle == IntPtr.Zero;
    protected override bool ReleaseHandle()
    {
        EscrowNative.sg_bundle_free(handle); // wipes the plaintext, then frees it
        return true;
    }
}
