// The key-release seam and its production implementation.
//
// IEscrowKeyService is what a loader asks for a release's content key. HttpEscrowKeyService calls
// the SCRIPT//GO master (POST /v1/licenses/key) over TLS with the deployment token and the server's
// public key. A definitive refusal ({valid:false}) is returned as Refused; a 4xx/5xx or a network
// error is Unreachable, so the caller applies the offline grace of its last valid answer.
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ScriptGo.Escrow;

/// <summary>What the master answers for a key request. A definitive refusal has Valid=false and a
/// reason (the license verify reasons plus <c>unbound</c> and <c>not_escrowed</c>); a transport
/// failure sets <see cref="TransportError"/>.</summary>
public sealed record EscrowKeyResult
{
    public bool Valid { get; init; }
    public WrappedKey? WrappedKey { get; init; }
    /// <summary>Opaque per-delivery watermark token the master computed (traceability); may be null.</summary>
    public string? DeliveryWatermark { get; init; }
    public string? Reason { get; init; }
    /// <summary>The key endpoint was unreachable (4xx/5xx/network): apply offline grace, do not refuse.</summary>
    public bool TransportError { get; init; }
    /// <summary>When this answer stops being valid: the loader asks again before it.</summary>
    public DateTimeOffset? ExpiresAt { get; init; }
    /// <summary>The last instant the resource may keep running without a fresh valid answer.</summary>
    public DateTimeOffset? OfflineGraceUntil { get; init; }

    public static EscrowKeyResult Granted(WrappedKey key, string? watermark = null, DateTimeOffset? expiresAt = null, DateTimeOffset? offlineGraceUntil = null) =>
        new() { Valid = true, WrappedKey = key, DeliveryWatermark = watermark, ExpiresAt = expiresAt, OfflineGraceUntil = offlineGraceUntil };
    public static EscrowKeyResult Refused(string reason) => new() { Valid = false, Reason = reason };
    public static EscrowKeyResult Unreachable(string reason) => new() { Valid = false, Reason = reason, TransportError = true };
}

/// <summary>The seam to the key-release endpoint. <see cref="HttpEscrowKeyService"/> is the
/// production implementation; a host with its own licensing back end implements this instead, and
/// tests inject a fake so the crypto path needs no network.</summary>
public interface IEscrowKeyService
{
    /// <summary>Asks for the content key of <paramref name="manifest"/>'s release, wrapped to
    /// <paramref name="identity"/>'s public key. Called once to open a release and again on every renewal.</summary>
    Task<EscrowKeyResult> RequestKeyAsync(EscrowManifest manifest, EscrowIdentity identity, CancellationToken cancellation = default);
}

/// <summary>Calls <c>POST /v1/licenses/key</c> on the SCRIPT//GO master.</summary>
public sealed class HttpEscrowKeyService(HttpClient http, HttpEscrowKeyService.Options options) : IEscrowKeyService
{
    /// <param name="DeploymentToken">The server's deployment token (<c>sg_dep_...</c>). A secret: never log it.</param>
    /// <param name="Package">The package identifier (<c>creator//name</c>).</param>
    /// <param name="Environment">The environment slug the license must cover (for example <c>dotnet</c>).</param>
    /// <param name="AdapterVersion">Free text identifying the host, shown to the operator in their dashboard.</param>
    public sealed record Options(string DeploymentToken, string Package, string Environment, string? AdapterVersion = null);

    public async Task<EscrowKeyResult> RequestKeyAsync(EscrowManifest manifest, EscrowIdentity identity, CancellationToken cancellation = default)
    {
        var request = new KeyRequest(options.DeploymentToken, options.Package, ManifestVersion(manifest), options.Environment, options.AdapterVersion, identity.PublicKeyBase64Url);
        HttpResponseMessage response;
        try { response = await http.PostAsJsonAsync("/v1/licenses/key", request, cancellation).ConfigureAwait(false); }
        catch (HttpRequestException e) { return EscrowKeyResult.Unreachable("network:" + e.Message); }
        catch (TaskCanceledException e) when (!cancellation.IsCancellationRequested) { return EscrowKeyResult.Unreachable("timeout:" + e.Message); }

        using (response)
        {
            // 4xx/5xx mean the API could not answer; a definitive refusal is 200 {valid:false}.
            if (!response.IsSuccessStatusCode) return EscrowKeyResult.Unreachable($"http_{(int)response.StatusCode}");

            KeyResponse? body;
            try { body = await response.Content.ReadFromJsonAsync<KeyResponse>(cancellation).ConfigureAwait(false); }
            catch (JsonException e) { return EscrowKeyResult.Unreachable("bad_response:" + e.Message); }
            catch (HttpRequestException e) { return EscrowKeyResult.Unreachable("network:" + e.Message); }
            if (body is null) return EscrowKeyResult.Unreachable("empty_response");
            if (!body.Valid) return EscrowKeyResult.Refused(body.Reason ?? "refused");
            if (body.WrappedKey is null) return EscrowKeyResult.Unreachable("bad_response:no wrappedKey in a valid answer");
            return EscrowKeyResult.Granted(body.WrappedKey, body.DeliveryWatermark, body.ExpiresAt, body.OfflineGraceUntil);
        }
    }

    private static string ManifestVersion(EscrowManifest manifest)
    {
        var at = manifest.Aad.LastIndexOf('@');
        return at >= 0 ? manifest.Aad[(at + 1)..] : manifest.Version;
    }

    private sealed record KeyRequest(
        [property: JsonPropertyName("deploymentToken")] string DeploymentToken,
        [property: JsonPropertyName("package")] string Package,
        [property: JsonPropertyName("version")] string Version,
        [property: JsonPropertyName("environment")] string Environment,
        [property: JsonPropertyName("adapterVersion")] string? AdapterVersion,
        [property: JsonPropertyName("serverPublicKey")] string ServerPublicKey);

    private sealed record KeyResponse(
        [property: JsonPropertyName("valid")] bool Valid,
        [property: JsonPropertyName("reason")] string? Reason,
        [property: JsonPropertyName("wrappedKey")] WrappedKey? WrappedKey,
        [property: JsonPropertyName("signerPublicKey")] string? SignerPublicKey,
        [property: JsonPropertyName("deliveryWatermark")] string? DeliveryWatermark,
        [property: JsonPropertyName("offlineGraceUntil")] DateTimeOffset? OfflineGraceUntil,
        [property: JsonPropertyName("expiresAt")] DateTimeOffset? ExpiresAt);
}
