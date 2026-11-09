// The escrow crypto for the .NET kit. Vetted primitives only, never hand-rolled
// (CREATOR-PROTECTION.md §2): AES-256-GCM via System.Security.Cryptography; X25519 key agreement and
// ed25519 verification via NSec (libsodium). The byte layouts mirror packages/escrow/src/crypto.ts
// exactly (docs/spec/escrow.md); the cross-language vector test keeps them in step.
//
// Honest ceiling: this decrypts a resource the host then runs, so the operator of this host can
// ultimately recover it. The crypto raises cost and makes a leaked file useless off a bound server;
// it is not, and is never sold as, an unbreakable boundary.
using System.Security.Cryptography;
using NSec.Cryptography;

namespace ScriptGo.Host.Escrow;

public static class EscrowCrypto
{
    public const int ContentKeyBytes = 32;
    public const int AesNonceBytes = 12;
    public const int AesTagBytes = 16;
    public const int X25519KeyBytes = 32;

    private static readonly byte[] WrapInfo = "scriptgo.escrow.keywrap.v1"u8.ToArray();

    /// <summary>AES-256-GCM decrypt. <paramref name="ciphertextWithTag"/> is ciphertext||tag (16-byte tag).
    /// Throws <see cref="CryptographicException"/> if the tag or AAD does not verify (tamper-evident).</summary>
    public static byte[] AeadDecrypt(ReadOnlySpan<byte> key, ReadOnlySpan<byte> nonce, ReadOnlySpan<byte> ciphertextWithTag, ReadOnlySpan<byte> aad)
    {
        if (key.Length != ContentKeyBytes) throw new ArgumentException("AES-256-GCM needs a 32-byte key.", nameof(key));
        if (nonce.Length != AesNonceBytes) throw new ArgumentException("AES-GCM nonce must be 12 bytes.", nameof(nonce));
        if (ciphertextWithTag.Length < AesTagBytes) throw new CryptographicException("ciphertext is shorter than the GCM tag.");
        var tag = ciphertextWithTag[^AesTagBytes..];
        var body = ciphertextWithTag[..^AesTagBytes];
        var plaintext = new byte[body.Length];
        using var aes = new AesGcm(key, AesTagBytes);
        aes.Decrypt(nonce, body, tag, plaintext, aad);
        return plaintext;
    }

    /// <summary>Raw 32-byte X25519 shared secret (the same bytes Node's diffieHellman yields). Used by
    /// the cross-language vector test to prove the two X25519 implementations agree.</summary>
    public static byte[] X25519Agree(ReadOnlySpan<byte> privateRaw, ReadOnlySpan<byte> publicRaw)
    {
        using var shared = AgreeShared(privateRaw, publicRaw, exportable: true);
        return shared.Export(SharedSecretBlobFormat.RawSharedSecret);
    }

    private static SharedSecret AgreeShared(ReadOnlySpan<byte> privateRaw, ReadOnlySpan<byte> publicRaw, bool exportable)
    {
        var algorithm = KeyAgreementAlgorithm.X25519;
        using var privateKey = Key.Import(algorithm, privateRaw, KeyBlobFormat.RawPrivateKey,
            new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
        var publicKey = PublicKey.Import(algorithm, publicRaw, KeyBlobFormat.RawPublicKey);
        var parameters = new SharedSecretCreationParameters
        {
            ExportPolicy = exportable ? KeyExportPolicies.AllowPlaintextExport : KeyExportPolicies.None,
        };
        return algorithm.Agree(privateKey, publicKey, in parameters)
            ?? throw new CryptographicException("X25519 agreement failed (invalid public key).");
    }

    /// <summary>Unwraps a content key wrapped to this server's X25519 public key (ECIES: ephemeral
    /// X25519 + HKDF-SHA256 + AES-256-GCM). A copy on an unbound server has no matching private key.</summary>
    public static byte[] UnwrapContentKey(WrappedKey wrapped, ReadOnlySpan<byte> serverPrivateRaw, ReadOnlySpan<byte> serverPublicRaw, ReadOnlySpan<byte> aad)
    {
        var epk = Base64Url.Decode(wrapped.Epk);
        var nonce = Base64Url.Decode(wrapped.Nonce);
        var body = Base64Url.Decode(wrapped.Wrapped);
        // salt = epk || serverPublic, binding the derived key to both parties.
        var salt = new byte[epk.Length + serverPublicRaw.Length];
        epk.CopyTo(salt, 0);
        serverPublicRaw.CopyTo(salt.AsSpan(epk.Length));
        using var shared = AgreeShared(serverPrivateRaw, epk, exportable: false);
        var kek = KeyDerivationAlgorithm.HkdfSha256.DeriveBytes(shared, salt, WrapInfo, ContentKeyBytes);
        try { return AeadDecrypt(kek, nonce, body, aad); }
        finally { CryptographicOperations.ZeroMemory(kek); }
    }

    /// <summary>Verifies an ed25519 signature over <paramref name="message"/> by a raw 32-byte public key.</summary>
    public static bool Ed25519Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature, ReadOnlySpan<byte> publicRaw)
    {
        if (publicRaw.Length != 32 || signature.Length != 64) return false;
        var publicKey = PublicKey.Import(SignatureAlgorithm.Ed25519, publicRaw, KeyBlobFormat.RawPublicKey);
        return SignatureAlgorithm.Ed25519.Verify(publicKey, message, signature);
    }
}
