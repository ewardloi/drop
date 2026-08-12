(function () {
  "use strict";

  const log = window.Log.ui;

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

  function applyTransportMode(mode, tm) {
    document.getElementById("transport-icon-relay").style.display =
      mode === "webrtc" ? "none" : "";
    document.getElementById("transport-icon-p2p").style.display =
      mode === "webrtc" ? "" : "none";
    document.getElementById("transport-label").textContent =
      mode === "webrtc" ? "P2P" : "Relay";
    document.getElementById("transport-toggle").title =
      mode === "webrtc"
        ? "Using direct P2P (WebRTC) when possible"
        : "Using the relay server";

    for (const item of document.querySelectorAll(
      "#transport-menu .dropdown-item",
    )) {
      item.classList.toggle(
        "selected",
        item.dataset.transportMode === mode,
      );
    }

    localStorage.setItem(TRANSPORT_KEY, mode);

    if (tm) tm.webrtcEnabled = mode === "webrtc";

    log.info(`Transfer mode set to ${mode}`);
  }

  function initTransportToggle(tm) {
    const saved = localStorage.getItem(TRANSPORT_KEY) ?? "webrtc";

    applyTransportMode(saved, tm);

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
      if (menu.hidden) openMenu();
      else closeMenu();
    });

    for (const item of menu.querySelectorAll(".dropdown-item")) {
      item.addEventListener("click", () => {
        applyTransportMode(item.dataset.transportMode, tm);
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

  function toast(message, kind) {
    const root = document.getElementById("toast-root");
    const node = el(`<div class="toast ${kind || ""}">${message}</div>`);

    root.appendChild(node);
    log[kind === "error" ? "error" : "info"]("Toast:", message);

    setTimeout(() => node.remove(), 5000);
  }

  function renderDevices(peers, onPick, selfCanUpload) {
    const grid = document.getElementById("devices-grid");
    const empty = document.getElementById("devices-empty");
    const count = document.getElementById("peer-count");

    count.textContent = `${peers.length} online`;
    grid.innerHTML = "";
    empty.style.display = peers.length === 0 ? "flex" : "none";

    for (const peer of peers) {
      const canUpload = peer.canUpload !== false;
      const mode = canUpload && selfCanUpload ? "local" : "remote";

      const card = el(`
        <div class="device-card ${canUpload ? "" : "download-only"} ${selfCanUpload ? "" : "upload-disabled"}" role="listitem" data-id="${peer.id}" title="${selfCanUpload ? "Click to send files, Shift+Click to send a folder, or drag files here" : "You are on a public network and can only receive files"}">
          <span class="status-dot pulse"></span>
          <div class="device-avatar">${ICON.laptop}</div>
          <div class="device-card-name">${escapeHtml(peer.name)}</div>
          <div class="device-card-mode">${mode}</div>
        </div>
      `);

      card.addEventListener("click", (e) => {
        if (!selfCanUpload) {
          toast(
            "You are outside the local network, so you can only receive files.",
            "error",
          );
          return;
        }
        onPick(peer, e.shiftKey ? "folder" : "files");
      });

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
    const row = el(`
      <div class="card received-row" data-file-key="${receivedFileKey(entry)}">
        <div class="card-row">
          <div class="card-icon">${ICON.doc}</div>
          <div style="min-width:0; flex:1;">
            <div class="card-title">${escapeHtml(entry.relativePath)}</div>
            <div class="card-sub">${formatBytes(entry.size)}</div>
          </div>
          <div class="card-actions">
            <button class="btn-secondary icon-only dl-btn" title="Download">${ICON.download}</button>
            <button class="btn-danger icon-only del-btn" title="Delete">${ICON.trash}</button>
          </div>
        </div>
      </div>
    `);

    row.querySelector(".dl-btn").addEventListener("click", (e) => {
      withBusyButton(e.currentTarget, "Downloading…", () => downloadEntry(entry), {
        iconOnly: true,
      });
    });
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

    title.textContent = entry.relativePath;
    title.title = entry.relativePath;
    sub.textContent = formatBytes(entry.size);
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

    const shouldHideDownloadAll = isSafari() || entries.length < 2;
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
        log.info(`Downloading all ${entries.length} received file(s)`);

        for (const entry of entries) {
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

  function isSafari() {
    return /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
  }

  window.UI = {
    formatBytes,
    initTheme,
    initTransportToggle,
    initNavMenu,
    toast,
    renderDevices,
    initGlobalDropOverlay,
    renderIncomingRequests,
    renderActiveTransfers,
    renderReceivedFiles,
    escapeHtml,
  };
})();
