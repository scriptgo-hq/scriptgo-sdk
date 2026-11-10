// The identity file, read and written by the MANAGED FALLBACK backend in the same format as
// libscriptgo (sdk/native/src/internal.h), so a server keeps its identity across backends:
//
//   "SGIDENT1" | protection (1 byte) | public key (32) | length (u32 LE) | protected private key
//
// protection 1 = Windows DPAPI (CryptProtectData, current user); 2 = raw key in a 0600 file (POSIX).
// Unlike the native backend, the private key passes through managed memory here. It is held in a
// pinned array (the garbage collector cannot copy it around) and wiped on Dispose, which narrows
// the exposure and does not remove it.
using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;

namespace ScriptGo.Escrow.Managed;

internal static partial class ManagedIdentityStore
{
    private static readonly byte[] Magic = "SGIDENT1"u8.ToArray();
    private static readonly byte[] Entropy = "scriptgo.escrow.identity.v1"u8.ToArray();
    private const byte ProtectionDpapi = 1;
    private const byte ProtectionFileMode = 2;
    private const int HeaderBytes = 8 + 1 + 32 + 4;
    private const int MaxFileBytes = 4096;

    public static (byte[] PinnedPrivateKey, bool Created) LoadOrCreate(string path)
    {
        if (File.Exists(path)) return (Load(path), false);
        var key = GC.AllocateArray<byte>(32, pinned: true);
        RandomNumberGenerator.Fill(key);
        try
        {
            Save(path, key, ManagedCrypto.X25519PublicKey(key), replace: false);
            return (key, true);
        }
        catch (IOException) when (File.Exists(path))
        {
            // Another process created the file between our check and our write: use theirs.
            CryptographicOperations.ZeroMemory(key);
            return (Load(path), false);
        }
    }

    public static byte[] Load(string path)
    {
        var info = new FileInfo(path);
        if (info.Length < HeaderBytes || info.Length > MaxFileBytes) throw Damaged(path);
        if (!OperatingSystem.IsWindows())
        {
            var mode = File.GetUnixFileMode(path);
            const UnixFileMode others = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute
                | UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
            if ((mode & others) != 0) throw new CryptographicException($"escrow identity at {path}: the identity file is readable by other users");
        }
        var file = File.ReadAllBytes(path);
        try
        {
            if (!file.AsSpan(0, 8).SequenceEqual(Magic)) throw Damaged(path);
            var protection = file[8];
            var storedPublic = file.AsSpan(9, 32);
            var length = (int)BinaryPrimitives.ReadUInt32LittleEndian(file.AsSpan(41, 4));
            if (length <= 0 || length != file.Length - HeaderBytes) throw Damaged(path);
            var blob = file.AsSpan(HeaderBytes, length);

            var key = GC.AllocateArray<byte>(32, pinned: true);
            if (OperatingSystem.IsWindows())
            {
                if (protection != ProtectionDpapi) throw Damaged(path);
                if (!Dpapi.Unprotect(blob, Entropy, key))
                    throw new CryptographicException($"escrow identity at {path}: the operating system refused to unseal the identity (another user or machine?)");
            }
            else
            {
                if (protection != ProtectionFileMode || length != 32) throw Damaged(path);
                blob.CopyTo(key);
            }
            if (!CryptographicOperations.FixedTimeEquals(ManagedCrypto.X25519PublicKey(key), storedPublic))
            {
                CryptographicOperations.ZeroMemory(key);
                throw Damaged(path);
            }
            return key;
        }
        finally { CryptographicOperations.ZeroMemory(file); }
    }

    public static void Save(string path, ReadOnlySpan<byte> privateKey, ReadOnlySpan<byte> publicKey, bool replace)
    {
        byte protection;
        byte[] blob;
        if (OperatingSystem.IsWindows())
        {
            protection = ProtectionDpapi;
            blob = Dpapi.Protect(privateKey, Entropy);
        }
        else
        {
            protection = ProtectionFileMode;
            blob = privateKey.ToArray();
        }
        var file = new byte[HeaderBytes + blob.Length];
        try
        {
            Magic.CopyTo(file, 0);
            file[8] = protection;
            publicKey.CopyTo(file.AsSpan(9, 32));
            BinaryPrimitives.WriteUInt32LittleEndian(file.AsSpan(41, 4), (uint)blob.Length);
            blob.CopyTo(file, HeaderBytes);

            // Written next to the target and moved into place, so a crash never leaves half an identity.
            var temp = path + ".tmp." + Environment.ProcessId;
            var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write, Share = FileShare.None };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            try
            {
                using (var stream = new FileStream(temp, options))
                {
                    stream.Write(file);
                    stream.Flush(flushToDisk: true);
                }
                File.Move(temp, path, overwrite: replace); // throws IOException when the target exists and replace is false
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(file);
            CryptographicOperations.ZeroMemory(blob);
        }
    }

    private static CryptographicException Damaged(string path) =>
        new($"escrow identity at {path}: the identity file is damaged or is not an identity file");

    /// <summary>Windows DPAPI, called directly (crypt32) so the package needs no extra dependency.</summary>
    [SupportedOSPlatform("windows")]
    private static unsafe partial class Dpapi
    {
        private const uint UiForbidden = 0x1;

        [StructLayout(LayoutKind.Sequential)]
        private struct Blob
        {
            public uint Length;
            public byte* Data;
        }

        [LibraryImport("crypt32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool CryptProtectData(Blob* dataIn, char* description, Blob* entropy, void* reserved, void* prompt, uint flags, Blob* dataOut);

        [LibraryImport("crypt32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool CryptUnprotectData(Blob* dataIn, char** description, Blob* entropy, void* reserved, void* prompt, uint flags, Blob* dataOut);

        [LibraryImport("kernel32.dll")]
        private static partial void* LocalFree(void* memory);

        public static byte[] Protect(ReadOnlySpan<byte> clear, ReadOnlySpan<byte> entropy)
        {
            fixed (byte* c = clear, e = entropy)
            fixed (char* description = "SCRIPT//GO escrow server identity")
            {
                var input = new Blob { Length = (uint)clear.Length, Data = c };
                var salt = new Blob { Length = (uint)entropy.Length, Data = e };
                Blob output = default;
                if (!CryptProtectData(&input, description, &salt, null, null, UiForbidden, &output))
                    throw new CryptographicException("DPAPI could not seal the identity (error " + Marshal.GetLastPInvokeError() + ").");
                try { return new ReadOnlySpan<byte>(output.Data, (int)output.Length).ToArray(); }
                finally { LocalFree(output.Data); }
            }
        }

        public static bool Unprotect(ReadOnlySpan<byte> sealedBlob, ReadOnlySpan<byte> entropy, Span<byte> key)
        {
            fixed (byte* s = sealedBlob, e = entropy)
            {
                var input = new Blob { Length = (uint)sealedBlob.Length, Data = s };
                var salt = new Blob { Length = (uint)entropy.Length, Data = e };
                Blob output = default;
                if (!CryptUnprotectData(&input, null, &salt, null, null, UiForbidden, &output)) return false;
                try
                {
                    var clear = new Span<byte>(output.Data, (int)output.Length);
                    var ok = clear.Length == key.Length;
                    if (ok) clear.CopyTo(key);
                    clear.Clear(); // DPAPI returns the key in ordinary heap memory: wipe it before freeing
                    return ok;
                }
                finally { LocalFree(output.Data); }
            }
        }
    }
}
