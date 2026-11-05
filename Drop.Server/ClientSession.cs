using System.Collections.Concurrent;

namespace Drop.Server;

internal sealed class ClientSession(string token)
{
    private readonly ConcurrentDictionary<string, byte> _allowedUploaders = new();

    private int _hasTotpAccess;
    
    private long _lastSeenUtcTicks = DateTime.UtcNow.Ticks;

    public string Token { get; } = token;

    public bool HasTotpAccess => Volatile.Read(ref _hasTotpAccess) != 0;

    public DateTime LastSeenUtc => new(Interlocked.Read(ref _lastSeenUtcTicks), DateTimeKind.Utc);

    public void GrantTotpAccess() => Volatile.Write(ref _hasTotpAccess, 1);

    public void Touch() => Interlocked.Exchange(ref _lastSeenUtcTicks, DateTime.UtcNow.Ticks);

    public bool AllowsUploader(string uploaderToken) => _allowedUploaders.ContainsKey(uploaderToken);

    public void SetUploaderAllowed(string uploaderToken, bool allowed)
    {
        if (allowed)
            _allowedUploaders[uploaderToken] = 0;
        else
            _allowedUploaders.TryRemove(uploaderToken, out _);
    }
}