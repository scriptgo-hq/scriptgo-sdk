// Escrow for the SCRIPT//GO sandbox: opens an escrowed bundle with ScriptGo.Escrow (verify the
// signature, get the key released to this server, decrypt in libscriptgo) and mounts the result on
// the host's file provider. Lua scripts of the release are then compiled straight from native
// memory (EscrowResourceFiles is an INativeLuaChunks); JavaScript guests read through the managed
// door, because Jint takes managed source.
//
// Refuses on unlicensed / unbound / revoked / wrong-environment (a definitive key-service refusal),
// on a bad signature and on a wrong key. A transport error is reported distinctly
// (key_service_unreachable:...), so the caller can retry instead of treating it as a refusal.
using ScriptGo.Escrow;

namespace ScriptGo.Host;

/// <param name="Ok">The release is mounted.</param>
/// <param name="Reason">Why not, as ScriptGo.Escrow reports it (<c>refused:revoked</c>, <c>unwrap_failed:...</c>).</param>
/// <param name="ResourceRoot">The virtual root to pass to host.AddResource(root, checkFolderName: false).</param>
/// <param name="Content">The opened release: its lease, its watermark, its Revoked event. Dispose it
/// after stopping the resource; that wipes the decrypted files.</param>
public sealed record EscrowLoadResult(bool Ok, string? Reason, string? ResourceRoot, EscrowContent? Content = null)
{
    public static EscrowLoadResult Failure(string reason) => new(false, reason, null);
}

public static class EscrowLoader
{
    /// <summary>Opens an escrowed bundle and mounts it on <paramref name="files"/>.</summary>
    public static async Task<EscrowLoadResult> LoadAsync(
        byte[] bundle,
        EscrowResourceFiles files,
        EscrowIdentity identity,
        IEscrowKeyService keyService,
        string? trustedSignerPublicKey,
        EscrowOpenOptions? options = null,
        CancellationToken cancellation = default)
    {
        EscrowContent content;
        try { content = await EscrowSession.OpenAsync(bundle, identity, keyService, trustedSignerPublicKey, options, cancellation).ConfigureAwait(false); }
        catch (EscrowException e) { return EscrowLoadResult.Failure(e.Reason); }
        return new EscrowLoadResult(true, null, files.Mount(content), content);
    }

    /// <summary>
    /// Ties a started resource to its release's lease: starts the renewal loop, and when the lease
    /// ends for good (revoked, expired, refunded, unbound, or offline for longer than the grace) the
    /// resource is stopped on the host's next tick with the reason <c>escrow_revoked:...</c>. The
    /// decrypted files are wiped at that moment; the guest VM is closed by the stop.
    /// </summary>
    public static void BindLease(ScriptGoHost host, string resourceName, EscrowContent content, EscrowRenewalOptions? renewal = null)
    {
        content.Revoked += (_, e) => host.StopOnNextTick(resourceName, "escrow_revoked:" + e.Reason);
        content.StartRenewal(renewal);
    }
}
