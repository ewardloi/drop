using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Drop.Server;

internal sealed class ClientConnection(string id, string name, WebSocket socket, bool canUpload)
{
    public string Id { get; } = id;
    
    public string Name { get; set; } = name;
    
    public WebSocket Socket { get; } = socket;

    public bool CanUpload { get; } = canUpload;

    public SemaphoreSlim SendLock { get; } = new(1, 1);
}

internal sealed record TransferRoute(string SenderId, string ReceiverId);

public class RelayHub(ILogger logger)
{
    private readonly ConcurrentDictionary<string, ClientConnection> _clients = new();
    
    private readonly ConcurrentDictionary<string, TransferRoute> _transfers = new();

    private const int HeaderBufferSize = 64 * 1024;

    private const int HeaderSize = 28;
    
    public async Task HandleClientAsync(string id, string name, WebSocket socket, bool canUpload, CancellationToken cancellationToken)
    {
        var client = new ClientConnection(id, name, socket, canUpload);
        _clients[id] = client;

        try
        {
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
            _clients.TryRemove(id, out _);
            
            await NotifyPeerLeftAsync(id, cancellationToken);
            await SendPeersToAllAsync(CancellationToken.None);
            
            logger.LogInformation("Client disconnected id={Id}", id);
        }
    }

    private async Task ReceiveLoopAsync(ClientConnection client, CancellationToken ct)
    {
        var headerBuffer = new byte[HeaderBufferSize];

        while (client.Socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
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
            case "transfer-request":
            {
                var transferId = obj["transferId"]?.GetValue<string>();
                var targetId = obj["targetId"]?.GetValue<string>();

                if (transferId is null || targetId is null) break;

                if (!client.CanUpload)
                {
                    await SafeSendJsonAsync(client, new JsonObject
                    {
                        ["type"] = "transfer-cancel",
                        ["transferId"] = transferId,
                        ["reason"] = "Uploads are disabled for public network clients."
                    }, ct);
                    break;
                }

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

    private async Task SendPeersToAllAsync(CancellationToken ct)
    {
        foreach (var client in _clients.Values)
        {
            var peers = new JsonArray();

            if (client.CanUpload)
            {
                foreach (var other in _clients.Values)
                {
                    if (other.Id == client.Id) continue;

                    peers.Add(new JsonObject
                    {
                        ["id"] = other.Id,
                        ["name"] = other.Name,
                        ["canUpload"] = other.CanUpload
                    });
                }
            }

            await SafeSendJsonAsync(client, new JsonObject
            {
                ["type"] = "peers",
                ["selfId"] = client.Id,
                ["selfName"] = client.Name,
                ["selfCanUpload"] = client.CanUpload,
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