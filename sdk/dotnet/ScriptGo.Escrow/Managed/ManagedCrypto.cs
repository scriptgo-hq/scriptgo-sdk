// The escrow crypto of the MANAGED FALLBACK backend. Vetted primitives only, never hand-rolled:
// AES-256-GCM via System.Security.Cryptography; X25519 key agreement and ed25519 verification via
// NSec (libsodium). The byte layouts mirror packages/escrow/src/crypto.ts and the native library
// exactly (docs/spec/escrow.md); the cross-language vector test keeps the three in step.
//
// This backend is weaker than the native one against memory inspection: keys and plaintext are
// managed arrays. And the ceiling is the same for both: the operator of a host that decrypts and
// runs a resource can ultimately recover it. Escrow raises cost and makes a leaked file useless
// off a bound server; it is not a guarantee of secrecy.
using System.Security.Cryptography;
using NSec.Cryptography;

namespace ScriptGo.Escrow.Managed;

internal static class ManagedCrypto
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
        if (key.Length != ContentKeyBytes) throw new CryptographicException("AES-256-GCM needs a 32-byte key.");
        if (nonce.Length != AesNonceBytes) throw new CryptographicException("AES-GCM nonce must be 12 bytes.");
        if (ciphertextWithTag.Length < AesTagBytes) throw new CryptographicException("ciphertext is shorter than the GCM tag.");
        var tag = ciphertextWithTag[^AesTagBytes..];
        var body = ciphertextWithTag[..^AesTagBytes];
        var plaintext = new byte[body.Length];
        using var aes = new AesGcm(key, AesTagBytes);
        aes.Decrypt(nonce, body, tag, plaintext, aad);
        return plaintext;
    }

    /// <summary>Raw 32-byte X25519 shared secret (the same bytes Node's diffieHellman yields). Used by
    /// the cross-language vector test to prove the X25519 implementations agree.</summary>
    public static byte[] X25519Agree(ReadOnlySpan<byte> privateRaw, ReadOnlySpan<byte> publicRaw)
    {
        using var shared = AgreeShared(privateRaw, publicRaw, exportable: true);
        return shared.Export(SharedSecretBlobFormat.RawSharedSecret);
    }

    /// <summary>The X25519 public key of a raw private key.</summary>
    public static byte[] X25519PublicKey(ReadOnlySpan<byte> privateRaw)
    {
        using var key = Key.Import(KeyAgreementAlgorithm.X25519, privateRaw, KeyBlobFormat.RawPrivateKey,
            new KeyCreationParameters { ExportPolicy = KeyExportPolicies.None });
        return key.PublicKey.Export(KeyBlobFormat.RawPublicKey);
    }

    private static SharedSecret AgreeShared(ReadOnlySpan<byte> privateRaw, ReadOnlySpan<byte> publicRaw, bool exportable)
    {
        if (privateRaw.Length != X25519KeyBytes || publicRaw.Length != X25519KeyBytes)
            throw new CryptographicException("X25519 keys must be 32 bytes.");
        var algorithm = KeyAgreementAlgorithm.X25519;
        using var privateKey = Key.Import(algorithm, privateRaw, KeyBlobFormat.RawPrivateKey,
            new KeyCreationParameters { ExportPolicy = KeyExportPolicies.None });
        PublicKey publicKey;
        try { publicKey = PublicKey.Import(algorithm, publicRaw, KeyBlobFormat.RawPublicKey); }
        catch (FormatException e) { throw new CryptographicException("X25519 public key is not valid.", e); }
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
        byte[] epk, nonce, body;
        try
        {
            epk = Base64Url.Decode(wrapped.Epk);
            nonce = Base64Url.Decode(wrapped.Nonce);
            body = Base64Url.Decode(wrapped.Wrapped);
        }
        catch (FormatException e) { throw new CryptographicException("the wrapped key is not base64url.", e); }
        if (body.Length != ContentKeyBytes + AesTagBytes) throw new CryptographicException("the wrapped key has the wrong length.");
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
        PublicKey publicKey;
        try { publicKey = PublicKey.Import(SignatureAlgorithm.Ed25519, publicRaw, KeyBlobFormat.RawPublicKey); }
        catch (FormatException) { return false; }
        return SignatureAlgorithm.Ed25519.Verify(publicKey, message, signature);
    }
}
