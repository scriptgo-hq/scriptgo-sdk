namespace ScriptGo.Host.Tests;

/// <summary>The embedding example of sdk/dotnet/README.md, with its paths moved to a temporary folder.</summary>
[TestClass]
public sealed class EmbeddingTests
{
    [TestMethod]
    public void TheReadmeExampleRuns()
    {
        var root = Path.Combine(Path.GetTempPath(), "sg-dotnet-tests", Guid.NewGuid().ToString("N"));
        var resource = Path.Combine(root, "resources", "sg_demo");
        Directory.CreateDirectory(Path.Combine(resource, "server"));
        File.WriteAllText(Path.Combine(resource, "scriptgo.lua"), "resource \"sg_demo\"\nversion \"1.0.0\"\nserver_script \"server/main.ts\"\n");
        File.WriteAllText(Path.Combine(resource, "server", "main.ts.js"), "AddEventHandler('playerJoining', () => ScriptGo.storage.set('greeting', world.greet(ScriptGo.players.name(source))));\n");
        try
        {
            var log = new CaptureLog();
            // --- README ---
            var services = new HostServices
            {
                Log = log,
                Storage = new FolderStorage(Path.Combine(root, "data", "storage")),
            };
            using var host = new ScriptGoHost(services, new HostOptions { Environment = "dotnet" });

            var world = NativeModule.FromJson("""
                { "name": "world", "global": true,
                  "functions": [{ "name": "greet", "params": [{ "name": "who", "type": "string" }], "returns": "string" }] }
                """);
            world.Bind("greet", call => [SgValue.Of($"hi {call.Arg(0).AsText()} from {call.Language}")]);
            host.RegisterNativeModule(world);

            host.AddResource(resource);
            var started = host.Start("sg_demo");
            Assert.IsTrue(started.Ok, started.Reason + "\n" + log);

            host.PlayerJoin(1, "Ann");
            host.RunFor(100);
            host.StopAll();
            // --- end ---
            var storage = Path.Combine(root, "data", "storage");
            Assert.IsTrue(Directory.Exists(storage), "nothing stored\n" + log);
            var stored = Directory.GetFiles(storage).Select(File.ReadAllText).ToList();
            Assert.IsTrue(stored.Any(s => s.Contains("hi Ann from js", StringComparison.Ordinal)), string.Join("\n", stored) + "\n" + log);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch (IOException) { }
        }
    }
}
