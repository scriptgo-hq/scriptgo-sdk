package scriptgo.jvm;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** How the plugin cuts a Hytale command input into the line handed to the host (plain JVM). */
class CommandsTest {
    @Test
    void argumentsAreEverythingAfterTheName() {
        assertEquals("3 water", Commands.arguments("/give 3 water"));
        assertEquals("3  water", Commands.arguments("give\t3  water "));
        assertEquals("", Commands.arguments("/sg"));
        assertEquals("", Commands.arguments(""));
        assertEquals("", Commands.arguments(null));
        assertEquals("hello wörld 魔", Commands.arguments("sg hello wörld 魔"));
    }

    @Test
    void onlySimpleLowercaseNamesBecomeHytaleCommands() {
        assertTrue(Commands.isValidName("give"));
        assertTrue(Commands.isValidName("sg_shop-2"));
        assertFalse(Commands.isValidName("giveWeapon"));
        assertFalse(Commands.isValidName("2fast"));
        assertFalse(Commands.isValidName("a b"));
        assertFalse(Commands.isValidName(""));
        assertFalse(Commands.isValidName(null));
    }

    @Test
    void listing() {
        assertEquals("none", Commands.listing(List.of()));
        assertEquals("/a, /b", Commands.listing(List.of("a", "b")));
    }
}
