package scriptgo.jvm;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

/**
 * In-memory HostServices for unit tests on a plain JVM. It stands in for the game server and is
 * NOT Hytale: these tests prove the bridge (Cobalt + the core + the Hytale Lua side), never the
 * Hytale integration itself.
 */
final class MemoryServices implements HostServices {
    record Message(UUID player, String title, String message, String type) {
    }

    final List<String> logs = new CopyOnWriteArrayList<>();
    final List<Message> messages = new CopyOnWriteArrayList<>();
    final List<String> commandsAdded = new CopyOnWriteArrayList<>();
    final Map<UUID, Set<String>> nodes = new ConcurrentHashMap<>();
    final List<String> threadsSeen = new CopyOnWriteArrayList<>();
    final CountDownLatch shutdown = new CountDownLatch(1);
    volatile String shutdownReason;

    @Override
    public String runtimeVersion() {
        return "plain JVM " + System.getProperty("java.version") + " (unit test, not Hytale)";
    }

    @Override
    public void log(String level, String message) {
        threadsSeen.add(Thread.currentThread().getName());
        logs.add("[" + level + "] " + message);
    }

    @Override
    public boolean hasPermission(UUID player, String node) {
        Set<String> s = nodes.get(player);
        return s != null && (s.contains(node) || s.contains("*"));
    }

    @Override
    public void sendMessage(UUID player, String title, String message, String type) {
        messages.add(new Message(player, title, message, type));
    }

    @Override
    public void commandAdded(String name) {
        commandsAdded.add(name);
    }

    @Override
    public void requestShutdown(String reason) {
        shutdownReason = reason;
        shutdown.countDown();
    }

    /** Waits until a log line matches, or fails after `seconds`. */
    String awaitLog(Predicate<String> match, double seconds) throws InterruptedException {
        long deadline = System.nanoTime() + (long) (seconds * 1e9);
        while (System.nanoTime() < deadline) {
            for (String l : logs) if (match.test(l)) return l;
            TimeUnit.MILLISECONDS.sleep(10);
        }
        throw new AssertionError("no log line matched within " + seconds + " s; got:\n" + String.join("\n", logs));
    }
}
