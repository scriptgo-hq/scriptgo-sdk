// An IResourceFiles that serves decrypted escrow resources from memory and delegates everything else
// to a fallback provider (folders on disk). This is the host's own seam (IResourceFiles.Read/List):
// the decrypted plaintext stays in managed memory and reaches the host through the same path as a
// local folder — never written to disk, never passed through the KeraLua VM for decryption.
using System.Collections.Concurrent;

namespace ScriptGo.Host.Escrow;

public sealed class EscrowResourceFiles : IResourceFiles
{
    private readonly IResourceFiles _fallback;
    private readonly ConcurrentDictionary<string, IReadOnlyDictionary<string, byte[]>> _mounts = new(StringComparer.Ordinal);
    private const string Prefix = "escrow://";

    public EscrowResourceFiles(IResourceFiles? fallback = null) => _fallback = fallback ?? new FolderFiles();

    /// <summary>Mounts a decrypted file map under a virtual root and returns that root. Pass the root to
    /// host.AddResource(root, checkFolderName: false); the manifest inside names the resource.</summary>
    public string Mount(string package, string version, IReadOnlyDictionary<string, byte[]> files)
    {
        var slug = new string(package.Select(c => char.IsLetterOrDigit(c) ? c : '_').ToArray());
        var root = $"{Prefix}{slug}/{version}";
        _mounts[root] = files;
        return root;
    }

    public void Unmount(string root) => _mounts.TryRemove(root, out _);

    public byte[]? Read(string root, string relativePath)
    {
        if (TryMount(root, out var files))
            return files.TryGetValue(relativePath, out var bytes) ? (byte[])bytes.Clone() : null;
        return _fallback.Read(root, relativePath);
    }

    public IReadOnlyList<string> List(string root)
    {
        if (TryMount(root, out var files)) return files.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
        return _fallback.List(root);
    }

    private bool TryMount(string root, out IReadOnlyDictionary<string, byte[]> files)
    {
        if (root.StartsWith(Prefix, StringComparison.Ordinal) && _mounts.TryGetValue(root, out var m)) { files = m; return true; }
        files = null!;
        return false;
    }
}
