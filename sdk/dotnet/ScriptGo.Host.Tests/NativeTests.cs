namespace ScriptGo.Host.Tests;

/// <summary>Native modules registered from a description, called from Lua and JavaScript.</summary>
[TestClass]
public sealed class NativeTests
{
    private const string Description = """
        {
          "name": "world",
          "description": "A test module.",
          "global": true,
          "functions": [
            { "name": "greet", "params": [{ "name": "who", "type": "string" }], "returns": "string" },
            { "name": "position", "params": [{ "name": "id", "type": "integer" }], "returns": ["number", "number"], "side": "server" },
            { "name": "secret", "permission": "world.secret", "returns": "string" },
            { "name": "clientOnly", "side": "client" },
            { "name": "busy" },
            { "name": "touch", "params": [{ "name": "tags", "type": "string[]?" }] }
          ]
        }
        """;

    private static NativeModule World()
    {
        var m = NativeModule.FromJson(Description);
        m.Bind("greet", c => [SgValue.Of($"hi {c.Arg(0).AsText()} from {c.Language} in {c.Resource}")]);
        m.Bind("position", c => [SgValue.Of(1.5), SgValue.Of(c.Arg(0).AsInteger() * 2.0)]);
        m.Bind("secret", _ => [SgValue.Of("s3cret")]);
        m.Bind("clientOnly", _ => []);
        m.Bind("busy", _ => throw new NativeException("world_busy", "try later"));
        m.Bind("touch", _ => []);
        return m;
    }

    private static Sandbox WithWorld(Func<string, string, bool>? grant = null)
    {
        var sb = new Sandbox(new HostOptions { GrantPermission = grant });
        sb.Host.RegisterNativeModule(World());
        return sb;
    }

    private const string Permissions = "permissions { \"world.secret\" }\n";

    [TestMethod]
    public void LuaCallsNatives()
    {
        using var sb = WithWorld();
        sb.Resource("nat_lua", Sandbox.Manifest("nat_lua", ["server/main.lua"], [], Permissions), ("server/main.lua", """
            print("greet", ScriptGo.natives.world.greet("bob"), world.greet("ann"))
            print("pos", ScriptGo.natives.world.position(21))
            print("bad", ScriptGo.natives.world.greet(5))
            print("secret", ScriptGo.natives.world.secret())
            print("side", ScriptGo.natives.world.clientOnly())
            print("busy", ScriptGo.natives.world.busy())
            print("touch", world.touch(), world.touch({ "a", "b" }), world.touch({ a = 1 }))
            print("readonly", pcall(function() world.greet = nil end))
            """));
        sb.Start("nat_lua");
        var p = sb.Printed;
        var log = sb.Log.ToString();
        CollectionAssert.Contains(p, "greet\thi bob from lua in nat_lua\thi ann from lua in nat_lua", log);
        CollectionAssert.Contains(p, "pos\t1.5\t42.0", log);
        CollectionAssert.Contains(p, "bad\tnil\tinvalid_argument:who\texpected string, got integer", log);
        CollectionAssert.Contains(p, "secret\ts3cret", log);
        CollectionAssert.Contains(p, "side\tnil\tnative_unavailable_on_side:server", log);
        Assert.IsTrue(p.Any(l => l.StartsWith("busy\tnil\tworld_busy", StringComparison.Ordinal)), log);
        CollectionAssert.Contains(p, "touch\ttrue\ttrue\tnil\tinvalid_argument:tags\texpected string[]?, got table", log);
        Assert.IsTrue(p.Any(l => l.StartsWith("readonly\tfalse", StringComparison.Ordinal)), log);
    }

    [TestMethod]
    public void JavaScriptCallsNatives()
    {
        using var sb = WithWorld();
        sb.Resource("nat_js", Sandbox.Manifest("nat_js", ["server/main.js"], [], Permissions), ("server/main.js", """
            const code = (f) => { try { f(); return 'no error'; } catch (e) { return e.name + ' ' + e.code; } };
            print('greet', ScriptGo.natives.world.greet('bob'), world.greet('ann'));
            print('pos', ScriptGo.natives.world.position(21), JSON.stringify(ScriptGo.natives.invoke('world', 'position', 21)));
            print('bad', code(() => world.greet(5)));
            print('detail', (() => { try { world.greet(5); } catch (e) { return e.detail; } })());
            print('secret', world.secret());
            print('side', code(() => world.clientOnly()));
            print('busy', code(() => world.busy()));
            print('missing', code(() => ScriptGo.natives.invoke('world', 'nope')));
            print('touch', world.touch(), code(() => world.touch({ a: 1 })));
            print('modules', JSON.stringify(Object.keys(ScriptGo.natives)));
            print('frozen', code(() => { 'use strict'; ScriptGo.natives.world.greet = null; }));
            """));
        sb.Start("nat_js");
        var p = sb.Printed;
        var log = sb.Log.ToString();
        CollectionAssert.Contains(p, "greet\thi bob from js in nat_js\thi ann from js in nat_js", log);
        CollectionAssert.Contains(p, "pos\t1.5\t[1.5,42]", log);
        CollectionAssert.Contains(p, "bad\tScriptGoError invalid_argument:who", log);
        CollectionAssert.Contains(p, "detail\texpected string, got integer", log);
        CollectionAssert.Contains(p, "secret\ts3cret", log);
        CollectionAssert.Contains(p, "side\tScriptGoError native_unavailable_on_side:server", log);
        CollectionAssert.Contains(p, "busy\tScriptGoError world_busy", log);
        CollectionAssert.Contains(p, "missing\tScriptGoError native_not_found:world.nope", log);
        CollectionAssert.Contains(p, "touch\tundefined\tScriptGoError invalid_argument:tags", log);
        CollectionAssert.Contains(p, "modules\t[\"world\"]", log);
        Assert.IsTrue(p.Any(l => l.StartsWith("frozen\tTypeError", StringComparison.Ordinal)), log);
    }

    [TestMethod]
    public void APermissionMustBeDeclaredAndGranted()
    {
        // Not declared in the manifest: refused even though the operator grants everything.
        using (var sb = WithWorld())
        {
            sb.Server("nat_undeclared", ("server/main.lua", "print('secret', ScriptGo.natives.world.secret())"));
            sb.Start("nat_undeclared");
            CollectionAssert.Contains(sb.Printed, "secret\tnil\tpermission_denied:world.secret", sb.Log.ToString());
        }
        // Declared, but the operator does not grant it.
        using (var sb = WithWorld((res, perm) => !(res == "nat_refused" && perm == "world.secret")))
        {
            sb.Resource("nat_refused", Sandbox.Manifest("nat_refused", ["server/main.js"], [], Permissions),
                ("server/main.js", "try { world.secret(); } catch (e) { print('secret', e.code); }"));
            sb.Start("nat_refused");
            CollectionAssert.Contains(sb.Printed, "secret\tpermission_denied:world.secret", sb.Log.ToString());
        }
    }

    [TestMethod]
    public void RegistrationIsValidated()
    {
        using var sb = new Sandbox();
        var unbound = NativeModule.FromJson("""{ "name": "m", "functions": [{ "name": "f" }] }""");
        StringAssert.Contains(Assert.ThrowsExactly<ArgumentException>(() => sb.Host.RegisterNativeModule(unbound)).Message, "no handler bound");
        var reserved = NativeModule.FromJson("""{ "name": "exports", "global": true, "functions": [] }""");
        StringAssert.Contains(Assert.ThrowsExactly<ArgumentException>(() => sb.Host.RegisterNativeModule(reserved)).Message, "cannot be a global");
        var invoke = NativeModule.FromJson("""{ "name": "invoke", "functions": [] }""");
        StringAssert.Contains(Assert.ThrowsExactly<ArgumentException>(() => sb.Host.RegisterNativeModule(invoke)).Message, "reserved");
        var badType = NativeModule.FromJson("""{ "name": "m2", "functions": [{ "name": "f", "params": [{ "name": "x", "type": "vector" }] }] }""").Bind("f", _ => []);
        StringAssert.Contains(Assert.ThrowsExactly<ArgumentException>(() => sb.Host.RegisterNativeModule(badType)).Message, "unknown type 'vector'");
    }

    [TestMethod]
    public void TypingsAreGeneratedFromTheDescription()
    {
        var m = World();
        var ts = m.ToTypeScript();
        StringAssert.Contains(ts, "greet(who: string): string");
        var lua = m.ToLuaAnnotations();
        StringAssert.Contains(lua, "---@param who string");
    }
}
