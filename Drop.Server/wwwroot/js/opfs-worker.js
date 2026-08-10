"use strict";

const openHandles = new Map();
let nextHandleId = 1;

async function getReceivedRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("received", { create: true });
}

async function resolveParentDir(transferId, relativePath, create) {
  const receivedRoot = await getReceivedRoot();
  const parts = relativePath.split("/").filter(Boolean);
  const fileName = parts.pop();

  let dir = await receivedRoot.getDirectoryHandle(String(transferId), {
    create: !!create,
  });

  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: !!create });
  }

  return { dirHandle: dir, fileName };
}

async function handleOpenWrite({ transferId, relativePath, size }) {
  const { dirHandle, fileName } = await resolveParentDir(
    transferId,
    relativePath,
    true,
  );
  const fileHandle = await dirHandle.getFileHandle(fileName, {
    create: true,
  });
  const accessHandle = await fileHandle.createSyncAccessHandle();

  try {
    accessHandle.truncate(Number.isFinite(size) && size > 0 ? size : 0);
  } catch (err) {
    accessHandle.close();
    throw err;
  }

  const handleId = nextHandleId++;
  openHandles.set(handleId, accessHandle);
  return { handleId };
}

function handleWriteChunk({ handleId, offset, buffer }) {
  const accessHandle = openHandles.get(handleId);

  if (!accessHandle) {
    throw new Error("Unknown write handle (already closed?)");
  }

  const view = new Uint8Array(buffer);
  let totalWritten = 0;

  while (totalWritten < view.byteLength) {
    const remaining = view.subarray(totalWritten);
    const written = accessHandle.write(remaining, {
      at: offset + totalWritten,
    });

    if (!(written > 0)) {
      throw new Error(
        `OPFS write stalled: wrote 0 of ${remaining.byteLength} remaining byte(s) ` +
          `at offset ${offset + totalWritten}`,
      );
    }

    totalWritten += written;
  }

  return { written: totalWritten };
}

function handleCloseWrite({ handleId }) {
  const accessHandle = openHandles.get(handleId);

  if (!accessHandle) {
    return { ok: true };
  }

  try {
    accessHandle.flush();
  } finally {
    accessHandle.close();
    openHandles.delete(handleId);
  }

  return { ok: true };
}

function handleAbortWrite({ handleId }) {
  const accessHandle = openHandles.get(handleId);

  if (!accessHandle) {
    return { ok: true };
  }

  try {
    accessHandle.close();
  } finally {
    openHandles.delete(handleId);
  }

  return { ok: true };
}

async function handleReadFile({ transferId, relativePath }) {
  const { dirHandle, fileName } = await resolveParentDir(
    transferId,
    relativePath,
    false,
  );
  const fileHandle = await dirHandle.getFileHandle(fileName, {
    create: false,
  });
  const accessHandle = await fileHandle.createSyncAccessHandle();

  try {
    const size = accessHandle.getSize();
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);

    const READ_CHUNK_SIZE = 512 * 1024 * 1024;
    let offset = 0;

    while (offset < size) {
      const end = Math.min(offset + READ_CHUNK_SIZE, size);
      const slice = view.subarray(offset, end);
      let readInSlice = 0;

      while (readInSlice < slice.byteLength) {
        const remaining = slice.subarray(readInSlice);
        const got = accessHandle.read(remaining, {
          at: offset + readInSlice,
        });

        if (!(got > 0)) {
          throw new Error(
            `OPFS read stalled: read 0 of ${remaining.byteLength} remaining byte(s) ` +
              `at offset ${offset + readInSlice}`,
          );
        }

        readInSlice += got;
      }

      offset = end;
    }

    return { buffer, size, name: fileName };
  } finally {
    accessHandle.close();
  }
}

const handlers = {
  "open-write": handleOpenWrite,
  "write-chunk": handleWriteChunk,
  "close-write": handleCloseWrite,
  "abort-write": handleAbortWrite,
  "read-file": handleReadFile,
};

let queue = Promise.resolve();

self.onmessage = (event) => {
  const { id, type, ...payload } = event.data;
  const handler = handlers[type];

  queue = queue.then(async () => {
    if (!handler) {
      self.postMessage({
        id,
        ok: false,
        error: `Unknown OPFS worker command: ${type}`,
      });
      return;
    }

    try {
      const result = await handler(payload);
      const transferables =
        result && result.buffer instanceof ArrayBuffer ? [result.buffer] : [];
      self.postMessage({ id, ok: true, result }, transferables);
    } catch (err) {
      self.postMessage({
        id,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  });
};