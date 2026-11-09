package scriptgo.jvm;

import org.squiddev.cobalt.Constants;
import org.squiddev.cobalt.LuaError;
import org.squiddev.cobalt.LuaTable;
import org.squiddev.cobalt.LuaValue;
import org.squiddev.cobalt.ValueFactory;
import org.squiddev.cobalt.function.LibFunction;

import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.TextStyle;
import java.util.Locale;

/**
 * The part of Lua's os library the core and resources use: time, clock, date and difftime.
 * Cobalt ships no os library (CC: Tweaked provides its own), so this is written here.
 *
 * <p>os.clock is the CPU time of the calling thread, not of the process: the plugin shares its JVM
 * with a busy multi-threaded game server, and the core uses os.clock for its per-resume execution
 * budget, which must not be charged for the server's own threads.
 */
final class OsLib {
    private static final ThreadMXBean THREADS = ManagementFactory.getThreadMXBean();
    private static final boolean THREAD_CPU = THREADS.isCurrentThreadCpuTimeSupported();
    private static final long T0 = System.nanoTime();

    private OsLib() {
    }

    static LuaTable create() {
        LuaTable os = new LuaTable();
        os.rawset("time", LibFunction.create((s, t) -> t.isNil()
            ? ValueFactory.valueOf((double) Math.floorDiv(System.currentTimeMillis(), 1000L))
            : ValueFactory.valueOf((double) timeOf(t.checkTable()))));
        os.rawset("clock", LibFunction.create(s -> ValueFactory.valueOf(clock())));
        os.rawset("difftime", LibFunction.create((s, a, b) -> ValueFactory.valueOf(a.checkDouble() - b.optDouble(0))));
        os.rawset("date", LibFunction.create((s, f, t) -> {
            String format = f.isNil() ? "%c" : LuaVm.text(f);
            long seconds = t.isNil() ? Math.floorDiv(System.currentTimeMillis(), 1000L) : (long) t.checkDouble();
            return date(format, seconds);
        }));
        return os;
    }

    static double clock() {
        if (THREAD_CPU) {
            long ns = THREADS.getCurrentThreadCpuTime();
            if (ns >= 0) return ns / 1e9;
        }
        return (System.nanoTime() - T0) / 1e9;
    }

    private static long timeOf(LuaTable t) throws LuaError {
        int year = field(t, "year", -1), month = field(t, "month", -1), day = field(t, "day", -1);
        if (year < 0 || month < 0 || day < 0) throw new LuaError("field 'day' missing in date table");
        int hour = field(t, "hour", 12), min = field(t, "min", 0), sec = field(t, "sec", 0);
        // Out-of-range fields are normalised as in C's mktime (month 13 is January next year...).
        LocalDateTime ldt = LocalDateTime.of(year, 1, 1, 0, 0, 0)
            .plusMonths(month - 1L).plusDays(day - 1L).plusHours(hour).plusMinutes(min).plusSeconds(sec);
        return ldt.atZone(ZoneId.systemDefault()).toEpochSecond();
    }

    private static int field(LuaTable t, String key, int def) throws LuaError {
        LuaValue v = t.rawget(key);
        if (v.isNil()) return def;
        return (int) v.checkDouble();
    }

    static LuaValue date(String format, long seconds) throws LuaError {
        boolean utc = format.startsWith("!");
        if (utc) format = format.substring(1);
        ZonedDateTime d = Instant.ofEpochSecond(seconds).atZone(utc ? ZoneOffset.UTC : ZoneId.systemDefault());
        if (format.startsWith("*t")) {
            LuaTable t = new LuaTable();
            t.rawset("year", ValueFactory.valueOf(d.getYear()));
            t.rawset("month", ValueFactory.valueOf(d.getMonthValue()));
            t.rawset("day", ValueFactory.valueOf(d.getDayOfMonth()));
            t.rawset("hour", ValueFactory.valueOf(d.getHour()));
            t.rawset("min", ValueFactory.valueOf(d.getMinute()));
            t.rawset("sec", ValueFactory.valueOf(d.getSecond()));
            t.rawset("wday", ValueFactory.valueOf(d.getDayOfWeek().getValue() % 7 + 1));
            t.rawset("yday", ValueFactory.valueOf(d.getDayOfYear()));
            t.rawset("isdst", ValueFactory.valueOf(!utc && d.getZone().getRules().isDaylightSavings(d.toInstant())));
            return t;
        }
        return LuaVm.str(strftime(format, d));
    }

    /** C strftime, "C" locale, for the conversions Lua 5.2 accepts. */
    static String strftime(String format, ZonedDateTime d) throws LuaError {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < format.length(); i++) {
            char c = format.charAt(i);
            if (c != '%') {
                out.append(c);
                continue;
            }
            if (++i >= format.length()) throw new LuaError("bad argument #1 to 'date' (invalid conversion specifier '%')");
            char k = format.charAt(i);
            switch (k) {
                case 'a' -> out.append(d.getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.ROOT));
                case 'A' -> out.append(d.getDayOfWeek().getDisplayName(TextStyle.FULL, Locale.ROOT));
                case 'b', 'h' -> out.append(d.getMonth().getDisplayName(TextStyle.SHORT, Locale.ROOT));
                case 'B' -> out.append(d.getMonth().getDisplayName(TextStyle.FULL, Locale.ROOT));
                case 'c' -> out.append(strftime("%a %b %e %H:%M:%S %Y", d));
                case 'C' -> out.append(two(d.getYear() / 100));
                case 'd' -> out.append(two(d.getDayOfMonth()));
                case 'D' -> out.append(strftime("%m/%d/%y", d));
                case 'e' -> out.append(String.format(Locale.ROOT, "%2d", d.getDayOfMonth()));
                case 'F' -> out.append(strftime("%Y-%m-%d", d));
                case 'H' -> out.append(two(d.getHour()));
                case 'I' -> out.append(two(d.getHour() % 12 == 0 ? 12 : d.getHour() % 12));
                case 'j' -> out.append(String.format(Locale.ROOT, "%03d", d.getDayOfYear()));
                case 'm' -> out.append(two(d.getMonthValue()));
                case 'M' -> out.append(two(d.getMinute()));
                case 'n' -> out.append('\n');
                case 'p' -> out.append(d.getHour() < 12 ? "AM" : "PM");
                case 'r' -> out.append(strftime("%I:%M:%S %p", d));
                case 'R' -> out.append(strftime("%H:%M", d));
                case 'S' -> out.append(two(d.getSecond()));
                case 't' -> out.append('\t');
                case 'T', 'X' -> out.append(strftime("%H:%M:%S", d));
                case 'u' -> out.append(d.getDayOfWeek().getValue());
                case 'w' -> out.append(d.getDayOfWeek() == DayOfWeek.SUNDAY ? 0 : d.getDayOfWeek().getValue());
                case 'x' -> out.append(strftime("%m/%d/%y", d));
                case 'y' -> out.append(two(d.getYear() % 100));
                case 'Y' -> out.append(d.getYear());
                case 'z' -> {
                    int off = d.getOffset().getTotalSeconds() / 60;
                    out.append(off < 0 ? '-' : '+').append(two(Math.abs(off) / 60)).append(two(Math.abs(off) % 60));
                }
                case 'Z' -> out.append(d.getZone().getDisplayName(TextStyle.SHORT, Locale.ROOT));
                case '%' -> out.append('%');
                default -> throw new LuaError("bad argument #1 to 'date' (invalid conversion specifier '%" + k + "')");
            }
        }
        return out.toString();
    }

    private static String two(int n) {
        return n < 10 ? "0" + n : Integer.toString(n);
    }

}
