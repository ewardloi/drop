# Drop

A small AirDrop-like app: pick a device, drop files or a
whole folder onto it, the other side accepts or rejects, then the transfer
streams directly without ever holding a whole file in memory on either side.

## Run with Docker

```bash
docker compose up --build
```

The app listens on **http://localhost:10010**.

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
