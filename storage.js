const DB_NAME = "p2p_direct_mesh_v2";
const STORE_NAME = "profiles";
const DB_VERSION = 1;
const LS_PREFIX = "p2p_direct_profile_v2:";

const DEFAULT_NAMES = [
  "Alpha",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
];

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
 * Acquires a stable profile slot for this browser tab:
 * - Honors `?profile=<slot>` query param if explicitly provided.
 * - Reuses `sessionStorage` slot on page reloads so the same tab keeps its identity & encrypted log.
 * - Uses Web Locks (`navigator.locks`) so a single tab reopens `"default"` across browser restarts,
 *   while multiple simultaneously open tabs automatically get distinct slots (`peer-2`, `peer-3`, ...).
 */
export async function acquireProfileSlot() {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("profile");
  if (explicit && explicit.trim()) {
    const clean = explicit.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "default";
    try {
      sessionStorage.setItem("p2p_direct_slot", clean);
    } catch {
      // ignore storage restrictions
    }
    holdSlotLock(clean);
    return clean;
  }

  let savedSlot = null;
  try {
    savedSlot = sessionStorage.getItem("p2p_direct_slot");
  } catch {
    savedSlot = null;
  }

  const candidates = [];
  if (savedSlot) {
    candidates.push(savedSlot);
  }
  candidates.push("default");
  for (let i = 2; i <= 16; i++) {
    candidates.push(`peer-${i}`);
  }

  if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
    for (const slot of candidates) {
      const acquired = await tryAcquireLock(slot);
      if (acquired) {
        try {
          sessionStorage.setItem("p2p_direct_slot", slot);
        } catch {
          // ignore
        }
        return slot;
      }
    }
  }

  const fallback = savedSlot || "default";
  try {
    sessionStorage.setItem("p2p_direct_slot", fallback);
  } catch {
    // ignore
  }
  return fallback;
}

function tryAcquireLock(slot) {
  return new Promise((resolve) => {
    try {
      navigator.locks
        .request(`p2p-direct-slot:${slot}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          resolve(true);
          return new Promise(() => {});
        })
        .catch(() => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

function holdSlotLock(slot) {
  if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
    navigator.locks
      .request(`p2p-direct-slot:${slot}`, { ifAvailable: true }, (lock) => {
        if (!lock) return;
        return new Promise(() => {});
      })
      .catch(() => {});
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "slot" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open error"));
  });
}

export function createDefaultProfile(slot) {
  const peerId = `p-${randomHex(6)}`;
  let index = 0;
  if (slot.startsWith("peer-")) {
    const parsed = Number.parseInt(slot.slice(5), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      index = (parsed - 1) % DEFAULT_NAMES.length;
    }
  }
  const suffix = peerId.slice(2, 6).toUpperCase();
  const baseName =
    slot === "default"
      ? `Node-${suffix}`
      : slot.startsWith("peer-")
        ? `${DEFAULT_NAMES[index]}-${suffix}`
        : slot;

  return {
    slot,
    peerId,
    authorName: baseName,
    room: "mesh-main",
    autoMeshEnabled: true,
    x25519Secret: randomBase64Url(32),
    meshKey: randomBase64Url(32),
    passphraseMode: false,
    knownPeers: [],
    snapshot: { version: 2, e2ee: "chacha20-poly1305", lamport: 0, records: [] },
    updatedAt: Date.now(),
  };
}

function ensureCryptoFields(record) {
  if (!record.x25519Secret) {
    record.x25519Secret = randomBase64Url(32);
  }
  if (!record.meshKey) {
    record.meshKey = randomBase64Url(32);
  }
  if (typeof record.passphraseMode !== "boolean") {
    record.passphraseMode = false;
  }
  if (!Array.isArray(record.knownPeers)) {
    record.knownPeers = [];
  }
  return record;
}

export function upsertKnownPeer(profile, peerInfo) {
  if (!profile || !peerInfo || !peerInfo.peerId || peerInfo.peerId === profile.peerId) {
    return;
  }
  if (!Array.isArray(profile.knownPeers)) {
    profile.knownPeers = [];
  }
  const existingIdx = profile.knownPeers.findIndex((p) => p.peerId === peerInfo.peerId);
  const entry = {
    peerId: peerInfo.peerId,
    authorName: peerInfo.authorName || "Peer",
    pubKey: peerInfo.pubKey || "",
    lastSeenAt: Date.now(),
  };
  if (existingIdx >= 0) {
    profile.knownPeers[existingIdx] = { ...profile.knownPeers[existingIdx], ...entry };
  } else {
    profile.knownPeers.unshift(entry);
  }
  profile.knownPeers.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  if (profile.knownPeers.length > 24) {
    profile.knownPeers.length = 24;
  }
}

export async function loadProfileState(slot) {
  try {
    const db = await openDb();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(slot);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("IndexedDB read error"));
    });
    db.close();
    if (record && record.peerId) {
      return ensureCryptoFields(record);
    }
  } catch {
    // Fallback to localStorage below
  }

  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${slot}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.peerId) {
        return ensureCryptoFields(parsed);
      }
    }
  } catch {
    // ignore corrupt localStorage
  }

  const fresh = createDefaultProfile(slot);
  await saveProfileState(fresh);
  return fresh;
}

export async function saveProfileState(profile) {
  const record = {
    ...profile,
    updatedAt: Date.now(),
  };

  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB write error"));
    });
    db.close();
  } catch {
    // Fallback to localStorage
  }

  try {
    const serialized = JSON.stringify(record);
    if (serialized.length < 1_500_000) {
      localStorage.setItem(`${LS_PREFIX}${record.slot}`, serialized);
    }
  } catch {
    // Ignore localStorage quota exceeded when IndexedDB holds the full encrypted log
  }
}
