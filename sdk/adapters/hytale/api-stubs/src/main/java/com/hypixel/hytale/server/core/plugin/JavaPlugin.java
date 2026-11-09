/*
 * Hand-written compile-time stand-in for the Hytale server API (no Hytale code).
 * Only the members the SCRIPT//GO plugin uses, with the shapes seen in public 0.7.x plugins.
 * Never shipped and never on a server: the plugin is built for real against HytaleServer.jar.
 */
package com.hypixel.hytale.server.core.plugin;

import com.hypixel.hytale.event.EventRegistry;
import com.hypixel.hytale.logger.HytaleLogger;
import com.hypixel.hytale.server.core.command.system.CommandRegistry;

import java.nio.file.Path;

public abstract class JavaPlugin {
    protected JavaPlugin(JavaPluginInit init) {
    }

    protected void setup() {
    }

    protected void start() {
    }

    protected void shutdown() {
    }

    public Path getDataDirectory() {
        throw new UnsupportedOperationException("stub");
    }

    public HytaleLogger getLogger() {
        throw new UnsupportedOperationException("stub");
    }

    public EventRegistry getEventRegistry() {
        throw new UnsupportedOperationException("stub");
    }

    public CommandRegistry getCommandRegistry() {
        throw new UnsupportedOperationException("stub");
    }
}
