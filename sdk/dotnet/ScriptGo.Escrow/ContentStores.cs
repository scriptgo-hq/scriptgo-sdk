// Where the decrypted files of a release live. Two implementations behind one internal seam:
// NativeContentStore (libscriptgo: plaintext in guarded native memory) and ManagedContentStore
// (the labelled fallback: plaintext in managed arrays).
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using ScriptGo.Escrow.Native;

namespace ScriptGo.Escrow;

internal interface IContentStore : IDisposable
{
    /// <summary>The files of the encrypted payload, in path order. The delivery marker is not listed.</summary>
    IReadOnlyList<EscrowEntry> Entries { get; }
    bool MemoryLocked { get; }
    /// <summary>The size of an encrypted file or of the delivery marker.</summary>
    bool TryGetSize(string path, out long size);
    /// <summary>Copies a file into managed memory. Returns false when there is no such file; throws
    /// <see cref="ArgumentException"/> when <paramref name="destination"/> is too small.</summary>
    bool TryCopy(string path, Span<byte> destination, out int written);
    LuaChunkResult LoadLua(IntPtr luaState, string path, string chunkName, IntPtr loadBufferX);
    void SetMarker(ReadOnlySpan<byte> marker);
}

internal sealed class NativeContentStore : IContentStore
{
    private readonly EscrowBundleHandle _handle;

    private NativeContentStore(EscrowBundleHandle handle, List<EscrowEntry> entries, bool locked)
    {
        _handle = handle;
        Entries = entries;
        MemoryLocked = locked;
    }

    public IReadOnlyList<EscrowEntry> Entries { get; }
    public bool MemoryLocked { get; }

    /// <summary>Unwraps the content key and decrypts the payload inside libscriptgo. Neither the key
    /// nor the plaintext is ever a managed object on this path.</summary>
    public static unsafe NativeContentStore Open(EscrowIdentity identity, EscrowBundle bundle, WrappedKey wrapped)
    {
        EscrowNativeLibrary.EnsureAvailable();
        var manifest = bundle.Manifest;
        byte[] epk, wrapNonce, wrappedKey, payloadNonce, expectedHash;
        try
        {
            epk = Base64Url.Decode(wrapped.Epk);
            wrapNonce = Base64Url.Decode(wrapped.Nonce);
            wrappedKey = Base64Url.Decode(wrapped.Wrapped);
        }
        catch (FormatException) { throw new EscrowException(EscrowFailure.UnwrapFailed, "unwrap_failed:the wrapped key is not base64url"); }
        if (epk.Length != 32 || wrapNonce.Length != 12 || wrappedKey.Length != 48)
            throw new EscrowException(EscrowFailure.UnwrapFailed, "unwrap_failed:the wrapped key has the wrong shape");
        try
        {
            payloadNonce = Base64Url.Decode(manifest.Payload.Nonce);
            expectedHash = Convert.FromHexString(manifest.Payload.Sha256);
        }
        catch (FormatException) { throw new EscrowException(EscrowFailure.InvalidBundle, "invalid_bundle:the payload nonce or hash is malformed"); }
        if (payloadNonce.Length != 12 || expectedHash.Length != 32)
            throw new EscrowException(EscrowFailure.InvalidBundle, "invalid_bundle:the payload nonce or hash has the wrong length");
        var aad = Encoding.UTF8.GetBytes(manifest.Aad);
        var payload = bundle.Payload;
        if (payload.Length < 16) throw new EscrowException(EscrowFailure.InvalidBundle, "invalid_bundle:payload.enc is shorter than a GCM tag");

        int rc;
        IntPtr raw;
        fixed (byte* p = payload, pn = payloadNonce, a = aad, e = epk, wn = wrapNonce, w = wrappedKey, h = expectedHash)
        {
            // An empty aad pins to a null pointer; the library accepts that with a zero length.
            rc = EscrowNative.sg_bundle_open(identity.NativeHandle, p, (nuint)payload.Length, pn, a, (nuint)aad.Length,
                e, wn, w, (nuint)wrappedKey.Length, h, out raw);
        }
        if (rc != EscrowNative.Ok) throw OpenError(rc);

        var handle = new EscrowBundleHandle(raw);
        try
        {
            EscrowNative.sg_bundle_entry_count(handle, out var count);
            var entries = new List<EscrowEntry>((int)count);
            for (nuint i = 0; i < count; i++)
            {
                if (EscrowNative.sg_bundle_entry_at(handle, i, out var path, out var size) != EscrowNative.Ok) break;
                // Paths are public (escrow.json lists them): they may be managed strings.
                entries.Add(new EscrowEntry(Marshal.PtrToStringUTF8(path)!, (long)size));
            }
            return new NativeContentStore(handle, entries, EscrowNative.sg_bundle_memory_locked(handle) == 1);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static EscrowException OpenError(int code)
    {
        var text = EscrowNative.ErrorText(code);
        return code switch
        {
            EscrowNative.ErrUnwrap => new EscrowException(EscrowFailure.UnwrapFailed, "unwrap_failed:" + text),
            EscrowNative.ErrPayloadHash or EscrowNative.ErrDecrypt => new EscrowException(EscrowFailure.DecryptFailed, "decrypt_failed:" + text),
            EscrowNative.ErrNoAes => new EscrowException(EscrowFailure.NativeLibraryUnavailable, "native_library_unavailable:" + text),
            _ => new EscrowException(EscrowFailure.InvalidBundle, "invalid_bundle:" + text),
        };
    }

    public bool TryGetSize(string path, out long size)
    {
        var rc = EscrowNative.sg_bundle_entry_size(_handle, path, out var n);
        size = (long)n;
        return rc == EscrowNative.Ok;
    }

    public unsafe bool TryCopy(string path, Span<byte> destination, out int written)
    {
        written = 0;
        nuint length;
        int rc;
        fixed (byte* d = destination)
            rc = EscrowNative.sg_bundle_copy(_handle, path, d, (nuint)destination.Length, out length);
        if (rc == EscrowNative.ErrNotFound) return false;
        if (rc == EscrowNative.ErrBufferTooSmall) throw new ArgumentException($"The destination is too small: {path} is {length} bytes.", nameof(destination));
        if (rc != EscrowNative.Ok) throw new InvalidOperationException(EscrowNative.ErrorText(rc));
        written = (int)length;
        return true;
    }

    public LuaChunkResult LoadLua(IntPtr luaState, string path, string chunkName, IntPtr loadBufferX)
    {
        // The plaintext goes from libscriptgo's memory into the Lua VM inside this one native call.
        var rc = EscrowNative.sg_bundle_lua_load(_handle, path, luaState, loadBufferX, chunkName, out var luaStatus);
        return rc switch
        {
            EscrowNative.Ok => new LuaChunkResult(LuaChunkStatus.Loaded, 0),
            EscrowNative.ErrLuaLoad => new LuaChunkResult(LuaChunkStatus.LuaError, luaStatus),
            EscrowNative.ErrNotFound => new LuaChunkResult(LuaChunkStatus.NotFound, 0),
            _ => throw new InvalidOperationException(EscrowNative.ErrorText(rc)),
        };
    }

    public unsafe void SetMarker(ReadOnlySpan<byte> marker)
    {
        int rc;
        fixed (byte* m = marker) rc = EscrowNative.sg_bundle_set_marker(_handle, m, (nuint)marker.Length);
        if (rc != EscrowNative.Ok && rc != EscrowNative.ErrExists) throw new InvalidOperationException(EscrowNative.ErrorText(rc));
    }

    public void Dispose() => _handle.Dispose(); // sg_bundle_free wipes the plaintext
}

/// <summary>The managed fallback: every decrypted file is a managed array. Weaker against memory
/// inspection than the native store, by construction.</summary>
internal sealed class ManagedContentStore : IContentStore
{
    private readonly Dictionary<string, byte[]> _files;
    private byte[]? _marker;
    private bool _disposed;

    public ManagedContentStore(Dictionary<string, byte[]> files)
    {
        _files = files;
        Entries = files.OrderBy(f => f.Key, StringComparer.Ordinal).Select(f => new EscrowEntry(f.Key, f.Value.LongLength)).ToList();
    }

    public IReadOnlyList<EscrowEntry> Entries { get; }
    public bool MemoryLocked => false;

    private byte[]? Find(string path)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_files.TryGetValue(path, out var bytes)) return bytes;
        return path == EscrowFormat.DeliveryMarker ? _marker : null;
    }

    public bool TryGetSize(string path, out long size)
    {
        var bytes = Find(path);
        size = bytes?.LongLength ?? 0;
        return bytes is not null;
    }

    public bool TryCopy(string path, Span<byte> destination, out int written)
    {
        written = 0;
        var bytes = Find(path);
        if (bytes is null) return false;
        if (destination.Length < bytes.Length) throw new ArgumentException($"The destination is too small: {path} is {bytes.Length} bytes.", nameof(destination));
        bytes.CopyTo(destination);
        written = bytes.Length;
        return true;
    }

    public unsafe LuaChunkResult LoadLua(IntPtr luaState, string path, string chunkName, IntPtr loadBufferX)
    {
        var bytes = Find(path);
        if (bytes is null) return new LuaChunkResult(LuaChunkStatus.NotFound, 0);
        var name = Encoding.UTF8.GetBytes(chunkName + "\0");
        ReadOnlySpan<byte> mode = "t\0"u8; // text only: Lua refuses precompiled bytecode
        var load = (delegate* unmanaged[Cdecl]<IntPtr, byte*, nuint, byte*, byte*, int>)loadBufferX;
        int status;
        fixed (byte* source = bytes.Length > 0 ? bytes : new byte[1])
        fixed (byte* n = name, m = mode)
            status = load(luaState, source, (nuint)bytes.Length, n, m);
        return status == 0 ? new LuaChunkResult(LuaChunkStatus.Loaded, 0) : new LuaChunkResult(LuaChunkStatus.LuaError, status);
    }

    public void SetMarker(ReadOnlySpan<byte> marker)
    {
        if (_files.ContainsKey(EscrowFormat.DeliveryMarker)) return; // an archive entry of that name wins
        _marker = marker.Length > 0 ? marker.ToArray() : null;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        // Best effort: the garbage collector may already have copied these arrays elsewhere.
        foreach (var bytes in _files.Values) CryptographicOperations.ZeroMemory(bytes);
        _files.Clear();
    }
}
