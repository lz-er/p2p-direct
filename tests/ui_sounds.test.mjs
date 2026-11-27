import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { UI_SOUND_DEFS, createUiSoundPlayer } from "../ui_sounds.js";
import { DEFAULT_AUDIO_SETTINGS, sanitizeAudioSettings } from "../storage.js";

function createMockAudioContextClass(log) {
  return class MockAudioContext {
    constructor() {
      this.state = "running";
      this.currentTime = 1.0;
      this.destination = { kind: "destination" };
      this.sinkIds = [];
      this.closed = false;
      log.contexts.push(this);
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    setSinkId(id) {
      this.sinkIds.push(id);
      return Promise.resolve();
    }
    createOscillator() {
      const osc = {
        type: "sine",
        freqs: [],
        startedAt: null,
        stoppedAt: null,
        connectedTo: null,
        frequency: {
          setValueAtTime(f, t) {
            osc.freqs.push({ f, t });
          },
        },
        connect(dest) {
          osc.connectedTo = dest;
        },
        start(t) {
          osc.startedAt = t;
        },
        stop(t) {
          osc.stoppedAt = t;
        },
      };
      log.oscillators.push(osc);
      return osc;
    }
    createGain() {
      const gain = {
        events: [],
        connectedTo: null,
        gain: {
          setValueAtTime(v, t) {
            gain.events.push({ fn: "set", v, t });
          },
          linearRampToValueAtTime(v, t) {
            gain.events.push({ fn: "linear", v, t });
          },
          exponentialRampToValueAtTime(v, t) {
            gain.events.push({ fn: "exp", v, t });
          },
        },
        connect(dest) {
          gain.connectedTo = dest;
        },
      };
      log.gains.push(gain);
      return gain;
    }
    close() {
      this.closed = true;
      this.state = "closed";
      return Promise.resolve();
    }
  };
}

describe("UI Sound Effects — ui_sounds.js & storage.js", () => {
  it("defines all 9 required synthesized UI sound recipes", () => {
    const required = [
      "peer_join",
      "voice_join",
      "voice_leave",
      "self_join",
      "self_leave",
      "mute",
      "unmute",
      "deafen",
      "undeafen",
    ];
    for (const name of required) {
      const def = UI_SOUND_DEFS[name];
      assert.ok(def && Array.isArray(def.notes) && def.notes.length >= 2, `Missing recipe for ${name}`);
      for (const note of def.notes) {
        assert.ok(note.freq > 100 && note.freq < 4000);
        assert.ok(note.durMs > 0);
        assert.ok(note.gain > 0 && note.gain <= 0.25);
      }
    }
  });

  it("plays mute/unmute/deafen/undeafen/peer_join/voice_join/voice_leave, respects getEnabled(), and applies setSinkId", () => {
    const log = { contexts: [], oscillators: [], gains: [] };
    let enabled = true;
    let outDevice = "headphones-1";

    const player = createUiSoundPlayer({
      getEnabled: () => enabled,
      getOutputDeviceId: () => outDevice,
      AudioContextCtor: createMockAudioContextClass(log),
    });

    const sounds = ["mute", "unmute", "deafen", "undeafen", "peer_join", "voice_join", "voice_leave"];
    let expectedOscCount = 0;
    for (const s of sounds) {
      assert.equal(player.play(s), true);
      expectedOscCount += UI_SOUND_DEFS[s].notes.length;
    }
    assert.equal(log.contexts.length, 1);
    assert.equal(log.oscillators.length, expectedOscCount);
    assert.deepEqual(log.contexts[0].sinkIds, ["headphones-1"]);

    // Verify smooth attack + release envelopes and direct connection to ctx.destination
    for (const g of log.gains) {
      assert.equal(g.connectedTo, log.contexts[0].destination);
      assert.equal(g.events.length, 3);
      assert.equal(g.events[0].fn, "set");
      assert.equal(g.events[1].fn, "linear");
      assert.equal(g.events[2].fn, "exp");
    }

    // Switching output device updates sinkId cleanly
    outDevice = "speakers-2";
    assert.equal(player.play("self_join"), true);
    assert.deepEqual(log.contexts[0].sinkIds, ["headphones-1", "speakers-2"]);

    // Respects getEnabled() === false and unknown sound names
    enabled = false;
    const countBefore = log.oscillators.length;
    assert.equal(player.play("mute"), false);
    assert.equal(log.oscillators.length, countBefore);

    enabled = true;
    assert.equal(player.play("nonexistent_sound"), false);

    player.dispose();
    assert.equal(log.contexts[0].closed, true);
  });

  it("no-ops cleanly in headless Node when AudioContext is unavailable", () => {
    const player = createUiSoundPlayer({ getEnabled: () => true });
    assert.equal(player.play("mute"), false);
    assert.doesNotThrow(() => player.dispose());
  });

  it("persists and sanitizes uiSounds boolean in storage.js audio settings", () => {
    assert.equal(DEFAULT_AUDIO_SETTINGS.uiSounds, true);
    assert.equal(sanitizeAudioSettings({}).uiSounds, true);
    assert.equal(sanitizeAudioSettings({ uiSounds: false }).uiSounds, false);
    assert.equal(sanitizeAudioSettings({ uiSounds: true }).uiSounds, true);
    assert.equal(sanitizeAudioSettings({ uiSounds: "yes" }).uiSounds, true);
  });
});
