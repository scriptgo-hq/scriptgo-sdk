/*
 * Hand-written compile-time stand-in for the Hytale server API (no Hytale code).
 * Only the members the SCRIPT//GO plugin uses, with the shapes seen in public 0.7.x plugins.
 * Never shipped and never on a server: the plugin is built for real against HytaleServer.jar.
 */
package com.hypixel.hytale.server.core;

public class Message {
    public static Message raw(String text) {
        throw new UnsupportedOperationException("stub");
    }

    public Message color(String colour) {
        throw new UnsupportedOperationException("stub");
    }
}
