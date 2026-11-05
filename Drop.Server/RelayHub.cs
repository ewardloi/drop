using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

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

internal sealed record TransferRoute(string SenderId, string ReceiverId);

public class RelayHub(ILogger logger, TotpAuthenticator totp)
{
    private readonly ConcurrentDictionary<string, ClientConnection> _clients = new();
    private readonly ConcurrentDictionary<string, ClientSession> _sessions = new();

    private readonly ConcurrentDictionary<string, TransferRoute> _transfers = new();

    private const int HeaderBufferSize = 64 * 1024;

    private const int HeaderSize = 28;

    private static readonly TimeSpan OfflineSessionLifetime = TimeSpan.FromMinutes(1);
    
    public async Task HandleClientAsync(string id, string name, WebSocket socket, bool canUpload, CancellationToken cancellationToken)
    {
        var client = new ClientConnection(id, name, socket, canUpload);
        _clients[id] = client;

        try
        {
            await ReceiveSessionHandshakeAsync(client, cancellationToken);
            await SendPeersToAllAsync(cancellationToken);
            await ReceiveLoopAsync(client, cancellationToken);
        }
        catch (WebSocketException wse)
        {
            logger.LogWarning("WebSocket error for client {Id}: {Message}", id, wse.Message);
        }
        catch (OperationCanceledException)
        {
            // normal shutdown
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Unhandled error for client {Id}", id);
        }
        finally
        {
            client.Session?.Touch();
            if (client.Session is { } disconnectedSession)
                _ = ExpireSessionAfterDisconnectAsync(disconnectedSession);

            if (_clients.TryGetValue(id, out var current) && ReferenceEquals(current, client))
                _clients.TryRemove(id, out _);
            
            await NotifyPeerLeftAsync(id, cancellationToken);
            await SendPeersToAllAsync(CancellationToken.None);
            
            logger.LogInformation("Client disconnected id={Id}", id);
        }
    }

    private async Task ReceiveSessionHandshakeAsync(ClientConnection client, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        ct = timeout.Token;

        using var ms = new MemoryStream();
        var buffer = new byte[HeaderBufferSize];
        WebSocketReceiveResult result;

        do
        {
            result = await client.Socket.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close)
                throw new OperationCanceledException("Client disconnected before session resume.", ct);
            if (result.MessageType != WebSocketMessageType.Text)
                throw new InvalidDataException("Expected a session resume message.");

            ms.Write(buffer, 0, result.Count);
        } while (!result.EndOfMessage);

        if (JsonNode.Parse(ms.ToArray()) is not JsonObject obj
            || obj["type"]?.GetValue<string>() != "resume-session")
            throw new InvalidDataException("Expected a session resume message.");

        var requestedToken = obj["token"]?.GetValue<string>();
        PruneExpiredSessions();

        ClientSession? session = null;
        if (requestedToken is { Length: 43 }
            && requestedToken.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_'))
            _sessions.TryGetValue(requestedToken, out session);

        if (session is null)
        {
            session = new ClientSession(CreateSessionToken());
            _sessions[session.Token] = session;
        }

        session.Touch();
        client.SetSession(session);

        await SafeSendJsonAsync(client, new JsonObject
        {
            ["type"] = "session-ready",
            ["token"] = session.Token
        }, ct);
    }

    private void PruneExpiredSessions()
    {
        var expiredBefore = DateTime.UtcNow - OfflineSessionLifetime;

        foreach (var session in _sessions.Values)
        {
            if (session.LastSeenUtc < expiredBefore)
                ExpireSessionIfInactive(session);
        }
    }

    private async Task ExpireSessionAfterDisconnectAsync(ClientSession session)
    {
        await Task.Delay(OfflineSessionLifetime);
        ExpireSessionIfInactive(session);
    }

    private void ExpireSessionIfInactive(ClientSession session)
    {
        if (session.LastSeenUtc >= DateTime.UtcNow - OfflineSessionLifetime
            || _clients.Values.Any(client => ReferenceEquals(client.Session, session)))
            return;

        if (!_sessions.TryRemove(session.Token, out _)) return;

        foreach (var otherSession in _sessions.Values)
            otherSession.SetUploaderAllowed(session.Token, false);
    }

    private static string CreateSessionToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        .TrimEnd('=')
        .Replace('+', '-')
        .Replace('/', '_');

    private async Task ReceiveLoopAsync(ClientConnection client, CancellationToken ct)
    {
        var headerBuffer = new byte[HeaderBufferSize];

        while (client.Socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            client.Session?.Touch();
            using var ms = new MemoryStream();
            WebSocketReceiveResult result;

            do
            {
                result = await client.Socket.ReceiveAsync(headerBuffer, ct);

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    logger.LogInformation("Client {Id} sent close frame", client.Id);
                
                    await client.Socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", ct);

                    return;
                }

                ms.Write(headerBuffer, 0, result.Count);
            } while (!result.EndOfMessage);

            var payload = ms.ToArray();

            try
            {
                if (result.MessageType == WebSocketMessageType.Text)
                    await HandleTextMessageAsync(client, payload, ct);
                else
                    await HandleBinaryFrameAsync(client, payload, ct);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error handling message from {Id}", client.Id);

                await SafeSendJsonAsync(client, new JsonObject
                {
                    ["type"] = "error",
                    ["message"] = $"Server failed to process your message: {ex.Message}"
                }, ct);
            }
        }
    }

    private async Task HandleTextMessageAsync(ClientConnection client, byte[] payload, CancellationToken ct)
    {
        var text = Encoding.UTF8.GetString(payload);
        
        JsonNode? node;
        
        try
        {
            node = JsonNode.Parse(text);
        }
        catch (JsonException ex)
        {
            logger.LogWarning("Malformed JSON from {Id}: {Msg}", client.Id, ex.Message);
            return;
        }

        if (node is not JsonObject obj || obj["type"] is not { } typeNode)
        {
            logger.LogWarning("Message from {Id} missing 'type'", client.Id);
            return;
        }

        var type = typeNode.GetValue<string>();
        
        logger.LogInformation("<- {Type} from {Id}", type, client.Id);

        switch (type)
        {
            case "rename":
            {
                var newName = obj["name"]?.GetValue<string>();
                if (!string.IsNullOrWhiteSpace(newName))
                {
                    client.Name = newName;
                    await SendPeersToAllAsync(ct);
                }
                break;
            }
            case "request-access":
            {
                var validCode = totp.Validate(obj["code"]?.GetValue<string>());
                var granted = client.CanUpload || validCode;
                if (validCode && !client.IsLocalNetwork)
                {
                    client.Session?.GrantTotpAccess();
                    logger.LogInformation("Elevated network access granted to client {Id}", client.Id);
                }

                await SafeSendJsonAsync(client, new JsonObject
                {
                    ["type"] = "access-result",
                    ["granted"] = granted
                }, ct);

                if (granted)
                    await SendPeersToAllAsync(ct);

                break;
            }
            case "set-uploader-permission":
            {
                if (!client.CanUpload) break;

                var uploaderId = obj["uploaderId"]?.GetValue<string>();
                var allowed = obj["allowed"]?.GetValue<bool>() ?? false;
                if (string.IsNullOrWhiteSpace(uploaderId) || uploaderId == client.Id) break;

                if (client.Session is null
                    || !_clients.TryGetValue(uploaderId, out var uploader)
                    || uploader.Session is null
                    || uploader.Session.Token == client.Session.Token)
                    break;

                client.SetUploaderAllowed(uploader.Session.Token, allowed);
                if (!allowed)
                    await CancelTransfersFromAsync(uploaderId, client.Id, ct);

                await SendPeersToAllAsync(ct);
                break;
            }
            case "transfer-request":
            {
                var transferId = obj["transferId"]?.GetValue<string>();
                var targetId = obj["targetId"]?.GetValue<string>();

                if (transferId is null || targetId is null) break;

                if (!_clients.TryGetValue(targetId, out var target))
                {
                    await SafeSendJsonAsync(client, new JsonObject
                    {
                        ["type"] = "transfer-cancel",
                        ["transferId"] = transferId,
                        ["reason"] = "Recipient is no longer online."
                    }, ct);
                    break;
                }

                if (!client.CanUpload
                    && (client.Session is null || !target.AllowsUploader(client.Session.Token)))
                {
                    await SafeSendJsonAsync(client, new JsonObject
                    {
                        ["type"] = "transfer-cancel",
                        ["transferId"] = transferId,
                        ["reason"] = "Uploads are disabled for public network clients."
                    }, ct);
                    break;
                }

                _transfers[transferId] = new TransferRoute(client.Id, targetId);

                var relayed = obj.DeepClone()!.AsObject();
                
                relayed["fromId"] = client.Id;
                relayed["fromName"] = client.Name;
                relayed.Remove("targetId");
                
                await SafeSendJsonAsync(target, relayed, ct);
                break;
            }
            case "transfer-response":
            case "file-start":
            case "file-end":
            case "file-ack":
            case "resend-chunk":
            case "webrtc-offer":
            case "webrtc-answer":
            case "webrtc-ice":
            case "transfer-complete":
            case "transfer-cancel":
            {
                var transferId = obj["transferId"]?.GetValue<string>();
                if (transferId is null || !_transfers.TryGetValue(transferId, out var route)) break;

                var otherId = route.SenderId == client.Id ? route.ReceiverId : route.SenderId;
                if (_clients.TryGetValue(otherId, out var other))
                    await SafeSendJsonAsync(other, obj, ct);

                if (type is "transfer-complete" or "transfer-cancel")
                    _transfers.TryRemove(transferId, out _);

                break;
            }

            default:
                logger.LogWarning("Unknown message type '{Type}' from {Id}", type, client.Id);
                break;
        }
    }

    private async Task HandleBinaryFrameAsync(ClientConnection client, byte[] frame, CancellationToken ct)
    {
        if (frame.Length < HeaderSize)
        {
            logger.LogWarning("Binary frame from {Id} too small ({Len} bytes)", client.Id, frame.Length);
            return;
        }

        var transferIdBytes = frame.AsSpan(0, 16).ToArray();
        var transferId = new Guid(transferIdBytes).ToString();

        if (!_transfers.TryGetValue(transferId, out var route))
        {
            logger.LogWarning("Binary frame for unknown transfer {TransferId} from {Id}", transferId, client.Id);
            return;
        }

        var otherId = route.SenderId == client.Id ? route.ReceiverId : route.SenderId;

        if (!_clients.TryGetValue(otherId, out var other))
        {
            logger.LogWarning("Cannot relay chunk, peer {OtherId} offline", otherId);

            await SafeSendJsonAsync(client, new JsonObject
            {
                ["type"] = "transfer-cancel",
                ["transferId"] = transferId,
                ["reason"] = "Peer disconnected during transfer."
            }, ct);

            return;
        }

        await SafeSendBinaryAsync(other, frame, ct);
    }

    private async Task NotifyPeerLeftAsync(string clientId, CancellationToken ct)
    {
        foreach (var (key, route) in _transfers)
        {
            if (route.SenderId != clientId && route.ReceiverId != clientId) continue;

            var otherId = route.SenderId == clientId ? route.ReceiverId : route.SenderId;

            if (_clients.TryGetValue(otherId, out var other))
            {
                await SafeSendJsonAsync(other, new JsonObject
                {
                    ["type"] = "transfer-cancel",
                    ["transferId"] = key,
                    ["reason"] = "The other device disconnected."
                }, ct);
            }
            
            _transfers.TryRemove(key, out _);
        }
    }

    private async Task CancelTransfersFromAsync(string uploaderId, string receiverId, CancellationToken ct)
    {
        foreach (var (transferId, route) in _transfers)
        {
            if (route.SenderId != uploaderId || route.ReceiverId != receiverId) continue;

            var message = new JsonObject
            {
                ["type"] = "transfer-cancel",
                ["transferId"] = transferId,
                ["reason"] = "Upload access was revoked."
            };

            if (_clients.TryGetValue(uploaderId, out var uploader))
                await SafeSendJsonAsync(uploader, message.DeepClone(), ct);
            if (_clients.TryGetValue(receiverId, out var receiver))
                await SafeSendJsonAsync(receiver, message, ct);

            _transfers.TryRemove(transferId, out _);
        }
    }

    private async Task SendPeersToAllAsync(CancellationToken ct)
    {
        var onlineClients = _clients.Values.Where(client => client.Session is not null).ToArray();

        foreach (var client in onlineClients)
        {
            var peers = new JsonArray();
            var session = client.Session!;
            var visiblePeers = client.CanUpload
                ? onlineClients.Where(other => other.Id != client.Id).ToArray()
                : onlineClients.Where(other => other.Id != client.Id && other.AllowsUploader(session.Token)).ToArray();

            foreach (var other in visiblePeers)
            {
                var otherSession = other.Session!;
                peers.Add(new JsonObject
                {
                    ["id"] = other.Id,
                    ["name"] = other.Name,
                    ["canUpload"] = other.CanUpload,
                    ["isLocalNetwork"] = other.IsLocalNetwork,
                    ["canUploadToSelf"] = session.AllowsUploader(otherSession.Token)
                });
            }

            await SafeSendJsonAsync(client, new JsonObject
            {
                ["type"] = "peers",
                ["selfId"] = client.Id,
                ["selfName"] = client.Name,
                ["selfCanUpload"] = client.CanUpload || visiblePeers.Length > 0,
                ["canManageUploaders"] = client.CanUpload,
                ["peers"] = peers
            }, ct);
        }
    }

    private async Task SafeSendJsonAsync(ClientConnection client, JsonNode node, CancellationToken ct)
    {
        try
        {
            var json = node.ToJsonString();
            var bytes = Encoding.UTF8.GetBytes(json);
            
            await client.SendLock.WaitAsync(ct);
            
            try
            {
                if (client.Socket.State != WebSocketState.Open) return;
            
                await client.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
            }
            finally
            {
                client.SendLock.Release();
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning("Failed sending JSON to {Id}: {Msg}", client.Id, ex.Message);
        }
    }

    private async Task SafeSendBinaryAsync(ClientConnection client, byte[] data, CancellationToken ct)
    {
        try
        {
            await client.SendLock.WaitAsync(ct);

            try
            {
                if (client.Socket.State != WebSocketState.Open) return;

                await client.Socket.SendAsync(data, WebSocketMessageType.Binary, true, ct);
            }
            finally
            {
                client.SendLock.Release();
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning("Failed relaying chunk to {Id}: {Msg}", client.Id, ex.Message);
        }
    }
}