package scriptgo.jvm;

import org.junit.jupiter.api.Test;
import org.squiddev.cobalt.Constants;
import org.squiddev.cobalt.LuaError;
import org.squiddev.cobalt.LuaState;
import org.squiddev.cobalt.LuaTable;
import org.squiddev.cobalt.function.LibFunction;

import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The Lua VM itself: the pinned Cobalt jar, and the SDK's own spec suite running on it. */
class CobaltTest {
    @Test
    void cobaltIsThePinnedJar() throws Exception {
        Path jar = Path.of(LuaState.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(jar)));
        assertEquals(System.getProperty("cobalt.sha256"), sha, "cc.tweaked:cobalt " + LuaVm.COBALT_VERSION + " at " + jar.getFileName());
    }

    /** Exit code of os.exit, carried out of the VM. */
    static final class Exit extends RuntimeException {
        final int code;

        Exit(int code) {
            super("os.exit(" + code + ")");
            this.code = code;
        }
    }

    /**
     * sdk/lua/spec/run.lua (what `node tools/lua-test.mjs` runs on Lua 5.4, 5.1 and LuaJIT) on
     * Cobalt, with the little io it needs supplied by the test.
     */
    @Test
    void sdkSpecSuitePassesOnCobalt() throws Exception {
        Path repo = VerifyModeTest.REPO;
        LuaVm vm = new LuaVm();
        LuaTable g = vm.state().globals();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        LuaTable io = new LuaTable();
        io.rawset("open", LibFunction.createV((s, a) -> {
            Path p = Path.of(LuaVm.text(a.arg(1)));
            if (!Files.isRegularFile(p)) return Constants.NIL;
            byte[] data;
            try {
                data = Files.readAllBytes(p);
            } catch (java.io.IOException e) {
                return Constants.NIL;
            }
            LuaTable f = new LuaTable();
            f.rawset("read", LibFunction.createV((s2, a2) -> LuaVm.bytes(data)));
            f.rawset("close", LibFunction.createV((s2, a2) -> Constants.TRUE));
            return f;
        }));
        io.rawset("write", LibFunction.createV((s, a) -> {
            for (int i = 1; i <= a.count(); i++) out.writeBytes(LuaVm.rawBytes(a.arg(i)));
            return Constants.NONE;
        }));
        g.rawset("io", io);
        g.rawset("loadfile", LibFunction.createV((s, a) -> {
            String path = LuaVm.text(a.arg(1));
            try {
                return vm.load(path, Files.readAllBytes(Path.of(path)));
            } catch (java.io.IOException | LuaError e) {
                return org.squiddev.cobalt.ValueFactory.varargsOf(Constants.NIL, LuaVm.str(e.getMessage()));
            }
        }));
        ((LuaTable) g.rawget("os")).rawset("exit", LibFunction.create((s, code) -> {
            throw new Exit(code.type() == Constants.TBOOLEAN ? (code.toBoolean() ? 0 : 1) : code.optInteger(0));
        }));

        List<String> fixtures = new ArrayList<>();
        try (Stream<Path> l = Files.list(repo.resolve("sdk/lua/spec/fixtures/manifests"))) {
            l.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".lua")).map(n -> n.substring(0, n.length() - 4)).sorted().forEach(fixtures::add);
        }
        List<String> specs = new ArrayList<>();
        try (Stream<Path> l = Files.list(repo.resolve("sdk/lua/spec"))) {
            l.map(p -> p.getFileName().toString()).filter(n -> n.endsWith("_spec.lua")).sorted().forEach(n -> specs.add(slashes(repo.resolve("sdk/lua/spec/" + n))));
        }
        List<org.squiddev.cobalt.LuaValue> args = new ArrayList<>();
        args.add(LuaVm.str(slashes(repo)));
        args.add(LuaVm.str(String.join(",", fixtures)));
        for (String s : specs) args.add(LuaVm.str(s));
        Path runner = repo.resolve("sdk/lua/spec/run.lua");
        int code = -1;
        try {
            vm.call(vm.load(slashes(runner), Files.readAllBytes(runner)), args.toArray(new org.squiddev.cobalt.LuaValue[0]));
        } catch (Exit e) {
            code = e.code;
        } catch (LuaError e) {
            // A Java exception thrown inside a native function arrives wrapped.
            if (e.getCause() instanceof Exit x) code = x.code;
            else throw e;
        }
        String text = out.toString(java.nio.charset.StandardCharsets.UTF_8);
        System.out.println(text);
        assertEquals(0, code, text);
        assertTrue(text.matches("(?s).*Lua 5\\.2: \\d+ tests, 0 failed.*"), text);
    }

    private static String slashes(Path p) {
        return p.toString().replace('\\', '/');
    }
}
