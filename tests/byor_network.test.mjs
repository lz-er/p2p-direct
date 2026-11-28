import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.__P2P_NO_AUTO_BOOT__ = true;

import {
  DEFAULT_MQTT_RELAYS,
  MultiRelayRendezvous,
  hasUserOwnedRelay,
  isThirdPartyRelayUrl,
  isUserOwnedRelayUrl,
  resolveRelayUrls,
} from "../mqtt_relay.js";
import {
  DEFAULT_NETWORK_SETTINGS,
  isValidStunUrl,
  sanitizeNetworkSettings,
} from "../storage.js";
import { buildIceConfig } from "../app.js";

describe("Bring Your Own Relay (BYOR) — Relay & STUN Policy", () => {
  it("classifies built-in 3rd-party demo brokers vs user-owned relays accurately", () => {
    for (const url of DEFAULT_MQTT_RELAYS) {
      assert.equal(isThirdPartyRelayUrl(url), true, `expected ${url} to be flagged as 3rd-party`);
      assert.equal(isUserOwnedRelayUrl(url), false, `expected ${url} NOT to be treated as user-owned`);
    }
    assert.equal(hasUserOwnedRelay(DEFAULT_MQTT_RELAYS), false);

    assert.equal(isThirdPartyRelayUrl("wss://relay.myhome.example/mqtt"), false);
    assert.equal(isUserOwnedRelayUrl("wss://relay.myhome.example/mqtt"), true);
    assert.equal(isUserOwnedRelayUrl("ws://127.0.0.1:9001/mqtt"), true);
    assert.equal(hasUserOwnedRelay(["wss://relay.myhome.example/mqtt"]), true);
    assert.equal(isUserOwnedRelayUrl("https://not-a-ws.example"), false);
  });

  it("uses ONLY user-owned relays when configured and honors allowPublicSignaling=false", () => {
    const custom = resolveRelayUrls(["wss://relay.myhome.example/mqtt"]);
    assert.deepEqual(custom, ["wss://relay.myhome.example/mqtt"]);
    assert.equal(hasUserOwnedRelay(custom), true);

    const strictNone = resolveRelayUrls([], { allowPublicSignaling: false });
    assert.deepEqual(strictNone, []);
    assert.equal(hasUserOwnedRelay(strictNone), false);

    const strictRendezvous = new MultiRelayRendezvous({
      roomTopic: "abcdef1234567890",
      urls: [],
    });
    assert.deepEqual(strictRendezvous.urls, []);

    const defaultSignalingOnly = resolveRelayUrls([], { allowPublicSignaling: true });
    assert.equal(defaultSignalingOnly.length, DEFAULT_MQTT_RELAYS.length);
    assert.equal(hasUserOwnedRelay(defaultSignalingOnly), false);
  });

  it("sanitizes Network Settings strictly — stripping 3rd-party public brokers and invalid URLs", () => {
    const clean = sanitizeNetworkSettings({
      relays: [
        "wss://relay.myhome.example/mqtt",
        "wss://broker.hivemq.com:8884/mqtt", // 3rd-party -> must be rejected
        "wss://relay.myhome.example/mqtt",   // duplicate
        "http://invalid.example",
      ],
      stunServers: [
        "stun:stun.myhome.example:3478",
        "stuns:stun2.myhome.example:5349",
        "turn:not-stun.example:3478", // TURN rejected
        "not a url",
      ],
      disableThirdPartyStun: true,
      blockThirdPartySignaling: true,
    });

    assert.deepEqual(clean.relays, ["wss://relay.myhome.example/mqtt"]);
    assert.deepEqual(clean.stunServers, [
      "stun:stun.myhome.example:3478",
      "stuns:stun2.myhome.example:5349",
    ]);
    assert.equal(clean.disableThirdPartyStun, true);
    assert.equal(clean.blockThirdPartySignaling, true);
    assert.equal(isValidStunUrl("stun:my-box.local:3478"), true);
    assert.equal(isValidStunUrl("turn:my-box.local:3478"), false);
  });

  it("builds ICE config with default STUN, custom STUN only, or zero 3rd-party STUN", () => {
    const def = buildIceConfig(DEFAULT_NETWORK_SETTINGS);
    assert.ok(def.iceServers.length > 0);
    assert.ok(def.iceServers.every((s) => String(s.urls).startsWith("stun:")));

    const custom = buildIceConfig({
      stunServers: ["stun:stun.myhome.example:3478"],
      disableThirdPartyStun: false,
    });
    assert.deepEqual(custom.iceServers, [{ urls: "stun:stun.myhome.example:3478" }]);

    const none = buildIceConfig({
      stunServers: [],
      disableThirdPartyStun: true,
    });
    assert.deepEqual(none.iceServers, []);
  });
});
