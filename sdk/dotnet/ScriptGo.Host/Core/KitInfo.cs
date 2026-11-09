using System.Reflection;

namespace ScriptGo.Host;

/// <summary>Versions of the kit and of the engines it embeds, for reports and diagnostics.</summary>
public static class KitInfo
{
    public static string Kit => ScriptGoHost.KitVersion;

    /// <summary>The .NET runtime the host process runs on.</summary>
    public static string Dotnet => System.Environment.Version.ToString();

    /// <summary>The Jint package (JavaScript guests).</summary>
    public static string Jint => PackageVersion(typeof(global::Jint.Engine).Assembly);

    /// <summary>The KeraLua package (Lua guests).</summary>
    public static string KeraLua => PackageVersion(typeof(global::KeraLua.Lua).Assembly);

    /// <summary>The Lua language version of the native library KeraLua loads (e.g. "Lua 5.4").</summary>
    public static string Lua { get; } = ReadLuaVersion();

    /// <summary>One line for a report: ".NET 10.0.0; KeraLua 1.4.9 (Lua 5.4); Jint 4.17.0".</summary>
    public static string Runtime => $".NET {Dotnet}; KeraLua {KeraLua} ({Lua}); Jint {Jint}";

    private static string PackageVersion(Assembly a)
    {
        var v = a.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? a.GetName().Version?.ToString() ?? "?";
        var plus = v.IndexOf('+');
        return plus >= 0 ? v[..plus] : v;
    }

    private static string ReadLuaVersion()
    {
        try
        {
            using var l = new global::KeraLua.Lua(openLibs: true);
            l.GetGlobal("_VERSION");
            return l.ToString(-1) ?? "Lua";
        }
        catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
        {
            return "Lua (native library unavailable)";
        }
    }
}
