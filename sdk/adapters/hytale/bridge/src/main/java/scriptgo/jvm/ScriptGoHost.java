package scriptgo.jvm;

import org.squiddev.cobalt.Constants;
import org.squiddev.cobalt.LuaError;
import org.squiddev.cobalt.LuaTable;
import org.squiddev.cobalt.LuaValue;
import org.squiddev.cobalt.Varargs;
import org.squiddev.cobalt.function.LibFunction;
import org.squiddev.cobalt.function.LuaFunction;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

/**
 * Runs SCRIPT//GO resources on a JVM game server: one Cobalt VM holding the pure-Lua core
 * (sdk/lua/scriptgo) and the Hytale Lua side (sdk/adapters/hytale/lua), ticked on its own thread.
 *
 * <p>Threading: everything Lua happens on one daemon thread, "scriptgo-host". Game events
 * (joins, drops, commands) are posted to it in arrival order; HTTP answers come back to it through
 * a queue drained at each tick. Lua never runs on a game thread, and the game is only reached
 * through {@link HostServices}.
 */
public final class ScriptGoHost implements AutoCloseable {
    public static final String ADAPTER_VERSION = "hytale-0.1.0";

    /** Verify mode: start only `resource` (and `with`, the README example), report after `seconds`. */
    public record Verify(String resource, String with, double seconds, Path report) {
    }

    /** The answer to a command: ok, or a message for the sender. */
    public record Result(boolean ok, String message) {
    }

    public static final class Options {
        /** The plugin's data folder: scriptgo.json, resources/, storage/. */
        public Path dataDir;
        /** Extra folders holding resources, searched after dataDir/resources. */
        public final List<Path> resourceDirs = new ArrayList<>();
        /** Defaults to dataDir/scriptgo.json. */
        public Path configFile;
        public Verify verify;
        public long tickMillis = 20;
    }

    /**
     * Options from the plugin's data folder plus -Dscriptgo.* system properties, which is how
     * `scriptgo verify --env hytale` drives a verify run:
     * scriptgo.resources (folders, path-separated), scriptgo.config, scriptgo.verify (resource),
     * scriptgo.verify.with, scriptgo.verify.seconds, scriptgo.verify.report, scriptgo.tickMillis.
     */
    public static Options fromSystemProperties(Path dataDir) {
        Options o = new Options();
        o.dataDir = dataDir;
        String dirs = System.getProperty("scriptgo.resources");
        if (dirs != null && !dirs.isBlank()) {
            for (String d : dirs.split(File.pathSeparator)) if (!d.isBlank()) o.resourceDirs.add(Path.of(d));
        }
        String config = System.getProperty("scriptgo.config");
        if (config != null && !config.isBlank()) o.configFile = Path.of(config);
        String verify = System.getProperty("scriptgo.verify");
        if (verify != null && !verify.isBlank()) {
            String report = System.getProperty("scriptgo.verify.report");
            o.verify = new Verify(verify.trim(), blankToNull(System.getProperty("scriptgo.verify.with")),
                Double.parseDouble(System.getProperty("scriptgo.verify.seconds", "3")),
                report == null || report.isBlank() ? dataDir.resolve("scriptgo-verify-" + verify.trim() + ".json") : Path.of(report));
        }
        String tick = System.getProperty("scriptgo.tickMillis");
        if (tick != null && !tick.isBlank()) o.tickMillis = Long.parseLong(tick.trim());
        return o;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    private final HostServices services;
    private final Options options;
    private final List<Path> roots = new ArrayList<>();
    private final ScheduledExecutorService exec;
    private final ConcurrentLinkedQueue<Runnable> completions = new ConcurrentLinkedQueue<>();
    private final HttpClient http = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(Duration.ofSeconds(10))
        .build();
    private final long t0 = System.nanoTime();

    // Host thread only.
    private LuaVm vm;
    private LuaTable api;
    private final Map<UUID, Integer> idByUuid = new HashMap<>();
    private final Map<Integer, UUID> uuidById = new HashMap<>();
    private final Map<Integer, String> nameById = new HashMap<>();
    private final Set<Integer> online = new LinkedHashSet<>();
    private final Set<String> knownCommands = new TreeSet<>();
    private int nextId = 1;

    private volatile Set<String> commandSnapshot = Set.of();
    private volatile boolean closed;

    public ScriptGoHost(HostServices services, Options options) {
        this.services = services;
        this.options = options;
        if (options.dataDir == null) throw new IllegalArgumentException("options.dataDir is required");
        roots.add(options.dataDir.resolve("resources").toAbsolutePath().normalize());
        for (Path p : options.resourceDirs) roots.add(p.toAbsolutePath().normalize());
        exec = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "scriptgo-host");
            t.setDaemon(true);
            return t;
        });
    }

    public Options options() {
        return options;
    }

    /** Boots the VM, loads and starts resources, then ticks every tickMillis. */
    public CompletableFuture<Void> start() {
        CompletableFuture<Void> booted = new CompletableFuture<>();
        exec.execute(() -> {
            try {
                boot();
                booted.complete(null);
            } catch (Throwable e) {
                services.log("error", "[scriptgo] boot failed: " + describe(e));
                booted.completeExceptionally(e);
                return;
            }
            exec.scheduleWithFixedDelay(this::tick, options.tickMillis, options.tickMillis, TimeUnit.MILLISECONDS);
        });
        return booted;
    }

    /** A player is now online (any thread). */
    public void playerJoined(UUID uuid, String name) {
        post(() -> {
            int id = idFor(uuid);
            if (name != null) nameById.put(id, name);
            if (online.add(id)) callApi("playerJoin", LuaVm.num(id), LuaVm.str(nameById.get(id)));
        });
    }

    /** A player left (any thread). reason: left, kicked, timed_out... */
    public void playerLeft(UUID uuid, String reason) {
        post(() -> {
            Integer id = idByUuid.get(uuid);
            if (id == null || !online.contains(id)) return;
            callApi("playerDrop", LuaVm.num(id), LuaVm.str(reason == null ? "left" : reason));
            online.remove(id);
        });
    }

    /** Runs a resource command line ("give 3 water") as a player, or as the console when player is null. */
    public CompletableFuture<Result> runCommand(UUID player, String line) {
        CompletableFuture<Result> out = new CompletableFuture<>();
        post(() -> {
            int source = player == null ? 0 : idFor(player);
            Varargs r = callApi("command", LuaVm.num(source), LuaVm.str(line));
            if (r == null) {
                out.complete(new Result(false, "SCRIPT//GO is not running."));
                return;
            }
            if (r.first().toBoolean()) {
                out.complete(new Result(true, ""));
                return;
            }
            String why = textOrEmpty(r.arg(2));
            String name = line.trim().replaceFirst("^/", "").split("\\s+", 2)[0];
            if (why.equals("not_allowed")) out.complete(new Result(false, "You are not allowed to use /" + name + "."));
            else if (why.startsWith("unknown_command")) out.complete(new Result(false, "Unknown command /" + name + "."));
            else out.complete(new Result(false, "/" + name + ": " + why));
        });
        return out;
    }

    /** `/scriptgo [start|stop|restart <resource>]`; the three actions need scriptgo.admin (console always may). */
    public CompletableFuture<Result> admin(UUID caller, String param) {
        CompletableFuture<Result> out = new CompletableFuture<>();
        post(() -> {
            boolean action = param != null && !param.isBlank();
            if (action && caller != null && !services.hasPermission(caller, "scriptgo.admin")) {
                out.complete(new Result(false, "Needs the scriptgo.admin permission."));
                return;
            }
            Varargs r = callApi("admin", LuaVm.str(param == null ? "" : param));
            if (r == null) out.complete(new Result(false, "SCRIPT//GO is not running."));
            else out.complete(new Result(r.first().toBoolean(), textOrEmpty(r.arg(2))));
        });
        return out;
    }

    /** Resource command names known after the last tick (any thread). */
    public Set<String> commandNames() {
        return commandSnapshot;
    }

    /** Stops every resource and the host thread. */
    @Override
    public void close() {
        if (closed) return;
        CompletableFuture<Void> stopped = new CompletableFuture<>();
        try {
            exec.execute(() -> {
                callApi("shutdown");
                stopped.complete(null);
            });
            stopped.get(5, TimeUnit.SECONDS);
        } catch (Exception e) {
            services.log("warn", "[scriptgo] resources did not stop cleanly: " + describe(e));
        } finally {
            closed = true;
            exec.shutdownNow();
        }
    }

    // Host thread ---------------------------------------------------------------------------------------

    private void post(Runnable task) {
        if (closed) return;
        try {
            exec.execute(() -> {
                try {
                    task.run();
                } catch (Throwable e) {
                    services.log("error", "[scriptgo] " + describe(e));
                }
            });
        } catch (RejectedExecutionException ignored) {
            // shutting down
        }
    }

    private void boot() throws LuaError, IOException {
        vm = new LuaVm();
        LuaTable nat = buildNative();
        LuaValue coreReader = LibFunction.create((s, path) -> LuaVm.bytes(classpath("/scriptgo/core/" + LuaVm.text(path))));
        LuaValue core = vm.call(vm.load("scriptgo/init.lua", requireClasspath("/scriptgo/core/init.lua")), LuaVm.str(""), coreReader).first();
        LuaValue adapterFactory = vm.call(vm.load("scriptgo/hytale/adapter.lua", requireClasspath("/scriptgo/hytale/adapter.lua"))).first();
        LuaValue main = vm.call(vm.load("scriptgo/hytale/main.lua", requireClasspath("/scriptgo/hytale/main.lua"))).first();

        LuaTable opts = new LuaTable();
        List<String> dirs = new ArrayList<>();
        for (Path r : roots) dirs.add(slashes(r));
        opts.rawset("resourceDirs", LuaVm.list(dirs));
        Path config = options.configFile != null ? options.configFile : options.dataDir.resolve("scriptgo.json");
        if (Files.isRegularFile(config)) opts.rawset("configText", LuaVm.bytes(Files.readAllBytes(config)));
        if (options.verify != null) {
            LuaTable v = new LuaTable();
            v.rawset("name", LuaVm.str(options.verify.resource()));
            if (options.verify.with() != null) v.rawset("with", LuaVm.str(options.verify.with()));
            v.rawset("seconds", LuaVm.num(options.verify.seconds()));
            opts.rawset("verify", v);
        }
        api = vm.call(main, core, nat, adapterFactory, opts).first().checkTable();
        syncCommands();
        services.log("info", "[scriptgo] host ready (" + ADAPTER_VERSION + ", " + LuaVm.luaVersion() + ")");
    }

    private void tick() {
        if (api == null) return;
        try {
            Runnable done;
            while ((done = completions.poll()) != null) done.run();
            callApi("tick");
            syncCommands();
        } catch (Throwable e) {
            // A periodic task that throws is cancelled for good: never let one escape.
            services.log("error", "[scriptgo] tick: " + describe(e));
        }
    }

    private void syncCommands() {
        Varargs r = callApi("commandList");
        if (r == null || !(r.first() instanceof LuaTable list)) return;
        Set<String> now = new TreeSet<>();
        for (int i = 1; i <= list.length(); i++) {
            try {
                now.add(LuaVm.text(list.rawget(i)));
            } catch (LuaError ignored) {
                // names are strings
            }
        }
        if (now.equals(knownCommands)) return;
        for (String name : now) if (!knownCommands.contains(name)) services.commandAdded(name);
        knownCommands.clear();
        knownCommands.addAll(now);
        commandSnapshot = Collections.unmodifiableSet(new TreeSet<>(now));
    }

    /** Calls api[name](...) and logs (never throws) a Lua error; null when it failed. */
    private Varargs callApi(String name, LuaValue... args) {
        if (api == null) return null;
        try {
            return vm.call(api.rawget(name), args);
        } catch (LuaError | RuntimeException e) {
            services.log("error", "[scriptgo] " + name + ": " + describe(e));
            return null;
        }
    }

    private int idFor(UUID uuid) {
        Integer id = idByUuid.get(uuid);
        if (id == null) {
            id = nextId++;
            idByUuid.put(uuid, id);
            uuidById.put(id, uuid);
        }
        return id;
    }

    private UUID onlineUuid(LuaValue id) {
        if (!id.isNumber()) return null;
        int n = (int) id.toDouble();
        return online.contains(n) ? uuidById.get(n) : null;
    }

    // The native table: what adapter.lua and main.lua may call. Never reachable from resources. ------

    private LuaTable buildNative() {
        LuaTable n = new LuaTable();
        n.rawset("adapterVersion", LibFunction.create(s -> LuaVm.str(ADAPTER_VERSION)));
        n.rawset("runtimeVersion", LibFunction.create(s -> LuaVm.str(services.runtimeVersion())));
        n.rawset("luaVersion", LibFunction.create(s -> LuaVm.str(LuaVm.luaVersion())));
        n.rawset("now", LibFunction.create(s -> LuaVm.num((System.nanoTime() - t0) / 1e9)));
        n.rawset("log", LibFunction.create((s, level, origin, msg) -> {
            services.log(LuaVm.text(level), "[scriptgo] " + LuaVm.text(origin) + " " + LuaVm.text(msg));
            return Constants.NIL;
        }));

        n.rawset("isFile", LibFunction.create((s, p) -> {
            Path path = allowed(LuaVm.text(p));
            return LuaVm.bool(path != null && Files.isRegularFile(path));
        }));
        n.rawset("readFile", LibFunction.create((s, p) -> {
            Path path = allowed(LuaVm.text(p));
            if (path == null || !Files.isRegularFile(path)) return Constants.NIL;
            try {
                return LuaVm.bytes(Files.readAllBytes(path));
            } catch (IOException e) {
                return Constants.NIL;
            }
        }));
        n.rawset("listFiles", LibFunction.create((s, p) -> LuaVm.list(listFiles(allowed(LuaVm.text(p))))));
        n.rawset("listDirs", LibFunction.create((s, p) -> LuaVm.list(listDirs(allowed(LuaVm.text(p))))));

        n.rawset("storageLoad", LibFunction.create((s, key) -> {
            Path f = storageFile(LuaVm.text(key));
            try {
                return Files.isRegularFile(f) ? LuaVm.bytes(Files.readAllBytes(f)) : Constants.NIL;
            } catch (IOException e) {
                services.log("warn", "[scriptgo] cannot read " + f.getFileName() + ": " + e.getMessage());
                return Constants.NIL;
            }
        }));
        n.rawset("storageSave", LibFunction.create((s, key, text) -> {
            Path f = storageFile(LuaVm.text(key));
            try {
                Files.createDirectories(f.getParent());
                Path tmp = f.resolveSibling(f.getFileName() + ".tmp");
                Files.write(tmp, LuaVm.rawBytes(text));
                Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException e) {
                throw new LuaError("storage: cannot write " + f.getFileName() + ": " + e.getMessage());
            }
            return Constants.NIL;
        }));

        n.rawset("playerList", LibFunction.create(s -> LuaVm.list(new TreeSet<>(online))));
        n.rawset("playerName", LibFunction.create((s, id) -> onlineUuid(id) == null ? Constants.NIL : LuaVm.str(nameById.get((int) id.toDouble()))));
        n.rawset("playerUuid", LibFunction.create((s, id) -> {
            if (!id.isNumber()) return Constants.NIL;
            UUID u = uuidById.get((int) id.toDouble());
            return u == null ? Constants.NIL : LuaVm.str(u.toString());
        }));
        n.rawset("hasPermission", LibFunction.create((s, id, privilege) -> {
            UUID u = onlineUuid(id);
            if (u == null) return Constants.FALSE;
            String p = LuaVm.text(privilege);
            return LuaVm.bool(services.hasPermission(u, "scriptgo.admin") || services.hasPermission(u, "scriptgo." + p));
        }));
        n.rawset("notify", LibFunction.createV((s, a) -> {
            LuaValue target = a.arg(1);
            String title = LuaVm.text(a.arg(2)), message = LuaVm.text(a.arg(3)), type = LuaVm.text(a.arg(4));
            if (target.isNumber() && target.toDouble() == -1) {
                services.sendMessage(null, title, message, type);
            } else {
                UUID u = onlineUuid(target);
                if (u != null) services.sendMessage(u, title, message, type);
            }
            return Constants.NONE;
        }));

        n.rawset("httpRequest", LibFunction.createV((s, a) -> {
            httpRequest(LuaVm.text(a.arg(1)), LuaVm.text(a.arg(2)), a.arg(3), a.arg(4), a.arg(5).optDouble(10), a.arg(6).checkFunction());
            return Constants.NONE;
        }));

        n.rawset("writeReport", LibFunction.create((s, text) -> {
            if (options.verify == null) throw new LuaError("writeReport: not a verify run");
            try {
                Path report = options.verify.report();
                if (report.getParent() != null) Files.createDirectories(report.getParent());
                Files.write(report, LuaVm.rawBytes(text));
            } catch (IOException e) {
                throw new LuaError("cannot write the verify report: " + e.getMessage());
            }
            return Constants.NIL;
        }));
        n.rawset("shutdown", LibFunction.create((s, reason) -> {
            services.requestShutdown(LuaVm.text(reason));
            return Constants.NIL;
        }));
        return n;
    }

    // Files: reads are confined to the resource folders and the data folder.

    private Path allowed(String p) {
        if (p == null) return null;
        Path path = Path.of(p).toAbsolutePath().normalize();
        if (path.startsWith(options.dataDir.toAbsolutePath().normalize())) return path;
        for (Path r : roots) if (path.startsWith(r)) return path;
        return null;
    }

    /** For tests: whether the native readFile would read this path. */
    boolean readable(String path) {
        return allowed(path) != null;
    }

    private static List<String> listFiles(Path root) {
        List<String> out = new ArrayList<>();
        if (root == null || !Files.isDirectory(root)) return out;
        try (Stream<Path> walk = Files.walk(root)) {
            walk.filter(Files::isRegularFile).forEach(f -> {
                Path rel = root.relativize(f);
                for (Path part : rel) if (part.toString().startsWith(".")) return;
                out.add(slashes(rel));
            });
        } catch (IOException e) {
            return out;
        }
        Collections.sort(out);
        return out;
    }

    private static List<String> listDirs(Path dir) {
        List<String> out = new ArrayList<>();
        if (dir == null || !Files.isDirectory(dir)) return out;
        try (Stream<Path> list = Files.list(dir)) {
            list.filter(Files::isDirectory).map(d -> d.getFileName().toString()).filter(nm -> !nm.startsWith(".")).forEach(out::add);
        } catch (IOException e) {
            return out;
        }
        Collections.sort(out);
        return out;
    }

    private Path storageFile(String key) {
        String safe = key == null ? "_" : key.replaceAll("[^A-Za-z0-9_.-]", "_");
        if (safe.isEmpty() || safe.startsWith(".")) safe = "_" + safe;
        return options.dataDir.resolve("storage").resolve(safe + ".json");
    }

    // HTTP: java.net.http, asynchronous; the answer is handed to Lua on the host thread.

    private void httpRequest(String method, String url, LuaValue headers, LuaValue body, double timeout, LuaFunction done) throws LuaError {
        HttpRequest.Builder b;
        try {
            b = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofMillis((long) (Math.max(0.1, timeout) * 1000)));
            if (headers instanceof LuaTable t) {
                LuaValue k = Constants.NIL;
                while (true) {
                    Varargs next = t.next(k);
                    k = next.first();
                    if (k.isNil()) break;
                    b.header(LuaVm.text(k), LuaVm.text(next.arg(2)));
                }
            }
            HttpRequest.BodyPublisher publisher = body.isNil()
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofByteArray(LuaVm.rawBytes(body));
            b.method(method == null ? "GET" : method.toUpperCase(), publisher);
        } catch (IllegalArgumentException e) {
            LuaTable res = response(0, null, null, "invalid_request");
            completions.add(() -> deliver(done, res));
            return;
        }
        http.sendAsync(b.build(), HttpResponse.BodyHandlers.ofByteArray()).whenComplete((resp, err) -> completions.add(() -> {
            if (err != null) {
                Throwable cause = err.getCause() != null ? err.getCause() : err;
                deliver(done, response(0, null, null, cause instanceof HttpTimeoutException ? "timeout" : "request_failed"));
            } else {
                deliver(done, response(resp.statusCode(), resp.body(), resp.headers().map(), null));
            }
        }));
    }

    private static LuaTable response(int status, byte[] body, Map<String, List<String>> headers, String error) {
        LuaTable r = new LuaTable();
        r.rawset("status", LuaVm.num(status));
        r.rawset("body", body == null ? LuaVm.str("") : LuaVm.bytes(body));
        LuaTable h = new LuaTable();
        if (headers != null) {
            for (Map.Entry<String, List<String>> e : headers.entrySet()) {
                if (e.getKey() == null || e.getValue().isEmpty()) continue;
                h.rawset(e.getKey().toLowerCase(), LuaVm.str(e.getValue().get(0)));
            }
        }
        r.rawset("headers", h);
        if (error != null) r.rawset("error", LuaVm.str(error));
        return r;
    }

    private void deliver(LuaFunction done, LuaTable res) {
        try {
            vm.call(done, res);
        } catch (LuaError | RuntimeException e) {
            services.log("error", "[scriptgo] http callback: " + describe(e));
        }
    }

    // Helpers -----------------------------------------------------------------------------------------

    private static byte[] classpath(String name) {
        try (InputStream in = ScriptGoHost.class.getResourceAsStream(name)) {
            return in == null ? null : in.readAllBytes();
        } catch (IOException e) {
            return null;
        }
    }

    private static byte[] requireClasspath(String name) throws IOException {
        byte[] b = classpath(name);
        if (b == null) throw new IOException(name + " is missing from the plugin jar");
        return b;
    }

    private static String slashes(Path p) {
        return p.toString().replace('\\', '/');
    }

    private static String textOrEmpty(LuaValue v) {
        try {
            String s = LuaVm.text(v);
            return s == null ? "" : s;
        } catch (LuaError e) {
            return "";
        }
    }

    static String describe(Throwable e) {
        String m = e.getMessage();
        return m == null ? e.getClass().getSimpleName() : m;
    }

}
