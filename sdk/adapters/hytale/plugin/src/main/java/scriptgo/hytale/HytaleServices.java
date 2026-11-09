package scriptgo.hytale;

import com.hypixel.hytale.common.util.java.ManifestUtil;
import com.hypixel.hytale.logger.HytaleLogger;
import com.hypixel.hytale.server.core.HytaleServer;
import com.hypixel.hytale.server.core.Message;
import com.hypixel.hytale.server.core.ShutdownReason;
import com.hypixel.hytale.server.core.permissions.PermissionsModule;
import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import scriptgo.jvm.HostServices;

import java.util.UUID;
import java.util.logging.Level;

/**
 * HostServices on the Hytale server API. Called from the scriptgo-host thread: logging, permission
 * lookups and chat messages, which plugins also send from their own threads.
 */
final class HytaleServices implements HostServices {
    private final HytaleLogger logger;
    private volatile boolean setupDone;
    private boolean started; // guarded by this
    private String pendingShutdown; // guarded by this

    HytaleServices(HytaleLogger logger) {
        this.logger = logger;
    }

    @Override
    public String runtimeVersion() {
        return "Hytale " + ManifestUtil.getImplementationVersion();
    }

    @Override
    public void log(String level, String message) {
        Level l = switch (level) {
            case "error" -> Level.SEVERE;
            case "warn" -> Level.WARNING;
            case "debug" -> Level.FINE;
            default -> Level.INFO;
        };
        logger.at(l).log(message);
    }

    @Override
    public boolean hasPermission(UUID player, String node) {
        return player != null && PermissionsModule.get().hasPermission(player, node);
    }

    @Override
    public void sendMessage(UUID player, String title, String message, String type) {
        String text = title == null || title.isEmpty() ? message : "[" + title + "] " + message;
        String colour = switch (type == null ? "info" : type) {
            case "error" -> "#FF5555";
            case "warning", "warn" -> "#FFAA00";
            case "success" -> "#55FF55";
            default -> "#FFFFFF";
        };
        if (player == null) {
            for (PlayerRef p : Universe.get().getPlayers()) p.sendMessage(Message.raw(text).color(colour));
            return;
        }
        PlayerRef p = Universe.get().getPlayer(player);
        if (p != null) p.sendMessage(Message.raw(text).color(colour));
    }

    @Override
    public void commandAdded(String name) {
        // Hytale takes command registrations only during setup; later ones go through /sg.
        if (setupDone) log("info", "[scriptgo] /" + name + " was registered after startup: run it with /sg " + name);
    }

    @Override
    public synchronized void requestShutdown(String reason) {
        // Before the server has started, wait for start().
        if (!started) pendingShutdown = reason;
        else shutdown(reason);
    }

    void setupDone() {
        setupDone = true;
    }

    synchronized void serverStarted() {
        started = true;
        if (pendingShutdown != null) shutdown(pendingShutdown);
    }

    /**
     * Never on the caller's thread: stopping the server stops this plugin, which waits for the
     * scriptgo-host thread that may be the one asking.
     */
    private static void shutdown(String reason) {
        Thread t = new Thread(() -> HytaleServer.get().shutdownServer(ShutdownReason.SHUTDOWN.withMessage(Message.raw(reason))),
            "scriptgo-shutdown");
        t.setDaemon(true);
        t.start();
    }
}
