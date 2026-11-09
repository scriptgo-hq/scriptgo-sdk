package scriptgo.jvm;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The plugin's verify mode, driven exactly as on a Hytale server (system-property options, the
 * Lua side writing the report, then asking for a shutdown), but on a plain JVM with in-memory
 * services. Proves the bridge runs the real conformance probe and packages from this repository;
 * it is not a Hytale run and writes nothing to verification/reports.
 */
class VerifyModeTest {
    static final Path REPO = Path.of(System.getProperty("scriptgo.repo", "../../../..")).toAbsolutePath().normalize();

    @TempDir
    Path data;

    @SuppressWarnings("unchecked")
    private Map<String, Object> verify(String resource, String with, Path... extraDirs) throws Exception {
        ScriptGoHost.Options o = new ScriptGoHost.Options();
        o.dataDir = data;
        o.resourceDirs.add(REPO.resolve("sdk/conformance"));
        o.resourceDirs.add(REPO.resolve("sdk/packages"));
        o.resourceDirs.addAll(List.of(extraDirs));
        o.verify = new ScriptGoHost.Verify(resource, with, 2.0, data.resolve("out/report.json"));
        o.tickMillis = 10;
        MemoryServices svc = new MemoryServices();
        try (ScriptGoHost host = new ScriptGoHost(svc, o)) {
            host.start().get(30, TimeUnit.SECONDS);
            assertTrue(svc.shutdown.await(30, TimeUnit.SECONDS), "verify mode never asked for a shutdown:\n" + String.join("\n", svc.logs));
        }
        assertEquals("SCRIPT//GO verify finished", svc.shutdownReason);
        assertTrue(svc.threadsSeen.stream().allMatch(t -> t.equals("scriptgo-host")), "Lua ran off the host thread: " + svc.threadsSeen);
        return MiniJson.object(Files.readString(data.resolve("out/report.json"), StandardCharsets.UTF_8));
    }

    @SuppressWarnings("unchecked")
    private static String failures(Map<String, Object> report) {
        StringBuilder b = new StringBuilder();
        for (Object c : (List<Object>) report.get("checks")) {
            Map<String, Object> m = (Map<String, Object>) c;
            if (!"passed".equals(m.get("status"))) b.append(m.get("name")).append(": ").append(m.get("message")).append('\n');
        }
        return b.toString();
    }

    @Test
    @SuppressWarnings("unchecked")
    void conformanceProbePassesEveryCheck() throws Exception {
        Map<String, Object> r = verify("sg_probe", null);
        assertEquals("verified", r.get("status"), failures(r) + r.get("log"));
        assertEquals("hytale", r.get("environment"));
        assertEquals("hytale-0.1.0", r.get("adapterVersion"));
        assertEquals(LuaVm.luaVersion(), r.get("luaVersion"));
        List<Object> checks = (List<Object>) r.get("checks");
        long self = checks.stream().filter(c -> ((String) ((Map<String, Object>) c).get("name")).startsWith("self:")).count();
        assertEquals(25, self, "sg_probe prints 25 SGCHECK lines");
        assertTrue(((String) r.get("log")).contains("SGCHECK DONE env=hytale lua=Lua 5.2 pass=25 fail=0"), (String) r.get("log"));
    }

    @Test
    void readmeExampleOfTheEventBusRuns() throws Exception {
        // What `scriptgo verify` does (packages/cli/src/lib/readme-example.ts): the README's
        // `lua runnable` block becomes a resource that depends on the package.
        String readme = Files.readString(REPO.resolve("sdk/packages/sg_eventbus/README.md"), StandardCharsets.UTF_8).replace("\r\n", "\n");
        Matcher m = Pattern.compile("(?ms)^```lua runnable\\n(.*?)^```").matcher(readme);
        assertTrue(m.find(), "sg_eventbus/README.md has a runnable block");
        Path extra = data.resolve("examples");
        Path dir = extra.resolve("sg_eventbus_readme");
        Files.createDirectories(dir.resolve("server"));
        Files.writeString(dir.resolve("scriptgo.lua"), String.join("\n",
            "resource \"sg_eventbus_readme\"", "version \"1.0.2\"", "scriptgo_version \">=0.1.0\"",
            "capabilities { \"events\", \"logging\" }", "dependency \"sg_eventbus\"", "server_script \"server/main.lua\"", ""));
        Files.writeString(dir.resolve("server/main.lua"), m.group(1));
        Map<String, Object> r = verify("sg_eventbus", "sg_eventbus_readme", extra);
        // sg_eventbus 1.0.2 does not list hytale in its environments yet, so this one check fails,
        // as it would on a real server; everything that ran passed.
        assertEquals("environment_declared: standalone, love2d, godot, luanti, open77, neovim\n", failures(r), (String) r.get("log"));
        assertTrue(((String) r.get("log")).contains("sale #1 from sg_eventbus_readme: water for 3"), (String) r.get("log"));
    }

    @Test
    void aBrokenResourceIsReportedFailing() throws Exception {
        Path extra = data.resolve("broken");
        Path dir = extra.resolve("t_broken");
        Files.createDirectories(dir.resolve("server"));
        Files.writeString(dir.resolve("scriptgo.lua"), String.join("\n",
            "resource \"t_broken\"", "version \"1.0.0\"", "scriptgo_version \">=0.1.0\"", "environments { \"standalone\" }",
            "server_script \"server/main.lua\"", ""));
        Files.writeString(dir.resolve("server/main.lua"), "CreateThread(function() Wait(10) error('boom') end)\n");
        Map<String, Object> r = verify("t_broken", null, extra);
        assertEquals("failing", r.get("status"));
        String f = failures(r);
        assertTrue(f.contains("environment_declared") && f.contains("no_runtime_errors") && f.contains("boom"), f);
    }
}
