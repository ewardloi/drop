using Drop.Server;
using Drop.Server.Helpers;
using Microsoft.AspNetCore.HttpOverrides;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.AddSimpleConsole(o =>
{
    o.SingleLine = true;
    o.TimestampFormat = "HH:mm:ss.fff ";
});

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

var app = builder.Build();
var logger = app.Logger;

app.UseForwardedHeaders();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });

var hub = new RelayHub(logger);

app.Map("/ws", async context =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsync("Expected a WebSocket request.");
        return;
    }

    var id = context.Request.Query["id"].ToString();
    var name = context.Request.Query["name"].ToString();

    if (string.IsNullOrWhiteSpace(id))
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsync("Missing 'id' query parameter.");
        return;
    }

    if (string.IsNullOrWhiteSpace(name))
    {
        name = "Unnamed device";
    }

    var remoteIp = IpHelper.ResolveClientIpAddress(context);
    var canUpload = IpHelper.IsPrivateOrLocalAddress(remoteIp);
    var accessMode = canUpload ? "upload+download" : "download-only";

    using var socket = await context.WebSockets.AcceptWebSocketAsync();

    logger.LogInformation("Client connected id={Id} name={Name} remote={RemoteIp} access={AccessMode}", id, name, remoteIp, accessMode);

    await hub.HandleClientAsync(id, name, socket, canUpload, context.RequestAborted);
});

app.Run();