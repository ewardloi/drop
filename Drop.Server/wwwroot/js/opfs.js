(function () {
  "use strict";

  const log = window.Log.opfs;

  let opfsWorker = null;

  class OpfsWorkerClient {
    constructor() {
      this.worker = new Worker("js/opfs-worker.js");
      this.nextId = 1;
      this.pending = new Map();

      this.worker.onmessage = (event) => {
        const { id, ok, result, error } = event.data;
        const pending = this.pending.get(id);

        if (!pending) return;

        this.pending.delete(id);

        if (ok) pending.resolve(result);
        else pending.reject(new Error(error));
      };

      this.worker.onerror = (event) => {
        log.error("OPFS worker crashed", event.message || event);

        for (const [id, pending] of this.pending) {
          pending.reject(new Error("OPFS worker crashed"));
          this.pending.delete(id);
        }
      };
    }

    call(type, payload, transfer) {
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, type, ...payload }, transfer || []);
      });
    }
  }

  function getWorker() {
    if (!opfsWorker) {
      opfsWorker = new OpfsWorkerClient();
    }

    return opfsWorker;
  }

  function checkSupport() {
    if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) {
      throw new Error(
        "This browser does not support the Origin Private File System (OPFS). Drop cannot store received files.",
      );
    }
  }

  async function getReceivedRoot() {
    checkSupport();
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("received", { create: true });
  }

  async function getTransferDir(transferId, create) {
    const receivedRoot = await getReceivedRoot();
    return receivedRoot.getDirectoryHandle(String(transferId), {
      create: !!create,
    });
  }

  function markerNameFor(fileName) {
    return `.drop-complete-${encodeURIComponent(fileName)}`;
  }

  async function resolveParentDir(transferId, relativePath) {
    const parts = relativePath.split("/").filter(Boolean);
    const fileName = parts.pop();

    let dir = await getTransferDir(transferId, true);

    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }

    return { dirHandle: dir, fileName };
  }

  async function openWritableViaWorker(client, transferId, relativePath, size) {
    const { handleId } = await client.call("open-write", {
      transferId,
      relativePath,
      size,
    });

    let position = 0;
    let closed = false;

    return {
      async write(payload) {
        if (closed) throw new Error("Writable already closed");

        const view =
          payload instanceof Uint8Array ? payload : new Uint8Array(payload);

        const owned = view.slice();
        const expectedLen = owned.byteLength;

        const result = await client.call(
          "write-chunk",
          { handleId, offset: position, buffer: owned.buffer },
          [owned.buffer],
        );

        if (result?.written !== expectedLen) {
          throw new Error(
            `OPFS write incomplete at offset ${position}: expected ${expectedLen} bytes, worker reported ${result?.written}`,
          );
        }

        position += expectedLen;
      },
      async close() {
        closed = true;
        await client.call("close-write", { handleId });
      },
      async abort() {
        closed = true;
        await client.call("abort-write", { handleId }).catch(() => {});
      },
    };
  }

  async function getFileViaWorker(client, entry) {
    const { buffer, name } = await client.call("read-file", {
      transferId: entry.transferId,
      relativePath: entry.relativePath,
    });

    const PART_SIZE = 512 * 1024 * 1024;
    const parts = [];

    for (let offset = 0; offset < buffer.byteLength; offset += PART_SIZE) {
      parts.push(
        new Uint8Array(
          buffer,
          offset,
          Math.min(PART_SIZE, buffer.byteLength - offset),
        ),
      );
    }

    return new File(parts, name || entry.name, {
      lastModified: entry.lastModified,
    });
  }

  function isQuotaError(err) {
    return !!err && (err.name === "QuotaExceededError" || err.code === 22);
  }

  async function openWritable(transferId, relativePath, size) {
    log.info(`Opening writable for transfer ${transferId} -> ${relativePath}`);

    const client = getWorker();

    return openWritableViaWorker(client, transferId, relativePath, size);
  }

  async function getFile(entry) {
    const client = getWorker();

    return getFileViaWorker(client, entry);
  }

  async function markFileCompleted(transferId, relativePath, metadata = {}) {
    const { dirHandle, fileName } = await resolveParentDir(
      transferId,
      relativePath,
    );

    const marker = await dirHandle.getFileHandle(markerNameFor(fileName), {
      create: true,
    });

    const writable = await marker.createWritable();

    await writable.write(new TextEncoder().encode(JSON.stringify(metadata)));
    await writable.close();

    log.info(`Marked file complete ${relativePath} in transfer ${transferId}`);
  }

  async function listAllReceived() {
    const out = [];

    let receivedRoot;

    try {
      receivedRoot = await getReceivedRoot();
    } catch (err) {
      log.error("Cannot access OPFS root", err);
      throw err;
    }

    async function walkTransfer(
      transferDirHandle,
      transferId,
      prefix,
      dirHandle,
    ) {
      for await (const [name, handle] of dirHandle.entries()) {
        if (name.startsWith(".drop-complete-")) continue;

        if (handle.kind === "directory") {
          await walkTransfer(
            transferDirHandle,
            transferId,
            prefix ? `${prefix}/${name}` : name,
            handle,
          );
          continue;
        }

        try {
          const markerName = markerNameFor(name);
          let hasCompletedMarker = false;
          let markerHandle = null;

          try {
            markerHandle = await dirHandle.getFileHandle(markerName, { create: false });
            hasCompletedMarker = true;
          } catch (err) {
            if (err.name !== "NotFoundError") {
              throw err;
            }
          }

          if (!hasCompletedMarker) continue;

          let metadata = {};

          try {
            metadata = JSON.parse(await (await markerHandle.getFile()).text());
          } catch {
            metadata = {};
          }

          const file = await handle.getFile();
          out.push({
            transferId,
            relativePath: prefix ? `${prefix}/${name}` : name,
            name,
            size: file.size,
            lastModified: file.lastModified,
            transferKind: metadata.transferKind || "file",
            senderName: metadata.senderName || "",
            receivedAt: metadata.receivedAt || null,
            handle,
            parentDirHandle: dirHandle,
          });
        } catch (err) {
          log.error(`Failed reading file metadata for ${name}`, err);
        }
      }
    }

    try {
      for await (const [
        transferId,
        transferDirHandle,
      ] of receivedRoot.entries()) {
        if (transferDirHandle.kind !== "directory") continue;

        await walkTransfer(
          transferDirHandle,
          transferId,
          "",
          transferDirHandle,
        );
      }
    } catch (err) {
      log.error(
        "Failed enumerating received files (async directory iteration unsupported?)",
        err,
      );
      throw err;
    }

    return out;
  }

  async function deleteEntry(entry) {
    log.info(
      `Deleting ${entry.relativePath} from transfer ${entry.transferId}`,
    );

    try {
      await entry.parentDirHandle.removeEntry(markerNameFor(entry.name));
    } catch (err) {
      if (err.name !== "NotFoundError") {
        throw err;
      }
    }
    await entry.parentDirHandle.removeEntry(entry.name);
  }

  async function deleteTransfer(transferId) {
    const receivedRoot = await getReceivedRoot();

    try {
      await receivedRoot.removeEntry(String(transferId), { recursive: true });
      log.info(`Deleted whole transfer directory ${transferId}`);
    } catch (err) {
      log.error(`Failed deleting transfer directory ${transferId}`, err);
      throw err;
    }
  }

  async function clearAllReceived(protectedTransferIds) {
    const protectedSet =
      protectedTransferIds instanceof Set
        ? protectedTransferIds
        : new Set(protectedTransferIds || []);

    try {
      const receivedRoot = await getReceivedRoot();
      const entries = [];

      for await (const [name, handle] of receivedRoot.entries()) {
        entries.push([name, handle]);
      }

      for (const [name] of entries) {
        if (protectedSet.has(name)) {
          log.info(
            `Skipping transfer ${name} during clear-all (still in progress)`,
          );
          continue;
        }
        await receivedRoot.removeEntry(name, { recursive: true });
      }

      log.info("Cleared settled received transfers from OPFS");
    } catch (err) {
      log.error("Failed clearing OPFS received files", err);
      throw err;
    }
  }

  async function ensurePersisted() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        const granted = await navigator.storage.persist();
        log.info(`Persistent storage ${granted ? "granted" : "denied"}`);
      }
    } catch (err) {
      log.warn("navigator.storage.persist() failed", err);
    }
  }

  async function hasQuotaFor(bytesNeeded, safetyMarginRatio = 0.05) {
    if (!navigator.storage || !navigator.storage.estimate) {
      return { ok: true, unknown: true };
    }

    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const available = quota - usage;
      const needed = bytesNeeded * (1 + safetyMarginRatio);

      return { ok: available >= needed, available, quota, usage, unknown: false };
    } catch (err) {
      log.warn("navigator.storage.estimate() failed", err);
      return { ok: true, unknown: true };
    }
  }

  window.OpfsStore = {
    checkSupport,
    openWritable,
    markFileCompleted,
    listAllReceived,
    deleteEntry,
    deleteTransfer,
    clearAllReceived,
    getFile,
    ensurePersisted,
    hasQuotaFor,
    isQuotaError,
  };
})();