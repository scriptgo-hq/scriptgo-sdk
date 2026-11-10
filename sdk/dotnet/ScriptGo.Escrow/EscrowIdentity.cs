// The per-server identity: an X25519 key pair. The master wraps a release's content key to the
// public key; the private key never leaves the server. That is what makes a leaked encrypted
// folder fail on an unbound box (CREATOR-PROTECTION.md §3.3), without hardware fingerprinting.
//
// Native backend (default): the private key is generated, stored and used inside libscriptgo. It is
// never a managed array, and there is no API here that returns it.
// Managed backend (explicit fallback): the private key is a pinned managed array, wiped on Dispose.
// Both backends read and write the same identity file, so a server keeps its identity when it
// moves from one to the other.
using System.Security.Cryptography;
using ScriptGo.Escrow.Managed;
using ScriptGo.Escrow.Native;

namespace ScriptGo.Escrow;

public sealed class EscrowIdentity : IDisposable
{
    private readonly EscrowIdentityHandle? _native;
    private readonly byte[]? _managedPrivate; // pinned; the managed backend only
    private readonly byte[] _public;
    private bool _disposed;

    private EscrowIdentity(EscrowIdentityHandle native, bool created)
    {
        _native = native;
        Backend = EscrowBackend.Native;
        Created = created;
        _public = new byte[32];
        unsafe
        {
            fixed (byte* p = _public)
            {
                var rc = EscrowNative.sg_identity_public_key(native, p);
                if (rc != EscrowNative.Ok) throw new CryptographicException(EscrowNative.ErrorText(rc));
            }
        }
    }

    private EscrowIdentity(byte[] pinnedPrivate, bool created)
    {
        _managedPrivate = pinnedPrivate;
        Backend = EscrowBackend.Managed;
        Created = created;
        _public = ManagedCrypto.X25519PublicKey(pinnedPrivate);
    }

    /// <summary>Where this identity's private key lives.</summary>
    public EscrowBackend Backend { get; }

    /// <summary>True when <see cref="LoadOrCreate"/> wrote a new identity file: the server then has a
    /// new public key that its deployment does not know yet.</summary>
    public bool Created { get; }

    /// <summary>Raw 32-byte X25519 public key (registered with the deployment). A copy.</summary>
    public byte[] PublicKey => (byte[])_public.Clone();

    /// <summary>The public key as the key endpoint expects it (base64url, no padding).</summary>
    public string PublicKeyBase64Url => Base64Url.Encode(_public);

    internal EscrowIdentityHandle NativeHandle => _native ?? throw new InvalidOperationException("This identity uses the managed backend.");

    /// <summary>
    /// Loads the identity stored at <paramref name="path"/>, or creates one there on first run.
    /// On Windows the private key is sealed with DPAPI for the current user (the file opens only for
    /// that account on that machine); elsewhere the file is created with mode 0600 and refused when
    /// group or others can read it. An existing file that cannot be opened is an error: an identity is
    /// never silently replaced, because that would unbind the server.
    /// </summary>
    /// <param name="path">The identity file. Its directory is created when missing.</param>
    /// <param name="backend"><see cref="EscrowBackend.Native"/> (default) keeps the private key out of
    /// managed memory. <see cref="EscrowBackend.Managed"/> is the labelled fallback.</param>
    /// <param name="allowManagedFallback">When the native library is absent: false (default) fails
    /// closed with a message that says what is missing; true falls back to the managed backend, and
    /// <see cref="Backend"/> then reports <see cref="EscrowBackend.Managed"/>.</param>
    public static EscrowIdentity LoadOrCreate(string path, EscrowBackend backend = EscrowBackend.Native, bool allowManagedFallback = false)
    {
        ArgumentException.ThrowIfNullOrEmpty(path);
        var full = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        if (ResolveBackend(backend, allowManagedFallback) == EscrowBackend.Managed)
        {
            var (key, created) = ManagedIdentityStore.LoadOrCreate(full);
            return new EscrowIdentity(key, created);
        }
        var rc = EscrowNative.sg_identity_load_or_create(full, out var handle, out var wasCreated);
        if (rc != EscrowNative.Ok) throw IdentityError(rc, full);
        return new EscrowIdentity(new EscrowIdentityHandle(handle), wasCreated != 0);
    }

    /// <summary>A fresh identity that lives only in memory (tests, or a host with its own key store).</summary>
    public static EscrowIdentity Generate(EscrowBackend backend = EscrowBackend.Native, bool allowManagedFallback = false)
    {
        if (ResolveBackend(backend, allowManagedFallback) == EscrowBackend.Managed)
        {
            var key = GC.AllocateArray<byte>(32, pinned: true);
            RandomNumberGenerator.Fill(key);
            return new EscrowIdentity(key, created: true);
        }
        var rc = EscrowNative.sg_identity_generate(out var handle);
        if (rc != EscrowNative.Ok) throw new CryptographicException(EscrowNative.ErrorText(rc));
        return new EscrowIdentity(new EscrowIdentityHandle(handle), created: true);
    }

    /// <summary>
    /// An identity from a raw 32-byte X25519 private key the caller already holds (a migration from
    /// another key store). This is the one door through which a private key enters from managed
    /// memory: prefer <see cref="LoadOrCreate"/>, which never exposes it. Wipe your copy afterwards.
    /// </summary>
    public static EscrowIdentity ImportPrivateKey(ReadOnlySpan<byte> privateKey, EscrowBackend backend = EscrowBackend.Native, bool allowManagedFallback = false)
    {
        if (privateKey.Length != 32) throw new ArgumentException("An X25519 private key is 32 bytes.", nameof(privateKey));
        if (ResolveBackend(backend, allowManagedFallback) == EscrowBackend.Managed)
        {
            var key = GC.AllocateArray<byte>(32, pinned: true);
            privateKey.CopyTo(key);
            return new EscrowIdentity(key, created: false);
        }
        unsafe
        {
            fixed (byte* p = privateKey)
            {
                var rc = EscrowNative.sg_identity_import(p, out var handle);
                if (rc != EscrowNative.Ok) throw new CryptographicException(EscrowNative.ErrorText(rc));
                return new EscrowIdentity(new EscrowIdentityHandle(handle), created: false);
            }
        }
    }

    /// <summary>Writes this identity to a file in the same protected format <see cref="LoadOrCreate"/>
    /// reads. With <paramref name="replace"/> false an existing file is kept and an exception thrown.</summary>
    public void Save(string path, bool replace = false)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var full = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        if (Backend == EscrowBackend.Managed)
        {
            ManagedIdentityStore.Save(full, _managedPrivate!, _public, replace);
            return;
        }
        var rc = EscrowNative.sg_identity_save(_native!, full, replace ? 1 : 0);
        if (rc != EscrowNative.Ok) throw IdentityError(rc, full);
    }

    /// <summary>The managed backend's unwrap. The native backend unwraps inside libscriptgo.</summary>
    internal byte[] UnwrapManaged(WrappedKey wrapped, ReadOnlySpan<byte> aad)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return ManagedCrypto.UnwrapContentKey(wrapped, _managedPrivate!, _public, aad);
    }

    /// <summary>Picks the backend: native unless asked otherwise; managed only when asked for, or
    /// when the native library is absent and the caller opted in. Never a silent downgrade.</summary>
    internal static EscrowBackend ResolveBackend(EscrowBackend requested, bool allowManagedFallback)
    {
        var nativeAvailable = requested == EscrowBackend.Native && EscrowNativeLibrary.IsAvailable;
        if (ChooseBackend(requested, allowManagedFallback, nativeAvailable) is { } backend) return backend;
        EscrowNativeLibrary.EnsureAvailable(); // throws, with the reason and the remedy
        return EscrowBackend.Native;
    }

    /// <summary>The decision itself. Null means: fail closed.</summary>
    internal static EscrowBackend? ChooseBackend(EscrowBackend requested, bool allowManagedFallback, bool nativeAvailable)
    {
        if (requested == EscrowBackend.Managed) return EscrowBackend.Managed;
        if (nativeAvailable) return EscrowBackend.Native;
        return allowManagedFallback ? EscrowBackend.Managed : null;
    }

    private static Exception IdentityError(int code, string path)
    {
        var text = EscrowNative.ErrorText(code);
        return code == EscrowNative.ErrExists
            ? new IOException($"identity file already exists: {path}")
            : new CryptographicException($"escrow identity at {path}: {text}");
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _native?.Dispose(); // libscriptgo wipes the key before freeing it
        if (_managedPrivate is not null) CryptographicOperations.ZeroMemory(_managedPrivate);
    }
}
