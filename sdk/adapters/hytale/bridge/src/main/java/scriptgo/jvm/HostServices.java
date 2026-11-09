package scriptgo.jvm;

import java.util.UUID;

/**
 * What a game server supplies to run SCRIPT//GO resources: the "host interface" of
 * docs/plan/MULTI-LANGUAGE-SANDBOX.md, for the JVM. The Hytale plugin implements it on top of the
 * Hytale server API; tests implement it in memory.
 *
 * <p>Every method is called on ScriptGoHost's host thread, never on a game thread. An
 * implementation that must touch thread-confined game state hops to the right thread itself.
 */
public interface HostServices {
    /** The game server and its version, for reports: "Hytale server 0.7.6". */
    String runtimeVersion();

    /** level is debug, info, warn or error. */
    void log(String level, String message);

    /** True when the host's own permission system grants `node` to the player. */
    boolean hasPermission(UUID player, String node);

    /** A chat line to one player, or to everyone online when player is null. type: info, success, warning, error. */
    void sendMessage(UUID player, String title, String message, String type);

    /**
     * A resource registered a command the host does not know yet. The host may expose it as a
     * native command that forwards to {@link ScriptGoHost#runCommand}; every command also works as
     * {@code /sg <command> ...} regardless.
     */
    default void commandAdded(String name) {
    }

    /** Asks the server to stop (verify runs, once the report is written). */
    void requestShutdown(String reason);
}
