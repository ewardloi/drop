(function () {
  "use strict";

  const log = window.Log.webrtc;

  const HEADER_SIZE = 28;

  const DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  function uuidToBytes(uuid) {
    const hex = uuid.replace(/-/g, "");
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }

  function bytesToUuid(bytes) {
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  class WebRtcTransport extends EventTarget {
    constructor(relayClient, transferId) {
      super();
      this.relayClient = relayClient;
      this.transferId = transferId;
      this.pc = null;
      this.channel = null;
      this.connected = false;
      this._signalHandlers = [];
    }

    async connect(isInitiator, timeoutMs = 8000) {
      try {
        this.pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });

        this.pc.onicecandidate = (e) => {
          if (e.candidate) {
            this._sendSignal("webrtc-ice", { candidate: e.candidate });
          }
        };

        this.pc.onconnectionstatechange = () => {
          if (["failed", "closed"].includes(this.pc?.connectionState)) {
            this._onClosed();
          }
        };

        const channelOpen = new Promise((resolve) => {
          const wireUp = (channel) => {
            this.channel = channel;
            channel.binaryType = "arraybuffer";
            channel.onopen = () => {
              this.connected = true;
              resolve(true);
            };
            channel.onclose = () => this._onClosed();
            channel.onerror = (e) =>
              log.error(`Data channel error for transfer ${this.transferId}`, e);
            channel.onmessage = (e) => this._onMessage(e);
          };

          if (isInitiator) {
            wireUp(this.pc.createDataChannel("drop", { ordered: true }));
          } else {
            this.pc.ondatachannel = (e) => wireUp(e.channel);
          }
        });

        this._addSignalHandler("webrtc-offer", async (msg) => {
          await this.pc.setRemoteDescription(msg.sdp);
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this._sendSignal("webrtc-answer", { sdp: answer });
        });

        this._addSignalHandler("webrtc-answer", async (msg) => {
          await this.pc.setRemoteDescription(msg.sdp);
        });

        this._addSignalHandler("webrtc-ice", async (msg) => {
          try {
            await this.pc.addIceCandidate(msg.candidate);
          } catch (err) {
            log.warn(
              `Failed adding ICE candidate for transfer ${this.transferId}`,
              err,
            );
          }
        });

        if (isInitiator) {
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          this._sendSignal("webrtc-offer", { sdp: offer });
        }

        const timedOut = new Promise((resolve) =>
          setTimeout(() => resolve(false), timeoutMs),
        );

        const ok = await Promise.race([channelOpen, timedOut]);

        if (!ok) {
          log.warn(
            `Data channel for transfer ${this.transferId} did not open within ${timeoutMs}ms`,
          );
          this.close();
          return false;
        }

        log.info(`Data channel open for transfer ${this.transferId}`);
        return true;
      } catch (err) {
        log.warn(`WebRTC setup failed for transfer ${this.transferId}`, err);
        this.close();
        return false;
      }
    }

    _addSignalHandler(type, handler) {
      const wrapped = (e) => {
        if (e.detail.transferId !== this.transferId) return;
        handler(e.detail).catch((err) =>
          log.error(`Error handling ${type} for transfer ${this.transferId}`, err),
        );
      };
      this.relayClient.addEventListener(`message:${type}`, wrapped);
      this._signalHandlers.push([`message:${type}`, wrapped]);
    }

    _sendSignal(type, payload) {
      try {
        this.relayClient.sendJson({ type, transferId: this.transferId, ...payload });
      } catch (err) {
        log.error(`Failed sending ${type} signal`, err);
      }
    }

    _onClosed() {
      if (!this.connected) return;
      this.connected = false;
      this.dispatchEvent(new CustomEvent("disconnected"));
    }

    _onMessage(event) {
      if (typeof event.data === "string") {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          log.error("Received malformed JSON over data channel", err);
          return;
        }
        this.dispatchEvent(new CustomEvent("message", { detail: msg }));
        this.dispatchEvent(
          new CustomEvent(`message:${msg.type}`, { detail: msg }),
        );
        return;
      }

      const buf = event.data;

      if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEADER_SIZE) {
        log.warn("Malformed data channel frame (too short)");
        return;
      }

      const view = new DataView(buf);
      const transferId = bytesToUuid(new Uint8Array(buf, 0, 16));
      const fileIndex = view.getUint32(16, true);
      const offset = Number(view.getBigUint64(20, true));
      const payload = new Uint8Array(buf, HEADER_SIZE);

      this.dispatchEvent(
        new CustomEvent("chunk", {
          detail: { transferId, fileIndex, offset, payload },
        }),
      );
    }

    sendJson(obj) {
      if (!this.channel || this.channel.readyState !== "open") {
        throw new Error("WebRTC data channel is not open.");
      }
      this.channel.send(JSON.stringify(obj));
    }

    sendChunk(transferId, fileIndex, offset, payload) {
      if (!this.channel || this.channel.readyState !== "open") {
        throw new Error("WebRTC data channel is not open.");
      }

      const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
      frame.set(uuidToBytes(transferId), 0);

      const view = new DataView(frame.buffer);
      view.setUint32(16, fileIndex, true);
      view.setBigUint64(20, BigInt(offset), true);
      frame.set(payload, HEADER_SIZE);

      this.channel.send(frame.buffer);
    }

    async waitForDrain(threshold) {
      while (
        this.channel &&
        this.channel.readyState === "open" &&
        this.channel.bufferedAmount > threshold
      ) {
        await new Promise((r) => setTimeout(r, 15));
      }
    }

    close() {
      for (const [type, fn] of this._signalHandlers) {
        this.relayClient.removeEventListener(type, fn);
      }
      this._signalHandlers = [];

      if (this.channel) {
        try {
          this.channel.close();
        } catch {
          // ignore
        }
      }
      if (this.pc) {
        try {
          this.pc.close();
        } catch {
          // ignore
        }
      }

      this.channel = null;
      this.pc = null;
      this.connected = false;
    }
  }

  window.WebRtcTransport = WebRtcTransport;
})();
