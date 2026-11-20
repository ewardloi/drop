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
var totp = new TotpAuthenticator(builder.Configuration["DROP_TOTP_SECRET"]);

logger.LogWarning("TOTP provisioning URI (contains the shared secret): {OtpAuthUri}", totp.GetOtpAuthUri());
if (string.IsNullOrWhiteSpace(builder.Configuration["DROP_TOTP_SECRET"]))
    logger.LogWarning("Generated temporary TOTP secret: {TotpSecret}. Set DROP_TOTP_SECRET to this value to keep access codes stable across restarts.", totp.Secret);

app.UseForwardedHeaders();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });

var localSubnets = IpHelper.ParseLocalSubnets(
    builder.Configuration["LOCAL_SUBNETS"],
    invalid => logger.LogWarning("LOCAL_SUBNETS: ignoring invalid entry '{Entry}'", invalid));

if (localSubnets is null)
    logger.LogInformation("LOCAL_SUBNETS is not set: treating loopback, private IPv4 and ULA IPv6 addresses as local.");
else
    logger.LogInformation("LOCAL_SUBNETS: {Count} subnet(s) configured: {Subnets}", localSubnets.Count, string.Join(", ", localSubnets));

var hub = new RelayHub(logger, totp);

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
    var isLocalNetwork = IpHelper.IsPrivateOrLocalAddress(remoteIp, localSubnets);
    var accessMode = isLocalNetwork ? "upload+download" : "download-only";

    using var socket = await context.WebSockets.AcceptWebSocketAsync();

    logger.LogInformation("Client connected id={Id} name={Name} remote={RemoteIp} access={AccessMode}", id, name, remoteIp, accessMode);

    await hub.HandleClientAsync(id, name, socket, isLocalNetwork, context.RequestAborted);
});

app.Run();