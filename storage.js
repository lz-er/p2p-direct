/**
 * Ephemeral in-memory session identity helpers.
 *
 * Nothing is stored permanently on the client (zero IndexedDB, zero localStorage writes).
 * Messages live strictly in active peers' memory and stay alive as long as at least one
 * peer remains in the room; once all users leave, all messages are cleared.
 */

const LEGACY_DB_NAME = "p2p_direct_mesh_v2";
const LEGACY_LS_PREFIX = "p2p_direct_profile_v2:";
const SESSION_NAME_KEY = "p2p-direct-name";
const SESSION_AUDIO_KEY = "p2p-direct-audio-settings";

export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  preset: "voice",
  deviceId: "",
  micGain: 100, // 0..250 (%)
  outputGain: 100, // 0..200 (%)
  noiseGate: 2, // 0..35 (% of full scale RMS)
  highPassHz: 80, // 0 | 80 | 120 | 200
  presenceDb: 2, // -6..+6 dB @ 2800 Hz
  compressor: true,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

function clampNum(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function sanitizeAudioSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const hp = Number(src.highPassHz);
  const highPassHz = [0, 80, 120, 200].includes(hp) ? hp : DEFAULT_AUDIO_SETTINGS.highPassHz;
  const preset = ["voice", "broadcast", "raw", "custom"].includes(src.preset)
    ? src.preset
    : DEFAULT_AUDIO_SETTINGS.preset;
  return {
    preset,
    deviceId: typeof src.deviceId === "string" ? src.deviceId.slice(0, 128) : "",
    micGain: Math.round(clampNum(src.micGain, 0, 250, DEFAULT_AUDIO_SETTINGS.micGain)),
    outputGain: Math.round(clampNum(src.outputGain, 0, 200, DEFAULT_AUDIO_SETTINGS.outputGain)),
    noiseGate: Math.round(clampNum(src.noiseGate, 0, 35, DEFAULT_AUDIO_SETTINGS.noiseGate)),
    highPassHz,
    presenceDb: Math.round(clampNum(src.presenceDb, -6, 6, DEFAULT_AUDIO_SETTINGS.presenceDb)),
    compressor:
      typeof src.compressor === "boolean" ? src.compressor : DEFAULT_AUDIO_SETTINGS.compressor,
    echoCancellation:
      typeof src.echoCancellation === "boolean"
        ? src.echoCancellation
        : DEFAULT_AUDIO_SETTINGS.echoCancellation,
    noiseSuppression:
      typeof src.noiseSuppression === "boolean"
        ? src.noiseSuppression
        : DEFAULT_AUDIO_SETTINGS.noiseSuppression,
    autoGainControl:
      typeof src.autoGainControl === "boolean"
        ? src.autoGainControl
        : DEFAULT_AUDIO_SETTINGS.autoGainControl,
  };
}

/**
 * Loads personal audio settings for this browser session (sessionStorage only; zero permanent storage).
 */
export function loadSessionAudioSettings() {
  try {
    if (typeof sessionStorage !== "undefined") {
      const raw = sessionStorage.getItem(SESSION_AUDIO_KEY);
      if (raw) {
        return sanitizeAudioSettings(JSON.parse(raw));
      }
    }
  } catch {
    // ignore storage errors
  }
  return { ...DEFAULT_AUDIO_SETTINGS };
}

/**
 * Saves personal audio settings for this browser session only (sessionStorage only).
 */
export function saveSessionAudioSettings(settings) {
  const clean = sanitizeAudioSettings(settings);
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(SESSION_AUDIO_KEY, JSON.stringify(clean));
    }
  } catch {
    // ignore storage errors
  }
  return clean;
}

function sanitizeAuthorName(raw) {
  const clean = String(raw || "").trim().slice(0, 32);
  return clean || null;
}

/**
 * Loads the user's display name for the current browser session.
 * Uses a browser-session cookie (no Expires / Max-Age, shared across tabs until
 * browser close) with a sessionStorage fallback — never persisted permanently.
 */
export function loadSessionAuthorName() {
  try {
    if (typeof document !== "undefined" && typeof document.cookie === "string") {
      const prefix = `${SESSION_NAME_KEY}=`;
      const parts = document.cookie.split(";");
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith(prefix)) {
          const decoded = decodeURIComponent(trimmed.slice(prefix.length));
          const clean = sanitizeAuthorName(decoded);
          if (clean) return clean;
        }
      }
    }
  } catch {
    // ignore cookie restrictions
  }

  try {
    if (typeof sessionStorage !== "undefined") {
      const clean = sanitizeAuthorName(sessionStorage.getItem(SESSION_NAME_KEY));
      if (clean) return clean;
    }
  } catch {
    // ignore storage restrictions
  }

  return null;
}

/**
 * Saves the user's display name for the current browser session only.
 * Shared across tabs/new openings within the same browser session; clears on browser close.
 */
export function saveSessionAuthorName(name) {
  const clean = sanitizeAuthorName(name);
  if (!clean) return;

  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(SESSION_NAME_KEY, clean);
    }
  } catch {
    // ignore storage restrictions
  }

  try {
    if (typeof document !== "undefined") {
      const secureAttr =
        typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${SESSION_NAME_KEY}=${encodeURIComponent(clean)}; path=/; SameSite=Lax${secureAttr}`;
    }
  } catch {
    // ignore cookie restrictions
  }
}

function randomBytes(len) {
  const arr = new Uint8Array(len);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return arr;
}

function randomHex(bytesLen) {
  return Array.from(randomBytes(bytesLen), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomBase64Url(bytesLen = 32) {
  const bytes = randomBytes(bytesLen);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Purges any legacy IndexedDB databases or localStorage entries left from earlier versions
 * so zero messages, keys, or profiles persist permanently on the client.
 */
export function purgeLegacyClientStorage() {
  try {
    if (typeof indexedDB !== "undefined" && typeof indexedDB.deleteDatabase === "function") {
      indexedDB.deleteDatabase(LEGACY_DB_NAME);
    }
  } catch {
    // ignore storage restrictions
  }

  try {
    if (typeof localStorage !== "undefined") {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith(LEGACY_LS_PREFIX) || key === "p2p-direct-theme")) {
          toRemove.push(key);
        }
      }
      for (const key of toRemove) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // ignore storage restrictions
  }
}

/**
 * Creates a fresh ephemeral in-memory session identity (never persisted to disk),
 * reusing the browser-session display name when present.
 */
export function createEphemeralProfile() {
  const peerId = `p-${randomHex(6)}`;
  const suffix = peerId.slice(2, 6).toUpperCase();
  const savedName = loadSessionAuthorName();
  const authorName = savedName || `Node-${suffix}`;
  if (!savedName) {
    saveSessionAuthorName(authorName);
  }

  return {
    peerId,
    authorName,
    room: "mesh-main",
    autoMeshEnabled: true,
    x25519Secret: randomBase64Url(32),
    meshKey: randomBase64Url(32),
    passphraseMode: false,
  };
}
