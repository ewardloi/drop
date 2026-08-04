(function () {
  "use strict";

  const log = window.Log.opfs;

  const SYNC_ACCESS_HANDLES_SUPPORTED =
    typeof FileSystemFileHandle !== "undefined" &&
    "createSyncAccessHandle" in FileSystemFileHandle.prototype;

  let opfsWorker = null;
  let workerInitFailed = false;

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
    if (!SYNC_ACCESS_HANDLES_SUPPORTED || workerInitFailed) return null;

    if (!opfsWorker) {
      try {
        opfsWorker = new OpfsWorkerClient();
      } catch (err) {
        log.error(
          "Failed starting OPFS worker, falling back to main-thread I/O",
          err,
        );
        workerInitFailed = true;
        return null;
      }
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

  async function openWritableLegacy(transferId, relativePath) {
    const { dirHandle, fileName } = await resolveParentDir(
      transferId,
      relativePath,
    );
    const fileHandle = await dirHandle.getFileHandle(fileName, {
      create: true,
    });

    return await fileHandle.createWritable();
  }

  async function getFileLegacy(entry) {
    return entry.handle.getFile();
  }

  async function openWritableViaWorker(client, transferId, relativePath) {
    const { handleId } = await client.call("open-write", {
      transferId,
      relativePath,
    });

    let position = 0;
    let closed = false;

    return {
      async write(payload) {
        if (closed) throw new Error("Writable already closed");

        const view =
          payload instanceof Uint8Array ? payload : new Uint8Array(payload);

        const owned = view.slice();

        await client.call(
          "write-chunk",
          { handleId, offset: position, buffer: owned.buffer },
          [owned.buffer],
        );

        position += owned.byteLength;
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

    return new File([buffer], name || entry.name, {
      lastModified: entry.lastModified,
    });
  }

  async function openWritable(transferId, relativePath) {
    log.info(`Opening writable for transfer ${transferId} -> ${relativePath}`);

    const client = getWorker();

    if (!client) {
      return openWritableLegacy(transferId, relativePath);
    }

    try {
      return await openWritableViaWorker(client, transferId, relativePath);
    } catch (err) {
      log.warn(
        `OPFS worker write failed, falling back to main-thread write for ${relativePath}`,
        err,
      );
      return openWritableLegacy(transferId, relativePath);
    }
  }

  async function getFile(entry) {
    const client = getWorker();

    if (!client) {
      return getFileLegacy(entry);
    }

    try {
      return await getFileViaWorker(client, entry);
    } catch (err) {
      log.warn(
        `OPFS worker read failed, falling back to main-thread read for ${entry.relativePath}`,
        err,
      );
      return getFileLegacy(entry);
    }
  }

  async function markFileCompleted(transferId, relativePath) {
    const { dirHandle, fileName } = await resolveParentDir(
      transferId,
      relativePath,
    );

    const marker = await dirHandle.getFileHandle(markerNameFor(fileName), {
      create: true,
    });

    const writable = await marker.createWritable();

    await writable.write(new TextEncoder().encode("complete"));
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

          try {
            await dirHandle.getFileHandle(markerName, { create: false });
            hasCompletedMarker = true;
          } catch (err) {
            if (err.name !== "NotFoundError") {
              throw err;
            }
          }

          if (!hasCompletedMarker) continue;

          const file = await handle.getFile();
          out.push({
            transferId,
            relativePath: prefix ? `${prefix}/${name}` : name,
            name,
            size: file.size,
            lastModified: file.lastModified,
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

  window.OpfsStore = {
    checkSupport,
    openWritable,
    markFileCompleted,
    listAllReceived,
    deleteEntry,
    deleteTransfer,
    clearAllReceived,
    getFile,
  };
})();
