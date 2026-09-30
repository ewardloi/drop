(function () {
  "use strict";

  const log = window.Log.ui;
  let deviceMenuController = null;
  let textDialogSecretValue = "";
  let textDialogSecretMasked = false;

  const ICON = {
    spinner: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" class="spin"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="42" stroke-dashoffset="14"/></svg>`,
    check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    x: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
    download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3v12M12 15l-4.5-4.5M12 15l4.5-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V4.8A1.8 1.8 0 0 1 10.8 3h2.4A1.8 1.8 0 0 1 15 4.8V7M6 7l1 13.2A1.8 1.8 0 0 0 8.8 22h6.4a1.8 1.8 0 0 0 1.8-1.8L18 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    stop: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/></svg>`,
    laptop: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="12" rx="1.6" stroke="currentColor" stroke-width="1.6"/><path d="M2 19h20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    file: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 3h8l4 4v14H6V3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3v4h4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
    folder: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
    doc: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 3h8l4 4v14H6V3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    eye: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.7"/></svg>`,
    eyeOff: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="m3 3 18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.2A10.7 10.7 0 0 1 12 5c6.1 0 9.5 7 9.5 7a15.8 15.8 0 0 1-3.1 3.8M6.2 6.3C3.8 8 2.5 12 2.5 12s3.4 7 9.5 7c1.1 0 2.1-.2 3-.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    copy: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="12" height="13" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.7"/></svg>`,
    clock: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3.2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };

  function formatBytes(n) {
    if (n === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(n) / Math.log(1024));
    const idx = Math.min(i, units.length - 1);
    return `${(n / Math.pow(1024, idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
  }

  function formatBytesPerSecond(n) {
    return `${formatBytes(n)}/s`;
  }

  function formatDuration(totalSeconds) {
    if (!isFinite(totalSeconds) || totalSeconds < 0) return "";
    const s = Math.round(totalSeconds);
    if (s < 1) return "<1s";
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const remS = s % 60;
    if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
  }

  function currentFileRemainingBytes(job, doneBytes) {
    const currentFile = job.files?.[job.currentFileIndex];
    if (!currentFile || !(currentFile.size > 0)) return null;

    let bytesBeforeCurrent = 0;
    for (let i = 0; i < job.currentFileIndex; i++) {
      bytesBeforeCurrent += job.files[i]?.size || 0;
    }

    const doneInFile = Math.min(
      currentFile.size,
      Math.max(0, doneBytes - bytesBeforeCurrent),
    );

    return currentFile.size - doneInFile;
  }

  function etaText(job, doneBytes) {
    if (!["sending", "receiving"].includes(job.status)) return "";
    if (!(job.speedBytesPerSecond > 0)) return "";

    const remainingBytes =
      currentFileRemainingBytes(job, doneBytes) ?? job.totalBytes - doneBytes;
    if (remainingBytes <= 0) return "";

    return `${formatDuration(remainingBytes / job.speedBytesPerSecond)} left`;
  }

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function transferMetaParts(job, isOut) {
    const isActive = ["sending", "receiving"].includes(job.status);
    const finalizing = isActive && job.phase === "finalizing";
    const doneBytes = isOut ? job.sentBytes : job.receivedBytes;

    const speedText =
      isActive && !finalizing && job.speedBytesPerSecond > 0
        ? `${isOut ? "↑" : "↓"} ${formatBytesPerSecond(job.speedBytesPerSecond)}`
        : "";
    const etaValue = isActive && !finalizing ? etaText(job, doneBytes) : "";
    const sizeText = `${formatBytes(doneBytes)} / ${formatBytes(job.totalBytes)}`;

    return { isActive, finalizing, doneBytes, speedText, etaValue, sizeText };
  }

  const THEME_KEY = "drop.theme";
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    document.getElementById("theme-icon-light").style.display =
      theme === "light" ? "" : "none";
    document.getElementById("theme-icon-dark").style.display =
      theme === "dark" ? "" : "none";
    document.getElementById("theme-icon-auto").style.display =
      theme === "auto" ? "" : "none";
    document.getElementById("theme-label").textContent =
      theme[0].toUpperCase() + theme.slice(1);

    localStorage.setItem(THEME_KEY, theme);

    log.info(`Theme set to ${theme}`);
  }
  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) ?? "auto";

    applyTheme(saved);

    document.getElementById("theme-toggle").addEventListener("click", () => {
      const order = ["auto", "light", "dark"];
      const current = document.documentElement.getAttribute("data-theme");
      const next = order[(order.indexOf(current) + 1) % order.length];
      applyTheme(next);
    });
  }

  const TRANSPORT_KEY = "drop.transportMode";

  function applyTransportMode(mode, tm, canUpload = true) {
    const normalizedMode = ["auto", "p2p", "relay"].includes(mode)
      ? mode
      : "auto";
    const effectiveMode = canUpload ? normalizedMode : "relay";

    const labelByMode = {
      auto: "Auto",
      p2p: "P2P",
      relay: "Relay",
    };

    document.getElementById("transport-icon-relay").style.display =
      effectiveMode === "relay" ? "" : "none";
    document.getElementById("transport-icon-p2p").style.display =
      effectiveMode === "relay" ? "none" : "";
    document.getElementById("transport-label").textContent =
      labelByMode[effectiveMode];
    document.getElementById("transport-toggle").title =
      !canUpload
        ? "This device can only receive files"
        : effectiveMode === "auto"
          ? "Auto"
          : effectiveMode === "p2p"
            ? "P2P"
            : "Relay";

    for (const item of document.querySelectorAll(
      "#transport-menu .dropdown-item",
    )) {
      item.classList.toggle(
        "selected",
        item.dataset.transportMode === effectiveMode,
      );
    }

    localStorage.setItem(TRANSPORT_KEY, effectiveMode);

    if (tm) {
      tm.transportMode = effectiveMode;
      tm.webrtcEnabled = effectiveMode !== "relay" && canUpload;
    }

    log.info(`Transfer mode set to ${effectiveMode} (canUpload=${canUpload})`);
  }

  function setTransportAvailability(tm, canUpload) {
    const saved = localStorage.getItem(TRANSPORT_KEY) ?? "auto";
    const normalizedSaved = ["auto", "p2p", "relay"].includes(saved)
      ? saved
      : "auto";

    applyTransportMode(normalizedSaved, tm, canUpload);

    const dropdown = document.getElementById("transport-dropdown");
    if (dropdown) {
      dropdown.style.display = canUpload ? "" : "none";
      dropdown.setAttribute("aria-hidden", String(!canUpload));
    }
  }

  function setNetworkAvailability(canUpload) {
    const panel = document.querySelector(".devices-panel");
    if (!panel) return;

    panel.style.display = canUpload ? "" : "none";
  }

  function initTransportToggle(tm) {
    const saved = localStorage.getItem(TRANSPORT_KEY) ?? "auto";
    const normalizedSaved = ["auto", "p2p", "relay"].includes(saved)
      ? saved
      : "auto";

    applyTransportMode(normalizedSaved, tm, true);

    const dropdown = document.getElementById("transport-dropdown");
    const toggleBtn = document.getElementById("transport-toggle");
    const menu = document.getElementById("transport-menu");

    function positionMenu() {
      const rect = toggleBtn.getBoundingClientRect();
      const menuWidth = Math.min(268, window.innerWidth - 24);

      let left = rect.right - menuWidth;
      left = Math.max(12, Math.min(left, window.innerWidth - menuWidth - 12));

      menu.style.width = `${menuWidth}px`;
      menu.style.left = `${left}px`;
      menu.style.top = `${rect.bottom + 8}px`;
    }

    function openMenu() {
      positionMenu();
      menu.hidden = false;
      dropdown.dataset.open = "true";
      toggleBtn.setAttribute("aria-expanded", "true");
    }

    function closeMenu() {
      menu.hidden = true;
      delete dropdown.dataset.open;
      toggleBtn.setAttribute("aria-expanded", "false");
    }

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dropdown.style.display === "none") return;
      if (menu.hidden) openMenu();
      else closeMenu();
    });

    for (const item of menu.querySelectorAll(".dropdown-item")) {
      item.addEventListener("click", () => {
        if (dropdown.style.display === "none") return;
        applyTransportMode(item.dataset.transportMode, tm, true);
        closeMenu();
      });
    }

    window.addEventListener("resize", () => {
      if (!menu.hidden) positionMenu();
    });

    document.addEventListener("click", (e) => {
      if (!menu.hidden && !dropdown.contains(e.target)) closeMenu();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) closeMenu();
    });
  }

  function initNavMenu() {
    const toggleBtn = document.getElementById("nav-toggle");
    const panel = document.getElementById("topbar-secondary");

    function openPanel() {
      panel.dataset.open = "true";
      toggleBtn.setAttribute("aria-expanded", "true");
    }

    function closePanel() {
      delete panel.dataset.open;
      toggleBtn.setAttribute("aria-expanded", "false");
    }

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (panel.dataset.open === "true") closePanel();
      else openPanel();
    });

    for (const btn of panel.querySelectorAll("button")) {
      if (btn.id === "theme-toggle") continue;
      btn.addEventListener("click", () => closePanel());
    }

    document.addEventListener("click", (e) => {
      if (
        panel.dataset.open === "true" &&
        !panel.contains(e.target) &&
        !toggleBtn.contains(e.target)
      ) {
        closePanel();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panel.dataset.open === "true") closePanel();
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 640 && panel.dataset.open === "true") {
        closePanel();
      }
    });
  }

  function toastPopoverIsOpen(root) {
    if (typeof root.hidePopover !== "function") return false;

    try {
      return root.matches(":popover-open");
    } catch {
      return false;
    }
  }

  function toast(message, kind) {
    const root = document.getElementById("toast-root");
    const node = el(`<div class="toast ${kind || ""}">${message}</div>`);

    root.appendChild(node);

    if (typeof root.showPopover === "function") {
      try {
        if (toastPopoverIsOpen(root)) root.hidePopover();
        root.showPopover();
      } catch (err) {
        root.removeAttribute("popover");
        log.warn("Could not promote notifications to the top layer", err);
      }
    }

    const openDialog = document.querySelector("dialog[open]");

    if (!toastPopoverIsOpen(root) && openDialog && !openDialog.contains(root)) {
      openDialog.appendChild(root);
      root.dataset.toastDialog = openDialog.id;
      openDialog.addEventListener("close", () => {
        if (root.dataset.toastDialog !== openDialog.id) return;

        document.body.appendChild(root);
        delete root.dataset.toastDialog;
      }, { once: true });
    }

    log[kind === "error" ? "error" : "info"]("Toast:", message);

    setTimeout(() => {
      node.remove();
      
      if (root.childElementCount > 0) return;

      if (toastPopoverIsOpen(root)) root.hidePopover();
      
      if (root.dataset.toastDialog) {
        document.body.appendChild(root);
        delete root.dataset.toastDialog;
      }
    }, 5000);
  }

  function renderDevices(peers, onPick, selfCanUpload) {
    const grid = document.getElementById("devices-grid");
    const empty = document.getElementById("devices-empty");
    const count = document.getElementById("peer-count");

    count.textContent = `${peers.length} online`;
    
    deviceMenuController?.abort();
    deviceMenuController = new AbortController();

    document.querySelectorAll(".device-context-menu").forEach((menu) => menu.remove());
    grid.innerHTML = "";
    empty.style.display = peers.length === 0 ? "flex" : "none";

    for (const peer of peers) {
      const canUpload = peer.canUpload !== false;
      const mode = canUpload && selfCanUpload ? "local" : "remote";

      const card = el(`
        <div class="device-card ${canUpload ? "" : "download-only"} ${selfCanUpload ? "" : "upload-disabled"}" role="listitem" data-id="${peer.id}" title="${selfCanUpload ? "Click to send files, Shift+Click to send a folder, or right-click for more options" : "You are on a public network and can only receive files"}">
          <span class="status-dot pulse"></span>
          <div class="device-avatar">${ICON.laptop}</div>
          <div class="device-card-name">${escapeHtml(peer.name)}</div>
          <div class="device-card-mode">${mode}</div>
        </div>
      `);

      card.addEventListener("click", (e) => {
        if (card.dataset.suppressClick === "true") {
          delete card.dataset.suppressClick;
          e.preventDefault();
          return;
        }

        if (!selfCanUpload) {
          toast(
            "You are outside the local network, so you can only receive files.",
            "error",
          );
          return;
        }
        onPick(peer, e.shiftKey ? "folder" : "files");
      });

      const menu = el(`
        <div class="device-context-menu" role="menu" hidden>
          <button type="button" role="menuitem" data-action="files">${ICON.file}<span>Send files</span></button>
          <button type="button" role="menuitem" data-action="folder">${ICON.folder}<span>Send folder</span></button>
          <button type="button" role="menuitem" data-action="clipboard">${ICON.copy}<span>Send from clipboard</span></button>
          <button type="button" role="menuitem" data-action="secret">${ICON.doc}<span>Send secret</span></button>
        </div>
      `);
      document.body.appendChild(menu);

      function closeMenu() {
        menu.hidden = true;
      }

      function openMenu(x, y) {
        if (!selfCanUpload) {
          toast("You are outside the local network, so you can only receive files.", "error");
          return;
        }

        menu.hidden = false;
        
        const rect = menu.getBoundingClientRect();
        
        menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
      }

      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        closeMenu();
        openMenu(e.clientX, e.clientY);
      });

      let pressTimer = null;

      card.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "touch") return;

        pressTimer = setTimeout(() => {
          card.dataset.suppressClick = "true";
          openMenu(e.clientX, e.clientY);
          pressTimer = null;
        }, 550);
      });

      for (const eventName of ["pointerup", "pointercancel", "pointermove"]) {
        card.addEventListener(eventName, () => {
          if (pressTimer) clearTimeout(pressTimer);
          pressTimer = null;
        });
      }

      menu.addEventListener("click", (e) => {
        const button = e.target.closest("button[data-action]");
        if (!button) return;
        closeMenu();
        onPick(peer, button.dataset.action);
      });

      document.addEventListener("pointerdown", (e) => {
        if (!menu.hidden && !menu.contains(e.target)) closeMenu();
      }, { signal: deviceMenuController.signal });

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMenu();
      }, { signal: deviceMenuController.signal });

      card.addEventListener("dragover", (e) => {
        if (!selfCanUpload) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        card.classList.add("drag-over");
      });

      card.addEventListener("dragleave", () =>
        card.classList.remove("drag-over"),
      );

      card.addEventListener("drop", async (e) => {
        if (!selfCanUpload) {
          e.preventDefault();
          toast(
            "You are outside the local network, so you can only receive files.",
            "error",
          );
          return;
        }

        e.preventDefault();
        card.classList.remove("drag-over");
        hideDropOverlay();

        try {
          const items = e.dataTransfer.items;
          const entries =
            items && items.length > 0
              ? await window.FileWalker.fromDataTransferItems(items)
              : window.FileWalker.fromFileList(e.dataTransfer.files);

          if (entries.length === 0) {
            toast("No files found in what was dropped.", "error");
            return;
          }

          onPick(peer, "entries", entries);
        } catch (err) {
          log.error("Failed resolving dropped items", err);
          toast(`Could not read the dropped files: ${err.message}`, "error");
        }
      });

      grid.appendChild(card);
    }
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  let dragDepth = 0;
  function initGlobalDropOverlay() {
    const overlay = document.getElementById("drop-overlay");

    const setDragActive = (active) => {
      document.body.classList.toggle("drag-active", active);
      overlay.classList.remove("visible");
    };

    window.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      dragDepth++;
      setDragActive(true);
    });

    window.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragActive(false);
    });

    window.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer?.types?.includes("Files")) setDragActive(true);
    });

    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      setDragActive(false);
    });
  }

  function hideDropOverlay() {
    dragDepth = 0;
    document.body.classList.remove("drag-active");
    document.getElementById("drop-overlay").classList.remove("visible");
  }

  function renderIncomingRequests(jobs, onDecision) {
    const root = document.getElementById("incoming-requests");
    root.innerHTML = "";

    const pendingDecision = jobs.filter((j) => j.status === "pending-decision");
    const queued = jobs.filter((j) => j.status === "pending-queue");
    const queuedCount = queued.length;

    const groups = new Map();
    for (const job of [...pendingDecision, ...queued]) {
      const key = `${job.fromId || job.fromName}`;

      if (!groups.has(key)) {
        groups.set(key, {
          fromName: job.fromName,
          transferIds: [],
          files: [],
          totalBytes: 0,
          canAct: false,
        });
      }

      const group = groups.get(key);

      group.transferIds.push(job.transferId);
      group.files.push(...job.files);
      group.totalBytes += job.totalBytes;
      group.canAct = group.canAct || job.status === "pending-decision";
    }

    for (const group of groups.values()) {
      const visibleFiles = group.files.slice(0, 8);

      const filesHtml = visibleFiles
        .map(
          (f) => `
        <div class="file-list-mini-row"><span>${escapeHtml(f.relativePath || f.name)}</span><span>${formatBytes(f.size)}</span></div>
      `,
        )
        .join("");

      const more =
        group.files.length > visibleFiles.length
          ? `<div class="file-list-mini-row"><span>+ ${group.files.length - visibleFiles.length} more</span><span></span></div>`
          : "";
      const fileLabel =
        group.files.length === 1 ? "1 file" : `${group.files.length} files`;
      const canAct = group.canAct || group.transferIds.length > 0;

      const card = el(`
        <div class="card request">
          <div class="card-row">
            <div class="card-icon">${ICON.laptop}</div>
            <div class="card-main">
              <div class="card-title">${escapeHtml(group.fromName)} wants to send ${fileLabel}</div>
              <div class="card-sub">${formatBytes(group.totalBytes)} total${queuedCount > 0 ? ` &middot; ${queuedCount} more request(s) waiting` : ""}</div>
            </div>
            <div class="card-actions">
              ${canAct ? `<button class="btn-danger reject-btn">${ICON.x} Reject</button>` : ""}
              ${canAct ? `<button class="btn-primary accept-btn">${ICON.check} Accept</button>` : `<span class="status-tag queued">Queued</span>`}
            </div>
          </div>
          <div class="file-list-mini">${filesHtml}${more}</div>
        </div>
      `);

      const acceptBtn = card.querySelector(".accept-btn");
      const rejectBtn = card.querySelector(".reject-btn");

      if (acceptBtn)
        acceptBtn.addEventListener("click", () =>
          onDecision(group.transferIds, true),
        );
      if (rejectBtn)
        rejectBtn.addEventListener("click", () =>
          onDecision(group.transferIds, false),
        );

      root.appendChild(card);
    }
  }

  function statusLabel(status) {
    return (
      {
        queued: "Queued",
        requesting: "Waiting for response",
        sending: "Sending",
        receiving: "Receiving",
        done: "Done",
        rejected: "Rejected",
        canceled: "Canceled",
        error: "Failed",
        "pending-queue": "Queued",
        "pending-decision": "Awaiting your response",
      }[status] || status
    );
  }

  function statusClass(status) {
    if (["sending", "receiving", "requesting"].includes(status))
      return "active";
    if (["done"].includes(status)) return "done";
    if (["rejected", "canceled", "error"].includes(status)) return "rejected";
    return "queued";
  }

  function fileStatusForTransfer(job, fileIndex) {
    const currentIndex = Number.isInteger(job.currentFileIndex)
      ? job.currentFileIndex
      : -1;
    if (job.status === "done") return "done";

    if (job.status === "canceled") {
      if (fileIndex < currentIndex) return "done";
      return "rejected";
    }

    if (["rejected", "error"].includes(job.status)) {
      if (currentIndex < 0) return "rejected";
      if (fileIndex < currentIndex) return "done";
      if (fileIndex === currentIndex) return "rejected";
      return "queued";
    }

    if (fileIndex < currentIndex) return "done";
    if (
      fileIndex === currentIndex &&
      ["sending", "receiving", "requesting"].includes(job.status)
    )
      return "active";
    return "queued";
  }

  function createTransferFileRow(file, index, job) {
    const status = fileStatusForTransfer(job, index);

    const label =
      status === "active"
        ? "Active"
        : status === "done"
          ? "Done"
          : status === "rejected"
            ? "Canceled"
            : "Queued";

    const path = file.relativePath || file.name || `File ${index + 1}`;
    const row = el(`
      <div class="file-list-mini-row" data-file-index="${index}">
        <span>${escapeHtml(path)}</span>
        <span class="file-status-pill ${status}">${label}</span>
      </div>
    `);

    row.querySelector("span:first-child").textContent = path;
    row.querySelector(".file-status-pill").textContent = label;
    row.querySelector(".file-status-pill").className =
      `file-status-pill ${status}`;

    return row;
  }

  function updateTransferFileRows(card, job) {
    const list = card.querySelector(".file-list-mini");

    if (!job.files || job.files.length === 0) {
      if (list) list.remove();

      return;
    }

    if (!list) {
      const created = el(`<div class="file-list-mini"></div>`);
      card.appendChild(created);
      updateTransferFileRows(card, job);
      return;
    }

    const existing = new Map();

    for (const row of list.querySelectorAll(".file-list-mini-row")) {
      existing.set(Number(row.dataset.fileIndex), row);
    }

    for (const [index, file] of job.files.entries()) {
      const status = fileStatusForTransfer(job, index);
      const label =
        status === "active"
          ? "Active"
          : status === "done"
            ? "Done"
            : status === "rejected"
              ? "Canceled"
              : "Queued";

      const path = file.relativePath || file.name || `File ${index + 1}`;
      const row = existing.get(index);

      if (row) {
        row.querySelector("span:first-child").textContent = path;
        const pill = row.querySelector(".file-status-pill");
        pill.className = `file-status-pill ${status}`;
        pill.textContent = label;
      } else {
        list.appendChild(createTransferFileRow(file, index, job));
      }
    }

    for (const row of [...list.querySelectorAll(".file-list-mini-row")]) {
      if (!job.files[row.dataset.fileIndex]) {
        row.remove();
      }
    }
  }

  function createActiveTransferCard(job, onCancel) {
    const isOut = job.direction === "outgoing";

    const peerName = isOut ? job.targetName : job.fromName;
    const { doneBytes, isActive, speedText, etaValue, sizeText } =
      transferMetaParts(job, isOut);
    const pct =
      job.totalBytes > 0
        ? Math.min(100, Math.round((doneBytes / job.totalBytes) * 100))
        : 0;
    const currentFile =
      job.files[job.currentFileIndex]?.name ||
      job.files[job.currentFileIndex]?.relativePath ||
      peerName;
    const currentFileSize = job.files[job.currentFileIndex]?.size;
    const currentFileTitle =
      currentFileSize != null
        ? `${currentFile} • ${formatBytes(currentFileSize)}`
        : currentFile;
    const canCancel = ["queued", "requesting", "sending", "receiving"].includes(
      job.status,
    );

    const card = el(`
      <div class="card" data-transfer-id="${job.transferId}">
        <div class="card-row">
          <div class="card-icon">${isOut ? ICON.download : ICON.folder}</div>
          <div class="card-main">
            <div class="card-title" title="${escapeHtml(currentFileTitle)}">${escapeHtml(currentFileTitle)}</div>
          </div>
          ${job.webrtcTransport ? `<span class="status-tag p2p" title="Direct P2P connection (WebRTC)">P2P</span>` : ""}
          <span class="status-tag ${statusClass(job.status)}">${statusLabel(job.status)}</span>
          ${canCancel ? `<button class="btn-ghost icon-only cancel-btn" title="Cancel">${ICON.stop}</button>` : ""}
        </div>
        <div class="card-footer-row">
          ${
            isActive
              ? job.phase === "finalizing"
                ? `<div class="card-meta finalizing">
                    <span class="card-meta-status">${ICON.clock} Finishing file&hellip;</span>
                    <span class="card-meta-status-spacer">&nbsp;</span>
                  </div>`
                : `<div class="card-meta">
                    <span class="card-meta-speed"${speedText ? "" : ' style="visibility:hidden"'}>${escapeHtml(speedText) || "&nbsp;"}</span>
                    <span class="card-meta-eta"${etaValue ? "" : ' style="visibility:hidden"'}>${ICON.clock}<span>${escapeHtml(etaValue) || "&nbsp;"}</span></span>
                  </div>`
              : ""
          }
          <span class="card-size">${escapeHtml(sizeText)}</span>
        </div>
        <div class="progress-track"><div class="progress-fill ${job.status === "error" ? "danger" : job.status === "done" ? "success" : ""}" style="width:${pct}%"></div></div>
      </div>
    `);
    const cancelBtn = card.querySelector(".cancel-btn");
    if (cancelBtn) cancelBtn.addEventListener("click", () => onCancel(job));
    return card;
  }

  function updateActiveTransferCard(card, job, onCancel) {
    const isOut = job.direction === "outgoing";
    const peerName = isOut ? job.targetName : job.fromName;
    const { doneBytes, isActive, finalizing, speedText, etaValue, sizeText } =
      transferMetaParts(job, isOut);
    const pct =
      job.totalBytes > 0
        ? Math.min(100, Math.round((doneBytes / job.totalBytes) * 100))
        : 0;
    const currentFile =
      job.files[job.currentFileIndex]?.name ||
      job.files[job.currentFileIndex]?.relativePath ||
      peerName;
    const currentFileSize = job.files[job.currentFileIndex]?.size;
    const currentFileTitle =
      currentFileSize != null
        ? `${currentFile} • ${formatBytes(currentFileSize)}`
        : currentFile;
    const canCancel = ["queued", "requesting", "sending", "receiving"].includes(
      job.status,
    );

    const titleEl = card.querySelector(".card-title");
    const footerRow = card.querySelector(".card-footer-row");
    let metaEl = card.querySelector(".card-meta");
    const sizeEl = card.querySelector(".card-size");
    let p2pTag = card.querySelector(".status-tag.p2p");
    const statusTag = card.querySelector(".status-tag:not(.p2p)");
    const progressFill = card.querySelector(".progress-fill");
    const cancelBtn = card.querySelector(".cancel-btn");

    titleEl.textContent = currentFileTitle;
    titleEl.title = currentFileTitle;

    if (finalizing) {
      if (!metaEl || !metaEl.classList.contains("finalizing")) {
        if (metaEl) metaEl.remove();
        metaEl = el(`
          <div class="card-meta finalizing">
            <span class="card-meta-status">${ICON.clock} Finishing file&hellip;</span>
            <span class="card-meta-status-spacer">&nbsp;</span>
          </div>
        `);
        footerRow.insertAdjacentElement("afterbegin", metaEl);
      }
    } else if (isActive) {
      if (!metaEl || metaEl.classList.contains("finalizing")) {
        if (metaEl) metaEl.remove();
        metaEl = el(`
          <div class="card-meta">
            <span class="card-meta-speed">&nbsp;</span>
            <span class="card-meta-eta">${ICON.clock}<span>&nbsp;</span></span>
          </div>
        `);
        footerRow.insertAdjacentElement("afterbegin", metaEl);
      }
      const speedEl = metaEl.querySelector(".card-meta-speed");
      const etaEl = metaEl.querySelector(".card-meta-eta");
      speedEl.innerHTML = escapeHtml(speedText) || "&nbsp;";
      speedEl.style.visibility = speedText ? "" : "hidden";
      etaEl.querySelector("span").innerHTML = escapeHtml(etaValue) || "&nbsp;";
      etaEl.style.visibility = etaValue ? "" : "hidden";
    } else if (metaEl) {
      metaEl.remove();
    }

    sizeEl.textContent = sizeText;

    if (job.webrtcTransport) {
      if (!p2pTag) {
        p2pTag = document.createElement("span");
        p2pTag.className = "status-tag p2p";
        p2pTag.title = "Direct P2P connection (WebRTC)";
        p2pTag.textContent = "P2P";
        statusTag.insertAdjacentElement("beforebegin", p2pTag);
      }
    } else if (p2pTag) {
      p2pTag.remove();
    }

    statusTag.className = `status-tag ${statusClass(job.status)}`;
    statusTag.textContent = statusLabel(job.status);
    progressFill.style.width = `${pct}%`;
    progressFill.className = `progress-fill ${job.status === "error" ? "danger" : job.status === "done" ? "success" : ""}`;

    updateTransferFileRows(card, job);

    if (canCancel) {
      if (!cancelBtn) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-ghost icon-only cancel-btn";
        btn.title = "Cancel";
        btn.innerHTML = ICON.stop;
        btn.addEventListener("click", () => onCancel(job));
        card.querySelector(".card-row").appendChild(btn);
      }
    } else if (cancelBtn) {
      cancelBtn.remove();
    }
  }

  function renderActiveTransfers(outgoingJobs, incomingJobs, onCancel) {
    const root = document.getElementById("active-transfers");
    const emptyEl = document.getElementById("active-transfers-empty");

    const relevant = [...outgoingJobs, ...incomingJobs].filter(
      (j) => !["pending-queue", "pending-decision"].includes(j.status),
    );

    emptyEl.style.display = relevant.length === 0 ? "flex" : "none";

    const existingCards = new Map();
    for (const card of root.querySelectorAll(".card[data-transfer-id]")) {
      existingCards.set(card.dataset.transferId, card);
    }

    for (const job of relevant) {
      const transferId = job.transferId;
      const existing = existingCards.get(transferId);

      if (existing) {
        updateActiveTransferCard(existing, job, onCancel);
        existingCards.delete(transferId);
      } else {
        root.appendChild(createActiveTransferCard(job, onCancel));
      }
    }

    for (const leftover of existingCards.values()) {
      leftover.remove();
    }
  }

  function receivedFileKey(entry) {
    return `${entry.transferId}:${entry.relativePath}`;
  }

  function createReceivedRow(entry) {
    const special = ["clipboard", "secret"].includes(entry.transferKind);

    const receivedTime = entry.receivedAt
      ? new Date(entry.receivedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      : "";

    const kindLabel = entry.transferKind === "clipboard" ? "Clipboard" : "Secret";
    
    const titleText = special
      ? `${entry.senderName || "Unknown device"} · ${kindLabel} · ${receivedTime}`
      : entry.relativePath;

    const row = el(`
      <div class="card received-row" data-file-key="${receivedFileKey(entry)}">
        <div class="card-row">
          <div class="card-icon">${ICON.doc}</div>
          <div style="min-width:0; flex:1;">
            <div class="card-title">${escapeHtml(titleText)}</div>
            <div class="card-sub">${special ? `${kindLabel} · ${formatBytes(entry.size)}` : formatBytes(entry.size)}</div>
          </div>
          <div class="card-actions">
            ${special ? `<button class="btn-secondary icon-only view-btn" title="View">${ICON.eye}</button><button class="btn-secondary icon-only copy-btn" title="Copy">${ICON.copy}</button>` : `<button class="btn-secondary icon-only dl-btn" title="Download">${ICON.download}</button>`}
            <button class="btn-danger icon-only del-btn" title="Delete">${ICON.trash}</button>
          </div>
        </div>
      </div>
    `);

    const downloadButton = row.querySelector(".dl-btn");

    if (downloadButton) downloadButton.addEventListener("click", (e) => {
      withBusyButton(e.currentTarget, "Downloading…", () => downloadEntry(entry), { iconOnly: true });
    });

    const viewButton = row.querySelector(".view-btn");

    if (viewButton) viewButton.addEventListener("click", () => viewReceivedText(entry));

    const copyButton = row.querySelector(".copy-btn");

    if (copyButton) copyButton.addEventListener("click", () => copyReceivedText(entry));

    row.querySelector(".del-btn").addEventListener("click", async () => {
      try {
        await window.OpfsStore.deleteEntry(entry);
        toast(`Deleted ${entry.relativePath}`, "success");
        renderReceivedFiles();
      } catch (err) {
        log.error("Delete failed", err);
        toast(
          `Could not delete ${entry.relativePath}: ${err.message}`,
          "error",
        );
      }
    });

    return row;
  }

  function updateReceivedRow(row, entry) {
    row.dataset.fileKey = receivedFileKey(entry);

    const title = row.querySelector(".card-title");
    const sub = row.querySelector(".card-sub");

    const special = ["clipboard", "secret"].includes(entry.transferKind);
    const receivedTime = entry.receivedAt
      ? new Date(entry.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      : "";
    const kindLabel = entry.transferKind === "clipboard" ? "Clipboard" : "Secret";
    title.textContent = special
      ? `${entry.senderName || "Unknown device"} · ${kindLabel} · ${receivedTime}`
      : entry.relativePath;
    title.title = title.textContent;
    sub.textContent = special ? `${kindLabel} · ${formatBytes(entry.size)}` : formatBytes(entry.size);
  }

  const INCOMING_TERMINAL_STATUSES = new Set([
    "done",
    "rejected",
    "canceled",
    "error",
  ]);

  function isTransferSettled(transferId, tm) {
    if (!tm) return true;
    
    const job = tm.incoming.get(transferId);

    if (!job) return true;
    
    return INCOMING_TERMINAL_STATUSES.has(job.status);
  }

  function activeIncomingTransferIds(tm) {
    const ids = new Set();
    if (!tm) return ids;
    for (const [transferId, job] of tm.incoming.entries()) {
      if (!INCOMING_TERMINAL_STATUSES.has(job.status)) ids.add(transferId);
    }
    return ids;
  }

  async function renderReceivedFiles(tm) {
    const root = document.getElementById("received-files");
    const section = document.getElementById("received-files-section");
    const empty = document.getElementById("received-empty");
    const clearAllBtn = document.getElementById("clear-all-btn");
    const downloadAllBtn = document.getElementById("download-all-btn");

    let entries;

    try {
      entries = await window.OpfsStore.listAllReceived();
      entries = entries.filter((entry) =>
        isTransferSettled(entry.transferId, tm),
      );
    } catch (err) {
      log.error("Failed to list received files", err);
      root.replaceChildren();
      empty.style.display = "flex";
      section.style.display = "none";
      empty.querySelector("p").textContent =
        `Could not read local storage: ${err.message}`;
      clearAllBtn.hidden = true;
      clearAllBtn.style.display = "none";
      downloadAllBtn.hidden = true;
      downloadAllBtn.style.display = "none";
      return;
    }

    const hasEntries = entries.length > 0;
    section.style.display = hasEntries ? "" : "none";
    empty.style.display = hasEntries ? "none" : "flex";

    const shouldHideClearAll = entries.length < 2;
    clearAllBtn.hidden = shouldHideClearAll;
    clearAllBtn.style.display = shouldHideClearAll ? "none" : "";

    const downloadableEntries = entries.filter(
      (entry) => !["clipboard", "secret"].includes(entry.transferKind),
    );
    const shouldHideDownloadAll = isSafari() || downloadableEntries.length < 2;
    downloadAllBtn.hidden = shouldHideDownloadAll;
    downloadAllBtn.style.display = shouldHideDownloadAll ? "none" : "";

    const existingRows = new Map();
    for (const row of root.querySelectorAll(".received-row[data-file-key]")) {
      existingRows.set(row.dataset.fileKey, row);
    }

    const nextKeys = new Set();

    for (const entry of entries) {
      const key = receivedFileKey(entry);
      nextKeys.add(key);

      const existing = existingRows.get(key);
      if (existing) {
        updateReceivedRow(existing, entry);
        root.appendChild(existing);
        existingRows.delete(key);
        continue;
      }

      const row = createReceivedRow(entry);
      root.appendChild(row);
    }

    for (const leftover of existingRows.values()) {
      leftover.remove();
    }

    if (!hasEntries) {
      root.replaceChildren();
    }

    clearAllBtn.onclick = () =>
      withBusyButton(clearAllBtn, "Clearing…", async () => {
        try {
          await window.OpfsStore.clearAllReceived(
            activeIncomingTransferIds(tm),
          );
          toast("Cleared all received files", "success");
          await renderReceivedFiles(tm);
        } catch (err) {
          log.error("Failed clearing received files", err);
          toast(`Could not clear received files: ${err.message}`, "error");
        }
      });

    downloadAllBtn.onclick = () =>
      withBusyButton(downloadAllBtn, "Downloading…", async () => {
        log.info(`Downloading all ${downloadableEntries.length} received file(s)`);

        for (const entry of downloadableEntries) {
          await downloadEntry(entry);
        }
      });
  }

  async function withBusyButton(button, busyLabel, fn, { iconOnly = false } = {}) {
    if (button.dataset.busy === "true") return;

    button.dataset.busy = "true";
    button.disabled = true;

    const originalHtml = button.innerHTML;
    const originalTitle = button.title;

    button.innerHTML = iconOnly
      ? ICON.spinner
      : `${ICON.spinner}<span class="btn-label">${escapeHtml(busyLabel)}</span>`;
    if (iconOnly) button.title = busyLabel;

    try {
      await fn();
    } finally {
      button.innerHTML = originalHtml;
      button.title = originalTitle;
      button.disabled = false;
      delete button.dataset.busy;
    }
  }

  async function downloadEntry(entry) {
    try {
      const file = await window.OpfsStore.getFile(entry);
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");

      a.href = url;
      a.download = entry.name;
      document.body.appendChild(a);

      a.click();
      a.remove();

      setTimeout(() => URL.revokeObjectURL(url), 10000);
      log.info(`Downloading ${entry.relativePath}`);
    } catch (err) {
      log.error(`Failed to download ${entry.relativePath}`, err);
      toast(
        `Could not download ${entry.relativePath}: ${err.message}`,
        "error",
      );
    }
  }

  async function viewReceivedText(entry) {
    try {
      const file = await window.OpfsStore.getFile(entry);
      const dialog = document.getElementById("text-dialog");
      const isSecret = entry.transferKind === "secret";
      document.getElementById("text-dialog-title").textContent =
        isSecret ? "Received secret" : "Received clipboard";
      textDialogSecretValue = await file.text();
      textDialogSecretMasked = isSecret;
      document.getElementById("text-dialog-value").value = isSecret
        ? maskSecretText(textDialogSecretValue)
        : textDialogSecretValue;
      document.getElementById("text-dialog-copy").hidden = false;
      document.getElementById("text-dialog-submit").hidden = true;
      document.getElementById("text-dialog-toggle").hidden = !isSecret;
      document.getElementById("text-dialog-close").textContent = "Close";
      document.getElementById("text-dialog-value").readOnly = true;
      updateTextDialogToggle();
      dialog.dataset.mode = "view";
      dialog.showModal();
    } catch (err) {
      log.error("Could not open received text", err);
      toast(`Could not open text: ${err.message}`, "error");
    }
  }

  function maskSecretText(text) {
    return text.replace(/[^\r\n]/g, "•");
  }

  function updateTextDialogToggle() {
    const button = document.getElementById("text-dialog-toggle");
    const isVisible = !textDialogSecretMasked;
    button.querySelector(".visibility-toggle-icon").innerHTML =
      isVisible ? ICON.eyeOff : ICON.eye;
    button.querySelector(".visibility-toggle-state").textContent =
      isVisible ? "Visible" : "Hidden";
    button.classList.toggle("is-visible", isVisible);
    button.setAttribute("aria-checked", String(isVisible));
    button.setAttribute("aria-label", `Secret ${isVisible ? "visible" : "hidden"}`);
    button.title = `Secret ${isVisible ? "visible" : "hidden"}`;
  }

  async function copyReceivedText(entry) {
    try {
      const file = await window.OpfsStore.getFile(entry);
      await navigator.clipboard.writeText(await file.text());
      toast("Copied to clipboard", "success");
    } catch (err) {
      log.error("Could not copy received text", err);
      toast(`Could not copy text: ${err.message}`, "error");
    }
  }

  function promptSecret() {
    return new Promise((resolve) => {
      const dialog = document.getElementById("text-dialog");
      const form = document.getElementById("text-dialog-form");
      const value = document.getElementById("text-dialog-value");
      const copyButton = document.getElementById("text-dialog-copy");
      const closeButton = document.getElementById("text-dialog-close");
      document.getElementById("text-dialog-title").textContent = "Send secret";
      textDialogSecretValue = "";
      textDialogSecretMasked = true;
      value.value = "";
      value.readOnly = false;
      value.classList.add("secret-masked");
      copyButton.hidden = true;
      document.getElementById("text-dialog-submit").hidden = false;
      document.getElementById("text-dialog-toggle").hidden = false;
      closeButton.textContent = "Cancel";
      updateTextDialogToggle();
      dialog.dataset.mode = "send";
      dialog.showModal();
      value.focus();

      function finish(result) {
        form.removeEventListener("submit", onSubmit);
        dialog.removeEventListener("close", onClose);
        value.readOnly = true;
        value.classList.remove("secret-masked");
        textDialogSecretValue = "";
        textDialogSecretMasked = false;
        value.value = "";
        resolve(result);
      }
      function onSubmit(event) {
        event.preventDefault();
        const text = textDialogSecretValue;
        dialog.close();
        finish(text);
      }
      function onClose() {
        finish(null);
      }
      form.addEventListener("submit", onSubmit);
      dialog.addEventListener("close", onClose, { once: true });
    });
  }

  document.getElementById("text-dialog-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(textDialogSecretValue);
      toast("Copied to clipboard", "success");
    } catch (err) {
      toast(`Could not copy text: ${err.message}`, "error");
    }
  });
  document.getElementById("text-dialog-close").addEventListener("click", () => {
    document.getElementById("text-dialog").close();
  });
  document.getElementById("text-dialog-value").addEventListener("input", (event) => {
    if (document.getElementById("text-dialog").dataset.mode !== "send") return;
    textDialogSecretValue = event.currentTarget.value;
  });
  document.getElementById("text-dialog-toggle").addEventListener("click", () => {
    textDialogSecretMasked = !textDialogSecretMasked;
    const value = document.getElementById("text-dialog-value");
    if (document.getElementById("text-dialog").dataset.mode === "send") {
      value.classList.toggle("secret-masked", textDialogSecretMasked);
    } else {
      value.value = textDialogSecretMasked
        ? maskSecretText(textDialogSecretValue)
        : textDialogSecretValue;
    }
    updateTextDialogToggle();
    value.focus();
  });
  document.getElementById("text-dialog").addEventListener("close", () => {
    if (document.getElementById("text-dialog").dataset.mode !== "view") return;
    textDialogSecretValue = "";
    document.getElementById("text-dialog-value").value = "";
  });

  function isSafari() {
    return /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
  }

  window.UI = {
    formatBytes,
    initTheme,
    initTransportToggle,
    setTransportAvailability,
    setNetworkAvailability,
    initNavMenu,
    toast,
    renderDevices,
    initGlobalDropOverlay,
    renderIncomingRequests,
    renderActiveTransfers,
    renderReceivedFiles,
    escapeHtml,
    promptSecret,
    viewReceivedText,
  };
})();
