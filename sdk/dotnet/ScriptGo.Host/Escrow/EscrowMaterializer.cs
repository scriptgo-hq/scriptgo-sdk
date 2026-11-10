// THE LICENSE-ONLY-GRADE FALLBACK. Materializes a decrypted escrow resource as a normal
// local-resource folder, for a host that can only load resources from disk (OPEN//77's
// ServerResourceHost.Discover reads open77.lua folders and their scripts from disk: there is no
// in-process resource-provider seam a dropped-in DLL could hook).
//
// This is the Option A hand-off for OPEN//77 (sdk/adapters/open77/escrow/README.md, "The fallback loader"). The key is
// released only to a licensed, bound server and the unwrap and the decryption happen in
// libscriptgo (on the native backend), but the plaintext then has to be written into the operator's own resources
// directory. So there is NO code-secrecy claim on this path: it is license-only grade. What still
// holds is binding (a leaked encrypted copy will not open on an unbound server), revocation of
// future key releases, signing and the delivery marker. A host that can load from memory should
// use EscrowLoader instead (Option B on OPEN//77): that keeps the scripts off the disk.
using ScriptGo.Escrow;

namespace ScriptGo.Host;

public static class EscrowMaterializer
{
    /// <summary>Opens an escrowed bundle and writes the decrypted resource into
    /// <paramref name="resourcesRoot"/> as a folder named after the resource, ready for a disk-reading
    /// host to discover. Returns the resource folder, or a failure reason. Nothing is written when the
    /// key is refused.</summary>
    public static async Task<(bool Ok, string? Reason, string? ResourceDir)> MaterializeAsync(
        byte[] bundle,
        string resourcesRoot,
        EscrowIdentity identity,
        IEscrowKeyService keyService,
        string? trustedSignerPublicKey,
        CancellationToken cancellation = default)
    {
        EscrowContent content;
        try { content = await EscrowSession.OpenAsync(bundle, identity, keyService, trustedSignerPublicKey, null, cancellation).ConfigureAwait(false); }
        catch (EscrowException e) { return (false, e.Reason, null); }

        using (content)
        {
            // The resource's folder is named after the manifest, which is a clear file.
            var manifestName = ResolveResourceName(content);
            if (manifestName is null) return (false, "no_manifest_in_bundle", null);
            if (!EscrowPaths.IsSafe(manifestName) || manifestName.Contains('/')) return (false, "unsafe_path:" + manifestName, null);

            var dir = Path.Combine(resourcesRoot, manifestName);
            try { EscrowDiskFallback.WriteTo(content, dir); }
            catch (InvalidDataException e) { return (false, "unsafe_path:" + e.Message, null); }
            catch (IOException e) { return (false, "write_failed:" + e.Message, null); }
            catch (UnauthorizedAccessException e) { return (false, "write_failed:" + e.Message, null); }
            return (true, null, dir);
        }
    }

    private static string? ResolveResourceName(EscrowContent content)
    {
        foreach (var candidate in Manifest.ManifestParser.ManifestFiles)
        {
            if (!content.ClearFiles.TryGetValue(candidate, out var bytes)) continue;
            var parsed = Manifest.ManifestParser.Parse(System.Text.Encoding.UTF8.GetString(bytes), candidate);
            return parsed.Manifest?.Name;
        }
        return null;
    }
}
