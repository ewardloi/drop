(function () {
  "use strict";

  const log = window.Log.ws;
  const HEADER_SIZE = 28;

  function uuidToRfcBytes(uuid) {
    const hex = uuid.replace(/-/g, "");

    if (hex.length !== 32) throw new Error(`Invalid UUID: ${uuid}`);

    const bytes = new Uint8Array(16);

    for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);

    return bytes;
  }

  function rfcBytesToDotNetGuidBytes(b) {
    const g = new Uint8Array(16);

    g[0] = b[3];
    g[1] = b[2];
    g[2] = b[1];
    g[3] = b[0];
    g[4] = b[5];
    g[5] = b[4];
    g[6] = b[7];
    g[7] = b[6];

    for (let i = 8; i < 16; i++) g[i] = b[i];

    return g;
  }

  function dotNetGuidBytesToUuid(g) {
    const b = new Uint8Array(16);

    b[0] = g[3];
    b[1] = g[2];
    b[2] = g[1];
    b[3] = g[0];
    b[4] = g[5];
    b[5] = g[4];
    b[6] = g[7];
    b[7] = g[6];

    for (let i = 8; i < 16; i++) b[i] = g[i];

    const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function transferIdToHeaderBytes(transferId) {
    return rfcBytesToDotNetGuidBytes(uuidToRfcBytes(transferId));
  }

  class RelayClient extends EventTarget {
    constructor() {
      super();
      this.socket = null;
      this.id = null;
      this.name = null;
      this.reconnectDelay = 1000;
      this.shouldReconnect = true;
      this.connected = false;
    }

    connect(id, name) {
      this.id = id;
      this.name = name;
      this.shouldReconnect = true;
      this._open();
    }

    _open() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/ws?id=${encodeURIComponent(this.id)}&name=${encodeURIComponent(this.name)}`;

      log.info("Connecting to", url);

      const socket = new WebSocket(url);

      socket.binaryType = "arraybuffer";

      this.socket = socket;

      socket.addEventListener("open", () => {
        log.info("Connection open");

        this.connected = true;
        this.reconnectDelay = 1000;
        this.dispatchEvent(new CustomEvent("connected"));
      });

      socket.addEventListener("message", (ev) => this._onMessage(ev));

      socket.addEventListener("close", (ev) => {
        this.connected = false;

        log.warn(
          `Connection closed (code=${ev.code} reason=${ev.reason || "n/a"})`,
        );

        this.dispatchEvent(new CustomEvent("disconnected"));

        if (this.shouldReconnect) {
          log.info(`Reconnecting in ${this.reconnectDelay}ms`);
          setTimeout(() => this._open(), this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 15000);
        }
      });

      socket.addEventListener("error", (ev) => {
        log.error("Socket error", ev);
      });
    }

    disconnect() {
      this.shouldReconnect = false;
      this.socket?.close(1000, "client closing");
    }

    waitForOpen(timeoutMs = 60000, signal) {
      if (this.connected && this.socket?.readyState === WebSocket.OPEN) {
        return Promise.resolve();
      }

      return new Promise((resolve, reject) => {
        let settled = false;

        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.removeEventListener("connected", onConnected);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };

        const onConnected = () => {
          if (this.connected && this.socket?.readyState === WebSocket.OPEN) {
            finish();
          }
        };
        const onAbort = () =>
          finish(
            new DOMException("Waiting for connection was canceled.", "AbortError"),
          );
        const timer = setTimeout(
          () =>
            finish(
              new Error("Could not reconnect to the server within 60 seconds."),
            ),
          timeoutMs,
        );

        this.addEventListener("connected", onConnected);
        signal?.addEventListener("abort", onAbort, { once: true });

        if (signal?.aborted) onAbort();
        else onConnected();
      });
    }

    async _onMessage(ev) {
      if (typeof ev.data === "string") {
        let msg;

        try {
          msg = JSON.parse(ev.data);
        } catch (err) {
          log.error("Failed to parse JSON message", err, ev.data);
          return;
        }

        log.debug("-> ", msg.type, msg);

        this.dispatchEvent(new CustomEvent("message", { detail: msg }));
        this.dispatchEvent(
          new CustomEvent(`message:${msg.type}`, { detail: msg }),
        );

        return;
      }

      try {
        let buf;

        if (ev.data instanceof Blob) {
          buf = await ev.data.arrayBuffer();
        } else if (ev.data instanceof ArrayBuffer) {
          buf = ev.data;
        } else if (ev.data && ev.data.buffer instanceof ArrayBuffer) {
          buf = ev.data.buffer;
        } else {
          throw new Error("Unsupported binary message payload type");
        }

        const view = new DataView(buf);
        const transferIdBytes = new Uint8Array(buf, 0, 16);
        const transferId = dotNetGuidBytesToUuid(transferIdBytes);
        const fileIndex = view.getUint32(16, true);
        const offset = Number(view.getBigUint64(20, true));
        const payload = new Uint8Array(buf, HEADER_SIZE);

        this.dispatchEvent(
          new CustomEvent("chunk", {
            detail: { transferId, fileIndex, offset, payload },
          }),
        );
      } catch (err) {
        log.error("Failed to parse binary frame", err);
      }
    }

    sendJson(obj) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        log.error("Cannot send, socket not open", obj);
        throw new Error("Connection to the server is not open.");
      }

      log.debug("<- ", obj.type, obj);

      this.socket.send(JSON.stringify(obj));
    }

    sendChunk(transferId, fileIndex, offset, payload) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new Error("Connection to the server is not open.");
      }

      const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
      frame.set(transferIdToHeaderBytes(transferId), 0);

      const view = new DataView(frame.buffer);
      view.setUint32(16, fileIndex, true);
      view.setBigUint64(20, BigInt(offset), true);
      frame.set(payload, HEADER_SIZE);

      this.socket.send(
        frame.buffer.slice(
          frame.byteOffset,
          frame.byteOffset + frame.byteLength,
        ),
      );
    }

    get bufferedAmount() {
      return this.socket ? this.socket.bufferedAmount : 0;
    }

    async waitForDrain(threshold) {
      while (
        this.socket &&
        this.socket.readyState === WebSocket.OPEN &&
        this.socket.bufferedAmount > threshold
      ) {
        await new Promise((r) => setTimeout(r, 15));
      }
    }
  }

  window.RelayClient = RelayClient;
})();
