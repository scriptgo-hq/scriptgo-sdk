// An IResourceFiles that serves opened escrow releases (ScriptGo.Escrow's EscrowContent) and
// delegates everything else to a fallback provider (folders on disk).
//
// Three kinds of file, three paths:
//  - clear files (the manifest, docs, creator-named config): public, served as ordinary bytes;
//  - encrypted LUA scripts on the native backend: never served as bytes to the host. This class is
//    also an INativeLuaChunks, so the host has libscriptgo compile them straight into the guest's
//    lua_State. The plaintext is not a managed string or array at any point;
//  - everything else that is encrypted (JavaScript and compiled TypeScript for Jint, data files a
//    resource reads): served through EscrowContent.ReadAllBytes, the managed door. Jint takes
//    managed source, so for those guests the plaintext does enter the managed heap, and we say so.
using System.Collections.Concurrent;
using ScriptGo.Escrow;

namespace ScriptGo.Host;

public sealed class EscrowResourceFiles : IResourceFiles, INativeLuaChunks
{
    private const string Prefix = "escrow://";

    // KeraLua's own Lua library: the pointer must come from the library that created the guest's states.
    private static readonly Lazy<LuaChunkLoader> Loader = new(() => LuaChunkLoader.FromLibraryName("lua54", typeof(KeraLua.Lua).Assembly));

    private readonly IResourceFiles _fallback;
    private readonly ConcurrentDictionary<string, EscrowContent> _mounts = new(StringComparer.Ordinal);

    public EscrowResourceFiles(IResourceFiles? fallback = null) => _fallback = fallback ?? new FolderFiles();

    /// <summary>Mounts an opened release under a virtual root and returns that root. Pass the root to
    /// host.AddResource(root, checkFolderName: false); the manifest inside names the resource. The
    /// content stays owned by the caller, who disposes it after unmounting.</summary>
    public string Mount(EscrowContent content)
    {
        var slug = new string(content.Manifest.Package.Select(c => char.IsLetterOrDigit(c) ? c : '_').ToArray());
        var root = $"{Prefix}{slug}/{content.Manifest.Version}";
        _mounts[root] = content;
        return root;
    }

    public void Unmount(string root) => _mounts.TryRemove(root, out _);

    /// <summary>The release mounted at <paramref name="root"/>, if any.</summary>
    public EscrowContent? ContentAt(string root) => TryMount(root, out var content) ? content : null;

    public byte[]? Read(string root, string relativePath)
    {
        if (!TryMount(root, out var content)) return _fallback.Read(root, relativePath);
        if (content.ClearFiles.TryGetValue(relativePath, out var clear)) return (byte[])clear.Clone();
        if (content.State == EscrowLeaseState.Revoked || !content.TryGetSize(relativePath, out _)) return null;
        // The managed door: needed for JavaScript guests and for data files a resource reads.
        try { return content.ReadAllBytes(relativePath); }
        catch (EscrowException) { return null; } // revoked between the check and the read
    }

    public IReadOnlyList<string> List(string root)
    {
        if (!TryMount(root, out var content)) return _fallback.List(root);
        var names = new SortedSet<string>(content.ClearFiles.Keys, StringComparer.Ordinal);
        foreach (var entry in content.EncryptedEntries) names.Add(entry.Path);
        if (content.DeliveryWatermark is not null) names.Add(EscrowFormat.DeliveryMarker);
        return names.ToList();
    }

    public bool HasNativeChunk(string root, string relativePath) =>
        TryMount(root, out var content)
        && content.Backend == EscrowBackend.Native
        && content.State != EscrowLeaseState.Revoked
        && relativePath.EndsWith(".lua", StringComparison.Ordinal)
        && content.ContainsEncrypted(relativePath);

    public NativeChunkStatus LoadChunk(string root, string relativePath, IntPtr luaState, string chunkName)
    {
        if (!TryMount(root, out var content)) return NativeChunkStatus.NotFound;
        LuaChunkResult result;
        try { result = content.LoadLuaChunk(luaState, relativePath, chunkName, Loader.Value); }
        catch (EscrowException) { return NativeChunkStatus.NotFound; } // revoked: the resource is being stopped
        return result.Status switch
        {
            LuaChunkStatus.Loaded => NativeChunkStatus.Loaded,
            LuaChunkStatus.LuaError => NativeChunkStatus.LuaError,
            _ => NativeChunkStatus.NotFound,
        };
    }

    private bool TryMount(string root, out EscrowContent content)
    {
        if (root.StartsWith(Prefix, StringComparison.Ordinal) && _mounts.TryGetValue(root, out var m)) { content = m; return true; }
        content = null!;
        return false;
    }
}
