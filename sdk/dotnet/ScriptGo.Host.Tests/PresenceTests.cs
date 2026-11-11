// Player match (docs/spec/player-match.md) in the .NET kit: the Lua guest of the resource that declares
// presence runs the portable core's presence module (sdk/lua/scriptgo/presence.lua, embedded in the
// kit), with addresses from IHostPlayerAddresses and .NET's HMACSHA256. The API here is a fake with
// the shapes of the contract.
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ScriptGo.Host.Tests;

[TestClass]
public sealed class PresenceTests
{
    private const string Token = "sg_srv_dotnet_test";
    private const string Key = "pk_test_20261111";
    private const string Address = "203.0.113.9";

    private static string Fingerprint(string key, string message) =>
        Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(key), Encoding.UTF8.GetBytes(message))).ToLowerInvariant();

    private sealed class MatchApi : IHostHttp
    {
        public ConcurrentQueue<HttpRequestData> Seen { get; } = new();

        public async Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation)
        {
            Seen.Enqueue(request);
            await Task.Delay(5, cancellation).ConfigureAwait(false);
            var none = new Dictionary<string, string>();
            if (!request.Headers.TryGetValue("authorization", out var auth) || auth != "Bearer " + Token)
                return new HttpResponseData(401, none, "{\"error\":{\"code\":\"unknown_server_link\",\"message\":\"x\"}}");
            var path = new Uri(request.Url).AbsolutePath;
            if (request.Method == "POST" && path == "/v1/presence")
                return new HttpResponseData(200, none, JsonSerializer.Serialize(new { accepted = 0, presenceKey = Key, rotatesAt = "2099-01-01T00:00:00.000Z" }));
            if (request.Method == "DELETE" && path.StartsWith("/v1/presence/", StringComparison.Ordinal))
                return new HttpResponseData(200, none, "{\"removed\":true}");
            if (request.Method == "POST" && path == "/v1/identity/codes/confirm")
            {
                using var body = JsonDocument.Parse(request.Body!);
                return body.RootElement.GetProperty("code").GetString() == "K7-4QX"
                    ? new HttpResponseData(200, none, "{\"linked\":true}")
                    : new HttpResponseData(410, none, "{\"error\":{\"code\":\"code_used\",\"message\":\"x\"}}");
            }
            return new HttpResponseData(404, none, "{\"error\":{\"code\":\"not_found\"}}");
        }
    }

    private sealed class Accounts : IHostPlayers, IHostPlayerAddresses
    {
        public SortedDictionary<int, (string Name, string Address)> Online { get; } = [];
        public IReadOnlyList<int> List() => Online.Keys.ToList();
        public string? Name(int id) => Online.TryGetValue(id, out var n) ? n.Name : null;
        public string? Identifier(int id) => Online.TryGetValue(id, out var n) ? $"acct:{n.Name.ToLowerInvariant()}-{id:0000}" : null;
        public string? Address(int id) => Online.TryGetValue(id, out var n) ? n.Address : null;
    }

    private sealed class Notes : IHostUi
    {
        public List<(int Target, string Message)> Sent { get; } = [];
        public void Notify(int target, SgTable payload) => Sent.Add((target, payload.Get("message").ToString() ?? ""));
    }

    private sealed class Convars(Dictionary<string, SgValue> values) : IHostConfig
    {
        public SgValue? Get(string? resource, string key) => resource is null && values.TryGetValue(key, out var v) ? v : null;
    }

    private static Sandbox Server(MatchApi api, Accounts players, Notes ui, string capabilities = "\"events\", \"players\", \"presence\"")
    {
        var convars = new Dictionary<string, SgValue>
        {
            ["scriptgo_api"] = SgValue.Of("http://api.test"),
            ["scriptgo_server_token"] = SgValue.Of(Token),
            ["scriptgo_presence"] = SgValue.Of("true"),
            ["scriptgo_perks_poll_seconds"] = SgValue.Of(1),
        };
        var sb = new Sandbox(configure: s =>
        {
            s.Http = api;
            s.Players = players;
            s.Ui = ui;
            s.Config = new Convars(convars);
        });
        sb.Resource("match", Sandbox.Manifest("match", ["server/main.lua"], [], $"capabilities {{ {capabilities} }}\n"),
            ("server/main.lua", "print(\"PRESENCE\", ScriptGo.capabilities.has(\"presence\"))"));
        sb.Resource("other", Sandbox.Manifest("other", ["server/main.lua"], [], "capabilities { \"events\" }\n"), ("server/main.lua", "print(\"OTHER\")"));
        return sb;
    }

    private static bool Until(Sandbox sb, Func<bool> done, int timeoutMs = 8000)
    {
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs)
        {
            sb.Host.RunFor(100);
            if (done()) return true;
            Thread.Sleep(5);
        }
        return done();
    }

    [TestMethod]
    public void ReportsTheFingerprintNeverTheAddress()
    {
        var api = new MatchApi();
        var players = new Accounts();
        using var sb = Server(api, players, new Notes());
        sb.Start("match", "other");
        CollectionAssert.Contains(sb.Printed, "PRESENCE\ttrue");
        players.Online[3] = ("Ada", Address + ":30120");
        sb.Host.PlayerJoin(3, "Ada");
        var expected = Fingerprint(Key, Address);
        Assert.IsTrue(Until(sb, () => api.Seen.Any(r => r.Body?.Contains(expected, StringComparison.Ordinal) == true)), sb.Log.ToString());
        var report = api.Seen.First(r => r.Body?.Contains(expected, StringComparison.Ordinal) == true);
        using (var body = JsonDocument.Parse(report.Body!))
        {
            var entry = body.RootElement.GetProperty("players")[0];
            Assert.AreEqual("acct:ada-0003", entry.GetProperty("player").GetString());
            Assert.AreEqual("Ada", entry.GetProperty("name").GetString());
        }
        // One resource declares presence: the other one never reports.
        Assert.AreEqual(1, api.Seen.Count(r => r.Body?.Contains(expected, StringComparison.Ordinal) == true));
        Assert.IsFalse(api.Seen.Any(r => (r.Body ?? "").Contains(Address, StringComparison.Ordinal) || r.Url.Contains(Address, StringComparison.Ordinal)));
        Assert.IsFalse(sb.Log.Has(Address));

        players.Online.Remove(3);
        sb.Host.PlayerDrop(3);
        Assert.IsTrue(Until(sb, () => api.Seen.Any(r => r.Method == "DELETE")), sb.Log.ToString());
        Assert.AreEqual("http://api.test/v1/presence/acct%3Aada-0003", api.Seen.First(r => r.Method == "DELETE").Url);
    }

    [TestMethod]
    public void TheLinkCommandConfirmsTheCodeAndTellsThePlayer()
    {
        var api = new MatchApi();
        var players = new Accounts();
        var ui = new Notes();
        using var sb = Server(api, players, ui);
        sb.Start("match", "other");
        players.Online[3] = ("Ada", Address);
        sb.Host.PlayerJoin(3, "Ada");
        Assert.IsTrue(Until(sb, () => sb.Host.CommandList().Contains("link")), sb.Log.ToString());
        Assert.IsTrue(sb.Host.ExecuteCommand(3, "/link k7-4qx").Ok);
        Assert.IsTrue(Until(sb, () => ui.Sent.Count > 0), sb.Log.ToString());
        Assert.AreEqual((3, "Linked: you can go back to your browser."), ui.Sent[0]);
        var confirm = api.Seen.First(r => r.Url == "http://api.test/v1/identity/codes/confirm");
        using (var body = JsonDocument.Parse(confirm.Body!))
        {
            Assert.AreEqual("K7-4QX", body.RootElement.GetProperty("code").GetString());
            Assert.AreEqual("acct:ada-0003", body.RootElement.GetProperty("player").GetString());
        }
        Assert.IsTrue(sb.Host.ExecuteCommand(3, "link US-ED00").Ok);
        Assert.IsTrue(Until(sb, () => ui.Sent.Count > 1), sb.Log.ToString());
        StringAssert.StartsWith(ui.Sent[1].Message, "That code is not valid");
    }

    [TestMethod]
    public void JavaScriptGuestsDoNotHavePresence()
    {
        var api = new MatchApi();
        using var sb = Server(api, new Accounts(), new Notes());
        sb.Resource("jsmatch", Sandbox.Manifest("jsmatch", ["server/main.js"], [], "capabilities { \"presence\" }\n"), ("server/main.js", "console.log('x');"));
        sb.Host.AddResource(Path.Combine(sb.Root, "jsmatch"));
        var r = sb.Host.Start("jsmatch");
        Assert.IsFalse(r.Ok);
        Assert.AreEqual("capability_unavailable:presence@dotnet", r.Reason);
    }
}
