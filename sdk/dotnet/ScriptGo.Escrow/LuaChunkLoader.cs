// How EscrowContent.LoadLuaChunk reaches the host's own Lua: through luaL_loadbufferx of the Lua
// library the host already loaded. ScriptGo.Escrow links no Lua and ships none.
using System.Reflection;
using System.Runtime.InteropServices;

namespace ScriptGo.Escrow;

/// <summary>
/// A pointer to <c>luaL_loadbufferx</c> of the host's Lua 5.3/5.4 library:
/// <c>int luaL_loadbufferx(lua_State* L, const char* buff, size_t size, const char* name, const char* mode)</c>.
/// Resolve it once and keep it.
/// </summary>
public readonly struct LuaChunkLoader
{
    private LuaChunkLoader(IntPtr functionPointer) => FunctionPointer = functionPointer;

    /// <summary>The address of <c>luaL_loadbufferx</c>.</summary>
    public IntPtr FunctionPointer { get; }

    public bool IsValid => FunctionPointer != IntPtr.Zero;

    /// <summary>From a function pointer the host already has (a C++/CLI host, a custom binding).</summary>
    public static LuaChunkLoader FromFunctionPointer(IntPtr luaLLoadBufferX)
    {
        if (luaLLoadBufferX == IntPtr.Zero) throw new ArgumentException("A null function pointer.", nameof(luaLLoadBufferX));
        return new LuaChunkLoader(luaLLoadBufferX);
    }

    /// <summary>From a native library handle (<see cref="NativeLibrary.Load(string)"/>, <c>dlopen</c>,
    /// <c>LoadLibrary</c>) of the Lua library the host's states come from.</summary>
    public static LuaChunkLoader FromLibrary(IntPtr luaLibraryHandle)
    {
        if (luaLibraryHandle == IntPtr.Zero) throw new ArgumentException("A null library handle.", nameof(luaLibraryHandle));
        if (!NativeLibrary.TryGetExport(luaLibraryHandle, "luaL_loadbufferx", out var pointer))
            throw new EntryPointNotFoundException("luaL_loadbufferx is not exported by that library (is it Lua 5.2 or newer, built as a shared library?).");
        return new LuaChunkLoader(pointer);
    }

    /// <summary>
    /// From the name a .NET Lua binding P/Invokes, resolved the way that binding's assembly resolves
    /// it, so the pointer comes from the very library that created the host's states. For KeraLua:
    /// <c>LuaChunkLoader.FromLibraryName("lua54", typeof(KeraLua.Lua).Assembly)</c>.
    /// </summary>
    public static LuaChunkLoader FromLibraryName(string libraryName, Assembly bindingAssembly) =>
        FromLibrary(NativeLibrary.Load(libraryName, bindingAssembly, null));
}

/// <summary>Outcome of <see cref="EscrowContent.LoadLuaChunk"/>.</summary>
public enum LuaChunkStatus
{
    /// <summary>The compiled function is on top of the Lua stack.</summary>
    Loaded,
    /// <summary>No such encrypted file; nothing was pushed.</summary>
    NotFound,
    /// <summary>Lua refused the chunk; its error message is on top of the Lua stack.</summary>
    LuaError,
}

/// <param name="Status">What happened.</param>
/// <param name="LuaStatus">Lua's own status code (0 = LUA_OK, 3 = LUA_ERRSYNTAX, 4 = LUA_ERRMEM).</param>
public readonly record struct LuaChunkResult(LuaChunkStatus Status, int LuaStatus)
{
    public bool Ok => Status == LuaChunkStatus.Loaded;
}
