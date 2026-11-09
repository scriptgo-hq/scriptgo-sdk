package scriptgo.hytale;

import com.hypixel.hytale.server.core.event.events.player.PlayerConnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerDisconnectEvent;
import com.hypixel.hytale.server.core.plugin.JavaPlugin;
import com.hypixel.hytale.server.core.plugin.JavaPluginInit;
import com.hypixel.hytale.server.core.universe.PlayerRef;
import scriptgo.jvm.Commands;
import scriptgo.jvm.ScriptGoHost;

import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * The Hytale server plugin: boots SCRIPT//GO (scriptgo.jvm.ScriptGoHost) during setup, forwards
 * player connects and disconnects, and exposes commands.
 *
 * <p>Hytale accepts command registrations only while a plugin is in its setup phase, so the host
 * starts its resources here, and every command they registered by then becomes a real /command.
 * Commands registered later (a resource started with /scriptgo start, or one that registers inside
 * a thread) are reached through /sg &lt;command&gt;, which always works.
 *
 * <p>Data folder (mods/ScriptGo_ScriptGo/): scriptgo.json, resources/, storage/.
 */
public final class ScriptGoPlugin extends JavaPlugin {
    /** Names the plugin itself uses. */
    private static final Set<String> RESERVED = Set.of("scriptgo", "sg");

    private HytaleServices services;
    private ScriptGoHost host;

    public ScriptGoPlugin(JavaPluginInit init) {
        super(init);
    }

    @Override
    protected void setup() {
        services = new HytaleServices(getLogger());
        services.log("info", "[scriptgo] data folder: " + getDataDirectory().toAbsolutePath());
        host = new ScriptGoHost(services, ScriptGoHost.fromSystemProperties(getDataDirectory()));
        try {
            host.start().get(60, TimeUnit.SECONDS);
        } catch (Exception e) {
            // The host logged why; /scriptgo still answers "SCRIPT//GO is not running."
        }

        getEventRegistry().registerGlobal(PlayerConnectEvent.class, event -> {
            PlayerRef player = event.getPlayerRef();
            if (player != null) host.playerJoined(player.getUuid(), player.getUsername());
        });
        getEventRegistry().registerGlobal(PlayerDisconnectEvent.class, event -> {
            PlayerRef player = event.getPlayerRef();
            if (player != null) host.playerLeft(player.getUuid(), "disconnected");
        });

        getCommandRegistry().registerCommand(new LuaCommand("scriptgo",
            "SCRIPT//GO resources: /scriptgo [start|stop|restart <resource>]", host::admin));
        getCommandRegistry().registerCommand(new LuaCommand("sg",
            "Run a SCRIPT//GO command: /sg <command> [arguments]", (sender, line) -> line.isEmpty()
                ? java.util.concurrent.CompletableFuture.completedFuture(new ScriptGoHost.Result(true,
                    "SCRIPT//GO commands: " + Commands.listing(host.commandNames())))
                : host.runCommand(sender, line)));

        for (String name : host.commandNames()) {
            if (RESERVED.contains(name) || !Commands.isValidName(name)) {
                services.log("warn", "[scriptgo] /" + name + " is not registered as a Hytale command: use /sg " + name);
                continue;
            }
            try {
                getCommandRegistry().registerCommand(new LuaCommand(name, "SCRIPT//GO command",
                    (sender, args) -> host.runCommand(sender, args.isEmpty() ? name : name + " " + args)));
            } catch (RuntimeException e) {
                services.log("warn", "[scriptgo] could not register /" + name + " (" + e.getMessage() + "): use /sg " + name);
            }
        }
        services.setupDone();
    }

    @Override
    protected void start() {
        services.serverStarted();
    }

    @Override
    protected void shutdown() {
        if (host != null) host.close();
    }
}
