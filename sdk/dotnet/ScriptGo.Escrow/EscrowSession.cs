// The entry point of the package: bundle bytes in, an EscrowContent out.
//
//   using var identity = EscrowIdentity.LoadOrCreate("data/scriptgo.identity");
//   var keys = new HttpEscrowKeyService(http, new("sg_dep_...", "creator//name", "my-engine"));
//   using var content = await EscrowSession.OpenAsync(bundleBytes, identity, keys, trustedSigner);
//   content.LoadLuaChunk(lua.Handle, "server/main.lua", "@demo/server/main.lua", loader);
//
// The order is fixed: parse, verify the signature, check the clear files, and only then ask for the
// key. A bundle that fails any check never causes a key request, so nothing is released for it.
using System.Security.Cryptography;
using System.Text;

namespace ScriptGo.Escrow;

public sealed class EscrowOpenOptions
{
    /// <summary>The clock the lease runs on. Tests pass a fake one.</summary>
    public TimeProvider TimeProvider { get; init; } = TimeProvider.System;

    /// <summary>The lease to assume when the key service gives no <c>expiresAt</c>. Default 15 minutes.</summary>
    public TimeSpan DefaultLease { get; init; } = TimeSpan.FromMinutes(15);

    /// <summary>The offline grace to assume after the lease when the key service gives no
    /// <c>offlineGraceUntil</c>. Default none: grace is the license server's decision, not the host's.</summary>
    public TimeSpan DefaultOfflineGrace { get; init; } = TimeSpan.Zero;

    /// <summary>
    /// Which clear files may differ from the signed release. Null (the default): none, any edit is
    /// refused. A host that lets operators edit the files a creator left clear (a config) returns
    /// true for those paths; it should still return false for whatever decides what code runs (the
    /// resource manifest). Called with the resource-relative path of each missing or modified file.
    /// </summary>
    public Func<string, bool>? AllowEditedClearFile { get; init; }
}

public static class EscrowSession
{
    /// <summary>
    /// Opens an escrow release: verifies the release signature, asks <paramref name="keyService"/> for
    /// the content key wrapped to <paramref name="identity"/>, unwraps and decrypts (in libscriptgo
    /// on the native backend), and returns the content. The backend is the identity's.
    /// </summary>
    /// <param name="bundle">The bytes of the <c>.escrow.zip</c> release.</param>
    /// <param name="identity">This server's identity; see <see cref="EscrowIdentity.LoadOrCreate"/>.</param>
    /// <param name="keyService">Where the key comes from; <see cref="HttpEscrowKeyService"/> in production.</param>
    /// <param name="trustedSignerPublicKey">The ed25519 release-signing key you trust (raw, base64url).
    /// Always pass it in production: with null the signature only proves the bundle was not modified
    /// after signing, by whoever signed it.</param>
    /// <exception cref="EscrowException">The reason says which step refused: <c>invalid_bundle:</c>,
    /// <c>signature:</c>, <c>refused:&lt;license reason&gt;</c>, <c>key_service_unreachable:</c>,
    /// <c>unwrap_failed:</c> (this server is not the one the key was released to),
    /// <c>decrypt_failed:</c>, <c>native_library_unavailable:</c>.</exception>
    public static async Task<EscrowContent> OpenAsync(
        ReadOnlyMemory<byte> bundle,
        EscrowIdentity identity,
        IEscrowKeyService keyService,
        string? trustedSignerPublicKey,
        EscrowOpenOptions? options = null,
        CancellationToken cancellation = default)
    {
        EscrowBundle parsed;
        try { parsed = EscrowBundle.Read(bundle); }
        catch (InvalidDataException e) { throw new EscrowException(EscrowFailure.InvalidBundle, "invalid_bundle:" + e.Message, e); }
        return await OpenAsync(parsed, identity, keyService, trustedSignerPublicKey, options, cancellation).ConfigureAwait(false);
    }

    /// <summary>
    /// Opens a release already parsed by <see cref="EscrowBundle.Read"/> or
    /// <see cref="EscrowBundle.ReadFolder"/> (a release installed, still encrypted, as a folder).
    /// The same order as the other overloads: signature, clear files, then the key request.
    /// A host with a main loop that must not wait on the network uses <see cref="Open"/> instead.
    /// </summary>
    /// <exception cref="EscrowException">As the other overloads; also <c>refused:release_mismatch</c>
    /// when the key service names another release than the one opened, and <c>signature:</c> when,
    /// with no signer pinned, the manifest's signer is not the one the key service names.</exception>
    public static async Task<EscrowContent> OpenAsync(
        EscrowBundle bundle,
        EscrowIdentity identity,
        IEscrowKeyService keyService,
        string? trustedSignerPublicKey,
        EscrowOpenOptions? options = null,
        CancellationToken cancellation = default)
    {
        ArgumentNullException.ThrowIfNull(bundle);
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(keyService);
        options ??= new EscrowOpenOptions();
        Precheck(bundle, identity, trustedSignerPublicKey, options);

        EscrowKeyResult grant;
        try { grant = await keyService.RequestKeyAsync(bundle.Manifest, identity, cancellation).ConfigureAwait(false); }
        catch (HttpRequestException e) { throw new EscrowException(EscrowFailure.KeyServiceUnreachable, "key_service_unreachable:" + e.Message, e); }
        catch (TaskCanceledException e) when (!cancellation.IsCancellationRequested) { throw new EscrowException(EscrowFailure.KeyServiceUnreachable, "key_service_unreachable:" + e.Message, e); }
        return Finish(bundle, identity, grant, keyService, trustedSignerPublicKey, options);
    }

    /// <summary>
    /// Opens a release with a key answer the host already holds, without any request: for a host
    /// with a main loop that must not wait on the network. Ask for the key in the background
    /// (<see cref="IEscrowKeyService.RequestKeyAsync"/>), keep the valid answer (in memory only; see
    /// <see cref="EscrowKeyCache"/>), then call this on the thread that owns the Lua state. The same
    /// checks as <see cref="OpenAsync(EscrowBundle, EscrowIdentity, IEscrowKeyService, string?, EscrowOpenOptions?, CancellationToken)"/>
    /// run here, in the same order. <paramref name="keyService"/> is used for renewals only.
    /// <para>An answer past its <c>expiresAt</c> but inside its <c>offlineGraceUntil</c> opens too:
    /// that is a start during an outage, on the grace of the last valid answer; the content then
    /// reports <see cref="EscrowLeaseState.Grace"/> and renewal keeps asking. An answer past its
    /// grace is refused with <c>revoked:</c>.</para>
    /// </summary>
    public static EscrowContent Open(
        EscrowBundle bundle,
        EscrowIdentity identity,
        EscrowKeyResult answer,
        IEscrowKeyService keyService,
        string? trustedSignerPublicKey,
        EscrowOpenOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(bundle);
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(answer);
        ArgumentNullException.ThrowIfNull(keyService);
        options ??= new EscrowOpenOptions();
        Precheck(bundle, identity, trustedSignerPublicKey, options);
        if (answer.Valid && answer.OfflineGraceUntil is { } grace && answer.ExpiresAt is { } expires &&
            options.TimeProvider.GetUtcNow() >= (grace > expires ? grace : expires))
            throw new EscrowException(EscrowFailure.Revoked, "revoked:offline_grace_exhausted:the key answer is past its offline grace");
        return Finish(bundle, identity, answer, keyService, trustedSignerPublicKey, options);
    }

    /// <summary>Everything checked before a key is asked for or used: the signature, then the clear
    /// files. A bundle that fails here never causes a key request.</summary>
    private static void Precheck(EscrowBundle bundle, EscrowIdentity identity, string? trustedSignerPublicKey, EscrowOpenOptions options)
    {
        var (ok, reason) = bundle.Verify(trustedSignerPublicKey, identity.Backend);
        if (!ok) throw new EscrowException(EscrowFailure.Signature, "signature:" + reason);

        foreach (var edited in bundle.EditedClearFiles())
        {
            if (options.AllowEditedClearFile?.Invoke(edited) == true) continue;
            throw new EscrowException(EscrowFailure.DecryptFailed, $"decrypt_failed:clear file {EscrowPaths.Printable(edited)} is missing or tampered.");
        }
    }

    private static EscrowContent Finish(EscrowBundle bundle, EscrowIdentity identity, EscrowKeyResult grant,
        IEscrowKeyService keyService, string? trustedSignerPublicKey, EscrowOpenOptions options)
    {
        if (!grant.Valid || grant.WrappedKey is null)
        {
            throw grant.TransportError
                ? new EscrowException(EscrowFailure.KeyServiceUnreachable, "key_service_unreachable:" + (grant.Reason ?? "no_answer"))
                : new EscrowException(EscrowFailure.Refused, "refused:" + (grant.Reason ?? "no_key"));
        }
        if (CheckGrant(grant, bundle.Manifest, trustedSignerPublicKey) is { } mismatch) throw mismatch;

        IContentStore store = identity.Backend == EscrowBackend.Native
            ? NativeContentStore.Open(identity, bundle, grant.WrappedKey)
            : OpenManaged(identity, bundle, grant.WrappedKey);
        try { return new EscrowContent(bundle, store, identity, keyService, grant, options, trustedSignerPublicKey); }
        catch
        {
            store.Dispose();
            throw;
        }
    }

    /// <summary>What a valid answer must still satisfy before its key is used: it is for the release
    /// that was asked for, and, when the host pinned no signer, the release is signed by the key the
    /// service names for this licence. An answer that carries neither field passes (a key service
    /// that does not name them, a test double): the unwrap then decides, since a key is wrapped with
    /// the release identity as associated data.</summary>
    internal static EscrowException? CheckGrant(EscrowKeyResult grant, EscrowManifest manifest, string? trustedSignerPublicKey)
    {
        if (grant.Aad is not null && !string.Equals(grant.Aad, manifest.Aad, StringComparison.Ordinal))
            return new EscrowException(EscrowFailure.Refused, "refused:release_mismatch");
        if (trustedSignerPublicKey is null && grant.SignerPublicKey is not null &&
            !string.Equals(grant.SignerPublicKey, manifest.SignerPublicKey, StringComparison.Ordinal))
            return new EscrowException(EscrowFailure.Signature, "signature:the release signer is not the one the key service names for this licence");
        return null;
    }

    /// <inheritdoc cref="OpenAsync(ReadOnlyMemory{byte}, EscrowIdentity, IEscrowKeyService, string?, EscrowOpenOptions?, CancellationToken)"/>
    public static Task<EscrowContent> OpenAsync(byte[] bundle, EscrowIdentity identity, IEscrowKeyService keyService,
        string? trustedSignerPublicKey, EscrowOpenOptions? options = null, CancellationToken cancellation = default) =>
        OpenAsync(new ReadOnlyMemory<byte>(bundle ?? throw new ArgumentNullException(nameof(bundle))), identity, keyService, trustedSignerPublicKey, options, cancellation);

    /// <summary>The managed fallback: the content key and the plaintext are managed arrays here.</summary>
    private static ManagedContentStore OpenManaged(EscrowIdentity identity, EscrowBundle bundle, WrappedKey wrapped)
    {
        byte[] contentKey;
        try { contentKey = identity.UnwrapManaged(wrapped, Encoding.UTF8.GetBytes(bundle.Manifest.Aad)); }
        catch (CryptographicException e) { throw new EscrowException(EscrowFailure.UnwrapFailed, "unwrap_failed:" + e.Message, e); }
        try { return new ManagedContentStore(bundle.DecryptManaged(contentKey)); }
        catch (CryptographicException e) { throw new EscrowException(EscrowFailure.DecryptFailed, "decrypt_failed:" + e.Message, e); }
        catch (InvalidDataException e) { throw new EscrowException(EscrowFailure.InvalidBundle, "invalid_bundle:" + e.Message, e); }
        finally { CryptographicOperations.ZeroMemory(contentKey); }
    }
}

/// <summary>
/// The LICENSE-ONLY-GRADE FALLBACK for hosts that can only read resources from disk: writes a
/// decrypted release into a folder. The plaintext then sits on the operator's disk, so this gives no
/// code secrecy at all. What still holds is everything that does not depend on hiding the code: the
/// key was released only to a licensed, bound server; the release is signed; the copy carries the
/// delivery marker; and the next key request is refused after a revocation. Prefer
/// <see cref="EscrowContent.LoadLuaChunk"/> wherever the host can load from memory.
/// </summary>
public static class EscrowDiskFallback
{
    /// <summary>Writes every file of <paramref name="content"/> (clear files, decrypted files and the
    /// delivery marker) under <paramref name="directory"/>, replacing what is there. Returns the number
    /// of files written.</summary>
    public static int WriteTo(EscrowContent content, string directory)
    {
        ArgumentNullException.ThrowIfNull(content);
        var root = Path.GetFullPath(directory);
        var prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        Directory.CreateDirectory(root);
        var written = 0;

        void Write(string relative, byte[] bytes)
        {
            if (!EscrowPaths.IsSafe(relative)) throw new InvalidDataException("unsafe path: " + EscrowPaths.Printable(relative));
            var full = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
            if (!full.StartsWith(prefix, StringComparison.Ordinal)) throw new InvalidDataException("unsafe path: " + EscrowPaths.Printable(relative));
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllBytes(full, bytes);
            written++;
        }

        foreach (var (path, bytes) in content.ClearFiles) Write(path, bytes);
        foreach (var entry in content.EncryptedEntries) Write(entry.Path, content.ReadAllBytes(entry.Path));
        if (content.TryGetSize(EscrowFormat.DeliveryMarker, out _) && !content.ContainsEncrypted(EscrowFormat.DeliveryMarker))
            Write(EscrowFormat.DeliveryMarker, content.ReadAllBytes(EscrowFormat.DeliveryMarker));
        return written;
    }
}
