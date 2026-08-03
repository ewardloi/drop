(function () {
  "use strict";

  const log = window.Log.app;
  const ID_KEY = "drop.clientId";
  const NAME_KEY = "drop.clientName";

  function getOrCreateClientId() {
    let id = localStorage.getItem(ID_KEY);

    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(ID_KEY, id);
      log.info("Generated new client id", id);
    }

    return id;
  }

  function openNameDialog(initialValue) {
    return new Promise((resolve) => {
      const dialog = document.getElementById("name-dialog");
      const input = document.getElementById("name-input");
      const form = document.getElementById("name-form");

      input.value = initialValue || "";
      dialog.showModal();
      input.focus();

      function onSubmit(e) {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        cleanup();
        dialog.close();
        resolve(value);
      }

      function cleanup() {
        form.removeEventListener("submit", onSubmit);
      }

      form.addEventListener("submit", onSubmit);
    });
  }

  async function clearStorageOnExit() {
    try {
      if (!window.OpfsStore?.clearAllReceived) return;
      await window.OpfsStore.clearAllReceived();
    } catch (err) {
      log.warn("Failed to clear OPFS on exit", err);
    }
  }

  async function main() {
    log.info("Starting Drop");

    try {
      window.OpfsStore.checkSupport();
      await window.OpfsStore.clearAllReceived();
    } catch (err) {
      log.error("OPFS unsupported", err);
      window.UI.toast(err.message, "error");
    }

    window.UI.initTheme();
    window.UI.initGlobalDropOverlay();

    const clientId = getOrCreateClientId();
    let clientName = localStorage.getItem(NAME_KEY);

    if (!clientName) {
      clientName = await openNameDialog("");
      localStorage.setItem(NAME_KEY, clientName);
      log.info("Name set for the first time:", clientName);
    }

    document.getElementById("my-device-name").textContent = clientName;

    document
      .getElementById("my-device-btn")
      .addEventListener("click", async () => {
        const newName = await openNameDialog(clientName);
        if (newName && newName !== clientName) {
          clientName = newName;
          localStorage.setItem(NAME_KEY, clientName);
          document.getElementById("my-device-name").textContent = clientName;
          try {
            rc.sendJson({ type: "rename", name: clientName });
            log.info("Renamed device to", clientName);
          } catch (err) {
            log.error("Failed to send rename", err);
            window.UI.toast(
              "Could not update your name on the network - reconnect and try again.",
              "error",
            );
          }
        }
      });

    const rc = new window.RelayClient();
    const tm = new window.TransferManager(rc);

    let pendingTarget = null;
    const filePicker = document.getElementById("file-picker");
    const folderPicker = document.getElementById("folder-picker");
    let selfCanUpload = true;

    function onPick(peer, mode, entries) {
      if (entries) {
        tm.queueSend(peer.id, peer.name, entries);
        return;
      }

      pendingTarget = peer;

      if (mode === "folder") {
        folderPicker.value = "";
        folderPicker.click();
      } else {
        filePicker.value = "";
        filePicker.click();
      }
    }

    filePicker.addEventListener("change", () => {
      if (!selfCanUpload) return;

      if (!pendingTarget || filePicker.files.length === 0) return;

      const entries = window.FileWalker.fromFileList(filePicker.files);
      tm.queueSend(pendingTarget.id, pendingTarget.name, entries);
      pendingTarget = null;
    });

    folderPicker.addEventListener("change", () => {
      if (!selfCanUpload) return;

      if (!pendingTarget || folderPicker.files.length === 0) return;

      const entries = window.FileWalker.fromFileList(folderPicker.files);
      tm.queueSend(pendingTarget.id, pendingTarget.name, entries);
      pendingTarget = null;
    });

    rc.addEventListener("message:peers", (e) => {
      selfCanUpload = e.detail.selfCanUpload !== false;
      window.UI.renderDevices(e.detail.peers, onPick, selfCanUpload);
    });

    rc.addEventListener("disconnected", () => {
      window.UI.renderDevices([], onPick);
    });

    tm.addEventListener("outgoing-changed", (e) => renderActive());
    tm.addEventListener("incoming-changed", (e) => {
      window.UI.renderIncomingRequests(e.detail, (transferIds, accepted) =>
        tm.respondToRequests(transferIds, accepted),
      );
      renderActive();
      window.UI.renderReceivedFiles(tm);
    });
    tm.addEventListener("received-updated", () =>
      window.UI.renderReceivedFiles(tm),
    );
    tm.addEventListener("toast", (e) =>
      window.UI.toast(e.detail.message, e.detail.kind),
    );

    function renderActive() {
      window.UI.renderActiveTransfers(
        [...tm.outgoing.values()],
        [...tm.incoming.values()],
        (job) => {
          if (job.direction === "outgoing") {
            tm.cancelOutgoing(job.transferId);
          } else {
            tm.cancelIncoming(
              job.transferId,
              job.status === "pending-decision",
            );
          }
        },
      );
    }

    window.UI.renderReceivedFiles(tm);
    rc.connect(clientId, clientName);

    window.addEventListener("beforeunload", () => {
      clearStorageOnExit();
    });
    window.addEventListener("pagehide", () => {
      clearStorageOnExit();
    });

    log.info("Drop ready. clientId =", clientId, "name =", clientName);
  }

  main().catch((err) => {
    window.Log.app.error("Fatal startup error", err);
    window.UI.toast(`Drop failed to start: ${err.message}`, "error");
  });
})();
