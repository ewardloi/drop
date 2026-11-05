(function () {
  "use strict";

  const log = window.Log.app;
  const ID_KEY = "drop.clientId";
  const NAME_KEY = "drop.clientName";
  const SESSION_KEY = "drop.session";
  const AUTH_SESSION_KEY = "drop.authSession";
  let accessRequestResultHandler = null;
  const EXTENSIONS_BY_MIME_TYPE = Object.freeze({
    "image/png": "png",
    "text/html": "html",
    "text/plain": "txt",
  });

  function tryGetExtensionFromMimeType(mimeType) {
    const type = String(mimeType || "")
      .toLowerCase()
      .split(";")[0]
      .trim();
    if (EXTENSIONS_BY_MIME_TYPE[type]) return EXTENSIONS_BY_MIME_TYPE[type];

    const subtype = type.split("/")[1]?.split("+")[0] || "bin";
    return subtype.replace(/[^a-z0-9_-]/g, "_");
  }

  function getOrCreateClientId() {
    let id = localStorage.getItem(ID_KEY);

    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(ID_KEY, id);
      log.info("Generated new client id", id);
    }

    return id;
  }

  function openNameDialog(
    initialValue,
    canRequestAccess = false,
    requestAccess = () => {},
  ) {
    return new Promise((resolve) => {
      const dialog = document.getElementById("name-dialog");
      const input = document.getElementById("name-input");
      const form = document.getElementById("name-form");
      const accessPanel = document.getElementById("name-access-panel");
      const requestButton = document.getElementById("name-access-request");
      const codeRow = document.getElementById("name-access-code-row");
      const verifyButton = document.getElementById("name-access-verify");
      const codeInput = document.getElementById("name-access-code");
      const accessStatus = document.getElementById("name-access-status");

      input.value = initialValue || "";
      accessPanel.hidden = !canRequestAccess;
      codeRow.hidden = true;
      codeInput.value = "";
      codeInput.hidden = true;
      requestButton.hidden = false;
      verifyButton.hidden = true;
      verifyButton.disabled = false;
      accessStatus.hidden = true;
      accessStatus.textContent = "";
      dialog.showModal();
      input.focus();

      function onSubmit(e) {
        e.preventDefault();
        if (document.activeElement === codeInput) {
          onVerifyAccess();
          return;
        }
        const value = input.value.trim();
        if (!value) return;
        cleanup();
        dialog.close();
        resolve(value);
      }

      function onRequestAccess() {
        codeRow.hidden = false;
        codeInput.hidden = false;
        requestButton.hidden = true;
        verifyButton.hidden = false;
        codeInput.focus();
      }

      function onVerifyAccess() {
        const code = codeInput.value.trim();
        if (!/^[0-9]{6}$/.test(code)) {
          accessStatus.textContent = "Enter a valid 6-digit code.";
          accessStatus.hidden = false;
          return;
        }

        verifyButton.disabled = true;
        accessStatus.textContent = "Checking code...";
        accessStatus.hidden = false;
        try {
          requestAccess(code);
        } catch (err) {
          verifyButton.disabled = false;
          accessStatus.textContent = err.message;
        }
      }

      function cleanup() {
        form.removeEventListener("submit", onSubmit);
        requestButton.removeEventListener("click", onRequestAccess);
        verifyButton.removeEventListener("click", onVerifyAccess);
        accessRequestResultHandler = null;
      }

      form.addEventListener("submit", onSubmit);
      requestButton.addEventListener("click", onRequestAccess);
      verifyButton.addEventListener("click", onVerifyAccess);
      accessRequestResultHandler = (result) => {
        verifyButton.disabled = false;
        if (result.granted) {
          cleanup();
          dialog.close();
          resolve(initialValue || "");
          return;
        }

        accessStatus.textContent = "That code was not accepted. Try again.";
        accessStatus.hidden = false;
      };
    });
  }

  async function main() {
    log.info("Starting Drop");

    try {
      window.OpfsStore.checkSupport();
      var session = sessionStorage.getItem(SESSION_KEY);

      if (!session)
        await window.OpfsStore.clearAllReceived();

      sessionStorage.setItem(SESSION_KEY, session ?? crypto.randomUUID());
    } catch (err) {
      log.error("OPFS unsupported", err);
      window.UI.toast(err.message, "error");
    }

    window.UI.initTheme();
    window.UI.initGlobalDropOverlay();

    const clientId = getOrCreateClientId();
    const layout = document.querySelector(".layout");
    const startupLoader = document.getElementById("startup-loader");
    let clientName = localStorage.getItem(NAME_KEY);

    if (!clientName) {
      startupLoader.hidden = true;
      clientName = await openNameDialog("");
      localStorage.setItem(NAME_KEY, clientName);
      log.info("Name set for the first time:", clientName);
    }

    startupLoader.hidden = false;
    document.getElementById("my-device-name").textContent = clientName;

    document
      .getElementById("my-device-btn")
      .addEventListener("click", async () => {
        const newName = await openNameDialog(
          clientName,
          !selfCanManageUploaders,
          (code) => rc.sendJson({ type: "request-access", code }),
        );
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

    window.UI.initTransportToggle(tm);
    window.UI.setTransportAvailability(tm, true);
    window.UI.initNavMenu();

    let pendingTarget = null;
    const filePicker = document.getElementById("file-picker");
    const folderPicker = document.getElementById("folder-picker");
    let selfCanUpload = true;
    let selfCanManageUploaders = false;

    function isRemotePeer(peer) {
      return !((peer.canUpload !== false) && selfCanUpload);
    }

    function onPick(peer, mode, entries) {
      if (mode === "allow-upload" || mode === "revoke-upload") {
        try {
          rc.sendJson({
            type: "set-uploader-permission",
            uploaderId: peer.id,
            allowed: mode === "allow-upload",
          });
        } catch (err) {
          window.UI.toast(err.message, "error");
        }
        return;
      }

      if (entries) {
        tm.queueSend(peer.id, peer.name, entries, isRemotePeer(peer));
        return;
      }

      if (mode === "clipboard" || mode === "secret") {
        sendText(peer, mode);
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

    async function readClipboardEntries() {
      const clipboard = navigator.clipboard;
      if (typeof clipboard.read === "function") {
        const items = await clipboard.read();
        const entries = [];

        for (const item of items) {
          for (const itemType of item.types) {
            const type = itemType.toLowerCase().split(";")[0];
            const blob = await item.getType(itemType);
            const file = new File(
              [blob],
              `${Date.now() + entries.length + 1}.${tryGetExtensionFromMimeType(type)}`,
              { type },
            );
            entries.push({ file, relativePath: file.name });
          }
        }

        if (entries.length > 0) return entries;
        throw new Error("Clipboard is empty");
      }

      const text = await clipboard.readText();
      if (text.length === 0) throw new Error("Clipboard is empty");
      const file = new File([text], `${Date.now()}.txt`, { type: "text/plain" });
      return [{ file, relativePath: file.name }];
    }

    async function sendText(peer, kind) {
      let entries;

      try {
        if (kind === "clipboard") {
          entries = await readClipboardEntries();
        } else {
          const text = await window.UI.promptSecret();
          if (text === null || text === undefined) return;
          if (text.trim().length === 0) {
            window.UI.toast("Secret cannot be empty", "error");
            return;
          }
          const file = new File([text], "secret", { type: "text/plain" });
          entries = [{ file, relativePath: file.name }];
        }
      } catch (err) {
        log.error(`Could not prepare ${kind}`, err);
        window.UI.toast(
          kind === "clipboard"
            ? `Could not read the clipboard: ${err.message}`
            : `Could not prepare the secret: ${err.message}`,
          "error",
        );
        return;
      }

      tm.queueSend(
        peer.id,
        peer.name,
        entries,
        isRemotePeer(peer),
        kind,
      );
    }

    filePicker.addEventListener("change", () => {
      if (!selfCanUpload) return;

      if (!pendingTarget || filePicker.files.length === 0) return;

      const entries = window.FileWalker.fromFileList(filePicker.files);
      tm.queueSend(
        pendingTarget.id,
        pendingTarget.name,
        entries,
        isRemotePeer(pendingTarget),
      );
      pendingTarget = null;
    });

    folderPicker.addEventListener("change", () => {
      if (!selfCanUpload) return;

      if (!pendingTarget || folderPicker.files.length === 0) return;

      const entries = window.FileWalker.fromFileList(folderPicker.files);
      tm.queueSend(
        pendingTarget.id,
        pendingTarget.name,
        entries,
        isRemotePeer(pendingTarget),
      );
      pendingTarget = null;
    });

    rc.addEventListener("message:peers", (e) => {
      selfCanUpload = e.detail.selfCanUpload !== false;
      selfCanManageUploaders = e.detail.canManageUploaders === true;
      window.UI.setTransportAvailability(tm, selfCanUpload);
      window.UI.setNetworkAvailability(selfCanUpload);
      window.UI.renderDevices(
        e.detail.peers,
        onPick,
        selfCanUpload,
        selfCanManageUploaders,
      );
      layout.hidden = false;
      startupLoader.hidden = true;
    });

    rc.addEventListener("disconnected", () => {
      selfCanUpload = false;
      selfCanManageUploaders = false;
      window.UI.setTransportAvailability(tm, false);
      window.UI.setNetworkAvailability(false);
      window.UI.renderDevices([], onPick, false, false);
    });

    rc.addEventListener("message:access-result", (e) => {
      accessRequestResultHandler?.(e.detail);
    });

    rc.addEventListener("message:session-ready", (e) => {
      try {
        sessionStorage.setItem(AUTH_SESSION_KEY, e.detail.token);
      } catch (err) {
        log.warn("Could not persist session token for reconnects", err);
      }
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
    let authSessionToken = null;
    try {
      authSessionToken = sessionStorage.getItem(AUTH_SESSION_KEY);
    } catch (err) {
      log.warn("Could not read the session token; reconnects will start a new session", err);
    }
    rc.connect(clientId, clientName, authSessionToken);

    log.info("Drop ready. clientId =", clientId, "name =", clientName);
  }

  main().catch((err) => {
    window.Log.app.error("Fatal startup error", err);
    window.UI.toast(`Drop failed to start: ${err.message}`, "error");
  });
})();
