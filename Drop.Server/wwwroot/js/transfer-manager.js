(function () {
  "use strict";

  const log = window.Log.transfer;
  const CHUNK_SIZE = 256 * 1024;
  const BACKPRESSURE_THRESHOLD = 4 * 1024 * 1024;

  function newId() {
    return crypto.randomUUID();
  }

  async function withRetry(
    fn,
    { retries = 3, baseDelayMs = 200, label, retryable } = {},
  ) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;

        if (retryable && !retryable(err)) break;
        if (attempt === retries) break;
        
        const delay = baseDelayMs * Math.pow(2, attempt);
        
        if (label)
          log.warn(
            `${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms`,
            err,
          );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  function totalSize(files) {
    return files.reduce((sum, f) => sum + f.size, 0);
  }

  function updateTransferProgress(job) {
    const now = Date.now();
    const doneBytes =
      job.direction === "outgoing" ? job.sentBytes : job.receivedBytes;

    if (!job.startedAt) job.startedAt = now;

    if (job.lastProgressAt == null) {
      job.lastProgressAt = now;
      job.lastProgressBytes = doneBytes;
      job.speedBytesPerSecond = 0;
      return;
    }

    const elapsedSinceLast = (now - job.lastProgressAt) / 1000;

    if (elapsedSinceLast < 0.2) return;

    const bytesSinceLast = doneBytes - job.lastProgressBytes;
    const instantaneousSpeed = Math.max(bytesSinceLast, 0) / elapsedSinceLast;

    const alpha = 0.3;
    job.speedBytesPerSecond =
      job.speedBytesPerSecond > 0
        ? Math.round(
            alpha * instantaneousSpeed + (1 - alpha) * job.speedBytesPerSecond,
          )
        : Math.round(instantaneousSpeed);

    job.lastProgressAt = now;
    job.lastProgressBytes = doneBytes;
  }

  function resetProgressClock(job, doneBytes) {
    job.lastProgressAt = Date.now();
    job.lastProgressBytes = doneBytes;
  }

  class TransferManager extends EventTarget {
    constructor(relayClient) {
      super();

      this.rc = relayClient;

      this.transportMode = "auto";
      this.webrtcEnabled = true;
      this.outgoing = new Map();
      this.incoming = new Map();
      this.outgoingQueue = [];
      this.incomingQueue = [];
      this.outgoingBusy = false;
      this.incomingBusy = false;
      this._pendingResponses = new Map();
      this._pendingFileAcks = new Map();

      window.OpfsStore?.ensurePersisted?.();

      this.rc.addEventListener("message:transfer-request", (e) =>
        this._onIncomingRequest(e.detail),
      );
      this.rc.addEventListener("message:transfer-response", (e) =>
        this._onTransferResponse(e.detail),
      );
      this.rc.addEventListener("message:transfer-cancel", (e) =>
        this._onTransferCancel(e.detail),
      );
      this.rc.addEventListener("message:transfer-complete", (e) =>
        this._onTransferCompleteMsg(e.detail),
      );
      this.rc.addEventListener("disconnected", () => this._onDisconnected());

      this._wireDataListeners(this.rc);

      this._progressTickTimer = setInterval(() => this._tickStaleProgress(), 1000);
    }

    _wireDataListeners(transport) {
      transport.addEventListener("message:file-start", (e) =>
        this._onFileStart(e.detail, transport),
      );
      transport.addEventListener("message:file-end", (e) =>
        this._onFileEnd(e.detail, transport),
      );
      transport.addEventListener("message:file-ack", (e) =>
        this._onFileAck(e.detail, transport),
      );
      transport.addEventListener("message:resend-chunk", (e) =>
        this._onResendChunkRequest(e.detail, transport),
      );
      transport.addEventListener("chunk", (e) =>
        this._onChunk(e.detail, transport),
      );
    }

    _sendJsonFor(job, obj) {
      try {
        job.transport.sendJson(obj);
      } catch (err) {
        if (job.transport === this.rc) throw err;

        log.warn(
          `WebRTC send failed for transfer ${job.transferId}, falling back to relay`,
          err,
        );
        job.transport = this.rc;
        this.rc.sendJson(obj);
      }
    }

    async _sendJsonWhenOpen(obj, timeoutMs, signal) {
      const deadline = Date.now() + timeoutMs;
      let lastError;

      while (Date.now() < deadline) {
        await this.rc.waitForOpen(deadline - Date.now(), signal);

        try {
          this.rc.sendJson(obj);
          return;
        } catch (err) {
          if (err.message !== "Connection to the server is not open.") throw err;
          lastError = err;
        }
      }

      throw lastError || new Error("Could not reconnect to the server in time.");
    }

    _sendChunkFor(job, transferId, fileIndex, offset, payload) {
      try {
        job.transport.sendChunk(transferId, fileIndex, offset, payload);
      } catch (err) {
        if (job.transport === this.rc) throw err;

        log.warn(
          `WebRTC send failed for transfer ${transferId}, falling back to relay`,
          err,
        );
        job.transport = this.rc;
        this.rc.sendChunk(transferId, fileIndex, offset, payload);
      }
    }

    _tickStaleProgress() {
      const STALL_MS = 1500;
      const now = Date.now();
      let outgoingChanged = false;
      let incomingChanged = false;

      for (const job of this.outgoing.values()) {
        if (job.status !== "sending" || job.phase === "finalizing") continue;
        if (
          job.speedBytesPerSecond > 0 &&
          job.lastProgressAt != null &&
          now - job.lastProgressAt > STALL_MS
        ) {
          job.speedBytesPerSecond = 0;
          outgoingChanged = true;
        }
      }

      for (const job of this.incoming.values()) {
        if (job.status !== "receiving" || job.phase === "finalizing") continue;
        if (
          job.speedBytesPerSecond > 0 &&
          job.lastProgressAt != null &&
          now - job.lastProgressAt > STALL_MS
        ) {
          job.speedBytesPerSecond = 0;
          incomingChanged = true;
        }
      }

      if (outgoingChanged) this._emitOutgoing();
      if (incomingChanged) this._emitIncoming();
    }

    _onFileAck(msg, transport) {
      const key = `${msg.transferId}:${msg.fileIndex}`;
      const resolve = this._pendingFileAcks.get(key);

      if (transport) {
        const job = this.outgoing.get(msg.transferId);
        if (job) job.transport = transport;
      }

      if (resolve) {
        this._pendingFileAcks.delete(key);
        resolve(true);
      }
    }

    async _onResendChunkRequest(msg, transport) {
      const job = this.outgoing.get(msg.transferId);
      if (!job) return;

      if (transport) job.transport = transport;

      const f =
        job.files.find((file) => file.index === msg.fileIndex) ||
        job.files[msg.fileIndex];
      if (!f) return;

      const offset = msg.offset;
      if (typeof offset !== "number" || offset < 0 || offset >= f.size) return;

      const end = Math.min(offset + CHUNK_SIZE, f.size);

      try {
        const buf = await withRetry(
          async () => {
            const b = await f.file.slice(offset, end).arrayBuffer();
            const expectedLen = end - offset;

            if (b.byteLength !== expectedLen) {
              throw new Error(
                `Short read at offset ${offset}: expected ${expectedLen} bytes, got ${b.byteLength}`,
              );
            }

            return b;
          },
          {
            retries: 3,
            baseDelayMs: 200,
            label: `Re-reading "${f.name}" at offset ${offset} for resend`,
          },
        );
        this._sendChunkFor(job, msg.transferId, f.index, offset, new Uint8Array(buf));
        log.info(
          `Resent chunk at offset ${offset} for "${f.name}" (transfer ${msg.transferId}) on request`,
        );
      } catch (err) {
        log.error(
          `Failed to resend chunk at offset ${offset} for "${f.name}"`,
          err,
        );
      }
    }

    _waitForFileAck(transferId, fileIndex, timeoutMs = 180000) {
      const key = `${transferId}:${fileIndex}`;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pendingFileAcks.delete(key);
          reject(
            new Error(
              "Timed out waiting for the receiver to finish saving the file.",
            ),
          );
        }, timeoutMs);

        this._pendingFileAcks.set(key, (ok) => {
          clearTimeout(timer);
          if (ok) {
            resolve();
          } else {
            reject(
              new Error(
                "Connection lost while waiting for the receiver to finish saving the file.",
              ),
            );
          }
        });
      });
    }

    _rejectPendingFileAcks(transferId) {
      const prefix = `${transferId}:`;

      for (const [key, resolve] of [...this._pendingFileAcks.entries()]) {
        if (key.startsWith(prefix)) {
          this._pendingFileAcks.delete(key);
          resolve(false);
        }
      }
    }

    _onDisconnected() {
      for (const job of this.outgoing.values()) {
        if (job.status === "requesting") {
          job.status = "error";
          job.error = "Connection lost.";
        }
      }
      for (const transferId of [...this._pendingResponses.keys()]) {
        this._resolvePending(transferId, false);
      }
      for (const transferId of this.outgoing.keys()) {
        this._rejectPendingFileAcks(transferId);
      }

      for (const job of [...this.incoming.values()]) {
        if (
          ["pending-queue", "pending-decision", "receiving"].includes(
            job.status,
          )
        ) {
          this._abortIncoming(job, "Connection lost.");
        }
      }
    }

    _emitOutgoing() {
      this.dispatchEvent(
        new CustomEvent("outgoing-changed", {
          detail: [...this.outgoing.values()],
        }),
      );
    }
    _emitIncoming() {
      this.dispatchEvent(
        new CustomEvent("incoming-changed", {
          detail: [...this.incoming.values()],
        }),
      );
    }
    _toast(message, kind) {
      this.dispatchEvent(
        new CustomEvent("toast", { detail: { message, kind } }),
      );
    }

    _scheduleForget(map, transferId, emit) {
      setTimeout(() => {
        map.delete(transferId);
        emit();
      }, 5000);
    }

    queueSend(targetId, targetName, fileEntries, forceRelay = false, transferKind = "file") {
      if (!Array.isArray(fileEntries) || fileEntries.length === 0) {
        return [];
      }

      const transferId = newId();
      const files = fileEntries.map((entry, index) => ({
        index,
        name: entry.file.name,
        relativePath: entry.relativePath,
        size: entry.file.size,
        file: entry.file,
      }));

      const job = {
        transferId,
        direction: "outgoing",
        targetId,
        targetName,
        files,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        sentBytes: 0,
        status: "queued",
        currentFileIndex: -1,
        completedFileIndices: new Set(),
        error: null,
        startedAt: null,
        speedBytesPerSecond: 0,
        forceRelay,
        transferKind,
        phase: "transferring",
        transport: this.rc,
        webrtcTransport: null,
      };

      this.outgoing.set(transferId, job);
      this.outgoingQueue.push(transferId);

      log.info(
        `Queued 1 outgoing transfer containing ${files.length} file(s) to ${targetName}`,
      );
      this._emitOutgoing();
      this._pumpOutgoing();
      return [transferId];
    }

    cancelOutgoing(transferId) {
      const job = this.outgoing.get(transferId);

      if (!job) return;
      log.info(`Canceling outgoing transfer ${transferId}`);

      job.status = "canceled";
      job.connectionWaitController?.abort();

      try {
        this.rc.sendJson({
          type: "transfer-cancel",
          transferId,
          reason: "Canceled by sender.",
        });
      } catch (err) {
        log.error("Failed to send cancel", err);
      }

      this._emitOutgoing();
      this._resolvePending(transferId, false);
      this._rejectPendingFileAcks(transferId);

      if (job.webrtcTransport) {
        job.webrtcTransport.close();
        job.webrtcTransport = null;
      }
      job.transport = this.rc;
    }

    async _pumpOutgoing() {
      if (this.outgoingBusy) return;
      const nextId = this.outgoingQueue.shift();

      if (!nextId) return;
      this.outgoingBusy = true;

      try {
        await this._runOutgoing(nextId);
      } catch (err) {
        const job = this.outgoing.get(nextId);

        if (!job || job.status === "canceled") {
          log.info(`Outgoing transfer ${nextId} canceled`);

          if (job) {
            this._scheduleForget(this.outgoing, nextId, () =>
              this._emitOutgoing(),
            );
          }
        } else {
          log.error(`Outgoing transfer ${nextId} failed`, err);
          
          job.status = "error";
          job.error = err.message;

          try {
            this.rc.sendJson({
              type: "transfer-cancel",
              transferId: nextId,
              reason: err.message,
            });
          } catch (sendErr) {
            log.error("Failed to notify receiver of send failure", sendErr);
          }

          if (job.webrtcTransport) {
            job.webrtcTransport.close();
            job.webrtcTransport = null;
          }
          job.transport = this.rc;

          this._emitOutgoing();
          this._scheduleForget(this.outgoing, nextId, () =>
            this._emitOutgoing(),
          );
          this._toast(`Send failed: ${err.message}`, "error");
        }
      } finally {
        this.outgoingBusy = false;
        this._pumpOutgoing();
      }
    }

    async _runOutgoing(transferId) {
      const job = this.outgoing.get(transferId);

      if (!job || job.status === "canceled") {
        if (job)
          this._scheduleForget(this.outgoing, transferId, () =>
            this._emitOutgoing(),
          );
        return;
      }

      const connectionWaitController = new AbortController();
      job.connectionWaitController = connectionWaitController;
      
      if (job.status === "canceled") return;

      job.status = "requesting";
      this._emitOutgoing();

      try {
        await this._sendJsonWhenOpen(
          {
            type: "transfer-request",
            transferId,
            targetId: job.targetId,
            transferKind: job.transferKind,
            files: job.files.map((f) => ({
              name: f.name,
              size: f.size,
              relativePath: f.relativePath,
            })),
          },
          10000,
          connectionWaitController.signal,
        );
      } finally {
        if (job.connectionWaitController === connectionWaitController) {
          job.connectionWaitController = null;
        }
      }

      const response = await new Promise((resolve) => {
        this._pendingResponses.set(transferId, resolve);
      });

      const accepted =
        response === true || (response && response.accepted === true);
      const remoteWantsWebrtc = !!(response && response.webrtcEnabled);

      if (!accepted) {
        if (job.status !== "canceled" && job.status !== "error") {
          job.status = "rejected";
        }
        log.info(`Transfer ${transferId} not accepted (status=${job.status})`);

        this._emitOutgoing();
        this._scheduleForget(this.outgoing, transferId, () =>
          this._emitOutgoing(),
        );

        return;
      }

      job.status = "sending";
      this._emitOutgoing();
      log.info(`Transfer ${transferId} accepted, starting upload`);

      const canUseWebrtc = this.webrtcEnabled && !job.forceRelay && remoteWantsWebrtc;

      if (job.forceRelay) {
        log.info(
          `Transfer ${transferId} is going to a remote peer, skipping WebRTC and using the relay`,
        );
      } else if (this.transportMode === "relay") {
        log.info(`Transfer ${transferId}: relay-only mode enabled`);
      } else if (!remoteWantsWebrtc) {
        if (this.transportMode === "p2p") {
          throw new Error(
            `Transfer ${transferId}: receiver does not allow direct P2P, aborting as required by the P2P mode.`,
          );
        }
        log.info(
          `Transfer ${transferId}: receiver is not using WebRTC, using the relay`,
        );
      } else if (this.transportMode === "p2p") {
        log.info(`Transfer ${transferId}: P2P mode enabled`);
      }

      if (canUseWebrtc && this.transportMode !== "relay") {
        const webrtcTransport = new WebRtcTransport(this.rc, transferId);
        this._wireDataListeners(webrtcTransport);

        const ok = await webrtcTransport.connect(true, 8000);

        if (job.status === "canceled") {
          webrtcTransport.close();
        } else if (ok) {
          job.transport = webrtcTransport;
          job.webrtcTransport = webrtcTransport;
          log.info(`Using WebRTC data channel for transfer ${transferId}`);
        } else {
          webrtcTransport.close();

          if (this.transportMode === "p2p") {
            throw new Error(
              `P2P connection failed for transfer ${transferId}; aborting as required by the current mode.`,
            );
          }

          log.info(
            `WebRTC unavailable for transfer ${transferId}, using relay`,
          );
        }
      }

      for (const f of job.files) {
        if (job.status === "canceled") break;

        if (!Number.isFinite(f.size) || f.size < 0) {
          log.error(
            `Invalid size for "${f.name}" (index ${f.index}) in transfer ${transferId}: ` +
              `${f.size} (typeof ${typeof f.size})`,
          );
          throw new Error(
            `"${f.name}" has an invalid size (${f.size}) and can't be sent.`,
          );
        }

        job.currentFileIndex = f.index;
        job.phase = "transferring";
        this._emitOutgoing();

        this._sendJsonFor(job, {
          type: "file-start",
          transferId,
          fileIndex: f.index,
          name: f.name,
          size: f.size,
          relativePath: f.relativePath,
        });

        let offset = 0;

        while (offset < f.size) {
          if (job.status === "canceled") break;

          if (!Number.isFinite(f.size) || f.size < 0) {
            log.error(
              `f.size for "${f.name}" became invalid mid-transfer at offset ${offset}: ` +
                `${f.size} (typeof ${typeof f.size})`,
            );
            throw new Error(
              `"${f.name}"'s size became invalid (${f.size}) partway through sending.`,
            );
          }

          const end = Math.min(offset + CHUNK_SIZE, f.size);
          let buf;
          try {
            buf = await withRetry(
              async () => {
                const b = await f.file.slice(offset, end).arrayBuffer();
                const expectedLen = end - offset;

                if (b.byteLength !== expectedLen) {
                  throw new Error(
                    `Short read at offset ${offset}: expected ${expectedLen} bytes, got ${b.byteLength}`,
                  );
                }

                return b;
              },
              {
                retries: 3,
                baseDelayMs: 200,
                label: `Reading "${f.name}" at offset ${offset}`,
              },
            );
          } catch (err) {
            log.error(
              `Failed reading local file ${f.name} at offset ${offset} after retries`,
              err,
            );
            throw new Error(
              `Could not read "${f.name}" from disk: ${err.message}`,
            );
          }

          this._sendChunkFor(job, transferId, f.index, offset, new Uint8Array(buf));
          offset = end;
          job.sentBytes += buf.byteLength;

          updateTransferProgress(job);

          this._emitOutgoing();

          await job.transport.waitForDrain(BACKPRESSURE_THRESHOLD);
        }

        if (job.status === "canceled") break;
        this._sendJsonFor(job, { type: "file-end", transferId, fileIndex: f.index });

        job.phase = "finalizing";
        this._emitOutgoing();

        log.info(
          `Finished sending file ${f.name} (${f.size} bytes) for transfer ${transferId}, waiting for receiver to save it`,
        );

        try {
          await this._waitForFileAck(transferId, f.index);
        } catch (err) {
          if (job.status === "canceled") break;
          throw new Error(`Receiver failed to save "${f.name}": ${err.message}`);
        }

        if (job.status === "canceled") break;

        job.completedFileIndices.add(f.index);
        job.phase = "transferring";
        resetProgressClock(job, job.sentBytes);
        this._emitOutgoing();

        log.info(
          `Receiver confirmed "${f.name}" is saved for transfer ${transferId}`,
        );
      }

      if (job.status === "canceled") {
        log.info(`Transfer ${transferId} canceled mid-flight`);
        this._scheduleForget(this.outgoing, transferId, () =>
          this._emitOutgoing(),
        );
        return;
      }

      this.rc.sendJson({ type: "transfer-complete", transferId });

      job.status = "done";
      job.currentFileIndex = -1;

      if (job.webrtcTransport) {
        job.webrtcTransport.close();
        job.webrtcTransport = null;
      }
      job.transport = this.rc;

      this._emitOutgoing();
      this._toast(
        `Sent ${job.files.length} file(s) to ${job.targetName}.`,
        "success",
      );

      log.info(`Transfer ${transferId} complete`);
      this._scheduleForget(this.outgoing, transferId, () =>
        this._emitOutgoing(),
      );
    }

    _resolvePending(transferId, accepted) {
      const resolve = this._pendingResponses.get(transferId);
      if (resolve) {
        this._pendingResponses.delete(transferId);
        resolve(accepted);
      }
    }

    _onTransferResponse(msg) {
      log.info(
        `Response for ${msg.transferId}: accepted=${msg.accepted} webrtcEnabled=${!!msg.webrtcEnabled}`,
      );
      this._resolvePending(msg.transferId, {
        accepted: !!msg.accepted,
        webrtcEnabled: !!msg.webrtcEnabled,
      });
    }

    _onTransferCancel(msg) {
      const outJob = this.outgoing.get(msg.transferId);

      if (outJob && outJob.status !== "done") {
        outJob.status = "canceled";
        outJob.error = msg.reason || null;

        this._emitOutgoing();
        this._resolvePending(msg.transferId, false);
        this._rejectPendingFileAcks(msg.transferId);
        this._toast(
          `Transfer to ${outJob.targetName} was canceled: ${msg.reason || "unknown reason"}`,
          "error",
        );

        if (outJob.webrtcTransport) {
          outJob.webrtcTransport.close();
          outJob.webrtcTransport = null;
        }
        outJob.transport = this.rc;
      }

      const inJob = this.incoming.get(msg.transferId);

      if (inJob && inJob.status !== "done") {
        log.warn(`Incoming transfer ${msg.transferId} canceled: ${msg.reason}`);
        this._abortIncoming(
          inJob,
          msg.reason || "The sender canceled the transfer.",
          false,
        );
      }
    }

    _onIncomingRequest(msg) {
      const job = {
        transferId: msg.transferId,
        direction: "incoming",
        fromId: msg.fromId,
        fromName: msg.fromName,
        transferKind: ["clipboard", "secret"].includes(msg.transferKind)
          ? msg.transferKind
          : "file",
        receivedAt: null,
        files: msg.files,
        totalBytes: totalSize(msg.files),
        receivedBytes: 0,
        status: "pending-queue",
        currentFileIndex: -1,
        completedFileIndices: new Set(),
        writers: new Map(),
        orphanChunks: new Map(),
        transport: this.rc,
        webrtcTransport: null,
        phase: "transferring",
        decided: false,
        startedAt: null,
        speedBytesPerSecond: 0,
      };

      this.incoming.set(msg.transferId, job);
      this.incomingQueue.push(msg.transferId);

      log.info(
        `Incoming transfer request ${msg.transferId} from ${msg.fromName} (${msg.files.length} file(s))`,
      );

      this._emitIncoming();
      this._pumpIncoming();
    }

    _removeFromIncomingQueue(transferId) {
      this.incomingQueue = this.incomingQueue.filter((id) => id !== transferId);
    }

    _pumpIncoming() {
      if (this.incomingBusy) return;

      let promoted = false;
      const remaining = [];

      for (const id of this.incomingQueue) {
        const job = this.incoming.get(id);

        if (
          !job ||
          ["canceled", "rejected", "done", "error"].includes(job.status)
        ) {
          continue;
        }

        if (job.status === "pending-queue") {
          job.status = "pending-decision";
          promoted = true;
        }
        remaining.push(id);
      }

      this.incomingQueue = remaining;
      if (promoted) {
        this._emitIncoming();
      }
    }

    async respondToRequest(transferId, accepted) {
      const job = this.incoming.get(transferId);
      if (!job) return;

      if (accepted && window.OpfsStore?.hasQuotaFor) {
        const quota = await window.OpfsStore.hasQuotaFor(job.totalBytes);

        if (!quota.ok) {
          log.warn(
            `Rejecting transfer ${transferId}: insufficient OPFS quota (need ~${job.totalBytes}, available ~${quota.available})`,
          );
          accepted = false;
          job.status = "pending-decision";
          this._toast(
            `Not enough free storage to receive this transfer (${job.fromName}).`,
            "error",
          );
        }
      }

      job.decided = true;
      log.info(
        `User ${accepted ? "accepted" : "rejected"} transfer ${transferId} from ${job.fromName}`,
      );

      let webrtcConnectPromise = null;
      let pendingWebrtcTransport = null;

      if (accepted && this.transportMode !== "relay") {
        pendingWebrtcTransport = new WebRtcTransport(this.rc, transferId);
        this._wireDataListeners(pendingWebrtcTransport);
        webrtcConnectPromise = pendingWebrtcTransport.connect(false, 8000);
      }

      try {
        this.rc.sendJson({
          type: "transfer-response",
          transferId,
          accepted,
          webrtcEnabled: this.transportMode !== "relay",
        });
      } catch (err) {
        log.error("Failed to send transfer response", err);
        this._abortIncoming(job, "Connection lost.");
        return;
      }

      if (!accepted) {
        job.status = "rejected";
        this._emitIncoming();
        this._scheduleForget(this.incoming, transferId, () =>
          this._emitIncoming(),
        );
        this._removeFromIncomingQueue(transferId);
        this._pumpIncoming();
        return;
      }

      job.status = "receiving";
      job.startedAt = Date.now();
      updateTransferProgress(job);
      this.incomingBusy = true;
      this._emitIncoming();

      if (webrtcConnectPromise) {
        webrtcConnectPromise.then((ok) => {
          if (job.status === "canceled") {
            pendingWebrtcTransport.close();
            return;
          }

          if (ok) {
            job.webrtcTransport = pendingWebrtcTransport;
            log.info(`Using WebRTC data channel for transfer ${transferId}`);
          } else {
            pendingWebrtcTransport.close();
          }
        });
      }
    }

    respondToRequests(transferIds, accepted) {
      if (!Array.isArray(transferIds) || transferIds.length === 0) return;

      for (const transferId of transferIds) {
        const job = this.incoming.get(transferId);

        if (!job || job.decided) continue;

        this.respondToRequest(transferId, accepted);
      }
    }

    async _onFileStart(msg, transport) {
      const job = this.incoming.get(msg.transferId);

      if (!job || job.status !== "receiving") return;

      if (transport) job.transport = transport;

      job.currentFileIndex = msg.fileIndex;

      if (job.receivedAt === null) job.receivedAt = Date.now();
      
      job.phase = "transferring";
      resetProgressClock(job, job.receivedBytes);

      this._emitIncoming();

      const writer = {
        writable: null,
        chain: Promise.resolve(),
        written: 0,
        ready: Promise.resolve(),
        pendingChunks: new Map(),
      };

      job.writers.set(msg.fileIndex, writer);

      const orphans = job.orphanChunks.get(msg.fileIndex);

      if (orphans && orphans.size > 0) {
        log.warn(
          `Recovering ${orphans.size} chunk(s) that arrived before file-start for ` +
            `"${msg.relativePath}" (transfer ${msg.transferId}, file ${msg.fileIndex})`,
        );

        job.orphanChunks.delete(msg.fileIndex);

        const sortedOffsets = [...orphans.keys()].sort((a, b) => a - b);

        for (const offset of sortedOffsets) {
          this._enqueueChunk(
            job,
            writer,
            msg.transferId,
            msg.fileIndex,
            offset,
            orphans.get(offset),
          );
        }
      }

      writer.ready = (async () => {
        try {
          writer.writable = await withRetry(
            () =>
              window.OpfsStore.openWritable(
                msg.transferId,
                msg.relativePath,
                msg.size,
              ),
            {
              retries: 3,
              baseDelayMs: 200,
              label: `Opening OPFS writable for ${msg.relativePath}`,
              retryable: (err) => !window.OpfsStore.isQuotaError(err),
            },
          );
          log.info(
            `Ready to receive file "${msg.relativePath}" for transfer ${msg.transferId}`,
          );
        } catch (err) {
          log.error(
            `Failed opening OPFS writable for ${msg.relativePath}`,
            err,
          );
          this._abortIncoming(
            job,
            `Could not save "${msg.relativePath}": ${err.message}`,
          );
          throw err;
        }
      })();
    }

    static MAX_ORPHAN_CHUNKS_PER_FILE = 1024;

    _onChunk(detail, transport) {
      const job = this.incoming.get(detail.transferId);

      if (!job || job.status !== "receiving") return;

      if (transport) job.transport = transport;

      const chunk =
        detail.payload instanceof Uint8Array
          ? new Uint8Array(detail.payload)
          : new Uint8Array(
              detail.payload.buffer,
              detail.payload.byteOffset,
              detail.payload.byteLength,
            );

      const writer = job.writers.get(detail.fileIndex);

      if (!writer) {
        let orphans = job.orphanChunks.get(detail.fileIndex);

        if (!orphans) {
          orphans = new Map();
          job.orphanChunks.set(detail.fileIndex, orphans);
        }

        if (orphans.size >= TransferManager.MAX_ORPHAN_CHUNKS_PER_FILE) {
          log.error(
            `Dropping chunk for transfer ${detail.transferId} file ${detail.fileIndex} ` +
              `at offset ${detail.offset}: too many chunks (${orphans.size}) buffered ` +
              `ahead of file-start`,
          );
          return;
        }

        log.warn(
          `Chunk for transfer ${detail.transferId} file ${detail.fileIndex} at offset ` +
            `${detail.offset} arrived before file-start; buffering (${orphans.size + 1} pending)`,
        );

        orphans.set(detail.offset, chunk);
        return;
      }

      this._enqueueChunk(
        job,
        writer,
        detail.transferId,
        detail.fileIndex,
        detail.offset,
        chunk,
      );
    }
    
    _enqueueChunk(job, writer, transferId, fileIndex, offset, chunk) {
      writer.chain = writer.chain.then(async () => {
        try {
          await writer.ready;
          if (!writer.writable) {
            throw new Error("Writable not ready");
          }

          if (offset < writer.written) {
            log.debug(
              `Ignoring duplicate or stale chunk for transfer ${transferId} file ${fileIndex} at offset ${offset}`,
            );
            return;
          }

          writer.pendingChunks.set(offset, chunk);

          while (writer.pendingChunks.has(writer.written)) {
            const payload = writer.pendingChunks.get(writer.written);

            writer.pendingChunks.delete(writer.written);

            if (!payload) {
              break;
            }

            await withRetry(() => writer.writable.write(payload), {
              retries: 3,
              baseDelayMs: 200,
              label: `Writing to disk for transfer ${transferId} file ${fileIndex}`,
              retryable: (err) => !window.OpfsStore.isQuotaError(err),
            });
            writer.written += payload.byteLength;

            job.receivedBytes += payload.byteLength;

            updateTransferProgress(job);

            this._emitIncoming();
          }
        } catch (err) {
          log.error(
            `Write failed for transfer ${transferId} file ${fileIndex}`,
            err,
          );
          this._abortIncoming(job, `Failed writing to disk: ${err.message}`);
        }
      });
    }

    async _onFileEnd(msg, transport) {
      const job = this.incoming.get(msg.transferId);

      if (!job || job.status !== "receiving") return;

      if (transport) job.transport = transport;

      const writer = job.writers.get(msg.fileIndex);

      if (!writer) return;

      job.phase = "finalizing";
      this._emitIncoming();

      writer.chain = writer.chain.then(async () => {
        try {
          await writer.ready;

          if (!writer.writable) {
            throw new Error("Writable not ready");
          }

          while (writer.pendingChunks.has(writer.written)) {
            const payload = writer.pendingChunks.get(writer.written);
            writer.pendingChunks.delete(writer.written);
            if (!payload) {
              break;
            }
            await withRetry(() => writer.writable.write(payload), {
              retries: 3,
              baseDelayMs: 200,
              label: `Writing to disk for transfer ${msg.transferId} file ${msg.fileIndex}`,
              retryable: (err) => !window.OpfsStore.isQuotaError(err),
            });
            writer.written += payload.byteLength;
            job.receivedBytes += payload.byteLength;
            updateTransferProgress(job);
            this._emitIncoming();
          }
        } catch (err) {
          log.error(
            `Write failed for transfer ${msg.transferId} file ${msg.fileIndex}`,
            err,
          );
          this._abortIncoming(job, `Failed writing to disk: ${err.message}`);
          throw err;
        }
      });

      try {
        await writer.chain;
      } catch {
        return;
      }

      const expectedSize = (
        job.files.find((file) => file.index === msg.fileIndex) ||
        job.files[msg.fileIndex]
      )?.size;

      if (
        job.status === "receiving" &&
        expectedSize != null &&
        writer.written < expectedSize
      ) {
        const missingOffsets = [];
        let cursor = writer.written;

        while (cursor < expectedSize) {
          if (!writer.pendingChunks.has(cursor)) missingOffsets.push(cursor);
          cursor += CHUNK_SIZE;
        }

        if (missingOffsets.length > 0) {
          log.warn(
            `File ${msg.fileIndex} for transfer ${msg.transferId} is missing ` +
              `${missingOffsets.length} chunk(s) at file-end; requesting resend: ` +
              `[${missingOffsets.slice(0, 5).join(", ")}${missingOffsets.length > 5 ? ", ..." : ""}]`,
          );

          for (const offset of missingOffsets) {
            try {
              this._sendJsonFor(job, {
                type: "resend-chunk",
                transferId: msg.transferId,
                fileIndex: msg.fileIndex,
                offset,
              });
            } catch (err) {
              log.error("Failed to request chunk resend", err);
            }
          }
        }

        const GRACE_MS = 8000;
        const POLL_MS = 100;
        let waited = 0;

        while (
          job.status === "receiving" &&
          writer.written < expectedSize &&
          waited < GRACE_MS
        ) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          waited += POLL_MS;
        }

        if (waited > 0 && writer.written >= expectedSize) {
          log.warn(
            `File ${msg.fileIndex} for transfer ${msg.transferId} recovered ` +
              `${missingOffsets.length} missing chunk(s) via resend after ${waited}ms`,
          );
        }
      }

      if (job.status !== "receiving") return;

      writer.chain = writer.chain.then(async () => {
        try {
          if (writer.pendingChunks.size > 0) {
            const gotOffsets = [...writer.pendingChunks.keys()].sort(
              (a, b) => a - b,
            );
            throw new Error(
              `Missing chunk(s) before file close; next expected offset ${writer.written}, ` +
                `but have ${writer.pendingChunks.size} buffered chunk(s) starting at ` +
                `[${gotOffsets.slice(0, 5).join(", ")}${gotOffsets.length > 5 ? ", ..." : ""}] ` +
                `(written so far: ${writer.written} bytes)`,
            );
          }

          await writer.writable.close();
          job.completedFileIndices.add(msg.fileIndex);
          const completedFile =
            job.files.find((file) => file.index === msg.fileIndex) ||
            job.files[msg.fileIndex];

          if (completedFile?.relativePath) {
            try {
              await window.OpfsStore.markFileCompleted(
                msg.transferId,
                completedFile.relativePath,
                {
                  transferKind: job.transferKind,
                  senderName: job.fromName,
                  receivedAt: job.receivedAt,
                },
              );
            } catch (err) {
              log.warn(
                `Failed marking file ${completedFile.relativePath} as complete`,
                err,
              );
            }
          }

          this._emitIncoming();
          this.dispatchEvent(new CustomEvent("received-updated"));

          this._sendJsonFor(job, {
            type: "file-ack",
            transferId: msg.transferId,
            fileIndex: msg.fileIndex,
          });

          log.info(
            `Closed file ${msg.fileIndex} for transfer ${msg.transferId}`,
          );
        } catch (err) {
          log.error(
            `Failed closing file ${msg.fileIndex} for transfer ${msg.transferId}`,
            err,
          );
          this._abortIncoming(job, `Failed finalizing a file: ${err.message}`);
        }
      });
      await writer.chain;
    }

    async _onTransferCompleteMsg(msg) {
      const job = this.incoming.get(msg.transferId);
      if (!job) return;

      for (const writer of job.writers.values()) {
        await writer.chain;
      }

      job.status = "done";
      job.currentFileIndex = -1;

      if (job.webrtcTransport) {
        job.webrtcTransport.close();
        job.webrtcTransport = null;
      }
      job.transport = this.rc;

      this._emitIncoming();
      this._toast(
        `Received ${job.files.length} file(s) from ${job.fromName}.`,
        "success",
      );

      log.info(`Transfer ${msg.transferId} fully received`);

      this.incomingBusy = false;

      this._removeFromIncomingQueue(msg.transferId);
      this.dispatchEvent(new CustomEvent("received-updated"));
      this._scheduleForget(this.incoming, msg.transferId, () =>
        this._emitIncoming(),
      );
      this._pumpIncoming();
    }

    _abortIncoming(job, reason, notifyPeer = true) {
      const wasActive = job.status === "receiving";

      job.status = "canceled";
      job.error = reason;

      this._emitIncoming();
      this._toast(
        `Transfer from ${job.fromName} was canceled: ${reason}`,
        "error",
      );

      if (notifyPeer) {
        try {
          this.rc.sendJson({
            type: "transfer-cancel",
            transferId: job.transferId,
            reason,
          });
        } catch (err) {
          log.error("Failed to notify sender of abort", err);
        }
      }

      for (const writer of job.writers.values()) {
        if (writer.writable) {
          writer.writable
            .abort()
            .catch((e) => log.error("Failed aborting writable", e));
        }
      }

      job.orphanChunks.clear();

      if (job.webrtcTransport) {
        job.webrtcTransport.close();
        job.webrtcTransport = null;
      }
      job.transport = this.rc;

      if (wasActive) {
        window.OpfsStore?.deleteTransfer?.(job.transferId).catch((e) =>
          log.warn(
            `Failed cleaning up OPFS data for aborted transfer ${job.transferId}`,
            e,
          ),
        );
      }

      if (wasActive) this.incomingBusy = false;

      this._removeFromIncomingQueue(job.transferId);
      this._scheduleForget(this.incoming, job.transferId, () =>
        this._emitIncoming(),
      );
      this._pumpIncoming();
    }

    cancelIncoming(transferId, isRejectingBeforeDecision) {
      const job = this.incoming.get(transferId);

      if (!job) return;

      if (isRejectingBeforeDecision) {
        this.respondToRequest(transferId, false);
        return;
      }

      this.rc.sendJson({
        type: "transfer-cancel",
        transferId,
        reason: "Canceled by recipient.",
      });
      this._abortIncoming(job, "Canceled by recipient.");
    }
  }

  window.TransferManager = TransferManager;
})();