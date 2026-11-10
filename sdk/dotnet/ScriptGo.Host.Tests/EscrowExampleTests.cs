using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using ScriptGo.Escrow;

namespace ScriptGo.Host.Tests;

/// <summary>
/// The third-party example (sdk/examples/custom-adapter-dotnet, "Acme Engine") run as a real
/// process against a key endpoint over real HTTP: the path an integrator's end-to-end script takes.
/// Acme uses ScriptGo.Escrow only, with its own Lua sandbox.
/// </summary>
[TestClass]
public sealed class EscrowExampleTests
{
    /// <summary>A minimal key endpoint on loopback: POST /v1/licenses/key, answered as the master does.</summary>
    private sealed class KeyEndpoint : IDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private readonly EscrowVector _v = EscrowVector.Load();

        public string? Refuse { get; set; }
        public int Requests;
        public string Url { get; }

        public KeyEndpoint()
        {
            _listener.Start();
            Url = $"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}";
            _ = Task.Run(Serve);
        }

        private async Task Serve()
        {
            while (!_stop.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await _listener.AcceptTcpClientAsync(_stop.Token); }
                catch (Exception e) when (e is OperationCanceledException or SocketException or ObjectDisposedException) { return; }
                using (client)
                {
                    try { await Answer(client.GetStream()); }
                    catch (IOException) { }
                }
            }
        }

        private async Task Answer(NetworkStream stream)
        {
            // Read the headers, then the body: Content-Length bytes, or chunks (HttpClient sends JSON chunked).
            var buffer = new byte[64 * 1024];
            var read = 0;
            int headerEnd;
            while ((headerEnd = Encoding.ASCII.GetString(buffer, 0, read).IndexOf("\r\n\r\n", StringComparison.Ordinal)) < 0)
            {
                var n = await stream.ReadAsync(buffer.AsMemory(read));
                if (n == 0) return;
                read += n;
            }
            var head = Encoding.ASCII.GetString(buffer, 0, headerEnd);
            var bodyStart = headerEnd + 4;
            byte[] body;
            if (head.Contains("Transfer-Encoding: chunked", StringComparison.OrdinalIgnoreCase))
            {
                while (!Encoding.ASCII.GetString(buffer, bodyStart, read - bodyStart).EndsWith("0\r\n\r\n", StringComparison.Ordinal))
                {
                    var n = await stream.ReadAsync(buffer.AsMemory(read));
                    if (n == 0) return;
                    read += n;
                }
                using var joined = new MemoryStream();
                var at = bodyStart;
                while (true)
                {
                    var lineEnd = Array.IndexOf(buffer, (byte)'\n', at);
                    var size = Convert.ToInt32(Encoding.ASCII.GetString(buffer, at, lineEnd - at).Trim(), 16);
                    if (size == 0) break;
                    joined.Write(buffer, lineEnd + 1, size);
                    at = lineEnd + 1 + size + 2;
                }
                body = joined.ToArray();
            }
            else
            {
                var length = head.Split("\r\n").Select(l => l.Split(':', 2)).Where(p => p.Length == 2 && p[0].Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
                    .Select(p => int.Parse(p[1].Trim())).FirstOrDefault();
                while (read - bodyStart < length)
                {
                    var n = await stream.ReadAsync(buffer.AsMemory(read));
                    if (n == 0) return;
                    read += n;
                }
                body = buffer.AsSpan(bodyStart, length).ToArray();
            }
            using var request = JsonDocument.Parse(body);
            Interlocked.Increment(ref Requests);

            object answer;
            if (!head.StartsWith("POST /v1/licenses/key ", StringComparison.Ordinal)) answer = new { error = "not_found" };
            else if (Refuse is not null) answer = new { valid = false, reason = Refuse };
            else
            {
                // What the master does: wrap the release's content key to the key this server presented.
                var serverKey = Base64Url.Decode(request.RootElement.GetProperty("serverPublicKey").GetString()!);
                var wrapped = EscrowKit.Wrap(_v.ContentKey, serverKey, Encoding.UTF8.GetBytes(_v.aad));
                answer = new
                {
                    valid = true,
                    wrappedKey = new { epk = wrapped.Epk, nonce = wrapped.Nonce, wrapped = wrapped.Wrapped },
                    deliveryWatermark = "example-delivery",
                    expiresAt = DateTimeOffset.UtcNow.AddMinutes(15),
                    offlineGraceUntil = DateTimeOffset.UtcNow.AddHours(1),
                };
            }
            var json = JsonSerializer.SerializeToUtf8Bytes(answer);
            await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {json.Length}\r\nConnection: close\r\n\r\n"));
            await stream.WriteAsync(json);
        }

        public void Dispose()
        {
            _stop.Cancel();
            _listener.Stop();
        }
    }

    private static string AcmeExecutable()
    {
        // <repo>/sdk/dotnet/ScriptGo.Host.Tests/bin/<configuration>/net10.0/  ->  <repo>/sdk/examples/...
        var output = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        var configuration = output.Parent!.Name;
        var sdk = output.Parent!.Parent!.Parent!.Parent!.Parent!.FullName;
        var name = OperatingSystem.IsWindows() ? "acme-engine.exe" : "acme-engine";
        var path = Path.Combine(sdk, "examples", "custom-adapter-dotnet", "bin", configuration, output.Name, name);
        Assert.IsTrue(File.Exists(path), "the Acme example was not built next to the tests: " + path);
        return path;
    }

    private static async Task<(int ExitCode, string Output, string Error)> RunAcme(string master, string workDirectory, params string[] extra)
    {
        var v = EscrowVector.Load();
        var bundle = Path.Combine(workDirectory, "demo.escrow.zip");
        await File.WriteAllBytesAsync(bundle, v.Bundle);
        var start = new ProcessStartInfo(AcmeExecutable())
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in new[]
        {
            "--bundle", bundle, "--master", master, "--deployment-token", "sg_dep_example", "--package", v.package,
            "--environment", "acme", "--trusted-signer", v.signerPublicKeyB64Url, "--identity", Path.Combine(workDirectory, "acme.identity"),
        }.Concat(extra)) start.ArgumentList.Add(argument);

        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail("acme-engine did not exit within 60 seconds.");
        }
        return (process.ExitCode, await output, await error);
    }

    [TestMethod]
    public async Task AThirdPartyHostRunsAnEscrowedResourceEndToEndOverHttp()
    {
        EscrowKit.RequireNative();
        var work = Path.Combine(Path.GetTempPath(), "sg-escrow-example", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        using var endpoint = new KeyEndpoint();
        try
        {
            // First run: creates the server identity, gets the key released to it, runs the resource.
            var first = await RunAcme(endpoint.Url, work, "--once");
            Assert.AreEqual(0, first.ExitCode, first.Output + first.Error);
            StringAssert.Contains(first.Output, "(new identity)");
            StringAssert.Contains(first.Output, "[demo] escrow secret ok 42", "the decrypted entry script ran and required its escrowed module.");
            StringAssert.Contains(first.Output, "backend=native");
            StringAssert.Contains(first.Output, "managed copies=0", "Acme's sandbox loaded everything from native memory.");
            Assert.AreEqual(1, endpoint.Requests);

            // Second run: the identity persisted, so the same server asks again and runs again.
            var second = await RunAcme(endpoint.Url, work, "--once");
            Assert.AreEqual(0, second.ExitCode, second.Output + second.Error);
            Assert.IsFalse(second.Output.Contains("(new identity)"), "the identity must be loaded, not recreated.");
            var key = first.Output.Split('\n').First(l => l.Contains("server public key")).Trim().Split(' ')[4];
            StringAssert.Contains(second.Output, key, "the same server public key on every run.");

            // The identity file holds no raw key material an operator could copy to another account (Windows: DPAPI).
            Assert.IsTrue(File.ReadAllBytes(Path.Combine(work, "acme.identity")).AsSpan().StartsWith("SGIDENT1"u8));

            // A refused license: non-zero exit, the reason on stderr, nothing run.
            endpoint.Refuse = "revoked";
            var refused = await RunAcme(endpoint.Url, work, "--once");
            Assert.AreEqual(1, refused.ExitCode);
            StringAssert.Contains(refused.Error, "escrow refused: refused:revoked");
            Assert.IsFalse(refused.Output.Contains("escrow secret ok"));

            // An unreachable master is a different exit code: retry later, it is not a refusal.
            var closed = new TcpListener(IPAddress.Loopback, 0);
            closed.Start();
            var closedUrl = $"http://127.0.0.1:{((IPEndPoint)closed.LocalEndpoint).Port}";
            closed.Stop(); // a port nothing listens on
            var offline = await RunAcme(closedUrl, work, "--once");
            Assert.AreEqual(3, offline.ExitCode, offline.Error);
            StringAssert.Contains(offline.Error, "key_service_unreachable");
        }
        finally
        {
            try { Directory.Delete(work, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
