// scriptgo-host-escrow: the same escrowed resource as ../custom-adapter-dotnet, this time in the full
// SCRIPT//GO sandbox (ScriptGo.Host: events, exports, quotas, Lua and JavaScript guests). The host
// does the wiring Acme did by hand:
//
//   EscrowLoader.LoadAsync     opens the release and mounts it on the host's file provider
//   EscrowResourceFiles        compiles Lua scripts from native memory (no managed plaintext);
//                              JavaScript guests read through the managed door (Jint takes
//                              managed source), which is the weaker path and is counted
//   EscrowLoader.BindLease     renews the key and stops the resource when the license ends
//
//   scriptgo-host-escrow --bundle <release>.escrow.zip --master https://<master> --deployment-token sg_dep_...
//                        --package <creator//name> --environment <slug> --trusted-signer <key>
//                        [--identity <file>] [--once]
//
// Exit codes: 0 ran; 1 refused or failed (reason on stderr); 2 bad command line;
//             3 key service unreachable; 4 the license ended while running.
using System.Security.Cryptography;
using ScriptGo.Escrow;
using ScriptGo.Host;

var values = new Dictionary<string, string>(StringComparer.Ordinal);
var once = false;
for (var i = 0; i < args.Length; i++)
{
    if (args[i] == "--once") once = true;
    else if (args[i].StartsWith("--", StringComparison.Ordinal) && i + 1 < args.Length) values[args[i][2..]] = args[++i];
}
var missing = new[] { "bundle", "master", "deployment-token", "package", "environment" }.Where(n => !values.ContainsKey(n)).ToList();
if (missing.Count > 0)
{
    Console.Error.WriteLine("missing " + string.Join(", ", missing.Select(m => "--" + m)));
    Console.Error.WriteLine("usage: scriptgo-host-escrow --bundle <file> --master <url> --deployment-token <token> --package <creator//name> --environment <slug> [--trusted-signer <key>] [--identity <file>] [--once]");
    return 2;
}

EscrowIdentity identity;
try { identity = EscrowIdentity.LoadOrCreate(values.GetValueOrDefault("identity", Path.Combine(AppContext.BaseDirectory, "host.scriptgo.identity"))); }
catch (Exception e) when (e is EscrowException or CryptographicException or IOException)
{
    Console.Error.WriteLine($"cannot open the server identity: {e.Message}");
    return 1;
}
using var ownedIdentity = identity;
Console.WriteLine($"server public key {identity.PublicKeyBase64Url}");

using var http = new HttpClient { BaseAddress = new Uri(values["master"]), Timeout = TimeSpan.FromSeconds(15) };
var keys = new HttpEscrowKeyService(http, new HttpEscrowKeyService.Options(values["deployment-token"], values["package"], values["environment"], "scriptgo-host-escrow/0.1.0"));

// The host's file provider: escrow releases from memory, everything else from folders on disk.
var files = new EscrowResourceFiles();
using var host = new ScriptGoHost(new HostServices { Files = files, Log = new ConsoleLog() }, new HostOptions { Environment = values["environment"] });

var loaded = await EscrowLoader.LoadAsync(await File.ReadAllBytesAsync(values["bundle"]), files, identity, keys, values.GetValueOrDefault("trusted-signer"));
if (!loaded.Ok)
{
    Console.Error.WriteLine($"escrow refused: {loaded.Reason}");
    return loaded.Reason!.StartsWith("key_service_unreachable", StringComparison.Ordinal) ? 3 : 1;
}
using var content = loaded.Content!;

var name = host.AddResource(loaded.ResourceRoot!, checkFolderName: false);
var started = host.Start(name);
if (!started.Ok)
{
    Console.Error.WriteLine($"{name} failed to start: {started.Reason}");
    return 1;
}
host.RunFor(50);
Console.WriteLine($"started {name} (backend={content.Backend.ToString().ToLowerInvariant()}, managed copies={content.ManagedCopies})");
if (once)
{
    host.StopAll();
    return 0;
}

// Renew in the background; on revocation the stop is queued and applied by host.Tick() below.
EscrowLoader.BindLease(host, name, content);
using var stop = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };
while (!stop.IsCancellationRequested && host.ResourceState(name) == "started")
{
    host.Tick();
    await Task.Delay(50);
}
if (content.State == EscrowLeaseState.Revoked)
{
    Console.Error.WriteLine($"{name} stopped: the license ended ({content.RevocationReason}).");
    return 4;
}
host.StopAll();
return 0;
