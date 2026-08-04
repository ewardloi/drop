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

async function handleOpenWrite({ transferId, relativePath }) {
  const { dirHandle, fileName } = await resolveParentDir(
    transferId,
    relativePath,
    true,
  );
  const fileHandle = await dirHandle.getFileHandle(fileName, {
    create: true,
  });
  const accessHandle = await fileHandle.createSyncAccessHandle();

  accessHandle.truncate(0);

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
  const written = accessHandle.write(view, { at: offset });
  return { written };
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

    accessHandle.read(new Uint8Array(buffer), { at: 0 });

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

self.onmessage = async (event) => {
  const { id, type, ...payload } = event.data;
  const handler = handlers[type];

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
};
