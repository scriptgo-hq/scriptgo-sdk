// The key-release seam and its production implementation.
//
// IEscrowKeyService is what a loader asks for a release's content key. HttpEscrowKeyService calls
// the SCRIPT//GO master (POST /v1/licenses/key) over TLS with the deployment token and the server's
// public key. A definitive refusal ({valid:false}) is returned as Refused; a 4xx/5xx or a network
// error is Unreachable, so the caller applies the offline grace of its last valid answer.
using System.Globalization;
using System.Net.Http.Headers;
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
    /// <summary>
    /// A refusal the key service marked <c>final</c>: the right to run has ended for good (revoked,
    /// refunded, expired, deactivated), so a running resource stops at once instead of running on to
    /// the end of its offline grace. Never set for an unreachable service: grace is for outages.
    /// </summary>
    public bool Final { get; init; }
    /// <summary>The release the key belongs to (<c>package@version</c>), when the service names it.
    /// A grant for another release than the one asked for is refused by the loader.</summary>
    public string? Aad { get; init; }
    /// <summary>The release signer the service knows for this licence, when it names one. With no
    /// signer pinned by the host, the manifest's signer must be this one.</summary>
    public string? SignerPublicKey { get; init; }
    /// <summary>When this answer stops being valid: the loader asks again before it.</summary>
    public DateTimeOffset? ExpiresAt { get; init; }
    /// <summary>The last instant the resource may keep running without a fresh valid answer.</summary>
    public DateTimeOffset? OfflineGraceUntil { get; init; }

    public static EscrowKeyResult Granted(WrappedKey key, string? watermark = null, DateTimeOffset? expiresAt = null, DateTimeOffset? offlineGraceUntil = null) =>
        new() { Valid = true, WrappedKey = key, DeliveryWatermark = watermark, ExpiresAt = expiresAt, OfflineGraceUntil = offlineGraceUntil };
    public static EscrowKeyResult Refused(string reason, bool final = false) => new() { Valid = false, Reason = reason, Final = final };
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

/// <summary>
/// Calls <c>POST /v1/licenses/key</c> on the SCRIPT//GO master. HTTP 200 with <c>valid:false</c> is
/// a definitive refusal; any other status, a transport error or a body that is not the documented
/// shape means the service could not answer. Nothing a remote host says reaches a caller's log
/// unbounded: reasons are reduced to short tokens and the body is read up to a fixed size.
/// </summary>
public sealed class HttpEscrowKeyService : IEscrowKeyService
{
    /// <summary>The largest answer read. A key answer is a few hundred bytes.</summary>
    public const int MaximumResponseBytes = 64 * 1024;

    private readonly HttpClient _http;
    private readonly Func<Options> _options;

    /// <param name="DeploymentToken">The server's deployment token (<c>sg_dep_...</c>). A secret: never log it.</param>
    /// <param name="Package">The package identifier (<c>creator//name</c>).</param>
    /// <param name="Environment">The environment slug the license must cover (for example <c>dotnet</c>).</param>
    /// <param name="AdapterVersion">Free text identifying the host, shown to the operator in their dashboard.</param>
    public sealed record Options(string DeploymentToken, string Package, string Environment, string? AdapterVersion = null)
    {
        // A record prints every member by default; this one holds a bearer secret.
        public override string ToString() =>
            $"Options {{ Package = {Package}, Environment = {Environment}, AdapterVersion = {AdapterVersion}, DeploymentToken = *** }}";
    }

    public HttpEscrowKeyService(HttpClient http, Options options) : this(http, () => options)
    {
        ArgumentNullException.ThrowIfNull(options);
    }

    /// <summary>For a host that reads its deployment token again for every request (a token file
    /// an operator may rotate): <paramref name="options"/> is called once per request. An exception
    /// it throws is answered as <c>Unreachable("token_unavailable")</c>.</summary>
    public HttpEscrowKeyService(HttpClient http, Func<Options> options)
    {
        ArgumentNullException.ThrowIfNull(http);
        ArgumentNullException.ThrowIfNull(options);
        _http = http;
        _options = options;
    }

    /// <summary>
    /// An <see cref="HttpClient"/> suited to the key endpoint: base address <paramref name="master"/>,
    /// no automatic redirects (the body carries a deployment token, and a redirect is how a token
    /// gets replayed to a host nobody configured), JSON accepted, a bounded timeout.
    /// </summary>
    public static HttpClient CreateClient(Uri master, string? userAgent = null, TimeSpan? timeout = null)
    {
        ArgumentNullException.ThrowIfNull(master);
        var client = new HttpClient(new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            ConnectTimeout = TimeSpan.FromSeconds(10),
        })
        {
            BaseAddress = master.AbsoluteUri.EndsWith('/') ? master : new Uri(master.AbsoluteUri + "/"),
            Timeout = timeout ?? TimeSpan.FromSeconds(15),
        };
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (!string.IsNullOrWhiteSpace(userAgent) && ProductInfoHeaderValue.TryParse(userAgent, out var product))
            client.DefaultRequestHeaders.UserAgent.Add(product);
        return client;
    }

    public async Task<EscrowKeyResult> RequestKeyAsync(EscrowManifest manifest, EscrowIdentity identity, CancellationToken cancellation = default)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(identity);
        Options options;
        try { options = _options() ?? throw new InvalidOperationException("no options"); }
        catch (Exception e) when (e is not OutOfMemoryException) { return EscrowKeyResult.Unreachable("token_unavailable"); }

        var request = new KeyRequest(options.DeploymentToken, options.Package, ManifestVersion(manifest), options.Environment, options.AdapterVersion, identity.PublicKeyBase64Url);
        try
        {
            // Relative to the client's base address, so a master mounted under a path
            // (https://host/scriptgo/) is reached there.
            using var message = new HttpRequestMessage(HttpMethod.Post, new Uri("v1/licenses/key", UriKind.Relative))
            {
                Content = JsonContent.Create(request),
            };
            using var response = await _http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellation).ConfigureAwait(false);
            // 4xx/5xx mean the API could not answer; a definitive refusal is 200 {valid:false}.
            if ((int)response.StatusCode != 200)
                return EscrowKeyResult.Unreachable("http_" + ((int)response.StatusCode).ToString(CultureInfo.InvariantCulture));
            var body = await ReadBoundedAsync(response, cancellation).ConfigureAwait(false);
            return body is null ? EscrowKeyResult.Unreachable("response_too_large") : Parse(body);
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { return EscrowKeyResult.Unreachable("timeout"); }
        // The type only: an exception message may quote the URL or a proxy's reply.
        catch (HttpRequestException) { return EscrowKeyResult.Unreachable("network"); }
        catch (IOException) { return EscrowKeyResult.Unreachable("network"); }
    }

    private static async Task<byte[]?> ReadBoundedAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(cancellation).ConfigureAwait(false);
        var buffer = new byte[MaximumResponseBytes + 1];
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(total), cancellation).ConfigureAwait(false);
            if (read == 0) break;
            total += read;
        }
        return total > MaximumResponseBytes ? null : buffer[..total];
    }

    /// <summary>Maps a response body (HTTP 200) to an answer. Public so a host with its own
    /// transport, and a test without a socket, can use the same reading of the contract.</summary>
    public static EscrowKeyResult Parse(ReadOnlyMemory<byte> body)
    {
        try
        {
            using var document = JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 16 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("valid", out var valid) ||
                valid.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return EscrowKeyResult.Unreachable("bad_response");
            if (valid.ValueKind == JsonValueKind.False)
                return EscrowKeyResult.Refused(Token(Text(root, "reason"), "refused"),
                    final: root.TryGetProperty("final", out var final) && final.ValueKind == JsonValueKind.True);
            if (!root.TryGetProperty("wrappedKey", out var wrapped) || wrapped.ValueKind != JsonValueKind.Object ||
                Bytes(wrapped, "epk", 32) is not { } epk || Bytes(wrapped, "nonce", 12) is not { } nonce ||
                Bytes(wrapped, "wrapped", 48) is not { } key)
                return EscrowKeyResult.Unreachable("bad_response");
            return new EscrowKeyResult
            {
                Valid = true,
                WrappedKey = new WrappedKey(epk, nonce, key),
                Aad = Text(root, "aad"),
                SignerPublicKey = Text(root, "signerPublicKey"),
                DeliveryWatermark = Text(root, "deliveryWatermark"),
                OfflineGraceUntil = Time(root, "offlineGraceUntil"),
                ExpiresAt = Time(root, "expiresAt"),
            };
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException) { return EscrowKeyResult.Unreachable("bad_response"); }
    }

    /// <summary>A remote reason reduced to a short token (letters, digits, <c>_ - . :</c>, at most
    /// 64 characters): it ends up in a log line and in a resource's error, and nothing a remote host
    /// says may shape either.</summary>
    public static string Token(string? value, string fallback)
    {
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        var clean = new string(value.Where(static c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.' or ':').Take(64).ToArray());
        return clean.Length == 0 ? fallback : clean;
    }

    private static string? Text(JsonElement parent, string name) =>
        parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String &&
        value.GetString() is { Length: <= 1024 } text ? text : null;

    /// <summary>A base64url field of an exact decoded length, returned as written; null otherwise.</summary>
    private static string? Bytes(JsonElement parent, string name, int length)
    {
        if (Text(parent, name) is not { } text) return null;
        try { return Base64Url.Decode(text).Length == length ? text : null; }
        catch (FormatException) { return null; }
    }

    private static DateTimeOffset? Time(JsonElement parent, string name) =>
        Text(parent, name) is { } text && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var time)
            ? time
            : null;

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
}
