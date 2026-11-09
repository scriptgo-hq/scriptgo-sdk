// The production IEscrowKeyService: calls the SCRIPT//GO master's key endpoint
// (POST /v1/licenses/key) over TLS with the deployment token and the server's public key, and maps
// the answer to an EscrowKeyResult. A definitive refusal ({valid:false}) is returned as Refused; a
// 4xx/5xx or a network error is Unreachable, so the caller applies the license layer's offline grace.
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ScriptGo.Host.Escrow;

public sealed class HttpEscrowKeyService(HttpClient http, HttpEscrowKeyService.Options options) : IEscrowKeyService
{
    public sealed record Options(string DeploymentToken, string Package, string Environment, string? AdapterVersion = null);

    public async Task<EscrowKeyResult> RequestKeyAsync(EscrowManifest manifest, EscrowServerIdentity identity, CancellationToken cancellation = default)
    {
        var request = new KeyRequest(options.DeploymentToken, options.Package, ManifestVersion(manifest), options.Environment, options.AdapterVersion, identity.PublicKeyBase64Url);
        HttpResponseMessage response;
        try { response = await http.PostAsJsonAsync("/v1/licenses/key", request, cancellation).ConfigureAwait(false); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { return EscrowKeyResult.Unreachable("network:" + e.Message); }

        // 4xx/5xx mean the API could not answer; a definitive refusal is 200 {valid:false}.
        if (!response.IsSuccessStatusCode) return EscrowKeyResult.Unreachable($"http_{(int)response.StatusCode}");

        KeyResponse? body;
        try { body = await response.Content.ReadFromJsonAsync<KeyResponse>(cancellation).ConfigureAwait(false); }
        catch (JsonException e) { return EscrowKeyResult.Unreachable("bad_response:" + e.Message); }
        if (body is null) return EscrowKeyResult.Unreachable("empty_response");
        if (!body.Valid || body.WrappedKey is null) return EscrowKeyResult.Refused(body.Reason ?? "refused");
        return EscrowKeyResult.Granted(body.WrappedKey, body.DeliveryWatermark);
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
        [property: JsonPropertyName("deliveryWatermark")] string? DeliveryWatermark);
}
