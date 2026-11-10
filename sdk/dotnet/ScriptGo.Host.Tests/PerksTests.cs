// Player perks (ADR-0038) in the .NET kit: a Lua guest runs the portable core's perks module
// (sdk/lua/scriptgo/perks.lua, embedded in the kit) over IHostHttp and IHostPlayers.Identifier.
// JavaScript and TypeScript guests do not have the capability yet, and are told so. The API here is a
// fake with the shapes of docs/spec/perks.md.
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;

namespace ScriptGo.Host.Tests;

[TestClass]
public sealed class PerksTests
{
    private const string Token = "sg_srv_dotnet_test";
    private const string Ada = "acct:ada-0003";

    /// <summary>A fake SCRIPT//GO API for one operator.</summary>
    private sealed class PerksApi : IHostHttp
    {
        public ConcurrentQueue<HttpRequestData> Seen { get; } = new();
        public Dictionary<string, Dictionary<string, long?>> Held { get; } = [];
        public List<(int Seq, string Kind, string Perk, string Player, string Reason, long? ExpiresAt)> Queue { get; } = [];
        public int Acked;

        private static string Iso(long unix) => DateTimeOffset.FromUnixTimeSeconds(unix).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        private static long Now => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        private static string Grace(long? expiresAt) => Iso(Math.Min(Now + 72 * 3600, expiresAt ?? long.MaxValue));

        public void Push(string kind, string player, string perk, long? expiresAt, string reason)
        {
            lock (Queue) Queue.Add((Queue.Count + 1, kind, perk, player, reason, expiresAt));
        }

        public async Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation)
        {
            Seen.Enqueue(request);
            await Task.Delay(5, cancellation).ConfigureAwait(false);
            var none = new Dictionary<string, string>();
            if (!request.Headers.TryGetValue("authorization", out var auth) || auth != "Bearer " + Token)
                return new HttpResponseData(401, none, "{\"error\":{\"code\":\"unknown_server_link\",\"message\":\"Unknown or revoked server link token.\"}}");
            var uri = new Uri(request.Url);
            using var body = JsonDocument.Parse(string.IsNullOrEmpty(request.Body) ? "{}" : request.Body);
            switch (uri.AbsolutePath)
            {
                case "/v1/perks/check":
                {
                    var player = body.RootElement.GetProperty("player").GetString()!;
                    var list = new List<object>();
                    lock (Held)
                    {
                        if (Held.TryGetValue(player, out var perks))
                            foreach (var p in perks)
                                list.Add(new { key = p.Key, status = "active", expiresAt = p.Value is { } e ? Iso(e) : null, offlineGraceUntil = Grace(p.Value) });
                    }
                    return new HttpResponseData(200, none, JsonSerializer.Serialize(new { player, perks = list, serverTime = Iso(Now) }));
                }
                case "/v1/perks/events":
                {
                    var after = Acked;
                    foreach (var part in uri.Query.TrimStart('?').Split('&'))
                        if (part.StartsWith("after=", StringComparison.Ordinal)) after = int.Parse(part[6..]);
                    var events = new List<object>();
                    var cursor = after;
                    lock (Queue)
                    {
                        foreach (var e in Queue.Where(e => e.Seq > after))
                        {
                            events.Add(new
                            {
                                seq = e.Seq, kind = e.Kind, perk = e.Perk, player = e.Player, reason = e.Reason, status = e.Kind == "removed" ? "refunded" : "active",
                                expiresAt = e.ExpiresAt is { } x ? Iso(x) : null, offlineGraceUntil = e.Kind == "removed" ? null : Grace(e.ExpiresAt), at = Iso(Now),
                            });
                            cursor = e.Seq;
                        }
                    }
                    return new HttpResponseData(200, none, JsonSerializer.Serialize(new { events, cursor, more = false, serverTime = Iso(Now) }));
                }
                case "/v1/perks/events/ack":
                    Acked = Math.Max(Acked, body.RootElement.GetProperty("upTo").GetInt32());
                    return new HttpResponseData(200, none, JsonSerializer.Serialize(new { acked = Acked }));
                case "/v1/perks/purchase-link":
                    return new HttpResponseData(201, none, JsonSerializer.Serialize(new { url = "https://web.test/perk/signed", expiresAt = Iso(Now + 900) }));
            }
            return new HttpResponseData(404, none, "{\"error\":{\"code\":\"not_found\"}}");
        }
    }

    private sealed class Accounts : IHostPlayers
    {
        public SortedDictionary<int, string> Online { get; } = [];
        public IReadOnlyList<int> List() => Online.Keys.ToList();
        public string? Name(int id) => Online.TryGetValue(id, out var n) ? n : null;
        public string? Identifier(int id) => Online.TryGetValue(id, out var n) ? $"acct:{n.ToLowerInvariant()}-{id:0000}" : null;
    }

    private sealed class Convars(Dictionary<string, SgValue> values) : IHostConfig
    {
        public SgValue? Get(string? resource, string key) => resource is null && values.TryGetValue(key, out var v) ? v : null;
    }

    private const string Script = """
        AddEventHandler("onPlayerConnected", function(player)
            local has, info = ScriptGo.perks.has(player, "vip")
            print("JOIN", player, has, type(info) == "table" and info.source or info)
        end)
        ScriptGo.perks.on("granted", function(player, key, info) print("GRANTED", player, key, info.identifier, info.reason) end)
        ScriptGo.perks.on("removed", function(player, key, info) print("REMOVED", player, key, info.reason) end)
        exports("link", function(player) return ScriptGo.perks.purchaseLink(player, "vip") end)
        print("PERKS", ScriptGo.capabilities.has("perks"))
        """;

    private static Sandbox Server(PerksApi api, Accounts players, string? token = Token)
    {
        var convars = new Dictionary<string, SgValue> { ["scriptgo_api"] = SgValue.Of("http://api.test"), ["scriptgo_perks_poll_seconds"] = SgValue.Of(1) };
        if (token is not null) convars["scriptgo_server_token"] = SgValue.Of(token);
        var sb = new Sandbox(configure: s =>
        {
            s.Http = api;
            s.Players = players;
            s.Config = new Convars(convars);
        });
        sb.Resource("shop", Sandbox.Manifest("shop", ["server/main.lua"], [], "capabilities { \"events\", \"players\", \"perks\" }\n"), ("server/main.lua", Script));
        return sb;
    }

    /// <summary>The perks module keeps wall-clock time: ticks the host while real time passes.</summary>
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
    public void LuaGuestAsksAtJoinWithTheHostIdentifier()
    {
        var api = new PerksApi();
        api.Held[Ada] = new Dictionary<string, long?> { ["vip"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30 * 86400 };
        var players = new Accounts();
        using var sb = Server(api, players);
        sb.Start("shop");
        CollectionAssert.Contains(sb.Printed, "PERKS\ttrue");
        CollectionAssert.Contains(sb.Host.Capabilities.ToList(), "perks");
        players.Online[3] = "Ada";
        sb.Host.PlayerJoin(3, "Ada");
        Assert.IsTrue(Until(sb, () => sb.Printed.Any(l => l.StartsWith("JOIN", StringComparison.Ordinal))), sb.Log.ToString());
        CollectionAssert.Contains(sb.Printed, "JOIN\t3\ttrue\tapi");
        var check = api.Seen.First(r => r.Url == "http://api.test/v1/perks/check");
        Assert.AreEqual("POST", check.Method);
        Assert.AreEqual("Bearer " + Token, check.Headers["authorization"]);
        using var body = JsonDocument.Parse(check.Body!);
        Assert.AreEqual(Ada, body.RootElement.GetProperty("player").GetString());
        Assert.AreEqual("dotnet", body.RootElement.GetProperty("environment").GetString());
    }

    [TestMethod]
    public void LuaGuestPullsEventsAndRunsHandlers()
    {
        var api = new PerksApi();
        var players = new Accounts();
        using var sb = Server(api, players);
        sb.Start("shop");
        players.Online[3] = "Ada";
        sb.Host.PlayerJoin(3, "Ada");
        Assert.IsTrue(Until(sb, () => sb.Printed.Contains("JOIN\t3\tfalse\tnot_held")), sb.Log.ToString());
        api.Push("granted", Ada, "vip", null, "purchase");
        Assert.IsTrue(Until(sb, () => sb.Printed.Contains($"GRANTED\t3\tvip\t{Ada}\tpurchase")), sb.Log.ToString());
        api.Push("removed", Ada, "vip", null, "refunded");
        Assert.IsTrue(Until(sb, () => sb.Printed.Contains("REMOVED\t3\tvip\trefunded")), sb.Log.ToString());
        Assert.IsTrue(Until(sb, () => api.Acked == 2, 3000), "acknowledged " + api.Acked);
        var link = sb.Host.CallExportSync("shop", "link", "server", 5000, SgValue.Of(3));
        Assert.IsTrue(link.Ok, link.Reason);
        Assert.AreEqual("https://web.test/perk/signed", link.Values[0].ToString());
    }

    [TestMethod]
    public void AnUnlinkedServerGetsNothing()
    {
        var api = new PerksApi();
        api.Held[Ada] = new Dictionary<string, long?> { ["vip"] = null };
        var players = new Accounts();
        using (var sb = Server(api, players, token: null))
        {
            sb.Start("shop");
            players.Online[3] = "Ada";
            sb.Host.PlayerJoin(3, "Ada");
            Assert.IsTrue(Until(sb, () => sb.Printed.Contains("JOIN\t3\tfalse\tnot_linked")), sb.Log.ToString());
            Until(sb, () => false, 1500);
            Assert.IsTrue(api.Seen.IsEmpty, "an unlinked server made a request");
        }
        using (var sb = Server(api, players, token: "sg_srv_another_operators"))
        {
            sb.Start("shop");
            sb.Host.PlayerJoin(3, "Ada");
            Assert.IsTrue(Until(sb, () => sb.Printed.Contains("JOIN\t3\tfalse\tnot_linked")), sb.Log.ToString());
        }
    }

    [TestMethod]
    public void JavaScriptGuestsDoNotHaveItAndSaySo()
    {
        using var sb = new Sandbox(configure: s => s.Http = new PerksApi());
        sb.Server("js_shop", ("server/main.js", """
            console.log("PERKS", ScriptGo.capabilities.has("perks"), ScriptGo.capabilities.list().includes("perks"));
            try { ScriptGo.perks.has(1, "vip"); } catch (e) { console.log("REFUSED", e.code); }
            """));
        sb.Start("js_shop");
        CollectionAssert.Contains(sb.Printed, "PERKS false false");
        CollectionAssert.Contains(sb.Printed, "REFUSED capability_unavailable:perks@dotnet");

        // A resource that requires perks and runs JavaScript on the server cannot start here.
        sb.Resource("js_needs", Sandbox.Manifest("js_needs", ["server/main.js"], [], "capabilities { \"perks\" }\n"), ("server/main.js", "console.log('never')"));
        sb.Host.AddResource(Path.Combine(sb.Root, "js_needs"));
        var r = sb.Host.Start("js_needs");
        Assert.IsFalse(r.Ok);
        Assert.AreEqual("capability_unavailable:perks@dotnet", r.Reason);
    }

    [TestMethod]
    public void WithoutHttpThereAreNoPerks()
    {
        using var sb = new Sandbox();
        CollectionAssert.DoesNotContain(sb.Host.Capabilities.ToList(), "perks");
        sb.Resource("shop", Sandbox.Manifest("shop", ["server/main.lua"], [], "capabilities { \"perks\" }\n"), ("server/main.lua", Script));
        sb.Host.AddResource(Path.Combine(sb.Root, "shop"));
        var r = sb.Host.Start("shop");
        Assert.IsFalse(r.Ok);
        Assert.AreEqual("capability_unavailable:perks@dotnet", r.Reason);

        // HTTP present but switched off by the integrator: perks goes with it.
        using var off = new Sandbox(new HostOptions { Capabilities = ["players", "perks"] }, s => s.Http = new PerksApi());
        CollectionAssert.DoesNotContain(off.Host.Capabilities.ToList(), "perks");
    }
}
