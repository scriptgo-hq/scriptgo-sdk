// KeraLua calls Lua through [DllImport("lua54")], and how a runtime resolves that name differs:
// CoreCLR looks next to the app and in runtimes/<rid>/native; Unity's Mono (Rust's dedicated server)
// looks in its own places. Loading the library once by its full path makes every later lookup find
// the module already in the process (Windows matches loaded modules by base name; glibc matches an
// already loaded object by its SONAME), so the server owner only has to put the file in one of the
// folders listed in sdk/adapters/rust/README.md.
//
// The escrow library (scriptgo.dll / libscriptgo.so, sdk/native) is loaded the same way, and only
// when escrow is enabled and an escrowed resource starts. It compiles encrypted scripts by calling
// luaL_loadbufferx of the Lua library the VM itself runs on, so this file also finds that function:
// it asks the VM for the address of one of its own C functions, finds the module that address lives
// in, and takes the export from that module. Two copies of lua54 in one process must never be mixed.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using LuaState = KeraLua.Lua;

namespace ScriptGo.Bridge
{
    public static class NativeLua
    {
        private static string _loaded;
        private static IntPtr _handle;
        private static string _escrowLoaded;

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

        /// <summary>The file name the escrow library (sdk/native) has on this OS.</summary>
        public static string EscrowFileName
        {
            get
            {
                if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return "scriptgo.dll";
                if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX)) return "libscriptgo.dylib";
                return "libscriptgo.so";
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
            IntPtr handle;
            var path = LoadFirst(FileName, folders, null, false, out handle, out error);
            if (path == null) return null;
            _loaded = path;
            _handle = handle;
            return path;
        }

        /// <summary>
        /// Loads the escrow library: from <paramref name="explicitPath"/> when it is set, else from the
        /// first folder that holds it. Returns the full path loaded, or null with the reason. A process
        /// keeps the first copy it loaded: a later call answers that path, as long as the library it was
        /// asked for exists (a missing file is always reported).
        /// </summary>
        public static string PreloadEscrow(IEnumerable<string> folders, string explicitPath, out string error)
        {
            error = null;
            IntPtr handle;
            var path = LoadFirst(EscrowFileName, folders, explicitPath, _escrowLoaded != null, out handle, out error);
            if (path == null) return null;
            if (_escrowLoaded == null) _escrowLoaded = path;
            return _escrowLoaded;
        }

        // The first candidate that exists is loaded; `findOnly` checks that one exists without loading it.
        private static string LoadFirst(string fileName, IEnumerable<string> folders, string explicitPath, bool findOnly, out IntPtr handle, out string error)
        {
            handle = IntPtr.Zero;
            error = null;
            var candidates = new List<string>();
            if (!string.IsNullOrEmpty(explicitPath)) candidates.Add(Path.GetFullPath(explicitPath));
            else
            {
                foreach (var folder in folders ?? new string[0])
                {
                    if (!string.IsNullOrEmpty(folder)) candidates.Add(Path.GetFullPath(Path.Combine(folder, fileName)));
                }
            }
            foreach (var path in candidates)
            {
                if (!File.Exists(path)) continue;
                if (findOnly) return path;
                string why;
                if (Load(path, out handle, out why)) return path;
                error = path + ": " + why;
                return null;
            }
            error = fileName + " not found in: " + (candidates.Count == 0 ? "(no folder given)" : string.Join(", ", candidates));
            return null;
        }

        private static bool Load(string path, out IntPtr handle, out string why)
        {
            why = null;
            handle = IntPtr.Zero;
            try
            {
                if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                {
                    handle = LoadLibraryW(path);
                    if (handle != IntPtr.Zero) return true;
                    why = "LoadLibrary failed with Win32 error " + Marshal.GetLastWin32Error()
                        + " (a 64-bit library is needed: lua54.dll comes from KeraLua's runtimes/win-x64/native)";
                    return false;
                }
                handle = DlOpen(path, RTLD_NOW | RTLD_GLOBAL);
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

        /// <summary>
        /// The address of luaL_loadbufferx in the Lua library <paramref name="lua"/> runs on, or
        /// IntPtr.Zero with the reason. <paramref name="module"/> receives where it was found.
        /// </summary>
        public static IntPtr ResolveLoadBufferX(LuaState lua, out string module, out string error)
        {
            module = null;
            error = null;
            try
            {
                // 1. The module that holds one of the VM's own C functions (`type` is never removed).
                IntPtr probe = IntPtr.Zero;
                int top = lua.GetTop();
                lua.GetGlobal("type");
                var fn = lua.ToCFunction(-1);
                lua.SetTop(top);
                if (fn != null) probe = Marshal.GetFunctionPointerForDelegate(fn);
                IntPtr handle = probe == IntPtr.Zero ? IntPtr.Zero : ModuleOf(probe, out module);
                IntPtr address = handle == IntPtr.Zero ? IntPtr.Zero : Symbol(handle, "luaL_loadbufferx");
                if (address != IntPtr.Zero) return address;

                // 2. The copy this class loaded by full path: the one DllImport("lua54") resolves to when
                //    the runtime matches loaded modules by name (see the header of this file).
                if (_handle != IntPtr.Zero)
                {
                    address = Symbol(_handle, "luaL_loadbufferx");
                    if (address != IntPtr.Zero)
                    {
                        module = _loaded;
                        return address;
                    }
                }
                error = "luaL_loadbufferx was not found in the Lua library this VM runs on"
                    + (module != null ? " (" + module + ")" : "");
                return IntPtr.Zero;
            }
            catch (Exception e)
            {
                error = "cannot locate luaL_loadbufferx: " + e.GetType().Name + ": " + e.Message;
                return IntPtr.Zero;
            }
        }

        // The loaded module an address belongs to, as a handle GetProcAddress / dlsym accepts.
        private static IntPtr ModuleOf(IntPtr address, out string name)
        {
            name = null;
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                const uint FROM_ADDRESS = 0x4, UNCHANGED_REFCOUNT = 0x2;
                IntPtr module;
                if (!GetModuleHandleExW(FROM_ADDRESS | UNCHANGED_REFCOUNT, address, out module) || module == IntPtr.Zero) return IntPtr.Zero;
                var buffer = new char[1024];
                uint n = GetModuleFileNameW(module, buffer, (uint)buffer.Length);
                if (n > 0) name = new string(buffer, 0, (int)n);
                return module;
            }
            DlInfo info;
            if (DlAddr(address, out info) == 0 || info.FileName == IntPtr.Zero) return IntPtr.Zero;
            name = Marshal.PtrToStringAnsi(info.FileName);
            return string.IsNullOrEmpty(name) ? IntPtr.Zero : DlOpen(name, RTLD_NOW | RTLD_NOLOAD);
        }

        private static IntPtr Symbol(IntPtr module, string name)
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return GetProcAddress(module, name);
            try { return dlsym2(module, name); }
            catch (DllNotFoundException) { return dlsym(module, name); }
        }

        private const int RTLD_NOW = 2, RTLD_NOLOAD = 4, RTLD_GLOBAL = 0x100;

        private static IntPtr DlOpen(string path, int flags)
        {
            try { return dlopen2(path, flags); }
            catch (DllNotFoundException) { return dlopen(path, flags); }
        }

        private static int DlAddr(IntPtr address, out DlInfo info)
        {
            try { return dladdr2(address, out info); }
            catch (DllNotFoundException) { return dladdr(address, out info); }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DlInfo
        {
            public IntPtr FileName;
            public IntPtr Base;
            public IntPtr SymbolName;
            public IntPtr SymbolAddress;
        }

        [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadLibraryW(string path);

        [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetModuleHandleExW(uint flags, IntPtr address, out IntPtr module);

        [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetModuleFileNameW(IntPtr module, [Out] char[] buffer, uint size);

        [DllImport("kernel32", CharSet = CharSet.Ansi, ExactSpelling = true, BestFitMapping = false, SetLastError = true)]
        private static extern IntPtr GetProcAddress(IntPtr module, [MarshalAs(UnmanagedType.LPStr)] string name);

        [DllImport("libdl.so.2", EntryPoint = "dlopen")]
        private static extern IntPtr dlopen2(string path, int flags);

        [DllImport("libdl", EntryPoint = "dlopen")]
        private static extern IntPtr dlopen(string path, int flags);

        [DllImport("libdl.so.2", EntryPoint = "dlsym")]
        private static extern IntPtr dlsym2(IntPtr handle, string name);

        [DllImport("libdl", EntryPoint = "dlsym")]
        private static extern IntPtr dlsym(IntPtr handle, string name);

        [DllImport("libdl.so.2", EntryPoint = "dladdr")]
        private static extern int dladdr2(IntPtr address, out DlInfo info);

        [DllImport("libdl", EntryPoint = "dladdr")]
        private static extern int dladdr(IntPtr address, out DlInfo info);
    }
}
