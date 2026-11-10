// acme-engine: a fictional third-party game server that runs an ESCROWED SCRIPT//GO resource in its
// own Lua sandbox. The whole SCRIPT//GO surface it uses is the ScriptGo.Escrow package:
//
//   EscrowIdentity.LoadOrCreate   this server's identity (private key stays in native memory)
//   HttpEscrowKeyService          POST /v1/licenses/key on the master
//   EscrowSession.OpenAsync       verify, get the key released to this server, decrypt natively
//   EscrowContent.LoadLuaChunk    compile a script into Acme's own lua_State
//   EscrowContent.StartRenewal    keep the license honest; Revoked stops the resource
//
//   acme-engine --bundle <release>.escrow.zip --master https://<master> --deployment-token sg_dep_...
//               --package <creator//name> --environment <slug> --trusted-signer <ed25519 key, base64url>
//               [--identity <file>] [--once] [--allow-managed-fallback]
//
//   --once   run the resource's server scripts, print their output, exit.
//   (none)   keep running: renew the key before it expires, stop the resource when it is revoked.
//
// Exit codes: 0 ran (or stopped by Ctrl+C); 1 refused or failed (the reason is on stderr);
//             2 bad command line; 3 the key service could not be reached (retry later);
//             4 the license ended while running (revoked, or unverifiable past the offline grace).
//
// Escrow is deterrence, traceability and revocation. The operator of this server could still
// recover a running resource from their own process; nothing here pretends otherwise.
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Acme.Engine;
using KeraLua;
using ScriptGo.Escrow;

var options = Options.Parse(args);
if (options is null) return 2;

// ---- 1. This server's identity ------------------------------------------------------------------
EscrowIdentity identity;
try { identity = EscrowIdentity.LoadOrCreate(options.Identity, allowManagedFallback: options.AllowManagedFallback); }
catch (Exception e) when (e is EscrowException or CryptographicException or IOException)
{
    Console.Error.WriteLine($"acme: cannot open the server identity: {e.Message}");
    return 1;
}
using var ownedIdentity = identity;
Console.WriteLine($"acme: server public key {identity.PublicKeyBase64Url}{(identity.Created ? " (new identity)" : "")}");
if (identity.Backend == EscrowBackend.Managed)
    Console.WriteLine("acme: WARNING: managed fallback in use. Keys and plaintext are in managed memory: weaker against memory inspection.");

// ---- 2. Open the release: verify, ask the master for the key, decrypt in native memory ----------
byte[] bundle;
try { bundle = await File.ReadAllBytesAsync(options.Bundle); }
catch (IOException e)
{
    Console.Error.WriteLine($"acme: cannot read the bundle: {e.Message}");
    return 1;
}

using var http = new HttpClient { BaseAddress = new Uri(options.Master), Timeout = TimeSpan.FromSeconds(15) };
var keys = new HttpEscrowKeyService(http, new HttpEscrowKeyService.Options(options.DeploymentToken, options.Package, options.Environment, "acme-engine/0.1.0"));

EscrowContent content;
try { content = await EscrowSession.OpenAsync(bundle, identity, keys, options.TrustedSigner); }
catch (EscrowException e)
{
    // The reason is a stable token: refused:revoked, unwrap_failed:..., signature:bad signature, ...
    Console.Error.WriteLine($"acme: escrow refused: {e.Reason}");
    return e.IsTransient ? 3 : 1;
}
using var ownedContent = content;

// ---- 3. Acme reads the resource's manifest (a clear file) to learn what to run ------------------
var resource = AcmeManifest.Read(content);
if (resource is null)
{
    Console.Error.WriteLine("acme: the release has no scriptgo.lua / scriptgo.json manifest Acme can read.");
    return 1;
}
var scripts = resource.ServerScripts.Where(s => s.EndsWith(".lua", StringComparison.Ordinal)).ToList();
if (scripts.Count == 0)
{
    Console.Error.WriteLine("acme: the release declares no Lua server script (Acme runs Lua only).");
    return 1;
}

// ---- 4. Run it in Acme's own sandbox, straight from native memory -------------------------------
var loader = LuaChunkLoader.FromLibraryName("lua54", typeof(Lua).Assembly); // Acme's own Lua library
using var sandbox = new AcmeSandbox(resource.Name, content, loader, (level, message) =>
{
    var line = $"[{resource.Name}] {message}";
    if (level == "error") Console.Error.WriteLine(line); else Console.WriteLine(line);
});
foreach (var script in scripts)
{
    var (ok, error) = sandbox.RunScript(script);
    if (ok) continue;
    Console.Error.WriteLine($"acme: {resource.Name} failed to start: {error}");
    return 1;
}
sandbox.Emit("start", resource.Name);
Console.WriteLine($"acme: started {resource.Name} {resource.Version} " +
    $"(backend={content.Backend.ToString().ToLowerInvariant()}, encrypted files={content.EncryptedEntries.Count}, " +
    // On the native backend this must stay 0: no script was ever copied into managed memory.
    (content.Backend == EscrowBackend.Native ? $"managed copies={content.ManagedCopies})" : "plaintext held in managed memory)"));

if (options.Once) return 0;

// ---- 5. Keep running: renew before the key expires, stop when the license ends -------------------
string? revoked = null;
using var stop = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };
// Revoked is raised on the renewal task: only record it here, and act on Acme's main loop below.
content.Revoked += (_, e) => { Volatile.Write(ref revoked, e.Reason); stop.Cancel(); };
content.StartRenewal(new EscrowRenewalOptions
{
    OnRenewal = r => Console.WriteLine($"acme: license check -> {r.State.ToString().ToLowerInvariant()}" +
        (r.Reason is null ? $", valid until {r.ExpiresAt:u}" : $" ({r.Reason}), grace until {r.OfflineGraceUntil:u}")),
});
Console.WriteLine($"acme: running; key valid until {content.ExpiresAt:u}, offline grace until {content.OfflineGraceUntil:u}. Ctrl+C stops.");

var tick = 0;
while (!stop.IsCancellationRequested)
{
    sandbox.Emit("tick", (++tick).ToString());
    try { await Task.Delay(TimeSpan.FromSeconds(1), stop.Token); }
    catch (OperationCanceledException) { }
}

var reason = Volatile.Read(ref revoked);
sandbox.Emit("stop", reason ?? "shutdown");
sandbox.Dispose(); // closing the Lua state releases the resource's compiled code
if (reason is null)
{
    Console.WriteLine("acme: stopped.");
    return 0;
}
// Two different endings: the license said no, or nobody could be asked for longer than the grace.
var why = reason.StartsWith("offline_grace_exhausted", StringComparison.Ordinal)
    ? "the license could not be re-verified before offline grace ran out"
    : "the license was revoked";
Console.Error.WriteLine($"acme: {resource.Name} stopped: {why} ({reason}). The decrypted files were wiped.");
return 4;

// ---------------------------------------------------------------------------------------------------

internal sealed record Options(
    string Bundle, string Master, string DeploymentToken, string Package, string Environment,
    string? TrustedSigner, string Identity, bool Once, bool AllowManagedFallback)
{
    private static readonly string[] Flags = ["once", "allow-managed-fallback"];

    public static Options? Parse(string[] argv)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var flags = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < argv.Length; i++)
        {
            if (!argv[i].StartsWith("--", StringComparison.Ordinal)) return Usage($"unexpected argument {argv[i]}");
            var name = argv[i][2..];
            if (Flags.Contains(name)) flags.Add(name);
            else if (i + 1 < argv.Length) values[name] = argv[++i];
            else return Usage($"--{name} needs a value");
        }
        string? Required(string name) => values.TryGetValue(name, out var v) ? v : null;
        var missing = new[] { "bundle", "master", "deployment-token", "package", "environment" }.Where(n => Required(n) is null).ToList();
        if (missing.Count > 0) return Usage("missing " + string.Join(", ", missing.Select(m => "--" + m)));
        if (!values.ContainsKey("trusted-signer"))
            Console.WriteLine("acme: WARNING: no --trusted-signer: the release signature proves integrity only, not who signed it.");
        return new Options(values["bundle"], values["master"], values["deployment-token"], values["package"], values["environment"],
            values.GetValueOrDefault("trusted-signer"),
            values.GetValueOrDefault("identity", Path.Combine(AppContext.BaseDirectory, "acme.scriptgo.identity")),
            flags.Contains("once"), flags.Contains("allow-managed-fallback"));
    }

    private static Options? Usage(string problem)
    {
        Console.Error.WriteLine($"acme: {problem}");
        Console.Error.WriteLine("usage: acme-engine --bundle <file> --master <url> --deployment-token <token> --package <creator//name> " +
            "--environment <slug> [--trusted-signer <key>] [--identity <file>] [--once] [--allow-managed-fallback]");
        return null;
    }
}

/// <summary>What Acme needs from the resource manifest: a name, a version, the server scripts.
/// Acme has its own reader on purpose: a third-party host does not need SCRIPT//GO's parser, only
/// the documented format (docs/spec/manifest.md). It reads the common forms and nothing more.</summary>
internal sealed partial record AcmeManifest(string Name, string Version, IReadOnlyList<string> ServerScripts)
{
    public static AcmeManifest? Read(EscrowContent content)
    {
        if (content.ClearFiles.TryGetValue("scriptgo.json", out var json))
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;
            var scripts = new List<string>();
            foreach (var key in new[] { "shared_scripts", "server_scripts" })
                if (root.TryGetProperty(key, out var list) && list.ValueKind == System.Text.Json.JsonValueKind.Array)
                    scripts.AddRange(list.EnumerateArray().Select(s => s.GetString()!).Where(s => s is not null));
            return new AcmeManifest(root.GetProperty("resource").GetString()!, root.GetProperty("version").GetString() ?? "0.0.0", scripts);
        }
        foreach (var file in new[] { "scriptgo.lua", "open77.lua" })
        {
            if (!content.ClearFiles.TryGetValue(file, out var lua)) continue;
            var text = LineComment().Replace(Encoding.UTF8.GetString(lua), "");
            var name = Scalar(text, "resource") ?? Scalar(text, "name");
            if (name is null) return null;
            var scripts = Strings(text, "shared_scripts?").Concat(Strings(text, "server_scripts?")).ToList();
            return new AcmeManifest(name, Scalar(text, "version") ?? "0.0.0", scripts);
        }
        return null;
    }

    private static string? Scalar(string text, string directive) => Strings(text, directive).FirstOrDefault();

    // directive "x" | directive("x") | directive { "a", "b" }
    private static IEnumerable<string> Strings(string text, string directive)
    {
        foreach (Match match in Regex.Matches(text, $@"(?m)^\s*{directive}\s*\(?\s*(\{{[^}}]*\}}|""[^""]*""|'[^']*')"))
            foreach (Match value in Regex.Matches(match.Groups[1].Value, @"""([^""]*)""|'([^']*)'"))
                yield return value.Groups[1].Success ? value.Groups[1].Value : value.Groups[2].Value;
    }

    [GeneratedRegex(@"--[^\n]*")]
    private static partial Regex LineComment();
}
