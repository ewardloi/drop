(function () {
  "use strict";

  const log = window.Log.files;

  function fromFileList(fileList) {
    const out = [];

    for (const file of fileList) {
      const relativePath =
        file.webkitRelativePath && file.webkitRelativePath.length > 0
          ? file.webkitRelativePath
          : file.name;
      out.push({ file, relativePath });
    }

    log.info(`Resolved ${out.length} file(s) from picker`);
    return out;
  }

  function readAllEntries(reader) {
    return new Promise((resolve, reject) => {
      const all = [];

      function readBatch() {
        reader.readEntries(
          (entries) => {
            if (entries.length === 0) {
              resolve(all);
              return;
            }

            all.push(...entries);
            readBatch();
          },
          (err) => {
            log.error("Directory reader failed", err);
            reject(err);
          },
        );
      }
      readBatch();
    });
  }

  function entryToFile(entry) {
    return new Promise((resolve, reject) => {
      entry.file(resolve, (err) => {
        log.error(`Failed reading file entry ${entry.fullPath}`, err);
        reject(err);
      });
    });
  }

  async function walkEntry(entry, out) {
    if (entry.isFile) {
      try {
        const file = await entryToFile(entry);
        const relativePath = entry.fullPath.replace(/^\//, "");

        out.push({ file, relativePath });
      } catch (err) {
        log.error(`Skipping unreadable file ${entry.fullPath}`, err);
      }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let children;

      try {
        children = await readAllEntries(reader);
      } catch (err) {
        log.error(`Skipping unreadable directory ${entry.fullPath}`, err);
        return;
      }

      for (const child of children) {
        await walkEntry(child, out);
      }
    } else {
      log.warn(`Unknown entry kind for ${entry.fullPath}`);
    }
  }

  async function fromDataTransferItems(items) {
    const out = [];
    const entries = [];

    for (const item of items) {
      if (item.kind !== "file") continue;

      if (typeof item.webkitGetAsEntry === "function") {
        const entry = item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      } else {
        const file = item.getAsFile();
        if (file) out.push({ file, relativePath: file.name });
      }
    }

    for (const entry of entries) {
      await walkEntry(entry, out);
    }

    log.info(
      `Resolved ${out.length} file(s) from drag-and-drop (directories expanded)`,
    );
    return out;
  }

  window.FileWalker = { fromFileList, fromDataTransferItems };
})();
