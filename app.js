import { SafeRustWasmMesh } from "./wasm_client.js";
import { MultiRelayRendezvous, resolveRelayUrls } from "./mqtt_relay.js";
import {
  DEFAULT_AUDIO_SETTINGS,
  createEphemeralProfile,
  loadSessionAudioSettings,
  purgeLegacyClientStorage,
  randomBase64Url,
  saveSessionAudioSettings,
  saveSessionAuthorName,
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

const VOICE_SAMPLE_RATE = 16000;
const VOICE_FRAME_SAMPLES = 320; // 20ms @ 16kHz wideband

const AUDIO_PRESETS = Object.freeze({
  voice: {
    preset: "voice",
    micGain: 100,
    noiseGate: 2,
    highPassHz: 80,
    presenceDb: 2,
    compressor: true,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  broadcast: {
    preset: "broadcast",
    micGain: 125,
    noiseGate: 3,
    highPassHz: 120,
    presenceDb: 4,
    compressor: true,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  },
  raw: {
    preset: "raw",
    micGain: 100,
    noiseGate: 0,
    highPassHz: 0,
    presenceDb: 0,
    compressor: false,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
});

const VOICE_CAPTURE_WORKLET_CODE = `
class P2PVoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = ${VOICE_SAMPLE_RATE};
    this.frameSize = ${VOICE_FRAME_SAMPLES};
    this.step = sampleRate / this.targetRate;
    this.inBuf = [];
    this.phase = 0;
    this.frame = new Int16Array(this.frameSize);
    this.frameIdx = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this.inBuf.push(ch[i]);
    }
    while (this.phase + 1 < this.inBuf.length) {
      const idx = Math.floor(this.phase);
      const frac = this.phase - idx;
      const sample = this.inBuf[idx] * (1 - frac) + this.inBuf[idx + 1] * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.frame[this.frameIdx++] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      this.phase += this.step;
      if (this.frameIdx >= this.frameSize) {
        const out = this.frame.slice();
        this.port.postMessage(out, [out.buffer]);
        this.frameIdx = 0;
      }
    }
    const drop = Math.floor(this.phase);
    if (drop > 0) {
      this.inBuf = this.inBuf.slice(drop);
      this.phase -= drop;
    }
    return true;
  }
}
registerProcessor("p2p-voice-capture", P2PVoiceCaptureProcessor);
`;

const STRUCTURED_PRESETS = {
  event: {
    type: "event",
    payload: { action: "checkpoint", version: 1, ok: true },
  },
  task: {
    type: "task",
    payload: { id: "task-1", title: "Verify encrypted sync", status: "open", priority: 2 },
  },
  metric: {
    type: "metric",
    payload: { name: "mesh_latency_ms", value: 14.2, unit: "ms", tags: ["p2p", "encrypted", "realtime"] },
  },
  state: {
    type: "state",
    payload: { key: "config.mode", value: "encrypted", updatedBy: "peer" },
  },
};

const METRO_TILE_THEMES = [
  "tile-coral",
  "tile-cobalt",
  "tile-ochre",
  "tile-cyan",
];

const VOICE_EQ_WEIGHTS = [0.32, 0.54, 0.76, 0.92, 1.0, 1.0, 0.92, 0.76, 0.54, 0.32];
const SAFE_IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const SAFE_HTTP_URL_RE = /^https?:\/\/[^\s<>"']+$/i;
const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;
const MAX_IMAGES_PER_MESSAGE = 3;
const MAX_TOTAL_IMAGE_DATA_CHARS = 60000;

const SPEAK_STAR_SVG =
  '<svg class="speak-star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12,1 14.8,8.2 22,5 16.8,12 22,19 14.8,15.8 12,23 9.2,15.8 2,19 7.2,12 2,5 9.2,8.2"/></svg>';
const MIC_ON_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const MIC_OFF_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const HEAD_ON_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19v-5h-3v7h1a2 2 0 0 0 2-2zM3 19a2 2 0 0 0 2 2h1v-7H3z"/></svg>';
const HEAD_OFF_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><line x1="2" y1="2" x2="22" y2="22"/><path d="M3 18v-6a9 9 0 0 1 14.5-7.1"/><path d="M21 12v6"/><path d="M21 19v-5h-3v4"/><path d="M3 19a2 2 0 0 0 2 2h1v-7H3z"/></svg>';
const EXIT_VOICE_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="square" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const LINK_ARROW_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" aria-hidden="true"><path d="M18 13v6H5V6h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
const TRASH_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><line x1="10" y1="11" x2="10" y2="16"/><line x1="14" y1="11" x2="14" y2="16"/></svg>';

function isSafeImageSrc(src) {
  if (typeof src !== "string") return false;
  return SAFE_IMAGE_DATA_URL_RE.test(src) || /^https:\/\/[^\s<>"']+$/i.test(src);
}

function formatBotRichText(raw) {
  const { html } = extractAndLinkify(String(raw || ""));
  return html
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

function computePcmRms(int16Pcm) {
  if (!int16Pcm || int16Pcm.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < int16Pcm.length; i++) {
    const s = int16Pcm[i];
    sumSq += s * s;
  }
  return Math.round(Math.sqrt(sumSq / int16Pcm.length));
}

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

function avatarInitials(name) {
  const parts = String(name || "P")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  const single = parts[0] || "P";
  return single.slice(0, 2).toUpperCase();
}

function peerTileTheme(seed, isSelf = false) {
  if (isSelf) return "tile-mint";
  const str = String(seed || "peer");
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return METRO_TILE_THEMES[Math.abs(hash) % METRO_TILE_THEMES.length];
}

function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function extractAndLinkify(text) {
  const raw = String(text || "");
  const links = [];
  const seenHref = new Set();
  let html = "";
  let lastIndex = 0;

  URL_REGEX.lastIndex = 0;
  let match;
  while ((match = URL_REGEX.exec(raw)) !== null) {
    const start = match.index;
    let candidate = match[0];
    let trailing = "";

    // Trim trailing sentence punctuation or unmatched closing brackets
    while (candidate.length > 0) {
      const last = candidate[candidate.length - 1];
      if (".!?,;:".includes(last)) {
        trailing = last + trailing;
        candidate = candidate.slice(0, -1);
      } else if (last === ")" && (candidate.match(/\(/g) || []).length < (candidate.match(/\)/g) || []).length) {
        trailing = last + trailing;
        candidate = candidate.slice(0, -1);
      } else if (last === "]" && (candidate.match(/\[/g) || []).length < (candidate.match(/\]/g) || []).length) {
        trailing = last + trailing;
        candidate = candidate.slice(0, -1);
      } else {
        break;
      }
    }

    html += escapeHtml(raw.slice(lastIndex, start));
    let parsed = null;
    try {
      const u = new URL(candidate);
      if (u.protocol === "http:" || u.protocol === "https:") {
        parsed = u;
      }
    } catch {
      parsed = null;
    }

    if (parsed) {
      const safeHref = escapeHtml(parsed.href);
      html += `<a class="chat-link" href="${safeHref}" target="_blank" rel="noopener noreferrer">${escapeHtml(candidate)}</a>`;
      if (!seenHref.has(parsed.href)) {
        seenHref.add(parsed.href);
        const pathLabel =
          (parsed.pathname === "/" ? "" : parsed.pathname) + (parsed.search || "") + (parsed.hash || "");
        links.push({
          href: parsed.href,
          host: parsed.hostname.replace(/^www\./, ""),
          path: pathLabel || parsed.pathname || "/",
        });
      }
    } else {
      html += escapeHtml(candidate);
    }

    html += escapeHtml(trailing);
    lastIndex = start + match[0].length;
  }

  html += escapeHtml(raw.slice(lastIndex));
  return { html, links };
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode pasted image"));
    };
    img.src = url;
  });
}

async function compressImageFile(file, maxChars = 54000) {
  const img = await loadImageFromFile(file);
  const origW = img.naturalWidth || img.width || 1;
  const origH = img.naturalHeight || img.height || 1;

  const attempts = [
    { maxDim: 880, quality: 0.8 },
    { maxDim: 760, quality: 0.68 },
    { maxDim: 620, quality: 0.56 },
    { maxDim: 480, quality: 0.46 },
    { maxDim: 360, quality: 0.38 },
  ];

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable");
  }

  let best = null;
  for (const { maxDim, quality } of attempts) {
    const scale = Math.min(1, maxDim / Math.max(origW, origH));
    const w = Math.max(1, Math.round(origW * scale));
    const h = Math.max(1, Math.round(origH * scale));
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    let dataUrl = canvas.toDataURL("image/webp", quality);
    if (!dataUrl.startsWith("data:image/webp")) {
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    best = {
      id: randomId("img"),
      dataUrl,
      width: w,
      height: h,
      name: file.name || "pasted-image.webp",
      bytes: Math.round((dataUrl.length * 3) / 4),
    };
    if (dataUrl.length <= maxChars) {
      return best;
    }
  }
  return best;
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

function shareableBaseUrl() {
  try {
    const u = new URL(window.location.href);
    u.hash = "";
    u.searchParams.delete("profile");
    return u.toString();
  } catch {
    return basePageUrl();
  }
}

function rmsToLevel(rms) {
  if (!rms || rms <= 0) return 0;
  const norm = Math.min(1, rms / 5500);
  return Math.min(1, Math.pow(norm, 0.48));
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
    this.logRenderState = {
      mode: "", // "empty" | "raw" | "chat"
      key: "",
    };
    this.advancedMode = false;
    this.rawJsonMode = false;
    this.composerMode = "chat";
    this.pendingImages = [];
    this.telemetry = [];
    this.toastTimer = null;

    // Step-by-step Connect Wizard state
    this.wizard = {
      mode: "idle", // "idle" | "host" | "join"
      step: 1, // 1 | 2 | 3
      hostCopied: false,
      joinCopied: false,
      peerName: "",
      offerMeta: "",
      answerMeta: "",
      offerHint: "",
      answerHint: "",
    };

    // Out-of-band manual signaling state
    this.pendingOffers = new Map();
    this.pendingAnswers = new Map();
    this.latestOffer = null;
    this.latestAnswer = null;

    // Live WebRTC transport maps
    this.directPeers = new Map();
    this.voiceChannels = new Map(); // peerId -> RTCDataChannel("p2p-voice")
    this.relayPeers = new Map();
    this.earlyRelayIce = new Map();

    // Same-browser BroadcastChannel 1-click local discovery & tab handoff
    this.bc = null;
    this.discoveredLocalMeshes = new Map();
    this.localDialing = new Map();
    this.earlyLocalIce = new Map();

    // Long-lived reusable room link & encrypted MQTT rendezvous state
    this.activeRoom = null; // { name, code, url, topic, relay, encrypted }
    this.roomRendezvous = null;
    this.roomRelayStatus = { state: "stopped", connectedCount: 0, totalCount: 0 };
    this.roomDialing = new Map();
    this.earlyRoomIce = new Map();
    this.seenRoomSignalIds = new Map();
    this.lastHelloReplyPerPeer = new Map();
    this.pendingRoomCode = null;

    // Background-resilient Web Worker keepalive
    this.keepaliveWorker = null;
    this.keepaliveFallbackTimer = null;
    this.keepaliveTickCount = 0;

    // Personal audio settings (session-only; zero permanent storage)
    this.audioSettings = loadSessionAudioSettings();

    // Real-time multi-peer voice channel state
    this.voice = {
      inVoice: false,
      muted: false,
      deafened: false,
      listenOnly: false,
      audioCtx: null,
      micStream: null,
      micSource: null,
      highPassFilter: null,
      presenceFilter: null,
      compressorNode: null,
      micGainNode: null,
      monitorGain: null,
      monitorActive: false,
      captureNode: null,
      silentGain: null,
      masterGain: null,
      gateOpenUntil: 0,
      gateClosed: false,
      settingsOpen: false,
      preCallMonitor: null, // { ctx, stream, source, highPass, presence, compressor, micGain, monitorGain, analyser, timer }
      audioDevices: [],
      peerMixers: new Map(), // peerId -> { gainNode, volume, muted, nextPlayTime, rms, smoothLevel, lastAudioAt, packetsReceived }
      joinOrder: [], // ordered participant keys (peerId or "self") so cards never jump when joining
      localRms: 0,
      localSmoothLevel: 0,
      localSpeakingAt: 0,
      meterTimer: null,
      meterTicks: 0,
      lastRosterKey: "",
      renderedKeys: new Set(),
    };

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
      "voice-header-chip",
      "voice-header-count",
      "log-count-display",
      "btn-advanced-toggle",
      "btn-theme-toggle",
      "icon-moon",
      "icon-sun",
      "room-lobby",
      "lobby-create-form",
      "lobby-room-name-input",
      "btn-lobby-create-room",
      "lobby-join-form",
      "lobby-room-link-input",
      "btn-lobby-join-room",
      "lobby-passphrase-box",
      "lobby-passphrase-form",
      "lobby-passphrase-input",
      "btn-lobby-unlock-room",
      "lobby-notice",
      "simple-room-bar",
      "simple-room-name",
      "simple-room-status-wrap",
      "simple-room-badge",
      "btn-simple-copy-link",
      "btn-simple-leave-room",
      "connect-panel-title",
      "btn-wizard-reset",
      "connect-panel-meta",
      "local-mesh-banner",
      "local-mesh-fp",
      "local-mesh-desc",
      "btn-join-local-mesh",
      "room-link-card",
      "room-link-setup",
      "room-name-input",
      "btn-create-room-link",
      "room-link-active",
      "room-active-name",
      "room-relay-badge",
      "room-active-hint",
      "room-link-output",
      "btn-room-copy-url",
      "btn-room-share",
      "btn-room-new",
      "btn-room-leave",
      "wizard-role-picker",
      "btn-wizard-start-host",
      "btn-wizard-start-join",
      "wizard-host-flow",
      "wizard-host-step-1",
      "host-step-1-badge",
      "host-offer-meta",
      "host-step-1-body",
      "host-step-1-hint",
      "btn-host-copy-url",
      "btn-host-copy-code",
      "btn-host-share",
      "host-offer-code",
      "wizard-host-step-2",
      "host-step-2-badge",
      "host-step-2-body",
      "host-answer-input",
      "btn-host-paste-answer",
      "btn-host-apply-answer",
      "wizard-host-step-3",
      "host-step-3-badge",
      "host-step-3-title",
      "host-step-3-body",
      "host-step-3-detail",
      "btn-host-invite-another",
      "btn-host-done",
      "wizard-join-flow",
      "wizard-join-step-1",
      "join-step-1-badge",
      "join-step-1-title",
      "join-step-1-body",
      "join-offer-input",
      "btn-join-paste-offer",
      "btn-join-create-reply",
      "wizard-join-step-2",
      "join-step-2-badge",
      "join-answer-meta",
      "join-step-2-body",
      "join-step-2-hint",
      "btn-join-copy-url",
      "btn-join-copy-code",
      "btn-join-share",
      "join-answer-code",
      "wizard-join-step-3",
      "join-step-3-badge",
      "join-step-3-title",
      "join-step-3-body",
      "join-step-3-detail",
      "btn-join-done",
      "connect-notice",
      "e2ee-key-details",
      "e2ee-mode-label",
      "e2ee-passphrase-input",
      "btn-apply-passphrase",
      "btn-clear-passphrase",
      "e2ee-bar-hint",
      "voice-panel",
      "voice-status-badge",
      "btn-voice-settings",
      "voice-settings-drawer",
      "btn-audio-monitor",
      "btn-audio-reset",
      "audio-input-select",
      "audio-mic-meter-status",
      "audio-mic-gain",
      "audio-mic-gain-val",
      "audio-mic-meter-fill",
      "audio-gate-marker",
      "audio-output-gain",
      "audio-output-gain-val",
      "audio-noise-gate",
      "audio-noise-gate-val",
      "audio-highpass",
      "audio-highpass-val",
      "audio-presence",
      "audio-presence-val",
      "audio-compressor",
      "audio-ec",
      "audio-ns",
      "audio-agc",
      "voice-join-card",
      "voice-empty-state",
      "btn-voice-join",
      "btn-voice-listen",
      "voice-participant-list",
      "voice-footer",
      "voice-codec-meta",
      "voice-join-hint",
      "voice-packet-stats",
      "voice-notice",
      "btn-sync-now",
      "topology-svg",
      "profile-slot-label",
      "auto-mesh-toggle",
      "auto-mesh-badge",
      "peer-list",
      "bot-connect-details",
      "bot-cli-command",
      "btn-copy-bot-cmd",
      "btn-copy-bot-wf",
      "btn-copy-bot-music",
      "stat-e2ee",
      "stat-batches",
      "stat-voice",
      "telemetry-log",
      "chat-panel",
      "chat-composer-dropzone",
      "chat-image-tray",
      "chat-image-input",
      "btn-attach-image",
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
      "image-lightbox",
      "btn-lightbox-close",
      "lightbox-img",
      "toast",
    ];
    for (const id of ids) {
      this.el[id] = document.getElementById(id);
    }
  }

  bindEvents() {
    // Simple vs Advanced mode toggle & Lobby / Simple Room Bar controls
    this.el["btn-advanced-toggle"].addEventListener("click", () => this.toggleAdvancedMode());
    this.el["lobby-create-form"].addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.createRoomFromLobby();
    });
    this.el["lobby-join-form"].addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.joinRoomFromLobby();
    });
    this.el["lobby-passphrase-form"].addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.unlockRoomFromLobby();
    });
    this.el["btn-simple-copy-link"].addEventListener("click", () => {
      if (!this.activeRoom) return;
      this.copyText(
        this.activeRoom.url,
        "Copied room link — anyone who opens it joins automatically"
      );
    });
    this.el["btn-simple-leave-room"].addEventListener("click", () => this.leaveLongLivedRoom());

    // Passphrase controls
    this.el["btn-apply-passphrase"].addEventListener("click", () => this.applyPassphrase());
    this.el["btn-clear-passphrase"].addEventListener("click", () => this.clearPassphrase());
    this.el["e2ee-passphrase-input"].addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.applyPassphrase();
      }
    });

    // Long-lived reusable room link controls
    this.el["btn-create-room-link"].addEventListener("click", () =>
      this.createLongLivedRoom({ freshKey: false })
    );
    this.el["room-name-input"].addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.createLongLivedRoom({ freshKey: false });
      }
    });
    this.el["room-link-output"].addEventListener("click", () => {
      this.el["room-link-output"].select();
    });
    this.el["btn-room-copy-url"].addEventListener("click", () => {
      if (!this.activeRoom) return;
      this.copyText(
        this.activeRoom.url,
        "Copied room link — anyone who opens it joins automatically"
      );
    });
    this.el["btn-room-share"].addEventListener("click", async () => {
      if (!this.activeRoom || typeof navigator.share !== "function") return;
      try {
        await navigator.share({
          title: `Join ${this.activeRoom.name || "my room"} on p2p-direct`,
          url: this.activeRoom.url,
        });
      } catch {
        // user canceled share sheet
      }
    });
    this.el["btn-room-new"].addEventListener("click", () =>
      this.createLongLivedRoom({ freshKey: true })
    );
    this.el["btn-room-leave"].addEventListener("click", () => this.leaveLongLivedRoom());

    // Quick local tab discovery banner
    this.el["btn-join-local-mesh"].addEventListener("click", () => this.joinDiscoveredLocalMesh());

    // Step-by-Step Connect Wizard controls
    this.el["btn-wizard-start-host"].addEventListener("click", () => this.createManualInvite(false));
    this.el["btn-wizard-start-join"].addEventListener("click", () => {
      this.openJoinWizard();
      this.el["join-offer-input"].focus();
    });
    this.el["btn-wizard-reset"].addEventListener("click", () => this.resetWizard());

    // Host Wizard actions
    this.el["btn-host-copy-url"].addEventListener("click", () => {
      if (!this.latestOffer) return;
      this.copyText(this.latestOffer.url, "Copied #offer= invite link — now paste your peer's reply in Step 2");
      this.markHostInviteShared();
    });
    this.el["btn-host-copy-code"].addEventListener("click", () => {
      if (!this.latestOffer) return;
      this.copyText(this.latestOffer.code, "Copied P2P1: invite code — now paste your peer's reply in Step 2");
      this.markHostInviteShared();
    });
    this.el["btn-host-share"].addEventListener("click", async () => {
      if (!this.latestOffer || typeof navigator.share !== "function") return;
      try {
        await navigator.share({
          title: "Join my p2p-direct room",
          url: this.latestOffer.url,
        });
        this.markHostInviteShared();
      } catch {
        // user canceled share sheet
      }
    });
    this.el["btn-host-paste-answer"].addEventListener("click", () =>
      this.pasteIntoField("host-answer-input", (val) => this.handleHostAnswerSubmit(val))
    );
    this.el["btn-host-apply-answer"].addEventListener("click", () =>
      this.handleHostAnswerSubmit(this.el["host-answer-input"].value)
    );
    this.el["host-answer-input"].addEventListener("paste", () => {
      setTimeout(() => {
        const val = this.el["host-answer-input"].value.trim();
        if (
          val.includes("P2P1:") ||
          val.includes("#answer=") ||
          val.includes("#offer=") ||
          val.includes("#room=") ||
          val.includes("#join=")
        ) {
          this.handleHostAnswerSubmit(val);
        }
      }, 0);
    });
    this.el["btn-host-invite-another"].addEventListener("click", () => this.createManualInvite(false));
    this.el["btn-host-done"].addEventListener("click", () => this.resetWizard());

    // Joiner Wizard actions
    this.el["btn-join-paste-offer"].addEventListener("click", () =>
      this.pasteIntoField("join-offer-input", (val) => this.handleJoinOfferSubmit(val))
    );
    this.el["btn-join-create-reply"].addEventListener("click", () =>
      this.handleJoinOfferSubmit(this.el["join-offer-input"].value)
    );
    this.el["join-offer-input"].addEventListener("paste", () => {
      setTimeout(() => {
        const val = this.el["join-offer-input"].value.trim();
        if (
          val.includes("P2P1:") ||
          val.includes("#offer=") ||
          val.includes("#answer=") ||
          val.includes("#room=") ||
          val.includes("#join=")
        ) {
          this.handleJoinOfferSubmit(val);
        }
      }, 0);
    });
    this.el["btn-join-copy-url"].addEventListener("click", () => {
      if (!this.latestAnswer) return;
      this.copyText(this.latestAnswer.url, "Copied #answer= reply link — send it back to connect");
      this.markJoinReplyShared();
    });
    this.el["btn-join-copy-code"].addEventListener("click", () => {
      if (!this.latestAnswer) return;
      this.copyText(this.latestAnswer.code, "Copied P2P1: reply code — send it back to connect");
      this.markJoinReplyShared();
    });
    this.el["btn-join-share"].addEventListener("click", async () => {
      if (!this.latestAnswer || typeof navigator.share !== "function") return;
      try {
        await navigator.share({
          title: "p2p-direct reply link",
          url: this.latestAnswer.url,
        });
        this.markJoinReplyShared();
      } catch {
        // user canceled share sheet
      }
    });
    this.el["btn-join-done"].addEventListener("click", () => this.resetWizard());

    // Real-time Multi-Peer Voice Channel controls (mute/deafen/leave bind dynamically inside your voice tile)
    this.el["btn-voice-join"].addEventListener("click", () => this.joinVoiceChat({ listenOnly: false }));
    this.el["btn-voice-listen"].addEventListener("click", () => this.joinVoiceChat({ listenOnly: true }));

    // Personal Audio Settings (loudness, noise gate, EQ filters, compressor, hardware constraints, mic test)
    if (this.el["btn-voice-settings"]) {
      this.el["btn-voice-settings"].addEventListener("click", () => this.toggleAudioSettingsDrawer());
    }
    for (const btn of document.querySelectorAll("[data-audio-preset]")) {
      btn.addEventListener("click", () => this.applyAudioPreset(btn.dataset.audioPreset));
    }
    if (this.el["btn-audio-monitor"]) {
      this.el["btn-audio-monitor"].addEventListener("click", () => this.toggleMicMonitor());
    }
    if (this.el["btn-audio-reset"]) {
      this.el["btn-audio-reset"].addEventListener("click", () => this.resetAudioSettings());
    }
    if (this.el["audio-input-select"]) {
      this.el["audio-input-select"].addEventListener("change", () =>
        this.updateAudioSetting("deviceId", this.el["audio-input-select"].value, {
          reconnectMic: true,
          keepPreset: true,
        })
      );
    }
    if (this.el["audio-mic-gain"]) {
      this.el["audio-mic-gain"].addEventListener("input", () =>
        this.updateAudioSetting("micGain", Number(this.el["audio-mic-gain"].value))
      );
    }
    if (this.el["audio-output-gain"]) {
      this.el["audio-output-gain"].addEventListener("input", () =>
        this.updateAudioSetting("outputGain", Number(this.el["audio-output-gain"].value), {
          keepPreset: true,
        })
      );
    }
    if (this.el["audio-noise-gate"]) {
      this.el["audio-noise-gate"].addEventListener("input", () =>
        this.updateAudioSetting("noiseGate", Number(this.el["audio-noise-gate"].value))
      );
    }
    if (this.el["audio-highpass"]) {
      this.el["audio-highpass"].addEventListener("change", () =>
        this.updateAudioSetting("highPassHz", Number(this.el["audio-highpass"].value))
      );
    }
    if (this.el["audio-presence"]) {
      this.el["audio-presence"].addEventListener("input", () =>
        this.updateAudioSetting("presenceDb", Number(this.el["audio-presence"].value))
      );
    }
    if (this.el["audio-compressor"]) {
      this.el["audio-compressor"].addEventListener("change", () =>
        this.updateAudioSetting("compressor", this.el["audio-compressor"].checked, {
          rewireGraph: true,
        })
      );
    }
    if (this.el["audio-ec"]) {
      this.el["audio-ec"].addEventListener("change", () =>
        this.updateAudioSetting("echoCancellation", this.el["audio-ec"].checked, {
          applyTrackConstraints: true,
        })
      );
    }
    if (this.el["audio-ns"]) {
      this.el["audio-ns"].addEventListener("change", () =>
        this.updateAudioSetting("noiseSuppression", this.el["audio-ns"].checked, {
          applyTrackConstraints: true,
        })
      );
    }
    if (this.el["audio-agc"]) {
      this.el["audio-agc"].addEventListener("change", () =>
        this.updateAudioSetting("autoGainControl", this.el["audio-agc"].checked, {
          applyTrackConstraints: true,
        })
      );
    }
    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
      navigator.mediaDevices.addEventListener("devicechange", () => {
        if (this.voice.settingsOpen) {
          this.refreshAudioInputDevices();
        }
      });
    }

    // Self-hosted Bot quick CLI copy buttons (Advanced sidebar)
    if (this.el["btn-copy-bot-cmd"]) {
      this.el["btn-copy-bot-cmd"].addEventListener("click", () => {
        this.copyText(this.buildBotCliCommand("bridge"), "Copied bot bridge command");
      });
    }
    if (this.el["btn-copy-bot-wf"]) {
      this.el["btn-copy-bot-wf"].addEventListener("click", () => {
        this.copyText(this.buildBotCliCommand("warframe"), "Copied Warframe bot command");
      });
    }
    if (this.el["btn-copy-bot-music"]) {
      this.el["btn-copy-bot-music"].addEventListener("click", () => {
        this.copyText(this.buildBotCliCommand("music"), "Copied Music bot command");
      });
    }

    // Identity & Mesh controls
    this.el["author-name-input"].addEventListener("input", () => {
      const typed = this.el["author-name-input"].value.trim();
      if (typed) {
        saveSessionAuthorName(typed);
      }
    });

    this.el["author-name-input"].addEventListener("change", () => {
      const next = this.el["author-name-input"].value.trim();
      if (!next) {
        this.el["author-name-input"].value = this.status.authorName;
        return;
      }
      saveSessionAuthorName(next);
      const res = this.wasm.call({ cmd: "set_profile", authorName: next });
      this.status = res.status;
      this.profile.authorName = next;
      this.executeActions(res.actions);
      this.renderHeader();
      this.renderVoicePanel(true);
      this.renderTopology();
      this.broadcastMeshBeacon(false);
      this.announceRoomHello(false);
      this.showToast(`Updated display name to ${next}`);
    });

    this.el["auto-mesh-toggle"].addEventListener("change", () => {
      const enabled = this.el["auto-mesh-toggle"].checked;
      const res = this.wasm.call({ cmd: "set_profile", autoMeshEnabled: enabled });
      this.status = res.status;
      this.profile.autoMeshEnabled = enabled;
      this.el["auto-mesh-badge"].textContent = enabled ? "ON" : "OFF";
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

    // Replicated log composer & toolbar
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

    // Theme toggle
    this.el["btn-theme-toggle"].addEventListener("click", () => this.toggleTheme());

    // Image attach, paste, and drag-and-drop into chat
    this.el["btn-attach-image"].addEventListener("click", () => {
      this.el["chat-image-input"].click();
    });
    this.el["chat-image-input"].addEventListener("change", async (ev) => {
      const files = Array.from(ev.target.files || []).filter((f) => f.type.startsWith("image/"));
      this.el["chat-image-input"].value = "";
      if (files.length > 0) {
        await this.addPendingImageFiles(files);
      }
    });

    const handleImagePaste = async (ev) => {
      const cd = ev.clipboardData;
      if (!cd) return;
      const imageFiles = [];
      if (cd.items) {
        for (const item of cd.items) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const f = item.getAsFile();
            if (f) imageFiles.push(f);
          }
        }
      }
      if (imageFiles.length === 0 && cd.files) {
        for (const f of cd.files) {
          if (f.type.startsWith("image/")) {
            imageFiles.push(f);
          }
        }
      }
      if (imageFiles.length > 0) {
        ev.preventDefault();
        if (this.composerMode !== "chat") {
          this.switchComposerMode("chat");
        }
        await this.addPendingImageFiles(imageFiles);
      }
    };

    this.el["chat-text-input"].addEventListener("paste", handleImagePaste);
    document.addEventListener("paste", (ev) => {
      if (ev.defaultPrevented || ev.target === this.el["chat-text-input"]) return;
      const active = document.activeElement;
      if (active === this.el["chat-text-input"]) return;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      handleImagePaste(ev);
    });

    const chatPanel = this.el["chat-panel"];
    const dropzone = this.el["chat-composer-dropzone"];
    chatPanel.addEventListener("dragover", (ev) => {
      if (ev.dataTransfer?.types && Array.from(ev.dataTransfer.types).includes("Files")) {
        ev.preventDefault();
        dropzone.classList.add("drag-over");
      }
    });
    chatPanel.addEventListener("dragleave", (ev) => {
      if (!chatPanel.contains(ev.relatedTarget)) {
        dropzone.classList.remove("drag-over");
      }
    });
    chatPanel.addEventListener("drop", async (ev) => {
      dropzone.classList.remove("drag-over");
      const files = Array.from(ev.dataTransfer?.files || []).filter((f) =>
        f.type.startsWith("image/")
      );
      if (files.length > 0) {
        ev.preventDefault();
        if (this.composerMode !== "chat") {
          this.switchComposerMode("chat");
        }
        await this.addPendingImageFiles(files);
      }
    });

    // Image lightbox controls
    this.el["btn-lightbox-close"].addEventListener("click", () => this.closeLightbox());
    this.el["image-lightbox"].addEventListener("click", (ev) => {
      if (ev.target === this.el["image-lightbox"]) {
        this.closeLightbox();
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !this.el["image-lightbox"].classList.contains("hidden")) {
        this.closeLightbox();
      }
    });

    this.el["chat-composer-form"].addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = this.el["chat-text-input"].value.trim();
      const images = this.pendingImages.map(({ dataUrl, width, height, name }) => ({
        dataUrl,
        width,
        height,
        name,
      }));
      if (!text && images.length === 0) return;
      const payload = images.length > 0 ? { text, images } : { text };
      this.publishMessage("chat", payload);
      this.el["chat-text-input"].value = "";
      this.pendingImages = [];
      this.renderImageTray();
      this.el["composer-error"].classList.add("hidden");
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
      this.el["btn-toggle-raw"].textContent = this.rawJsonMode ? "Chat View" : "Raw JSON";
      this.el["btn-toggle-raw"].classList.toggle("is-active", this.rawJsonMode);
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
      if (this.voice.inVoice) {
        this.leaveVoiceChat(/* silent = */ true);
      }
      if (this.roomRendezvous) {
        try {
          this.roomRendezvous.stop();
        } catch {
          // ignore
        }
      }
      for (const entry of this.roomDialing.values()) {
        try {
          entry.pc.close();
        } catch {
          // ignore
        }
      }
      if (this.keepaliveWorker) {
        try {
          this.keepaliveWorker.terminate();
        } catch {
          // ignore
        }
      }
      for (const vdc of this.voiceChannels.values()) {
        try {
          vdc.close();
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
    this.initTheme();
    this.initAdvancedMode();
    this.bindEvents();

    // Ensure nothing is persisted permanently on the client
    purgeLegacyClientStorage();
    this.el["profile-slot-label"].textContent = "in-memory session";
    this.profile = createEphemeralProfile();

    this.wasm = await SafeRustWasmMesh.loadFromUrl("./p2p_mesh.wasm");
    this.addTelemetry("engine", "In-memory encrypted session ready");

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
    this.logMessages = [];

    this.el["author-name-input"].value = this.status.authorName;
    this.el["auto-mesh-toggle"].checked = this.status.autoMeshEnabled;
    this.el["auto-mesh-badge"].textContent = this.status.autoMeshEnabled ? "ON" : "OFF";
    this.syncAudioSettingsUI();

    this.setupBroadcastChannel();
    this.startKeepaliveWorker();

    // Handle any #room=, #offer=, or #answer= fragment before first render to avoid lobby flash
    await this.handleUrlHashFragment();
    this.renderAll();

    // Discover any other live tabs open in this browser
    this.broadcastMeshBeacon(true);

    window.__p2pDirect = this;
  }

  /* ================= Simple vs Advanced Mode & Lobby ================= */

  initAdvancedMode() {
    const initial = document.documentElement.getAttribute("data-advanced") === "true";
    this.setAdvancedMode(initial, /* persist = */ false);
  }

  setAdvancedMode(enabled, persist = true) {
    this.advancedMode = Boolean(enabled);
    document.documentElement.setAttribute("data-advanced", this.advancedMode ? "true" : "false");

    const btn = this.el["btn-advanced-toggle"];
    if (btn) {
      btn.classList.toggle("is-active", this.advancedMode);
      btn.setAttribute("aria-pressed", String(this.advancedMode));
      btn.title = this.advancedMode
        ? "Return to simple room view"
        : "Show advanced networking, manual connect, and JSON tools";
    }

    if (persist) {
      try {
        sessionStorage.setItem("p2p-direct-advanced", this.advancedMode ? "true" : "false");
      } catch {
        // ignore storage restrictions
      }
    }

    if (!this.advancedMode) {
      if (this.rawJsonMode) {
        this.rawJsonMode = false;
        if (this.el["btn-toggle-raw"]) {
          this.el["btn-toggle-raw"].textContent = "Raw JSON";
          this.el["btn-toggle-raw"].classList.remove("is-active");
        }
      }
      if (this.composerMode !== "chat") {
        this.switchComposerMode("chat");
      }
      if (this.el["log-search-input"]) this.el["log-search-input"].value = "";
      if (this.el["log-type-filter"]) this.el["log-type-filter"].value = "";
    }

    if (this.status) {
      this.renderAll();
    } else {
      this.syncLayoutAttributes();
    }
  }

  toggleAdvancedMode() {
    this.setAdvancedMode(!this.advancedMode, true);
  }

  syncLayoutAttributes() {
    const inRoom = Boolean(this.activeRoom || this.directPeers.size > 0);
    document.documentElement.setAttribute("data-in-room", inRoom ? "true" : "false");
  }

  createRoomFromLobby() {
    const typedName = (this.el["lobby-room-name-input"]?.value || "").trim();
    this.createLongLivedRoom({ freshKey: false, roomNameOverride: typedName });
  }

  async joinRoomFromLobby() {
    const raw = (this.el["lobby-room-link-input"]?.value || "").trim();
    if (!raw) {
      this.showNotice("lobby-notice", "warn", "Paste a room invite link first.");
      return;
    }
    this.el["lobby-notice"]?.classList.add("hidden");
    this.el["lobby-passphrase-box"]?.classList.add("hidden");

    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      const decoded = this.wasm.call({
        cmd: "decode_signal",
        input: raw,
        passphrase: passInput || undefined,
      });
      if (decoded.signal.kind === "offer") {
        this.el["lobby-room-link-input"].value = "";
        this.setAdvancedMode(true);
        await this.handleJoinOfferSubmit(raw);
        return;
      }
      if (decoded.signal.kind === "answer") {
        this.el["lobby-room-link-input"].value = "";
        this.setAdvancedMode(true);
        await this.handleHostAnswerSubmit(raw);
        return;
      }
    } catch {
      // Fall through to joinLongLivedRoomLink so passphrase prompt / clean error notice displays
    }

    await this.joinLongLivedRoomLink(raw);
  }

  async unlockRoomFromLobby() {
    const pass = this.el["lobby-passphrase-input"]?.value || "";
    if (!pass) {
      this.showNotice("lobby-notice", "warn", "Enter the shared room passphrase.");
      return;
    }
    this.el["e2ee-passphrase-input"].value = pass;
    this.el["lobby-passphrase-input"].value = "";
    await this.applyPassphrase();
  }

  /* ================= Theme & Chat Media Helpers ================= */

  initTheme() {
    const current =
      document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    this.applyTheme(current, /* persist = */ false);
  }

  applyTheme(theme, persist = true) {
    const isDark = theme === "dark";
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", isDark ? "dark" : "light");
    void root.offsetHeight;
    root.classList.remove("theme-switching");
    if (this.el["icon-moon"] && this.el["icon-sun"]) {
      this.el["icon-moon"].classList.toggle("hidden", isDark);
      this.el["icon-sun"].classList.toggle("hidden", !isDark);
    }
    if (this.el["btn-theme-toggle"]) {
      const label = isDark ? "Switch to light mode" : "Switch to dark mode";
      this.el["btn-theme-toggle"].title = label;
      this.el["btn-theme-toggle"].setAttribute("aria-label", label);
    }
    if (persist) {
      try {
        sessionStorage.setItem("p2p-direct-theme", isDark ? "dark" : "light");
      } catch {
        // ignore storage restrictions
      }
    }
    if (this.status) {
      this.renderTopology();
    }
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    this.applyTheme(current === "dark" ? "light" : "dark", true);
  }

  async addPendingImageFiles(files) {
    this.el["composer-error"].classList.add("hidden");
    for (const file of files) {
      if (this.pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
        this.showComposerError(`Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`);
        break;
      }
      const usedChars = this.pendingImages.reduce((sum, img) => sum + img.dataUrl.length, 0);
      const remainingChars = MAX_TOTAL_IMAGE_DATA_CHARS - usedChars;
      if (remainingChars < 8000) {
        this.showComposerError("Image attachment budget reached for this message — send it first.");
        break;
      }
      try {
        const budget = Math.min(54000, remainingChars);
        const compressed = await compressImageFile(file, budget);
        if (!SAFE_IMAGE_DATA_URL_RE.test(compressed.dataUrl)) {
          throw new Error("Unsupported image encoding");
        }
        this.pendingImages.push(compressed);
      } catch (err) {
        this.showComposerError(`Could not attach image: ${err.message}`);
      }
    }
    this.renderImageTray();
    this.el["chat-text-input"].focus();
  }

  removePendingImage(id) {
    this.pendingImages = this.pendingImages.filter((img) => img.id !== id);
    this.renderImageTray();
  }

  renderImageTray() {
    const tray = this.el["chat-image-tray"];
    if (!tray) return;
    if (this.pendingImages.length === 0) {
      tray.innerHTML = "";
      tray.classList.add("hidden");
      return;
    }
    tray.classList.remove("hidden");
    tray.innerHTML = this.pendingImages
      .map(
        (img) => `
        <div class="staged-image-chip" data-staged-img="${escapeHtml(img.id)}">
          <img src="${img.dataUrl}" alt="${escapeHtml(img.name)}" />
          <div class="staged-image-meta">
            <span class="staged-image-name">${escapeHtml(img.name)}</span>
            <span>${img.width}×${img.height} · ${formatByteSize(img.bytes)}</span>
          </div>
          <button type="button" class="staged-image-remove" data-remove-img="${escapeHtml(img.id)}" aria-label="Remove image">×</button>
        </div>
      `
      )
      .join("");
    for (const btn of tray.querySelectorAll("[data-remove-img]")) {
      btn.addEventListener("click", () => this.removePendingImage(btn.dataset.removeImg));
    }
  }

  openLightbox(src, alt) {
    if (!SAFE_IMAGE_DATA_URL_RE.test(src)) return;
    this.el["lightbox-img"].src = src;
    this.el["lightbox-img"].alt = alt || "Shared image";
    this.el["image-lightbox"].classList.remove("hidden");
  }

  closeLightbox() {
    this.el["image-lightbox"].classList.add("hidden");
    this.el["lightbox-img"].removeAttribute("src");
  }

  /* ================= Step-by-Step Connect Wizard Helpers ================= */

  resetWizard() {
    this.wizard = {
      mode: "idle",
      step: 1,
      hostCopied: false,
      joinCopied: false,
      peerName: "",
      offerMeta: "",
      answerMeta: "",
      offerHint: "",
      answerHint: "",
    };
    this.el["host-answer-input"].value = "";
    this.el["join-offer-input"].value = "";
    this.el["connect-notice"].classList.add("hidden");
    this.renderWizard();
    this.renderConnectBanners();
  }

  openJoinWizard() {
    this.wizard = {
      mode: "join",
      step: 1,
      hostCopied: false,
      joinCopied: false,
      peerName: "",
      offerMeta: "",
      answerMeta: "",
      offerHint: "",
      answerHint: "",
    };
    this.el["connect-notice"].classList.add("hidden");
    this.renderWizard();
    this.renderConnectBanners();
  }

  markHostInviteShared() {
    if (this.wizard.mode !== "host") return;
    this.wizard.hostCopied = true;
    if (this.wizard.step < 2) {
      this.wizard.step = 2;
    }
    this.renderWizard();
    this.el["host-answer-input"].focus();
  }

  markJoinReplyShared() {
    if (this.wizard.mode !== "join") return;
    this.wizard.joinCopied = true;
    if (this.wizard.step < 3) {
      this.wizard.step = 3;
    }
    this.renderWizard();
  }

  async pasteIntoField(fieldId, callback) {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        this.showNotice("connect-notice", "warn", "Clipboard is empty.");
        return;
      }
      this.el[fieldId].value = text.trim();
      await callback(text.trim());
    } catch {
      this.showNotice(
        "connect-notice",
        "warn",
        "Browser blocked clipboard read — paste into the box with Ctrl+V / Cmd+V."
      );
      this.el[fieldId].focus();
    }
  }

  renderWizard() {
    const w = this.wizard;
    const isIdle = w.mode === "idle";
    const isHost = w.mode === "host";
    const isJoin = w.mode === "join";

    this.el["room-link-card"].classList.toggle("hidden", !isIdle);
    this.el["wizard-role-picker"].classList.toggle("hidden", !isIdle);
    this.el["wizard-host-flow"].classList.toggle("hidden", !isHost);
    this.el["wizard-join-flow"].classList.toggle("hidden", !isJoin);
    this.el["btn-wizard-reset"].classList.toggle("hidden", isIdle);
    this.el["connect-panel-meta"].classList.toggle("hidden", !isIdle);

    if (isIdle) {
      this.el["connect-panel-title"].textContent = "Connect Peer";
      return;
    }

    const setStepVisual = (stepEl, badgeEl, num, state) => {
      stepEl.classList.remove("active", "done", "upcoming");
      stepEl.classList.add(state);
      badgeEl.textContent = state === "done" ? "✓" : String(num);
    };

    if (isHost) {
      this.el["connect-panel-title"].textContent = "Invite a Peer";
      const s1State = w.step > 1 || w.hostCopied ? "done" : "active";
      const s2State = w.step === 3 ? "done" : w.step === 2 || w.hostCopied ? "active" : "upcoming";
      const s3State = w.step === 3 ? "done" : "upcoming";

      setStepVisual(this.el["wizard-host-step-1"], this.el["host-step-1-badge"], 1, s1State);
      setStepVisual(this.el["wizard-host-step-2"], this.el["host-step-2-badge"], 2, s2State);
      setStepVisual(this.el["wizard-host-step-3"], this.el["host-step-3-badge"], 3, s3State);

      this.el["host-offer-meta"].textContent = w.offerMeta || "";
      if (w.offerHint) {
        this.el["host-step-1-hint"].textContent = w.offerHint;
      }
      this.el["btn-host-share"].classList.toggle("hidden", typeof navigator.share !== "function");

      // At Step 3 (connected), collapse steps 1 & 2 and reveal Step 3 celebration/actions
      const connected = w.step === 3;
      this.el["host-step-1-body"].classList.toggle("hidden", connected);
      this.el["host-step-2-body"].classList.toggle("hidden", connected);
      this.el["host-step-3-body"].classList.toggle("hidden", !connected);
      this.el["host-step-3-title"].textContent = connected
        ? `Connected to ${w.peerName || "Peer"} (E2EE)`
        : "Connected (E2EE)";
      this.el["host-step-3-detail"].textContent = connected
        ? `Direct encrypted channel open with ${w.peerName || "your peer"}. Any additional peers you invite will auto-mesh directly with each other.`
        : "";
      return;
    }

    if (isJoin) {
      this.el["connect-panel-title"].textContent = "Join with Invite";
      const connected = w.step === 3 && Boolean(w.peerName) && this.directPeers.size > 0 && !this.latestAnswer;
      const s1State = w.step > 1 ? "done" : "active";
      const s2State = connected ? "done" : w.step === 2 ? "active" : w.step === 3 ? "done" : "upcoming";
      const s3State = connected ? "done" : w.step === 3 ? "active" : "upcoming";

      setStepVisual(this.el["wizard-join-step-1"], this.el["join-step-1-badge"], 1, s1State);
      setStepVisual(this.el["wizard-join-step-2"], this.el["join-step-2-badge"], 2, s2State);
      setStepVisual(this.el["wizard-join-step-3"], this.el["join-step-3-badge"], 3, s3State);

      this.el["join-step-1-title"].textContent =
        w.step > 1 && w.peerName
          ? `Invite loaded from ${w.peerName}`
          : "Paste the invite you received";
      this.el["join-step-1-body"].classList.toggle("hidden", w.step > 1);

      this.el["join-answer-meta"].textContent = w.answerMeta || "";
      if (w.answerHint) {
        this.el["join-step-2-hint"].textContent = w.answerHint;
      }
      this.el["btn-join-share"].classList.toggle("hidden", typeof navigator.share !== "function");
      this.el["join-step-2-body"].classList.toggle("hidden", w.step === 1 || connected);

      if (connected) {
        this.el["join-step-3-title"].textContent = `Connected to ${w.peerName}`;
        this.el["join-step-3-detail"].textContent =
          `Direct encrypted connection is live with ${w.peerName}. Messages sync automatically and you can join Voice Chat anytime.`;
        this.el["join-step-3-body"].classList.remove("hidden");
      } else if (w.step === 3) {
        this.el["join-step-3-title"].textContent = `Waiting for ${w.peerName || "host"} to apply your reply…`;
        this.el["join-step-3-detail"].textContent = "";
        this.el["join-step-3-body"].classList.add("hidden");
      } else {
        this.el["join-step-3-title"].textContent = "Waiting for peer to connect";
        this.el["join-step-3-body"].classList.add("hidden");
      }
    }
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

      // Periodically advertise encrypted room presence so future joiners discover us even in background tabs
      if (this.activeRoom && this.roomRendezvous && this.keepaliveTickCount % 2 === 0) {
        this.announceRoomHello(this.directPeers.size === 0);
      }

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
      this.addTelemetry("keepalive", "Started background Web Worker keepalive (4s interval)");
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
    if (this.activeRoom && this.roomRendezvous) {
      this.announceRoomHello(true);
    }
    if (this.voice.inVoice && this.voice.audioCtx && this.voice.audioCtx.state === "suspended") {
      this.voice.audioCtx.resume().catch(() => {});
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
    for (const [pid, entry] of this.roomDialing.entries()) {
      if (now - entry.startedAt > 18_000) {
        try {
          entry.pc.close();
        } catch {
          // ignore
        }
        this.roomDialing.delete(pid);
      }
    }
    for (const [sid, ts] of this.seenRoomSignalIds.entries()) {
      if (now - ts > 60_000) {
        this.seenRoomSignalIds.delete(sid);
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
      connectedPeers: Array.from(this.directPeers.keys()),
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
          this.discoveredLocalMeshes.delete(msg.peerId);
          const existing = this.directPeers.get(msg.peerId);
          const remoteConnectedToUs =
            Array.isArray(msg.connectedPeers) && msg.connectedPeers.includes(this.status.peerId);
          const isHealthy =
            existing && existing.dc && existing.dc.readyState === "open" && remoteConnectedToUs;
          if (!isHealthy && !this.localDialing.has(msg.peerId) && !this.roomDialing.has(msg.peerId)) {
            if (this.status.peerId < msg.peerId) {
              this.startLocalAutoRejoinOffer(msg.peerId, msg.authorName, msg.pubKey);
            }
          }
        } else if (!msg.passphraseMode && !this.activeRoom && this.directPeers.size === 0 && this.logMessages.length === 0) {
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
        if (this.status.e2ee.passphraseMode) return;
        await this.handleLocalJoinRequest(msg.fromPeerId);
        break;
      }

      case "local-join-offer": {
        await this.handleLocalJoinOffer(msg.fromPeerId, msg.code);
        break;
      }

      case "deliver-answer": {
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
      const voiceDc = pc.createDataChannel("p2p-voice", { ordered: false, maxRetransmits: 0 });
      const early = this.earlyLocalIce.get(targetPeerId) || [];
      this.earlyLocalIce.delete(targetPeerId);
      const entry = {
        pc,
        dc,
        voiceDc,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        startedAt: Date.now(),
      };
      this.localDialing.set(targetPeerId, entry);
      this.attachVoiceDataChannel(targetPeerId, voiceDc);
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
        if (ev.channel.label === "p2p-voice") {
          this.attachVoiceDataChannel(msg.fromPeerId, ev.channel);
          return;
        }
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
      const voiceDc = pc.createDataChannel("p2p-voice", { ordered: false, maxRetransmits: 0 });
      this.pendingOffers.set(inviteId, { inviteId, pc, dc, voiceDc, code: "", url: "" });

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

  async applyPassphrase() {
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

      if (this.pendingRoomCode) {
        const pendingCode = this.pendingRoomCode;
        this.pendingRoomCode = null;
        await this.joinLongLivedRoomLink(pendingCode);
        return;
      }

      if (this.activeRoom) {
        this.activateCurrentMeshAsRoom({
          roomName: this.activeRoom.name,
          relay: this.activeRoom.relay,
          updateHash: true,
          silent: true,
        });
      }

      this.renderAll();
      this.broadcastMeshBeacon(true);
      this.addTelemetry(
        "e2ee",
        `Derived 256-bit key via PBKDF2-HMAC-SHA256 (${this.status.e2ee.keyFingerprint}); P2P1 codes are passphrase-encrypted`
      );
      this.showToast(`Passphrase encryption active · FP ${this.status.e2ee.keyFingerprint}`);
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
    if (this.activeRoom) {
      this.activateCurrentMeshAsRoom({
        roomName: this.activeRoom.name,
        relay: this.activeRoom.relay,
        updateHash: true,
        silent: true,
      });
    }
    this.renderAll();
    this.broadcastMeshBeacon(true);
    this.addTelemetry(
      "e2ee",
      `Switched to automatic 256-bit mesh key (${this.status.e2ee.keyFingerprint})`
    );
    this.showToast(`Auto 256-bit key active · FP ${this.status.e2ee.keyFingerprint}`);
  }

  switchComposerMode(mode) {
    const isChat = mode === "chat";
    this.composerMode = isChat ? "chat" : "json";
    this.el["mode-btn-chat"].classList.toggle("active", isChat);
    this.el["mode-btn-chat"].setAttribute("aria-selected", String(isChat));
    this.el["mode-btn-json"].classList.toggle("active", !isChat);
    this.el["mode-btn-json"].setAttribute("aria-selected", String(!isChat));
    this.el["chat-composer-form"].classList.toggle("hidden", !isChat);
    this.el["json-composer-form"].classList.toggle("hidden", isChat);
    this.el["chat-image-tray"].classList.toggle("hidden", !isChat || this.pendingImages.length === 0);
    this.el["composer-error"].classList.add("hidden");
    this.el["next-lamport-preview"].textContent = isChat
      ? "Paste images or links"
      : `next lamport: ${(this.status?.lamport || 0) + 1}`;
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
    this.addTelemetry(
      "storage",
      "Cleared local in-memory messages; click Sync Now to backfill from online peers"
    );
    this.renderAll();
    this.showToast("Cleared local view (online peers still hold active messages)");
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
    this.showToast(`Exported ${exp.snapshot.records.length} encrypted record(s)`);
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

  /* ================= Long-Lived Reusable Room Links & Encrypted Rendezvous ================= */

  _disconnectAllPeersForRoomSwitch() {
    if (this.voice.inVoice) {
      this.leaveVoiceChat(/* silent = */ true);
    }
    this.voice.joinOrder = [];
    this.voice.lastRosterKey = "";
    this.voice.renderedKeys.clear();

    for (const entry of this.roomDialing.values()) {
      try {
        entry.pc.close();
      } catch {
        // ignore
      }
    }
    this.roomDialing.clear();
    this.earlyRoomIce.clear();
    this.seenRoomSignalIds.clear();
    this.lastHelloReplyPerPeer.clear();

    for (const entry of this.localDialing.values()) {
      try {
        entry.pc.close();
      } catch {
        // ignore
      }
    }
    this.localDialing.clear();
    this.earlyLocalIce.clear();

    for (const entry of this.relayPeers.values()) {
      try {
        entry.pc.close();
      } catch {
        // ignore
      }
    }
    this.relayPeers.clear();
    this.earlyRelayIce.clear();

    for (const p of this.pendingOffers.values()) {
      try {
        p.dc.close();
        if (p.voiceDc) p.voiceDc.close();
        p.pc.close();
      } catch {
        // ignore
      }
    }
    this.pendingOffers.clear();
    this.latestOffer = null;

    for (const a of this.pendingAnswers.values()) {
      try {
        a.pc.close();
      } catch {
        // ignore
      }
    }
    this.pendingAnswers.clear();
    this.latestAnswer = null;

    const oldPeerIds = Array.from(this.directPeers.keys());
    for (const pid of oldPeerIds) {
      const entry = this.directPeers.get(pid);
      if (entry) {
        entry.superseded = true;
        try {
          entry.dc.onclose = null;
          entry.dc.onerror = null;
          entry.pc.onconnectionstatechange = null;
          entry.pc.oniceconnectionstatechange = null;
          entry.dc.close();
          if (entry.voiceDc) entry.voiceDc.close();
          entry.pc.close();
        } catch {
          // ignore
        }
      }
      this.directPeers.delete(pid);
    }
    for (const vdc of this.voiceChannels.values()) {
      try {
        vdc.close();
      } catch {
        // ignore
      }
    }
    this.voiceChannels.clear();

    for (const p of (this.status?.peers || []).slice()) {
      try {
        const res = this.wasm.call({ cmd: "peer_disconnected", peerId: p.peerId });
        this.status = res.status;
      } catch {
        // ignore
      }
    }
  }

  switchToMeshKey(newMeshKey, passphraseMode, roomName) {
    const cleanRoom = (roomName || "").trim() || "Shared Room";
    const sameKey =
      newMeshKey === this.profile.meshKey &&
      Boolean(passphraseMode) === Boolean(this.status.e2ee?.passphraseMode);

    if (sameKey) {
      if (cleanRoom && cleanRoom !== this.status.room) {
        const prof = this.wasm.call({ cmd: "set_profile", room: cleanRoom });
        this.status = prof.status;
        this.profile.room = cleanRoom;
      }
      return false;
    }

    this._disconnectAllPeersForRoomSwitch();
    this.discoveredLocalMeshes.clear();

    // Clear in-memory log before adopting the new room key; live peers in the target room backfill automatically
    this.wasm.call({ cmd: "clear_log" });
    const keyRes = this.wasm.call({
      cmd: "set_mesh_key",
      meshKey: newMeshKey,
      passphraseMode: Boolean(passphraseMode),
      entropy: randomBase64Url(32),
    });
    this.status = keyRes.status;

    const profRes = this.wasm.call({ cmd: "set_profile", room: cleanRoom });
    this.status = profRes.status;
    this.profile.meshKey = newMeshKey;
    this.profile.passphraseMode = Boolean(passphraseMode);
    this.profile.room = cleanRoom;
    this.refreshLogFromWasm();
    return true;
  }

  createLongLivedRoom({ freshKey = false, roomNameOverride = null } = {}) {
    const typedName =
      roomNameOverride !== null
        ? String(roomNameOverride).trim()
        : (this.el["room-name-input"]?.value || "").trim();
    const params = new URLSearchParams(window.location.search);
    const queryRelay = (params.get("relay") || "").trim() || null;

    let roomName = typedName;
    if (freshKey) {
      const freshMeshKey = randomBase64Url(32);
      if (!roomName) {
        roomName = `Room ${freshMeshKey.slice(0, 4).toUpperCase()}`;
      }
      this.switchToMeshKey(freshMeshKey, false, roomName);
    } else if (!roomName) {
      roomName =
        this.status.room && this.status.room !== "mesh-main" && this.status.room !== "default"
          ? this.status.room
          : "Shared Room";
    }

    if (this.el["room-name-input"]) {
      this.el["room-name-input"].value = "";
    }
    if (this.el["lobby-room-name-input"]) {
      this.el["lobby-room-name-input"].value = "";
    }
    this.el["connect-notice"].classList.add("hidden");
    this.el["lobby-notice"]?.classList.add("hidden");
    this.el["lobby-passphrase-box"]?.classList.add("hidden");
    this.activateCurrentMeshAsRoom({
      roomName,
      relay: queryRelay,
      updateHash: true,
      silent: false,
      joined: false,
    });
    this.broadcastMeshBeacon(true);
  }

  async joinLongLivedRoomLink(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) return false;
    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      const decoded = this.wasm.call({
        cmd: "decode_signal",
        input: trimmed,
        passphrase: passInput || undefined,
      });
      const sig = decoded.signal;
      if (sig.kind !== "room") {
        throw new Error(`Expected a room invite link, got '${sig.kind}'`);
      }

      let targetMeshKey = this.profile.meshKey;
      let targetPassMode = Boolean(this.status.e2ee?.passphraseMode);
      if (!sig.encrypted && sig.meshKey) {
        targetMeshKey = sig.meshKey;
        targetPassMode = false;
      } else if (sig.encrypted) {
        if (passInput && !targetPassMode) {
          const passRes = this.wasm.call({
            cmd: "set_passphrase",
            passphrase: passInput,
            entropy: randomBase64Url(32),
          });
          targetMeshKey = passRes.meshKey;
          targetPassMode = true;
        }
      }

      this.pendingRoomCode = null;
      const roomName =
        sig.room && sig.room !== "default" && sig.room !== "mesh-main"
          ? sig.room
          : "Shared Room";
      this.switchToMeshKey(targetMeshKey, targetPassMode, roomName);

      const params = new URLSearchParams(window.location.search);
      const effectiveRelay = (params.get("relay") || "").trim() || sig.relay || null;

      this.el["connect-notice"].classList.add("hidden");
      this.el["lobby-notice"]?.classList.add("hidden");
      this.el["lobby-passphrase-box"]?.classList.add("hidden");
      if (this.el["lobby-room-link-input"]) {
        this.el["lobby-room-link-input"].value = "";
      }
      this.activateCurrentMeshAsRoom({
        roomName,
        relay: effectiveRelay,
        updateHash: true,
        silent: false,
        joined: true,
      });
      this.broadcastMeshBeacon(true);
      return true;
    } catch (err) {
      const msg = err?.message || "Invalid room link";
      if (msg.toLowerCase().includes("passphrase")) {
        this.pendingRoomCode = trimmed;
        this.el["e2ee-key-details"].open = true;
        if (this.advancedMode) {
          this.el["e2ee-passphrase-input"].focus();
        } else if (this.el["lobby-passphrase-box"]) {
          this.el["lobby-passphrase-box"].classList.remove("hidden");
          this.el["lobby-passphrase-input"]?.focus();
        }
      }
      this.showNotice("connect-notice", "error", msg);
      if (this.el["lobby-notice"]) {
        this.showNotice("lobby-notice", "error", msg);
      }
      this.syncLayoutAttributes();
      return false;
    }
  }

  activateCurrentMeshAsRoom({
    roomName,
    relay = null,
    updateHash = true,
    silent = false,
    joined = false,
  } = {}) {
    const cleanName = (roomName || this.status.room || "Shared Room").trim() || "Shared Room";
    const encoded = this.wasm.call({
      cmd: "encode_room_invite",
      room: cleanName,
      relay: relay || undefined,
      baseUrl: shareableBaseUrl(),
      entropy: randomBase64Url(16),
    });
    this.status = encoded.status;
    this.activeRoom = {
      name: encoded.room,
      code: encoded.code,
      url: encoded.url,
      topic: encoded.roomTopic,
      relay: relay || null,
      encrypted: Boolean(encoded.encrypted),
    };
    this.profile.room = encoded.room;

    if (updateHash) {
      try {
        history.replaceState(null, "", `${basePageUrl()}#room=${encoded.code}`);
      } catch {
        // ignore restricted history API
      }
    }

    this.startRoomRendezvous(encoded.roomTopic, relay);
    this.renderAll();

    this.addTelemetry(
      "room",
      `${joined ? "Joined" : "Created"} long-lived room "${encoded.room}" (topic ${encoded.roomTopic.slice(0, 10)}…)`
    );
    if (!silent) {
      this.showToast(
        joined
          ? `Joined "${encoded.room}" — connecting to peers automatically`
          : `Room link ready for "${encoded.room}"`
      );
    }
  }

  leaveLongLivedRoom() {
    this.stopPreCallMicMonitor();
    if (this.roomRendezvous) {
      this.roomRendezvous.stop();
      this.roomRendezvous = null;
    }
    this.activeRoom = null;
    this.pendingRoomCode = null;
    this.roomRelayStatus = { state: "stopped", connectedCount: 0, totalCount: 0 };
    this.el["lobby-notice"]?.classList.add("hidden");
    this.el["lobby-passphrase-box"]?.classList.add("hidden");
    // Disconnect from the room and wipe in-memory messages so leaving leaves zero trace
    this.switchToMeshKey(randomBase64Url(32), false, "mesh-main");
    try {
      history.replaceState(null, "", basePageUrl());
    } catch {
      // ignore
    }
    this.renderAll();
    this.addTelemetry("room", "Left room and cleared in-memory session");
    this.showToast("Left room — local messages cleared");
  }

  startRoomRendezvous(roomTopic, customRelay) {
    const urls = resolveRelayUrls(customRelay);
    if (
      this.roomRendezvous &&
      this.roomRendezvous.roomTopic === roomTopic &&
      JSON.stringify(this.roomRendezvous.urls) === JSON.stringify(urls)
    ) {
      this.announceRoomHello(true);
      return;
    }
    if (this.roomRendezvous) {
      this.roomRendezvous.stop();
      this.roomRendezvous = null;
    }

    this.roomRendezvous = new MultiRelayRendezvous({
      roomTopic,
      urls,
      onMessage: (sealedPayload) => {
        this.handleSealedRoomSignal(sealedPayload);
      },
      onBrokerReady: (_client, status) => {
        this.roomRelayStatus = status;
        this.renderRoomCard();
        this.announceRoomHello(true);
      },
      onStatusChange: (status) => {
        this.roomRelayStatus = status;
        this.renderRoomCard();
      },
    });
    this.roomRendezvous.start();
  }

  sendRoomSignal(msgObj) {
    if (!this.activeRoom || !this.roomRendezvous || !this.wasm) return;
    try {
      const enriched = msgObj.sid ? msgObj : { ...msgObj, sid: randomId("rs") };
      const sealedRes = this.wasm.call({
        cmd: "seal_room_signal",
        payload: JSON.stringify(enriched),
        entropy: randomBase64Url(16),
      });
      this.roomRendezvous.publish(sealedRes.sealed);
    } catch {
      // ignore serialization/seal errors during teardown
    }
  }

  announceRoomHello(requestReply) {
    if (!this.activeRoom || !this.roomRendezvous || !this.status) return;
    this.sendRoomSignal({
      t: "hello",
      from: this.status.peerId,
      name: this.status.authorName,
      pk: this.status.e2ee.publicKey,
      peers: Array.from(this.directPeers.keys()),
      reply: Boolean(requestReply),
      ts: Date.now(),
    });
  }

  async handleSealedRoomSignal(sealedPayload) {
    if (!this.activeRoom || !this.wasm || !this.status) return;
    let msg;
    try {
      const opened = this.wasm.call({
        cmd: "open_room_signal",
        sealed: sealedPayload,
      });
      msg = JSON.parse(opened.payload);
    } catch {
      // Ignore undecryptable or tampered packets from unrelated peers
      return;
    }

    if (!msg || typeof msg !== "object" || !msg.t || msg.from === this.status.peerId) {
      return;
    }
    if (msg.to && msg.to !== this.status.peerId) {
      return;
    }
    if (msg.sid) {
      if (this.seenRoomSignalIds.has(msg.sid)) {
        return;
      }
      this.seenRoomSignalIds.set(msg.sid, Date.now());
    }

    switch (msg.t) {
      case "hello": {
        if (!msg.from || !msg.pk) return;
        const existing = this.directPeers.get(msg.from);
        const remoteConnectedToUs =
          Array.isArray(msg.peers) && msg.peers.includes(this.status.peerId);
        const isHealthy =
          existing && existing.dc && existing.dc.readyState === "open" && remoteConnectedToUs;

        const now = Date.now();
        const lastReply = this.lastHelloReplyPerPeer.get(msg.from) || 0;
        if ((msg.reply || (!isHealthy && this.status.peerId > msg.from)) && now - lastReply >= 1400) {
          this.lastHelloReplyPerPeer.set(msg.from, now);
          this.announceRoomHello(false);
        }

        if (
          !isHealthy &&
          !this.roomDialing.has(msg.from) &&
          !this.localDialing.has(msg.from) &&
          !this.relayPeers.has(msg.from)
        ) {
          if (this.status.peerId < msg.from) {
            this.startRoomOffer(msg.from, msg.name || "Peer", msg.pk);
          }
        }
        break;
      }

      case "offer": {
        await this.acceptRoomOffer(msg);
        break;
      }

      case "answer": {
        await this.applyRoomAnswer(msg);
        break;
      }

      case "ice": {
        await this.applyRoomIce(msg.from, msg.cand);
        break;
      }

      default:
        break;
    }
  }

  async startRoomOffer(targetPeerId, targetName, targetPubKey) {
    if (this.roomDialing.has(targetPeerId) || this.localDialing.has(targetPeerId)) return;
    try {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      const dc = pc.createDataChannel("p2p-mesh", { ordered: true });
      const voiceDc = pc.createDataChannel("p2p-voice", { ordered: false, maxRetransmits: 0 });
      const early = this.earlyRoomIce.get(targetPeerId) || [];
      this.earlyRoomIce.delete(targetPeerId);

      const entry = {
        pc,
        dc,
        voiceDc,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        startedAt: Date.now(),
      };
      this.roomDialing.set(targetPeerId, entry);
      this.attachVoiceDataChannel(targetPeerId, voiceDc);
      this.attachDataChannel(pc, dc, targetPeerId, targetName, targetPubKey, false, null, true);

      const sendIce = (candJson) => {
        this.sendRoomSignal({
          t: "ice",
          from: this.status.peerId,
          to: targetPeerId,
          cand: candJson,
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

      this.sendRoomSignal({
        t: "offer",
        from: this.status.peerId,
        to: targetPeerId,
        name: this.status.authorName,
        pk: this.status.e2ee.publicKey,
        sdp: offer.sdp,
      });

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }
      this.addTelemetry("room", `Dialing ${targetName} (${targetPeerId}) via encrypted room link`);
    } catch {
      this.roomDialing.delete(targetPeerId);
    }
  }

  async acceptRoomOffer(msg) {
    if (!msg.from || !msg.sdp || !msg.pk) return;
    const prev = this.roomDialing.get(msg.from);
    if (prev) {
      try {
        prev.pc.close();
      } catch {
        // ignore
      }
      this.roomDialing.delete(msg.from);
    }
    try {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      const early = this.earlyRoomIce.get(msg.from) || [];
      this.earlyRoomIce.delete(msg.from);

      const entry = {
        pc,
        dc: null,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        startedAt: Date.now(),
      };
      this.roomDialing.set(msg.from, entry);

      pc.ondatachannel = (ev) => {
        if (ev.channel.label === "p2p-voice") {
          this.attachVoiceDataChannel(msg.from, ev.channel);
          return;
        }
        entry.dc = ev.channel;
        this.attachDataChannel(
          pc,
          ev.channel,
          msg.from,
          msg.name || "Peer",
          msg.pk,
          false,
          null,
          true
        );
      };

      const sendIce = (candJson) => {
        this.sendRoomSignal({
          t: "ice",
          from: this.status.peerId,
          to: msg.from,
          cand: candJson,
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

      this.sendRoomSignal({
        t: "answer",
        from: this.status.peerId,
        to: msg.from,
        name: this.status.authorName,
        pk: this.status.e2ee.publicKey,
        sdp: answer.sdp,
      });

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }
    } catch {
      this.roomDialing.delete(msg.from);
    }
  }

  async applyRoomAnswer(msg) {
    const entry = this.roomDialing.get(msg.from);
    if (!entry || !msg.sdp) return;
    try {
      if (entry.pc.signalingState === "have-local-offer") {
        await entry.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        entry.remoteDescSet = true;
        await this.flushPendingIce(entry);
      }
    } catch {
      // ignore race
    }
  }

  async applyRoomIce(fromPeerId, candidate) {
    if (!fromPeerId || !candidate) return;
    const entry = this.roomDialing.get(fromPeerId);
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
      const list = this.earlyRoomIce.get(fromPeerId) || [];
      list.push(candidate);
      this.earlyRoomIce.set(fromPeerId, list);
      return;
    }
    if (!entry.remoteDescSet) {
      entry.pendingIce.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      // ignore benign ICE errors
    }
  }

  /* ================= URL Fragments & Guided Signal Handling ================= */

  async handleUrlHashFragment() {
    const hash = window.location.hash;
    if (!hash || hash.length < 4) return;
    try {
      const frag = this.wasm.call({ cmd: "extract_fragment", hash });
      if (!frag.found) return;

      if (frag.kind === "room") {
        await this.joinLongLivedRoomLink(frag.code);
        return;
      }

      try {
        history.replaceState(null, "", basePageUrl());
      } catch {
        // ignore restricted history API
      }

      if (frag.kind === "offer") {
        if (!this.advancedMode) {
          this.setAdvancedMode(true);
        }
        this.openJoinWizard();
        await this.acceptManualOffer(frag.code);
      } else if (frag.kind === "answer") {
        if (!this.advancedMode) {
          this.setAdvancedMode(true);
        }
        await this.handleIncomingAnswerUrlOrCode(frag.code, /* fromHash = */ true);
      }
    } catch (err) {
      this.addTelemetry("error", `Fragment parse failed: ${err.message}`);
    }
  }

  async handleHostAnswerSubmit(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      this.showNotice("connect-notice", "warn", "Paste your peer's #answer= reply link or P2P1: reply code first.");
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
      this.handleDecodeFailure(err, trimmed);
      return;
    }

    if (decoded.signal.kind === "room") {
      this.resetWizard();
      await this.joinLongLivedRoomLink(trimmed);
      return;
    }

    if (decoded.signal.kind === "offer") {
      this.showNotice(
        "connect-notice",
        "warn",
        "That looks like an Invite (#offer=), not a Reply. Switching to 'Join with Invite' to accept it…"
      );
      this.openJoinWizard();
      await this.acceptManualOffer(trimmed);
      return;
    }
    await this.completeManualOffer(trimmed);
  }

  async handleJoinOfferSubmit(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      this.showNotice("connect-notice", "warn", "Paste a room link, #offer= link, or P2P1: code first.");
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
      this.handleDecodeFailure(err, trimmed);
      return;
    }

    if (decoded.signal.kind === "room") {
      this.resetWizard();
      await this.joinLongLivedRoomLink(trimmed);
      return;
    }

    if (decoded.signal.kind === "answer") {
      await this.handleIncomingAnswerUrlOrCode(trimmed, false);
      return;
    }
    await this.acceptManualOffer(trimmed);
  }

  async handleIncomingAnswerUrlOrCode(trimmed, fromHash) {
    let sig;
    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      const decoded = this.wasm.call({
        cmd: "decode_signal",
        input: trimmed,
        passphrase: passInput || undefined,
      });
      sig = decoded.signal;
    } catch (err) {
      this.handleDecodeFailure(err);
      return;
    }

    const hasLocalPending =
      (sig.inviteId && this.pendingOffers.has(sig.inviteId)) ||
      this.pendingOffers.size === 1 ||
      (this.latestOffer && this.pendingOffers.has(this.latestOffer.inviteId));

    if (hasLocalPending) {
      this.wizard.mode = "host";
      this.wizard.hostCopied = true;
      this.wizard.step = 2;
      this.renderWizard();
      await this.completeManualOffer(trimmed);
    } else if (this.bc) {
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
          : "That's a Reply (#answer=) for another tab — forwarded it to open tabs in this browser."
      );
    } else {
      this.showNotice(
        "connect-notice",
        "warn",
        "That's a Reply (#answer=). Paste it into Step 2 of the tab that created the invite."
      );
    }
  }

  handleDecodeFailure(err, rawInput = "") {
    const msg = err?.message || "Invalid P2P1 signal code";
    if (msg.toLowerCase().includes("passphrase")) {
      if (rawInput && (rawInput.includes("#room=") || rawInput.includes("#join="))) {
        this.pendingRoomCode = rawInput;
      }
      this.el["e2ee-key-details"].open = true;
      this.el["e2ee-passphrase-input"].focus();
    }
    this.showNotice("connect-notice", "error", msg);
  }

  /* ================= Manual Out-of-Band E2EE P2P1 Handshake ================= */

  async createManualInvite(isRejoin = false) {
    this.el["btn-wizard-start-host"].disabled = true;
    this.latestOffer = null;
    this.wizard = {
      mode: "host",
      step: 1,
      hostCopied: false,
      joinCopied: false,
      peerName: "",
      offerMeta: "preparing…",
      answerMeta: "",
      offerHint: "Preparing direct invite link…",
      answerHint: "",
    };
    this.el["host-offer-code"].value = "";
    this.el["host-answer-input"].value = "";
    this.el["connect-notice"].classList.add("hidden");
    this.renderWizard();
    this.renderConnectBanners();

    try {
      const inviteId = randomId("inv");
      const pc = new RTCPeerConnection(ICE_CONFIG);
      const dc = pc.createDataChannel("p2p-mesh", { ordered: true });
      const voiceDc = pc.createDataChannel("p2p-voice", { ordered: false, maxRetransmits: 0 });
      const pending = { inviteId, pc, dc, voiceDc, code: "", url: "" };
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

      this.wizard.offerMeta = `${encoded.rawBytes}B → ${encoded.codeChars} chars${encoded.encrypted ? " · AEAD" : ""}`;
      this.wizard.offerHint = encoded.encrypted
        ? "Passphrase-encrypted invite ready. Copy and send it to your peer."
        : isRejoin
          ? `Send this rejoin invite to any surviving peer in your mesh (FP ${this.status.e2ee.keyFingerprint}).`
          : `Copy and send this invite link to your peer (FP ${this.status.e2ee.keyFingerprint}).`;
      this.el["host-offer-code"].value = encoded.code;
      this.renderWizard();
      this.addTelemetry(
        "signal",
        `Generated ${isRejoin ? "rejoin " : ""}${encoded.encrypted ? "passphrase-encrypted " : ""}P2P1 offer ${inviteId} (${encoded.codeChars} chars)`
      );
    } catch (err) {
      this.showNotice("connect-notice", "error", `Failed to create invite: ${err.message}`);
    } finally {
      this.el["btn-wizard-start-host"].disabled = false;
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
    this.el["btn-join-create-reply"].disabled = true;
    this.latestAnswer = null;
    if (!silentUi) {
      this.showNotice("connect-notice", "info", "Decoding invite and preparing reply link…");
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
        this.renderHeader();
      }

      const pc = new RTCPeerConnection(ICE_CONFIG);
      pc.ondatachannel = (ev) => {
        if (ev.channel.label === "p2p-voice") {
          this.attachVoiceDataChannel(sig.peerId, ev.channel);
          return;
        }
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
        peerName: sig.authorName,
        inviteId: sig.inviteId || "",
      };
      this.pendingAnswers.set(sig.peerId, { pc, ...result });
      this.latestAnswer = result;

      if (!silentUi) {
        this.wizard.mode = "join";
        this.wizard.step = 2;
        this.wizard.joinCopied = false;
        this.wizard.peerName = sig.authorName || sig.peerId;
        this.wizard.answerMeta = `${encoded.rawBytes}B → ${encoded.codeChars} chars${encoded.encrypted ? " · AEAD" : ""}`;
        this.wizard.answerHint = `Copy and send this reply link back to ${sig.authorName}. As soon as they paste or click it, you'll connect automatically.`;
        this.el["join-answer-code"].value = encoded.code;
        this.el["join-offer-input"].value = "";
        this.el["connect-notice"].classList.add("hidden");
        this.renderWizard();
        this.renderConnectBanners();
      }
      this.addTelemetry("signal", `Created E2EE P2P1 reply for ${sig.authorName} (${sig.peerId})`);
      return result;
    } catch (err) {
      if (!silentUi) {
        this.handleDecodeFailure(err);
      }
      return null;
    } finally {
      this.el["btn-join-create-reply"].disabled = false;
    }
  }

  async completeManualOffer(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      this.showNotice("connect-notice", "warn", "Paste the peer's P2P1: reply code or #answer= link first.");
      return false;
    }
    this.el["btn-host-apply-answer"].disabled = true;
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
        throw new Error("No matching pending invite found. Click 'Invite a Peer' first.");
      }

      this.pendingOffers.delete(pending.inviteId);
      if (this.latestOffer && this.latestOffer.inviteId === pending.inviteId) {
        this.latestOffer = null;
      }

      if (pending.voiceDc) {
        this.attachVoiceDataChannel(sig.peerId, pending.voiceDc);
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

      this.el["host-answer-input"].value = "";
      this.showNotice(
        "connect-notice",
        "info",
        `Connecting directly to ${sig.authorName}…`
      );
      this.addTelemetry("signal", `Applied P2P1 answer from ${sig.authorName} (${sig.peerId})`);
      return true;
    } catch (err) {
      this.handleDecodeFailure(err);
      return false;
    } finally {
      this.el["btn-host-apply-answer"].disabled = false;
    }
  }

  /* ================= Personal Audio Settings & DSP Pipeline ================= */

  toggleAudioSettingsDrawer(forceOpen) {
    const next = typeof forceOpen === "boolean" ? forceOpen : !this.voice.settingsOpen;
    this.voice.settingsOpen = next;
    if (this.el["voice-settings-drawer"]) {
      this.el["voice-settings-drawer"].classList.toggle("hidden", !next);
    }
    if (this.el["btn-voice-settings"]) {
      this.el["btn-voice-settings"].setAttribute("aria-expanded", next ? "true" : "false");
    }
    if (next) {
      this.syncAudioSettingsUI();
      this.refreshAudioInputDevices();
    } else if (!this.voice.inVoice && this.voice.monitorActive) {
      this.stopPreCallMicMonitor();
    }
  }

  syncAudioSettingsUI() {
    const s = this.audioSettings;
    if (this.el["audio-mic-gain"]) {
      this.el["audio-mic-gain"].value = String(s.micGain);
    }
    if (this.el["audio-mic-gain-val"]) {
      this.el["audio-mic-gain-val"].textContent = `${s.micGain}%`;
    }
    if (this.el["audio-output-gain"]) {
      this.el["audio-output-gain"].value = String(s.outputGain);
    }
    if (this.el["audio-output-gain-val"]) {
      this.el["audio-output-gain-val"].textContent = `${s.outputGain}%`;
    }
    if (this.el["audio-noise-gate"]) {
      this.el["audio-noise-gate"].value = String(s.noiseGate);
    }
    if (this.el["audio-noise-gate-val"]) {
      this.el["audio-noise-gate-val"].textContent = s.noiseGate === 0 ? "Off" : `${s.noiseGate}%`;
    }
    if (this.el["audio-gate-marker"]) {
      const markerPct = Math.min(98, Math.round((s.noiseGate / 35) * 65));
      this.el["audio-gate-marker"].style.left = `${markerPct}%`;
      this.el["audio-gate-marker"].classList.toggle("hidden", s.noiseGate === 0);
    }
    if (this.el["audio-highpass"]) {
      this.el["audio-highpass"].value = String(s.highPassHz);
    }
    if (this.el["audio-highpass-val"]) {
      this.el["audio-highpass-val"].textContent = s.highPassHz === 0 ? "Off" : `${s.highPassHz} Hz`;
    }
    if (this.el["audio-presence"]) {
      this.el["audio-presence"].value = String(s.presenceDb);
    }
    if (this.el["audio-presence-val"]) {
      const sign = s.presenceDb > 0 ? "+" : "";
      this.el["audio-presence-val"].textContent = `${sign}${s.presenceDb} dB`;
    }
    if (this.el["audio-compressor"]) {
      this.el["audio-compressor"].checked = Boolean(s.compressor);
    }
    if (this.el["audio-ec"]) {
      this.el["audio-ec"].checked = Boolean(s.echoCancellation);
    }
    if (this.el["audio-ns"]) {
      this.el["audio-ns"].checked = Boolean(s.noiseSuppression);
    }
    if (this.el["audio-agc"]) {
      this.el["audio-agc"].checked = Boolean(s.autoGainControl);
    }
    for (const btn of document.querySelectorAll("[data-audio-preset]")) {
      btn.classList.toggle("active", btn.dataset.audioPreset === s.preset);
    }
    if (this.el["btn-audio-monitor"]) {
      this.el["btn-audio-monitor"].classList.toggle("is-active", this.voice.monitorActive);
      this.el["btn-audio-monitor"].setAttribute(
        "aria-pressed",
        this.voice.monitorActive ? "true" : "false"
      );
      this.el["btn-audio-monitor"].textContent = this.voice.monitorActive ? "Stop Test" : "Test Mic";
    }
  }

  async refreshAudioInputDevices() {
    const select = this.el["audio-input-select"];
    if (!select) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === "audioinput");
      this.voice.audioDevices = mics;
      const current = this.audioSettings.deviceId || "";
      const opts = ['<option value="">Default Microphone</option>'];
      mics.forEach((d, idx) => {
        if (!d.deviceId || d.deviceId === "default") return;
        const label = d.label && d.label.trim() ? d.label.trim() : `Microphone ${idx + 1}`;
        opts.push(`<option value="${escapeHtml(d.deviceId)}">${escapeHtml(label)}</option>`);
      });
      select.innerHTML = opts.join("");
      if (current && mics.some((d) => d.deviceId === current)) {
        select.value = current;
      } else {
        select.value = "";
      }
    } catch {
      // ignore permission/device enumeration errors
    }
  }

  applyAudioPreset(presetName) {
    const preset = AUDIO_PRESETS[presetName];
    if (!preset) return;
    this.audioSettings = saveSessionAudioSettings({
      ...this.audioSettings,
      ...preset,
    });
    this.syncAudioSettingsUI();
    this.applyLiveAudioDspParams(true);
    this.applyMicTrackConstraints();
    this.showToast(
      `Audio preset: ${presetName === "raw" ? "Raw / Music" : presetName[0].toUpperCase() + presetName.slice(1)}`
    );
  }

  resetAudioSettings() {
    this.audioSettings = saveSessionAudioSettings({
      ...DEFAULT_AUDIO_SETTINGS,
      deviceId: this.audioSettings.deviceId || "",
    });
    this.syncAudioSettingsUI();
    this.applyLiveAudioDspParams(true);
    this.applyMicTrackConstraints();
    this.showToast("Audio settings reset to defaults");
  }

  updateAudioSetting(
    key,
    value,
    { reconnectMic = false, rewireGraph = false, applyTrackConstraints = false, keepPreset = false } = {}
  ) {
    const next = {
      ...this.audioSettings,
      [key]: value,
    };
    if (!keepPreset) {
      next.preset = "custom";
    }
    this.audioSettings = saveSessionAudioSettings(next);
    this.syncAudioSettingsUI();
    this.applyLiveAudioDspParams(rewireGraph);
    if (applyTrackConstraints) {
      this.applyMicTrackConstraints();
    }
    if (reconnectMic) {
      this.switchActiveMicrophone();
    }
  }

  buildMicConstraints() {
    const s = this.audioSettings;
    const audio = {
      echoCancellation: Boolean(s.echoCancellation),
      noiseSuppression: Boolean(s.noiseSuppression),
      autoGainControl: Boolean(s.autoGainControl),
      channelCount: 1,
    };
    if (s.deviceId) {
      audio.deviceId = { ideal: s.deviceId };
    }
    return { audio, video: false };
  }

  async applyMicTrackConstraints() {
    const streams = [this.voice.micStream, this.voice.preCallMonitor?.stream].filter(Boolean);
    const s = this.audioSettings;
    for (const stream of streams) {
      for (const track of stream.getAudioTracks()) {
        if (typeof track.applyConstraints === "function") {
          try {
            await track.applyConstraints({
              echoCancellation: Boolean(s.echoCancellation),
              noiseSuppression: Boolean(s.noiseSuppression),
              autoGainControl: Boolean(s.autoGainControl),
            });
          } catch {
            // some browsers ignore live constraint updates cleanly
          }
        }
      }
    }
  }

  async switchActiveMicrophone() {
    if (this.voice.inVoice && !this.voice.listenOnly && this.voice.audioCtx) {
      try {
        const nextStream = await navigator.mediaDevices.getUserMedia(this.buildMicConstraints());
        for (const track of nextStream.getAudioTracks()) {
          track.enabled = !this.voice.muted;
        }
        const prevStream = this.voice.micStream;
        this.teardownMicCaptureGraph();
        this.voice.micStream = nextStream;
        await this.startMicCaptureGraph(this.voice.audioCtx, nextStream);
        if (prevStream) {
          for (const t of prevStream.getTracks()) {
            try {
              t.stop();
            } catch {
              // ignore
            }
          }
        }
        this.refreshAudioInputDevices();
        this.showToast("Switched microphone input");
      } catch (err) {
        this.showToast(`Could not switch microphone: ${err.message}`);
      }
    } else if (this.voice.preCallMonitor) {
      this.stopPreCallMicMonitor();
      await this.startPreCallMicMonitor();
    }
  }

  createMicDspNodes(ctx, source) {
    const highPass = ctx.createBiquadFilter();
    highPass.type = "highpass";
    highPass.Q.value = 0.707;

    const presence = ctx.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 2800;
    presence.Q.value = 1.1;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.12;

    const micGain = ctx.createGain();
    const monitorGain = ctx.createGain();
    monitorGain.gain.value = 0;

    return { source, highPass, presence, compressor, micGain, monitorGain };
  }

  wireDspChain(nodes, destinationNode, ctxDestination, enableMonitor) {
    const s = this.audioSettings;
    const { source, highPass, presence, compressor, micGain, monitorGain } = nodes;
    for (const n of [source, highPass, presence, compressor, micGain, monitorGain]) {
      try {
        n.disconnect();
      } catch {
        // ignore
      }
    }

    if (s.highPassHz > 0) {
      highPass.type = "highpass";
      highPass.frequency.value = s.highPassHz;
    } else {
      highPass.type = "allpass";
      highPass.frequency.value = 20;
    }

    presence.gain.value = s.presenceDb;
    micGain.gain.value = s.micGain / 100;
    monitorGain.gain.value = enableMonitor ? 0.7 : 0;

    source.connect(highPass);
    highPass.connect(presence);
    if (s.compressor) {
      presence.connect(compressor);
      compressor.connect(micGain);
    } else {
      presence.connect(micGain);
    }

    if (destinationNode) {
      micGain.connect(destinationNode);
    }
    if (ctxDestination) {
      micGain.connect(monitorGain);
      monitorGain.connect(ctxDestination);
    }
  }

  applyLiveAudioDspParams(rewire = false) {
    const s = this.audioSettings;
    if (this.voice.masterGain) {
      this.voice.masterGain.gain.value = this.voice.deafened ? 0 : s.outputGain / 100;
    }

    if (this.voice.micSource && this.voice.micGainNode && this.voice.audioCtx) {
      const nodes = {
        source: this.voice.micSource,
        highPass: this.voice.highPassFilter,
        presence: this.voice.presenceFilter,
        compressor: this.voice.compressorNode,
        micGain: this.voice.micGainNode,
        monitorGain: this.voice.monitorGain,
      };
      if (rewire) {
        this.wireDspChain(
          nodes,
          this.voice.captureNode,
          this.voice.audioCtx.destination,
          this.voice.monitorActive
        );
      } else {
        if (s.highPassHz > 0) {
          nodes.highPass.type = "highpass";
          nodes.highPass.frequency.value = s.highPassHz;
        } else {
          nodes.highPass.type = "allpass";
          nodes.highPass.frequency.value = 20;
        }
        nodes.presence.gain.value = s.presenceDb;
        nodes.micGain.gain.value = s.micGain / 100;
        nodes.monitorGain.gain.value = this.voice.monitorActive ? 0.7 : 0;
      }
    }

    const mon = this.voice.preCallMonitor;
    if (mon) {
      if (rewire) {
        this.wireDspChain(mon, mon.analyser, mon.ctx.destination, true);
      } else {
        if (s.highPassHz > 0) {
          mon.highPass.type = "highpass";
          mon.highPass.frequency.value = s.highPassHz;
        } else {
          mon.highPass.type = "allpass";
          mon.highPass.frequency.value = 20;
        }
        mon.presence.gain.value = s.presenceDb;
        mon.micGain.gain.value = s.micGain / 100;
        mon.monitorGain.gain.value = 0.7;
      }
    }
  }

  async toggleMicMonitor() {
    if (this.voice.inVoice) {
      if (this.voice.listenOnly || !this.voice.monitorGain) {
        this.showToast("Microphone test is unavailable in Listen-Only mode");
        return;
      }
      this.voice.monitorActive = !this.voice.monitorActive;
      this.voice.monitorGain.gain.value = this.voice.monitorActive ? 0.7 : 0;
      this.syncAudioSettingsUI();
      return;
    }

    if (this.voice.preCallMonitor) {
      this.stopPreCallMicMonitor();
    } else {
      await this.startPreCallMicMonitor();
    }
  }

  async startPreCallMicMonitor() {
    if (this.voice.preCallMonitor) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      this.showToast("Microphone capture is unavailable in this browser context");
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error("Web Audio API unsupported");
      const stream = await navigator.mediaDevices.getUserMedia(this.buildMicConstraints());
      const ctx = new AudioCtx();
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      const source = ctx.createMediaStreamSource(stream);
      const nodes = this.createMicDspNodes(ctx, source);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      this.wireDspChain(nodes, analyser, ctx.destination, true);

      const sampleBuf = new Float32Array(analyser.fftSize);
      const timer = setInterval(() => {
        if (!this.voice.preCallMonitor) return;
        analyser.getFloatTimeDomainData(sampleBuf);
        let sumSq = 0;
        for (let i = 0; i < sampleBuf.length; i++) {
          sumSq += sampleBuf[i] * sampleBuf[i];
        }
        const rmsInt16 = Math.round(Math.sqrt(sumSq / sampleBuf.length) * 32767);
        const gateThreshold = (this.audioSettings.noiseGate / 100) * 14000;
        const gated = this.audioSettings.noiseGate > 0 && rmsInt16 < gateThreshold;
        this.updateAudioMeterUi(rmsInt16, gated, "Testing");
      }, 65);

      this.voice.preCallMonitor = { ...nodes, ctx, stream, analyser, timer };
      this.voice.monitorActive = true;
      this.syncAudioSettingsUI();
      this.refreshAudioInputDevices();
    } catch (err) {
      this.stopPreCallMicMonitor();
      this.showToast(`Mic test error: ${err.message}`);
    }
  }

  stopPreCallMicMonitor() {
    const mon = this.voice.preCallMonitor;
    this.voice.preCallMonitor = null;
    if (!this.voice.inVoice) {
      this.voice.monitorActive = false;
    }
    if (mon) {
      if (mon.timer) clearInterval(mon.timer);
      for (const n of [
        mon.source,
        mon.highPass,
        mon.presence,
        mon.compressor,
        mon.micGain,
        mon.monitorGain,
        mon.analyser,
      ]) {
        try {
          n?.disconnect();
        } catch {
          // ignore
        }
      }
      if (mon.stream) {
        for (const t of mon.stream.getTracks()) {
          try {
            t.stop();
          } catch {
            // ignore
          }
        }
      }
      try {
        mon.ctx?.close();
      } catch {
        // ignore
      }
    }
    this.updateAudioMeterUi(0, false, "Idle");
    this.syncAudioSettingsUI();
  }

  updateAudioMeterUi(rmsInt16, gated, activeLabel = "Live") {
    const fill = this.el["audio-mic-meter-fill"];
    const status = this.el["audio-mic-meter-status"];
    if (!fill && !status) return;
    const pct = Math.min(100, Math.round((rmsInt16 / 7500) * 100));
    if (fill) {
      fill.style.width = `${pct}%`;
      fill.classList.toggle("is-gated", Boolean(gated));
      fill.classList.toggle("is-hot", !gated && pct > 82);
    }
    if (status) {
      if (!this.voice.inVoice && !this.voice.preCallMonitor) {
        status.textContent = "Idle";
        status.className = "audio-meter-status";
      } else if (this.voice.inVoice && (this.voice.muted || this.voice.listenOnly)) {
        status.textContent = this.voice.listenOnly ? "Listen-Only" : "Muted";
        status.className = "audio-meter-status";
      } else if (gated) {
        status.textContent = "Gated";
        status.className = "audio-meter-status is-gated";
      } else {
        status.textContent = activeLabel;
        status.className = "audio-meter-status is-live";
      }
    }
  }

  /* ================= Real-Time Multi-Peer E2EE Voice Chat ================= */

  attachVoiceDataChannel(peerId, voiceDc) {
    if (!voiceDc) return;
    voiceDc.binaryType = "arraybuffer";
    const prev = this.voiceChannels.get(peerId);
    if (prev && prev !== voiceDc) {
      try {
        prev.onmessage = null;
        prev.onclose = null;
        prev.onerror = null;
        prev.close();
      } catch {
        // ignore
      }
    }
    this.voiceChannels.set(peerId, voiceDc);
    const direct = this.directPeers.get(peerId);
    if (direct) {
      direct.voiceDc = voiceDc;
    }

    voiceDc.onmessage = (ev) => {
      this.handleIncomingVoicePacket(peerId, ev.data);
    };
    voiceDc.onclose = () => {
      if (this.voiceChannels.get(peerId) === voiceDc) {
        this.voiceChannels.delete(peerId);
      }
    };
    voiceDc.onerror = () => {
      // Unordered channel errors are non-fatal; close handler cleans up if needed
    };
  }

  ensureVoiceAudioContext() {
    if (!this.voice.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        throw new Error("Web Audio API is not supported in this browser.");
      }
      const ctx = new AudioCtx();
      const masterGain = ctx.createGain();
      masterGain.gain.value = this.voice.deafened ? 0 : this.audioSettings.outputGain / 100;
      masterGain.connect(ctx.destination);
      this.voice.audioCtx = ctx;
      this.voice.masterGain = masterGain;
    }
    if (this.voice.audioCtx.state === "suspended") {
      this.voice.audioCtx.resume().catch(() => {});
    }
    return this.voice.audioCtx;
  }

  ensurePeerVoiceMixer(peerId) {
    let mixer = this.voice.peerMixers.get(peerId);
    if (!mixer) {
      const ctx = this.ensureVoiceAudioContext();
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.0;
      gainNode.connect(this.voice.masterGain);
      mixer = {
        gainNode,
        volume: 1.0,
        muted: false,
        nextPlayTime: 0,
        rms: 0,
        smoothLevel: 0,
        lastAudioAt: 0,
        packetsReceived: 0,
      };
      this.voice.peerMixers.set(peerId, mixer);
    }
    return mixer;
  }

  async joinVoiceChat({ listenOnly = false } = {}) {
    if (this.voice.inVoice) return;
    this.stopPreCallMicMonitor();
    this.el["btn-voice-join"].disabled = true;
    this.el["btn-voice-listen"].disabled = true;
    this.el["voice-notice"].classList.add("hidden");

    try {
      const ctx = this.ensureVoiceAudioContext();
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      let micStream = null;
      let effectiveListenOnly = listenOnly;

      if (!listenOnly) {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
          throw new Error("Microphone capture is unavailable in this browser context. Try Listen Only.");
        }
        micStream = await navigator.mediaDevices.getUserMedia(this.buildMicConstraints());
      }

      this.voice.micStream = micStream;
      this.voice.listenOnly = effectiveListenOnly;
      this.voice.muted = effectiveListenOnly;
      this.voice.deafened = false;
      this.voice.inVoice = true;
      this.voice.monitorActive = false;
      this.voice.localRms = 0;
      this.voice.localSmoothLevel = 0;
      this.voice.localSpeakingAt = 0;
      this.voice.gateOpenUntil = 0;
      this.voice.gateClosed = false;
      this.voice.meterTicks = 0;

      if (this.voice.masterGain) {
        this.voice.masterGain.gain.value = this.audioSettings.outputGain / 100;
      }

      if (micStream) {
        await this.startMicCaptureGraph(ctx, micStream);
        this.refreshAudioInputDevices();
      }

      const res = this.wasm.call({
        cmd: "set_voice_state",
        inVoice: true,
        muted: this.voice.muted,
      });
      this.status = res.status;
      this.executeActions(res.actions);

      if (!this.voice.meterTimer) {
        this.voice.meterTimer = setInterval(() => this.updateVoiceMeters(), 70);
      }

      this.syncAudioSettingsUI();
      this.renderAll();
      this.showToast(
        effectiveListenOnly ? "Joined voice channel (listen-only)" : "Joined voice channel"
      );
    } catch (err) {
      this.cleanupVoiceAudioResources();
      this.voice.inVoice = false;
      this.showNotice(
        "voice-notice",
        "warn",
        `Could not start microphone: ${err.message}. You can still click "Listen Only" to hear peers.`
      );
      this.addTelemetry("error", `Voice join error: ${err.message}`);
    } finally {
      this.el["btn-voice-join"].disabled = false;
      this.el["btn-voice-listen"].disabled = false;
    }
  }

  teardownMicCaptureGraph() {
    if (this.voice.captureNode) {
      try {
        if (this.voice.captureNode.port) {
          this.voice.captureNode.port.onmessage = null;
        }
        this.voice.captureNode.disconnect();
      } catch {
        // ignore
      }
      this.voice.captureNode = null;
    }
    for (const key of [
      "micSource",
      "highPassFilter",
      "presenceFilter",
      "compressorNode",
      "micGainNode",
      "monitorGain",
      "silentGain",
    ]) {
      if (this.voice[key]) {
        try {
          this.voice[key].disconnect();
        } catch {
          // ignore
        }
        this.voice[key] = null;
      }
    }
  }

  async startMicCaptureGraph(ctx, micStream) {
    const source = ctx.createMediaStreamSource(micStream);
    const dspNodes = this.createMicDspNodes(ctx, source);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    silentGain.connect(ctx.destination);

    this.voice.micSource = dspNodes.source;
    this.voice.highPassFilter = dspNodes.highPass;
    this.voice.presenceFilter = dspNodes.presence;
    this.voice.compressorNode = dspNodes.compressor;
    this.voice.micGainNode = dspNodes.micGain;
    this.voice.monitorGain = dspNodes.monitorGain;
    this.voice.silentGain = silentGain;

    // Prefer modern off-main-thread AudioWorkletProcessor; fall back to ScriptProcessorNode cleanly
    let workletOk = false;
    if (ctx.audioWorklet && typeof AudioWorkletNode === "function") {
      try {
        const blob = new Blob([VOICE_CAPTURE_WORKLET_CODE], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const workletNode = new AudioWorkletNode(ctx, "p2p-voice-capture");
        workletNode.port.onmessage = (ev) => {
          if (ev.data instanceof Int16Array) {
            this.onCapturedPcmFrame(ev.data);
          } else if (ev.data && ev.data.buffer) {
            this.onCapturedPcmFrame(new Int16Array(ev.data.buffer));
          }
        };
        this.wireDspChain(dspNodes, workletNode, ctx.destination, this.voice.monitorActive);
        workletNode.connect(silentGain);
        this.voice.captureNode = workletNode;
        workletOk = true;
      } catch {
        workletOk = false;
      }
    }

    if (!workletOk && typeof ctx.createScriptProcessor === "function") {
      const proc = ctx.createScriptProcessor(1024, 1, 1);
      const step = ctx.sampleRate / VOICE_SAMPLE_RATE;
      let inBuf = [];
      let phase = 0;
      const frame = new Int16Array(VOICE_FRAME_SAMPLES);
      let frameIdx = 0;

      proc.onaudioprocess = (ev) => {
        if (!this.voice.inVoice) return;
        const ch = ev.inputBuffer.getChannelData(0);
        for (let i = 0; i < ch.length; i++) {
          inBuf.push(ch[i]);
        }
        while (phase + 1 < inBuf.length) {
          const idx = Math.floor(phase);
          const frac = phase - idx;
          const sample = inBuf[idx] * (1 - frac) + inBuf[idx + 1] * frac;
          const clamped = Math.max(-1, Math.min(1, sample));
          frame[frameIdx++] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
          phase += step;
          if (frameIdx >= VOICE_FRAME_SAMPLES) {
            this.onCapturedPcmFrame(frame.slice());
            frameIdx = 0;
          }
        }
        const drop = Math.floor(phase);
        if (drop > 0) {
          inBuf = inBuf.slice(drop);
          phase -= drop;
        }
      };
      this.wireDspChain(dspNodes, proc, ctx.destination, this.voice.monitorActive);
      proc.connect(silentGain);
      this.voice.captureNode = proc;
    }
  }

  onCapturedPcmFrame(int16Pcm) {
    if (!this.voice.inVoice || !this.wasm) return;
    const rawRms = this.voice.muted ? 0 : computePcmRms(int16Pcm);
    const now = Date.now();
    const gatePct = this.audioSettings.noiseGate;
    let gated = false;
    if (!this.voice.muted && gatePct > 0) {
      const thresholdRms = (gatePct / 100) * 14000;
      if (rawRms >= thresholdRms) {
        this.voice.gateOpenUntil = now + 180;
      }
      if (now > this.voice.gateOpenUntil) {
        gated = true;
      }
    }
    this.voice.gateClosed = gated;

    if (this.voice.settingsOpen) {
      this.updateAudioMeterUi(rawRms, gated, "Live");
    }

    if (gated) {
      this.voice.localRms = 0;
      return;
    }

    const { rms, packets } = this.wasm.sealVoicePcm(int16Pcm);
    this.voice.localRms = this.voice.muted ? 0 : rms;
    if (!this.voice.muted && rms > 220) {
      this.voice.localSpeakingAt = now;
    }
    for (const { peerId, data } of packets) {
      const vdc = this.voiceChannels.get(peerId);
      if (vdc && vdc.readyState === "open" && vdc.bufferedAmount < 16384) {
        try {
          vdc.send(data);
        } catch {
          // drop frame cleanly under congestion
        }
      }
    }
  }

  handleIncomingVoicePacket(peerId, rawData) {
    const direct = this.directPeers.get(peerId);
    if (direct) {
      direct.lastActivityMs = Date.now();
    }
    if (!this.voice.inVoice || !this.wasm) return;

    const processBytes = (pktBytes) => {
      if (!this.voice.inVoice || !this.wasm) return;
      const decoded = this.wasm.openVoicePacket(peerId, pktBytes);
      if (!decoded || !decoded.pcm || decoded.pcm.length === 0) return;

      const mixer = this.ensurePeerVoiceMixer(peerId);
      mixer.rms = decoded.rms;
      mixer.packetsReceived += 1;
      mixer.lastAudioAt = Date.now();

      if (this.voice.deafened || mixer.muted || !this.voice.audioCtx) {
        return;
      }

      const ctx = this.voice.audioCtx;
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }

      const buf = ctx.createBuffer(1, decoded.pcm.length, VOICE_SAMPLE_RATE);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < decoded.pcm.length; i++) {
        ch[i] = decoded.pcm[i] / 32768;
      }

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(mixer.gainNode);

      const now = ctx.currentTime;
      const targetBufferSec = 0.045;
      if (mixer.nextPlayTime < now + 0.005 || mixer.nextPlayTime > now + 0.25) {
        mixer.nextPlayTime = now + targetBufferSec;
      }
      src.start(mixer.nextPlayTime);
      mixer.nextPlayTime += buf.duration;
    };

    if (rawData instanceof ArrayBuffer) {
      processBytes(new Uint8Array(rawData));
    } else if (ArrayBuffer.isView(rawData)) {
      processBytes(new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength));
    } else if (typeof Blob !== "undefined" && rawData instanceof Blob) {
      rawData.arrayBuffer().then((ab) => processBytes(new Uint8Array(ab))).catch(() => {});
    }
  }

  toggleVoiceMute() {
    if (!this.voice.inVoice) return;
    if (this.voice.listenOnly) {
      this.showToast("Joined in Listen-Only mode — leave and click Join Voice to enable microphone");
      return;
    }
    this.voice.muted = !this.voice.muted;
    if (this.voice.micStream) {
      for (const track of this.voice.micStream.getAudioTracks()) {
        track.enabled = !this.voice.muted;
      }
    }
    if (this.voice.muted) {
      this.voice.localRms = 0;
      this.voice.localSmoothLevel = 0;
    }
    const res = this.wasm.call({
      cmd: "set_voice_state",
      inVoice: true,
      muted: this.voice.muted,
    });
    this.status = res.status;
    this.executeActions(res.actions);
    this.renderVoicePanel(true);
    this.renderHeader();
    this.updateVoiceMeters();
  }

  toggleVoiceDeafen() {
    if (!this.voice.inVoice) return;
    this.voice.deafened = !this.voice.deafened;
    if (this.voice.masterGain) {
      this.voice.masterGain.gain.value = this.voice.deafened ? 0 : this.audioSettings.outputGain / 100;
    }
    this.renderVoicePanel(true);
    this.updateVoiceMeters();
  }

  setPeerVoiceVolume(peerId, vol) {
    const mixer = this.voice.peerMixers.get(peerId) || (this.voice.inVoice ? this.ensurePeerVoiceMixer(peerId) : null);
    if (!mixer) return;
    mixer.volume = Math.max(0, Math.min(1.5, Number(vol) || 0));
    mixer.gainNode.gain.value = mixer.muted ? 0 : mixer.volume;
  }

  togglePeerVoiceMute(peerId) {
    const mixer = this.voice.peerMixers.get(peerId) || (this.voice.inVoice ? this.ensurePeerVoiceMixer(peerId) : null);
    if (!mixer) return;
    mixer.muted = !mixer.muted;
    mixer.gainNode.gain.value = mixer.muted ? 0 : mixer.volume;
    this.renderVoicePanel(true);
    this.updateVoiceMeters();
  }

  cleanupVoiceAudioResources() {
    if (this.voice.meterTimer) {
      clearInterval(this.voice.meterTimer);
      this.voice.meterTimer = null;
    }
    this.teardownMicCaptureGraph();
    this.voice.monitorActive = false;
    if (this.voice.micStream) {
      for (const track of this.voice.micStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this.voice.micStream = null;
    }
    for (const mixer of this.voice.peerMixers.values()) {
      try {
        mixer.gainNode.disconnect();
      } catch {
        // ignore
      }
    }
    this.voice.peerMixers.clear();
    if (this.voice.masterGain) {
      try {
        this.voice.masterGain.disconnect();
      } catch {
        // ignore
      }
      this.voice.masterGain = null;
    }
    if (this.voice.audioCtx) {
      try {
        this.voice.audioCtx.close();
      } catch {
        // ignore
      }
      this.voice.audioCtx = null;
    }
    this.updateAudioMeterUi(0, false, "Idle");
    this.syncAudioSettingsUI();
  }

  leaveVoiceChat(silent = false) {
    if (!this.voice.inVoice) return;
    this.cleanupVoiceAudioResources();
    this.voice.inVoice = false;
    this.voice.muted = false;
    this.voice.deafened = false;
    this.voice.listenOnly = false;
    this.voice.localRms = 0;
    this.voice.localSmoothLevel = 0;
    this.voice.gateClosed = false;
    this.voice.joinOrder = this.voice.joinOrder.filter((id) => id !== "self");
    this.voice.renderedKeys.delete("self");
    this.voice.lastRosterKey = "";

    if (this.wasm) {
      try {
        const res = this.wasm.call({
          cmd: "set_voice_state",
          inVoice: false,
          muted: false,
        });
        this.status = res.status;
        this.executeActions(res.actions);
      } catch {
        // ignore during teardown
      }
    }
    if (!silent) {
      this.el["voice-notice"].classList.add("hidden");
      this.renderAll();
      this.showToast("Left voice channel");
    }
  }

  _applySpeakerVisualizer(rowKey, level, defaultStateLabel, tickPhase) {
    const list = this.el["voice-participant-list"];
    const selector = rowKey === "self" ? "self" : CSS.escape(rowKey);
    const card = list.querySelector(`[data-voice-row="${selector}"]`);
    if (!card) return;
    const speaking = level > 0.09;
    card.style.setProperty("--voice-level", level.toFixed(3));
    card.classList.toggle("is-speaking", speaking);

    const stateEl = card.querySelector("[data-voice-state]");
    if (stateEl) {
      stateEl.textContent = speaking ? "Speaking" : defaultStateLabel;
    }

    const bars = card.querySelectorAll(".voice-eq-bar");
    for (let i = 0; i < bars.length; i++) {
      if (level <= 0.04) {
        bars[i].style.height = "4px";
      } else {
        const w = VOICE_EQ_WEIGHTS[i] || 0.5;
        const wobble = 0.72 + 0.28 * Math.sin(tickPhase * 0.9 + i * 1.15);
        const h = Math.max(4, Math.min(30, Math.round(4 + level * 26 * w * wobble)));
        bars[i].style.height = `${h}px`;
      }
    }
  }

  updateVoiceMeters() {
    if (!this.voice.inVoice || !this.wasm) return;
    const now = Date.now();
    this.voice.meterTicks = (this.voice.meterTicks + 1) % 100000;
    const phase = this.voice.meterTicks;

    // Local speaker smoothing (fast attack, smooth release)
    const selfSilenced = this.voice.muted || this.voice.listenOnly;
    const localFresh = !selfSilenced && now - this.voice.localSpeakingAt < 320;
    const localTarget = localFresh ? rmsToLevel(this.voice.localRms) : 0;
    this.voice.localSmoothLevel = selfSilenced
      ? 0
      : localTarget > this.voice.localSmoothLevel
        ? this.voice.localSmoothLevel * 0.4 + localTarget * 0.6
        : this.voice.localSmoothLevel * 0.72 + localTarget * 0.28;
    if (this.voice.localSmoothLevel < 0.015) this.voice.localSmoothLevel = 0;

    const selfDefault = this.voice.listenOnly
      ? "Listen-Only"
      : this.voice.muted
        ? "Muted"
        : "Live";
    this._applySpeakerVisualizer("self", this.voice.localSmoothLevel, selfDefault, phase);

    // Remote speaker smoothing & live visualizer update
    const peersInVoice = (this.status?.peers || []).filter((p) => p.inVoice);
    for (const p of peersInVoice) {
      const mixer = this.voice.peerMixers.get(p.peerId);
      const localMuted = Boolean(mixer && mixer.muted);
      const peerSilenced = this.voice.deafened || localMuted || Boolean(p.voiceMuted);
      const fresh = !peerSilenced && mixer && now - mixer.lastAudioAt < 340;
      const target = fresh ? rmsToLevel(mixer.rms) : 0;
      if (mixer) {
        mixer.smoothLevel = peerSilenced
          ? 0
          : target > (mixer.smoothLevel || 0)
            ? (mixer.smoothLevel || 0) * 0.4 + target * 0.6
            : (mixer.smoothLevel || 0) * 0.72 + target * 0.28;
        if (mixer.smoothLevel < 0.015) mixer.smoothLevel = 0;
      }
      const level = peerSilenced ? 0 : mixer ? mixer.smoothLevel : 0;
      const defaultState = this.voice.deafened
        ? "Deafened"
        : p.voiceMuted || localMuted
          ? "Muted"
          : "Live";
      this._applySpeakerVisualizer(p.peerId, level, defaultState, phase + p.peerId.charCodeAt(2));
    }

    // Refresh packet counters every ~4th visualizer frame (~280ms)
    if (this.voice.meterTicks % 4 === 0) {
      try {
        const st = this.wasm.call({ cmd: "get_state" }).status;
        this.status = st;
        this.renderStats();
        if (st?.stats) {
          this.el["voice-packet-stats"].textContent =
            `TX ${st.stats.voicePacketsSent} / RX ${st.stats.voicePacketsReceived}`;
        }
      } catch {
        // ignore
      }
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
      voiceDc: this.voiceChannels.get(peerId) || null,
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
      peerEntry.voiceDc = this.voiceChannels.get(peerId) || peerEntry.voiceDc;
      this.relayPeers.delete(peerId);
      this.earlyRelayIce.delete(peerId);
      this.localDialing.delete(peerId);
      this.earlyLocalIce.delete(peerId);
      this.roomDialing.delete(peerId);
      this.earlyRoomIce.delete(peerId);
      this.pendingAnswers.delete(peerId);
      if (this.latestAnswer && this.latestAnswer.peerId === peerId) {
        this.latestAnswer = null;
      }
      this.discoveredLocalMeshes.delete(peerId);
      this.directPeers.set(peerId, peerEntry);

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
        if (this.wizard.mode === "host" || this.wizard.mode === "join") {
          this.wizard.step = 3;
          this.wizard.peerName = peerEntry.authorName;
        }
        this.el["connect-notice"].classList.add("hidden");
      }
      this.renderAll();
      this.showToast(
        viaAutoMesh
          ? `Connected directly with ${peerEntry.authorName}`
          : `Connected to ${peerEntry.authorName}`
      );
    };

    const handleClose = () => {
      if (closed) return;
      closed = true;
      clearDisconnectTimer();
      try {
        dc.close();
        if (peerEntry.voiceDc) peerEntry.voiceDc.close();
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
        if (this.voiceChannels.get(peerId) === peerEntry.voiceDc) {
          this.voiceChannels.delete(peerId);
        }
        const mixer = this.voice.peerMixers.get(peerId);
        if (mixer) {
          try {
            mixer.gainNode.disconnect();
          } catch {
            // ignore
          }
          this.voice.peerMixers.delete(peerId);
        }
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
      const rm = this.roomDialing.get(peerId);
      if (rm && rm.pc === pc) {
        this.roomDialing.delete(peerId);
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
        const liveInfo = this.status.peers.find((p) => p.peerId === peerId);
        if (liveInfo && liveInfo.authorName && liveInfo.authorName !== peerEntry.authorName) {
          peerEntry.authorName = liveInfo.authorName;
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
    const vdc = this.voiceChannels.get(peerId);
    if (vdc) {
      this.voiceChannels.delete(peerId);
      try {
        vdc.close();
      } catch {
        // ignore
      }
    }
    const mixer = this.voice.peerMixers.get(peerId);
    if (mixer) {
      try {
        mixer.gainNode.disconnect();
      } catch {
        // ignore
      }
      this.voice.peerMixers.delete(peerId);
    }
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
        case "bot_action": {
          this.addTelemetry(
            "bot_action",
            `${act.fromName || act.fromPeerId} clicked "${act.label || act.actionId}"`
          );
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
    if (
      this.directPeers.has(targetPeerId) ||
      this.relayPeers.has(targetPeerId) ||
      this.roomDialing.has(targetPeerId) ||
      this.localDialing.has(targetPeerId)
    ) {
      return;
    }
    try {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      const dc = pc.createDataChannel("p2p-mesh", { ordered: true });
      const voiceDc = pc.createDataChannel("p2p-voice", { ordered: false, maxRetransmits: 0 });
      const early = this.earlyRelayIce.get(targetPeerId) || [];
      this.earlyRelayIce.delete(targetPeerId);
      const entry = {
        peerId: targetPeerId,
        authorName: targetName || "Peer",
        peerPubKey: targetPubKey,
        viaPeerId,
        pc,
        dc,
        voiceDc,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
      };
      this.relayPeers.set(targetPeerId, entry);
      this.attachVoiceDataChannel(targetPeerId, voiceDc);
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
        if (ev.channel.label === "p2p-voice") {
          this.attachVoiceDataChannel(fromPeerId, ev.channel);
          return;
        }
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
    this.syncLayoutAttributes();
    this.renderHeader();
    this.renderRoomCard();
    this.renderWizard();
    this.renderConnectBanners();
    this.renderVoicePanel();
    this.renderPeers();
    this.renderTopology();
    this.renderStats();
    this.renderTypeFilterOptions();
    this.renderLog();
  }

  buildBotCliCommand(kind = "bridge") {
    const roomUrl = this.activeRoom?.url || "<paste-room-link>";
    const passFlag = this.activeRoom?.encrypted ? ' --passphrase "<room-passphrase>"' : "";
    if (kind === "warframe") {
      return `node bot/examples/warframe-bot.mjs --room "${roomUrl}"${passFlag}`;
    }
    if (kind === "music") {
      return `node bot/examples/music-bot.mjs --room "${roomUrl}"${passFlag}`;
    }
    return `node bot/bridge.mjs --room "${roomUrl}" --name "MyBot" --port 8765${passFlag}`;
  }

  renderRoomCard() {
    const isActive = Boolean(this.activeRoom);
    const peerCount = this.status?.peers?.length || 0;
    const relayState = this.roomRelayStatus?.state || "connecting";
    const relayCount = this.roomRelayStatus?.connectedCount || 0;

    if (this.el["bot-cli-command"]) {
      this.el["bot-cli-command"].value = this.buildBotCliCommand("bridge");
    }

    let badgeText = "Connecting…";
    let badgeClass = "badge pending";
    let statusTitle = "Connecting to room…";
    let isLive = false;
    if (peerCount > 0) {
      badgeText = `Live · ${peerCount} ${peerCount === 1 ? "peer" : "peers"}`;
      badgeClass = "badge auto";
      statusTitle = `Room online — ${peerCount} ${peerCount === 1 ? "peer" : "peers"} connected`;
      isLive = true;
    } else if (isActive && relayState === "live" && relayCount > 0) {
      badgeText = "Ready";
      badgeClass = "badge auto";
      statusTitle = "Room ready — waiting for peers";
      isLive = true;
    }

    // Update Simple Mode architectural room ribbon
    if (this.el["simple-room-bar"]) {
      const displayName = isActive
        ? this.activeRoom.name || "Shared Room"
        : this.status?.room && this.status.room !== "mesh-main" && this.status.room !== "default"
          ? this.status.room
          : "Direct Room";
      this.el["simple-room-name"].textContent = displayName;
      this.el["simple-room-badge"].textContent = badgeText;
      this.el["simple-room-badge"].className = badgeClass;
      if (this.el["simple-room-status-wrap"]) {
        this.el["simple-room-status-wrap"].classList.toggle("is-live", isLive);
        this.el["simple-room-status-wrap"].title = statusTitle;
        this.el["simple-room-status-wrap"].setAttribute("aria-label", statusTitle);
      }
      this.el["btn-simple-copy-link"].classList.toggle("hidden", !isActive);
    }

    if (!this.el["room-link-card"]) return;
    this.el["room-link-card"].classList.toggle("is-active", isActive);
    this.el["room-link-setup"].classList.toggle("hidden", isActive);
    this.el["room-link-active"].classList.toggle("hidden", !isActive);

    if (!isActive) return;

    this.el["room-active-name"].textContent = this.activeRoom.name || "Shared Room";
    this.el["room-link-output"].value = this.activeRoom.url;
    this.el["btn-room-share"].classList.toggle("hidden", typeof navigator.share !== "function");

    const badge = this.el["room-relay-badge"];
    badge.textContent = badgeText;
    badge.className = badgeClass;

    if (peerCount > 0) {
      this.el["room-active-hint"].textContent =
        "Share this link anytime — new people who open it join this room automatically.";
    } else if (this.activeRoom.encrypted) {
      this.el["room-active-hint"].textContent =
        "Passphrase-protected room ready. Share this link and your passphrase — anyone who opens it joins automatically.";
    } else {
      this.el["room-active-hint"].textContent =
        "You're the first one here. Share this link — everyone who opens it will join you automatically.";
    }
  }

  renderHeader() {
    if (!this.status) return;
    this.el["peer-id-display"].textContent = this.status.peerId;
    this.el["lamport-display"].textContent = String(this.status.lamport);
    this.el["peer-count-display"].textContent = String(this.status.peers.length);
    this.el["log-count-display"].textContent = String(this.status.logCount);
    this.el["next-lamport-preview"].textContent =
      this.composerMode === "chat"
        ? "URLs & images supported"
        : `next lamport: ${this.status.lamport + 1}`;

    if (this.status.e2ee) {
      const shortFp = this.status.e2ee.keyFingerprint.slice(0, 9);
      this.el["key-fp-display"].textContent = shortFp;
      this.el["key-fp-display"].parentElement.title =
        `End-to-End Encrypted Room Key · Fingerprint: ${this.status.e2ee.keyFingerprint}`;
      this.el["e2ee-mode-label"].textContent = this.status.e2ee.passphraseMode
        ? `Passphrase · ${shortFp}`
        : `Auto · ${shortFp}`;
    }

    const isOnline = this.status.peers.length > 0;
    this.el["mesh-status-chip"].classList.toggle("live", isOnline);
    this.el["mesh-status-dot"].classList.toggle("online", isOnline);

    const remoteInVoice = (this.status.peers || []).filter((p) => p.inVoice).length;
    const totalInVoice = remoteInVoice + (this.voice.inVoice ? 1 : 0);
    this.el["voice-header-chip"].classList.toggle("hidden", totalInVoice === 0);
    this.el["voice-header-chip"].classList.toggle("live", this.voice.inVoice);
    this.el["voice-header-count"].textContent = String(totalInVoice);
  }

  renderConnectBanners() {
    if (!this.status) return;

    const localTarget =
      !this.activeRoom && this.directPeers.size === 0 && this.logMessages.length === 0
        ? this.discoveredLocalMeshes.values().next().value
        : null;
    if (localTarget) {
      this.el["local-mesh-banner"].classList.remove("hidden");
      this.el["local-mesh-fp"].textContent = `Key ${localTarget.keyFingerprint.slice(0, 9)}`;
      this.el["local-mesh-desc"].textContent =
        `${localTarget.authorName} is open in another tab (${localTarget.logCount} messages). Connect directly in 1 click.`;
      this.el["btn-join-local-mesh"].textContent = `Join ${localTarget.authorName}`;
    } else {
      this.el["local-mesh-banner"].classList.add("hidden");
    }
  }

  renderVoicePanel(forceRebuild = false) {
    if (!this.status) return;
    const peersInVoice = (this.status.peers || []).filter((p) => p.inVoice);
    const peerMap = new Map(peersInVoice.map((p) => [p.peerId, p]));
    const totalInVoice = peersInVoice.length + (this.voice.inVoice ? 1 : 0);

    // Maintain stable participant order so existing cards stay put and joining adds you cleanly
    const activeKeys = new Set(peerMap.keys());
    if (this.voice.inVoice) {
      activeKeys.add("self");
    }
    const ordered = this.voice.joinOrder.filter((k) => activeKeys.has(k));
    const sortedRemoteIds = Array.from(peerMap.keys()).sort();
    for (const pid of sortedRemoteIds) {
      if (!ordered.includes(pid)) {
        ordered.push(pid);
      }
    }
    if (this.voice.inVoice && !ordered.includes("self")) {
      ordered.push("self");
    }
    this.voice.joinOrder = ordered;

    this.el["voice-panel"].classList.toggle("has-participants", totalInVoice > 0);
    this.el["voice-panel"].classList.toggle("is-live", this.voice.inVoice);

    const badge = this.el["voice-status-badge"];
    if (totalInVoice === 0) {
      badge.textContent = "Empty";
      badge.className = "badge";
    } else if (this.voice.inVoice) {
      badge.textContent = `${totalInVoice} in call`;
      badge.className = "badge auto";
    } else {
      badge.textContent = `${totalInVoice} in channel`;
      badge.className = "badge auto";
    }

    this.el["voice-join-card"].classList.toggle("hidden", this.voice.inVoice);
    this.el["voice-empty-state"].classList.toggle("hidden", totalInVoice > 0);
    this.el["voice-participant-list"].classList.toggle("hidden", totalInVoice === 0);

    if (this.voice.inVoice) {
      if (this.el["voice-join-hint"]) {
        this.el["voice-join-hint"].classList.add("hidden");
      }
      if (this.status.stats) {
        this.el["voice-packet-stats"].textContent =
          `TX ${this.status.stats.voicePacketsSent} / RX ${this.status.stats.voicePacketsReceived}`;
      }
    } else if (totalInVoice > 0) {
      if (this.el["voice-join-hint"]) {
        this.el["voice-join-hint"].classList.remove("hidden");
      }
      this.el["voice-packet-stats"].textContent = "";
    } else {
      if (this.el["voice-join-hint"]) {
        this.el["voice-join-hint"].classList.add("hidden");
      }
      this.el["voice-packet-stats"].textContent = "";
    }

    if (totalInVoice === 0) {
      this.voice.lastRosterKey = "";
      this.voice.renderedKeys.clear();
      this.el["voice-participant-list"].innerHTML = "";
      return;
    }

    const rosterKey = JSON.stringify({
      inVoice: this.voice.inVoice,
      order: ordered,
      selfId: this.status.peerId,
      selfName: this.status.authorName,
      muted: this.voice.muted,
      listenOnly: this.voice.listenOnly,
      deafened: this.voice.deafened,
      peers: ordered
        .filter((k) => k !== "self")
        .map((id) => {
          const p = peerMap.get(id);
          const mx = this.voice.peerMixers.get(id);
          return [
            id,
            p ? p.authorName : "",
            p ? p.voiceMuted : false,
            mx ? mx.muted : false,
            Boolean(p && p.isBot),
          ];
        }),
    });

    if (!forceRebuild && rosterKey === this.voice.lastRosterKey) {
      return;
    }
    this.voice.lastRosterKey = rosterKey;

    const prevRendered = this.voice.renderedKeys;
    const eqBarsHtml = Array.from(
      { length: VOICE_EQ_WEIGHTS.length },
      () => '<span class="voice-eq-bar"></span>'
    ).join("");

    const items = [];
    for (const key of ordered) {
      const enteringClass = prevRendered.has(key) ? "" : " is-entering";

      if (key === "self") {
        const selfTheme = peerTileTheme(this.status.peerId, true);
        const selfInitials = escapeHtml(avatarInitials(this.status.authorName));
        const selfMuted = this.voice.muted || this.voice.listenOnly;
        const selfStateText = this.voice.listenOnly
          ? "Listen-Only"
          : this.voice.muted
            ? "Muted"
            : "Live";
        const muteLabel = this.voice.listenOnly
          ? "Listen-only mode"
          : this.voice.muted
            ? "Unmute microphone"
            : "Mute microphone";
        const deafenLabel = this.voice.deafened ? "Undeafen audio" : "Deafen audio";

        items.push(`
          <li class="voice-card is-self ${selfTheme}${selfMuted ? " is-color-muted" : ""}${enteringClass}" data-voice-row="self">
            <div class="voice-tile-top">
              <span class="tile-mono">${selfInitials}</span>
              <span class="tile-status-tag">${SPEAK_STAR_SVG}<span data-voice-state="self">${selfStateText}</span></span>
            </div>
            <div class="tile-lower">
              <div class="voice-tile-mid">
                <span class="voice-card-name">${escapeHtml(this.status.authorName)}</span>
                <span class="voice-you-pill">You</span>
              </div>
              <div class="tile-control-slot">
                <div class="self-card-controls">
                  <div class="self-audio-group">
                    <button
                      type="button"
                      id="btn-voice-mute"
                      class="self-ctrl-icon${selfMuted ? " is-toggled" : ""}"
                      aria-pressed="${selfMuted ? "true" : "false"}"
                      aria-label="${muteLabel}"
                      title="${muteLabel}"
                    >${selfMuted ? MIC_OFF_SVG : MIC_ON_SVG}</button>
                    <button
                      type="button"
                      id="btn-voice-deafen"
                      class="self-ctrl-icon${this.voice.deafened ? " is-toggled" : ""}"
                      aria-pressed="${this.voice.deafened ? "true" : "false"}"
                      aria-label="${deafenLabel}"
                      title="${deafenLabel}"
                    >${this.voice.deafened ? HEAD_OFF_SVG : HEAD_ON_SVG}</button>
                  </div>
                  <button
                    type="button"
                    id="btn-voice-leave"
                    class="self-ctrl-leave"
                    title="Leave voice channel (stays in room)"
                  >${EXIT_VOICE_SVG}<span>Leave Voice</span></button>
                </div>
              </div>
              <div class="voice-eq" aria-hidden="true">${eqBarsHtml}</div>
            </div>
          </li>
        `);
        continue;
      }

      const p = peerMap.get(key);
      if (!p) continue;
      const peerTheme = peerTileTheme(p.peerId, false);
      const initials = escapeHtml(avatarInitials(p.authorName));
      const botPill = p.isBot ? '<span class="voice-bot-pill">BOT</span>' : "";

      if (this.voice.inVoice) {
        const mixer = this.voice.peerMixers.get(p.peerId);
        const localMuted = Boolean(mixer && mixer.muted);
        const volPct = mixer ? Math.round(mixer.volume * 100) : 100;
        const peerColorMuted = this.voice.deafened || localMuted || Boolean(p.voiceMuted);
        const peerStateText = this.voice.deafened
          ? "Deafened"
          : p.voiceMuted || localMuted
            ? "Muted"
            : "Live";

        items.push(`
          <li class="voice-card ${peerTheme}${peerColorMuted ? " is-color-muted" : ""}${enteringClass}" data-voice-row="${escapeHtml(p.peerId)}">
            <div class="voice-tile-top">
              <span class="tile-mono">${initials}</span>
              <span class="tile-status-tag">${SPEAK_STAR_SVG}<span data-voice-state="${escapeHtml(p.peerId)}">${peerStateText}</span></span>
            </div>
            <div class="tile-lower">
              <div class="voice-tile-mid">
                <span class="voice-card-name">${escapeHtml(p.authorName)}</span>
                ${botPill}
              </div>
              <div class="tile-control-slot">
                <div class="voice-peer-mixer">
                  <button
                    type="button"
                    class="tile-mute-btn${localMuted ? " is-muted" : ""}"
                    data-peer-voice-mute="${escapeHtml(p.peerId)}"
                  >${localMuted ? "Unmute" : "Mute"}</button>
                  <input
                    type="range"
                    class="voice-volume-slider"
                    min="0"
                    max="150"
                    value="${volPct}"
                    data-peer-voice-vol="${escapeHtml(p.peerId)}"
                    aria-label="Volume for ${escapeHtml(p.authorName)}"
                  />
                </div>
              </div>
              <div class="voice-eq" aria-hidden="true">${eqBarsHtml}</div>
            </div>
          </li>
        `);
      } else {
        const previewStateText = p.voiceMuted ? "Muted" : "In Voice";
        items.push(`
          <li class="voice-card is-channel-preview ${peerTheme}${p.voiceMuted ? " is-color-muted" : ""}${enteringClass}" data-voice-row="${escapeHtml(p.peerId)}">
            <div class="voice-tile-top">
              <span class="tile-mono">${initials}</span>
              <span class="tile-status-tag">${SPEAK_STAR_SVG}<span data-voice-state="${escapeHtml(p.peerId)}">${previewStateText}</span></span>
            </div>
            <div class="tile-lower">
              <div class="voice-tile-mid">
                <span class="voice-card-name">${escapeHtml(p.authorName)}</span>
                ${botPill}
              </div>
              <div class="tile-control-slot">
                <span class="tile-prejoin-hint">Active in voice channel</span>
              </div>
              <div class="voice-eq${p.voiceMuted ? "" : " is-preview"}" aria-hidden="true">${eqBarsHtml}</div>
            </div>
          </li>
        `);
      }
    }

    this.voice.renderedKeys = new Set(ordered);
    const listEl = this.el["voice-participant-list"];
    listEl.innerHTML = items.join("");

    if (this.voice.inVoice) {
      const selfMuteBtn = listEl.querySelector("#btn-voice-mute");
      if (selfMuteBtn) {
        selfMuteBtn.addEventListener("click", () => this.toggleVoiceMute());
      }
      const selfDeafBtn = listEl.querySelector("#btn-voice-deafen");
      if (selfDeafBtn) {
        selfDeafBtn.addEventListener("click", () => this.toggleVoiceDeafen());
      }
      const selfLeaveBtn = listEl.querySelector("#btn-voice-leave");
      if (selfLeaveBtn) {
        selfLeaveBtn.addEventListener("click", () => this.leaveVoiceChat());
      }
      for (const btn of listEl.querySelectorAll("[data-peer-voice-mute]")) {
        btn.addEventListener("click", () => this.togglePeerVoiceMute(btn.dataset.peerVoiceMute));
      }
      for (const slider of listEl.querySelectorAll("[data-peer-voice-vol]")) {
        slider.addEventListener("input", () =>
          this.setPeerVoiceVolume(slider.dataset.peerVoiceVol, Number(slider.value) / 100)
        );
      }
    }
  }

  renderStats() {
    if (!this.status?.stats) return;
    const s = this.status.stats;
    this.el["stat-e2ee"].textContent = `${s.e2eeFramesEncrypted} / ${s.e2eeFramesDecrypted}`;
    this.el["stat-batches"].textContent = `${s.syncBatchesSent} / ${s.syncBatchesReceived}`;
    this.el["stat-voice"].textContent = `${s.voicePacketsSent} / ${s.voicePacketsReceived}`;
  }

  renderPeers() {
    if (!this.status) return;
    const list = this.el["peer-list"];
    const direct = this.status.peers || [];
    const pending = this.status.pendingAutoMesh || [];

    if (direct.length === 0 && pending.length === 0) {
      list.innerHTML =
        '<li class="empty-state">No peers connected yet. Use Connect Peer above to invite or join someone.</li>';
      return;
    }

    const parts = [];
    for (const p of direct) {
      const peerTheme = peerTileTheme(p.peerId, false);
      const botBadge = p.isBot ? '<span class="bot-tag">BOT</span>' : "";
      const originBadge = p.viaAutoMesh
        ? `<span class="badge auto" title="Auto-connected via ${escapeHtml(p.introducedBy || "peer")}">auto</span>`
        : '<span class="badge">direct</span>';
      const voiceBadge = p.inVoice
        ? `<span class="badge auto">${p.voiceMuted ? "voice · muted" : "in voice"}</span>`
        : "";
      const rttLabel = typeof p.rttMs === "number" ? ` · ${p.rttMs}ms` : "";
      parts.push(`
        <li class="peer-item ${peerTheme}" data-peer-id="${escapeHtml(p.peerId)}">
          <div class="peer-main">
            <div class="peer-name">${escapeHtml(p.authorName)} ${botBadge} ${originBadge} ${voiceBadge}</div>
            <div class="peer-id">${escapeHtml(p.peerId)} · code ${escapeHtml(p.safetyCode || "—")}${rttLabel}</div>
          </div>
          <button type="button" class="btn btn-sm btn-danger" data-disconnect="${escapeHtml(p.peerId)}">Drop</button>
        </li>
      `);
    }

    for (const pend of pending) {
      parts.push(`
        <li class="peer-item is-pending">
          <div class="peer-main">
            <div class="peer-name">${escapeHtml(pend.authorName)} <span class="badge pending">connecting via ${escapeHtml(pend.viaPeerId)}</span></div>
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
      {
        id: this.status.peerId,
        label: `${this.status.authorName} (you)`,
        kind: "self",
        inVoice: this.voice.inVoice,
      },
    ];
    const nodeMap = new Map();
    nodeMap.set(this.status.peerId, nodes[0]);

    for (const p of direct) {
      const n = {
        id: p.peerId,
        label: p.isBot ? `[BOT] ${p.authorName}` : p.authorName,
        kind: p.viaAutoMesh ? "auto" : "direct",
        inVoice: Boolean(p.inVoice),
      };
      nodes.push(n);
      nodeMap.set(p.peerId, n);
    }
    for (const p of pending) {
      if (!nodeMap.has(p.peerId)) {
        const n = { id: p.peerId, label: p.authorName, kind: "pending", inVoice: false };
        nodes.push(n);
        nodeMap.set(p.peerId, n);
      }
    }

    const cx = 170;
    const cy = 80;
    const rx = 112;
    const ry = 50;
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

    const themeColorVar = {
      "tile-coral": "var(--coral)",
      "tile-cobalt": "var(--cobalt)",
      "tile-ochre": "var(--ochre)",
      "tile-cyan": "var(--cyan)",
      "tile-mint": "var(--mint)",
    };

    const gridDefs = `
      <defs>
        <pattern id="topo-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--rule-soft)" stroke-width="1" />
        </pattern>
      </defs>
      <rect width="340" height="160" fill="url(#topo-grid)" />
    `;

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
          `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="var(--accent-warn)" stroke-width="2" stroke-dasharray="4 4" />`
        );
      } else if (style === "remote") {
        lines.push(
          `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="var(--accent-live)" stroke-opacity="0.45" stroke-width="1.8" />`
        );
      } else {
        lines.push(
          `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="var(--accent-live)" stroke-width="2.4" />`
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

    const blocks = nodes.map((n) => {
      const fill =
        n.kind === "self"
          ? "var(--ink-primary)"
          : n.kind === "pending"
            ? "var(--accent-warn)"
            : themeColorVar[peerTileTheme(n.id, false)] || "var(--accent-live)";
      const size = n.kind === "self" ? 16 : 14;
      const half = size / 2;
      const shortLabel = (n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label).toUpperCase();
      const labelY = n.y > cy ? n.y + 22 : n.y - 14;
      const frameSize = size + 8;
      const frameHalf = frameSize / 2;
      const voiceFrame = n.inVoice
        ? `<rect x="${(n.x - frameHalf).toFixed(1)}" y="${(n.y - frameHalf).toFixed(1)}" width="${frameSize}" height="${frameSize}" fill="none" stroke="var(--accent-live)" stroke-width="2" />`
        : "";
      return `
        <g>
          ${voiceFrame}
          <rect x="${(n.x - half).toFixed(1)}" y="${(n.y - half).toFixed(1)}" width="${size}" height="${size}" fill="${fill}" stroke="var(--bg-surface)" stroke-width="2" />
          <text x="${n.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" font-weight="700" letter-spacing="0.06em" fill="var(--ink-primary)">${escapeHtml(shortLabel)}</text>
        </g>
      `;
    });

    svg.innerHTML = `${gridDefs}${lines.join("")}${blocks.join("")}`;
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
          item.event === "rejoin" ||
          item.event === "room" ||
          item.event.includes("voice")
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

  isPeerBot(peerId) {
    if (!peerId) return false;
    if (!this.knownBotPeerIds) {
      this.knownBotPeerIds = new Set();
    }
    const peers = this.status?.peers || [];
    for (const p of peers) {
      if (p.isBot) {
        this.knownBotPeerIds.add(p.peerId);
      }
    }
    return this.knownBotPeerIds.has(peerId);
  }

  deleteLogMessage(msgId) {
    if (!msgId || !this.wasm) return;
    try {
      const res = this.wasm.call({
        cmd: "delete_message",
        targetId: msgId,
        ts: Date.now(),
        entropy: randomBase64Url(16),
      });
      this.status = res.status;
      this.executeActions(res.actions);
      this.renderAll();
      this.showToast("Message deleted for room");
    } catch (err) {
      this.addTelemetry("error", `Delete failed: ${err.message}`);
      this.showToast(`Could not delete message: ${err.message}`);
    }
  }

  handleBotButtonClick(msg, btnObj, btnEl) {
    if (!msg || !btnObj || btnObj.disabled || !this.wasm) return;

    if (typeof btnObj.url === "string" && SAFE_HTTP_URL_RE.test(btnObj.url.trim())) {
      window.open(btnObj.url.trim(), "_blank", "noopener,noreferrer");
      return;
    }

    const actionId = String(btnObj.id || btnObj.actionId || btnObj.label || "action");
    const label = String(btnObj.label || actionId);
    const value = btnObj.value !== undefined ? btnObj.value : null;
    const mode = btnObj.mode === "reply" ? "reply" : "action";

    if (mode === "reply") {
      const replyText =
        typeof btnObj.replyText === "string" && btnObj.replyText.trim()
          ? btnObj.replyText.trim()
          : label;
      try {
        const res = this.wasm.call({
          cmd: "publish",
          type: "chat",
          payload: {
            text: replyText,
            replyTo: {
              messageId: msg.id,
              botPeerId: msg.author,
              botName: msg.authorName,
              actionId,
              label,
              value,
            },
          },
          ts: Date.now(),
          entropy: randomBase64Url(16),
        });
        this.status = res.status;
        this.executeActions(res.actions);
        this.renderAll();
      } catch (err) {
        this.addTelemetry("error", `Bot reply error: ${err.message}`);
      }
      return;
    }

    // Discord-style silent E2EE interaction callback routed to the bot peer
    try {
      const targetBot = msg.author || "*";
      const res = this.wasm.call({
        cmd: "send_bot_action",
        toPeerId: targetBot,
        messageId: msg.id,
        actionId,
        label,
        value,
        ts: Date.now(),
      });
      this.status = res.status;
      this.executeActions(res.actions);

      if (btnEl) {
        const origHtml = btnEl.innerHTML;
        btnEl.classList.add("is-sent");
        btnEl.textContent = `${label} ✓`;
        setTimeout(() => {
          if (btnEl.isConnected) {
            btnEl.classList.remove("is-sent");
            btnEl.innerHTML = origHtml;
          }
        }, 700);
      }
    } catch (err) {
      this.addTelemetry("error", `Bot action failed: ${err.message}`);
      this.showToast(`Bot action failed: ${err.message}`);
    }
  }

  renderChatPayload(payload) {
    const parts = [];
    if (payload.replyTo && typeof payload.replyTo === "object") {
      const targetName = escapeHtml(payload.replyTo.botName || "Bot");
      const viaLabel = escapeHtml(payload.replyTo.label || payload.replyTo.actionId || "Button");
      parts.push(
        `<div class="chat-reply-banner"><span>↳ Answer to <strong>${targetName}</strong> · ${viaLabel}</span></div>`
      );
    }

    const text = typeof payload.text === "string" ? payload.text : "";
    if (text) {
      const { html, links } = extractAndLinkify(text);
      parts.push(`<div class="log-text-body">${html}</div>`);
      if (links.length > 0) {
        const cards = links
          .map(
            (lnk) => `
            <a class="chat-link-card" href="${escapeHtml(lnk.href)}" target="_blank" rel="noopener noreferrer">
              ${LINK_ARROW_SVG}
              <span class="chat-link-host">${escapeHtml(lnk.host)}</span>
              <span class="chat-link-path">${escapeHtml(lnk.path)}</span>
            </a>
          `
          )
          .join("");
        parts.push(`<div class="chat-link-cards">${cards}</div>`);
      }
    }

    if (Array.isArray(payload.images) && payload.images.length > 0) {
      const validImages = payload.images.filter(
        (img) => img && typeof img.dataUrl === "string" && SAFE_IMAGE_DATA_URL_RE.test(img.dataUrl)
      );
      if (validImages.length > 0) {
        const thumbs = validImages
          .map((img) => {
            const alt = escapeHtml(img.name || "Shared image");
            return `
              <button type="button" class="chat-image-btn" data-lightbox-src="${img.dataUrl}" data-lightbox-alt="${alt}">
                <img class="chat-image-thumb" src="${img.dataUrl}" alt="${alt}" loading="lazy" />
              </button>
            `;
          })
          .join("");
        parts.push(`<div class="chat-image-grid">${thumbs}</div>`);
      }
    }

    return parts.join("");
  }

  normalizeBotButtonRows(rawButtons) {
    if (!Array.isArray(rawButtons) || rawButtons.length === 0) return [];
    const rows = Array.isArray(rawButtons[0]) ? rawButtons : [rawButtons];
    const cleanRows = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const cleanBtns = row.filter((b) => b && typeof b === "object" && (b.label || b.id));
      if (cleanBtns.length > 0) {
        cleanRows.push(cleanBtns);
      }
    }
    return cleanRows;
  }

  renderBotCardPayload(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const allowedColors = new Set(["cobalt", "mint", "ochre", "coral", "cyan", "ink"]);
    const accent = allowedColors.has(p.color) ? p.color : "cobalt";
    const parts = [];

    if (p.title || p.subtitle || p.badge) {
      const subHtml = p.subtitle
        ? `<span class="bot-card-subtitle">${escapeHtml(p.subtitle)}</span>`
        : "";
      const titleHtml = p.title
        ? `<h3 class="bot-card-title">${escapeHtml(p.title)}</h3>`
        : "";
      const badgeHtml = p.badge
        ? `<span class="bot-card-badge">${escapeHtml(p.badge)}</span>`
        : "";
      parts.push(`
        <div class="bot-card-head">
          <div class="bot-card-titles">${subHtml}${titleHtml}</div>
          ${badgeHtml}
        </div>
      `);
    }

    if (typeof p.text === "string" && p.text.trim()) {
      parts.push(`<div class="bot-card-text">${formatBotRichText(p.text)}</div>`);
    }

    if (Array.isArray(p.fields) && p.fields.length > 0) {
      const fieldHtml = p.fields
        .filter((f) => f && typeof f === "object" && (f.label || f.value !== undefined))
        .map((f) => {
          const fullCls = f.inline === false ? " is-full" : "";
          return `
            <div class="bot-field${fullCls}">
              <span class="bot-field-label">${escapeHtml(f.label || "")}</span>
              <span class="bot-field-value">${formatBotRichText(f.value ?? "")}</span>
            </div>
          `;
        })
        .join("");
      if (fieldHtml) {
        parts.push(`<div class="bot-card-fields">${fieldHtml}</div>`);
      }
    }

    const imgSrc =
      typeof p.image === "string"
        ? p.image
        : p.image && typeof p.image === "object"
          ? p.image.dataUrl || p.image.url || ""
          : "";
    if (isSafeImageSrc(imgSrc)) {
      const alt = escapeHtml((p.image && p.image.alt) || p.title || "Bot attachment");
      parts.push(`
        <button type="button" class="bot-card-image-btn" data-lightbox-src="${escapeHtml(imgSrc)}" data-lightbox-alt="${alt}">
          <img src="${escapeHtml(imgSrc)}" alt="${alt}" loading="lazy" />
        </button>
      `);
    }

    const buttonRows = this.normalizeBotButtonRows(p.buttons);
    const flatButtons = [];
    if (buttonRows.length > 0) {
      const allowedStyles = new Set(["primary", "success", "warning", "danger", "secondary"]);
      const rowsHtml = buttonRows
        .map((row) => {
          const btnsHtml = row
            .map((btn) => {
              const idx = flatButtons.length;
              flatButtons.push(btn);
              const style = allowedStyles.has(btn.style) ? btn.style : "secondary";
              const label = escapeHtml(btn.label || btn.id || "Action");
              const isLink = typeof btn.url === "string" && SAFE_HTTP_URL_RE.test(btn.url.trim());
              const suffix = isLink ? ` ${LINK_ARROW_SVG}` : "";
              const disabledAttr = btn.disabled ? " disabled" : "";
              return `<button type="button" class="bot-btn bot-btn-${style}" data-bot-btn-idx="${idx}" data-bot-action-id="${escapeHtml(btn.id || btn.actionId || "")}"${disabledAttr}>${label}${suffix}</button>`;
            })
            .join("");
          return `<div class="bot-btn-row">${btnsHtml}</div>`;
        })
        .join("");
      parts.push(`<div class="bot-card-actions">${rowsHtml}</div>`);
    }

    if (typeof p.footer === "string" && p.footer.trim()) {
      parts.push(`<div class="bot-card-footer">${escapeHtml(p.footer)}</div>`);
    }

    return {
      html: `<div class="bot-card bot-accent-${accent}">${parts.join("")}</div>`,
      buttons: flatButtons,
    };
  }

  buildLogEntryElement(m, isSelf, isNew) {
    const stripeTheme = peerTileTheme(m.author, isSelf);
    const isBotMsg = m.type === "bot" && m.payload && typeof m.payload === "object";
    const isChat =
      m.type === "chat" &&
      m.payload &&
      (typeof m.payload.text === "string" || Array.isArray(m.payload.images));

    let bodyHtml;
    let botButtons = [];
    if (isBotMsg) {
      const rendered = this.renderBotCardPayload(m.payload);
      bodyHtml = rendered.html;
      botButtons = rendered.buttons;
    } else if (isChat) {
      bodyHtml = this.renderChatPayload(m.payload);
    } else {
      bodyHtml = `<pre class="log-json-pre">${escapeHtml(JSON.stringify(m.payload, null, 2))}</pre>`;
    }

    const showBotTag = isBotMsg || this.isPeerBot(m.author);
    const botTagHtml = showBotTag ? '<span class="bot-tag">BOT</span>' : "";
    const typeTag =
      isChat || isBotMsg ? "" : `<span class="log-type-tag">${escapeHtml(m.type)}</span>`;
    const updatedTag = m.updatedLamport
      ? '<span class="bot-updated-tag" title="Updated live by bot">edited</span>'
      : "";

    const article = document.createElement("article");
    article.className = `log-entry${isSelf ? " is-self" : ""}${isBotMsg ? " is-bot-entry" : ""}${isNew ? " is-new" : ""}`;
    article.dataset.msgId = m.id;
    article.dataset.rev = String(m.updatedLamport || 0);
    article.innerHTML = `
      <div class="msg-stripe ${stripeTheme}" aria-hidden="true"></div>
      <div class="log-entry-main">
        <div class="log-entry-head">
          <div class="log-author-group">
            <span class="log-author">${escapeHtml(m.authorName)}</span>
            ${botTagHtml}
            ${typeTag}
            ${updatedTag}
          </div>
          <div class="log-head-right">
            <span class="log-order-tuple" title="Order (lamport ${m.lamport}) · ${escapeHtml(m.id)}">
              ${escapeHtml(formatTime(m.ts))}
            </span>
            <button
              type="button"
              class="msg-delete-btn"
              data-delete-msg="${escapeHtml(m.id)}"
              title="Delete message for everyone in room"
              aria-label="Delete message"
            >${TRASH_SVG}</button>
          </div>
        </div>
        ${bodyHtml}
      </div>
    `;

    const delBtn = article.querySelector("[data-delete-msg]");
    if (delBtn) {
      delBtn.addEventListener("click", () => this.deleteLogMessage(m.id));
    }

    for (const btn of article.querySelectorAll("[data-lightbox-src]")) {
      btn.addEventListener("click", () =>
        this.openLightbox(btn.dataset.lightboxSrc, btn.dataset.lightboxAlt)
      );
    }

    for (const btnEl of article.querySelectorAll("[data-bot-btn-idx]")) {
      const idx = Number(btnEl.dataset.botBtnIdx);
      const btnObj = botButtons[idx];
      if (btnObj) {
        btnEl.addEventListener("click", () => this.handleBotButtonClick(m, btnObj, btnEl));
      }
    }

    return article;
  }

  renderLog() {
    const feed = this.el["log-feed"];
    const query = this.advancedMode ? this.el["log-search-input"].value.trim().toLowerCase() : "";
    const typeFilter = this.advancedMode ? this.el["log-type-filter"].value : "";

    const filtered = this.logMessages.filter((m) => {
      if (typeFilter && m.type !== typeFilter) return false;
      if (!query) return true;
      // Avoid scanning huge base64 image strings when searching text
      const searchable = {
        id: m.id,
        type: m.type,
        author: m.author,
        authorName: m.authorName,
        payload:
          m.type === "chat" && m.payload && Array.isArray(m.payload.images)
            ? {
                text: m.payload.text || "",
                imageNames: m.payload.images.map((i) => i?.name || "image"),
              }
            : m.payload,
      };
      return JSON.stringify(searchable).toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
      const emptyPrompt = this.advancedMode
        ? "No messages yet. Write a message, drop a link, press Ctrl+V to share an image, or send structured JSON."
        : "No messages yet. Write a message, drop a link, or press Ctrl+V to share an image.";
      const emptyText =
        this.logMessages.length === 0
          ? emptyPrompt
          : "No messages match your current filter.";
      const emptyKey = `empty:${emptyText}`;
      if (this.logRenderState.mode === "empty" && this.logRenderState.key === emptyKey) {
        return;
      }
      feed.innerHTML = `<div class="empty-state">${emptyText}</div>`;
      this.logRenderState = { mode: "empty", key: emptyKey };
      return;
    }

    if (this.advancedMode && this.rawJsonMode) {
      const rawKey = `raw:${filtered.map((m) => `${m.id}:${m.updatedLamport || 0}`).join(",")}`;
      if (this.logRenderState.mode === "raw" && this.logRenderState.key === rawKey) {
        return;
      }
      const jsonl = filtered.map((m) => JSON.stringify(m)).join("\n");
      feed.innerHTML = `<pre class="raw-jsonl-view">${escapeHtml(jsonl)}</pre>`;
      this.logRenderState = { mode: "raw", key: rawKey };
      return;
    }

    const myId = this.status?.peerId || "";
    const chatKey = `chat:${myId}:${filtered.map((m) => `${m.id}:${m.updatedLamport || 0}`).join(",")}`;
    if (this.logRenderState.mode === "chat" && this.logRenderState.key === chatKey) {
      return;
    }

    const prevMode = this.logRenderState.mode;
    const wasNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 64;

    if (prevMode !== "chat") {
      feed.innerHTML = "";
    }

    const existingNodes = new Map();
    for (const child of Array.from(feed.children)) {
      const msgId = child.dataset?.msgId;
      if (msgId) {
        existingNodes.set(msgId, child);
      } else {
        child.remove();
      }
    }

    const wantedIds = new Set(filtered.map((m) => m.id));
    for (const [id, node] of existingNodes.entries()) {
      if (!wantedIds.has(id)) {
        node.remove();
        existingNodes.delete(id);
      }
    }

    let addedSelfMessage = false;
    const animateNew = prevMode === "chat" || prevMode === "empty";
    for (let i = 0; i < filtered.length; i++) {
      const m = filtered[i];
      const isSelf = m.author === myId;
      const rev = String(m.updatedLamport || 0);
      let node = existingNodes.get(m.id);
      if (!node) {
        node = this.buildLogEntryElement(m, isSelf, animateNew);
        if (isSelf) addedSelfMessage = true;
      } else if (node.dataset.rev !== rev) {
        // Live bot card update: replace ONLY this message node in place (zero flicker on others)
        const updatedNode = this.buildLogEntryElement(m, isSelf, false);
        feed.replaceChild(updatedNode, node);
        node = updatedNode;
      }
      const refNode = feed.children[i] || null;
      if (refNode !== node) {
        feed.insertBefore(node, refNode);
      }
    }

    this.logRenderState = { mode: "chat", key: chatKey };

    if (prevMode !== "chat" || wasNearBottom || addedSelfMessage) {
      feed.scrollTop = feed.scrollHeight;
    }
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
