(function () {
  "use strict";

  const log = window.Log.transfer;
  const CHUNK_SIZE = 256 * 1024; // 256 KB
  const BACKPRESSURE_THRESHOLD = 4 * 1024 * 1024; // 4 MB buffered before pausing sends

  function newId() {
    return crypto.randomUUID();
  }

  async function withRetry(fn, { retries = 3, baseDelayMs = 200, label } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
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
    if (!job.startedAt) {
      job.startedAt = Date.now();
    }
    const elapsedSeconds = Math.max((Date.now() - job.startedAt) / 1000, 0.25);
    const doneBytes =
      job.direction === "outgoing" ? job.sentBytes : job.receivedBytes;
    job.speedBytesPerSecond =
      doneBytes > 0 ? Math.round(doneBytes / elapsedSeconds) : 0;
  }

  class TransferManager extends EventTarget {
    constructor(relayClient) {
      super();
      this.rc = relayClient;
      this.outgoing = new Map();
      this.incoming = new Map();
      this.outgoingQueue = [];
      this.incomingQueue = [];
      this.outgoingBusy = false;
      this.incomingBusy = false;
      this._pendingResponses = new Map();

      this.rc.addEventListener("message:transfer-request", (e) =>
        this._onIncomingRequest(e.detail),
      );
      this.rc.addEventListener("message:transfer-response", (e) =>
        this._onTransferResponse(e.detail),
      );
      this.rc.addEventListener("message:transfer-cancel", (e) =>
        this._onTransferCancel(e.detail),
      );
      this.rc.addEventListener("message:file-start", (e) =>
        this._onFileStart(e.detail),
      );
      this.rc.addEventListener("message:file-end", (e) =>
        this._onFileEnd(e.detail),
      );
      this.rc.addEventListener("message:transfer-complete", (e) =>
        this._onTransferCompleteMsg(e.detail),
      );
      this.rc.addEventListener("chunk", (e) => this._onChunk(e.detail));
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

    queueSend(targetId, targetName, fileEntries) {
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
        status: "queued", // queued -> requesting -> sending -> done | rejected | canceled | error
        currentFileIndex: -1,
        completedFileIndices: new Set(),
        error: null,
        startedAt: null,
        speedBytesPerSecond: 0,
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

      try {
        this.rc.sendJson({
          type: "transfer-cancel",
          transferId,
          reason: "Canceled by sender.",
        });
      } catch (err) {
        log.error("Failed to send cancel", err);
      }

      job.status = "canceled";

      this._emitOutgoing();
      this._resolvePending(transferId, false);
    }

    async _pumpOutgoing() {
      if (this.outgoingBusy) return;
      const nextId = this.outgoingQueue.shift();

      if (!nextId) return;
      this.outgoingBusy = true;

      try {
        await this._runOutgoing(nextId);
      } catch (err) {
        log.error(`Outgoing transfer ${nextId} failed`, err);

        const job = this.outgoing.get(nextId);

        if (job) {
          job.status = "error";
          job.error = err.message;

          this._emitOutgoing();
          this._scheduleForget(this.outgoing, nextId, () =>
            this._emitOutgoing(),
          );
        }
        this._toast(`Send failed: ${err.message}`, "error");
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

      job.status = "requesting";
      this._emitOutgoing();

      this.rc.sendJson({
        type: "transfer-request",
        transferId,
        targetId: job.targetId,
        files: job.files.map((f) => ({
          name: f.name,
          size: f.size,
          relativePath: f.relativePath,
        })),
      });

      const accepted = await new Promise((resolve) => {
        this._pendingResponses.set(transferId, resolve);
      });

      if (!accepted) {
        if (job.status !== "canceled") job.status = "rejected";
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

      for (const f of job.files) {
        if (job.status === "canceled") break;
        job.currentFileIndex = f.index;
        this._emitOutgoing();

        this.rc.sendJson({
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
          const end = Math.min(offset + CHUNK_SIZE, f.size);
          let buf;
          try {
            buf = await withRetry(
              () => f.file.slice(offset, end).arrayBuffer(),
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

          this.rc.sendChunk(transferId, f.index, offset, new Uint8Array(buf));
          offset = end;
          job.sentBytes += buf.byteLength;

          updateTransferProgress(job);

          this._emitOutgoing();

          await this.rc.waitForDrain(BACKPRESSURE_THRESHOLD);
        }

        if (job.status === "canceled") break;
        this.rc.sendJson({ type: "file-end", transferId, fileIndex: f.index });

        job.completedFileIndices.add(f.index);
        this._emitOutgoing();

        log.info(
          `Finished sending file ${f.name} (${f.size} bytes) for transfer ${transferId}`,
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
      log.info(`Response for ${msg.transferId}: accepted=${msg.accepted}`);
      this._resolvePending(msg.transferId, !!msg.accepted);
    }

    _onTransferCancel(msg) {
      const outJob = this.outgoing.get(msg.transferId);

      if (outJob && outJob.status !== "done") {
        outJob.status = "canceled";
        outJob.error = msg.reason || null;

        this._emitOutgoing();
        this._resolvePending(msg.transferId, false);
        this._toast(
          `Transfer to ${outJob.targetName} was canceled: ${msg.reason || "unknown reason"}`,
          "error",
        );
      }

      const inJob = this.incoming.get(msg.transferId);

      if (inJob && inJob.status !== "done") {
        log.warn(`Incoming transfer ${msg.transferId} canceled: ${msg.reason}`);
        this._abortIncoming(
          inJob,
          msg.reason || "The sender canceled the transfer.",
        );
      }
    }

    _onIncomingRequest(msg) {
      const job = {
        transferId: msg.transferId,
        direction: "incoming",
        fromId: msg.fromId,
        fromName: msg.fromName,
        files: msg.files,
        totalBytes: totalSize(msg.files),
        receivedBytes: 0,
        status: "pending-queue", // pending-queue -> pending-decision -> receiving -> done | rejected | canceled | error
        currentFileIndex: -1,
        completedFileIndices: new Set(),
        writers: new Map(),
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

    respondToRequest(transferId, accepted) {
      const job = this.incoming.get(transferId);
      if (!job) return;
      job.decided = true;
      log.info(
        `User ${accepted ? "accepted" : "rejected"} transfer ${transferId} from ${job.fromName}`,
      );
      this.rc.sendJson({ type: "transfer-response", transferId, accepted });

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
    }

    respondToRequests(transferIds, accepted) {
      if (!Array.isArray(transferIds) || transferIds.length === 0) return;

      for (const transferId of transferIds) {
        const job = this.incoming.get(transferId);

        if (!job || job.decided) continue;

        this.respondToRequest(transferId, accepted);
      }
    }

    async _onFileStart(msg) {
      const job = this.incoming.get(msg.transferId);

      if (!job || job.status !== "receiving") return;

      job.currentFileIndex = msg.fileIndex;

      this._emitIncoming();

      const writer = {
        writable: null,
        chain: Promise.resolve(),
        written: 0,
        ready: Promise.resolve(),
        pendingChunks: new Map(),
      };

      job.writers.set(msg.fileIndex, writer);

      writer.ready = (async () => {
        try {
          writer.writable = await withRetry(
            () =>
              window.OpfsStore.openWritable(msg.transferId, msg.relativePath),
            {
              retries: 3,
              baseDelayMs: 200,
              label: `Opening OPFS writable for ${msg.relativePath}`,
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

    _onChunk(detail) {
      const job = this.incoming.get(detail.transferId);

      if (!job || job.status !== "receiving") return;

      const writer = job.writers.get(detail.fileIndex);

      if (!writer) {
        log.warn(
          `Chunk for unknown file index ${detail.fileIndex} in transfer ${detail.transferId}`,
        );
        return;
      }

      const chunk =
        detail.payload instanceof Uint8Array
          ? new Uint8Array(detail.payload)
          : new Uint8Array(
              detail.payload.buffer,
              detail.payload.byteOffset,
              detail.payload.byteLength,
            );

      writer.chain = writer.chain.then(async () => {
        try {
          await writer.ready;
          if (!writer.writable) {
            throw new Error("Writable not ready");
          }

          if (detail.offset < writer.written) {
            log.debug(
              `Ignoring duplicate or stale chunk for transfer ${detail.transferId} file ${detail.fileIndex} at offset ${detail.offset}`,
            );
            return;
          }

          writer.pendingChunks.set(detail.offset, chunk);

          while (writer.pendingChunks.has(writer.written)) {
            const payload = writer.pendingChunks.get(writer.written);

            writer.pendingChunks.delete(writer.written);

            if (!payload) {
              break;
            }

            await withRetry(() => writer.writable.write(payload), {
              retries: 3,
              baseDelayMs: 200,
              label: `Writing to disk for transfer ${detail.transferId} file ${detail.fileIndex}`,
            });
            writer.written += payload.byteLength;

            job.receivedBytes += payload.byteLength;

            updateTransferProgress(job);

            this._emitIncoming();
          }
        } catch (err) {
          log.error(
            `Write failed for transfer ${detail.transferId} file ${detail.fileIndex}`,
            err,
          );
          this._abortIncoming(job, `Failed writing to disk: ${err.message}`);
        }
      });
    }

    async _onFileEnd(msg) {
      const job = this.incoming.get(msg.transferId);

      if (!job || job.status !== "receiving") return;

      const writer = job.writers.get(msg.fileIndex);

      if (!writer) return;

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
            });
            writer.written += payload.byteLength;
            job.receivedBytes += payload.byteLength;
            updateTransferProgress(job);
            this._emitIncoming();
          }

          if (writer.pendingChunks.size > 0) {
            throw new Error(
              `Missing chunk(s) before file close; next expected offset ${writer.written}`,
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

    _abortIncoming(job, reason) {
      const wasActive = job.status === "receiving";

      job.status = "canceled";
      job.error = reason;

      this._emitIncoming();
      this._toast(
        `Transfer from ${job.fromName} was canceled: ${reason}`,
        "error",
      );

      for (const writer of job.writers.values()) {
        if (writer.writable) {
          writer.writable
            .abort()
            .catch((e) => log.error("Failed aborting writable", e));
        }
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
