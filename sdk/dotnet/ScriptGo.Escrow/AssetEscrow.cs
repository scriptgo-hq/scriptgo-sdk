// Asset escrow (docs/spec/assets.md, "Asset escrow"): the content key of an asset container
// (scriptgo-asset-escrow/1) and the container itself, on top of libscriptgo.
//
// The two roles this file serves:
//   a licensed server   AssetKey.UnwrapForServer   the API's answer to POST /v1/licenses/key {kind:"assets"}
//                       AssetKey.WrapForClient     the same key, wrapped to one player's session key
//   a client (or test)  AssetKey.UnwrapForClient   the server's per-session wrap
//                       AssetContainer             open, check, bind, read in memory
//
// Native backend only: the content key never becomes a managed array. A reader's output buffer is
// plaintext, which is the point (the engine's loader reads it); from there no library can wipe it or
// keep it out of a memory dump. What this protects: assets at rest and in transit, one key per
// deployment, wrapped afresh for each player session, that the server can stop handing out; never
// "unbreakable".
using System.Runtime.InteropServices;
using System.Text;
using ScriptGo.Escrow.Native;

namespace ScriptGo.Escrow;

/// <summary>Constants and additional data of scriptgo-asset-escrow/1.</summary>
public static class AssetEscrowFormat
{
    public const string Format = "scriptgo-asset-escrow/1";
    /// <summary>The extension of an escrowed OPEN//77 preload's container inside its zip.</summary>
    public const string Extension = ".sgae";
    public const int KeyIdChars = 22;

    /// <summary>The aad of the API's wrap to a licensed server: binds the key to the release and the deployment.</summary>
    public static string ServerAad(string package, string version, string deployment) =>
        $"{Format}\nserver\n{package}@{version}\n{deployment}";

    /// <summary>The aad of a server's wrap to one player's session: binds the key to the release and its id.</summary>
    public static string ClientAad(string package, string version, string keyId) =>
        $"{Format}\nclient\n{package}@{version}\n{keyId}";
}

/// <summary>An asset content key in guarded native memory. It is never exported: it can only be
/// wrapped to another public key, identified by its <see cref="KeyId"/>, or bound to a container.</summary>
public sealed class AssetKey : IDisposable
{
    private readonly AssetKeyHandle _handle;

    private AssetKey(AssetKeyHandle handle)
    {
        _handle = handle;
        KeyId = ReadKeyId(handle);
    }

    /// <summary>base64url(SHA-256("scriptgo.asset-escrow.keyid.v1" || key)[0..16]): names the key, reveals nothing.</summary>
    public string KeyId { get; }

    internal AssetKeyHandle Handle => _handle;

    /// <summary>Unwraps the key the API wrapped to this server (<c>POST /v1/licenses/key</c> with
    /// <c>kind: "assets"</c>). <paramref name="aad"/> is the answer's <c>aad</c>, which must equal
    /// <see cref="AssetEscrowFormat.ServerAad"/> for the package, version and deployment this server
    /// expects: check it before calling, a key for another release must not be accepted.</summary>
    public static AssetKey UnwrapForServer(EscrowIdentity identity, WrappedKey wrapped, string aad) =>
        Unwrap(identity, EscrowNative.AssetWrapServer, wrapped, aad);

    /// <summary>Unwraps a server's per-session wrap with the session identity made for this connection.</summary>
    public static AssetKey UnwrapForClient(EscrowIdentity session, WrappedKey wrapped, string aad) =>
        Unwrap(session, EscrowNative.AssetWrapClient, wrapped, aad);

    /// <summary>Unwraps a client-code key the API wrapped to this server (<c>POST /v1/licenses/key</c>
    /// with <c>kind: "client"</c>, docs/spec/client-escrow.md). <paramref name="aad"/> must equal
    /// <see cref="ClientEscrowFormat.ServerAad"/>. The key's <see cref="KeyId"/> is the client-code id,
    /// <see cref="WrapForClient"/> re-wraps it with the client-code session label, and it binds only to a
    /// <see cref="ClientCodeContainer"/>.</summary>
    public static AssetKey UnwrapClientCodeForServer(EscrowIdentity identity, WrappedKey wrapped, string aad) =>
        Unwrap(identity, EscrowNative.ClientWrapServer, wrapped, aad);

    /// <summary>Unwraps a server's per-session wrap of a client-code key.</summary>
    public static AssetKey UnwrapClientCodeForSession(EscrowIdentity session, WrappedKey wrapped, string aad) =>
        Unwrap(session, EscrowNative.ClientWrapSession, wrapped, aad);

    /// <summary>Wraps this key to one player's session public key (32-byte X25519): a fresh ephemeral
    /// key and nonce per call. <paramref name="aad"/> is <see cref="AssetEscrowFormat.ClientAad"/>.</summary>
    public WrappedKey WrapForClient(ReadOnlySpan<byte> clientPublicKey, string aad)
    {
        ObjectDisposedException.ThrowIf(_handle.IsClosed, this);
        if (clientPublicKey.Length != 32) throw new ArgumentException("A session public key is 32 bytes.", nameof(clientPublicKey));
        ArgumentNullException.ThrowIfNull(aad);
        var aadBytes = Encoding.UTF8.GetBytes(aad);
        var epk = new byte[32];
        var nonce = new byte[12];
        var wrapped = new byte[48];
        int rc;
        unsafe
        {
            fixed (byte* pub = clientPublicKey)
            fixed (byte* a = aadBytes)
            fixed (byte* e = epk)
            fixed (byte* n = nonce)
            fixed (byte* w = wrapped)
                rc = EscrowNative.sg_asset_key_wrap(_handle, pub, a, (nuint)aadBytes.Length, e, n, w);
        }
        if (rc != EscrowNative.Ok) throw new EscrowException(EscrowFailure.UnwrapFailed, "wrap_failed:" + EscrowNative.ErrorText(rc));
        return new WrappedKey(Base64Url.Encode(epk), Base64Url.Encode(nonce), Base64Url.Encode(wrapped));
    }

    public void Dispose() => _handle.Dispose();

    private static AssetKey Unwrap(EscrowIdentity identity, int kind, WrappedKey wrapped, string aad)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(wrapped);
        ArgumentNullException.ThrowIfNull(aad);
        if (identity.Backend != EscrowBackend.Native)
            throw new EscrowException(EscrowFailure.NativeLibraryUnavailable, "native_library_unavailable:asset escrow needs the native backend");
        EnsureAvailable();
        byte[] epk, nonce, key;
        try { (epk, nonce, key) = (Base64Url.Decode(wrapped.Epk), Base64Url.Decode(wrapped.Nonce), Base64Url.Decode(wrapped.Wrapped)); }
        catch (FormatException) { throw new EscrowException(EscrowFailure.UnwrapFailed, "unwrap_failed:bad_encoding"); }
        if (epk.Length != 32 || nonce.Length != 12 || key.Length != 48)
            throw new EscrowException(EscrowFailure.UnwrapFailed, "unwrap_failed:bad_length");
        var aadBytes = Encoding.UTF8.GetBytes(aad);
        IntPtr handle = IntPtr.Zero;
        int rc;
        unsafe
        {
            fixed (byte* e = epk)
            fixed (byte* n = nonce)
            fixed (byte* w = key)
            fixed (byte* a = aadBytes)
            {
                rc = EscrowNative.sg_asset_key_unwrap(identity.NativeHandle, kind, e, n, w, (nuint)key.Length, a, (nuint)aadBytes.Length, out handle);
            }
        }
        if (rc != EscrowNative.Ok)
            throw new EscrowException(EscrowFailure.UnwrapFailed, "unwrap_failed:" + EscrowNative.ErrorText(rc));
        return new AssetKey(new AssetKeyHandle(handle));
    }

    private static string ReadKeyId(AssetKeyHandle handle)
    {
        Span<byte> buffer = stackalloc byte[AssetEscrowFormat.KeyIdChars + 1];
        int rc;
        unsafe
        {
            fixed (byte* b = buffer) rc = EscrowNative.sg_asset_key_id(handle, b, (nuint)buffer.Length);
        }
        if (rc != EscrowNative.Ok) { handle.Dispose(); throw new EscrowException(EscrowFailure.UnwrapFailed, "key_id:" + EscrowNative.ErrorText(rc)); }
        return Encoding.ASCII.GetString(buffer[..AssetEscrowFormat.KeyIdChars]);
    }

    private static volatile bool _assetApiChecked;

    /// <summary>The native library, and its asset calls: a libscriptgo of ABI 1 that predates them has
    /// no such export, which is said here instead of failing at the first call.</summary>
    internal static void EnsureAvailable()
    {
        EscrowNativeLibrary.EnsureAvailable();
        if (_assetApiChecked) return;
        try { EscrowNative.sg_asset_key_free(IntPtr.Zero); } // NULL is accepted: a pure presence probe
        catch (EntryPointNotFoundException)
        {
            throw new EscrowException(EscrowFailure.NativeLibraryUnavailable,
                "native_library_unavailable:this libscriptgo has no asset escrow calls (sg_asset_*); use the library that ships with this package");
        }
        _assetApiChecked = true;
    }
}

/// <summary>One file of a container: its path and plaintext size.</summary>
public readonly record struct AssetEntry(string Path, long Size);

/// <summary>An opened asset container. Opening runs every check that needs no key (format,
/// canonical header, pinned signer, signature, file table, ciphertext hashes). The container bytes
/// are copied to unmanaged memory and kept until <see cref="Dispose"/>. <see cref="Open"/> needs the
/// signer you trust; <see cref="Inspect"/> checks integrity only and never binds a key.</summary>
public sealed class AssetContainer : IDisposable
{
    private readonly AssetContainerHandle _handle;
    private bool _disposed;

    private AssetContainer(AssetContainerHandle handle)
    {
        _handle = handle;
        Package = Field("package")!;
        Version = Field("version")!;
        Release = Field("release")!;
        Deployment = Field("deployment")!;
        KeyId = Field("keyId")!;
        SignerPublicKey = Field("signerPublicKey")!;
        Fingerprint = Field("fingerprint");
        Files = ReadFiles();
    }

    public string Package { get; }
    public string Version { get; }
    public string Release { get; }
    public string Deployment { get; }
    public string KeyId { get; }
    public string SignerPublicKey { get; }
    /// <summary>The per-buyer fingerprint marker (ADR-0043), or null.</summary>
    public string? Fingerprint { get; }
    public IReadOnlyList<AssetEntry> Files { get; }
    public bool IsBound { get; private set; }
    /// <summary>True for a container from <see cref="Inspect"/>: its signature was checked under the key its
    /// header names (integrity, not origin), and it never takes a key.</summary>
    public bool IsInspectOnly { get; private init; }

    /// <summary>Opens and checks a container whose files will be decrypted. <paramref name="trustedSigner"/>
    /// (32 bytes, required) is the signer you trust, from a source the party that handed you the container
    /// does not control; a container signed by any other key is refused (<c>bad_signature</c>). Since 0.5.0
    /// there is no "accept the key the header names": that proves integrity, not origin, and is
    /// <see cref="Inspect"/>.</summary>
    public static AssetContainer Open(ReadOnlySpan<byte> container, ReadOnlySpan<byte> trustedSigner)
    {
        if (trustedSigner.Length != 32) throw new ArgumentException("A pinned signer public key (32 bytes) is required.", nameof(trustedSigner));
        return OpenCore(container, trustedSigner, inspect: false);
    }

    /// <summary>Runs the same checks with the signature verified under the key the header names: integrity
    /// only. For a host that reads the header and the file table and never decrypts (a server that relays
    /// containers to its clients). Compare <see cref="SignerPublicKey"/> with the key you trust before you
    /// rely on anything else; <see cref="Bind"/> refuses an inspected container.</summary>
    public static AssetContainer Inspect(ReadOnlySpan<byte> container) => OpenCore(container, default, inspect: true);

    private static AssetContainer OpenCore(ReadOnlySpan<byte> container, ReadOnlySpan<byte> trustedSigner, bool inspect)
    {
        if (container.IsEmpty) throw new EscrowException(EscrowFailure.InvalidBundle, "bad_container:empty");
        AssetKey.EnsureAvailable();
        unsafe
        {
            var data = (byte*)NativeMemory.Alloc((nuint)container.Length);
            container.CopyTo(new Span<byte>(data, container.Length));
            IntPtr handle = IntPtr.Zero;
            int rc;
            try
            {
                fixed (byte* signer = trustedSigner)
                {
                    rc = inspect
                        ? EscrowNative.sg_asset_container_inspect(data, (nuint)container.Length, out handle)
                        : EscrowNative.sg_asset_container_open(data, (nuint)container.Length, signer, out handle);
                }
            }
            catch (EntryPointNotFoundException)
            {
                NativeMemory.Free(data);
                throw new EscrowException(EscrowFailure.NativeLibraryUnavailable,
                    "native_library_unavailable:this libscriptgo predates sg_asset_container_inspect (0.2.0); use the library that ships with this package");
            }
            if (rc != EscrowNative.Ok)
            {
                NativeMemory.Free(data);
                throw rc switch
                {
                    EscrowNative.ErrBadSignature or EscrowNative.ErrUntrustedSigner =>
                        new EscrowException(EscrowFailure.Signature, "bad_signature:" + EscrowNative.ErrorText(rc)),
                    EscrowNative.ErrPayloadHash => new EscrowException(EscrowFailure.DecryptFailed, "payload_hash:" + EscrowNative.ErrorText(rc)),
                    _ => new EscrowException(EscrowFailure.InvalidBundle, "bad_container:" + EscrowNative.ErrorText(rc)),
                };
            }
            return new AssetContainer(new AssetContainerHandle(handle, (IntPtr)data)) { IsInspectOnly = inspect };
        }
    }

    /// <summary>Gives the container its content key. Refused (<c>key_mismatch</c>) when the key's id is
    /// not the header's: another deployment's or another release's key. An inspected container is refused
    /// (<c>untrusted_signer</c>).</summary>
    public void Bind(AssetKey key)
    {
        ArgumentNullException.ThrowIfNull(key);
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (IsBound) throw new InvalidOperationException("The container already has its key.");
        if (IsInspectOnly) throw new EscrowException(EscrowFailure.Signature, "untrusted_signer:an inspected container is never decrypted; open it with the signer you trust");
        var rc = EscrowNative.sg_asset_container_bind(_handle, key.Handle);
        if (rc == EscrowNative.ErrKeyMismatch) throw new EscrowException(EscrowFailure.UnwrapFailed, "key_mismatch");
        if (rc != EscrowNative.Ok) throw new EscrowException(EscrowFailure.UnwrapFailed, "bind_failed:" + EscrowNative.ErrorText(rc));
        IsBound = true;
    }

    /// <summary>A reader for the calling thread (one decrypted chunk cached in guarded memory).</summary>
    public AssetReader OpenReader()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!IsBound) throw new InvalidOperationException("Bind the content key first.");
        return new AssetReader(_handle);
    }

    /// <summary>Decrypts one whole file into a new managed array: plaintext the GC may copy. For tests
    /// and tools; a loader that cares reads into its own buffer through <see cref="OpenReader"/>.</summary>
    public byte[] ReadAll(string path)
    {
        var entry = Files.FirstOrDefault(f => f.Path == path);
        if (entry.Path is null) throw new EscrowException(EscrowFailure.InvalidBundle, "not_found:" + path);
        var buffer = new byte[entry.Size];
        using var reader = OpenReader();
        var read = reader.Read(path, 0, buffer);
        if (read != buffer.Length) throw new EscrowException(EscrowFailure.DecryptFailed, "short_read:" + path);
        return buffer;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        // Released once no call is in flight and every reader is disposed (readers hold a reference):
        // then the key is wiped, the container freed, and its bytes after it.
        _handle.Dispose();
    }

    private string? Field(string name)
    {
        var rc = EscrowNative.sg_asset_container_field(_handle, name, out var value);
        if (rc == EscrowNative.ErrNotFound) return null;
        if (rc != EscrowNative.Ok) throw new EscrowException(EscrowFailure.InvalidBundle, "bad_container:" + EscrowNative.ErrorText(rc));
        return Marshal.PtrToStringUTF8(value);
    }

    private List<AssetEntry> ReadFiles()
    {
        var rc = EscrowNative.sg_asset_container_file_count(_handle, out var count);
        if (rc != EscrowNative.Ok) throw new EscrowException(EscrowFailure.InvalidBundle, "bad_container:" + EscrowNative.ErrorText(rc));
        var files = new List<AssetEntry>((int)count);
        for (nuint i = 0; i < count; i++)
        {
            rc = EscrowNative.sg_asset_container_file_at(_handle, i, out var path, out var size);
            if (rc != EscrowNative.Ok) throw new EscrowException(EscrowFailure.InvalidBundle, "bad_container:" + EscrowNative.ErrorText(rc));
            files.Add(new AssetEntry(Marshal.PtrToStringUTF8(path)!, (long)size));
        }
        return files;
    }
}

/// <summary>Reads decrypted ranges of a bound container. Belongs to one thread.</summary>
public sealed class AssetReader : IDisposable
{
    private readonly AssetContainerHandle _container;
    private IntPtr _reader;

    internal AssetReader(AssetContainerHandle container)
    {
        var added = false;
        container.DangerousAddRef(ref added); // the container outlives its readers
        _container = container;
        var rc = EscrowNative.sg_asset_reader_new(container, out _reader);
        if (rc != EscrowNative.Ok)
        {
            container.DangerousRelease();
            throw new EscrowException(EscrowFailure.DecryptFailed, "reader:" + EscrowNative.ErrorText(rc));
        }
    }

    /// <summary>Decrypts [offset, offset + buffer.Length) of <paramref name="path"/>, clamped to the
    /// file. Every chunk is authenticated before a byte of it is copied. Returns the bytes written.</summary>
    public int Read(string path, long offset, Span<byte> buffer)
    {
        ArgumentNullException.ThrowIfNull(path);
        ObjectDisposedException.ThrowIf(_reader == IntPtr.Zero, this);
        ArgumentOutOfRangeException.ThrowIfNegative(offset);
        int rc;
        nuint read;
        unsafe
        {
            fixed (byte* b = buffer) rc = EscrowNative.sg_asset_reader_read(_reader, path, (ulong)offset, b, (nuint)buffer.Length, out read);
        }
        if (rc == EscrowNative.ErrNotFound) throw new EscrowException(EscrowFailure.InvalidBundle, "not_found:" + path);
        if (rc != EscrowNative.Ok) throw new EscrowException(EscrowFailure.DecryptFailed, "decrypt_failed:" + EscrowNative.ErrorText(rc));
        return (int)read;
    }

    public void Dispose()
    {
        if (_reader == IntPtr.Zero) return;
        EscrowNative.sg_asset_reader_free(_reader);
        _reader = IntPtr.Zero;
        _container.DangerousRelease();
    }
}
