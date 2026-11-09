// Materializes a decrypted escrow resource as a normal local-resource folder for a host that loads
// resources from disk (OPEN//77's ServerResourceHost.Discover reads open77.lua folders and their
// scripts from disk — there is no in-process resource-provider seam a dropped-in DLL could hook).
//
// This is the Option A hand-off for OPEN//77 (sdk/adapters/open77/escrow/PROPOSAL.md): decryption
// happens in C# (EscrowLoader), and the plaintext is written into the operator's resources root so
// OPEN//77 discovers it unchanged — no OPEN//77 core change. HONEST CAVEAT: on OPEN//77 the plaintext
// must land on the operator's own disk (the host reads scripts from there), so code secrecy there is
// license-only-grade; binding, revocation, signing and traceability remain real. Option B keeps the
// plaintext in memory via a core hook (the proposal), and is the only way to avoid the disk write.
using System.Security.Cryptography;

namespace ScriptGo.Host.Escrow;

public static class EscrowMaterializer
{
    /// <summary>Loads an escrowed bundle (verify → wrapped key → decrypt in memory) and writes the
    /// decrypted resource into <paramref name="resourcesRoot"/> as a folder named after the resource,
    /// ready for a disk-reading host to discover. Returns the resource folder, or a failure reason.</summary>
    public static async Task<(bool Ok, string? Reason, string? ResourceDir)> MaterializeAsync(
        byte[] bundle,
        string resourcesRoot,
        EscrowServerIdentity identity,
        IEscrowKeyService keyService,
        string? trustedSignerPublicKey,
        CancellationToken cancellation = default)
    {
        var files = new EscrowResourceFiles();
        var load = await EscrowLoader.LoadAsync(bundle, files, identity, keyService, trustedSignerPublicKey, cancellation).ConfigureAwait(false);
        if (!load.Ok) return (false, load.Reason, null);

        // Read the resource name from the decrypted manifest so the folder matches it.
        var manifestName = ResolveResourceName(files, load.ResourceRoot!);
        if (manifestName is null) return (false, "no_manifest_in_bundle", null);

        var dir = Path.Combine(resourcesRoot, manifestName);
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
            foreach (var relative in files.List(load.ResourceRoot!))
            {
                var bytes = files.Read(load.ResourceRoot!, relative);
                if (bytes is null) continue;
                var full = Path.GetFullPath(Path.Combine(dir, relative.Replace('/', Path.DirectorySeparatorChar)));
                var prefix = Path.GetFullPath(dir) + Path.DirectorySeparatorChar;
                if (!full.StartsWith(prefix, StringComparison.Ordinal)) return (false, "unsafe_path:" + relative, null);
                Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                File.WriteAllBytes(full, bytes);
            }
        }
        catch (IOException e) { return (false, "write_failed:" + e.Message, null); }
        finally { files.Unmount(load.ResourceRoot!); }
        return (true, null, dir);
    }

    private static string? ResolveResourceName(EscrowResourceFiles files, string root)
    {
        foreach (var candidate in Manifest.ManifestParser.ManifestFiles)
        {
            var bytes = files.Read(root, candidate);
            if (bytes is null) continue;
            var parsed = Manifest.ManifestParser.Parse(System.Text.Encoding.UTF8.GetString(bytes), candidate);
            return parsed.Manifest?.Name;
        }
        return null;
    }
}
