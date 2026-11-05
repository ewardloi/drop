using System.Net.WebSockets;

namespace Drop.Server;

internal sealed class ClientConnection(string id, string name, WebSocket socket, bool isLocalNetwork)
{
    public string Id { get; } = id;

    public string Name { get; set; } = name;

    public WebSocket Socket { get; } = socket;

    public bool IsLocalNetwork { get; } = isLocalNetwork;

    public ClientSession? Session { get; private set; }

    public bool CanUpload => IsLocalNetwork || Session?.HasTotpAccess == true;

    public void SetSession(ClientSession session) => Session = session;

    public bool AllowsUploader(string uploaderToken) => Session?.AllowsUploader(uploaderToken) == true;

    public void SetUploaderAllowed(string uploaderToken, bool allowed) => Session?.SetUploaderAllowed(uploaderToken, allowed);

    public SemaphoreSlim SendLock { get; } = new(1, 1);
}