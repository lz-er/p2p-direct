/**
 * Ephemeral in-memory session identity helpers & optional local room bookmarks.
 *
 * Messages, media, peer keys, and passphrases are NEVER stored permanently on the client
 * (zero IndexedDB; messages live strictly in active peers' memory and clear when all leave).
 * Users can explicitly bookmark room invite links locally (`p2p-direct-saved-rooms-v1`), and
 * the most recently joined room shortcut (`p2p-direct-last-room-v1`) is remembered locally so
 * users can rejoin it manually in one click (never auto-joined).
 */

import { sanitizeWarframeSettings } from "./warframe_bot.js";

const LEGACY_DB_NAME = "p2p_direct_mesh_v2";
const LEGACY_LS_PREFIX = "p2p_direct_profile_v2:";
const SESSION_NAME_KEY = "p2p-direct-name";
const SESSION_AUDIO_KEY = "p2p-direct-audio-settings";
export const SAVED_ROOMS_KEY = "p2p-direct-saved-rooms-v1";
export const LAST_ROOM_KEY = "p2p-direct-last-room-v1";
export const WARFRAME_BOT_SETTINGS_KEY = "p2p-direct-warframe-bot-v1";
const MAX_SAVED_ROOMS = 50;

export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  preset: "voice",
  deviceId: "",
  outputDeviceId: "",
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
    outputDeviceId: typeof src.outputDeviceId === "string" ? src.outputDeviceId.slice(0, 128) : "",
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

/* ================= Local Room Bookmarks & Last Joined Room ================= */

function sanitizeRoomName(raw) {
  const clean = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return clean || "Shared Room";
}

function sanitizeRoomUrl(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().slice(0, 2400);
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return trimmed;
    }
  } catch {
    // ignore invalid URL
  }
  return "";
}

function sanitizeRelayUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, 512);
  if (!trimmed) return null;
  // Allow comma-separated ws:// or wss:// relay endpoints
  const parts = trimmed
    .split(",")
    .map((p) => p.trim())
    .filter((p) => /^wss?:\/\//i.test(p));
  return parts.length > 0 ? parts.join(",") : null;
}

export function sanitizeRoomBookmark(raw) {
  if (!raw || typeof raw !== "object") return null;
  const code = typeof raw.code === "string" ? raw.code.trim().slice(0, 2048) : "";
  if (!code || !/^P2P1:/i.test(code)) return null;
  const topicRaw = typeof raw.topic === "string" ? raw.topic.trim().slice(0, 128) : "";
  const topic = topicRaw || code.slice(0, 48);
  const now = Date.now();
  const savedAt =
    typeof raw.savedAt === "number" && Number.isFinite(raw.savedAt) && raw.savedAt > 0
      ? Math.round(raw.savedAt)
      : now;
  const lastJoinedAt =
    typeof raw.lastJoinedAt === "number" && Number.isFinite(raw.lastJoinedAt) && raw.lastJoinedAt > 0
      ? Math.round(raw.lastJoinedAt)
      : savedAt;
  return {
    topic,
    name: sanitizeRoomName(raw.name),
    code,
    url: sanitizeRoomUrl(raw.url),
    relay: sanitizeRelayUrl(raw.relay),
    encrypted: Boolean(raw.encrypted),
    savedAt,
    lastJoinedAt,
  };
}

function sortSavedRooms(list) {
  return list.sort((a, b) => {
    const ta = Math.max(a.lastJoinedAt || 0, a.savedAt || 0);
    const tb = Math.max(b.lastJoinedAt || 0, b.savedAt || 0);
    return tb - ta;
  });
}

/**
 * Loads the user's locally saved rooms from localStorage (sorted most-recent first).
 */
export function loadSavedRooms() {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(SAVED_ROOMS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const dedup = new Map();
    for (const item of parsed) {
      const clean = sanitizeRoomBookmark(item);
      if (clean && !dedup.has(clean.topic)) {
        dedup.set(clean.topic, clean);
      }
    }
    return sortSavedRooms(Array.from(dedup.values())).slice(0, MAX_SAVED_ROOMS);
  } catch {
    return [];
  }
}

/**
 * Writes the sanitized saved-rooms list to localStorage (or clears key if empty).
 */
export function saveSavedRooms(list) {
  const dedup = new Map();
  if (Array.isArray(list)) {
    for (const item of list) {
      const clean = sanitizeRoomBookmark(item);
      if (clean && !dedup.has(clean.topic)) {
        dedup.set(clean.topic, clean);
      }
    }
  }
  const ordered = sortSavedRooms(Array.from(dedup.values())).slice(0, MAX_SAVED_ROOMS);
  try {
    if (typeof localStorage !== "undefined") {
      if (ordered.length === 0) {
        localStorage.removeItem(SAVED_ROOMS_KEY);
      } else {
        localStorage.setItem(SAVED_ROOMS_KEY, JSON.stringify(ordered));
      }
    }
  } catch {
    // ignore storage quota/privacy errors
  }
  return ordered;
}

/**
 * Adds or updates a room in local saved rooms.
 */
export function upsertSavedRoom(entry, { preserveCustomName = false } = {}) {
  const clean = sanitizeRoomBookmark(entry);
  if (!clean) return loadSavedRooms();
  const list = loadSavedRooms();
  const idx = list.findIndex((r) => r.topic === clean.topic);
  if (idx >= 0) {
    const existing = list[idx];
    list[idx] = {
      ...clean,
      name: preserveCustomName && existing.name ? existing.name : clean.name,
      savedAt: existing.savedAt || clean.savedAt,
      lastJoinedAt: Math.max(existing.lastJoinedAt || 0, clean.lastJoinedAt || 0),
    };
  } else {
    list.unshift(clean);
  }
  return saveSavedRooms(list);
}

/**
 * Renames a locally saved room (and updates Last Joined if it points to the same room).
 */
export function renameSavedRoom(topic, newName) {
  const cleanName = sanitizeRoomName(newName);
  const list = loadSavedRooms();
  let changed = false;
  for (const r of list) {
    if (r.topic === topic) {
      r.name = cleanName;
      changed = true;
    }
  }
  const saved = changed ? saveSavedRooms(list) : list;
  const last = loadLastJoinedRoom();
  if (last && last.topic === topic) {
    saveLastJoinedRoom({ ...last, name: cleanName }, { syncSaved: false });
  }
  return saved;
}

/**
 * Removes a room from local saved rooms by topic.
 */
export function removeSavedRoom(topic) {
  const list = loadSavedRooms().filter((r) => r.topic !== topic);
  return saveSavedRooms(list);
}

/**
 * Loads the last joined room shortcut from localStorage (never auto-joined).
 */
export function loadLastJoinedRoom() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(LAST_ROOM_KEY);
    if (!raw) return null;
    return sanitizeRoomBookmark(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Saves the most recently joined/created room locally so the user can manually rejoin it later.
 * Never stores passphrases or messages, and never triggers auto-join.
 */
export function saveLastJoinedRoom(entry, { syncSaved = true } = {}) {
  const clean = sanitizeRoomBookmark(entry);
  if (!clean) return null;
  const savedList = loadSavedRooms();
  const existingSaved = savedList.find((r) => r.topic === clean.topic);
  const finalEntry = existingSaved
    ? {
        ...clean,
        name: existingSaved.name || clean.name,
        savedAt: existingSaved.savedAt,
      }
    : clean;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LAST_ROOM_KEY, JSON.stringify(finalEntry));
    }
  } catch {
    // ignore storage errors
  }
  if (syncSaved && existingSaved) {
    upsertSavedRoom(finalEntry, { preserveCustomName: true });
  }
  return finalEntry;
}

/**
 * Clears the stored last-joined room shortcut without touching saved rooms.
 */
export function clearLastJoinedRoom() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(LAST_ROOM_KEY);
    }
  } catch {
    // ignore storage errors
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
 * Purges any legacy IndexedDB databases or legacy localStorage entries left from earlier versions
 * so zero messages, keys, or profiles persist permanently on the client.
 * Local room bookmarks (`p2p-direct-saved-rooms-v1` / `p2p-direct-last-room-v1`) are preserved.
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

/**
 * Loads local UI settings for the optional Built-in Warframe Worldstate Bot.
 * Disabled by default so zero external Warframe API requests occur unless enabled.
 */
export function loadWarframeBotSettings() {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(WARFRAME_BOT_SETTINGS_KEY);
      if (raw) {
        return sanitizeWarframeSettings(JSON.parse(raw));
      }
    }
  } catch {
    // ignore storage restrictions
  }
  return sanitizeWarframeSettings(null);
}

/**
 * Saves local UI settings for the optional Built-in Warframe Worldstate Bot.
 */
export function saveWarframeBotSettings(settings) {
  const clean = sanitizeWarframeSettings(settings);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(WARFRAME_BOT_SETTINGS_KEY, JSON.stringify(clean));
    }
  } catch {
    // ignore storage restrictions
  }
  return clean;
}
