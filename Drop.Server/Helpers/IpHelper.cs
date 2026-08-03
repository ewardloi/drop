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

    public static bool IsPrivateOrLocalAddress(IPAddress? remoteIp)
    {
        if (remoteIp is null)
            return false;

        if (IPAddress.IsLoopback(remoteIp))
            return true;

        if (remoteIp.IsIPv4MappedToIPv6)
            remoteIp = remoteIp.MapToIPv4();

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