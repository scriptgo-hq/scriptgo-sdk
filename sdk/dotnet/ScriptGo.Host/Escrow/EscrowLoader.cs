// The escrow loader for the .NET kit: given an escrowed bundle, it verifies the release signature,
// asks the key service for the content key wrapped to this server, unwraps and decrypts IN MEMORY,
// stamps the delivery watermark, and hands the plaintext file map to the host through
// EscrowResourceFiles — the host's normal local-resource path, never the KeraLua VM.
//
// Refuses on unlicensed / unbound / revoked / wrong-environment (a definitive key-service refusal)
// and on a bad signature or a wrong content key. A transport error is reported distinctly so the
// caller can apply the license layer's offline grace.
using System.Security.Cryptography;
using System.Text;

namespace ScriptGo.Host.Escrow;

/// <summary>What the master answers for a key request. A definitive refusal has Valid=false and a
/// reason (the license verify reasons); a transport failure sets TransportError.</summary>
public sealed record EscrowKeyResult
{
    public bool Valid { get; init; }
    public WrappedKey? WrappedKey { get; init; }
    /// <summary>Opaque per-delivery watermark token the master computed (traceability); may be null.</summary>
    public string? DeliveryWatermark { get; init; }
    public string? Reason { get; init; }
    /// <summary>The key endpoint was unreachable (4xx/5xx/network): apply offline grace, do not refuse.</summary>
    public bool TransportError { get; init; }

    public static EscrowKeyResult Granted(WrappedKey key, string? watermark = null) => new() { Valid = true, WrappedKey = key, DeliveryWatermark = watermark };
    public static EscrowKeyResult Refused(string reason) => new() { Valid = false, Reason = reason };
    public static EscrowKeyResult Unreachable(string reason) => new() { Valid = false, Reason = reason, TransportError = true };
}

/// <summary>The seam to the master's key-release endpoint (gated on the existing license verify).
/// The HTTP client is one implementation; tests inject a fake so the crypto path needs no network.</summary>
public interface IEscrowKeyService
{
    Task<EscrowKeyResult> RequestKeyAsync(EscrowManifest manifest, EscrowServerIdentity identity, CancellationToken cancellation = default);
}

public sealed record EscrowLoadResult(bool Ok, string? Reason, string? ResourceRoot)
{
    public static EscrowLoadResult Failure(string reason) => new(false, reason, null);
}

public static class EscrowLoader
{
    /// <summary>Loads an escrowed bundle and mounts the decrypted resource on <paramref name="files"/>.
    /// On success the returned ResourceRoot is a virtual root to pass to host.AddResource(..., checkFolderName:false).</summary>
    public static async Task<EscrowLoadResult> LoadAsync(
        byte[] bundle,
        EscrowResourceFiles files,
        EscrowServerIdentity identity,
        IEscrowKeyService keyService,
        string? trustedSignerPublicKey,
        CancellationToken cancellation = default)
    {
        EscrowBundle parsed;
        try { parsed = EscrowBundle.Read(bundle); }
        catch (Exception e) when (e is InvalidDataException or System.Text.Json.JsonException) { return EscrowLoadResult.Failure("invalid_bundle:" + e.Message); }

        var (ok, reason) = parsed.Verify(trustedSignerPublicKey);
        if (!ok) return EscrowLoadResult.Failure("signature:" + reason);

        EscrowKeyResult grant;
        try { grant = await keyService.RequestKeyAsync(parsed.Manifest, identity, cancellation).ConfigureAwait(false); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { return EscrowLoadResult.Failure("key_service_unreachable:" + e.Message); }
        if (!grant.Valid || grant.WrappedKey is null)
            return EscrowLoadResult.Failure((grant.TransportError ? "key_service_unreachable:" : "refused:") + (grant.Reason ?? "no_key"));

        var aad = Encoding.UTF8.GetBytes(parsed.Manifest.Aad);
        byte[] contentKey;
        try { contentKey = identity.Unwrap(grant.WrappedKey, aad); }
        catch (CryptographicException e) { return EscrowLoadResult.Failure("unwrap_failed:" + e.Message); }

        Dictionary<string, byte[]> decrypted;
        try { decrypted = parsed.Open(contentKey, trustedSignerPublicKey); }
        catch (CryptographicException e) { return EscrowLoadResult.Failure("decrypt_failed:" + e.Message); }
        finally { CryptographicOperations.ZeroMemory(contentKey); }

        if (grant.DeliveryWatermark is not null)
            decrypted[EscrowFormat.DeliveryMarker] = Encoding.UTF8.GetBytes(grant.DeliveryWatermark + "\n");

        var root = files.Mount(parsed.Manifest.Package, parsed.Manifest.Version, decrypted);
        return new EscrowLoadResult(true, null, root);
    }
}
