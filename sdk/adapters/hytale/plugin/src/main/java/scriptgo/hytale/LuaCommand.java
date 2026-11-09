package scriptgo.hytale;

import com.hypixel.hytale.server.core.Message;
import com.hypixel.hytale.server.core.command.system.AbstractCommand;
import com.hypixel.hytale.server.core.command.system.CommandContext;
import scriptgo.jvm.Commands;
import scriptgo.jvm.ScriptGoHost;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * A Hytale command answered by SCRIPT//GO. Hytale checks no permission of its own: the resource's
 * RegisterCommand(restricted) and /scriptgo's scriptgo.admin are checked by the host, against
 * Hytale permission nodes (scriptgo.admin, scriptgo.command.&lt;name&gt;) or scriptgo.json grants.
 * The whole input after the command name is handed over as one line, as FiveM does.
 */
final class LuaCommand extends AbstractCommand {
    interface Handler {
        /** sender is null for the console; arguments is the text after the command name. */
        CompletableFuture<ScriptGoHost.Result> run(UUID sender, String arguments);
    }

    private static final String RED = "#FF5555";
    private static final String GREY = "#AAAAAA";

    private final Handler handler;

    LuaCommand(String name, String description, Handler handler) {
        super(name, description);
        this.handler = handler;
        requireNoPermission();
        setAllowsExtraArguments(true);
    }

    @Override
    protected CompletableFuture<Void> execute(CommandContext context) {
        UUID sender = context.isPlayer() ? context.sender().getUuid() : null;
        return handler.run(sender, Commands.arguments(context.getInputString())).handle((result, error) -> {
            if (error != null) {
                context.sendMessage(Message.raw("SCRIPT//GO: " + error.getMessage()).color(RED));
            } else if (!result.message().isEmpty()) {
                context.sendMessage(Message.raw(result.message()).color(result.ok() ? GREY : RED));
            }
            return null;
        });
    }
}
