using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Drop.Server;

public sealed class TotpAuthenticator
{
    private const string Base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    private readonly byte[] _secret;

    public TotpAuthenticator(string? configuredSecret)
    {
        if (string.IsNullOrWhiteSpace(configuredSecret))
        {
            _secret = RandomNumberGenerator.GetBytes(20);
            Secret = EncodeBase32(_secret);
            return;
        }

        Secret = configuredSecret.Trim().TrimEnd('=').ToUpperInvariant();
        _secret = DecodeBase32(Secret);
        if (_secret.Length < 16)
            throw new InvalidOperationException("DROP_TOTP_SECRET must decode to at least 16 bytes.");
    }

    public string Secret { get; }

    public string GetOtpAuthUri()
    {
        const string issuer = "Drop";
        var label = Uri.EscapeDataString($"{issuer}:Remote access");
        return $"otpauth://totp/{label}?secret={Secret}&issuer={issuer}&algorithm=SHA1&digits=6&period=30";
    }

    public bool Validate(string? code, DateTimeOffset? now = null)
    {
        if (code is null) return false;
        code = code.Trim();
        if (code.Length != 6 || code.Any(character => character is < '0' or > '9'))
            return false;

        var supplied = Encoding.ASCII.GetBytes(code);
        var currentCounter = (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds() / 30;
        for (var drift = -1; drift <= 1; drift++)
        {
            if (currentCounter + drift < 0) continue;

            var expected = Encoding.ASCII.GetBytes(GenerateCode(currentCounter + drift));
            if (CryptographicOperations.FixedTimeEquals(supplied, expected))
                return true;
        }

        return false;
    }

    private string GenerateCode(long counter)
    {
        Span<byte> counterBytes = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64BigEndian(counterBytes, counter);
        var hash = HMACSHA1.HashData(_secret, counterBytes);
        var offset = hash[^1] & 0x0f;
        var binary = ((hash[offset] & 0x7f) << 24)
            | (hash[offset + 1] << 16)
            | (hash[offset + 2] << 8)
            | hash[offset + 3];
        return (binary % 1_000_000).ToString("D6");
    }

    private static byte[] DecodeBase32(string value)
    {
        var bytes = new List<byte>(value.Length * 5 / 8);
        var buffer = 0;
        var bits = 0;

        foreach (var character in value)
        {
            var digit = Base32Alphabet.IndexOf(character);
            if (digit < 0)
                throw new InvalidOperationException("DROP_TOTP_SECRET must be a Base32 string.");

            buffer = (buffer << 5) | digit;
            bits += 5;
            if (bits < 8) continue;

            bits -= 8;
            bytes.Add((byte)(buffer >> bits));
            buffer &= (1 << bits) - 1;
        }

        if (bits > 0 && buffer != 0)
            throw new InvalidOperationException("DROP_TOTP_SECRET has invalid Base32 padding bits.");

        return bytes.ToArray();
    }

    private static string EncodeBase32(byte[] bytes)
    {
        var result = new StringBuilder((bytes.Length * 8 + 4) / 5);
        var buffer = 0;
        var bits = 0;

        foreach (var value in bytes)
        {
            buffer = (buffer << 8) | value;
            bits += 8;
            while (bits >= 5)
            {
                bits -= 5;
                result.Append(Base32Alphabet[(buffer >> bits) & 0x1f]);
            }
            buffer &= (1 << bits) - 1;
        }

        if (bits > 0)
            result.Append(Base32Alphabet[(buffer << (5 - bits)) & 0x1f]);

        return result.ToString();
    }
}