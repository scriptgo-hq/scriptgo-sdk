// Player perks (ADR-0038) in the bridge: ScriptGo.perks is the portable core's module
// (sdk/lua/scriptgo/perks.lua), which the bridge embeds with the rest of the core. These tests check
// what the Rust side supplies to it: the plugin's web requests, the Steam identifier of a player, the
// convars and the data files. Same caveat as the rest of this suite: a plain .NET process with fake
// services, not a Rust server. The API here is a fake with the shapes of docs/spec/perks.md.
using System.Collections.Concurrent;
using System.Text.Json;
using ScriptGo.Bridge;

internal static partial class Program
{
    private const string PerksToken = "sg_srv_rust_test";
    private const string Ada = "steam:76561198000000003";

    private static void RunPerksTests()
    {
        Test("perks.asked_at_join_with_the_steam_identifier", PerksAskedAtJoin);
        Test("perks.events_pulled_applied_acknowledged", PerksEvents);
        Test("perks.cache_survives_restart_in_data_files", PerksCacheAcrossRestart);
        Test("perks.unlinked_server_gets_nothing", PerksUnlinked);
        Test("perks.capability_needs_http", PerksNeedsHttp);
    }

    /// <summary>A fake SCRIPT//GO API for one operator, behind the plugin's web requests.</summary>
    private sealed class PerksApi : IHostHttp
    {
        public readonly ConcurrentQueue<HttpRequestData> Seen = new();
        public readonly Dictionary<string, Dictionary<string, long?>> Held = new();
        public readonly List<(int seq, string kind, string perk, string player, string reason, long? expiresAt)> Queue = new();
        public int Acked;
        public volatile bool Down;

        private static string Iso(long unix) => DateTimeOffset.FromUnixTimeSeconds(unix).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        private static long Now => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        private static string Grace(long? expiresAt) => Iso(Math.Min(Now + 72 * 3600, expiresAt ?? long.MaxValue));

        public void Push(string kind, string player, string perk, long? expiresAt, string reason)
        {
            lock (Queue) Queue.Add((Queue.Count + 1, kind, perk, player, reason, expiresAt));
        }

        public Task<HttpResponseData> SendAsync(HttpRequestData request, CancellationToken cancellation)
        {
            Seen.Enqueue(request);
            return Task.Run(async () =>
            {
                await Task.Delay(5);
                if (Down) throw new HttpRequestException("connection refused");
                return Answer(request);
            });
        }

        private HttpResponseData Answer(HttpRequestData request)
        {
            var none = new Dictionary<string, string>();
            if (!request.Headers.TryGetValue("authorization", out var auth) || auth != "Bearer " + PerksToken)
                return new HttpResponseData(401, none, "{\"error\":{\"code\":\"unknown_server_link\",\"message\":\"Unknown or revoked server link token.\"}}");
            var uri = new Uri(request.Url);
            using var body = JsonDocument.Parse(string.IsNullOrEmpty(request.Body) ? "{}" : request.Body);
            switch (uri.AbsolutePath)
            {
                case "/v1/perks/check":
                {
                    var player = body.RootElement.GetProperty("player").GetString();
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
                        foreach (var e in Queue.Where(e => e.seq > after))
                        {
                            events.Add(new
                            {
                                e.seq, e.kind, e.perk, e.player, e.reason, status = e.kind == "removed" ? "refunded" : "active",
                                expiresAt = e.expiresAt is { } x ? Iso(x) : null, offlineGraceUntil = e.kind == "removed" ? null : Grace(e.expiresAt), at = Iso(Now),
                            });
                            cursor = e.seq;
                        }
                    }
                    return new HttpResponseData(200, none, JsonSerializer.Serialize(new { events, cursor, more = false, serverTime = Iso(Now) }));
                }
                case "/v1/perks/events/ack":
                    Acked = Math.Max(Acked, body.RootElement.GetProperty("upTo").GetInt32());
                    return new HttpResponseData(200, none, JsonSerializer.Serialize(new { acked = Acked }));
            }
            return new HttpResponseData(404, none, "{\"error\":{\"code\":\"not_found\"}}");
        }
    }

    private const string PerksScript = """
        AddEventHandler("onPlayerConnected", function(player)
            local has, info = ScriptGo.perks.has(player, "vip")
            print("JOIN " .. player .. " " .. tostring(has) .. " " .. tostring(type(info) == "table" and info.source or info))
        end)
        ScriptGo.perks.on("granted", function(player, key, info)
            print("GRANTED " .. tostring(player) .. " " .. key .. " " .. info.identifier .. " " .. tostring(info.reason))
        end)
        ScriptGo.perks.on("removed", function(player, key, info)
            print("REMOVED " .. tostring(player) .. " " .. key .. " " .. tostring(info.reason))
        end)
        print("PERKS " .. tostring(ScriptGo.capabilities.has("perks")))
        """;

    private static Rig PerksRig(string set, PerksApi api, string token = PerksToken, IHostStorage storage = null)
    {
        var dir = Fixture(set, "rt_perks", "capabilities { \"events\", \"players\", \"perks\" }", PerksScript);
        var rig = new Rig(realClock: true);
        rig.Services.Http = api;
        if (storage != null) rig.Services.Storage = storage;
        rig.Config.Values["<convar>/scriptgo_api"] = "\"http://api.test\"";
        if (token != null) rig.Config.Values["<convar>/scriptgo_server_token"] = JsonSerializer.Serialize(token);
        rig.Config.Values["<convar>/scriptgo_perks_poll_seconds"] = "1";
        rig.Options.SearchDirs.Add(dir);
        rig.Players.Online[3] = "Ada";
        rig.Boot();
        return rig;
    }

    private static void PerksAskedAtJoin()
    {
        var api = new PerksApi();
        api.Held[Ada] = new Dictionary<string, long?> { ["vip"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30 * 86400 };
        using var rig = PerksRig("perks-join", api);
        Assert(rig.Log.Has("PERKS true"), rig.Log.Dump());
        rig.Runtime.PlayerJoin(3, "Ada");
        Assert(rig.RunUntil("JOIN 3", 5000), "no answer:\n" + rig.Log.Dump());
        Assert(rig.Log.Has("JOIN 3 true api"), rig.Log.Dump());
        var check = api.Seen.FirstOrDefault(r => r.Url == "http://api.test/v1/perks/check");
        Assert(check != null && check.Method == "POST", "no check request");
        Assert(check.Headers.TryGetValue("authorization", out var auth) && auth == "Bearer " + PerksToken, "no bearer token");
        using var body = JsonDocument.Parse(check.Body);
        Assert(body.RootElement.GetProperty("player").GetString() == Ada, check.Body);
        Assert(body.RootElement.GetProperty("environment").GetString() == "rust", check.Body);
    }

    private static void PerksEvents()
    {
        var api = new PerksApi();
        using var rig = PerksRig("perks-events", api);
        rig.Runtime.PlayerJoin(3, "Ada");
        Assert(rig.RunUntil("JOIN 3", 5000), "no answer:\n" + rig.Log.Dump());
        Assert(rig.Log.Has("JOIN 3 false not_held"), rig.Log.Dump());
        api.Push("granted", Ada, "vip", null, "purchase");
        Assert(rig.RunUntil("GRANTED 3 vip " + Ada + " purchase", 8000), "the grant was not pulled:\n" + rig.Log.Dump());
        api.Push("removed", Ada, "vip", null, "refunded");
        Assert(rig.RunUntil("REMOVED 3 vip refunded", 8000), "the removal was not pulled:\n" + rig.Log.Dump());
        rig.RunUntil("never printed", 300);
        Assert(api.Acked == 2, "acknowledged " + api.Acked);
    }

    private static void PerksCacheAcrossRestart()
    {
        var api = new PerksApi();
        api.Held[Ada] = new Dictionary<string, long?> { ["vip"] = null };
        var storage = new FolderStorage(Path.Combine(_tmp, "perks-data"));
        using (var rig = PerksRig("perks-cache", api, storage: storage))
        {
            rig.Runtime.PlayerJoin(3, "Ada");
            Assert(rig.RunUntil("JOIN 3", 5000), "no answer:\n" + rig.Log.Dump());
            Assert(rig.Log.Has("JOIN 3 true api"), rig.Log.Dump());
        }
        var saved = storage.Load("scriptgo.perks");
        Assert(saved != null && saved.Contains(Ada, StringComparison.Ordinal), "the cache was not written: " + saved);
        Assert(!saved.Contains(PerksToken, StringComparison.Ordinal), "the link token is in the data file");
        // The server restarts while the API cannot be reached: the stored answer holds, inside its bounds.
        api.Down = true;
        using (var rig = PerksRig("perks-cache", api, storage: storage))
        {
            rig.Runtime.PlayerJoin(3, "Ada");
            Assert(rig.RunUntil("JOIN 3", 5000), "no answer:\n" + rig.Log.Dump());
            Assert(rig.Log.Has("JOIN 3 true cache"), rig.Log.Dump());
        }
    }

    private static void PerksUnlinked()
    {
        var api = new PerksApi();
        api.Held[Ada] = new Dictionary<string, long?> { ["vip"] = null };
        using (var rig = PerksRig("perks-unlinked", api, token: null))
        {
            rig.Runtime.PlayerJoin(3, "Ada");
            Assert(rig.RunUntil("JOIN 3", 5000), "no answer:\n" + rig.Log.Dump());
            Assert(rig.Log.Has("JOIN 3 false not_linked"), rig.Log.Dump());
            rig.RunUntil("never printed", 1500);
            Assert(api.Seen.IsEmpty, "an unlinked server made " + api.Seen.Count + " request(s)");
        }
        using (var rig = PerksRig("perks-wrong-token", api, token: "sg_srv_another_operators"))
        {
            rig.Runtime.PlayerJoin(3, "Ada");
            Assert(rig.RunUntil("JOIN 3", 5000), "no answer:\n" + rig.Log.Dump());
            Assert(rig.Log.Has("JOIN 3 false not_linked"), rig.Log.Dump());
        }
    }

    private static void PerksNeedsHttp()
    {
        var dir = Fixture("perks-nohttp", "rt_perks", "capabilities { \"events\", \"players\", \"perks\" }", PerksScript);
        using var rig = new Rig();
        rig.Options.SearchDirs.Add(dir);
        rig.Boot();
        rig.Run(20);
        Assert(rig.Log.Has("capability_unavailable:perks@rust"), rig.Log.Dump());
        Assert(!rig.Log.Has("PERKS true"), rig.Log.Dump());
    }
}
