/**
 * Zero-dependency Web Audio API UI sound synthesizer for Direct Voice & Chat.
 * Uses smooth attack/release envelopes (zero clicks/pops), connects directly to
 * `ctx.destination` (never gated by call deafen/masterGain), and degrades silently
 * in headless/Node/autoplay-blocked environments.
 */

export const UI_SOUND_DEFS = Object.freeze({
  peer_join: Object.freeze({
    notes: Object.freeze([
      Object.freeze({ freq: 523.25, startMs: 0, durMs: 65, gain: 0.08, type: "sine" }),
      Object.freeze({ freq: 659.25, startMs: 55, durMs: 75, gain: 0.085, type: "sine" }),
    ]),
  }),
  voice_join: Object.freeze({
    notes: Object.freeze([
      Object.freeze({ freq: 587.33, startMs: 0, durMs: 70, gain: 0.09, type: "triangle" }),
      Object.freeze({ freq: 880.0, startMs: 65, durMs: 85, gain: 0.095, type: "sine" }),
    ]),
  }),
  voice_leave: Object.freeze({
    notes: Object.freeze([
      Object.freeze({ freq: 523.25, startMs: 0, durMs: 65, gain: 0.08, type: "sine" }),
      Object.freeze({ freq: 392.0, startMs: 55, durMs: 75, gain: 0.075, type: "sine" }),
    ]),
  }),
  self_join: Object.freeze({
    notes: Object.freeze([
      Object.freeze({ freq: 440.0, startMs: 0, durMs: 70, gain: 0.09, type: "sine" }),
      Object.freeze({ freq: 659.25, startMs: 60, durMs: 90, gain: 0.095, type: "triangle" }),
    ]),
  }),
  self_leave: Object.freeze({
    notes: Object.freeze([
      Object.freeze({ freq: 587.33, startMs: 0, durMs: 65, gain: 0.085, type: "sine" }),
      Object.freeze({ freq: 392.0, startMs: 55, durMs: 85, gain: 0.08, type: "sine" }),
    ]),
  }),
  mute: Object.freeze({
    notes: Object.freeze([
      Object.freeze({ freq: 480.0, startMs: 0, durMs: 45, gain: 0.09, type: "triangle" }),
      Object.freeze({ freq: 330.0, startMs: 45, durMs: 55, gain: 0.085, type: "sine" }),
    ]),
  }),
  unmute: Object.freeze({
    notes: Object.freeze([
      Object.freeze({ freq: 360.0, startMs: 0, durMs: 45, gain: 0.085, type: "sine" }),
      Object.freeze({ freq: 540.0, startMs: 45, durMs: 55, gain: 0.095, type: "triangle" }),
    ]),
  }),
  deafen: Object.freeze({
    notes: Object.freeze([
      Object.freeze({ freq: 440.0, startMs: 0, durMs: 60, gain: 0.095, type: "triangle" }),
      Object.freeze({ freq: 260.0, startMs: 60, durMs: 80, gain: 0.1, type: "sine" }),
    ]),
  }),
  undeafen: Object.freeze({
    notes: Object.freeze([
      Object.freeze({ freq: 293.66, startMs: 0, durMs: 48, gain: 0.085, type: "sine" }),
      Object.freeze({ freq: 440.0, startMs: 48, durMs: 50, gain: 0.09, type: "triangle" }),
      Object.freeze({ freq: 587.33, startMs: 96, durMs: 65, gain: 0.095, type: "sine" }),
    ]),
  }),
});

/**
 * Creates a lightweight synthesized UI sound player backed by its own dedicated AudioContext.
 */
export function createUiSoundPlayer({
  getEnabled = () => true,
  getOutputDeviceId = () => "",
  AudioContextCtor = null,
} = {}) {
  let ctx = null;
  let lastSinkId = "";

  function resolveCtor() {
    if (typeof AudioContextCtor === "function") return AudioContextCtor;
    if (typeof globalThis.AudioContext === "function") return globalThis.AudioContext;
    if (typeof globalThis.webkitAudioContext === "function") return globalThis.webkitAudioContext;
    return null;
  }

  function ensureContext() {
    if (ctx && ctx.state !== "closed") return ctx;
    const Ctor = resolveCtor();
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
      lastSinkId = "";
      return ctx;
    } catch {
      ctx = null;
      return null;
    }
  }

  function syncSinkId(audioCtx) {
    if (!audioCtx || typeof audioCtx.setSinkId !== "function") return;
    let desired = "";
    try {
      desired = String(getOutputDeviceId?.() || "");
    } catch {
      desired = "";
    }
    if (desired === lastSinkId) return;
    lastSinkId = desired;
    try {
      const p = audioCtx.setSinkId(desired);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      // ignore unsupported/disconnected output device
    }
  }

  function play(soundName) {
    let enabled = true;
    try {
      enabled = Boolean(getEnabled?.());
    } catch {
      enabled = false;
    }
    if (!enabled) return false;

    const def = UI_SOUND_DEFS[soundName];
    if (!def || !Array.isArray(def.notes) || def.notes.length === 0) return false;

    const audioCtx = ensureContext();
    if (!audioCtx) return false;

    try {
      syncSinkId(audioCtx);
      if (audioCtx.state === "suspended" && typeof audioCtx.resume === "function") {
        const rp = audioCtx.resume();
        if (rp && typeof rp.catch === "function") rp.catch(() => {});
      }

      const baseTime = Number.isFinite(audioCtx.currentTime) ? audioCtx.currentTime : 0;
      const startBase = baseTime + 0.004;

      for (const note of def.notes) {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        const t0 = startBase + (Number(note.startMs) || 0) / 1000;
        const dur = Math.max(0.02, (Number(note.durMs) || 60) / 1000);
        const attack = Math.min(0.008, dur * 0.25);
        const peakGain = Math.max(0.001, Math.min(0.25, Number(note.gain) || 0.08));
        const tEnd = t0 + dur;

        osc.type = note.type || "sine";
        osc.frequency.setValueAtTime(Number(note.freq) || 440, t0);

        gainNode.gain.setValueAtTime(0.0001, t0);
        gainNode.gain.linearRampToValueAtTime(peakGain, t0 + attack);
        if (typeof gainNode.gain.exponentialRampToValueAtTime === "function") {
          gainNode.gain.exponentialRampToValueAtTime(0.0001, tEnd);
        } else {
          gainNode.gain.linearRampToValueAtTime(0.0001, tEnd);
        }

        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(tEnd + 0.005);
      }
      return true;
    } catch {
      return false;
    }
  }

  function dispose() {
    if (!ctx) return;
    const old = ctx;
    ctx = null;
    lastSinkId = "";
    try {
      if (typeof old.close === "function") {
        const p = old.close();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    } catch {
      // ignore close errors
    }
  }

  return { play, dispose };
}
