/**
 * Deterministic seeded Xoshiro128** PRNG for reproducible P2P & timing simulations.
 * Zero external dependencies. Pure Node 24 ESM.
 */

function rotl32(x, k) {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function fnv1a32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function splitMix32(seed) {
  let z = seed >>> 0;
  return () => {
    z = (z + 0x9e3779b9) >>> 0;
    let t = z;
    t = Math.imul(t ^ (t >>> 16), 0x85ebca6b) >>> 0;
    t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35) >>> 0;
    return (t ^ (t >>> 16)) >>> 0;
  };
}

function normalizeSeed(seed) {
  if (typeof seed === "bigint") {
    const low = Number(seed & 0xffffffffn) >>> 0;
    const high = Number((seed >> 32n) & 0xffffffffn) >>> 0;
    return {
      label: `0x${seed.toString(16)}`,
      initial: (low ^ Math.imul(high, 0x9e3779b1)) >>> 0,
      extra: high,
    };
  }
  if (typeof seed === "number" && Number.isFinite(seed)) {
    const intPart = Math.trunc(seed);
    const low = intPart >>> 0;
    const high = Math.floor(Math.abs(intPart) / 0x100000000) >>> 0;
    return {
      label: String(seed),
      initial: (low ^ Math.imul(high, 0x9e3779b1)) >>> 0,
      extra: high,
    };
  }
  const str = String(seed ?? "1").trim() || "1";
  const hexMatch = str.match(/^(?:0x)?([0-9a-fA-F]+)$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    // Fold arbitrary-length hex cleanly into two 32-bit words
    let a = 0x6a09e667 >>> 0;
    let b = 0xbb67ae85 >>> 0;
    for (let i = 0; i < hex.length; i += 8) {
      const chunk = parseInt(hex.slice(i, i + 8), 16) >>> 0;
      a = Math.imul(a ^ chunk, 0x85ebca6b) >>> 0;
      b = rotl32((b + chunk + 0x9e3779b9) >>> 0, 13);
    }
    return {
      label: str.startsWith("0x") ? str.toLowerCase() : `0x${hex.toLowerCase()}`,
      initial: a,
      extra: b,
    };
  }
  const h1 = fnv1a32(str);
  const h2 = fnv1a32(`${str}|xoshiro128ss`);
  return {
    label: str,
    initial: h1,
    extra: h2,
  };
}

function makePrngFromState(s0, s1, s2, s3, seedLabel) {
  const s = new Uint32Array([s0 >>> 0, s1 >>> 0, s2 >>> 0, s3 >>> 0]);
  if ((s[0] | s[1] | s[2] | s[3]) === 0) {
    s[0] = 0x9e3779b9;
    s[1] = 0x243f6a88;
    s[2] = 0xb7e15162;
    s[3] = 0x8aed2a6a;
  }

  function nextUint32() {
    const result = Math.imul(rotl32(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;

    s[2] = (s[2] ^ s[0]) >>> 0;
    s[3] = (s[3] ^ s[1]) >>> 0;
    s[1] = (s[1] ^ s[2]) >>> 0;
    s[0] = (s[0] ^ s[3]) >>> 0;

    s[2] = (s[2] ^ t) >>> 0;
    s[3] = rotl32(s[3], 11);

    return result;
  }

  function next() {
    return nextUint32() / 0x100000000;
  }

  function int(min, max) {
    let lo = Math.trunc(Number(min));
    let hi = Math.trunc(Number(max));
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = lo;
    if (lo > hi) {
      const tmp = lo;
      lo = hi;
      hi = tmp;
    }
    const span = hi - lo + 1;
    if (span <= 1) return lo;
    if (span <= 0x100000000) {
      // Rejection sampling avoids modulo bias
      const limit = Math.floor(0x100000000 / span) * span;
      let r = nextUint32();
      while (r >= limit) {
        r = nextUint32();
      }
      return lo + (r % span);
    }
    return lo + Math.floor(next() * span);
  }

  function float(min, max) {
    let lo = Number(min);
    let hi = Number(max);
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = lo;
    if (lo > hi) {
      const tmp = lo;
      lo = hi;
      hi = tmp;
    }
    return lo + next() * (hi - lo);
  }

  function chance(p) {
    const prob = Number(p);
    if (!Number.isFinite(prob) || prob <= 0) return false;
    if (prob >= 1) return true;
    return next() < prob;
  }

  function pick(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    return arr[int(0, arr.length - 1)];
  }

  function weighted(items) {
    if (!Array.isArray(items) || items.length === 0) return undefined;
    let total = 0;
    const normalized = [];
    for (const entry of items) {
      let value;
      let weight;
      if (Array.isArray(entry)) {
        value = entry[0];
        weight = Number(entry[1]);
      } else if (entry && typeof entry === "object") {
        value = "value" in entry ? entry.value : entry.item;
        weight = Number(entry.weight);
      } else {
        value = entry;
        weight = 1;
      }
      if (Number.isFinite(weight) && weight > 0) {
        total += weight;
        normalized.push({ value, cumulative: total });
      }
    }
    if (normalized.length === 0 || total <= 0) return undefined;
    const target = next() * total;
    for (const entry of normalized) {
      if (target < entry.cumulative) {
        return entry.value;
      }
    }
    return normalized[normalized.length - 1].value;
  }

  function shuffle(arr) {
    if (!Array.isArray(arr)) return [];
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(0, i);
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  function jitter(baseMs, spreadMs = 0) {
    const base = Number(baseMs) || 0;
    const spread = Math.max(0, Number(spreadMs) || 0);
    if (spread === 0) return Math.max(0, Math.round(base));
    return Math.max(0, Math.round(base + float(-spread, spread)));
  }

  function bytes(length) {
    const len = Math.max(0, Math.trunc(Number(length) || 0));
    const out = new Uint8Array(len);
    let i = 0;
    while (i < len) {
      let r = nextUint32();
      for (let b = 0; b < 4 && i < len; b++, i++) {
        out[i] = r & 0xff;
        r >>>= 8;
      }
    }
    return out;
  }

  function fork(label = "") {
    const h = fnv1a32(String(label));
    const mix = splitMix32((nextUint32() ^ h) >>> 0);
    return makePrngFromState(
      mix() ^ s[0],
      mix() ^ s[1],
      mix() ^ s[2],
      mix() ^ s[3],
      `${seedLabel}:${label}`
    );
  }

  function clone() {
    return makePrngFromState(s[0], s[1], s[2], s[3], seedLabel);
  }

  return {
    seed: seedLabel,
    nextUint32,
    next,
    int,
    float,
    chance,
    pick,
    weighted,
    shuffle,
    jitter,
    bytes,
    fork,
    clone,
  };
}

/**
 * Creates a deterministic seeded Xoshiro128** PRNG instance.
 * @param {number|string|bigint} [seed=1]
 */
export function createPrng(seed = 1) {
  const norm = normalizeSeed(seed);
  const mixA = splitMix32(norm.initial);
  const mixB = splitMix32((norm.extra ^ 0x9e3779b9) >>> 0);
  const s0 = mixA() ^ mixB();
  const s1 = mixA() ^ rotl32(mixB(), 7);
  const s2 = mixA() ^ rotl32(mixB(), 15);
  const s3 = mixA() ^ rotl32(mixB(), 23);
  return makePrngFromState(s0, s1, s2, s3, norm.label);
}
