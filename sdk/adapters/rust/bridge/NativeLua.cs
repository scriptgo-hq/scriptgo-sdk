// KeraLua calls Lua through [DllImport("lua54")], and how a runtime resolves that name differs:
// CoreCLR looks next to the app and in runtimes/<rid>/native; Unity's Mono (Rust's dedicated server)
// looks in its own places. Loading the library once by its full path makes every later lookup find
// the module already in the process (Windows matches loaded modules by base name; glibc matches an
// already loaded object by its SONAME), so the server owner only has to put the file in one of the
// folders listed in sdk/adapters/rust/README.md.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace ScriptGo.Bridge
{
    public static class NativeLua
    {
        private static string _loaded;

        /// <summary>The file name KeraLua's native library has on this OS.</summary>
        public static string FileName
        {
            get
            {
                if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return "lua54.dll";
                if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX)) return "liblua54.dylib";
                return "liblua54.so";
            }
        }

        /// <summary>
        /// Loads the native Lua library from the first folder that holds it. Returns the full path loaded,
        /// or null with the folders tried in <paramref name="error"/>. Calling it again is a no-op.
        /// </summary>
        public static string Preload(IEnumerable<string> folders, out string error)
        {
            error = null;
            if (_loaded != null) return _loaded;
            var tried = new List<string>();
            foreach (var folder in folders)
            {
                if (string.IsNullOrEmpty(folder)) continue;
                var path = Path.GetFullPath(Path.Combine(folder, FileName));
                tried.Add(path);
                if (!File.Exists(path)) continue;
                string why;
                if (Load(path, out why))
                {
                    _loaded = path;
                    return path;
                }
                error = path + ": " + why;
                return null;
            }
            error = FileName + " not found in: " + string.Join(", ", tried);
            return null;
        }

        private static bool Load(string path, out string why)
        {
            why = null;
            try
            {
                if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                {
                    if (LoadLibraryW(path) != IntPtr.Zero) return true;
                    why = "LoadLibrary failed with Win32 error " + Marshal.GetLastWin32Error()
                        + " (the 64-bit lua54.dll from KeraLua's runtimes/win-x64/native is needed)";
                    return false;
                }
                const int RTLD_NOW = 2, RTLD_GLOBAL = 0x100;
                IntPtr handle;
                try { handle = dlopen2(path, RTLD_NOW | RTLD_GLOBAL); }
                catch (DllNotFoundException) { handle = dlopen(path, RTLD_NOW | RTLD_GLOBAL); }
                if (handle != IntPtr.Zero) return true;
                why = "dlopen failed";
                return false;
            }
            catch (Exception e)
            {
                why = e.GetType().Name + ": " + e.Message;
                return false;
            }
        }

        [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadLibraryW(string path);

        [DllImport("libdl.so.2", EntryPoint = "dlopen")]
        private static extern IntPtr dlopen2(string path, int flags);

        [DllImport("libdl", EntryPoint = "dlopen")]
        private static extern IntPtr dlopen(string path, int flags);
    }
}
