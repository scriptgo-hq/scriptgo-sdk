// The clear, signed description of an escrowed release: escrow.json (docs/spec/escrow.md). Nothing
// in it is secret: names, sizes, hashes, the signer's public key and a signature. This class only
// reads and checks its shape; the signature is verified by the native library over the canonical
// bytes built here.
using System;
using System.Collections.Generic;
using System.Text;

namespace ScriptGo.Bridge.Escrow
{
    internal sealed class ClearFile
    {
        public string Path;
        public byte[] Sha256;
        public long Bytes;
    }

    internal sealed class EscrowManifest
    {
        public const string Format = "scriptgo-escrow/1";
        public const string Cipher = "AES-256-GCM";
        public const string Kdf = "HKDF-SHA256+X25519";
        public const string FileName = "escrow.json";
        public const string PayloadFileName = "payload.enc";
        /// <summary>The first words of a stub: the file an installer writes at the path of an encrypted script.</summary>
        public const string StubPrefix = "-- scriptgo-escrow/1 ";
        // The native library refuses a larger payload (SG_MAX_PAYLOAD_BYTES).
        public const long MaxPayloadBytes = 256L * 1024 * 1024;
        public const int MaxManifestBytes = 4 * 1024 * 1024;

        /// <summary>The resource manifests the core looks for, in its order.</summary>
        public static readonly string[] ResourceManifests = { "scriptgo.lua", "scriptgo.json", "open77.lua" };

        public string Package, Version, Aad, PayloadSha256Hex, SignerPublicKeyText;
        public byte[] PayloadNonce, PayloadSha256, SignerPublicKey, Signature, Canonical;
        public long PayloadBytes;
        public readonly Dictionary<string, ClearFile> Clear = new Dictionary<string, ClearFile>(StringComparer.Ordinal);
        public readonly List<string> ClearOrder = new List<string>();
        public readonly HashSet<string> Encrypted = new HashSet<string>(StringComparer.Ordinal);
        public readonly List<string> EncryptedOrder = new List<string>();

        /// <summary>Reads escrow.json. Throws <see cref="JsonError"/> with what is wrong.</summary>
        public static EscrowManifest Parse(byte[] raw)
        {
            if (raw == null || raw.Length == 0) throw new JsonError("escrow.json is empty");
            if (raw.Length > MaxManifestBytes) throw new JsonError("escrow.json is larger than 4 MiB");
            var parsed = Json.Parse(raw);
            var root = Json.Object(parsed, "escrow.json");
            var m = new EscrowManifest();

            var format = Json.String(root, "format");
            if (format != Format) throw new JsonError("unsupported format \"" + format + "\" (this adapter reads " + Format + ")");
            var cipher = Json.String(root, "cipher");
            var kdf = Json.String(root, "kdf");
            if (cipher != Cipher || kdf != Kdf) throw new JsonError("unsupported cipher or kdf (" + cipher + ", " + kdf + ")");

            m.Package = Json.String(root, "package");
            m.Version = Json.String(root, "version");
            m.Aad = Json.String(root, "aad");
            if (m.Package.Length == 0 || m.Version.Length == 0) throw new JsonError("package and version must not be empty");
            if (m.Package.IndexOfAny(new[] { ' ', '\t', '\r', '\n' }) >= 0 || m.Version.IndexOfAny(new[] { ' ', '\t', '\r', '\n' }) >= 0)
                throw new JsonError("package and version must not contain white space");
            // The aad binds the payload and the wrapped key to this exact release.
            if (m.Aad != m.Package + "@" + m.Version) throw new JsonError("aad must be <package>@<version>");

            var payload = Json.Object(root.ContainsKey("payload") ? root["payload"] : null, "\"payload\"");
            if (!Base64Url.TryDecode(Json.String(payload, "nonce"), EscrowNative.NonceBytes, out m.PayloadNonce))
                throw new JsonError("payload.nonce must be 12 bytes, base64url");
            m.PayloadSha256Hex = Json.String(payload, "sha256");
            m.PayloadSha256 = Hex(m.PayloadSha256Hex, "payload.sha256");
            m.PayloadBytes = Json.Integer(payload, "bytes");
            if (m.PayloadBytes < 16 || m.PayloadBytes > MaxPayloadBytes) throw new JsonError("payload.bytes is out of range");

            foreach (var item in Json.Array(root, "clearFiles"))
            {
                var o = Json.Object(item, "a clearFiles entry");
                var file = new ClearFile { Path = Json.String(o, "path"), Bytes = Json.Integer(o, "bytes") };
                file.Sha256 = Hex(Json.String(o, "sha256"), "clearFiles sha256");
                CheckPath(file.Path);
                if (file.Bytes < 0) throw new JsonError("clearFiles bytes is negative");
                if (m.Clear.ContainsKey(file.Path)) throw new JsonError("clear file listed twice: " + file.Path);
                m.Clear[file.Path] = file;
                m.ClearOrder.Add(file.Path);
            }
            foreach (var item in Json.Array(root, "encryptedFiles"))
            {
                var path = item as string;
                if (path == null) throw new JsonError("encryptedFiles must hold strings");
                CheckPath(path);
                if (m.Clear.ContainsKey(path)) throw new JsonError(path + " is listed as clear and as encrypted");
                if (!m.Encrypted.Add(path)) throw new JsonError("encrypted file listed twice: " + path);
                m.EncryptedOrder.Add(path);
            }
            Json.Array(root, "allowlist");
            Json.OptionalString(root, "watermark");

            m.SignerPublicKeyText = Json.String(root, "signerPublicKey");
            if (!Base64Url.TryDecode(m.SignerPublicKeyText, EscrowNative.PublicKeyBytes, out m.SignerPublicKey))
                throw new JsonError("signerPublicKey must be 32 bytes, base64url");
            if (!Base64Url.TryDecode(Json.String(root, "signature"), EscrowNative.SignatureBytes, out m.Signature))
                throw new JsonError("signature must be 64 bytes, base64url");

            m.Canonical = Encoding.UTF8.GetBytes(Json.Canonical(parsed, true));
            return m;
        }

        /// <summary>The one line an installer writes at the path of an encrypted script (without the line end).</summary>
        public string StubLine(string path)
        {
            return StubPrefix + Package + "@" + Version + " sha256=" + PayloadSha256Hex + " path=" + path;
        }

        /// <summary>Is this file content the stub of <paramref name="path"/>? One line, an optional line end.</summary>
        public bool IsStub(string path, byte[] content)
        {
            var expected = Encoding.UTF8.GetBytes(StubLine(path));
            int n = content.Length;
            if (n > 0 && content[n - 1] == (byte)'\n') n--;
            if (n > 0 && content[n - 1] == (byte)'\r') n--;
            if (n != expected.Length) return false;
            for (int i = 0; i < n; i++) if (content[i] != expected[i]) return false;
            return true;
        }

        private static void CheckPath(string path)
        {
            if (FolderFiles.UnsafeRelative(path) || path.IndexOf('\\') >= 0 || path.IndexOf('\0') >= 0
                || path.EndsWith("/", StringComparison.Ordinal) || path.Contains("//"))
                throw new JsonError("unsafe path in escrow.json: " + path);
            if (path == FileName || path == PayloadFileName) throw new JsonError(path + " cannot be a file of the release");
        }

        private static byte[] Hex(string text, string what)
        {
            if (text == null || text.Length != 64) throw new JsonError(what + " must be 64 hex digits");
            var bytes = new byte[32];
            for (int i = 0; i < 32; i++)
            {
                int hi = Digit(text[2 * i]), lo = Digit(text[2 * i + 1]);
                if (hi < 0 || lo < 0) throw new JsonError(what + " must be lowercase hex");
                bytes[i] = (byte)(hi * 16 + lo);
            }
            return bytes;
        }

        private static int Digit(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            return -1;
        }

        public static bool SameBytes(byte[] a, byte[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }
    }
}
