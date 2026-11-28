import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  HOST_SIGNALING_SETTLE_MS,
  electRoomSignalingHost,
  shouldDisconnectSignalingBroker,
} from "../peer_hop.js";
import { SafeRustWasmMesh } from "../wasm_client.js";
import { P2PBot } from "../bot/sdk.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, "..", "p2p_mesh.wasm");

/**
 * In-memory direct WebRTC DataChannel pair (p2p-mesh, p2p-voice, p2p-bulk)
 * between two P2PBot instances backed by real p2p_mesh.wasm.
 */
function createVirtualDirectPair() {
  const makeChannelPair = (label) => {
    const chA = {
      label,
      transport: "direct",
      readyState: "connecting",
      bufferedAmount: 0,
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null,
      send(data) {
        if (this.readyState !== "open" || chB.readyState !== "open") return;
        if (typeof chB.onmessage === "function") chB.onmessage({ data });
      },
      close() {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        const cb = this.onclose;
        this.onclose = null;
        if (typeof cb === "function") cb();
        if (chB.readyState !== "closed") {
          chB.readyState = "closed";
          const cbB = chB.onclose;
          chB.onclose = null;
          if (typeof cbB === "function") cbB();
        }
      },
    };
    const chB = {
      label,
      transport: "direct",
      readyState: "connecting",
      bufferedAmount: 0,
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null,
      send(data) {
        if (this.readyState !== "open" || chA.readyState !== "open") return;
        if (typeof chA.onmessage === "function") chA.onmessage({ data });
      },
      close() {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        const cb = this.onclose;
        this.onclose = null;
        if (typeof cb === "function") cb();
        if (chA.readyState !== "closed") {
          chA.readyState = "closed";
          const cbA = chA.onclose;
          chA.onclose = null;
          if (typeof cbA === "function") cbA();
        }
      },
    };
    return [chA, chB];
  };

  const [dcA, dcB] = makeChannelPair("p2p-mesh");
  const [voiceA, voiceB] = makeChannelPair("p2p-voice");
  const [bulkA, bulkB] = makeChannelPair("p2p-bulk");
  const makePc = () => ({
    connectionState: "connected",
    iceConnectionState: "connected",
    onconnectionstatechange: null,
    close() {
      this.connectionState = "closed";
      this.iceConnectionState = "closed";
    },
  });

  const openAll = () => {
    for (const ch of [voiceA, voiceB, bulkA, bulkB, dcA, dcB]) {
      ch.readyState = "open";
    }
    for (const ch of [voiceA, voiceB, bulkA, bulkB, dcA, dcB]) {
      if (typeof ch.onopen === "function") {
        const cb = ch.onopen;
        ch.onopen = null;
        cb();
      }
    }
  };

  return {
    a: { pc: makePc(), dc: dcA, voiceDc: voiceA, bulkDc: bulkA },
    b: { pc: makePc(), dc: dcB, voiceDc: voiceB, bulkDc: bulkB },
    openAll,
  };
}

/**
 * Tracks live broker connections per peer so tests can assert exact open/parked
 * signaling socket counts across the entire room.
 */
function createMockBrokerBus() {
  const activeClients = new Set();
  const statsByPeer = new Map();

  const createFactoryFor = (peerId) => {
    const stats = { starts: 0, stops: 0, active: false, published: 0, received: 0 };
    statsByPeer.set(peerId, stats);

    return ({ roomTopic, urls, onMessage, onBrokerReady }) => {
      const client = {
        peerId,
        roomTopic,
        urls,
        started: false,
        start() {
          this.started = true;
          stats.starts += 1;
          stats.active = true;
          activeClients.add(client);
          if (typeof onBrokerReady === "function") {
            onBrokerReady(client, this.getStatus());
          }
        },
        stop() {
          if (!this.started) return;
          this.started = false;
          stats.stops += 1;
          stats.active = false;
          activeClients.delete(client);
        },
        publish(sealedPayload) {
          stats.published += 1;
          for (const other of Array.from(activeClients)) {
            if (other !== client && other.roomTopic === roomTopic && other.started) {
              other._deliver(sealedPayload);
            }
          }
        },
        _deliver(sealedPayload) {
          stats.received += 1;
          if (typeof onMessage === "function") onMessage(sealedPayload);
        },
        getStatus() {
          return {
            state: this.started ? "connected" : "disconnected",
            connectedCount: this.started ? 1 : 0,
            totalCount: 1,
            connectedUrls: this.started ? urls.slice(0, 1) : [],
          };
        },
      };
      return client;
    };
  };

  return {
    activeClients,
    statsByPeer,
    createFactoryFor,
    activePeerIds() {
      return Array.from(activeClients)
        .map((c) => c.peerId)
        .sort();
    },
  };
}

async function createOfflineHostBot({
  peerId,
  name,
  isBot = false,
  meshKey,
  room = "host-sig-room",
  electedHostSignaling = false,
  hostSignalingSettleMs = 0,
  canHost = true,
  bus,
}) {
  const wasmBytes = await readFile(WASM_PATH);
  const wasm = await SafeRustWasmMesh.loadFromBytes(wasmBytes);
  const bot = new P2PBot({
    roomLink: "#room=placeholder",
    name,
    peerId,
    isBot,
    iceServers: [],
    electedHostSignaling,
    hostSignalingSettleMs,
    rendezvousFactory: bus.createFactoryFor(peerId),
  });
  // Offline unit tests wire direct WebRTC DataChannels via connectDirectBots()
  bot._startRoomOffer = async () => {};
  bot.wasm = wasm;
  const initRes = wasm.call({
    cmd: "init",
    peerId,
    authorName: name,
    room,
    meshKey,
    passphraseMode: false,
    autoMeshEnabled: false,
    isBot,
    x25519Secret: crypto.randomBytes(32).toString("base64url"),
    entropy: crypto.randomBytes(32).toString("base64url"),
  });
  bot.status = initRes.status;
  const encoded = wasm.call({
    cmd: "encode_room_invite",
    room,
    entropy: crypto.randomBytes(16).toString("base64url"),
  });
  bot.status = encoded.status;
  bot.activeRoom = {
    name: encoded.room,
    code: encoded.code,
    topic: encoded.roomTopic,
    relay: null,
  };
  bot._relayUrls = canHost ? ["wss://mock-broker.local/mqtt"] : [];
  if (!canHost) {
    bot._canSelfHostSignaling = () => false;
  }
  bot.connected = true;
  if (canHost) {
    bot._startRoomRendezvous();
  }
  bot._reconcileHostSignalingRole(Date.now());
  return bot;
}

function connectDirectBots(botA, botB) {
  const pair = createVirtualDirectPair();
  botA._attachVoiceDataChannel(botB.peerId, pair.a.voiceDc);
  botA._attachBulkDataChannel(botB.peerId, pair.a.bulkDc);
  botB._attachVoiceDataChannel(botA.peerId, pair.b.voiceDc);
  botB._attachBulkDataChannel(botA.peerId, pair.b.bulkDc);

  botA._attachDataChannel(
    pair.a.pc,
    pair.a.dc,
    botB.peerId,
    botB.name,
    botB.status.e2ee.publicKey,
    false,
    null
  );
  botB._attachDataChannel(
    pair.b.pc,
    pair.b.dc,
    botA.peerId,
    botA.name,
    botA.status.e2ee.publicKey,
    false,
    null
  );
  pair.openAll();
  return pair;
}

describe("Optional Elected Host Signaling — Pure Election & Parking Guards", () => {
  it("deterministically elects the exact same Host across every peer in a mesh", () => {
    const mkDirect = (ids) =>
      new Map(ids.map((id) => [id, { transport: "direct", superseded: false, dc: { readyState: "open" } }]));

    const allPeers = ["peer-cc", "peer-aa", "peer-dd", "peer-bb"];
    for (const selfId of allPeers) {
      const others = allPeers.filter((id) => id !== selfId);
      const res = electRoomSignalingHost({
        selfPeerId: selfId,
        selfIsBot: false,
        selfCanHost: true,
        directPeers: mkDirect(others),
        statusPeers: [],
      });
      assert.equal(res.hostPeerId, "peer-aa", `${selfId} must elect peer-aa`);
      assert.equal(res.isSelfHost, selfId === "peer-aa");
      assert.equal(res.hostCanHost, true);
    }
  });

  it("prioritizes canHost=true first, then always-on bots (isBot=true), then lexicographical peerId", () => {
    const directPeers = new Map([
      ["peer-aa", { transport: "direct", superseded: false, dc: { readyState: "open" } }],
      ["zzz-bot", { transport: "direct", superseded: false, dc: { readyState: "open" } }],
      ["bot-no-sig", { transport: "direct", superseded: false, dc: { readyState: "open" } }],
    ]);
    const statusPeers = [
      { peerId: "peer-aa", isBot: false },
      { peerId: "zzz-bot", isBot: true },
      { peerId: "bot-no-sig", isBot: true },
    ];
    const peerHostCapable = new Map([
      ["bot-no-sig", false],
      ["zzz-bot", true],
      ["peer-aa", true],
    ]);

    const res = electRoomSignalingHost({
      selfPeerId: "peer-00",
      selfIsBot: false,
      selfCanHost: true,
      directPeers,
      statusPeers,
      peerHostCapable,
    });
    assert.equal(res.hostPeerId, "zzz-bot", "host-capable bot must beat smaller browser peerId and non-hosting bot");
    assert.equal(res.hostIsBot, true);
    assert.equal(res.hostCanHost, true);
    assert.deepEqual(res.candidates, ["zzz-bot", "peer-00", "peer-aa", "bot-no-sig"]);
  });

  it("enforces all safety guards in shouldDisconnectSignalingBroker before parking broker", () => {
    const now = 100_000;
    const openHostMap = new Map([
      ["peer-aa", { transport: "direct", superseded: false, dc: { readyState: "open" } }],
    ]);
    const base = {
      enabled: true,
      hasActiveRoom: true,
      selfPeerId: "peer-bb",
      hostPeerId: "peer-aa",
      hostCanHost: true,
      directPeers: openHostMap,
      roomDialing: new Map(),
      pendingAutoMeshCount: 0,
      relayNeededCount: 0,
      peerHopPendingCount: 0,
      hostConnectedAtMs: now - HOST_SIGNALING_SETTLE_MS - 100,
      nowMs: now,
      settleMs: HOST_SIGNALING_SETTLE_MS,
    };

    assert.deepEqual(shouldDisconnectSignalingBroker(base), {
      shouldPark: true,
      reason: "delegated-to-host",
    });

    assert.equal(shouldDisconnectSignalingBroker({ ...base, enabled: false }).reason, "disabled");
    assert.equal(shouldDisconnectSignalingBroker({ ...base, hasActiveRoom: false }).reason, "no-room");
    assert.equal(shouldDisconnectSignalingBroker({ ...base, hostPeerId: "peer-bb" }).reason, "self-is-host");
    assert.equal(shouldDisconnectSignalingBroker({ ...base, hostCanHost: false }).reason, "host-cannot-signal");
    assert.equal(shouldDisconnectSignalingBroker({ ...base, directPeers: new Map() }).reason, "no-p2p-link-to-host");

    // Active BYOR relay peer keeps broker open
    const withRelay = new Map([
      ["peer-aa", { transport: "direct", superseded: false, dc: { readyState: "open" } }],
      ["peer-cc", { transport: "relay", superseded: false, dc: { readyState: "open" } }],
    ]);
    assert.equal(shouldDisconnectSignalingBroker({ ...base, directPeers: withRelay }).reason, "active-relay-peer");

    // Initial dial blocks parking, whereas background upgrade probe does NOT (uses hop_ctrl/sig!)
    const initialDial = new Map([["peer-cc", { isUpgradeProbe: false }]]);
    assert.equal(shouldDisconnectSignalingBroker({ ...base, roomDialing: initialDial }).reason, "dialing-in-progress");
    const upgradeProbe = new Map([["peer-cc", { isUpgradeProbe: true }]]);
    assert.equal(shouldDisconnectSignalingBroker({ ...base, roomDialing: upgradeProbe }).shouldPark, true);

    // Mesh settling guards
    assert.equal(shouldDisconnectSignalingBroker({ ...base, pendingAutoMeshCount: 1 }).reason, "mesh-settling");
    assert.equal(shouldDisconnectSignalingBroker({ ...base, peerHopPendingCount: 1 }).reason, "mesh-settling");
    assert.equal(shouldDisconnectSignalingBroker({ ...base, relayNeededCount: 1 }).reason, "mesh-settling");
    assert.equal(shouldDisconnectSignalingBroker({ ...base, hostConnectedAtMs: now - 1000 }).reason, "settle-window");
  });
});

describe("Optional Elected Host Signaling — Multi-Peer Real-WASM Lifecycle & Failover", () => {
  it("stays completely off by default (all peers keep broker sockets open)", async () => {
    const meshKey = crypto.randomBytes(32).toString("base64url");
    const bus = createMockBrokerBus();
    const alice = await createOfflineHostBot({ peerId: "peer-aa", name: "Alice", meshKey, bus });
    const bob = await createOfflineHostBot({ peerId: "peer-bb", name: "Bob", meshKey, bus });

    connectDirectBots(alice, bob);
    alice._reconcileHostSignalingRole(Date.now() + 10_000);
    bob._reconcileHostSignalingRole(Date.now() + 10_000);

    assert.equal(alice.electedHostSignaling, false);
    assert.equal(bob.electedHostSignaling, false);
    assert.equal(alice.signalingParkedForHost, false);
    assert.equal(bob.signalingParkedForHost, false);
    assert.deepEqual(bus.activePeerIds(), ["peer-aa", "peer-bb"]);

    await alice.disconnect();
    await bob.disconnect();
  });

  it("parks non-host peers, auto-promotes on Host disconnect, prefers always-on bots, and resumes cleanly when toggled off", async () => {
    const meshKey = crypto.randomBytes(32).toString("base64url");
    const bus = createMockBrokerBus();
    const t0 = Date.now();

    const alice = await createOfflineHostBot({
      peerId: "peer-aa",
      name: "Alice",
      meshKey,
      electedHostSignaling: true,
      hostSignalingSettleMs: 3000,
      bus,
    });
    const bob = await createOfflineHostBot({
      peerId: "peer-bb",
      name: "Bob",
      meshKey,
      electedHostSignaling: true,
      hostSignalingSettleMs: 3000,
      bus,
    });
    const charlie = await createOfflineHostBot({
      peerId: "peer-cc",
      name: "Charlie",
      meshKey,
      electedHostSignaling: true,
      hostSignalingSettleMs: 3000,
      bus,
    });

    // Connect full 3-peer P2P mesh
    const ab = connectDirectBots(alice, bob);
    const ac = connectDirectBots(alice, charlie);
    const bc = connectDirectBots(bob, charlie);

    // During settle window (< 3000ms), Bob and Charlie elect Alice but wait to park
    assert.equal(alice.electedHostPeerId, "peer-aa");
    assert.equal(bob.electedHostPeerId, "peer-aa");
    assert.equal(charlie.electedHostPeerId, "peer-aa");
    assert.equal(bob.signalingParkedForHost, false, "must wait settleMs before parking");
    assert.equal(charlie.signalingParkedForHost, false, "must wait settleMs before parking");

    // Once settle window elapses, ONLY Host Alice keeps the signaling broker socket open!
    const afterSettle = t0 + 5000;
    alice._reconcileHostSignalingRole(afterSettle);
    bob._reconcileHostSignalingRole(afterSettle);
    charlie._reconcileHostSignalingRole(afterSettle);

    assert.equal(alice.signalingParkedForHost, false);
    assert.ok(alice.roomRendezvous, "Host Alice must keep broker socket open");
    assert.equal(bob.signalingParkedForHost, true);
    assert.equal(bob.roomRendezvous, null, "Non-host Bob must park broker socket");
    assert.equal(charlie.signalingParkedForHost, true);
    assert.equal(charlie.roomRendezvous, null, "Non-host Charlie must park broker socket");
    assert.deepEqual(bus.activePeerIds(), ["peer-aa"], "3-peer room must hold only 1 broker connection");

    // E2EE messaging between Bob and Charlie continues with 0 broker sockets on either peer
    const charlieInbox = [];
    charlie.on("message", (m) => charlieInbox.push(m.payload?.text));
    bob.sendText("zero-broker-hello");
    assert.ok(charlieInbox.includes("zero-broker-hello"));

    // --- HOST FAILOVER TEST: Alice disconnects! ---
    // Force Bob<->Charlie connection age beyond settleMs so Charlie stays parked seamlessly
    charlie.peerConnectedAt.set("peer-bb", t0 - 10_000);
    const bobEvents = [];
    bob.on("hostChanged", (ev) => bobEvents.push(ev));

    ab.a.dc.close();
    ac.a.dc.close();
    await alice.disconnect();

    // Bob MUST immediately promote to Room Host and reopen signaling broker!
    assert.equal(bob.electedHostPeerId, "peer-bb");
    assert.equal(bob.signalingParkedForHost, false, "Promoted Host Bob must resume signaling immediately");
    assert.ok(bob.roomRendezvous, "Promoted Host Bob must have an active broker socket");
    assert.equal(bus.statsByPeer.get("peer-bb").starts, 2, "Bob must have reconnected broker once on promotion");
    assert.ok(
      bobEvents.some((e) => e.isSelfHost === true && e.signalingParked === false),
      "Bob must emit hostChanged on promotion"
    );

    // Charlie MUST switch elected Host to Bob and stay parked at 0 broker sockets!
    assert.equal(charlie.electedHostPeerId, "peer-bb");
    assert.equal(charlie.signalingParkedForHost, true, "Charlie must stay parked while connected to promoted Host Bob");
    assert.equal(charlie.roomRendezvous, null);
    assert.deepEqual(bus.activePeerIds(), ["peer-bb"], "Only newly promoted Host Bob holds the broker socket");

    // Bob <-> Charlie chat remained completely uninterrupted across failover
    bob.sendText("after-failover-ping");
    assert.ok(charlieInbox.includes("after-failover-ping"));

    // --- ALWAYS-ON BOT PROMOTION TEST ---
    // HA Bot has peerId "zzz-ha-bot" (lexicographically LARGER than peer-bb and peer-cc)
    // but isBot=true must win Host election over browser tabs!
    const haBot = await createOfflineHostBot({
      peerId: "zzz-ha-bot",
      name: "HA Voice Bot",
      isBot: true,
      meshKey,
      electedHostSignaling: true,
      hostSignalingSettleMs: 0,
      bus,
    });
    const bBot = connectDirectBots(bob, haBot);
    const cBot = connectDirectBots(charlie, haBot);

    const afterBotSettle = Date.now() + 10_000;
    bob._reconcileHostSignalingRole(afterBotSettle);
    charlie._reconcileHostSignalingRole(afterBotSettle);
    haBot._reconcileHostSignalingRole(afterBotSettle);

    assert.equal(haBot.electedHostPeerId, "zzz-ha-bot");
    assert.equal(bob.electedHostPeerId, "zzz-ha-bot", "Always-on bot must outrank peer-bb");
    assert.equal(charlie.electedHostPeerId, "zzz-ha-bot", "Always-on bot must outrank peer-cc");
    assert.equal(haBot.signalingParkedForHost, false);
    assert.equal(bob.signalingParkedForHost, true, "Bob must yield Host to always-on bot and park");
    assert.equal(charlie.signalingParkedForHost, true);
    assert.deepEqual(bus.activePeerIds(), ["zzz-ha-bot"], "Only always-on HA bot holds the broker socket");

    // --- TOGGLE OFF RECOVERY TEST ---
    charlie.setElectedHostSignaling(false);
    assert.equal(charlie.signalingParkedForHost, false);
    assert.ok(charlie.roomRendezvous, "Disabling Elected Host Signaling must immediately resume broker");
    assert.deepEqual(bus.activePeerIds(), ["peer-cc", "zzz-ha-bot"]);

    // Cleanup
    bc.a.dc.close();
    bBot.a.dc.close();
    cBot.a.dc.close();
    await bob.disconnect();
    await charlie.disconnect();
    await haBot.disconnect();
  });

  it("skips a peer that advertises canHost=false over hop_ctrl/neighbors", async () => {
    const meshKey = crypto.randomBytes(32).toString("base64url");
    const bus = createMockBrokerBus();

    const aliceNoSig = await createOfflineHostBot({
      peerId: "peer-aa",
      name: "Alice Offline",
      meshKey,
      electedHostSignaling: true,
      hostSignalingSettleMs: 0,
      canHost: false,
      bus,
    });
    const bob = await createOfflineHostBot({
      peerId: "peer-bb",
      name: "Bob",
      meshKey,
      electedHostSignaling: true,
      hostSignalingSettleMs: 0,
      canHost: true,
      bus,
    });

    const pair = connectDirectBots(aliceNoSig, bob);
    // Connecting triggers _broadcastDirectNeighborsToDirectPeers() carrying canHost=false from Alice
    bob._reconcileHostSignalingRole(Date.now() + 5000);
    aliceNoSig._reconcileHostSignalingRole(Date.now() + 5000);

    assert.equal(bob.peerHostCapable.get("peer-aa"), false);
    assert.equal(bob.electedHostPeerId, "peer-bb", "Bob must stay Host because peer-aa cannot signal");
    assert.equal(bob.signalingParkedForHost, false);
    assert.deepEqual(bus.activePeerIds(), ["peer-bb"]);

    pair.a.dc.close();
    await aliceNoSig.disconnect();
    await bob.disconnect();
  });
});
