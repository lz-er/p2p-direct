import { SafeRustWasmMesh } from "./wasm_client.js";
import {
  acquireProfileSlot,
  loadProfileState,
  randomBase64Url,
  saveProfileState,
} from "./storage.js";

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

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

function waitForIceGathering(pc, maxWaitMs = 2000) {
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
        candidateTimer = setTimeout(finish, 900);
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

    // Out-of-band manual signaling state
    this.pendingOffers = new Map();
    this.pendingAnswers = new Map();
    this.latestOffer = null;
    this.latestAnswer = null;

    // Live WebRTC transport maps
    this.directPeers = new Map();
    this.relayPeers = new Map();
    this.earlyRelayIce = new Map();

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
      "tab-btn-invite",
      "tab-btn-join",
      "tab-pane-invite",
      "tab-pane-join",
      "btn-create-invite",
      "btn-copy-offer-code",
      "btn-copy-offer-url",
      "offer-code-output",
      "offer-size-meta",
      "answer-code-input",
      "btn-accept-answer",
      "invite-notice",
      "offer-code-input",
      "btn-create-answer",
      "answer-code-output",
      "answer-size-meta",
      "btn-copy-answer-code",
      "btn-copy-answer-url",
      "join-notice",
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
    this.el["tab-btn-invite"].addEventListener("click", () => this.switchConnectTab("invite"));
    this.el["tab-btn-join"].addEventListener("click", () => this.switchConnectTab("join"));

    this.el["btn-apply-passphrase"].addEventListener("click", () => this.applyPassphrase());
    this.el["btn-clear-passphrase"].addEventListener("click", () => this.clearPassphrase());
    this.el["e2ee-passphrase-input"].addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.applyPassphrase();
      }
    });

    this.el["btn-create-invite"].addEventListener("click", () => this.createManualInvite());
    this.el["btn-copy-offer-code"].addEventListener("click", () => {
      if (this.latestOffer) this.copyText(this.latestOffer.code, "Copied P2P1: offer code");
    });
    this.el["btn-copy-offer-url"].addEventListener("click", () => {
      if (this.latestOffer) this.copyText(this.latestOffer.url, "Copied #offer= invite link");
    });
    this.el["btn-accept-answer"].addEventListener("click", () =>
      this.completeManualOffer(this.el["answer-code-input"].value)
    );

    this.el["btn-create-answer"].addEventListener("click", () =>
      this.acceptManualOffer(this.el["offer-code-input"].value)
    );
    this.el["btn-copy-answer-code"].addEventListener("click", () => {
      if (this.latestAnswer) this.copyText(this.latestAnswer.code, "Copied P2P1: reply code");
    });
    this.el["btn-copy-answer-url"].addEventListener("click", () => {
      if (this.latestAnswer) this.copyText(this.latestAnswer.url, "Copied #answer= reply link");
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
      this.addTelemetry("sync_inv", `Triggered E2EE anti-entropy sync across ${this.directPeers.size} peer(s)`);
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
    const teardownAll = () => {
      this.flushPersist();
      for (const p of this.directPeers.values()) {
        try {
          p.dc.close();
          p.pc.close();
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
    const hasRecords = snap && ((Array.isArray(snap.records) && snap.records.length > 0) || (Array.isArray(snap.messages) && snap.messages.length > 0));
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

    this.renderAll();

    await this.handleUrlHashFragment();

    setInterval(() => {
      if (!this.wasm) return;
      const runSync = this.directPeers.size > 0;
      const res = this.wasm.call({ cmd: "tick", nowMs: Date.now(), runSync });
      this.status = res.status;
      this.executeActions(res.actions);
      this.renderStats();
    }, 15_000);

    window.__p2pDirect = this;
  }

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
      this.flushPersist();
      this.renderAll();
      this.addTelemetry(
        "e2ee",
        `Derived 256-bit key via PBKDF2-HMAC-SHA256 (${this.status.e2ee.keyFingerprint}); P2P1 codes are now passphrase-encrypted`
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
    this.addTelemetry(
      "e2ee",
      `Switched to automatic 256-bit mesh key (${this.status.e2ee.keyFingerprint})`
    );
    this.showToast(`Auto 256-bit E2EE active · FP ${this.status.e2ee.keyFingerprint}`);
  }

  switchConnectTab(tab) {
    const isInvite = tab === "invite";
    this.el["tab-btn-invite"].classList.toggle("active", isInvite);
    this.el["tab-btn-invite"].setAttribute("aria-selected", String(isInvite));
    this.el["tab-pane-invite"].classList.toggle("active", isInvite);
    this.el["tab-btn-join"].classList.toggle("active", !isInvite);
    this.el["tab-btn-join"].setAttribute("aria-selected", String(!isInvite));
    this.el["tab-pane-join"].classList.toggle("active", !isInvite);
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
    this.toastTimer = setTimeout(() => el.classList.remove("visible"), 2600);
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
    this.addTelemetry("storage", "Cleared local encrypted log; click Sync Now to backfill from peers");
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

  async handleUrlHashFragment() {
    const hash = window.location.hash;
    if (!hash || hash.length < 4) return;
    try {
      const frag = this.wasm.call({ cmd: "extract_fragment", hash });
      if (!frag.found) return;
      if (frag.kind === "offer") {
        this.switchConnectTab("join");
        this.el["offer-code-input"].value = frag.code;
        await this.acceptManualOffer(frag.code);
      } else if (frag.kind === "answer") {
        this.switchConnectTab("invite");
        this.el["answer-code-input"].value = frag.code;
        if (this.pendingOffers.size > 0) {
          await this.completeManualOffer(frag.code);
        } else {
          this.showNotice(
            "invite-notice",
            "warn",
            "Detected #answer= fragment in URL. Paste it into the inviter tab that generated the matching offer."
          );
        }
      }
    } catch (err) {
      this.addTelemetry("error", `Fragment parse failed: ${err.message}`);
    }
  }

  /* ================= Manual Out-of-Band E2EE P2P1 Handshake ================= */

  async createManualInvite() {
    this.el["btn-create-invite"].disabled = true;
    this.showNotice("invite-notice", "info", "Gathering WebRTC ICE candidates…");
    try {
      const inviteId = randomId("inv");
      const pc = new RTCPeerConnection(ICE_CONFIG);
      const dc = pc.createDataChannel("p2p-mesh", { ordered: true });
      const pending = {
        inviteId,
        pc,
        dc,
        code: "",
        url: "",
      };
      this.pendingOffers.set(inviteId, pending);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc, 1800);

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

      this.el["offer-code-output"].value = encoded.code;
      this.el["offer-size-meta"].textContent = `${encoded.rawBytes}B SDP → ${encoded.codeChars} chars${encoded.encrypted ? " · AEAD" : ""}`;
      this.el["btn-copy-offer-code"].disabled = false;
      this.el["btn-copy-offer-url"].disabled = false;
      this.showNotice(
        "invite-notice",
        "success",
        encoded.encrypted
          ? `Passphrase-encrypted invite ready (${inviteId}). Peer must enter the same passphrase to decrypt.`
          : `E2EE invite ready (${inviteId}, FP ${this.status.e2ee.keyFingerprint}). Share the P2P1: code or #offer= link.`
      );
      this.addTelemetry(
        "signal",
        `Generated ${encoded.encrypted ? "passphrase-encrypted " : ""}P2P1 offer ${inviteId} (${encoded.codeChars} chars)`
      );
    } catch (err) {
      this.showNotice("invite-notice", "error", `Failed to create invite: ${err.message}`);
    } finally {
      this.el["btn-create-invite"].disabled = false;
    }
  }

  async acceptManualOffer(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      this.showNotice("join-notice", "warn", "Paste a P2P1: invite code or #offer= link first.");
      return;
    }
    this.el["btn-create-answer"].disabled = true;
    this.showNotice("join-notice", "info", "Decoding P2P1 offer and gathering ICE candidates…");
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

      // Adopt inviter's 256-bit mesh key automatically if embedded in out-of-band #offer= fragment
      if (sig.meshKey && !sig.encrypted) {
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
        this.attachDataChannel(pc, ev.channel, sig.peerId, sig.authorName, sig.pubKey, false, null);
      };

      await pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc, 1800);

      const encoded = this.wasm.call({
        cmd: "encode_signal",
        kind: "answer",
        inviteId: sig.inviteId || "",
        sdp: pc.localDescription.sdp,
        baseUrl: basePageUrl(),
        entropy: randomBase64Url(16),
      });

      this.pendingAnswers.set(sig.peerId, { pc, code: encoded.code, url: encoded.url });
      this.latestAnswer = { code: encoded.code, url: encoded.url, peerId: sig.peerId };

      this.el["answer-code-output"].value = encoded.code;
      this.el["answer-size-meta"].textContent = `${encoded.rawBytes}B SDP → ${encoded.codeChars} chars${encoded.encrypted ? " · AEAD" : ""}`;
      this.el["btn-copy-answer-code"].disabled = false;
      this.el["btn-copy-answer-url"].disabled = false;
      this.showNotice(
        "join-notice",
        "success",
        `E2EE reply ready for ${sig.authorName} (${sig.peerId}, FP ${this.status.e2ee.keyFingerprint}). Send reply back to connect.`
      );
      this.addTelemetry("signal", `Created E2EE P2P1 reply for ${sig.authorName} (${sig.peerId})`);
    } catch (err) {
      this.showNotice("join-notice", "error", `Could not accept invite: ${err.message}`);
    } finally {
      this.el["btn-create-answer"].disabled = false;
    }
  }

  async completeManualOffer(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      this.showNotice("invite-notice", "warn", "Paste the peer's P2P1: answer code or #answer= link first.");
      return;
    }
    this.el["btn-accept-answer"].disabled = true;
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
        throw new Error("No matching pending invite found. Click Generate Invite first.");
      }

      this.pendingOffers.delete(pending.inviteId);
      this.attachDataChannel(pending.pc, pending.dc, sig.peerId, sig.authorName, sig.pubKey, false, null);
      await pending.pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });

      this.el["answer-code-input"].value = "";
      this.showNotice(
        "invite-notice",
        "info",
        `Applying X25519 reply from ${sig.authorName} (${sig.peerId}) — opening E2EE DataChannel…`
      );
      this.addTelemetry("signal", `Applied P2P1 answer from ${sig.authorName} (${sig.peerId})`);
    } catch (err) {
      this.showNotice("invite-notice", "error", `Failed to complete connection: ${err.message}`);
    } finally {
      this.el["btn-accept-answer"].disabled = false;
    }
  }

  /* ================= Direct E2EE DataChannel & Relayed Auto-Mesh ================= */

  attachDataChannel(pc, dc, peerId, authorName, peerPubKey, viaAutoMesh, introducedBy) {
    let closed = false;

    const handleOpen = () => {
      if (closed) return;
      const existing = this.directPeers.get(peerId);
      if (existing && existing.dc && existing.dc.readyState === "open" && existing.dc !== dc) {
        try {
          dc.close();
          pc.close();
        } catch {
          // ignore
        }
        return;
      }

      this.relayPeers.delete(peerId);
      this.earlyRelayIce.delete(peerId);
      this.pendingAnswers.delete(peerId);
      this.directPeers.set(peerId, {
        peerId,
        authorName: authorName || "Peer",
        peerPubKey,
        pc,
        dc,
        viaAutoMesh,
        introducedBy,
      });

      const res = this.wasm.call({
        cmd: "peer_connected",
        peerId,
        authorName: authorName || "Peer",
        peerPubKey,
        viaAutoMesh,
        introducedBy,
      });
      this.status = res.status;
      this.executeActions(res.actions);
      this.renderAll();

      if (!viaAutoMesh) {
        this.showNotice(
          "invite-notice",
          "success",
          `Direct E2EE WebRTC channel open with ${authorName} (${peerId}).`
        );
      }
      this.showToast(
        viaAutoMesh
          ? `Auto-meshed directly (E2EE) with ${authorName || peerId}`
          : `Connected (E2EE) to ${authorName || peerId}`
      );
    };

    let disconnectTimer = null;
    const clearDisconnectTimer = () => {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
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
    };

    const evaluateConnectionState = () => {
      const cs = pc.connectionState;
      const ics = pc.iceConnectionState;
      if (cs === "failed" || cs === "closed" || ics === "failed" || ics === "closed") {
        handleClose();
      } else if (cs === "disconnected" || ics === "disconnected") {
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            if (
              pc.connectionState !== "connected" &&
              pc.iceConnectionState !== "connected" &&
              pc.iceConnectionState !== "completed"
            ) {
              handleClose();
            }
          }, 2500);
        }
      } else if (cs === "connected" || ics === "connected" || ics === "completed") {
        clearDisconnectTimer();
      }
    };

    dc.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const res = this.wasm.call({
          cmd: "wire_message",
          fromPeer: peerId,
          frame: ev.data,
          nowMs: Date.now(),
        });
        this.status = res.status;
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
          this.acceptRelayedOffer(act.fromPeerId, act.fromName, act.fromPubKey, act.viaPeerId, act.sdp);
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
      this.attachDataChannel(pc, dc, targetPeerId, targetName, targetPubKey, true, viaPeerId);

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
        this.attachDataChannel(pc, ev.channel, fromPeerId, fromName, fromPubKey, true, viaPeerId);
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
      this.el["key-fp-display"].textContent = this.status.e2ee.keyFingerprint.slice(0, 9);
      this.el["key-fp-display"].parentElement.title =
        `E2EE ${this.status.e2ee.cipher} · Full Key Fingerprint: ${this.status.e2ee.keyFingerprint}`;
      this.el["e2ee-mode-label"].textContent = this.status.e2ee.passphraseMode
        ? `Passphrase-Locked · ${this.status.e2ee.keyFingerprint.slice(0, 9)}`
        : `Auto 256-bit Key · ${this.status.e2ee.keyFingerprint.slice(0, 9)}`;
    }

    const isOnline = this.status.peers.length > 0;
    this.el["mesh-status-chip"].classList.toggle("live", isOnline);
    this.el["mesh-status-dot"].classList.toggle("online", isOnline);
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
        '<li class="empty-state">No direct peers yet. Create an invite or open an <code>#offer=</code> link to join a mesh.</li>';
      return;
    }

    const parts = [];
    for (const p of direct) {
      const originBadge = p.viaAutoMesh
        ? `<span class="badge auto" title="Auto-introduced via ${escapeHtml(p.introducedBy || "mesh")}">auto-mesh</span>`
        : '<span class="badge">manual</span>';
      parts.push(`
        <li class="peer-item" data-peer-id="${escapeHtml(p.peerId)}">
          <div class="peer-main">
            <div class="peer-name">${escapeHtml(p.authorName)} ${originBadge}</div>
            <div class="peer-id">${escapeHtml(p.peerId)} · safety ${escapeHtml(p.safetyCode || "—")} · synced ${p.knownCount}</div>
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
        if (item.event.startsWith("auto_mesh") || item.event === "peer_connected" || item.event === "e2ee") {
          cls += " event-auto";
        } else if (item.event.startsWith("sync") || item.event === "hello") {
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
