// Where libscriptgo comes from at run time, and whether it can be used.
//
// Search order (first hit wins), each an ABSOLUTE path so the OS never walks PATH or the current
// directory for it:
//   1. the path given to EscrowNativeLibrary.UseLibraryAt, if any;
//   2. <directory of ScriptGo.Escrow.dll>/runtimes/<rid>/native/<file>   (NuGet layout, project reference)
//   3. <directory of ScriptGo.Escrow.dll>/<file>                         (RID-specific publish)
//   4. the same two under AppContext.BaseDirectory                       (single-file, shadow copies)
//   5. the runtime's own resolution for the assembly (deps.json), without PATH.
//
// Honest note: this keeps a stray scriptgo.dll on PATH from being picked up by accident. It does
// not stop the operator of the machine from replacing the library next to the host: they control
// the host. Escrow is deterrence, traceability and revocation (docs/spec/escrow.md).
using System.Reflection;
using System.Runtime.InteropServices;
using ScriptGo.Escrow.Native;

namespace ScriptGo.Escrow;

/// <summary>State of the native escrow library (libscriptgo) in this process.</summary>
public static class EscrowNativeLibrary
{
    private static readonly object Gate = new();
    private static string? _explicitPath;
    private static string? _loadedFrom;
    private static bool _probed;
    private static string? _error;
    private static string? _version;

    /// <summary>Loads the library from this exact file instead of searching for it. Call it before
    /// anything else in this package; it has no effect once the library is loaded.</summary>
    public static void UseLibraryAt(string absolutePath)
    {
        if (!Path.IsPathFullyQualified(absolutePath)) throw new ArgumentException("An absolute path is required.", nameof(absolutePath));
        lock (Gate)
        {
            if (_probed) throw new InvalidOperationException("The native escrow library was already located; call UseLibraryAt first.");
            _explicitPath = absolutePath;
        }
    }

    /// <summary>True when libscriptgo is present, has the expected ABI and can run on this CPU.</summary>
    public static bool IsAvailable => Probe() is null;

    /// <summary>Why the native backend cannot be used, or null when it can.</summary>
    public static string? UnavailableReason => Probe();

    /// <summary>The file the library was loaded from, once loaded (null when the runtime resolved it itself).</summary>
    public static string? LoadedFrom { get { Probe(); return _loadedFrom; } }

    /// <summary>The library's own version string, once loaded.</summary>
    public static string? Version { get { Probe(); return _version; } }

    /// <summary>The file name of the library on this operating system.</summary>
    public static string FileName =>
        OperatingSystem.IsWindows() ? "scriptgo.dll" : OperatingSystem.IsMacOS() ? "libscriptgo.dylib" : "libscriptgo.so";

    /// <summary>The runtime identifier whose <c>runtimes/&lt;rid&gt;/native</c> folder is searched.</summary>
    public static string RuntimeIdentifier
    {
        get
        {
            var os = OperatingSystem.IsWindows() ? "win" : OperatingSystem.IsMacOS() ? "osx" : "linux";
            var arch = RuntimeInformation.ProcessArchitecture switch
            {
                Architecture.X64 => "x64",
                Architecture.Arm64 => "arm64",
                Architecture.X86 => "x86",
                Architecture.Arm => "arm",
                var other => other.ToString().ToLowerInvariant(),
            };
            return $"{os}-{arch}";
        }
    }

    /// <summary>Throws an <see cref="EscrowException"/> that says what is missing and how to get it.</summary>
    internal static void EnsureAvailable()
    {
        var reason = Probe();
        if (reason is not null) throw new EscrowException(EscrowFailure.NativeLibraryUnavailable, "native_library_unavailable:" + reason);
    }

    private static string? Probe()
    {
        if (_probed) return _error;
        lock (Gate)
        {
            if (_probed) return _error;
            try
            {
                var abi = EscrowNative.sg_abi_version();
                if (abi != EscrowNative.ExpectedAbi)
                {
                    _error = $"{FileName} has ABI {abi}, this package needs ABI {EscrowNative.ExpectedAbi}. Use the library that ships with this version of ScriptGo.Escrow.";
                }
                else
                {
                    var init = EscrowNative.sg_init();
                    if (init != EscrowNative.Ok) _error = EscrowNative.ErrorText(init);
                    else _version = Marshal.PtrToStringUTF8(EscrowNative.sg_version_string());
                }
            }
            catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
            {
                _error = $"{FileName} was not found for {RuntimeIdentifier} ({e.GetType().Name}). "
                    + $"It ships in the ScriptGo.Escrow package under runtimes/{RuntimeIdentifier}/native/, or is built from sdk/native "
                    + "(build.ps1 on Windows). To run without it, opt in to EscrowBackend.Managed, which decrypts in managed memory and is weaker against memory inspection.";
            }
            _probed = true;
            return _error;
        }
    }

    internal static IntPtr Resolve(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (libraryName != EscrowNative.Library) return IntPtr.Zero;
        foreach (var candidate in Candidates(assembly))
        {
            if (!File.Exists(candidate)) continue;
            if (NativeLibrary.TryLoad(candidate, out var handle))
            {
                _loadedFrom = candidate;
                return handle;
            }
        }
        if (_explicitPath is not null) return IntPtr.Zero;
        // The runtime's own probing for this assembly (deps.json native assets), never PATH.
        return NativeLibrary.TryLoad(libraryName, assembly, DllImportSearchPath.AssemblyDirectory, out var fallback) ? fallback : IntPtr.Zero;
    }

    private static IEnumerable<string> Candidates(Assembly assembly)
    {
        if (_explicitPath is not null)
        {
            yield return _explicitPath;
            yield break; // an explicit path is exclusive: a missing file must fail, not fall through
        }
        var directories = new List<string>();
        var assemblyDirectory = Path.GetDirectoryName(assembly.Location);
        if (!string.IsNullOrEmpty(assemblyDirectory)) directories.Add(assemblyDirectory);
        if (!string.IsNullOrEmpty(AppContext.BaseDirectory)) directories.Add(AppContext.BaseDirectory);
        foreach (var directory in directories.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            yield return Path.Combine(directory, "runtimes", RuntimeIdentifier, "native", FileName);
            yield return Path.Combine(directory, FileName);
        }
    }
}
