// scriptgo-open77-escrow: the Option A loader (PROPOSAL.md). It decrypts a SCRIPT//GO escrow release
// in C# and writes it into an OPEN//77 resources root as a normal open77.lua resource, which the
// OPEN//77 server then discovers unchanged — no OPEN//77 core change.
//
//   scriptgo-open77-escrow --bundle <release>.escrow.zip --resources-root <server>/resources
//       --master https://api... --deployment-token sg_dep_... --package <creator//name>
//       --environment open77 [--trusted-signer <ed25519-pubkey-b64url>]
//       [--identity-file <path>]   (the server's X25519 identity; created on first run, kept secret)
//
// HONEST NOTE: on OPEN//77 the decrypted scripts must land in the operator's own resources directory
// (OPEN//77 reads scripts from disk), so code secrecy there is license-only-grade; binding,
// revocation, signing and traceability remain real. Option B keeps the plaintext in memory.
//
// The crypto is the ScriptGo.Escrow package: the identity's private key and the content key stay
// inside libscriptgo (native), and the identity file is sealed for this user (DPAPI on Windows, a
// 0600 file elsewhere). ScriptGo.Host is referenced only to read the resource name from the manifest.
using System.Security.Cryptography;
using System.Text.Json;
using ScriptGo.Escrow;
using ScriptGo.Host;

var options = ParseArgs(args);
if (options is null) return 2;

EscrowIdentity identity;
try { identity = LoadOrCreateIdentity(options.IdentityFile); }
catch (Exception e) when (e is EscrowException or CryptographicException or IOException)
{
    Console.Error.WriteLine($"cannot open the server identity: {e.Message}");
    return 1;
}
using var ownedIdentity = identity;
Console.WriteLine($"server public key: {identity.PublicKeyBase64Url}");

using var http = new HttpClient { BaseAddress = new Uri(options.Master) };
var keyService = new HttpEscrowKeyService(http, new HttpEscrowKeyService.Options(options.DeploymentToken, options.Package, options.Environment, "open77-escrow-loader/0.1.0"));

byte[] bundle;
try { bundle = await File.ReadAllBytesAsync(options.Bundle); }
catch (IOException e) { Console.Error.WriteLine($"cannot read bundle: {e.Message}"); return 1; }

var (ok, reason, dir) = await EscrowMaterializer.MaterializeAsync(bundle, options.ResourcesRoot, identity, keyService, options.TrustedSigner);
if (!ok)
{
    Console.Error.WriteLine($"escrow load refused: {reason}");
    // A transport error (offline) is distinct from a definitive refusal: the operator can retry.
    return reason?.StartsWith("key_service_unreachable", StringComparison.Ordinal) == true ? 3 : 1;
}
Console.WriteLine($"materialized -> {dir}");
Console.WriteLine("start the OPEN//77 server over this resources root to load the resource.");
return 0;

static Options? ParseArgs(string[] argv)
{
    var map = new Dictionary<string, string>(StringComparer.Ordinal);
    for (var i = 0; i < argv.Length - 1; i += 2)
        if (argv[i].StartsWith("--", StringComparison.Ordinal)) map[argv[i][2..]] = argv[i + 1];
    string? Req(string k)
    {
        if (map.TryGetValue(k, out var v)) return v;
        Console.Error.WriteLine($"missing --{k}");
        return null;
    }
    var bundle = Req("bundle");
    var root = Req("resources-root");
    var master = Req("master");
    var token = Req("deployment-token");
    var pkg = Req("package");
    var env = Req("environment");
    if (bundle is null || root is null || master is null || token is null || pkg is null || env is null) return null;
    return new Options(bundle, root, master, token, pkg, env,
        map.GetValueOrDefault("trusted-signer"),
        map.GetValueOrDefault("identity-file", Path.Combine(root, ".scriptgo-escrow-identity.json")));
}

static EscrowIdentity LoadOrCreateIdentity(string path)
{
    // Earlier versions of this runner kept the key pair as plain JSON. Such a file is read once,
    // rewritten in the sealed format, and the server keeps the public key its deployment knows.
    if (File.Exists(path) && File.ReadAllBytes(path) is [(byte)'{', ..])
    {
        var saved = JsonSerializer.Deserialize<LegacyIdentityFile>(File.ReadAllText(path))!;
        var privateKey = Convert.FromBase64String(saved.PrivateKey);
        try
        {
            var migrated = EscrowIdentity.ImportPrivateKey(privateKey);
            migrated.Save(path, replace: true);
            Console.WriteLine("identity file migrated to the sealed format.");
            return migrated;
        }
        finally { CryptographicOperations.ZeroMemory(privateKey); }
    }
    // The identity file is what binds this server. It is created on first run and never replaced.
    return EscrowIdentity.LoadOrCreate(path);
}

internal sealed record Options(string Bundle, string ResourcesRoot, string Master, string DeploymentToken, string Package, string Environment, string? TrustedSigner, string IdentityFile);
internal sealed record LegacyIdentityFile(string PrivateKey, string PublicKey);
