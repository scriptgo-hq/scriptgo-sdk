package scriptgo.jvm;

import java.util.Collection;
import java.util.regex.Pattern;

/** Command-line helpers shared by the plugin's commands, kept here so they are tested on a plain JVM. */
public final class Commands {
    /** Names registered as real Hytale commands; anything else is reached through /sg. */
    private static final Pattern NAME = Pattern.compile("[a-z][a-z0-9_-]{0,31}");

    private Commands() {
    }

    /** The text after the command name: "/give 3 water" and "give  3 water" both give "3 water". */
    public static String arguments(String input) {
        String s = input == null ? "" : input.strip();
        if (s.startsWith("/")) s = s.substring(1);
        for (int i = 0; i < s.length(); i++) {
            if (Character.isWhitespace(s.charAt(i))) return s.substring(i).strip();
        }
        return "";
    }

    public static boolean isValidName(String name) {
        return name != null && NAME.matcher(name).matches();
    }

    public static String listing(Collection<String> names) {
        if (names.isEmpty()) return "none";
        StringBuilder b = new StringBuilder();
        for (String n : names) {
            if (b.length() > 0) b.append(", ");
            b.append('/').append(n);
        }
        return b.toString();
    }
}
