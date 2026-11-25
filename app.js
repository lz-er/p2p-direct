import { SafeRustWasmMesh } from "./wasm_client.js";
import {
  acquireProfileSlot,
  loadProfileState,
  randomBase64Url,
  saveProfileState,
  upsertKnownPeer,
} from "./storage.js";

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const BROADCAST_CHANNEL_NAME = "p2p-direct-signal-v1";
const KEEPALIVE_INTERVAL_MS = 4000;
const DISCONNECT_GRACE_MS = 6000;

const STRUCTURED_PRESETS = {
  event: {
    type: "event",
    payload: { action: "checkpoint", version: 1, ok: true },
  },
  task: {
    type: "task",
    payload: { id: "task-1", title: "Verify E2EE P2P backfill", status: "open", priority: 2 },
  },
  metric: {
    type: "metric",
    payload: { name: "mesh_latency_ms", value: 14.2, unit: "ms", tags: ["webrtc", "e2ee", "wasm"] },
  },
  state: {
    type: "state",
    payload: { key: "config.mode", value: "encrypted", updatedBy: "peer" },
  },
};

function randomId(prefix) {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTime(tsMs) {
  try {
    const d = new Date(tsMs);
    return d.toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(tsMs);
  }
}

function basePageUrl() {
  return `${window.location.origin}${window.location.pathname}${window.location.search}`;
}

function waitForIceGathering(pc, maxWaitMs = 1400) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let candidateTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (candidateTimer) clearTimeout(candidateTimer);
      pc.removeEventListener("icegatheringstatechange", onState);
      pc.removeEventListener("icecandidate", onCand);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === "complete") {
        finish();
      }
    };
    const onCand = (ev) => {
      if (!ev.candidate) {
        finish();
      } else if (!candidateTimer) {
        candidateTimer = setTimeout(finish, 600);
      }
    };
    const hardTimer = setTimeout(finish, maxWaitMs);
    pc.addEventListener("icegatheringstatechange", onState);
    pc.addEventListener("icecandidate", onCand);
  });
}

class P2PDirectApp {
  constructor() {
    this.wasm = null;
    this.profile = null;
    this.status = null;
    this.logMessages = [];
    this.rawJsonMode = false;
    this.telemetry = [];
    this.saveTimer = null;
    this.toastTimer = null;
    this.rejoinDismissed = false;

    // Out-of-band manual signaling state
    this.pendingOffers = new Map();
    this.pendingAnswers = new Map();
    this.latestOffer = null;
    this.latestAnswer = null;
    this.activeHandshake = null; // { kind: "offer"|"answer", code, url, inviteId }

    // Live WebRTC transport maps
    this.directPeers = new Map();
    this.relayPeers = new Map();
    this.earlyRelayIce = new Map();

    // Same-browser BroadcastChannel auto-rejoin & 1-click local discovery
    this.bc = null;
    this.discoveredLocalMeshes = new Map(); // peerId -> beacon
    this.localDialing = new Map(); // peerId -> { pc, dc, remoteDescSet, sdpSent, localIceQueue, pendingIce, startedAt }
    this.earlyLocalIce = new Map(); // peerId -> Array<candidate>

    // Background-resilient Web Worker keepalive
    this.keepaliveWorker = null;
    this.keepaliveFallbackTimer = null;
    this.keepaliveTickCount = 0;

    this.el = {};
  }

  bindElements() {
    const ids = [
      "author-name-input",
      "key-fp-display",
      "peer-id-display",
      "lamport-display",
      "mesh-status-chip",
      "mesh-status-dot",
      "peer-count-display",
      "log-count-display",
      "e2ee-mode-label",
      "e2ee-passphrase-input",
      "btn-apply-passphrase",
      "btn-clear-passphrase",
      "e2ee-bar-hint",
      "local-mesh-banner",
      "local-mesh-fp",
      "local-mesh-desc",
      "btn-join-local-mesh",
      "rejoin-banner",
      "rejoin-fp",
      "rejoin-desc",
      "btn-create-rejoin",
      "btn-dismiss-rejoin",
      "btn-create-invite",
      "handshake-card",
      "handshake-step-pill",
      "handshake-size-meta",
      "handshake-instruction",
      "btn-copy-handshake-url",
      "btn-copy-handshake-code",
      "btn-share-handshake",
      "handshake-code-output",
      "smart-signal-input",
      "btn-paste-clipboard",
      "btn-smart-connect",
      "connect-notice",
      "btn-sync-now",
      "topology-svg",
      "profile-slot-label",
      "auto-mesh-toggle",
      "auto-mesh-badge",
      "peer-list",
      "stat-e2ee",
      "stat-batches",
      "stat-gossip",
      "telemetry-log",
      "btn-toggle-raw",
      "btn-export-encrypted",
      "btn-export-log",
      "btn-clear-local-log",
      "log-search-input",
      "log-type-filter",
      "log-feed",
      "mode-btn-chat",
      "mode-btn-json",
      "next-lamport-preview",
      "chat-composer-form",
      "chat-text-input",
      "json-composer-form",
      "json-type-input",
      "json-payload-input",
      "composer-error",
      "toast",
    ];
    for (const id of ids) {
      this.el[id] = document.getElementById(id);
    }
  }

  bindEvents() {
    this.el["btn-apply-passphrase"].addEventListener("click", () => this.applyPassphrase());
    this.el["btn-clear-passphrase"].addEventListener("click", () => this.clearPassphrase());
    this.el["e2ee-passphrase-input"].addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.applyPassphrase();
      }
    });

    this.el["btn-join-local-mesh"].addEventListener("click", () => this.joinDiscoveredLocalMesh());
    this.el["btn-create-rejoin"].addEventListener("click", () => this.createManualInvite(true));
    this.el["btn-dismiss-rejoin"].addEventListener("click", () => {
      this.rejoinDismissed = true;
      this.renderConnectBanners();
    });

    this.el["btn-create-invite"].addEventListener("click", () => this.createManualInvite(false));
    this.el["btn-copy-handshake-url"].addEventListener("click", () => {
      if (this.activeHandshake) {
        const label =
          this.activeHandshake.kind === "offer"
            ? "Copied #offer= invite link"
            : "Copied #answer= reply link";
        this.copyText(this.activeHandshake.url, label);
      }
    });
    this.el["btn-copy-handshake-code"].addEventListener("click", () => {
      if (this.activeHandshake) {
        const label =
          this.activeHandshake.kind === "offer"
            ? "Copied P2P1: invite code"
            : "Copied P2P1: reply code";
        this.copyText(this.activeHandshake.code, label);
      }
    });
    this.el["btn-share-handshake"].addEventListener("click", async () => {
      if (!this.activeHandshake || typeof navigator.share !== "function") return;
      try {
        await navigator.share({
          title:
            this.activeHandshake.kind === "offer"
              ? "Join my E2EE p2p-direct mesh"
              : "p2p-direct E2EE reply link",
          url: this.activeHandshake.url,
        });
      } catch {
        // user canceled share sheet
      }
    });

    this.el["btn-smart-connect"].addEventListener("click", () =>
      this.handleSmartSignal(this.el["smart-signal-input"].value)
    );
    this.el["btn-paste-clipboard"].addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) {
          this.showNotice("connect-notice", "warn", "Clipboard is empty.");
          return;
        }
        this.el["smart-signal-input"].value = text.trim();
        await this.handleSmartSignal(text.trim());
      } catch {
        this.showNotice(
          "connect-notice",
          "warn",
          "Browser blocked direct clipboard read — paste into the box with Ctrl+V / Cmd+V."
        );
        this.el["smart-signal-input"].focus();
      }
    });
    this.el["smart-signal-input"].addEventListener("paste", () => {
      setTimeout(() => {
        const val = this.el["smart-signal-input"].value.trim();
        if (val.includes("P2P1:") || val.includes("#offer=") || val.includes("#answer=")) {
          this.handleSmartSignal(val);
        }
      }, 0);
    });

    this.el["author-name-input"].addEventListener("change", () => {
      const next = this.el["author-name-input"].value.trim();
      if (!next) {
        this.el["author-name-input"].value = this.status.authorName;
        return;
      }
      const res = this.wasm.call({ cmd: "set_profile", authorName: next });
      this.status = res.status;
      this.profile.authorName = next;
      this.schedulePersist();
      this.renderHeader();
      this.renderTopology();
      this.broadcastMeshBeacon(false);
      this.showToast(`Updated display name to ${next}`);
    });

    this.el["auto-mesh-toggle"].addEventListener("change", () => {
      const enabled = this.el["auto-mesh-toggle"].checked;
      const res = this.wasm.call({ cmd: "set_profile", autoMeshEnabled: enabled });
      this.status = res.status;
      this.profile.autoMeshEnabled = enabled;
      this.el["auto-mesh-badge"].textContent = enabled ? "ON" : "OFF";
      this.schedulePersist();
      this.addTelemetry("config", `Relayed auto-mesh ${enabled ? "enabled" : "disabled"}`);
    });

    this.el["btn-sync-now"].addEventListener("click", () => {
      const res = this.wasm.call({ cmd: "request_sync" });
      this.status = res.status;
      this.executeActions(res.actions);
      this.broadcastMeshBeacon(true);
      this.addTelemetry(
        "sync_inv",
        `Triggered E2EE anti-entropy sync across ${this.directPeers.size} peer(s)`
      );
      this.renderAll();
    });

    this.el["mode-btn-chat"].addEventListener("click", () => this.switchComposerMode("chat"));
    this.el["mode-btn-json"].addEventListener("click", () => this.switchComposerMode("json"));

    for (const btn of document.querySelectorAll(".preset-chip")) {
      btn.addEventListener("click", () => {
        const preset = STRUCTURED_PRESETS[btn.dataset.preset];
        if (preset) {
          this.el["json-type-input"].value = preset.type;
          this.el["json-payload-input"].value = JSON.stringify(preset.payload, null, 2);
          this.el["composer-error"].classList.add("hidden");
        }
      });
    }

    this.el["chat-composer-form"].addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = this.el["chat-text-input"].value.trim();
      if (!text) return;
      this.publishMessage("chat", { text });
      this.el["chat-text-input"].value = "";
    });

    this.el["json-composer-form"].addEventListener("submit", (ev) => {
      ev.preventDefault();
      const msgType = this.el["json-type-input"].value.trim();
      const rawPayload = this.el["json-payload-input"].value.trim();
      if (!msgType) {
        this.showComposerError("Message type must not be empty.");
        return;
      }
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(rawPayload);
      } catch (err) {
        this.showComposerError(`Invalid JSON payload: ${err.message}`);
        return;
      }
      this.el["composer-error"].classList.add("hidden");
      this.publishMessage(msgType, parsedPayload);
    });

    this.el["btn-toggle-raw"].addEventListener("click", () => {
      this.rawJsonMode = !this.rawJsonMode;
      this.el["btn-toggle-raw"].textContent = this.rawJsonMode ? "Card View" : "Raw JSON";
      this.renderLog();
    });

    this.el["btn-export-encrypted"].addEventListener("click", () => this.exportEncryptedBackup());
    this.el["btn-export-log"].addEventListener("click", () => this.exportDecryptedLog());
    this.el["btn-clear-local-log"].addEventListener("click", () => this.wipeLocalLog());

    this.el["log-search-input"].addEventListener("input", () => this.renderLog());
    this.el["log-type-filter"].addEventListener("change", () => this.renderLog());

    window.addEventListener("hashchange", () => this.handleUrlHashFragment());

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.wasm) {
        this.onForegroundResume();
      }
    });

    const teardownAll = () => {
      this.flushPersist();
      if (this.keepaliveWorker) {
        try {
          this.keepaliveWorker.terminate();
        } catch {
          // ignore
        }
      }
      for (const p of this.directPeers.values()) {
        try {
          p.dc.close();
          p.pc.close();
        } catch {
          // ignore
        }
      }
      if (this.bc) {
        try {
          this.bc.close();
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener("pagehide", teardownAll);
    window.addEventListener("beforeunload", teardownAll);
  }

  async init() {
    this.bindElements();
    this.bindEvents();

    const slot = await acquireProfileSlot();
    this.el["profile-slot-label"].textContent = `profile: ${slot}`;
    this.profile = await loadProfileState(slot);

    this.wasm = await SafeRustWasmMesh.loadFromUrl("./p2p_mesh.wasm");
    this.addTelemetry("wasm", "Loaded safe Rust WASM E2EE engine (X25519 + ChaCha20-Poly1305)");

    const initRes = this.wasm.call({
      cmd: "init",
      peerId: this.profile.peerId,
      authorName: this.profile.authorName,
      room: this.profile.room || "mesh-main",
      autoMeshEnabled: this.profile.autoMeshEnabled !== false,
      x25519Secret: this.profile.x25519Secret,
      meshKey: this.profile.meshKey,
      passphraseMode: Boolean(this.profile.passphraseMode),
      entropy: randomBase64Url(32),
    });
    this.status = initRes.status;

    const snap = this.profile.snapshot;
    const hasRecords =
      snap &&
      ((Array.isArray(snap.records) && snap.records.length > 0) ||
        (Array.isArray(snap.messages) && snap.messages.length > 0));
    if (hasRecords) {
      try {
        const imp = this.wasm.call({ cmd: "import_snapshot", snapshot: snap });
        this.status = imp.status;
        this.logMessages = imp.log;
        this.addTelemetry("e2ee", `Authenticated & decrypted ${imp.added} persisted log record(s)`);
      } catch (err) {
        this.addTelemetry("error", `Stored snapshot could not be decrypted: ${err.message}`);
        const state = this.wasm.call({ cmd: "get_state" });
        this.status = state.status;
        this.logMessages = state.log;
      }
    } else {
      const state = this.wasm.call({ cmd: "get_state" });
      this.status = state.status;
      this.logMessages = state.log;
    }

    this.el["author-name-input"].value = this.status.authorName;
    this.el["auto-mesh-toggle"].checked = this.status.autoMeshEnabled;
    this.el["auto-mesh-badge"].textContent = this.status.autoMeshEnabled ? "ON" : "OFF";

    this.setupBroadcastChannel();
    this.startKeepaliveWorker();
    this.renderAll();

    // Handle any #offer= or #answer= fragment present in the initial URL
    await this.handleUrlHashFragment();

    // Broadcast presence so reopened tabs on the same browser auto-rejoin immediately
    this.broadcastMeshBeacon(true);

    window.__p2pDirect = this;
  }

  /* ================= Background-Resilient Web Worker Keepalive ================= */

  startKeepaliveWorker() {
    const onTick = () => {
      if (!this.wasm) return;
      this.keepaliveTickCount += 1;
      const now = Date.now();

      if (this.directPeers.size > 0) {
        try {
          const pingRes = this.wasm.call({ cmd: "keepalive_ping", nowMs: now });
          this.status = pingRes.status;
          this.executeActions(pingRes.actions);
        } catch {
          // ignore
        }
      }

      // Every 4th worker tick (~16s), run anti-entropy sync & stale handshake cleanup
      if (this.keepaliveTickCount % 4 === 0) {
        try {
          const tickRes = this.wasm.call({
            cmd: "tick",
            nowMs: now,
            runSync: this.directPeers.size > 0,
          });
          this.status = tickRes.status;
          this.executeActions(tickRes.actions);
          this.cleanupStaleLocalDialing(now);
          this.renderStats();
        } catch {
          // ignore
        }
      }
    };

    try {
      const workerCode = `setInterval(() => postMessage("tick"), ${KEEPALIVE_INTERVAL_MS});`;
      const blob = new Blob([workerCode], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      worker.onmessage = onTick;
      worker.onerror = () => {
        try {
          worker.terminate();
        } catch {
          // ignore
        }
        this.keepaliveWorker = null;
        if (!this.keepaliveFallbackTimer) {
          this.keepaliveFallbackTimer = setInterval(onTick, KEEPALIVE_INTERVAL_MS);
        }
      };
      this.keepaliveWorker = worker;
      URL.revokeObjectURL(url);
      this.addTelemetry("keepalive", "Started background Web Worker E2EE keepalive (4s interval)");
    } catch {
      this.keepaliveFallbackTimer = setInterval(onTick, KEEPALIVE_INTERVAL_MS);
    }
  }

  onForegroundResume() {
    const now = Date.now();
    if (this.directPeers.size > 0) {
      try {
        const pingRes = this.wasm.call({ cmd: "keepalive_ping", nowMs: now });
        this.status = pingRes.status;
        this.executeActions(pingRes.actions);
        const syncRes = this.wasm.call({ cmd: "request_sync" });
        this.status = syncRes.status;
        this.executeActions(syncRes.actions);
        this.renderAll();
      } catch {
        // ignore
      }
    } else {
      this.broadcastMeshBeacon(true);
    }
  }

  cleanupStaleLocalDialing(now) {
    for (const [pid, entry] of this.localDialing.entries()) {
      if (now - entry.startedAt > 15_000) {
        try {
          entry.pc.close();
        } catch {
          // ignore
        }
        this.localDialing.delete(pid);
      }
    }
  }

  /* ================= Same-Browser BroadcastChannel Rejoin & Handoff ================= */

  setupBroadcastChannel() {
    if (typeof BroadcastChannel === "undefined") return;
    try {
      this.bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      this.bc.onmessage = (ev) => {
        if (!ev.data || !this.status) return;
        this.handleBroadcastMessage(ev.data);
      };
    } catch {
      this.bc = null;
    }
  }

  postBroadcast(msg) {
    if (!this.bc) return;
    try {
      this.bc.postMessage(msg);
    } catch {
      // ignore closed channel
    }
  }

  broadcastMeshBeacon(requestReply) {
    if (!this.bc || !this.status) return;
    this.postBroadcast({
      type: "mesh-beacon",
      peerId: this.status.peerId,
      authorName: this.status.authorName,
      pubKey: this.status.e2ee.publicKey,
      keyFingerprint: this.status.e2ee.keyFingerprint,
      passphraseMode: Boolean(this.status.e2ee.passphraseMode),
      peerCount: this.directPeers.size,
      logCount: this.logMessages.length,
      requestReply: Boolean(requestReply),
    });
  }

  async handleBroadcastMessage(msg) {
    if (!this.status || msg.peerId === this.status.peerId || msg.fromPeerId === this.status.peerId) {
      return;
    }
    if (msg.toPeerId && msg.toPeerId !== this.status.peerId) {
      return;
    }

    switch (msg.type) {
      case "mesh-beacon": {
        const myFp = this.status.e2ee.keyFingerprint;
        if (msg.requestReply) {
          this.broadcastMeshBeacon(false);
        }
        if (msg.keyFingerprint === myFp) {
          // Same E2EE mesh key! Auto-rejoin directly over WebRTC DataChannel with zero clicks!
          this.discoveredLocalMeshes.delete(msg.peerId);
          const existing = this.directPeers.get(msg.peerId);
          const isHealthy = existing && existing.dc && existing.dc.readyState === "open";
          if (!isHealthy && !this.localDialing.has(msg.peerId)) {
            if (this.status.peerId < msg.peerId) {
              this.startLocalAutoRejoinOffer(msg.peerId, msg.authorName, msg.pubKey);
            }
          }
        } else if (!msg.passphraseMode && this.directPeers.size === 0 && this.logMessages.length === 0) {
          // Brand-new tab sees an active local mesh -> offer 1-click Join button
          this.discoveredLocalMeshes.set(msg.peerId, msg);
          this.renderConnectBanners();
        }
        break;
      }

      case "local-offer": {
        if (msg.keyFingerprint !== this.status.e2ee.keyFingerprint) return;
        await this.acceptLocalAutoRejoinOffer(msg);
        break;
      }

      case "local-answer": {
        if (msg.keyFingerprint !== this.status.e2ee.keyFingerprint) return;
        await this.applyLocalAutoRejoinAnswer(msg);
        break;
      }

      case "local-ice": {
        if (msg.keyFingerprint !== this.status.e2ee.keyFingerprint) return;
        await this.applyLocalAutoRejoinIce(msg.fromPeerId, msg.candidate);
        break;
      }

      case "local-join-request": {
        // Only respond if not in passphrase-locked mode
        if (this.status.e2ee.passphraseMode) return;
        await this.handleLocalJoinRequest(msg.fromPeerId);
        break;
      }

      case "local-join-offer": {
        await this.handleLocalJoinOffer(msg.fromPeerId, msg.code);
        break;
      }

      case "deliver-answer": {
        // Cross-tab #answer= handoff (e.g., user clicked an #answer= link that opened in a new tab!)
        const hasPending =
          (msg.inviteId && this.pendingOffers.has(msg.inviteId)) ||
          (!msg.inviteId && this.pendingOffers.size === 1);
        if (hasPending) {
          const ok = await this.completeManualOffer(msg.code);
          if (ok) {
            this.postBroadcast({
              type: "answer-accepted",
              inviteId: msg.inviteId || "",
              fromPeerId: this.status.peerId,
              peerName: this.status.authorName,
              toPeerId: msg.fromPeerId || undefined,
            });
          }
        }
        break;
      }

      case "answer-accepted": {
        this.showNotice(
          "connect-notice",
          "success",
          `Reply delivered to ${msg.peerName || "your main mesh tab"}! Direct E2EE connection is opening — you can switch back or close this tab.`
        );
        this.showToast("Reply delivered automatically to your main tab");
        break;
      }

      default:
        break;
    }
  }

  async startLocalAutoRejoinOffer(targetPeerId, targetName, targetPubKey) {
    if (this.localDialing.has(targetPeerId)) return;
    try {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      const dc = pc.createDataChannel("p2p-mesh", { ordered: true });
      const early = this.earlyLocalIce.get(targetPeerId) || [];
      this.earlyLocalIce.delete(targetPeerId);
      const entry = {
        pc,
        dc,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        startedAt: Date.now(),
      };
      this.localDialing.set(targetPeerId, entry);
      this.attachDataChannel(pc, dc, targetPeerId, targetName, targetPubKey, false, null, true);

      const sendIce = (candJson) => {
        this.postBroadcast({
          type: "local-ice",
          fromPeerId: this.status.peerId,
          toPeerId: targetPeerId,
          keyFingerprint: this.status.e2ee.keyFingerprint,
          candidate: candJson,
        });
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const candJson = ev.candidate.toJSON();
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        sendIce(candJson);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.postBroadcast({
        type: "local-offer",
        fromPeerId: this.status.peerId,
        fromName: this.status.authorName,
        fromPubKey: this.status.e2ee.publicKey,
        toPeerId: targetPeerId,
        keyFingerprint: this.status.e2ee.keyFingerprint,
        sdp: offer.sdp,
      });

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }
      this.addTelemetry("rejoin", `Auto-rejoining ${targetName} (${targetPeerId}) over E2EE WebRTC`);
    } catch {
      this.localDialing.delete(targetPeerId);
    }
  }

  async acceptLocalAutoRejoinOffer(msg) {
    const prev = this.localDialing.get(msg.fromPeerId);
    if (prev) {
      try {
        prev.pc.close();
      } catch {
        // ignore
      }
      this.localDialing.delete(msg.fromPeerId);
    }
    try {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      const early = this.earlyLocalIce.get(msg.fromPeerId) || [];
      this.earlyLocalIce.delete(msg.fromPeerId);
      const entry = {
        pc,
        dc: null,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        startedAt: Date.now(),
      };
      this.localDialing.set(msg.fromPeerId, entry);

      pc.ondatachannel = (ev) => {
        entry.dc = ev.channel;
        this.attachDataChannel(
          pc,
          ev.channel,
          msg.fromPeerId,
          msg.fromName,
          msg.fromPubKey,
          false,
          null,
          true
        );
      };

      const sendIce = (candJson) => {
        this.postBroadcast({
          type: "local-ice",
          fromPeerId: this.status.peerId,
          toPeerId: msg.fromPeerId,
          keyFingerprint: this.status.e2ee.keyFingerprint,
          candidate: candJson,
        });
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const candJson = ev.candidate.toJSON();
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        sendIce(candJson);
      };

      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      entry.remoteDescSet = true;
      await this.flushPendingIce(entry);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.postBroadcast({
        type: "local-answer",
        fromPeerId: this.status.peerId,
        fromName: this.status.authorName,
        fromPubKey: this.status.e2ee.publicKey,
        toPeerId: msg.fromPeerId,
        keyFingerprint: this.status.e2ee.keyFingerprint,
        sdp: answer.sdp,
      });

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }
    } catch {
      this.localDialing.delete(msg.fromPeerId);
    }
  }

  async applyLocalAutoRejoinAnswer(msg) {
    const entry = this.localDialing.get(msg.fromPeerId);
    if (!entry) return;
    try {
      if (entry.pc.signalingState === "have-local-offer") {
        await entry.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        entry.remoteDescSet = true;
        await this.flushPendingIce(entry);
      }
    } catch {
      // ignore
    }
  }

  async applyLocalAutoRejoinIce(fromPeerId, candidate) {
    const entry = this.localDialing.get(fromPeerId);
    if (!entry) {
      const direct = this.directPeers.get(fromPeerId);
      if (direct && direct.pc) {
        try {
          await direct.pc.addIceCandidate(candidate);
        } catch {
          // ignore
        }
        return;
      }
      const list = this.earlyLocalIce.get(fromPeerId) || [];
      list.push(candidate);
      this.earlyLocalIce.set(fromPeerId, list);
      return;
    }
    if (!entry.remoteDescSet) {
      entry.pendingIce.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      // ignore
    }
  }

  joinDiscoveredLocalMesh() {
    const target = this.discoveredLocalMeshes.values().next().value;
    if (!target) return;
    this.el["btn-join-local-mesh"].disabled = true;
    this.showNotice(
      "connect-notice",
      "info",
      `Connecting directly (E2EE) to ${target.authorName}…`
    );
    this.postBroadcast({
      type: "local-join-request",
      fromPeerId: this.status.peerId,
      fromName: this.status.authorName,
      toPeerId: target.peerId,
    });
    setTimeout(() => {
      this.el["btn-join-local-mesh"].disabled = false;
    }, 3000);
  }

  async handleLocalJoinRequest(requesterPeerId) {
    try {
      const inviteId = randomId("inv");
      const pc = new RTCPeerConnection(ICE_CONFIG);
      const dc = pc.createDataChannel("p2p-mesh", { ordered: true });
      this.pendingOffers.set(inviteId, { inviteId, pc, dc, code: "", url: "" });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc, 1000);

      const encoded = this.wasm.call({
        cmd: "encode_signal",
        kind: "offer",
        inviteId,
        sdp: pc.localDescription.sdp,
        baseUrl: basePageUrl(),
        entropy: randomBase64Url(16),
      });
      this.postBroadcast({
        type: "local-join-offer",
        fromPeerId: this.status.peerId,
        toPeerId: requesterPeerId,
        code: encoded.code,
      });
    } catch {
      // ignore
    }
  }

  async handleLocalJoinOffer(fromPeerId, code) {
    const answerResult = await this.acceptManualOffer(code, /* silentUi = */ true);
    if (answerResult) {
      this.discoveredLocalMeshes.clear();
      this.postBroadcast({
        type: "deliver-answer",
        inviteId: answerResult.inviteId,
        code: answerResult.code,
        fromPeerId: this.status.peerId,
        toPeerId: fromPeerId,
      });
    }
  }

  /* ================= Passphrase & E2EE Key Controls ================= */

  applyPassphrase() {
    const pass = this.el["e2ee-passphrase-input"].value;
    if (!pass) {
      this.showToast("Enter a passphrase first, or click Auto for an automatic 256-bit key.");
      return;
    }
    try {
      const res = this.wasm.call({
        cmd: "set_passphrase",
        passphrase: pass,
        entropy: randomBase64Url(32),
      });
      this.status = res.status;
      this.profile.meshKey = res.meshKey;
      this.profile.passphraseMode = true;
      this.discoveredLocalMeshes.clear();
      this.flushPersist();
      this.renderAll();
      this.broadcastMeshBeacon(true);
      this.addTelemetry(
        "e2ee",
        `Derived 256-bit key via PBKDF2-HMAC-SHA256 (${this.status.e2ee.keyFingerprint}); P2P1 codes are passphrase-encrypted`
      );
      this.showToast(`Passphrase E2EE active · FP ${this.status.e2ee.keyFingerprint}`);
    } catch (err) {
      this.addTelemetry("error", `Passphrase error: ${err.message}`);
    }
  }

  clearPassphrase() {
    const freshKey = randomBase64Url(32);
    const res = this.wasm.call({
      cmd: "set_passphrase",
      passphrase: "",
      meshKey: freshKey,
      entropy: randomBase64Url(32),
    });
    this.el["e2ee-passphrase-input"].value = "";
    this.status = res.status;
    this.profile.meshKey = res.meshKey;
    this.profile.passphraseMode = false;
    this.flushPersist();
    this.renderAll();
    this.broadcastMeshBeacon(true);
    this.addTelemetry(
      "e2ee",
      `Switched to automatic 256-bit mesh key (${this.status.e2ee.keyFingerprint})`
    );
    this.showToast(`Auto 256-bit E2EE active · FP ${this.status.e2ee.keyFingerprint}`);
  }

  switchComposerMode(mode) {
    const isChat = mode === "chat";
    this.el["mode-btn-chat"].classList.toggle("active", isChat);
    this.el["mode-btn-chat"].setAttribute("aria-selected", String(isChat));
    this.el["mode-btn-json"].classList.toggle("active", !isChat);
    this.el["mode-btn-json"].setAttribute("aria-selected", String(!isChat));
    this.el["chat-composer-form"].classList.toggle("hidden", !isChat);
    this.el["json-composer-form"].classList.toggle("hidden", isChat);
    this.el["composer-error"].classList.add("hidden");
  }

  showNotice(id, kind, text) {
    const box = this.el[id];
    box.className = `inline-notice ${kind}`;
    box.textContent = text;
    box.classList.remove("hidden");
  }

  showComposerError(text) {
    this.el["composer-error"].textContent = text;
    this.el["composer-error"].classList.remove("hidden");
  }

  showToast(text) {
    const el = this.el["toast"];
    el.textContent = text;
    el.classList.add("visible");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove("visible"), 2800);
  }

  async copyText(text, toastMsg) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast(toastMsg);
    } catch {
      const tmp = document.createElement("textarea");
      tmp.value = text;
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand("copy");
      tmp.remove();
      this.showToast(toastMsg);
    }
  }

  addTelemetry(event, detail) {
    this.telemetry.unshift({ ts: formatTime(Date.now()), event, detail });
    if (this.telemetry.length > 80) {
      this.telemetry.length = 80;
    }
    this.renderTelemetry();
  }

  schedulePersist() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushPersist(), 120);
  }

  flushPersist() {
    if (!this.wasm || !this.profile) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const exp = this.wasm.call({ cmd: "export_snapshot" });
      this.profile.snapshot = exp.snapshot;
      this.profile.authorName = this.status.authorName;
      this.profile.autoMeshEnabled = this.status.autoMeshEnabled;
      this.profile.passphraseMode = Boolean(this.status.e2ee?.passphraseMode);
      saveProfileState(this.profile);
    } catch {
      // ignore persistence error
    }
  }

  publishMessage(msgType, payload) {
    try {
      const res = this.wasm.call({
        cmd: "publish",
        type: msgType,
        payload,
        ts: Date.now(),
        entropy: randomBase64Url(16),
      });
      this.status = res.status;
      this.executeActions(res.actions);
      this.refreshLogFromWasm();
      this.schedulePersist();
      this.renderAll();
    } catch (err) {
      this.showComposerError(err.message);
    }
  }

  refreshLogFromWasm() {
    const state = this.wasm.call({ cmd: "get_state" });
    this.status = state.status;
    this.logMessages = state.log;
  }

  wipeLocalLog() {
    const res = this.wasm.call({ cmd: "clear_log" });
    this.status = res.status;
    this.logMessages = res.log;
    this.flushPersist();
    this.addTelemetry(
      "storage",
      "Cleared local encrypted log; click Sync Now to backfill from peers"
    );
    this.renderAll();
    this.showToast("Local log cleared (surviving peers still hold encrypted history)");
  }

  exportEncryptedBackup() {
    const exp = this.wasm.call({ cmd: "export_snapshot" });
    const blob = new Blob([JSON.stringify(exp.snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `p2p-direct-e2ee-backup-${this.status.peerId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showToast(`Exported ${exp.snapshot.records.length} ChaCha20-Poly1305 encrypted record(s)`);
  }

  exportDecryptedLog() {
    const exp = this.wasm.call({ cmd: "export_decrypted" });
    const blob = new Blob([JSON.stringify(exp.snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `p2p-direct-log-${this.status.peerId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showToast(`Exported ${this.logMessages.length} decrypted log entries`);
  }

  showHandshakeCard(kind, code, url, sizeMeta, instruction, inviteId) {
    this.activeHandshake = { kind, code, url, inviteId };
    this.el["handshake-card"].classList.remove("hidden");
    this.el["handshake-step-pill"].textContent =
      kind === "offer" ? "Step 1 · Share Invite Link" : "Step 2 · Send Reply Link Back";
    this.el["handshake-size-meta"].textContent = sizeMeta;
    this.el["handshake-instruction"].textContent = instruction;
    this.el["btn-copy-handshake-url"].textContent =
      kind === "offer" ? "Copy #offer Link" : "Copy #answer Link";
    this.el["handshake-code-output"].value = code;
    this.el["btn-share-handshake"].classList.toggle("hidden", typeof navigator.share !== "function");
  }

  hideHandshakeCard() {
    this.activeHandshake = null;
    this.el["handshake-card"].classList.add("hidden");
  }

  /* ================= URL Fragments & Smart Auto-Detect Signal Handler ================= */

  async handleUrlHashFragment() {
    const hash = window.location.hash;
    if (!hash || hash.length < 4) return;
    try {
      const frag = this.wasm.call({ cmd: "extract_fragment", hash });
      if (!frag.found) return;

      // Clear consumed hash so refreshing or reopening this tab never re-processes a stale invite
      try {
        history.replaceState(null, "", basePageUrl());
      } catch {
        // ignore restricted history API
      }

      await this.handleSmartSignal(frag.code, /* fromHash = */ true);
    } catch (err) {
      this.addTelemetry("error", `Fragment parse failed: ${err.message}`);
    }
  }

  async handleSmartSignal(rawInput, fromHash = false) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      this.showNotice(
        "connect-notice",
        "warn",
        "Paste any P2P1: code or #offer= / #answer= link first."
      );
      return;
    }

    let decoded;
    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      decoded = this.wasm.call({
        cmd: "decode_signal",
        input: trimmed,
        passphrase: passInput || undefined,
      });
    } catch (err) {
      this.showNotice("connect-notice", "error", err.message);
      return;
    }

    const sig = decoded.signal;
    if (sig.kind === "offer") {
      await this.acceptManualOffer(trimmed);
    } else if (sig.kind === "answer") {
      const hasLocalPending =
        (sig.inviteId && this.pendingOffers.has(sig.inviteId)) ||
        this.pendingOffers.size === 1 ||
        (this.latestOffer && this.pendingOffers.has(this.latestOffer.inviteId));
      if (hasLocalPending) {
        await this.completeManualOffer(trimmed);
      } else if (this.bc) {
        // Forward #answer= link automatically to the original inviter tab in this browser!
        this.postBroadcast({
          type: "deliver-answer",
          inviteId: sig.inviteId || "",
          code: trimmed,
          fromPeerId: this.status.peerId,
        });
        this.showNotice(
          "connect-notice",
          "info",
          fromHash
            ? "Forwarding reply link to your original inviter tab…"
            : "No pending invite in this tab — forwarded reply to open tabs in this browser."
        );
      } else {
        this.showNotice(
          "connect-notice",
          "warn",
          "No matching pending invite in this tab. Paste this reply into the tab that generated the invite."
        );
      }
    }
  }

  /* ================= Manual Out-of-Band E2EE P2P1 Handshake ================= */

  async createManualInvite(isRejoin = false) {
    this.el["btn-create-invite"].disabled = true;
    this.latestOffer = null;
    this.showNotice("connect-notice", "info", "Gathering WebRTC ICE candidates…");
    try {
      const inviteId = randomId("inv");
      const pc = new RTCPeerConnection(ICE_CONFIG);
      const dc = pc.createDataChannel("p2p-mesh", { ordered: true });
      const pending = { inviteId, pc, dc, code: "", url: "" };
      this.pendingOffers.set(inviteId, pending);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc, 1400);

      const encoded = this.wasm.call({
        cmd: "encode_signal",
        kind: "offer",
        inviteId,
        sdp: pc.localDescription.sdp,
        baseUrl: basePageUrl(),
        entropy: randomBase64Url(16),
      });

      pending.code = encoded.code;
      pending.url = encoded.url;
      this.latestOffer = pending;

      const sizeMeta = `${encoded.rawBytes}B → ${encoded.codeChars} chars${encoded.encrypted ? " · AEAD" : ""}`;
      const instruction = encoded.encrypted
        ? "Send this passphrase-encrypted link to your peer. When they send back their #answer= link, simply open or paste it below."
        : isRejoin
          ? `Send this rejoin link to any surviving peer in your mesh (FP ${this.status.e2ee.keyFingerprint}). Open or paste their #answer= reply to reconnect and backfill.`
          : `Send this #offer= link to your peer (FP ${this.status.e2ee.keyFingerprint}). When they return an #answer= link, click it or paste it below.`;

      this.showHandshakeCard("offer", encoded.code, encoded.url, sizeMeta, instruction, inviteId);
      this.el["connect-notice"].classList.add("hidden");
      this.addTelemetry(
        "signal",
        `Generated ${isRejoin ? "rejoin " : ""}${encoded.encrypted ? "passphrase-encrypted " : ""}P2P1 offer ${inviteId} (${encoded.codeChars} chars)`
      );
    } catch (err) {
      this.showNotice("connect-notice", "error", `Failed to create invite: ${err.message}`);
    } finally {
      this.el["btn-create-invite"].disabled = false;
    }
  }

  async acceptManualOffer(rawInput, silentUi = false) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      if (!silentUi) {
        this.showNotice("connect-notice", "warn", "Paste a P2P1: invite code or #offer= link first.");
      }
      return null;
    }
    this.el["btn-smart-connect"].disabled = true;
    this.latestAnswer = null;
    if (!silentUi) {
      this.showNotice("connect-notice", "info", "Decoding P2P1 offer and gathering ICE candidates…");
    }
    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      const decoded = this.wasm.call({
        cmd: "decode_signal",
        input: trimmed,
        passphrase: passInput || undefined,
      });
      const sig = decoded.signal;
      if (sig.kind !== "offer") {
        throw new Error(`Expected an offer code, got '${sig.kind}'`);
      }
      if (sig.peerId === this.status.peerId) {
        throw new Error("Cannot connect a node to itself (open a second tab or device).");
      }

      // Adopt inviter's 256-bit mesh key only when different from our current key
      if (sig.meshKey && !sig.encrypted && sig.meshKey !== this.profile.meshKey) {
        const keyRes = this.wasm.call({
          cmd: "set_mesh_key",
          meshKey: sig.meshKey,
          passphraseMode: false,
          entropy: randomBase64Url(16),
        });
        this.status = keyRes.status;
        this.profile.meshKey = sig.meshKey;
        this.profile.passphraseMode = false;
        this.schedulePersist();
        this.renderHeader();
        this.addTelemetry(
          "e2ee",
          `Adopted inviter E2EE mesh key (FP ${this.status.e2ee.keyFingerprint})`
        );
      } else if (sig.encrypted && passInput && !this.status.e2ee.passphraseMode) {
        const passRes = this.wasm.call({
          cmd: "set_passphrase",
          passphrase: passInput,
          entropy: randomBase64Url(16),
        });
        this.status = passRes.status;
        this.profile.meshKey = passRes.meshKey;
        this.profile.passphraseMode = true;
        this.schedulePersist();
        this.renderHeader();
      }

      const pc = new RTCPeerConnection(ICE_CONFIG);
      pc.ondatachannel = (ev) => {
        this.attachDataChannel(
          pc,
          ev.channel,
          sig.peerId,
          sig.authorName,
          sig.pubKey,
          false,
          null,
          true
        );
      };

      await pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc, 1400);

      const encoded = this.wasm.call({
        cmd: "encode_signal",
        kind: "answer",
        inviteId: sig.inviteId || "",
        sdp: pc.localDescription.sdp,
        baseUrl: basePageUrl(),
        entropy: randomBase64Url(16),
      });

      const result = {
        code: encoded.code,
        url: encoded.url,
        peerId: sig.peerId,
        inviteId: sig.inviteId || "",
      };
      this.pendingAnswers.set(sig.peerId, { pc, ...result });
      this.latestAnswer = result;

      if (!silentUi) {
        const sizeMeta = `${encoded.rawBytes}B → ${encoded.codeChars} chars${encoded.encrypted ? " · AEAD" : ""}`;
        this.showHandshakeCard(
          "answer",
          encoded.code,
          encoded.url,
          sizeMeta,
          `Send this #answer= reply link back to ${sig.authorName}. Connection opens automatically once they open or paste it!`,
          sig.inviteId || ""
        );
        this.el["smart-signal-input"].value = "";
        this.el["connect-notice"].classList.add("hidden");
      }
      this.addTelemetry("signal", `Created E2EE P2P1 reply for ${sig.authorName} (${sig.peerId})`);
      return result;
    } catch (err) {
      if (!silentUi) {
        this.showNotice("connect-notice", "error", `Could not accept invite: ${err.message}`);
      }
      return null;
    } finally {
      this.el["btn-smart-connect"].disabled = false;
    }
  }

  async completeManualOffer(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      this.showNotice("connect-notice", "warn", "Paste the peer's P2P1: reply code or #answer= link first.");
      return false;
    }
    this.el["btn-smart-connect"].disabled = true;
    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      const decoded = this.wasm.call({
        cmd: "decode_signal",
        input: trimmed,
        passphrase: passInput || undefined,
      });
      const sig = decoded.signal;
      if (sig.kind !== "answer") {
        throw new Error(`Expected an answer code, got '${sig.kind}'`);
      }

      let pending = sig.inviteId ? this.pendingOffers.get(sig.inviteId) : null;
      if (!pending && this.pendingOffers.size === 1) {
        pending = this.pendingOffers.values().next().value;
      }
      if (!pending && this.latestOffer && this.pendingOffers.has(this.latestOffer.inviteId)) {
        pending = this.latestOffer;
      }
      if (!pending) {
        throw new Error("No matching pending invite found. Click Invite Peer first.");
      }

      this.pendingOffers.delete(pending.inviteId);
      if (this.latestOffer && this.latestOffer.inviteId === pending.inviteId) {
        this.latestOffer = null;
      }
      this.attachDataChannel(
        pending.pc,
        pending.dc,
        sig.peerId,
        sig.authorName,
        sig.pubKey,
        false,
        null,
        true
      );
      await pending.pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });

      this.el["smart-signal-input"].value = "";
      this.showNotice(
        "connect-notice",
        "info",
        `Opening direct E2EE WebRTC channel with ${sig.authorName} (${sig.peerId})…`
      );
      this.addTelemetry("signal", `Applied P2P1 answer from ${sig.authorName} (${sig.peerId})`);
      return true;
    } catch (err) {
      this.showNotice("connect-notice", "error", `Failed to complete connection: ${err.message}`);
      return false;
    } finally {
      this.el["btn-smart-connect"].disabled = false;
    }
  }

  /* ================= Direct E2EE DataChannel & Relayed Auto-Mesh ================= */

  attachDataChannel(
    pc,
    dc,
    peerId,
    authorName,
    peerPubKey,
    viaAutoMesh,
    introducedBy,
    replaceExisting = false
  ) {
    let closed = false;
    let disconnectTimer = null;

    const clearDisconnectTimer = () => {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
    };

    const peerEntry = {
      peerId,
      authorName: authorName || "Peer",
      peerPubKey,
      pc,
      dc,
      viaAutoMesh,
      introducedBy,
      lastActivityMs: Date.now(),
      superseded: false,
    };

    const handleOpen = () => {
      if (closed || peerEntry.superseded) return;
      const existing = this.directPeers.get(peerId);
      if (existing && existing.dc !== dc) {
        if (!replaceExisting && existing.dc && existing.dc.readyState === "open") {
          const recentlyActive = Date.now() - (existing.lastActivityMs || 0) < 12_000;
          if (recentlyActive) {
            try {
              dc.close();
              pc.close();
            } catch {
              // ignore
            }
            return;
          }
        }
        // Cleanly supersede stale/rejoining connection without emitting spurious disconnect!
        existing.superseded = true;
        try {
          existing.dc.onclose = null;
          existing.dc.onerror = null;
          existing.pc.onconnectionstatechange = null;
          existing.pc.oniceconnectionstatechange = null;
          existing.dc.close();
          existing.pc.close();
        } catch {
          // ignore
        }
      }

      peerEntry.lastActivityMs = Date.now();
      this.relayPeers.delete(peerId);
      this.earlyRelayIce.delete(peerId);
      this.localDialing.delete(peerId);
      this.earlyLocalIce.delete(peerId);
      this.pendingAnswers.delete(peerId);
      this.discoveredLocalMeshes.delete(peerId);
      this.directPeers.set(peerId, peerEntry);

      upsertKnownPeer(this.profile, { peerId, authorName: peerEntry.authorName, pubKey: peerPubKey });
      this.schedulePersist();

      const res = this.wasm.call({
        cmd: "peer_connected",
        peerId,
        authorName: peerEntry.authorName,
        peerPubKey,
        viaAutoMesh,
        introducedBy,
      });
      this.status = res.status;
      this.executeActions(res.actions);

      if (!viaAutoMesh) {
        this.hideHandshakeCard();
        this.showNotice(
          "connect-notice",
          "success",
          `Direct E2EE WebRTC channel open with ${peerEntry.authorName} (${peerId}).`
        );
      }
      this.renderAll();
      this.showToast(
        viaAutoMesh
          ? `Auto-meshed directly (E2EE) with ${peerEntry.authorName}`
          : `Connected (E2EE) to ${peerEntry.authorName}`
      );
    };

    const handleClose = () => {
      if (closed) return;
      closed = true;
      clearDisconnectTimer();
      try {
        dc.close();
        pc.close();
      } catch {
        // ignore
      }
      if (peerEntry.superseded) {
        return;
      }
      const current = this.directPeers.get(peerId);
      if (current && current.dc === dc) {
        this.directPeers.delete(peerId);
        const res = this.wasm.call({ cmd: "peer_disconnected", peerId });
        this.status = res.status;
        this.executeActions(res.actions);
        this.renderAll();
      }
      const rel = this.relayPeers.get(peerId);
      if (rel && rel.pc === pc) {
        this.relayPeers.delete(peerId);
      }
      const loc = this.localDialing.get(peerId);
      if (loc && loc.pc === pc) {
        this.localDialing.delete(peerId);
      }
    };

    const evaluateConnectionState = () => {
      if (closed || peerEntry.superseded) return;
      const cs = pc.connectionState;
      const ics = pc.iceConnectionState;
      if (cs === "failed" || cs === "closed" || ics === "failed" || ics === "closed") {
        handleClose();
      } else if (cs === "disconnected" || ics === "disconnected") {
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            disconnectTimer = null;
            if (closed || peerEntry.superseded) return;
            const healthyState =
              pc.connectionState === "connected" ||
              pc.iceConnectionState === "connected" ||
              pc.iceConnectionState === "completed";
            const recentEncryptedTraffic =
              Date.now() - peerEntry.lastActivityMs < DISCONNECT_GRACE_MS - 500;
            if (healthyState || recentEncryptedTraffic) {
              // Background keepalive ping/pong is still flowing — stay connected!
              if (!healthyState) {
                evaluateConnectionState();
              }
              return;
            }
            handleClose();
          }, DISCONNECT_GRACE_MS);
        }
      } else if (cs === "connected" || ics === "connected" || ics === "completed") {
        clearDisconnectTimer();
      }
    };

    dc.onmessage = (ev) => {
      if (typeof ev.data !== "string" || peerEntry.superseded) return;
      peerEntry.lastActivityMs = Date.now();
      try {
        const res = this.wasm.call({
          cmd: "wire_message",
          fromPeer: peerId,
          frame: ev.data,
          nowMs: Date.now(),
        });
        this.status = res.status;
        // Keep knownPeers name fresh after hello arrives
        const liveInfo = this.status.peers.find((p) => p.peerId === peerId);
        if (liveInfo && liveInfo.authorName && liveInfo.authorName !== peerEntry.authorName) {
          peerEntry.authorName = liveInfo.authorName;
          upsertKnownPeer(this.profile, {
            peerId,
            authorName: liveInfo.authorName,
            pubKey: peerPubKey,
          });
          this.schedulePersist();
        }
        this.executeActions(res.actions);
        this.renderAll();
      } catch (err) {
        this.addTelemetry("error", `E2EE wire rejection from ${peerId}: ${err.message}`);
        this.renderStats();
      }
    };

    dc.onclose = handleClose;
    dc.onerror = () => handleClose();
    pc.onconnectionstatechange = evaluateConnectionState;
    pc.oniceconnectionstatechange = evaluateConnectionState;

    if (dc.readyState === "open") {
      handleOpen();
    } else {
      dc.onopen = handleOpen;
    }
  }

  disconnectPeer(peerId) {
    const entry = this.directPeers.get(peerId);
    if (!entry) return;
    entry.superseded = true;
    this.directPeers.delete(peerId);
    try {
      entry.dc.close();
      entry.pc.close();
    } catch {
      // ignore
    }
    const res = this.wasm.call({ cmd: "peer_disconnected", peerId });
    this.status = res.status;
    this.executeActions(res.actions);
    this.renderAll();
    this.showToast(`Disconnected from ${entry.authorName || peerId}`);
  }

  executeActions(actions) {
    if (!Array.isArray(actions)) return;
    let logChanged = false;

    for (const act of actions) {
      switch (act.action) {
        case "send_wire": {
          const peer = this.directPeers.get(act.peerId);
          if (peer && peer.dc && peer.dc.readyState === "open") {
            try {
              peer.dc.send(act.frame);
            } catch (err) {
              this.addTelemetry("error", `Send failed to ${act.peerId}: ${err.message}`);
            }
          }
          break;
        }
        case "log_updated": {
          logChanged = true;
          break;
        }
        case "auto_mesh_create_offer": {
          this.startRelayedOffer(act.targetPeerId, act.targetName, act.targetPubKey, act.viaPeerId);
          break;
        }
        case "auto_mesh_accept_offer": {
          this.acceptRelayedOffer(
            act.fromPeerId,
            act.fromName,
            act.fromPubKey,
            act.viaPeerId,
            act.sdp
          );
          break;
        }
        case "auto_mesh_apply_answer": {
          this.applyRelayedAnswer(act.fromPeerId, act.sdp);
          break;
        }
        case "auto_mesh_add_ice": {
          this.applyRelayedIce(act.fromPeerId, act.candidate);
          break;
        }
        case "telemetry": {
          this.addTelemetry(act.event, act.detail);
          break;
        }
        default:
          break;
      }
    }

    if (logChanged) {
      this.refreshLogFromWasm();
      this.schedulePersist();
    }
  }

  _sendLocalIce(targetPeerId, viaPeerId, candidateJson) {
    try {
      const res = this.wasm.call({
        cmd: "send_relay_signal",
        toPeerId: targetPeerId,
        signalType: "ice",
        candidate: candidateJson,
        viaPeerId,
      });
      this.status = res.status;
      this.executeActions(res.actions);
    } catch {
      // ignore if relay closed
    }
  }

  async startRelayedOffer(targetPeerId, targetName, targetPubKey, viaPeerId) {
    if (this.directPeers.has(targetPeerId) || this.relayPeers.has(targetPeerId)) {
      return;
    }
    try {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      const dc = pc.createDataChannel("p2p-mesh", { ordered: true });
      const early = this.earlyRelayIce.get(targetPeerId) || [];
      this.earlyRelayIce.delete(targetPeerId);
      const entry = {
        peerId: targetPeerId,
        authorName: targetName || "Peer",
        peerPubKey: targetPubKey,
        viaPeerId,
        pc,
        dc,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
      };
      this.relayPeers.set(targetPeerId, entry);
      this.attachDataChannel(pc, dc, targetPeerId, targetName, targetPubKey, true, viaPeerId, false);

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const candJson = ev.candidate.toJSON();
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        this._sendLocalIce(targetPeerId, viaPeerId, candJson);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const res = this.wasm.call({
        cmd: "send_relay_signal",
        toPeerId: targetPeerId,
        signalType: "offer",
        sdp: offer.sdp,
        viaPeerId,
      });
      this.status = res.status;
      this.executeActions(res.actions);

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        this._sendLocalIce(targetPeerId, viaPeerId, entry.localIceQueue.shift());
      }
      this.renderAll();
    } catch (err) {
      this.relayPeers.delete(targetPeerId);
      this.addTelemetry("error", `Auto-mesh offer to ${targetPeerId} failed: ${err.message}`);
    }
  }

  async acceptRelayedOffer(fromPeerId, fromName, fromPubKey, viaPeerId, sdp) {
    if (this.directPeers.has(fromPeerId)) return;
    const prev = this.relayPeers.get(fromPeerId);
    if (prev) {
      try {
        prev.pc.close();
      } catch {
        // ignore
      }
      this.relayPeers.delete(fromPeerId);
    }

    try {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      const early = this.earlyRelayIce.get(fromPeerId) || [];
      this.earlyRelayIce.delete(fromPeerId);
      const entry = {
        peerId: fromPeerId,
        authorName: fromName || "Peer",
        peerPubKey: fromPubKey,
        viaPeerId,
        pc,
        dc: null,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
      };
      this.relayPeers.set(fromPeerId, entry);

      pc.ondatachannel = (ev) => {
        entry.dc = ev.channel;
        this.attachDataChannel(
          pc,
          ev.channel,
          fromPeerId,
          fromName,
          fromPubKey,
          true,
          viaPeerId,
          false
        );
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const candJson = ev.candidate.toJSON();
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        this._sendLocalIce(fromPeerId, viaPeerId, candJson);
      };

      await pc.setRemoteDescription({ type: "offer", sdp });
      entry.remoteDescSet = true;
      await this.flushPendingIce(entry);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      const res = this.wasm.call({
        cmd: "send_relay_signal",
        toPeerId: fromPeerId,
        signalType: "answer",
        sdp: answer.sdp,
        viaPeerId,
      });
      this.status = res.status;
      this.executeActions(res.actions);

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        this._sendLocalIce(fromPeerId, viaPeerId, entry.localIceQueue.shift());
      }
      this.renderAll();
    } catch (err) {
      this.relayPeers.delete(fromPeerId);
      this.addTelemetry("error", `Auto-mesh answer for ${fromPeerId} failed: ${err.message}`);
    }
  }

  async applyRelayedAnswer(fromPeerId, sdp) {
    const entry = this.relayPeers.get(fromPeerId);
    if (!entry) return;
    try {
      if (entry.pc.signalingState === "have-local-offer") {
        await entry.pc.setRemoteDescription({ type: "answer", sdp });
        entry.remoteDescSet = true;
        await this.flushPendingIce(entry);
      }
    } catch (err) {
      this.addTelemetry("error", `Auto-mesh apply answer from ${fromPeerId} failed: ${err.message}`);
    }
  }

  async applyRelayedIce(fromPeerId, candidate) {
    const entry = this.relayPeers.get(fromPeerId);
    if (!entry) {
      const direct = this.directPeers.get(fromPeerId);
      if (direct && direct.pc) {
        try {
          await direct.pc.addIceCandidate(candidate);
        } catch {
          // ignore late ICE
        }
        return;
      }
      const list = this.earlyRelayIce.get(fromPeerId) || [];
      list.push(candidate);
      this.earlyRelayIce.set(fromPeerId, list);
      return;
    }
    if (!entry.remoteDescSet) {
      entry.pendingIce.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      // ignore benign ICE error
    }
  }

  async flushPendingIce(entry) {
    while (entry.pendingIce.length > 0) {
      const cand = entry.pendingIce.shift();
      try {
        await entry.pc.addIceCandidate(cand);
      } catch {
        // ignore
      }
    }
  }

  /* ================= Rendering ================= */

  renderAll() {
    this.renderHeader();
    this.renderConnectBanners();
    this.renderPeers();
    this.renderTopology();
    this.renderStats();
    this.renderTypeFilterOptions();
    this.renderLog();
  }

  renderHeader() {
    if (!this.status) return;
    this.el["peer-id-display"].textContent = this.status.peerId;
    this.el["lamport-display"].textContent = String(this.status.lamport);
    this.el["peer-count-display"].textContent = String(this.status.peers.length);
    this.el["log-count-display"].textContent = String(this.status.logCount);
    this.el["next-lamport-preview"].textContent = `next lamport: ${this.status.lamport + 1}`;

    if (this.status.e2ee) {
      const shortFp = this.status.e2ee.keyFingerprint.slice(0, 9);
      this.el["key-fp-display"].textContent = shortFp;
      this.el["key-fp-display"].parentElement.title =
        `E2EE ${this.status.e2ee.cipher} · Full Key Fingerprint: ${this.status.e2ee.keyFingerprint}`;
      this.el["e2ee-mode-label"].textContent = this.status.e2ee.passphraseMode
        ? `Passphrase · ${shortFp}`
        : `Auto 256-bit · ${shortFp}`;
    }

    const isOnline = this.status.peers.length > 0;
    this.el["mesh-status-chip"].classList.toggle("live", isOnline);
    this.el["mesh-status-dot"].classList.toggle("online", isOnline);
  }

  renderConnectBanners() {
    if (!this.status) return;

    // 1. Local browser active mesh quick-join banner
    const localTarget =
      this.directPeers.size === 0 && this.logMessages.length === 0
        ? this.discoveredLocalMeshes.values().next().value
        : null;
    if (localTarget) {
      this.el["local-mesh-banner"].classList.remove("hidden");
      this.el["local-mesh-fp"].textContent = `FP ${localTarget.keyFingerprint.slice(0, 9)}`;
      this.el["local-mesh-desc"].textContent =
        `${localTarget.authorName} is open in another tab (${localTarget.logCount} log entries). Connect directly over E2EE WebRTC with 1 click.`;
      this.el["btn-join-local-mesh"].textContent = `Join ${localTarget.authorName}'s Mesh`;
    } else {
      this.el["local-mesh-banner"].classList.add("hidden");
    }

    // 2. Rejoin previous mesh banner (for cross-device tab reopen when disconnected)
    const known = this.profile?.knownPeers || [];
    const showRejoin =
      !this.rejoinDismissed &&
      this.directPeers.size === 0 &&
      known.length > 0 &&
      !localTarget &&
      !this.activeHandshake;
    if (showRejoin) {
      const names = known
        .slice(0, 3)
        .map((p) => p.authorName || p.peerId)
        .join(", ");
      const extra = known.length > 3 ? ` +${known.length - 3} more` : "";
      this.el["rejoin-banner"].classList.remove("hidden");
      this.el["rejoin-fp"].textContent = `FP ${this.status.e2ee.keyFingerprint.slice(0, 9)}`;
      this.el["rejoin-desc"].textContent =
        `Previously meshed with ${names}${extra}. Open tabs on this browser rejoin automatically; for peers on another device, share a Rejoin Link or paste their invite.`;
    } else {
      this.el["rejoin-banner"].classList.add("hidden");
    }
  }

  renderStats() {
    if (!this.status?.stats) return;
    const s = this.status.stats;
    this.el["stat-e2ee"].textContent = `${s.e2eeFramesEncrypted} / ${s.e2eeFramesDecrypted}`;
    this.el["stat-batches"].textContent = `${s.syncBatchesSent} / ${s.syncBatchesReceived}`;
    this.el["stat-gossip"].textContent = `${s.gossipForwards} / ${s.gossipDuplicatesDropped}`;
  }

  renderPeers() {
    if (!this.status) return;
    const list = this.el["peer-list"];
    const direct = this.status.peers || [];
    const pending = this.status.pendingAutoMesh || [];

    if (direct.length === 0 && pending.length === 0) {
      list.innerHTML =
        '<li class="empty-state">No direct peers yet. Click Invite Peer or paste a <code>P2P1:</code> / <code>#offer=</code> link above.</li>';
      return;
    }

    const parts = [];
    for (const p of direct) {
      const originBadge = p.viaAutoMesh
        ? `<span class="badge auto" title="Auto-introduced via ${escapeHtml(p.introducedBy || "mesh")}">auto-mesh</span>`
        : '<span class="badge">direct</span>';
      const rttLabel = typeof p.rttMs === "number" ? ` · ${p.rttMs}ms` : "";
      parts.push(`
        <li class="peer-item" data-peer-id="${escapeHtml(p.peerId)}">
          <div class="peer-main">
            <div class="peer-name">${escapeHtml(p.authorName)} ${originBadge}</div>
            <div class="peer-id">${escapeHtml(p.peerId)} · safety ${escapeHtml(p.safetyCode || "—")}${rttLabel} · synced ${p.knownCount}</div>
          </div>
          <button type="button" class="btn btn-sm btn-danger" data-disconnect="${escapeHtml(p.peerId)}">Drop</button>
        </li>
      `);
    }

    for (const pend of pending) {
      parts.push(`
        <li class="peer-item">
          <div class="peer-main">
            <div class="peer-name">${escapeHtml(pend.authorName)} <span class="badge pending">E2EE relay via ${escapeHtml(pend.viaPeerId)}</span></div>
            <div class="peer-id">${escapeHtml(pend.peerId)}</div>
          </div>
        </li>
      `);
    }

    list.innerHTML = parts.join("");
    for (const btn of list.querySelectorAll("[data-disconnect]")) {
      btn.addEventListener("click", () => this.disconnectPeer(btn.dataset.disconnect));
    }
  }

  renderTopology() {
    if (!this.status) return;
    const svg = this.el["topology-svg"];
    const direct = this.status.peers || [];
    const pending = this.status.pendingAutoMesh || [];

    const nodes = [
      { id: this.status.peerId, label: `${this.status.authorName} (you)`, kind: "self" },
    ];
    const nodeMap = new Map();
    nodeMap.set(this.status.peerId, nodes[0]);

    for (const p of direct) {
      const n = {
        id: p.peerId,
        label: p.authorName,
        kind: p.viaAutoMesh ? "auto" : "direct",
      };
      nodes.push(n);
      nodeMap.set(p.peerId, n);
    }
    for (const p of pending) {
      if (!nodeMap.has(p.peerId)) {
        const n = { id: p.peerId, label: p.authorName, kind: "pending" };
        nodes.push(n);
        nodeMap.set(p.peerId, n);
      }
    }

    const cx = 170;
    const cy = 85;
    const rx = 112;
    const ry = 56;
    if (nodes.length === 1) {
      nodes[0].x = cx;
      nodes[0].y = cy;
    } else {
      for (let i = 0; i < nodes.length; i++) {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / nodes.length;
        nodes[i].x = cx + rx * Math.cos(angle);
        nodes[i].y = cy + ry * Math.sin(angle);
      }
    }

    const edgeSet = new Set();
    const lines = [];
    const addEdge = (aId, bId, style) => {
      const a = nodeMap.get(aId);
      const b = nodeMap.get(bId);
      if (!a || !b || aId === bId) return;
      const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      if (style === "pending") {
        lines.push(
          `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#b45309" stroke-width="1.6" stroke-dasharray="4 4" />`
        );
      } else if (style === "remote") {
        lines.push(
          `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#8fb8b1" stroke-width="1.5" />`
        );
      } else {
        lines.push(
          `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#0f766e" stroke-width="2.1" />`
        );
      }
    };

    for (const p of direct) {
      addEdge(this.status.peerId, p.peerId, "direct");
      for (const rp of p.remotePeers || []) {
        if (nodeMap.has(rp.peerId)) {
          addEdge(p.peerId, rp.peerId, "remote");
        }
      }
    }
    for (const pend of pending) {
      addEdge(this.status.peerId, pend.peerId, "pending");
      addEdge(pend.viaPeerId, pend.peerId, "remote");
    }

    const circles = nodes.map((n) => {
      const fill =
        n.kind === "self" ? "#17191c" : n.kind === "pending" ? "#b45309" : "#0f766e";
      const r = n.kind === "self" ? 9 : 7.5;
      const shortLabel = n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label;
      const labelY = n.y > cy ? n.y + 18 : n.y - 12;
      return `
        <g>
          <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${r}" fill="${fill}" stroke="#ffffff" stroke-width="2" />
          <text x="${n.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#17191c">${escapeHtml(shortLabel)}</text>
        </g>
      `;
    });

    svg.innerHTML = `${lines.join("")}${circles.join("")}`;
  }

  renderTelemetry() {
    const box = this.el["telemetry-log"];
    if (this.telemetry.length === 0) return;
    box.innerHTML = this.telemetry
      .map((item) => {
        let cls = "telemetry-entry";
        if (
          item.event.startsWith("auto_mesh") ||
          item.event === "peer_connected" ||
          item.event === "e2ee" ||
          item.event === "rejoin"
        ) {
          cls += " event-auto";
        } else if (item.event.startsWith("sync") || item.event === "hello" || item.event === "keepalive") {
          cls += " event-sync";
        } else if (item.event === "error") {
          cls += " event-err";
        }
        return `<div class="${cls}">[${escapeHtml(item.ts)}] <strong>${escapeHtml(item.event)}</strong> ${escapeHtml(item.detail)}</div>`;
      })
      .join("");
  }

  renderTypeFilterOptions() {
    const select = this.el["log-type-filter"];
    const current = select.value;
    const types = Array.from(new Set(this.logMessages.map((m) => m.type))).sort();
    const opts = ['<option value="">All types</option>'];
    for (const t of types) {
      opts.push(`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`);
    }
    select.innerHTML = opts.join("");
    if (types.includes(current)) {
      select.value = current;
    }
  }

  renderLog() {
    const feed = this.el["log-feed"];
    const query = this.el["log-search-input"].value.trim().toLowerCase();
    const typeFilter = this.el["log-type-filter"].value;

    const filtered = this.logMessages.filter((m) => {
      if (typeFilter && m.type !== typeFilter) return false;
      if (!query) return true;
      return JSON.stringify(m).toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
      feed.innerHTML =
        this.logMessages.length === 0
          ? '<div class="empty-state">Replicated log is empty. Publish a message below — every entry is AEAD-encrypted with ChaCha20-Poly1305 in IndexedDB and on the wire, staying alive as long as at least one peer remains in the network.</div>'
          : '<div class="empty-state">No log entries match your current filter.</div>';
      return;
    }

    if (this.rawJsonMode) {
      const jsonl = filtered.map((m) => JSON.stringify(m)).join("\n");
      feed.innerHTML = `<pre class="raw-jsonl-view">${escapeHtml(jsonl)}</pre>`;
      return;
    }

    const myId = this.status?.peerId;
    feed.innerHTML = filtered
      .map((m) => {
        const isSelf = m.author === myId;
        const isChat = m.type === "chat" && m.payload && typeof m.payload.text === "string";
        const bodyHtml = isChat
          ? `<div class="log-text-body">${escapeHtml(m.payload.text)}</div>`
          : `<pre class="log-json-pre">${escapeHtml(JSON.stringify(m.payload, null, 2))}</pre>`;
        return `
          <article class="log-entry${isSelf ? " is-self" : ""}" data-msg-id="${escapeHtml(m.id)}">
            <div class="log-entry-head">
              <div class="log-author-group">
                <span class="log-author">${escapeHtml(m.authorName)}</span>
                <span class="log-type-tag${isChat ? " type-chat" : ""}">${escapeHtml(m.type)}</span>
                <span class="peer-id">${escapeHtml(m.author)}</span>
              </div>
              <span class="log-order-tuple" title="Deterministic sort tuple (lamport, ts, id)">
                L:${m.lamport} · ${escapeHtml(formatTime(m.ts))} · ${escapeHtml(m.id)}
              </span>
            </div>
            ${bodyHtml}
          </article>
        `;
      })
      .join("");

    feed.scrollTop = feed.scrollHeight;
  }
}

const app = new P2PDirectApp();
app.init().catch((err) => {
  const box = document.getElementById("telemetry-log");
  if (box) {
    box.innerHTML = `<div class="telemetry-entry event-err">Initialization error: ${escapeHtml(err.message)}</div>`;
  }
  console.error(err);
});
