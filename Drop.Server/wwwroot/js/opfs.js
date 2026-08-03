(function () {
  "use strict";

  const log = window.Log.opfs;

  function checkSupport() {
    if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) {
      throw new Error("This browser does not support the Origin Private File System (OPFS). Drop cannot store received files.");
    }
  }

  async function getReceivedRoot() {
    checkSupport();
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("received", { create: true });
  }

  async function getTransferDir(transferId, create) {
    const receivedRoot = await getReceivedRoot();
    return receivedRoot.getDirectoryHandle(String(transferId), { create: !!create });
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

  async function openWritable(transferId, relativePath) {
    log.info(`Opening writable for transfer ${transferId} -> ${relativePath}`);

    const { dirHandle, fileName } = await resolveParentDir(transferId, relativePath);
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });

    return await fileHandle.createWritable();
  }

  async function markFileCompleted(transferId, relativePath) {
    const { dirHandle, fileName } = await resolveParentDir(transferId, relativePath);
    
    const marker = await dirHandle.getFileHandle(markerNameFor(fileName), { create: true });
    
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

    async function walkTransfer(transferDirHandle, transferId, prefix, dirHandle) {
      for await (const [name, handle] of dirHandle.entries()) {
        if (name.startsWith(".drop-complete-")) continue;

        if (handle.kind === "directory") {
          await walkTransfer(transferDirHandle, transferId, prefix ? `${prefix}/${name}` : name, handle);
          return;
        }
        
        try {
          const markerName = markerNameFor(name);
          let hasCompletedMarker = false;
        
          try {
            await dirHandle.getFileHandle(markerName, {create: false});
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
      for await (const [transferId, transferDirHandle] of receivedRoot.entries()) {
        if (transferDirHandle.kind !== "directory") continue;
        
        await walkTransfer(transferDirHandle, transferId, "", transferDirHandle);
      }
    } catch (err) {
      log.error("Failed enumerating received files (async directory iteration unsupported?)", err);
      throw err;
    }

    return out;
  }

  async function deleteEntry(entry) {
    log.info(`Deleting ${entry.relativePath} from transfer ${entry.transferId}`);
    
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

  async function clearAllReceived() {
    try {
      const receivedRoot = await getReceivedRoot();
      const entries = [];
    
      for await (const [name, handle] of receivedRoot.entries()) {
        entries.push([name, handle]);
      }
    
      for (const [name] of entries) {
        await receivedRoot.removeEntry(name, { recursive: true });
      }
    
      log.info("Cleared all received transfers from OPFS");
    } catch (err) {
      log.error("Failed clearing OPFS received files", err);
      throw err;
    }
  }

  async function getFile(entry) {
    return entry.handle.getFile();
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
