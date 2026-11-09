// SPDX-License-Identifier: MIT
//
// The cc-core harness: ONE CC: Tweaked computer, run by the CC: Tweaked core classes and the Cobalt
// Lua VM taken from the same mod jar a Minecraft server loads, with the jar's own bios.lua and ROM,
// but WITHOUT Minecraft. It is an emulator for fast tests of the adapter: it is never evidence that
// the environment works in Minecraft, and `scriptgo verify --env cctweaked` never uses it.
//
//   java -cp <cc-tweaked.jar>:<cobalt.jar>:<slf4j-api.jar>:<slf4j-nop.jar>:<classes> CcCoreRun \
//        --jar <cc-tweaked.jar> --computer <dir> [--seconds 30] [--until <file in dir>] [--id 0]
//
// <dir> is the computer's root folder (what a world keeps in computercraft/computer/<id>/); the
// computer boots from the jar's BIOS and runs <dir>/startup.lua like a placed computer would. The
// run ends when the computer shuts itself down, when --until exists, or after --seconds. The
// terminal's last screen is printed, then `CCCORE exit=<on|off> ticks=<n>`.
//
// _HOST reads "ComputerCraft <version> (SCRIPT//GO cc-core harness, no Minecraft)", so nothing that
// ran here can pass for a run in Minecraft.
import dan200.computercraft.api.filesystem.Mount;
import dan200.computercraft.api.filesystem.WritableMount;
import dan200.computercraft.core.ComputerContext;
import dan200.computercraft.core.computer.Computer;
import dan200.computercraft.core.computer.ComputerEnvironment;
import dan200.computercraft.core.computer.GlobalEnvironment;
import dan200.computercraft.core.computer.mainthread.NoWorkMainThreadScheduler;
import dan200.computercraft.core.filesystem.JarMount;
import dan200.computercraft.core.filesystem.WritableFileMount;
import dan200.computercraft.core.metrics.MetricsObserver;
import dan200.computercraft.core.terminal.Terminal;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;
import java.util.jar.JarFile;

public final class CcCoreRun {
    public static void main(String[] args) throws Exception {
        String jarPath = null, computerDir = null, until = null;
        int seconds = 30, id = 0;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--jar" -> jarPath = args[++i];
                case "--computer" -> computerDir = args[++i];
                case "--seconds" -> seconds = Integer.parseInt(args[++i]);
                case "--until" -> until = args[++i];
                case "--id" -> id = Integer.parseInt(args[++i]);
                default -> throw new IllegalArgumentException("unknown argument " + args[i]);
            }
        }
        if (jarPath == null || computerDir == null) {
            System.err.println("usage: CcCoreRun --jar <cc-tweaked.jar> --computer <dir> [--seconds 30] [--until <file>] [--id 0]");
            System.exit(2);
        }

        File jar = new File(jarPath);
        String jarVersion;
        byte[] bios;
        try (JarFile jf = new JarFile(jar)) {
            jarVersion = jf.getManifest().getMainAttributes().getValue("Implementation-Version");
            try (InputStream in = jf.getInputStream(jf.getEntry("data/computercraft/lua/bios.lua"))) {
                bios = in.readAllBytes();
            }
        }
        String version = jarVersion == null ? "unknown" : jarVersion;
        JarMount rom = new JarMount(jar, "data/computercraft/lua/rom");
        String host = "ComputerCraft " + version + " (SCRIPT//GO cc-core harness, no Minecraft)";

        GlobalEnvironment global = new GlobalEnvironment() {
            @Override public String getHostString() { return host; }
            @Override public String getUserAgent() { return "computercraft/" + version; }
            @Override public Mount getRomMount() { return rom; }
            @Override public InputStream getLuaBios() { return new ByteArrayInputStream(bios); }
        };
        File root = new File(computerDir);
        ComputerEnvironment env = new ComputerEnvironment() {
            @Override public int getDay() { return 1; }
            @Override public double getTimeOfDay() { return 6.0; }
            @Override public MetricsObserver getMetrics() { return MetricsObserver.discard(); }
            // The default computer space of a CC: Tweaked server (computer_space_limit).
            @Override public WritableMount createRootMount() { return new WritableFileMount(root, 1_000_000); }
        };

        ComputerContext context = ComputerContext.builder(global)
            .computerThreads(1)
            .mainThreadScheduler(new NoWorkMainThreadScheduler())
            .build();
        Terminal term = new Terminal(51, 19, true);
        Computer computer = new Computer(context, env, term, id);
        computer.turnOn();

        File stopFile = until == null ? null : new File(root, until);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        int ticks = 0;
        boolean wasOn = false;
        while (System.nanoTime() < deadline) {
            computer.tick();
            ticks++;
            Thread.sleep(50); // one Minecraft server tick
            if (computer.isOn()) wasOn = true;
            if (wasOn && !computer.isOn()) break;
            if (stopFile != null && stopFile.isFile()) {
                // Let the computer finish what it was doing after writing the file.
                for (int i = 0; i < 10 && computer.isOn(); i++) { computer.tick(); ticks++; Thread.sleep(50); }
                break;
            }
        }
        boolean on = computer.isOn();
        for (int y = 0; y < term.getHeight(); y++) {
            String line = term.getLine(y).toString().replaceAll("\\s+$", "");
            System.out.println("CCTERM " + line);
        }
        System.out.println("CCCORE host=" + host + " exit=" + (on ? "on" : "off") + " ticks=" + ticks);
        computer.shutdown();
        for (int i = 0; i < 5; i++) { computer.tick(); Thread.sleep(20); }
        computer.unload();
        try {
            context.ensureClosed(5, TimeUnit.SECONDS);
        } catch (IllegalStateException e) {
            System.out.println("CCCORE close: " + e.getMessage());
        }
        try { rom.close(); } catch (IOException ignored) { }
        System.exit(0);
    }
}
