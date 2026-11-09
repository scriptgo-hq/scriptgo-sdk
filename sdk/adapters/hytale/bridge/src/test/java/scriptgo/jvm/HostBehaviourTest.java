package scriptgo.jvm;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The bridge's host behaviour on a plain JVM with in-memory services (not Hytale): player
 * events, commands and the permission mapping, chat notifications, storage files, config, UTF-8,
 * the execution budget and HTTP through the operator's allow-list.
 */
class HostBehaviourTest {
    @TempDir
    Path data;

    private ScriptGoHost host;
    private final MemoryServices svc = new MemoryServices();

    @AfterEach
    void stop() {
        if (host != null) host.close();
    }

    private void resource(String name, String caps, String server) throws Exception {
        Path dir = data.resolve("resources").resolve(name);
        Files.createDirectories(dir.resolve("server"));
        Files.writeString(dir.resolve("scriptgo.lua"), String.join("\n",
            "resource \"" + name + "\"", "version \"1.0.0\"", "scriptgo_version \">=0.1.0\"",
            "environments { \"hytale\" }", "capabilities { " + caps + " }", "server_script \"server/main.lua\"", ""));
        Files.writeString(dir.resolve("server/main.lua"), server, StandardCharsets.UTF_8);
    }

    private void boot(String configJson) throws Exception {
        if (configJson != null) Files.writeString(data.resolve("scriptgo.json"), configJson, StandardCharsets.UTF_8);
        ScriptGoHost.Options o = new ScriptGoHost.Options();
        o.dataDir = data;
        o.tickMillis = 5;
        host = new ScriptGoHost(svc, o);
        host.start().get(20, TimeUnit.SECONDS);
    }

    @Test
    void playersCommandsPermissionsAndNotifications() throws Exception {
        resource("t_res", "\"events\", \"logging\", \"players\", \"permissions\", \"commands\", \"ui\"", """
            AddEventHandler("playerJoining", function()
                print("JOIN " .. source .. " " .. tostring(ScriptGo.players.name(source)) .. " " .. tostring(ScriptGo.players.identifier(source)))
            end)
            AddEventHandler("playerDropped", function(reason)
                print("DROP " .. source .. " " .. reason .. " " .. tostring(ScriptGo.players.name(source)))
            end)
            RegisterCommand("hello", function(src, args, raw)
                print("HELLO " .. src .. " " .. raw)
                ScriptGo.ui.notify(src, { title = "t_res", message = "hi " .. tostring(args[1]) })
            end, false)
            RegisterCommand("secret", function(src) print("SECRET " .. src) end, true)
            RegisterCommand("shout", function(src) ScriptGo.ui.notify(-1, { message = "everyone" }) end, false)
            """);
        boot("{\"permissions\": {\"Ada\": [\"command.secret\"]}}");
        assertEquals(Set.of("hello", "secret", "shout"), host.commandNames());
        assertTrue(svc.commandsAdded.containsAll(Set.of("hello", "secret", "shout")));

        UUID zoe = UUID.fromString("00000000-0000-0000-0000-00000000000a");
        UUID ada = UUID.fromString("00000000-0000-0000-0000-00000000000b");
        host.playerJoined(zoe, "Zoë 魔");
        svc.awaitLog(l -> l.contains("JOIN 1 Zoë 魔 hytale:" + zoe), 5);
        host.playerJoined(ada, "Ada");
        svc.awaitLog(l -> l.contains("JOIN 2 Ada hytale:" + ada), 5);

        assertTrue(host.runCommand(zoe, "hello world").get(5, TimeUnit.SECONDS).ok());
        svc.awaitLog(l -> l.contains("HELLO 1 hello world"), 5);
        assertTrue(svc.messages.stream().anyMatch(m -> zoe.equals(m.player()) && m.message().equals("hi world") && m.title().equals("t_res")));

        // Restricted: Zoë has no grant and no node; Ada has the scriptgo.json grant; a node works too.
        ScriptGoHost.Result denied = host.runCommand(zoe, "/secret").get(5, TimeUnit.SECONDS);
        assertFalse(denied.ok());
        assertEquals("You are not allowed to use /secret.", denied.message());
        assertTrue(host.runCommand(ada, "secret").get(5, TimeUnit.SECONDS).ok());
        svc.awaitLog(l -> l.contains("SECRET 2"), 5);
        svc.nodes.put(zoe, Set.of("scriptgo.command.secret"));
        assertTrue(host.runCommand(zoe, "secret").get(5, TimeUnit.SECONDS).ok());
        svc.awaitLog(l -> l.contains("SECRET 1"), 5);
        assertTrue(host.runCommand(null, "secret").get(5, TimeUnit.SECONDS).ok(), "the console may run everything");

        assertEquals("Unknown command /nope.", host.runCommand(zoe, "nope").get(5, TimeUnit.SECONDS).message());

        assertTrue(host.runCommand(ada, "shout").get(5, TimeUnit.SECONDS).ok());
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (svc.messages.stream().noneMatch(m -> m.player() == null && m.message().equals("everyone")) && System.nanoTime() < deadline) Thread.sleep(10);
        assertTrue(svc.messages.stream().anyMatch(m -> m.player() == null && m.message().equals("everyone")), "-1 broadcasts");

        host.playerLeft(zoe, "left");
        svc.awaitLog(l -> l.contains("DROP 1 left Zoë 魔"), 5);
        host.playerJoined(zoe, "Zoë 魔");
        svc.awaitLog(l -> l.contains("JOIN 1 Zoë 魔"), 5); // same id again within the session

        // /scriptgo: listing for everyone, actions need scriptgo.admin.
        assertTrue(host.admin(zoe, "").get(5, TimeUnit.SECONDS).message().contains("t_res 1.0.0  started"));
        assertEquals("Needs the scriptgo.admin permission.", host.admin(zoe, "stop t_res").get(5, TimeUnit.SECONDS).message());
        svc.nodes.put(ada, Set.of("scriptgo.admin"));
        assertEquals("t_res: stopped", host.admin(ada, "stop t_res").get(5, TimeUnit.SECONDS).message());
        assertEquals("t_res: started", host.admin(null, "start t_res").get(5, TimeUnit.SECONDS).message());
    }

    @Test
    void storageConfigAndUtf8() throws Exception {
        resource("t_store", "\"events\", \"logging\", \"storage\", \"config\"", """
            CreateThread(function()
                ScriptGo.storage.set("k", { n = 1, s = "Zoë" })
                print("STORED " .. tostring(ScriptGo.storage.get("k").s))
                print("CONFIG " .. tostring(ScriptGo.config.get("greeting", "none")) .. " " .. tostring(GetConvar("sg_test", "unset")))
                print("DATE " .. os.date("!%Y-%m-%d %H:%M:%S", 86400 + 3661) .. " " .. tostring(os.time({ year = 2026, month = 1, day = 13, hour = 0 }) > 0))
                local t = os.date("!*t", 0)
                print("TABLE " .. t.year .. " " .. t.month .. " " .. t.wday .. " " .. tostring(t.isdst))
            end)
            """);
        boot("{\"resources\": {\"t_store\": {\"greeting\": \"salut\"}}, \"convars\": {\"sg_test\": \"on\"}}");
        svc.awaitLog(l -> l.contains("STORED Zoë"), 5);
        svc.awaitLog(l -> l.contains("CONFIG salut on"), 5);
        svc.awaitLog(l -> l.contains("DATE 1970-01-02 01:01:01 true"), 5);
        svc.awaitLog(l -> l.contains("TABLE 1970 1 5 false"), 5);
        String stored = Files.readString(data.resolve("storage/t_store.json"), StandardCharsets.UTF_8);
        assertTrue(stored.contains("\"s\":\"Zoë\""), stored);
    }

    @Test
    void aRunawayResourceIsStoppedAndTheHostKeepsTicking() throws Exception {
        resource("t_loop", "\"events\", \"logging\"", """
            CreateThread(function() Wait(20) while true do end end)
            CreateThread(function() Wait(400) print("STILL TICKING") end)
            """);
        boot("{\"budgetMs\": 100}");
        svc.awaitLog(l -> l.contains("execution budget exceeded"), 10);
        svc.awaitLog(l -> l.contains("STILL TICKING"), 10);
    }

    @Test
    void httpOnlyReachesTheOperatorsHostsAndAnswersOnTheHostThread() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/hello", ex -> {
            byte[] body = ("{\"method\":\"" + ex.getRequestMethod() + "\"}").getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("X-Test", "yes");
            ex.sendResponseHeaders(201, body.length);
            ex.getResponseBody().write(body);
            ex.close();
        });
        server.start();
        try {
            int port = server.getAddress().getPort();
            resource("t_http", "\"events\", \"logging\", \"http\"", """
                CreateThread(function()
                    local res, err = ScriptGo.http.request({ method = "POST", url = "http://127.0.0.1:%d/hello", body = "x" })
                    print("HTTP " .. tostring(res and res.status) .. " " .. tostring(res and res.body) .. " " .. tostring(res and res.headers["x-test"]) .. " " .. tostring(err))
                    local other = ScriptGo.http.request({ url = "http://example.invalid/" })
                    print("OTHER " .. tostring(other and other.status) .. " " .. tostring(other and other.error))
                end)
                """.formatted(port));
            boot("{\"http\": {\"allowedHosts\": [\"127.0.0.1\"]}}");
            svc.awaitLog(l -> l.contains("HTTP 201 {\"method\":\"POST\"} yes nil"), 10);
            svc.awaitLog(l -> l.contains("OTHER 0 host_not_allowed"), 10);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void withoutAllowedHostsHttpIsUnavailable() throws Exception {
        resource("t_nohttp", "\"events\", \"logging\"", """
            CreateThread(function()
                print("HAS " .. tostring(ScriptGo.capabilities.has("http")) .. " " .. tostring(ScriptGo.capabilities.has("licensing")))
                local ok, err = pcall(function() return ScriptGo.http.request({ url = "http://127.0.0.1/" }) end)
                print("REFUSED " .. tostring(ok) .. " " .. tostring(err))
            end)
            """);
        boot(null);
        svc.awaitLog(l -> l.contains("HAS false false"), 5);
        svc.awaitLog(l -> l.contains("REFUSED false") && l.contains("capability_unavailable:http@hytale"), 5);
    }

    @Test
    void filesOutsideTheResourceAndDataFoldersAreNotReadable() throws Exception {
        resource("t_files", "\"events\", \"logging\"", """
            CreateThread(function()
                print("OWN " .. tostring(ScriptGo.resource.readFile("server/main.lua") ~= nil))
                print("UP " .. tostring(ScriptGo.resource.readFile("../../scriptgo.json")))
            end)
            """);
        boot("{}");
        svc.awaitLog(l -> l.contains("OWN true"), 5);
        svc.awaitLog(l -> l.contains("UP nil"), 5);
        // The bridge's own confinement, under the core's: only resource folders and the data folder.
        assertTrue(host.readable(data.resolve("resources/t_files/server/main.lua").toString()));
        assertTrue(host.readable(data.resolve("scriptgo.json").toString()));
        assertFalse(host.readable(data.resolve("../outside.txt").toString()));
        assertFalse(host.readable(System.getProperty("java.home")));
    }
}
