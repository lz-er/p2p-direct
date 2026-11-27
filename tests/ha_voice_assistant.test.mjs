import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { WebSocketServer, WebSocket } from "../bot/node_modules/ws/wrapper.mjs";
import {
  VOICE_FRAME_SAMPLES,
  resamplePcm16,
  VoiceRoomMixer,
} from "../bot/sdk.mjs";
import { P2PBotBridge } from "../bot/bridge.mjs";
import {
  WyomingFrameDecoder,
  WyomingSatelliteServer,
  encodeWyomingEvent,
} from "../bot/wyoming.mjs";
import { HomeAssistantVoiceAssistant } from "../bot/ha-assistant.mjs";

function makeSinePcm(sampleRate, durationMs, channels = 1, amplitude = 12000) {
  const frames = Math.round((sampleRate * durationMs) / 1000);
  const buf = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amplitude);
    for (let c = 0; c < channels; c++) {
      buf.writeInt16LE(s, (i * channels + c) * 2);
    }
  }
  return buf;
}

describe("Bot SDK Voice Assistant DSP — resamplePcm16 & VoiceRoomMixer", () => {
  it("resamples arbitrary PCM (22050 Hz mono & 48000 Hz stereo) cleanly to 16 kHz mono", () => {
    const pcm16 = makeSinePcm(16000, 20, 1);
    assert.equal(resamplePcm16(pcm16, { sampleRate: 16000, channels: 1 }).length, 640);

    const pcm22k = makeSinePcm(22050, 100, 1);
    const out22 = resamplePcm16(pcm22k, { sampleRate: 22050, channels: 1 });
    assert.ok(Math.abs(out22.length - 3200) <= 4, `expected ~3200 bytes, got ${out22.length}`);

    const pcm48Stereo = makeSinePcm(48000, 50, 2);
    const out48 = resamplePcm16(pcm48Stereo, { sampleRate: 48000, channels: 2 });
    assert.equal(out48.length, 1600);
  });

  it("fills silence gaps, supports speaker locking, allowlists, and TTS echo suppression", () => {
    const mixer = new VoiceRoomMixer({ echoSuppression: true, echoTailMs: 300 });

    // Silence gap fill when no peers have sent packets
    const silent = mixer.produceFrame(1000);
    assert.equal(silent.pcm.length, VOICE_FRAME_SAMPLES);
    assert.equal(silent.buffer.length, 640);
    assert.equal(silent.isSilence, true);
    assert.equal(silent.rms, 0);

    // Push two speakers
    const a = new Int16Array(VOICE_FRAME_SAMPLES).fill(1000);
    const b = new Int16Array(VOICE_FRAME_SAMPLES).fill(2000);
    mixer.pushPeerAudio("peer-a", a, 1000);
    mixer.pushPeerAudio("peer-b", b, 2000);

    const mixed = mixer.produceFrame(1020);
    assert.equal(mixed.isSilence, false);
    assert.equal(mixed.pcm[0], 3000);
    assert.equal(mixed.dominantPeerId, "peer-b");

    // Lock to peer-a -> peer-b is excluded
    mixer.lockSpeaker("peer-a");
    mixer.pushPeerAudio("peer-a", a, 1000);
    mixer.pushPeerAudio("peer-b", b, 2000);
    const locked = mixer.produceFrame(1040);
    assert.deepEqual(locked.activePeerIds, ["peer-a"]);
    assert.equal(locked.pcm[0], 1000);
    mixer.unlockSpeaker();

    // TTS echo suppression zeroes inbound audio during speech and tail
    mixer.setExternalSpeaking(true);
    mixer.pushPeerAudio("peer-a", a, 1000);
    const suppressed = mixer.produceFrame(2000);
    assert.equal(suppressed.suppressed, true);
    assert.equal(suppressed.isSilence, true);
    assert.equal(suppressed.pcm[0], 0);
    mixer.setExternalSpeaking(false);

    // Allowlist ignores unlisted speakers
    mixer.setAllowedSpeakers(["peer-a"]);
    mixer.pushPeerAudio("peer-b", b, 2000);
    const afterAllow = mixer.produceFrame(Date.now() + 1000);
    assert.equal(afterAllow.isSilence, true);
  });
});

describe("Wyoming Voice Satellite Protocol & Server", () => {
  it("encodes and decodes fragmented Wyoming events including data_length + binary payloads", () => {
    const payload = Buffer.from([1, 2, 3, 4, 5, 6]);
    const extraData = Buffer.from(JSON.stringify({ rate: 16000, width: 2, channels: 1 }), "utf8");
    const hdr = Buffer.from(
      `${JSON.stringify({ type: "audio-chunk", data_length: extraData.length, payload_length: payload.length })}\n`,
      "utf8"
    );
    const full = Buffer.concat([hdr, extraData, payload]);

    const dec = new WyomingFrameDecoder();
    const out = [];
    for (let i = 0; i < full.length; i += 5) {
      out.push(...dec.push(full.subarray(i, i + 5)));
    }
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "audio-chunk");
    assert.equal(out[0].data.rate, 16000);
    assert.deepEqual(out[0].payload, payload);
  });

  it("handles describe/info, wake-word, button listen-now, TTS played, timers, and stt-error auto-rearm", async () => {
    const sat = new WyomingSatelliteServer({
      host: "127.0.0.1",
      port: 0,
      name: "test-p2p-sat",
      area: "Office",
      wakeWordEnabled: true,
      rearmDelayMs: 60,
    });
    const { port } = await sat.start();

    const receivedByHa = [];
    const dec = new WyomingFrameDecoder();
    const client = net.createConnection({ host: "127.0.0.1", port });
    const waitEvent = (type, timeoutMs = 2000) =>
      new Promise((resolve, reject) => {
        const onData = () => check();
        const timer = setTimeout(() => {
          client.off("data", onData);
          reject(new Error(`Timeout waiting for ${type}`));
        }, timeoutMs);
        const check = () => {
          const idx = receivedByHa.findIndex((e) => e.type === type);
          if (idx !== -1) {
            clearTimeout(timer);
            client.off("data", onData);
            const [ev] = receivedByHa.splice(idx, 1);
            resolve(ev);
          }
        };
        client.on("data", onData);
        check();
      });

    client.on("data", (chunk) => {
      receivedByHa.push(...dec.push(chunk));
    });

    try {
      // 1. Handshake: describe -> info
      client.write(encodeWyomingEvent("describe"));
      const infoEv = await waitEvent("info");
      assert.equal(infoEv.data.satellite.name, "test-p2p-sat");
      assert.equal(infoEv.data.satellite.area, "Office");
      assert.equal(infoEv.data.satellite.supports_trigger, true);

      // 2. HA starts satellite -> satellite arms wake-word pipeline
      client.write(encodeWyomingEvent("run-satellite"));
      const wakeRun = await waitEvent("run-pipeline");
      assert.equal(wakeRun.data.start_stage, "wake");
      assert.equal(wakeRun.data.end_stage, "tts");
      await waitEvent("audio-start");

      // 3. Button activation skips wake word -> start_stage = "asr"
      assert.equal(sat.triggerListenNow({ wakeWordName: "button" }), true);
      const asrRun = await waitEvent("run-pipeline");
      assert.equal(asrRun.data.start_stage, "asr");

      // 4. Native HA Timer events + TTS playback + played ack
      const eventsSeen = [];
      sat.on("timerStarted", (t) => eventsSeen.push(["timerStarted", t]));
      sat.on("timerFinished", (t) => eventsSeen.push(["timerFinished", t]));
      sat.on("ttsAudio", (a) => eventsSeen.push(["ttsAudio", a.rate, a.buffer.length]));

      client.write(encodeWyomingEvent("timer-started", { id: "t1", name: "Pasta", total_seconds: 300 }));
      client.write(encodeWyomingEvent("audio-start", { rate: 22050, width: 2, channels: 1 }));
      client.write(encodeWyomingEvent("audio-chunk", { rate: 22050, width: 2, channels: 1 }, Buffer.alloc(440)));
      client.write(encodeWyomingEvent("audio-stop"));
      client.write(encodeWyomingEvent("timer-finished", { id: "t1" }));

      await new Promise((r) => setTimeout(r, 80));
      assert.ok(eventsSeen.some(([k, v]) => k === "timerStarted" && v.name === "Pasta"));
      assert.ok(eventsSeen.some(([k, rate, len]) => k === "ttsAudio" && rate === 22050 && len === 440));
      assert.ok(eventsSeen.some(([k, v]) => k === "timerFinished" && v.id === "t1"));

      sat.notifyAudioPlayed();
      await waitEvent("played");

      // 5. Auto-recovery re-arm after stt-no-text-recognized
      receivedByHa.length = 0;
      client.write(encodeWyomingEvent("error", { code: "stt-no-text-recognized", text: "" }));
      const rearmed = await waitEvent("run-pipeline");
      assert.equal(rearmed.data.start_stage, "wake");
    } finally {
      client.destroy();
      await sat.stop();
    }
  });
});

describe("P2PBotBridge Standby Mode & HomeAssistantVoiceAssistant Integration", () => {
  it("starts P2PBotBridge in standby mode without --room and handles dynamic audio commands", async () => {
    const bridge = new P2PBotBridge({ host: "127.0.0.1", port: 0, name: "StandbyAssist" });
    const info = await bridge.start();
    assert.equal(info.state, "disconnected");

    const ws = new WebSocket(info.wsUrl);
    const msgs = [];
    ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString("utf8"))));
    await new Promise((r) => ws.once("open", r));
    await new Promise((r) => setTimeout(r, 40));

    try {
      assert.equal(msgs[0].event, "ready");
      assert.equal(msgs[0].state, "disconnected");

      const sendCmd = (obj) =>
        new Promise((resolve) => {
          const reqId = `r-${Math.random()}`;
          const onMsg = (raw) => {
            const m = JSON.parse(raw.toString("utf8"));
            if (m.event === "reply" && m.reqId === reqId) {
              ws.off("message", onMsg);
              resolve(m);
            }
          };
          ws.on("message", onMsg);
          ws.send(JSON.stringify({ ...obj, reqId }));
        });

      const fmtReply = await sendCmd({ cmd: "set_pcm_input_format", sampleRate: 22050, channels: 1 });
      assert.equal(fmtReply.ok, true);
      assert.equal(fmtReply.data.sampleRate, 22050);

      const mixReply = await sendCmd({ cmd: "subscribe_mixed_audio", enabled: true });
      assert.equal(mixReply.ok, true);
      assert.equal(mixReply.data.frameBytes, 640);

      const errReply = await sendCmd({ cmd: "send_text", text: "hi" });
      assert.equal(errReply.ok, false);
      assert.match(errReply.error, /standby mode/i);
    } finally {
      ws.close();
      await bridge.stop();
    }
  });

  it("watches HA helper state changes, runs conversation/process, renders live timer blocks, and serves Control Panel UI", async () => {
    // Mock Home Assistant WebSocket API
    const mockHaWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => mockHaWss.once("listening", r));
    const haPort = mockHaWss.address().port;

    mockHaWss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "auth_required" }));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        if (m.type === "auth") {
          ws.send(JSON.stringify({ type: m.access_token === "secret-tok" ? "auth_ok" : "auth_invalid" }));
        } else if (m.type === "subscribe_events") {
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
        } else if (m.type === "get_states") {
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: [{ entity_id: "input_text.p2p_voice_room_link", state: "" }],
          }));
        } else if (m.type === "conversation/process") {
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: {
              conversation_id: "conv-42",
              response: {
                response_type: "action_done",
                speech: { plain: { speech: "The living room light is now on." } },
              },
            },
          }));
        }
      });
    });

    const assistant = new HomeAssistantVoiceAssistant({
      wyomingHost: "127.0.0.1",
      wyomingPort: 0,
      uiHost: "127.0.0.1",
      uiPort: 0,
      haUrl: `http://127.0.0.1:${haPort}`,
      haToken: "secret-tok",
      roomHelper: "input_text.p2p_voice_room_link",
    });

    const { ui } = await assistant.start();
    await new Promise((r) => setTimeout(r, 120));

    try {
      // Control panel HTML & API work with zero external dependencies
      const htmlRes = await fetch(`http://127.0.0.1:${ui.port}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.match(html, /Room Voice Bridge/);

      const statusRes = await fetch(`http://127.0.0.1:${ui.port}/api/status`).then((r) => r.json());
      assert.equal(statusRes.ok, true);
      assert.equal(statusRes.state.homeAssistant.authenticated, true);

      // Text Q&A via HA conversation/process
      const askRes = await fetch(`http://127.0.0.1:${ui.port}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Turn on the living room light" }),
      }).then((r) => r.json());
      assert.equal(askRes.ok, true);
      assert.equal(askRes.reply.text, "The living room light is now on.");

      // Simulate active HA timer -> verify live timer block appears on chat card
      assistant.wyoming.emit("timerStarted", {
        id: "ha-timer-1",
        name: "Tea Timer",
        totalSeconds: 180,
        commandText: "",
      });
      const card = assistant.buildChatCard();
      assert.equal(card.icon, "home");
      const timerBlock = card.blocks.find((b) => b.type === "timer");
      assert.ok(timerBlock, "expected declarative live timer block on HA chat card");
      assert.equal(timerBlock.label, "Tea Timer");
      assert.equal(timerBlock.totalSec, 180);
      assert.ok(timerBlock.endsAtMs > Date.now());
    } finally {
      await assistant.stop();
      await new Promise((r) => mockHaWss.close(r));
    }
  });
});
