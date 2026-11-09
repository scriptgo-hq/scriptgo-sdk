package scriptgo.jvm;

import org.squiddev.cobalt.Constants;
import org.squiddev.cobalt.LuaError;
import org.squiddev.cobalt.LuaState;
import org.squiddev.cobalt.LuaString;
import org.squiddev.cobalt.LuaTable;
import org.squiddev.cobalt.LuaThread;
import org.squiddev.cobalt.LuaValue;
import org.squiddev.cobalt.ValueFactory;
import org.squiddev.cobalt.Varargs;
import org.squiddev.cobalt.compiler.CompileException;
import org.squiddev.cobalt.compiler.LoadState;
import org.squiddev.cobalt.function.LibFunction;
import org.squiddev.cobalt.function.LuaFunction;
import org.squiddev.cobalt.lib.CoreLibraries;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.Collection;
import java.util.Properties;

/**
 * The one place that talks to Cobalt. Cobalt does not promise a stable API between versions (its
 * README says so), so the version is pinned and every Cobalt call goes through this class, OsLib
 * and ScriptGoHost's native table: an upgrade touches these files only.
 *
 * <p>Not thread-safe: a LuaVm is created and used on one thread (ScriptGoHost's host thread).
 * Coroutines run on that same thread: Cobalt unwinds the Java stack to yield instead of parking a
 * Java thread per coroutine, which is why it was chosen over LuaJ (ADR-0017).
 */
public final class LuaVm {
    public static final String COBALT_VERSION;
    public static final String BRIDGE_VERSION;

    static {
        Properties p = new Properties();
        try (InputStream in = LuaVm.class.getResourceAsStream("/scriptgo-jvm.properties")) {
            if (in != null) p.load(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        COBALT_VERSION = p.getProperty("cobalt.version", "unknown");
        BRIDGE_VERSION = p.getProperty("bridge.version", "unknown");
    }

    private final LuaState state;

    public LuaVm() {
        state = LuaState.builder().build();
        try {
            // debug is needed by the core itself (traceback, and sethook for the execution
            // budget); resources never see it: the core builds their sandbox from scratch.
            CoreLibraries.debugGlobals(state);
        } catch (LuaError e) {
            throw new IllegalStateException("cannot create the Lua state", e);
        }
        LuaTable g = state.globals();
        g.rawset("os", OsLib.create());
        g.rawset("collectgarbage", LibFunction.create((s, opt) -> {
            String o = opt.isNil() ? "collect" : text(opt);
            if (o.equals("count")) {
                Runtime rt = Runtime.getRuntime();
                return ValueFactory.valueOf((rt.totalMemory() - rt.freeMemory()) / 1024.0);
            }
            throw new LuaError("collectgarbage: only \"count\" is available");
        }));
        // print is only reachable from the core's own code; resources get the host's print.
        g.rawset("print", LibFunction.createV((s, args) -> {
            StringBuilder b = new StringBuilder();
            for (int i = 1; i <= args.count(); i++) {
                if (i > 1) b.append('\t');
                b.append(text(args.arg(i)));
            }
            System.out.println(b);
            return Constants.NONE;
        }));
    }

    /** "Cobalt 0.9.9 (Lua 5.2)". */
    public static String luaVersion() {
        return "Cobalt " + COBALT_VERSION + " (Lua 5.2)";
    }

    public LuaState state() {
        return state;
    }

    /** Compiles a text chunk with the global environment. */
    public LuaFunction load(String chunkName, byte[] source) throws LuaError {
        if (source.length > 0 && source[0] == 27) throw new LuaError("binary chunks are not allowed");
        try {
            return LoadState.load(state, new ByteArrayInputStream(source), "@" + chunkName, state.globals());
        } catch (CompileException e) {
            throw new LuaError(e.getMessage());
        }
    }

    /** Calls a function on the main Lua thread and returns its results. */
    public Varargs call(LuaValue fn, LuaValue... args) throws LuaError {
        return LuaThread.runMain(state, fn.checkFunction(), ValueFactory.varargsOf(args));
    }

    // Values ------------------------------------------------------------------------------------------
    // Cobalt's own String conversions are Latin-1; Lua strings here carry UTF-8, so convert by hand.

    public static LuaValue str(String s) {
        return s == null ? Constants.NIL : LuaString.valueOf(s.getBytes(StandardCharsets.UTF_8));
    }

    public static LuaValue bytes(byte[] b) {
        return b == null ? Constants.NIL : LuaString.valueOf(b);
    }

    public static byte[] rawBytes(LuaValue v) throws LuaError {
        LuaString s = v.checkLuaString();
        byte[] out = new byte[s.length()];
        s.copyTo(0, out, 0, out.length);
        return out;
    }

    /** A Lua string (or number) as Java text, decoded as UTF-8; nil is null. */
    public static String text(LuaValue v) throws LuaError {
        if (v.isNil()) return null;
        if (v.type() == Constants.TBOOLEAN) return String.valueOf(v.toBoolean());
        return new String(rawBytes(v), StandardCharsets.UTF_8);
    }

    public static LuaValue num(double d) {
        return ValueFactory.valueOf(d);
    }

    public static LuaValue bool(boolean b) {
        return ValueFactory.valueOf(b);
    }

    public static LuaTable list(Collection<?> items) {
        LuaTable t = new LuaTable(items.size(), 0);
        int i = 1;
        for (Object o : items) {
            LuaValue v = o instanceof Number n ? num(n.doubleValue()) : str(String.valueOf(o));
            t.rawset(i++, v);
        }
        return t;
    }
}
