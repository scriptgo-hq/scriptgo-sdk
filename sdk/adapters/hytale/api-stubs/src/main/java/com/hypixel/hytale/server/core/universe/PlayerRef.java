/*
 * Hand-written compile-time stand-in for the Hytale server API (no Hytale code).
 * Only the members the SCRIPT//GO plugin uses, with the shapes seen in public 0.7.x plugins.
 * Never shipped and never on a server: the plugin is built for real against HytaleServer.jar.
 */
package com.hypixel.hytale.server.core.universe;

import com.hypixel.hytale.server.core.Message;

import java.util.UUID;

public class PlayerRef {
    public UUID getUuid() {
        throw new UnsupportedOperationException("stub");
    }

    public String getUsername() {
        throw new UnsupportedOperationException("stub");
    }

    public void sendMessage(Message message) {
        throw new UnsupportedOperationException("stub");
    }
}
