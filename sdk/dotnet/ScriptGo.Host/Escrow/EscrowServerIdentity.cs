// The per-server identity: an X25519 key pair generated at activation. The master wraps a release's
// content key to the public key; the private key NEVER leaves the server. This is what makes a
// leaked encrypted folder fail on an unbound box (CREATOR-PROTECTION.md §3.3), without hardware
// fingerprinting (brittle, hostile to honest migrations — research §2).
using System.Security.Cryptography;
using NSec.Cryptography;

namespace ScriptGo.Host.Escrow;

public sealed class EscrowServerIdentity : IDisposable
{
    private readonly byte[] _privateRaw;

    private EscrowServerIdentity(byte[] privateRaw, byte[] publicRaw)
    {
        _privateRaw = privateRaw;
        PublicKey = publicRaw;
    }

    /// <summary>Raw 32-byte X25519 public key (registered with the deployment).</summary>
    public byte[] PublicKey { get; }

    public string PublicKeyBase64Url => Base64Url.Encode(PublicKey);

    /// <summary>Generates a fresh server identity.</summary>
    public static EscrowServerIdentity Generate()
    {
        using var key = Key.Create(KeyAgreementAlgorithm.X25519,
            new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
        return new EscrowServerIdentity(
            key.Export(KeyBlobFormat.RawPrivateKey),
            key.PublicKey.Export(KeyBlobFormat.RawPublicKey));
    }

    /// <summary>Restores an identity from raw key bytes an operator keeps on the server (e.g. a
    /// protected file). The private key must never be logged, shipped, or written where others read it.</summary>
    public static EscrowServerIdentity FromRaw(byte[] privateRaw, byte[] publicRaw)
    {
        if (privateRaw.Length != EscrowCrypto.X25519KeyBytes || publicRaw.Length != EscrowCrypto.X25519KeyBytes)
            throw new ArgumentException("X25519 keys must be 32 bytes.");
        return new EscrowServerIdentity((byte[])privateRaw.Clone(), (byte[])publicRaw.Clone());
    }

    /// <summary>The raw 32-byte private key, for the operator to persist securely (e.g. a protected
    /// file, DPAPI, a secrets manager). SECRET: never log it, ship it, or store it where others read it.</summary>
    public byte[] ExportPrivateKey() => (byte[])_privateRaw.Clone();

    /// <summary>Unwraps a content key the master wrapped to this server, binding it to the release aad.</summary>
    internal byte[] Unwrap(WrappedKey wrapped, ReadOnlySpan<byte> aad) =>
        EscrowCrypto.UnwrapContentKey(wrapped, _privateRaw, PublicKey, aad);

    public void Dispose() => CryptographicOperations.ZeroMemory(_privateRaw);
}
