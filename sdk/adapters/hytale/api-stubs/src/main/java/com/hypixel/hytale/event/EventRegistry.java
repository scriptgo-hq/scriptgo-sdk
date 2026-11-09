/*
 * Hand-written compile-time stand-in for the Hytale server API (no Hytale code).
 * Only the members the SCRIPT//GO plugin uses, with the shapes seen in public 0.7.x plugins.
 * Never shipped and never on a server: the plugin is built for real against HytaleServer.jar.
 */
package com.hypixel.hytale.event;

import java.util.function.Consumer;

public class EventRegistry {
    public <E> Object registerGlobal(Class<E> type, Consumer<E> handler) {
        throw new UnsupportedOperationException("stub");
    }
}
