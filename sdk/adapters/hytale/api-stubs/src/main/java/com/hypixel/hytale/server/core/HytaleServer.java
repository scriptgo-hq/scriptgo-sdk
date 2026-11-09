/*
 * Hand-written compile-time stand-in for the Hytale server API (no Hytale code).
 * Only the members the SCRIPT//GO plugin uses, with the shapes seen in public 0.7.x plugins.
 * Never shipped and never on a server: the plugin is built for real against HytaleServer.jar.
 */
package com.hypixel.hytale.server.core;

public class HytaleServer {
    public static HytaleServer get() {
        throw new UnsupportedOperationException("stub");
    }

    public void shutdownServer(ShutdownReason reason) {
        throw new UnsupportedOperationException("stub");
    }
}
