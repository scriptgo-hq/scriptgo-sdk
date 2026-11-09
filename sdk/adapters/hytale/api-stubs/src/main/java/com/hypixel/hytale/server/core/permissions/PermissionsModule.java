/*
 * Hand-written compile-time stand-in for the Hytale server API (no Hytale code).
 * Only the members the SCRIPT//GO plugin uses, with the shapes seen in public 0.7.x plugins.
 * Never shipped and never on a server: the plugin is built for real against HytaleServer.jar.
 */
package com.hypixel.hytale.server.core.permissions;

import java.util.UUID;

public class PermissionsModule {
    public static PermissionsModule get() {
        throw new UnsupportedOperationException("stub");
    }

    public boolean hasPermission(UUID player, String node) {
        throw new UnsupportedOperationException("stub");
    }
}
