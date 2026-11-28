import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PEER_HOP_DATA_CHUNK_SIZE,
  canReplaceTransport,
  computeDirectUpgradeDelayMs,
  decodePeerHopVoicePacket,
  decrementPeerHopVoiceTtl,
  encodeHopCtrl,
  encodeHopData,
  encodePeerHopVoicePacket,
  isPeerHopVoicePacket,
  isTransportUpgrade,
  normalizeTransportKind,
  selectPeerHopMediators,
  tryParseHopFrame,
} from "../peer_hop.js";
import { SafeRustWasmMesh } from "../wasm_client.js";
import { P2PBot, VOICE_FRAME_SAMPLES } from "../bot/sdk.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, "..", "p2p_mesh.wasm");

/**
 * Creates a pair of synchronous/microtask in-memory DataChannels mimicking WebRTC
 * `p2p-mesh`, `p2p-voice`, and `p2p-bulk` channels between two peers.
 */
function createVirtualDirectPair({ onForwardAtoB = null, onForwardBtoA = null } = {}) {
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
        if (onForwardAtoB) onForwardAtoB(label, data);
        if (typeof chB.onmessage === "function") {
          chB.onmessage({ data });
        }
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
        if (onForwardBtoA) onForwardBtoA(label, data);
        if (typeof chA.onmessage === "function") {
          chA.onmessage({ data });
        }
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
 * Boots an offline P2PBot backed by real p2p_mesh.wasm (zero network / zero MQTT)
 * sharing a common room & mesh key.
 */
async function createOfflineBot({ peerId, name, isBot = false, meshKey, room = "hop-test-room" }) {
  const wasmBytes = await readFile(WASM_PATH);
  const wasm = await SafeRustWasmMesh.loadFromBytes(wasmBytes);
  const bot = new P2PBot({
    roomLink: "#room=placeholder",
    name,
    peerId,
    isBot,
  });
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
  bot.connected = true;
  bot.roomUsesCustomRelay = false;
  return bot;
}

function connectDirectBots(botA, botB, hooks = {}) {
  const pair = createVirtualDirectPair(hooks);
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

describe("Peer-Hop Transport Hierarchy & Helpers (peer_hop.js)", () => {
  it("enforces strict Direct > Peer-Hop > Relay priority and never downgrades", () => {
    assert.equal(normalizeTransportKind("direct"), "direct");
    assert.equal(normalizeTransportKind("peer-hop"), "peer-hop");
    assert.equal(normalizeTransportKind("relay"), "relay");
    assert.equal(normalizeTransportKind(undefined), "direct");

    // Never downgrade!
    assert.equal(canReplaceTransport("direct", "peer-hop"), false);
    assert.equal(canReplaceTransport("direct", "relay"), false);
    assert.equal(canReplaceTransport("peer-hop", "relay"), false);

    // Same-tier or upgrade always allowed
    assert.equal(canReplaceTransport("peer-hop", "direct"), true);
    assert.equal(canReplaceTransport("relay", "peer-hop"), true);
    assert.equal(canReplaceTransport("relay", "direct"), true);
    assert.equal(canReplaceTransport("peer-hop", "peer-hop"), true);
    assert.equal(canReplaceTransport("direct", "direct"), true);

    // Strict upgrade checks
    assert.equal(isTransportUpgrade("peer-hop", "direct"), true);
    assert.equal(isTransportUpgrade("relay", "peer-hop"), true);
    assert.equal(isTransportUpgrade("relay", "direct"), true);
    assert.equal(isTransportUpgrade("direct", "direct"), false);
    assert.equal(isTransportUpgrade("direct", "peer-hop"), false);
    assert.equal(isTransportUpgrade("peer-hop", "peer-hop"), false);
  });

  it("schedules aggressive early Direct P2P upgrade retries for peer-hop", () => {
    assert.equal(computeDirectUpgradeDelayMs(0, "peer-hop"), 12_000);
    assert.equal(computeDirectUpgradeDelayMs(1, "peer-hop"), 24_000);
    assert.equal(computeDirectUpgradeDelayMs(2, "peer-hop"), 45_000);
    assert.equal(computeDirectUpgradeDelayMs(3, "peer-hop"), 90_000);
    assert.equal(computeDirectUpgradeDelayMs(10, "peer-hop"), 120_000);
    assert.equal(computeDirectUpgradeDelayMs(0, "relay"), 20_000);
  });

  it("encodes, decodes, and decrements TTL on binary PH v1 voice envelopes", () => {
    const inner = new Uint8Array([0x56, 0x31, 1, 2, 3, 4, 5, 6, 7, 8]);
    const encoded = encodePeerHopVoicePacket({
      srcPeerId: "peer-alice",
      dstPeerId: "peer-charlie",
      payload: inner,
      ttl: 1,
    });
    assert.ok(encoded instanceof Uint8Array);
    assert.equal(isPeerHopVoicePacket(encoded), true);
    assert.equal(isPeerHopVoicePacket(inner), false);

    const decoded = decodePeerHopVoicePacket(encoded);
    assert.equal(decoded.ttl, 1);
    assert.equal(decoded.srcPeerId, "peer-alice");
    assert.equal(decoded.dstPeerId, "peer-charlie");
    assert.deepEqual(Array.from(decoded.payload), Array.from(inner));

    const fwd = decrementPeerHopVoiceTtl(encoded);
    assert.ok(fwd instanceof Uint8Array);
    assert.equal(decodePeerHopVoicePacket(fwd).ttl, 0);
    assert.equal(decodePeerHopVoicePacket(encoded).ttl, 1, "original buffer must not be mutated");

    // Loop prevention: TTL 0 cannot be forwarded again!
    assert.equal(decrementPeerHopVoiceTtl(fwd), null);

    // Invalid inputs rejected cleanly
    assert.equal(encodePeerHopVoicePacket({ srcPeerId: "", dstPeerId: "b", payload: inner }), null);
    assert.equal(encodePeerHopVoicePacket({ srcPeerId: "a", dstPeerId: "b", payload: new Uint8Array(0) }), null);
    assert.equal(decodePeerHopVoicePacket(new Uint8Array([0x50, 0x48, 0x01, 1, 10, 10])), null);
  });

  it("fast-parses hop_ctrl & hop_data while ignoring normal E2EE frames", () => {
    assert.equal(tryParseHopFrame('{"kind":"e2ee","s":1,"c":"abc"}'), null);
    assert.equal(tryParseHopFrame('{"kind":"dc_chunk","id":1,"i":0,"n":2,"d":"x"}'), null);

    const ctrlStr = encodeHopCtrl({ op: "open", from: "a", to: "c" });
    const parsedCtrl = tryParseHopFrame(ctrlStr);
    assert.equal(parsedCtrl.kind, "hop_ctrl");
    assert.equal(parsedCtrl.op, "open");
    assert.equal(parsedCtrl.from, "a");

    const dataStr = encodeHopData({ ch: "bulk", from: "a", to: "c", d: "ciphertext" });
    const parsedData = tryParseHopFrame(dataStr);
    assert.equal(parsedData.kind, "hop_data");
    assert.equal(parsedData.ch, "bulk");
    assert.equal(parsedData.d, "ciphertext");
  });

  it("deterministically selects mediators (direct-only, bots first, then peerId order)", () => {
    const directPeers = new Map([
      ["peer-z", { transport: "direct", dc: { readyState: "open" }, superseded: false }],
      ["peer-b", { transport: "direct", dc: { readyState: "open" }, superseded: false }],
      ["bot-ha", { transport: "direct", dc: { readyState: "open" }, superseded: false }],
      ["relay-x", { transport: "relay", dc: { readyState: "open" }, superseded: false }],
      ["hop-y", { transport: "peer-hop", dc: { readyState: "open" }, superseded: false }],
      ["closed-d", { transport: "direct", dc: { readyState: "closed" }, superseded: false }],
    ]);
    const peerNeighbors = new Map([
      ["peer-z", new Set(["alice", "charlie"])],
      ["peer-b", new Set(["alice", "charlie"])],
      ["bot-ha", new Set(["alice", "charlie"])],
      ["relay-x", new Set(["alice", "charlie"])],
      ["hop-y", new Set(["alice", "charlie"])],
      ["closed-d", new Set(["alice", "charlie"])],
    ]);
    const botPeerIds = new Set(["bot-ha"]);

    const fromAlice = selectPeerHopMediators({
      selfPeerId: "alice",
      targetPeerId: "charlie",
      directPeers,
      peerNeighbors,
      botPeerIds,
    });
    const fromCharlie = selectPeerHopMediators({
      selfPeerId: "charlie",
      targetPeerId: "alice",
      directPeers,
      peerNeighbors,
      botPeerIds,
    });

    // Both sides converge on identical order: always-on bot first, then lexicographical peerId;
    // relay, peer-hop, and closed peers are strictly excluded!
    assert.deepEqual(fromAlice, ["bot-ha", "peer-b", "peer-z"]);
    assert.deepEqual(fromCharlie, ["bot-ha", "peer-b", "peer-z"]);

    // Exclusions work for failover
    const afterExclude = selectPeerHopMediators({
      selfPeerId: "alice",
      targetPeerId: "charlie",
      directPeers,
      peerNeighbors,
      botPeerIds,
      excludeMediators: new Set(["bot-ha"]),
    });
    assert.deepEqual(afterExclude, ["peer-b", "peer-z"]);
  });
});

describe("3-Peer End-to-End Zero-Server E2EE Peer-Hopping & Direct Upgrade", () => {
  it("connects A <-> C via always-on Bot B with full E2EE chat, >25KB bulk media, voice while B is out of voice, then upgrades zero-drop to Direct P2P", async () => {
    const meshKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
    const alice = await createOfflineBot({ peerId: "peer-alice", name: "Alice", meshKey });
    const bob = await createOfflineBot({ peerId: "bot-ha", name: "HA Assistant", isBot: true, meshKey });
    const charlie = await createOfflineBot({ peerId: "peer-charlie", name: "Charlie", meshKey });

    const observedAtMediator = [];
    const wireAB = connectDirectBots(alice, bob, {
      onForwardAtoB: (label, data) => {
        if (typeof data === "string") observedAtMediator.push({ dir: "A->B", label, data });
      },
    });
    const wireBC = connectDirectBots(bob, charlie, {
      onForwardAtoB: (label, data) => {
        if (typeof data === "string") observedAtMediator.push({ dir: "B->C", label, data });
      },
    });

    try {
      // 1. Both Alice and Charlie learned via `hop_ctrl/neighbors` that Bob is directly connected to the other!
      assert.equal(alice.directPeers.get("bot-ha")?.transport, "direct");
      assert.equal(charlie.directPeers.get("bot-ha")?.transport, "direct");
      assert.equal(alice.peerDirectNeighbors.get("bot-ha")?.has("peer-charlie"), true);
      assert.equal(charlie.peerDirectNeighbors.get("bot-ha")?.has("peer-alice"), true);

      // 2. Alice's Direct ICE to Charlie fails -> fallback picks zero-server Peer-Hop via Bob!
      let relayNeededFired = false;
      alice.on("relayNeeded", () => {
        relayNeededFired = true;
      });
      await alice._requestRelayFallback("peer-charlie", "Charlie", charlie.status.e2ee.publicKey);

      assert.equal(relayNeededFired, false, "must NOT fire relayNeeded when Peer-Hop mediator exists");
      assert.equal(alice.directPeers.get("peer-charlie")?.transport, "peer-hop");
      assert.equal(alice.directPeers.get("peer-charlie")?.hopViaPeerId, "bot-ha");
      assert.equal(charlie.directPeers.get("peer-alice")?.transport, "peer-hop");
      assert.equal(charlie.directPeers.get("peer-alice")?.hopViaPeerId, "bot-ha");

      // 3. E2EE Chat + Large >25 KB Chunked Bulk Message across Peer-Hop (Bob sees ONLY ciphertext!)
      const secretText = "SUPER_SECRET_PEER_HOP_MESSAGE_9911";
      const bigPayload = "X".repeat(PEER_HOP_DATA_CHUNK_SIZE * 2 + 4500); // > 26 KB
      const charlieMessages = [];
      charlie.on("message", (m) => charlieMessages.push(m));

      observedAtMediator.length = 0;
      alice.sendText(secretText);
      alice.sendText(bigPayload);

      const receivedTexts = charlieMessages.map((m) => m.payload?.text);
      assert.ok(receivedTexts.includes(secretText), "Charlie must decrypt E2EE chat over Peer-Hop");
      assert.ok(receivedTexts.includes(bigPayload), "Charlie must reassemble & decrypt >25KB chunked bulk message over Peer-Hop");

      // Verify Bob forwarded `hop_data` frames and NEVER saw plaintext!
      const hopFramesSeenByBob = observedAtMediator.filter(
        (x) => x.data.startsWith('{"kind":"hop_data"')
      );
      assert.ok(hopFramesSeenByBob.length >= 3, "Bob must have forwarded hop_data envelopes including chunked bulk parts");
      for (const f of hopFramesSeenByBob) {
        assert.equal(f.data.includes(secretText), false, "Mediator MUST NEVER see chat plaintext");
        assert.equal(f.data.includes("XXXXXXXXXXXX"), false, "Mediator MUST NEVER see bulk plaintext");
        assert.ok(f.data.length < 15_500, `Every forwarded hop_data frame (${f.data.length}B) must stay safely under WebRTC 16KB SCTP cap`);
      }

      // 4. E2EE Voice over Binary "PH" v1 while Mediator Bob is NOT in voice (standby)!
      assert.equal(bob.inVoice, false);
      alice.joinVoice({ muted: false });
      charlie.joinVoice({ muted: false });

      const charlieVoiceFrames = [];
      charlie.on("voiceAudio", (ev) => charlieVoiceFrames.push(ev));

      // Generate a 440 Hz tone PCM frame (320 samples @ 16 kHz)
      const pcm = new Int16Array(VOICE_FRAME_SAMPLES);
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 14000);
      }
      const sentCount = alice.sendVoicePcm(pcm);
      assert.ok(sentCount >= 1, "Alice must transmit voice over Peer-Hop virtual voice channel");
      assert.equal(charlieVoiceFrames.length, 1, "Charlie must receive voice forwarded by chat-only mediator Bob");
      assert.equal(charlieVoiceFrames[0].peerId, "peer-alice");
      assert.ok(charlieVoiceFrames[0].rms > 2000, "Decrypted E2EE voice frame must carry real audio energy");

      // 4b. Anti-Spoof & Loop Prevention on Mediator Bob
      const spoofedPkt = encodePeerHopVoicePacket({
        srcPeerId: "evil-spoof",
        dstPeerId: "peer-charlie",
        payload: new Uint8Array([0x56, 0x31, 1, 2, 3, 4]),
        ttl: 1,
      });
      const zeroTtlPkt = encodePeerHopVoicePacket({
        srcPeerId: "peer-alice",
        dstPeerId: "peer-charlie",
        payload: new Uint8Array([0x56, 0x31, 1, 2, 3, 4]),
        ttl: 0,
      });
      let forwardedInvalid = 0;
      const origSend = wireBC.a.voiceDc.send.bind(wireBC.a.voiceDc);
      wireBC.a.voiceDc.send = (d) => {
        forwardedInvalid += 1;
        return origSend(d);
      };
      wireAB.a.voiceDc.send(spoofedPkt);
      wireAB.a.voiceDc.send(zeroTtlPkt);
      wireBC.a.voiceDc.send = origSend;
      assert.equal(forwardedInvalid, 0, "Mediator must drop spoofed srcPeerId and TTL=0 voice packets");

      // 5. Zero-Broker Sealed Signaling (`hop_ctrl/sig`) for Direct P2P Upgrade Probes!
      let charlieSawSealedOffer = null;
      const origAcceptOffer = charlie._acceptRoomOffer.bind(charlie);
      charlie._acceptRoomOffer = async (msg) => {
        charlieSawSealedOffer = msg;
      };
      alice._sendRoomSignal({
        t: "offer",
        from: alice.peerId,
        to: charlie.peerId,
        name: alice.name,
        pk: alice.status.e2ee.publicKey,
        sdp: "v=0\r\nmock-direct-upgrade-offer",
      });
      await new Promise((r) => setTimeout(r, 20));
      charlie._acceptRoomOffer = origAcceptOffer;
      assert.ok(charlieSawSealedOffer, "Direct P2P upgrade signaling must reach Charlie via hop_ctrl/sig with zero MQTT broker");
      assert.equal(charlieSawSealedOffer.sdp, "v=0\r\nmock-direct-upgrade-offer");

      // 6. Seamless Zero-Drop Upgrade: Peer-Hop -> Direct WebRTC P2P!
      let aliceLeft = false;
      let charlieLeft = false;
      alice.on("peerLeave", (p) => {
        if (p.peerId === "peer-charlie") aliceLeft = true;
      });
      charlie.on("peerLeave", (p) => {
        if (p.peerId === "peer-alice") charlieLeft = true;
      });

      const directAC = connectDirectBots(alice, charlie);
      assert.equal(alice.directPeers.get("peer-charlie")?.transport, "direct");
      assert.equal(charlie.directPeers.get("peer-alice")?.transport, "direct");
      assert.equal(aliceLeft, false, "Upgrade Peer-Hop -> Direct must be zero-drop (no peerLeave on Alice)");
      assert.equal(charlieLeft, false, "Upgrade Peer-Hop -> Direct must be zero-drop (no peerLeave on Charlie)");

      // Subsequent messages go DIRECTLY without touching Bob!
      observedAtMediator.length = 0;
      const postUpgradeText = "DIRECT_AFTER_UPGRADE_777";
      alice.sendText(postUpgradeText);
      assert.ok(
        charlieMessages.some((m) => m.payload?.text === postUpgradeText),
        "Post-upgrade E2EE messages must deliver seamlessly over Direct P2P using existing WASM session"
      );
      const bobSawPostHop = observedAtMediator.some((x) => x.data.startsWith('{"kind":"hop_data"'));
      assert.equal(bobSawPostHop, false, "Bob must NOT carry any Peer-Hop traffic after Direct P2P upgrade");

      // 7. NEVER downgrade Direct -> Peer-Hop!
      alice._openPeerHopVirtualPeer("peer-charlie", "Charlie", charlie.status.e2ee.publicKey, "bot-ha");
      assert.equal(
        alice.directPeers.get("peer-charlie")?.transport,
        "direct",
        "Direct P2P must NEVER downgrade back to Peer-Hop"
      );

      // 8. Mediator disconnect cleanly closes Peer-Hop and triggers failover when direct is absent
      directAC.a.dc.close();
      await alice._requestRelayFallback("peer-charlie", "Charlie", charlie.status.e2ee.publicKey);
      assert.equal(alice.directPeers.get("peer-charlie")?.transport, "peer-hop");

      // Drop mediator Bob -> Alice tears down Peer-Hop peer cleanly
      wireAB.a.dc.close();
      assert.equal(
        alice.directPeers.has("peer-charlie"),
        false,
        "Peer-Hop peer must tear down immediately when its mediator drops"
      );
    } finally {
      await alice.disconnect();
      await bob.disconnect();
      await charlie.disconnect();
    }
  });
});
