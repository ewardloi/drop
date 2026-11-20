using System.Net;
using System.Net.Sockets;

namespace Drop.Server.Helpers;

public static class IpHelper
{
    public static IPAddress? ResolveClientIpAddress(HttpContext context)
    {
        var forwardedFor = context.Request.Headers["X-Forwarded-For"].FirstOrDefault();

        if (!string.IsNullOrWhiteSpace(forwardedFor))
        {
            var first = forwardedFor
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .FirstOrDefault();
            
            if (IPAddress.TryParse(first, out var forwardedIp))
                return forwardedIp;
        }

        var realIp = context.Request.Headers["X-Real-IP"].FirstOrDefault();
        
        if (!string.IsNullOrWhiteSpace(realIp) && IPAddress.TryParse(realIp, out var realAddress))
            return realAddress;

        return context.Connection.RemoteIpAddress;
    }

    public static IReadOnlyList<IPNetwork>? ParseLocalSubnets(string? value, Action<string>? onInvalid = null)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;

        var result = new List<IPNetwork>();
        var entries = value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        foreach (var entry in entries)
        {
            if (TryParseSubnet(entry, out var network))
                result.Add(network);
            else
                onInvalid?.Invoke(entry);
        }

        return result;
    }

    private static bool TryParseSubnet(string entry, out IPNetwork network)
    {
        network = default;

        var slash = entry.IndexOf('/');
        var addressPart = slash < 0 ? entry : entry[..slash];

        if (!IPAddress.TryParse(addressPart, out var address))
            return false;

        if (address.IsIPv4MappedToIPv6)
            return false;

        var maxPrefix = address.AddressFamily == AddressFamily.InterNetwork ? 32 : 128;
        var prefix = maxPrefix;

        if (slash >= 0 && (!int.TryParse(entry[(slash + 1)..], out prefix) || prefix < 0 || prefix > maxPrefix))
            return false;

        var bytes = address.GetAddressBytes();
        for (var bit = prefix; bit < bytes.Length * 8; bit++)
            bytes[bit / 8] &= (byte)~(0x80 >> (bit % 8));

        network = new IPNetwork(new IPAddress(bytes), prefix);
        return true;
    }

    public static bool IsPrivateOrLocalAddress(IPAddress? remoteIp, IReadOnlyList<IPNetwork>? localSubnets = null)
    {
        if (remoteIp is null)
            return false;

        if (remoteIp.IsIPv4MappedToIPv6)
            remoteIp = remoteIp.MapToIPv4();

        if (localSubnets is not null)
        {
            foreach (var subnet in localSubnets)
            {
                if (subnet.Contains(remoteIp))
                    return true;
            }

            return false;
        }

        if (IPAddress.IsLoopback(remoteIp))
            return true;

        switch (remoteIp.AddressFamily)
        {
            case AddressFamily.InterNetwork:
            {
                var bytes = remoteIp.GetAddressBytes();
                return bytes[0] == 10 || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31) || (bytes[0] == 192 && bytes[1] == 168);
            }
            case AddressFamily.InterNetworkV6:
            {
                var bytes = remoteIp.GetAddressBytes();
                return bytes[0] == 0xFC || bytes[0] == 0xFD;
            }
            default:
                return false;
        }
    }
}