// Client code escrow (docs/spec/client-escrow.md): client scripts shipped as stripped Lua bytecode in a
// scriptgo-client-escrow/1 container, on top of libscriptgo.
//
// The two roles this file serves:
//   a licensed server   AssetKey.UnwrapClientCodeForServer   the API's answer to POST /v1/licenses/key {kind:"client"}
//                       AssetKey.WrapForClient               the same key, wrapped to one player's session key
//   a client (or test)  AssetKey.UnwrapClientCodeForSession  the server's per-session wrap
//                       ClientCodeContainer                  open, check the VM, bind, compile into a lua_State
//
// There is no call that returns decrypted bytecode: LoadLuaChunk compiles a chunk into the host's
// lua_State with mode "b" from guarded native memory, then wipes it. What this protects: client code
// at rest and in transit, never as source, a key per deployment handed to one session at a time.
// The VM runs the bytecode, so a player who reads their own memory can copy and decompile it into
// readable, de-identified Lua. Never "unbreakable".
using System.Runtime.InteropServices;
using System.Text;
using ScriptGo.Escrow.Native;

namespace ScriptGo.Escrow;

/// <summary>Constants and additional data of scriptgo-client-escrow/1.</summary>
public static class ClientEscrowFormat
{
    public const string Format = "scriptgo-client-escrow/1";
    /// <summary>The container's name at the root of a delivered resource.</summary>
    public const string EntryName = "clientcode.sgce";
    /// <summary>The Lua 5.4 dump header length a host passes to <see cref="ClientCodeContainer.CheckTarget"/>.</summary>
    public const int LuacHeaderBytes = 31;

    /// <summary>The aad of the API's wrap to a licensed server (<c>kind: "client"</c>).</summary>
    public static string ServerAad(string package, string version, string deployment) =>
        $"{Format}\nserver\n{package}@{version}\n{deployment}";

    /// <summary>The aad of a server's wrap to one player's session.</summary>
    public static string SessionAad(string package, string version, string keyId) =>
        $"{Format}\nclient\n{package}@{version}\n{keyId}";
}

/// <summary>One escrowed client script: its path and its bytecode size.</summary>
public readonly record struct ClientCodeChunk(string Path, long Size);

/// <summary>An opened client-code container. Opening runs every check that needs no key; the host's
/// VM is checked with <see cref="CheckTarget"/>, the key bound with <see cref="Bind"/>, then each
/// chunk is compiled into a lua_State by <see cref="LoadLuaChunk"/>.</summary>
public sealed class ClientCodeContainer : IDisposable
{
    private readonly ClientCodeContainerHandle _handle;
    private bool _disposed;

    private ClientCodeContainer(ClientCodeContainerHandle handle)
    {
        _handle = handle;
        Package = Field("package")!;
        Version = Field("version")!;
        Release = Field("release")!;
        Deployment = Field("deployment")!;
        KeyId = Field("keyId")!;
        SignerPublicKey = Field("signerPublicKey")!;
        Strip = Field("strip")!;
        Lua = Field("lua")!;
        Fingerprint = Field("fingerprint");
        Chunks = ReadChunks();
    }

    public string Package { get; }
    public string Version { get; }
    public string Release { get; }
    public string Deployment { get; }
    public string KeyId { get; }
    public string SignerPublicKey { get; }
    /// <summary>"full" (no names, synthetic positions) or "names" (names stripped, lines kept).</summary>
    public string Strip { get; }
    /// <summary>The Lua version the bytecode targets, e.g. "5.4.8".</summary>
    public string Lua { get; }
    public string? Fingerprint { get; }
    public IReadOnlyList<ClientCodeChunk> Chunks { get; }
    public bool IsBound { get; private set; }
    public bool TargetChecked { get; private set; }
    /// <summary>True for a container from <see cref="Inspect"/>: integrity only, it never takes a key.</summary>
    public bool IsInspectOnly { get; private init; }

    /// <summary>Opens and checks a container whose bytecode will be loaded. <paramref name="trustedSigner"/>
    /// (32 bytes, required) is the signer you trust, from a source the party that handed you the container
    /// does not control: Lua does not verify bytecode, so this signature is what vouches for it. Since
    /// 0.5.0 there is no "accept the key the header names"; that is <see cref="Inspect"/>.</summary>
    public static ClientCodeContainer Open(ReadOnlySpan<byte> container, ReadOnlySpan<byte> trustedSigner)
    {
        if (trustedSigner.Length != 32) throw new ArgumentException("A pinned signer public key (32 bytes) is required.", nameof(trustedSigner));
        return OpenCore(container, trustedSigner, inspect: false);
    }

    /// <summary>The same checks with the signature verified under the key the header names: integrity only.
    /// For a host that relays containers and never loads them; <see cref="Bind"/> refuses the result.</summary>
    public static ClientCodeContainer Inspect(ReadOnlySpan<byte> container) => OpenCore(container, default, inspect: true);

    private static ClientCodeContainer OpenCore(ReadOnlySpan<byte> container, ReadOnlySpan<byte> trustedSigner, bool inspect)
    {
        if (container.IsEmpty) throw new EscrowException(EscrowFailure.InvalidBundle, "bad_container:empty");
        EnsureAvailable();
        unsafe
        {
            var data = (byte*)NativeMemory.Alloc((nuint)container.Length);
            container.CopyTo(new Span<byte>(data, container.Length));
            IntPtr handle = IntPtr.Zero;
            int rc;
            try
            {
                fixed (byte* signer = trustedSigner)
                    rc = inspect
                        ? EscrowNative.sg_clink_container_inspect(data, (nuint)container.Length, out handle)
                        : EscrowNative.sg_clink_container_open(data, (nuint)container.Length, signer, out handle);
            }
            catch (EntryPointNotFoundException)
            {
                NativeMemory.Free(data);
                throw new EscrowException(EscrowFailure.NativeLibraryUnavailable,
                    "native_library_unavailable:this libscriptgo predates sg_clink_container_inspect (0.2.0); use the library that ships with this package");
            }
            if (rc != EscrowNative.Ok)
            {
                NativeMemory.Free(data);
                throw rc switch
                {
                    EscrowNative.ErrBadSignature or EscrowNative.ErrUntrustedSigner =>
                        new EscrowException(EscrowFailure.Signature, "bad_signature:" + EscrowNative.ErrorText(rc)),
                    EscrowNative.ErrPayloadHash => new EscrowException(EscrowFailure.DecryptFailed, "payload_hash:" + EscrowNative.ErrorText(rc)),
                    _ => new EscrowException(EscrowFailure.InvalidBundle, "bad_container:" + EscrowNative.ErrorText(rc)),
                };
            }
            return new ClientCodeContainer(new ClientCodeContainerHandle(handle, (IntPtr)data)) { IsInspectOnly = inspect };
        }
    }

    /// <summary>Checks the container targets the host's VM. <paramref name="luacHeader"/> is the first 31
    /// bytes of a <c>lua_dump</c> / <c>string.dump</c> made by the host's own Lua. Returns false (and no
    /// chunk will load) when the release was compiled for another VM.</summary>
    public bool CheckTarget(ReadOnlySpan<byte> luacHeader)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (luacHeader.Length < ClientEscrowFormat.LuacHeaderBytes) throw new ArgumentException("A LUAC header is 31 bytes.", nameof(luacHeader));
        int rc;
        unsafe
        {
            fixed (byte* h = luacHeader) rc = EscrowNative.sg_clink_target_check(_handle, h, (nuint)luacHeader.Length);
        }
        if (rc != EscrowNative.Ok && rc != EscrowNative.ErrTargetMismatch)
            throw new EscrowException(EscrowFailure.InvalidBundle, "target_check:" + EscrowNative.ErrorText(rc));
        TargetChecked = rc == EscrowNative.Ok;
        return TargetChecked;
    }

    /// <summary>Gives the container its client-code key; <c>key_mismatch</c> for another deployment's key or an asset key.</summary>
    public void Bind(AssetKey key)
    {
        ArgumentNullException.ThrowIfNull(key);
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (IsBound) throw new InvalidOperationException("The container already has its key.");
        if (IsInspectOnly) throw new EscrowException(EscrowFailure.Signature, "untrusted_signer:an inspected container is never loaded; open it with the signer you trust");
        var rc = EscrowNative.sg_clink_container_bind(_handle, key.Handle);
        if (rc == EscrowNative.ErrKeyMismatch) throw new EscrowException(EscrowFailure.UnwrapFailed, "key_mismatch");
        if (rc != EscrowNative.Ok) throw new EscrowException(EscrowFailure.UnwrapFailed, "bind_failed:" + EscrowNative.ErrorText(rc));
        IsBound = true;
    }

    /// <summary>Decrypts one chunk in guarded native memory, checks it, and compiles it into
    /// <paramref name="luaState"/> with mode "b". On <see cref="LuaChunkStatus.Loaded"/> the main function
    /// is on top of the stack; on <see cref="LuaChunkStatus.LuaError"/> Lua's message is.</summary>
    public LuaChunkResult LoadLuaChunk(string path, IntPtr luaState, LuaChunkLoader loader)
    {
        ArgumentNullException.ThrowIfNull(path);
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (luaState == IntPtr.Zero) throw new ArgumentException("A null lua_State.", nameof(luaState));
        if (!loader.IsValid) throw new ArgumentException("An unresolved luaL_loadbufferx.", nameof(loader));
        if (!IsBound) throw new InvalidOperationException("Bind the client-code key first.");
        if (!TargetChecked) throw new InvalidOperationException("Check the host VM's LUAC header first (CheckTarget).");
        var rc = EscrowNative.sg_clink_lua_load(_handle, path, luaState, loader.FunctionPointer, out var luaStatus);
        return rc switch
        {
            EscrowNative.Ok => new LuaChunkResult(LuaChunkStatus.Loaded, luaStatus),
            EscrowNative.ErrNotFound => new LuaChunkResult(LuaChunkStatus.NotFound, 0),
            EscrowNative.ErrLuaLoad => new LuaChunkResult(LuaChunkStatus.LuaError, luaStatus),
            EscrowNative.ErrTargetMismatch => throw new EscrowException(EscrowFailure.InvalidBundle, "target_mismatch:" + path),
            _ => throw new EscrowException(EscrowFailure.DecryptFailed, "decrypt_failed:" + EscrowNative.ErrorText(rc)),
        };
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _handle.Dispose();
    }

    private static volatile bool _checked;

    private static void EnsureAvailable()
    {
        AssetKey.EnsureAvailable();
        if (_checked) return;
        try { EscrowNative.sg_clink_container_free(IntPtr.Zero); }
        catch (EntryPointNotFoundException)
        {
            throw new EscrowException(EscrowFailure.NativeLibraryUnavailable,
                "native_library_unavailable:this libscriptgo has no client code escrow calls (sg_clink_*); use the library that ships with this package");
        }
        _checked = true;
    }

    private string? Field(string name)
    {
        var rc = EscrowNative.sg_clink_container_field(_handle, name, out var value);
        if (rc == EscrowNative.ErrNotFound) return null;
        if (rc != EscrowNative.Ok) throw new EscrowException(EscrowFailure.InvalidBundle, "bad_container:" + EscrowNative.ErrorText(rc));
        return Marshal.PtrToStringUTF8(value);
    }

    private List<ClientCodeChunk> ReadChunks()
    {
        var rc = EscrowNative.sg_clink_chunk_count(_handle, out var count);
        if (rc != EscrowNative.Ok) throw new EscrowException(EscrowFailure.InvalidBundle, "bad_container:" + EscrowNative.ErrorText(rc));
        var chunks = new List<ClientCodeChunk>((int)count);
        for (nuint i = 0; i < count; i++)
        {
            rc = EscrowNative.sg_clink_chunk_at(_handle, i, out var path, out var size);
            if (rc != EscrowNative.Ok) throw new EscrowException(EscrowFailure.InvalidBundle, "bad_container:" + EscrowNative.ErrorText(rc));
            chunks.Add(new ClientCodeChunk(Marshal.PtrToStringUTF8(path)!, (long)size));
        }
        return chunks;
    }
}
