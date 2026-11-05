# Drop

A small AirDrop-like app: pick a device, drop files or a
whole folder onto it, the other side accepts or rejects, then the transfer
streams directly without ever holding a whole file in memory on either side.

## Run with Docker

```bash
docker compose up --build
```

The app listens on **http://localhost:10010**.

On startup, the server logs a TOTP provisioning URI. If `DROP_TOTP_SECRET` is
not set, it generates a temporary secret and logs its Base32 value. To keep
authenticator codes valid across container restarts, put that value in a
`.env` file next to `docker-compose.yaml`:

```dotenv
DROP_TOTP_SECRET=BASE32_SECRET_FROM_THE_LOG
```

The provisioning URI and generated secret are credentials; restrict access to
container logs and do not publish them.

Remote TOTP access and per-device upload permissions survive reconnects in the
same browser tab. A session can resume for up to one minute after disconnect;
after that its access and upload permissions are dropped. Restarting the server
also clears them.

## Run without Docker

Requires the .NET 10 SDK.

```bash
cd Drop.Server
dotnet run
```

By default this listens on the port ASP.NET Core picks (see console output);
open that URL from two different devices/tabs on the same network.

## How it works

- **Signaling & relay**: one WebSocket per client (`Server/Program.cs`).
  JSON text frames carry control messages (who's online, transfer requests,
  accept/reject, per-file start/end). Binary frames carry file chunks with a
  28-byte header (transfer id, file index, byte offset) and are relayed by
  the server without ever buffering more than a single chunk.
- **Sending**: files are read with `File.slice()` in 256 KB chunks and sent
  over the WebSocket with basic backpressure (`bufferedAmount`), so a
  multi-gigabyte file never sits fully in the browser's memory.
- **Receiving**: chunks are written straight into the Origin Private File
  System (OPFS) via `FileSystemWritableFileStream`, again one chunk at a
  time. Completed files can be downloaded, deleted, or downloaded all at
  once, straight from OPFS.
- **Queueing**: only one outgoing and one incoming transfer are active at a
  time; anything else waits its turn and is shown with a queued status.

## Browser support notes

OPFS with `createWritable()` and async directory iteration are supported by
current Chrome/Edge, Firefox, and Safari. Very old browser versions may lack
async directory iteration in OPFS; Beam surfaces that as a clear on-screen
error rather than failing silently.
