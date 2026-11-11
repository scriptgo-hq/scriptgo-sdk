// Player match (docs/spec/player-match.md) in the bridge: ScriptGo.presence and the link command are the
// portable core's presence module (sdk/lua/scriptgo/presence.lua). These tests check what the Rust side
// supplies to it: a player's connection address (IHostPlayerAddresses, which the plugin answers from
// net.connection.ipaddress) and HMAC-SHA256 from .NET's HMACSHA256. Same caveat as the rest of this
// suite: a plain .NET process with fake services, not a Rust server with a connected player.
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ScriptGo.Bridge;

internal static partial class Program
{
    private const string MatchToken = "sg_srv_rust_test";
    private const string MatchKey = "pk_test_20261111";

    private static void RunPresenceTests()
    {
        Test("presence.reports_the_fingerprint_never_the_address", PresenceReports);
        Test("presence.link_command_confirms_and_tells_the_player", PresenceLink);
        Test("presence.off_by_default", PresenceOffByDefault);
    }

    private sealed class MatchApi : IHostHttp
    {
        public readonly ConcurrentQueue<HttpRequestData> Seen = new();
        public Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation)
        {
            Seen.Enqueue(request);
            return Task.Run(async () =>
            {
                await Task.Delay(5);
                var none = new Dictionary<string, string>();
                if (!request.Headers.TryGetValue("authorization", out var auth) || auth != "Bearer " + MatchToken)
                    return new HttpResponseData(401, none, "{\"error\":{\"code\":\"unknown_server_link\",\"message\":\"x\"}}");
                var path = new Uri(request.Url).AbsolutePath;
                if (request.Method == "POST" && path == "/v1/presence")
                    return new HttpResponseData(200, none, JsonSerializer.Serialize(new { accepted = 0, presenceKey = MatchKey, rotatesAt = "2099-01-01T00:00:00.000Z" }));
                if (request.Method == "DELETE") return new HttpResponseData(200, none, "{\"removed\":true}");
                if (request.Method == "POST" && path == "/v1/identity/codes/confirm")
                {
                    using var body = JsonDocument.Parse(request.Body);
                    return body.RootElement.GetProperty("code").GetString() == "K7-4QX"
                        ? new HttpResponseData(200, none, "{\"linked\":true}")
                        : new HttpResponseData(410, none, "{\"error\":{\"code\":\"code_expired\",\"message\":\"x\"}}");
                }
                return new HttpResponseData(404, none, "{\"error\":{\"code\":\"not_found\"}}");
            });
        }
    }

    /// <summary>BasePlayer with a connection address, as the plugin's RustPlayers answers it.</summary>
    private sealed class AddressedPlayers : IHostPlayers, IHostPlayerAddresses
    {
        public readonly SortedDictionary<int, (string Name, string Address)> Online = new();
        public IReadOnlyList<int> List() => Online.Keys.ToList();
        public string Name(int id) => Online.TryGetValue(id, out var p) ? p.Name : null;
        public string Identifier(int id) => Online.ContainsKey(id) ? "steam:7656119800000000" + id : null;
        public string Address(int id) => Online.TryGetValue(id, out var p) ? p.Address : null;
    }

    private static Rig MatchRig(string set, MatchApi api, AddressedPlayers players, bool presence = true)
    {
        var dir = Fixture(set, "rt_match", "capabilities { \"events\", \"players\", \"presence\" }",
            "print(\"PRESENCE \" .. tostring(ScriptGo.capabilities.has(\"presence\")))");
        var rig = new Rig(realClock: true);
        rig.Services.Http = api;
        rig.Services.Players = players;
        rig.Config.Values["<convar>/scriptgo_api"] = "\"http://api.test\"";
        rig.Config.Values["<convar>/scriptgo_server_token"] = JsonSerializer.Serialize(MatchToken);
        if (presence) rig.Config.Values["<convar>/scriptgo_presence"] = "true";
        rig.Options.SearchDirs.Add(dir);
        rig.Boot();
        return rig;
    }

    private static string Hmac(string key, string message)
    {
        using var h = new HMACSHA256(Encoding.UTF8.GetBytes(key));
        return Convert.ToHexString(h.ComputeHash(Encoding.UTF8.GetBytes(message))).ToLowerInvariant();
    }

    private static bool Wait(Rig rig, Func<bool> done, int timeoutMs)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs)
        {
            rig.Runtime.Tick();
            if (done()) return true;
            Thread.Sleep(3);
        }
        return done();
    }

    private static void PresenceReports()
    {
        var api = new MatchApi();
        var players = new AddressedPlayers();
        using var rig = MatchRig("presence-report", api, players);
        Assert(rig.Log.Has("PRESENCE true"), rig.Log.Dump());
        players.Online[3] = ("Ada", "203.0.113.9:28015");
        rig.Runtime.PlayerJoin(3, "Ada");
        var fp = Hmac(MatchKey, "203.0.113.9");
        Assert(Wait(rig, () => api.Seen.Any(r => r.Body != null && r.Body.Contains(fp)), 5000), "no report:\n" + rig.Log.Dump());
        var report = api.Seen.First(r => r.Body != null && r.Body.Contains(fp));
        using (var body = JsonDocument.Parse(report.Body))
        {
            var entry = body.RootElement.GetProperty("players")[0];
            Assert(entry.GetProperty("player").GetString() == "steam:76561198000000003", report.Body);
            Assert(entry.GetProperty("name").GetString() == "Ada", report.Body);
        }
        Assert(!api.Seen.Any(r => (r.Body ?? "").Contains("203.0.113.9") || r.Url.Contains("203.0.113.9")), "the raw address left the bridge");
        Assert(!rig.Log.Has("203.0.113.9"), "the raw address was logged");
        players.Online.Remove(3);
        rig.Runtime.PlayerDrop(3, "left");
        Assert(Wait(rig, () => api.Seen.Any(r => r.Method == "DELETE"), 5000), "no removal:\n" + rig.Log.Dump());
        Assert(api.Seen.First(r => r.Method == "DELETE").Url == "http://api.test/v1/presence/steam%3A76561198000000003", "removal url");
    }

    private static void PresenceLink()
    {
        var api = new MatchApi();
        var players = new AddressedPlayers();
        using var rig = MatchRig("presence-link", api, players);
        players.Online[3] = ("Ada", "203.0.113.9");
        rig.Runtime.PlayerJoin(3, "Ada");
        Assert(Wait(rig, () => rig.Runtime.HasCommand("link"), 3000), "no link command:\n" + rig.Log.Dump());
        var r = rig.Runtime.ExecuteCommand(3, "/link k7-4qx");
        Assert(r.Ok, r.Reason);
        Assert(Wait(rig, () => rig.Ui.Sent.Count > 0, 5000), "the player was not told:\n" + rig.Log.Dump());
        Assert(rig.Ui.Sent[0].target == 3 && rig.Ui.Sent[0].n.Message == "Linked: you can go back to your browser.", rig.Ui.Sent[0].n.Message);
        var confirm = api.Seen.First(q => q.Url == "http://api.test/v1/identity/codes/confirm");
        using (var body = JsonDocument.Parse(confirm.Body))
            Assert(body.RootElement.GetProperty("player").GetString() == "steam:76561198000000003", confirm.Body);
        rig.Runtime.ExecuteCommand(3, "link OLD-123");
        Assert(Wait(rig, () => rig.Ui.Sent.Count > 1, 5000), "no refusal:\n" + rig.Log.Dump());
        Assert(rig.Ui.Sent[1].n.Message.StartsWith("That code is not valid", StringComparison.Ordinal), rig.Ui.Sent[1].n.Message);
    }

    private static void PresenceOffByDefault()
    {
        var api = new MatchApi();
        var players = new AddressedPlayers();
        using var rig = MatchRig("presence-off", api, players, presence: false);
        players.Online[3] = ("Ada", "203.0.113.9");
        rig.Runtime.PlayerJoin(3, "Ada");
        Wait(rig, () => false, 1500);
        Assert(!api.Seen.Any(r => r.Url.EndsWith("/v1/presence", StringComparison.Ordinal)), "reported while scriptgo_presence is off");
        // The link command does not depend on presence reporting: only on the server link.
        Assert(rig.Runtime.HasCommand("link"), "no link command");
    }
}
