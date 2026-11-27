import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "../bot/node_modules/ws/wrapper.mjs";
import { SafeRustWasmMesh } from "../wasm_client.js";
import {
  P2PBot,
  StreamingPcmResampler,
  VOICE_FRAME_SAMPLES,
  VOICE_HD_OUT_FRAME_BYTES,
  VOICE_HD_OUT_FRAME_SAMPLES,
  VOICE_HD_OUT_SAMPLE_RATE,
  VOICE_SAMPLE_RATE,
  VOICE_V2_CODEC_PCM16,
  VOICE_V2_HEADER_BYTES,
  resamplePcm16,
  VoiceRoomMixer,
} from "../bot/sdk.mjs";
import { P2PBotBridge } from "../bot/bridge.mjs";
import {
  WyomingFrameDecoder,
  WyomingSatelliteServer,
  encodeWyomingEvent,
} from "../bot/wyoming.mjs";
import {
  HomeAssistantVoiceAssistant,
  HomeAssistantWsClient,
  TIMER_LIST_FEATURES,
  formatTimerDurationLabel,
  formatTimerListSourceLabel,
  formatWakeWordLabel,
  parseHaCliArgs,
  parseWavPcm16,
} from "../bot/ha-assistant.mjs";

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

    // Cubic interpolation accuracy check (22050 -> 24000 Hz 440 Hz sine wave)
    const src22k = makeSinePcm(22050, 100, 1, 16000);
    const up24k = resamplePcm16(src22k, { sampleRate: 22050, channels: 1, targetRate: VOICE_HD_OUT_SAMPLE_RATE });
    const nOut = up24k.length / 2;
    assert.ok(Math.abs(nOut - 2400) <= 2, `expected ~2400 samples, got ${nOut}`);
    let sumSqErr = 0;
    let sumSqRef = 0;
    for (let i = 20; i < nOut - 20; i++) {
      const ref = Math.sin((2 * Math.PI * 440 * i) / 24000) * 16000;
      const got = up24k.readInt16LE(i * 2);
      sumSqErr += (got - ref) ** 2;
      sumSqRef += ref ** 2;
    }
    const relErr = Math.sqrt(sumSqErr / sumSqRef);
    assert.ok(relErr < 0.005, `expected cubic resampling relative error < 0.5%, got ${(relErr * 100).toFixed(3)}%`);
  });

  it("streams chunked 22.05 kHz & 48 kHz stereo PCM through StreamingPcmResampler without boundary clicks or drift", () => {
    assert.equal(VOICE_HD_OUT_SAMPLE_RATE, 24000);
    assert.equal(VOICE_HD_OUT_FRAME_SAMPLES, 480);
    assert.equal(VOICE_HD_OUT_FRAME_BYTES, 960);
    assert.equal(VOICE_V2_CODEC_PCM16, 2);
    assert.equal(VOICE_V2_HEADER_BYTES, 8);

    // 1. Chunked 22,050 Hz -> 24,000 Hz (2 seconds split into Wyoming-style 2,048-byte chunks)
    const resampler = new StreamingPcmResampler({ targetRate: VOICE_HD_OUT_SAMPLE_RATE });
    const full22kSec1 = makeSinePcm(22050, 1000, 1, 14000);
    const full22kSec2 = Buffer.alloc(22050 * 2);
    for (let i = 0; i < 22050; i++) {
      const s = Math.round(Math.sin((2 * Math.PI * 440 * (22050 + i)) / 22050) * 14000);
      full22kSec2.writeInt16LE(s, i * 2);
    }

    const sec1Chunks = [];
    const boundaryOffsets = [];
    let runningSamples = 0;
    for (let off = 0; off < full22kSec1.length; off += 2048) {
      const piece = full22kSec1.subarray(off, Math.min(full22kSec1.length, off + 2048));
      const out = resampler.push(piece, { sampleRate: 22050, channels: 1 });
      if (runningSamples > 0 && out.length > 0) boundaryOffsets.push(runningSamples);
      runningSamples += out.length / 2;
      sec1Chunks.push(out);
    }
    const sec1Out = Buffer.concat(sec1Chunks);
    const sec1Samples = sec1Out.length / 2;
    assert.ok(Math.abs(sec1Samples - 24000) <= 4, `expected ~24000 samples for 1st second, got ${sec1Samples}`);

    const sec2Chunks = [];
    for (let off = 0; off < full22kSec2.length; off += 2048) {
      const piece = full22kSec2.subarray(off, Math.min(full22kSec2.length, off + 2048));
      const out = resampler.push(piece, { sampleRate: 22050, channels: 1 });
      if (out.length > 0) boundaryOffsets.push(runningSamples);
      runningSamples += out.length / 2;
      sec2Chunks.push(out);
    }
    const sec2Out = Buffer.concat(sec2Chunks);
    const sec2Samples = sec2Out.length / 2;
    assert.equal(sec2Samples, 24000, "expected exact 24,000 samples on steady-state 2nd second (zero drift)");

    // Verify smooth sine wave continuity across every single chunk boundary (zero clicks)
    const combined22k = Buffer.concat([sec1Out, sec2Out]);
    const total22kSamples = combined22k.length / 2;
    const maxExpectedDelta = Math.ceil((2 * Math.PI * 440 * 14000) / 24000) + 120;
    for (const bIdx of boundaryOffsets) {
      if (bIdx > 1 && bIdx < total22kSamples - 1) {
        const prev = combined22k.readInt16LE((bIdx - 1) * 2);
        const curr = combined22k.readInt16LE(bIdx * 2);
        const delta = Math.abs(curr - prev);
        assert.ok(
          delta <= maxExpectedDelta,
          `click detected at chunk boundary ${bIdx}: delta=${delta} > ${maxExpectedDelta}`
        );
      }
    }

    // 2. Chunked 48,000 Hz stereo -> 24,000 Hz mono (auto-reset on format change + anti-aliasing + zero drift)
    const stereo48Sec1 = makeSinePcm(48000, 1000, 2, 12000);
    const stereo48Sec2 = Buffer.alloc(48000 * 4);
    for (let i = 0; i < 48000; i++) {
      const s = Math.round(Math.sin((2 * Math.PI * 440 * (48000 + i)) / 48000) * 12000);
      stereo48Sec2.writeInt16LE(s, i * 4);
      stereo48Sec2.writeInt16LE(s, i * 4 + 2);
    }
    const out48Sec1Parts = [];
    for (let off = 0; off < stereo48Sec1.length; off += 3840) {
      out48Sec1Parts.push(
        resampler.push(stereo48Sec1.subarray(off, Math.min(stereo48Sec1.length, off + 3840)), {
          sampleRate: 48000,
          channels: 2,
        })
      );
    }
    const out48Sec2Parts = [];
    for (let off = 0; off < stereo48Sec2.length; off += 3840) {
      out48Sec2Parts.push(
        resampler.push(stereo48Sec2.subarray(off, Math.min(stereo48Sec2.length, off + 3840)), {
          sampleRate: 48000,
          channels: 2,
        })
      );
    }
    const out48Sec1 = Buffer.concat(out48Sec1Parts);
    const out48Sec2 = Buffer.concat(out48Sec2Parts);
    assert.ok(Math.abs(out48Sec1.length / 2 - 24000) <= 4);
    assert.equal(out48Sec2.length / 2, 24000, "expected exact 24,000 samples on steady-state 48k->24k 2nd second");

    // Verify 48k->24k anti-aliasing pre-filter attenuates high-frequency (20 kHz) above 12 kHz Nyquist
    const hfResampler = new StreamingPcmResampler({ targetRate: VOICE_HD_OUT_SAMPLE_RATE });
    const hf48k = Buffer.alloc(4800 * 2);
    for (let i = 0; i < 4800; i++) {
      hf48k.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 20000 * i) / 48000) * 16000), i * 2);
    }
    const hfOut = hfResampler.push(hf48k, { sampleRate: 48000, channels: 1 });
    let hfSumSq = 0;
    for (let i = 20; i < hfOut.length / 2 - 20; i++) {
      const v = hfOut.readInt16LE(i * 2);
      hfSumSq += v * v;
    }
    const hfRms = Math.sqrt(hfSumSq / (hfOut.length / 2 - 40));
    const inputRms = 16000 / Math.SQRT2;
    assert.ok(hfRms < inputRms * 0.35, `expected 20 kHz aliasing component attenuated (<35%), got ${Math.round((hfRms / inputRms) * 100)}%`);

    // 3. Fast-path 24 kHz mono pass-through (trims stray odd byte cleanly) + reset()
    resampler.reset();
    const raw24kOdd = Buffer.concat([makeSinePcm(24000, 20, 1, 10000), Buffer.from([0x7f])]);
    const pass24k = resampler.push(raw24kOdd, { sampleRate: 24000, channels: 1 });
    assert.equal(pass24k.length, VOICE_HD_OUT_FRAME_BYTES);
    assert.deepEqual(pass24k, raw24kOdd.subarray(0, VOICE_HD_OUT_FRAME_BYTES));
  });

  it("routes P2PBot V2 lossless 24 kHz PCM to v2pcm peers and V1 16 kHz ADPCM to legacy peers without cross-sending", async () => {
    const wasmPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "p2p_mesh.wasm");
    const wasmBytes = fs.readFileSync(wasmPath);

    const makePeerWasm = async (peerId, authorName, meshKey) => {
      const m = await SafeRustWasmMesh.loadFromBytes(wasmBytes);
      const init = m.call({
        cmd: "init",
        peerId,
        authorName,
        room: "hd-voice-test",
        autoMeshEnabled: false,
        meshKey,
        passphraseMode: false,
        x25519Secret: crypto.randomBytes(32).toString("base64url"),
        entropy: crypto.randomBytes(32).toString("base64url"),
      });
      return { wasm: m, status: init.status, pubKey: init.status.e2ee.publicKey };
    };

    const sharedKey = crypto.randomBytes(32).toString("base64url");
    const botNode = await makePeerWasm("bot-hd-1", "Home Assistant", sharedKey);
    const modernNode = await makePeerWasm("peer-modern", "Alice", sharedKey);
    const legacyNode = await makePeerWasm("peer-legacy", "Bob", sharedKey);

    // Connect both peers to botNode in Rust WASM and exchange voice-join state
    const connectPair = (a, b) => {
      const rA = a.wasm.call({
        cmd: "peer_connected",
        peerId: b.status.peerId,
        authorName: b.status.authorName,
        peerPubKey: b.pubKey,
      });
      const rB = b.wasm.call({
        cmd: "peer_connected",
        peerId: a.status.peerId,
        authorName: a.status.authorName,
        peerPubKey: a.pubKey,
      });
      const relay = (from, to, actions) => {
        for (const act of actions || []) {
          if (act.action === "send_wire" && act.peerId === to.status.peerId) {
            to.status = to.wasm.wireMessage(from.status.peerId, act.frame, Date.now()).status;
          }
        }
      };
      a.status = rA.status;
      b.status = rB.status;
      relay(a, b, rA.actions);
      relay(b, a, rB.actions);
    };

    connectPair(botNode, modernNode);
    connectPair(botNode, legacyNode);

    const setVoiceAndDeliver = (sender, receivers) => {
      const res = sender.wasm.call({ cmd: "set_voice_state", inVoice: true, muted: false });
      sender.status = res.status;
      for (const act of res.actions || []) {
        if (act.action === "send_wire") {
          const target = receivers.find((r) => r.status.peerId === act.peerId);
          if (target) {
            target.status = target.wasm.wireMessage(sender.status.peerId, act.frame, Date.now()).status;
          }
        }
      }
    };
    setVoiceAndDeliver(botNode, [modernNode, legacyNode]);
    setVoiceAndDeliver(modernNode, [botNode]);
    setVoiceAndDeliver(legacyNode, [botNode]);

    const bot = new P2PBot({ roomLink: "P2P1:placeholder", peerId: "bot-hd-1", name: "Home Assistant" });
    bot.wasm = botNode.wasm;
    bot.status = botNode.status;
    bot.inVoice = true;
    bot.voiceMuted = false;

    assert.equal(bot.pacer.sampleRate, VOICE_HD_OUT_SAMPLE_RATE);
    assert.equal(bot.pacer.frameSamples, VOICE_HD_OUT_FRAME_SAMPLES);
    assert.equal(bot.pacer.frameBytes, VOICE_HD_OUT_FRAME_BYTES);

    // Signal capability tracking
    bot._recordPeerVoiceCapsFromSignal({ from: "peer-modern", v2pcm: true, vcodec: "opus48" });
    bot._recordPeerVoiceCapsFromSignal({ from: "peer-legacy", vcodec: "opus48" });
    assert.deepEqual(bot.peerVoiceCaps.get("peer-modern"), { v2pcm: true, vcodec: "opus48" });
    assert.deepEqual(bot.peerVoiceCaps.get("peer-legacy"), { v2pcm: false, vcodec: "opus48" });

    // Build two distinct 480-sample 24 kHz frames
    const frame1 = new Int16Array(VOICE_HD_OUT_FRAME_SAMPLES);
    const frame2 = new Int16Array(VOICE_HD_OUT_FRAME_SAMPLES);
    let expectedSumSq1 = 0;
    for (let i = 0; i < VOICE_HD_OUT_FRAME_SAMPLES; i++) {
      frame1[i] = Math.round(Math.sin((2 * Math.PI * 523.25 * i) / VOICE_HD_OUT_SAMPLE_RATE) * 14000);
      frame2[i] = Math.round(Math.sin((2 * Math.PI * 659.25 * i) / VOICE_HD_OUT_SAMPLE_RATE) * 10000);
      expectedSumSq1 += frame1[i] * frame1[i];
    }
    const expectedRms1 = Math.round(Math.sqrt(expectedSumSq1 / VOICE_HD_OUT_FRAME_SAMPLES));

    // Spy on sealVoicePcm & sealVoiceRaw counts
    let v1Encodes = 0;
    let v2Encodes = 0;
    const origSealV1 = bot.wasm.sealVoicePcm.bind(bot.wasm);
    const origSealV2 = bot.wasm.sealVoiceRaw.bind(bot.wasm);
    bot.wasm.sealVoicePcm = (...args) => {
      v1Encodes += 1;
      return origSealV1(...args);
    };
    bot.wasm.sealVoiceRaw = (...args) => {
      v2Encodes += 1;
      return origSealV2(...args);
    };

    const modernRx = [];
    const legacyRx = [];
    const modernDc = { readyState: "open", bufferedAmount: 0, send: (b) => modernRx.push(new Uint8Array(b)) };
    const legacyDc = { readyState: "open", bufferedAmount: 0, send: (b) => legacyRx.push(new Uint8Array(b)) };

    // A. V2-only room: modern peer receives V2 lossless 24 kHz PCM; V1 ADPCM is NEVER encoded!
    bot.voiceChannels.set("peer-modern", modernDc);
    assert.equal(bot.sendVoicePcm24k(frame1), 1);
    assert.equal(bot.sendVoicePcm24k(frame2), 1);
    assert.equal(v2Encodes, 2);
    assert.equal(v1Encodes, 0, "V1 ADPCM must NOT be encoded when all voice peers support v2pcm");
    assert.equal(modernRx.length, 2);

    // Decrypt both V2 packets with real SafeRustWasmMesh.openVoiceRaw() and assert bit-exact round-trip
    for (let idx = 0; idx < 2; idx++) {
      const pkt = modernRx[idx];
      assert.equal(pkt[0], 0x56); // 'V'
      assert.equal(pkt[1], 0x32); // '2'
      const plain = modernNode.wasm.openVoiceRaw("bot-hd-1", pkt);
      assert.ok(plain, `expected valid V2 packet decryption for frame ${idx}`);
      assert.equal(plain.byteLength, VOICE_V2_HEADER_BYTES + VOICE_HD_OUT_FRAME_BYTES);
      assert.equal(plain[0], VOICE_V2_CODEC_PCM16);
      assert.equal(plain[1], 24);
      const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
      if (idx === 0) {
        assert.equal(dv.getUint16(2, true), expectedRms1);
        assert.equal(dv.getUint32(4, true), 0);
      } else {
        assert.equal(dv.getUint32(4, true), VOICE_HD_OUT_FRAME_SAMPLES);
      }
      const expectedFrame = idx === 0 ? frame1 : frame2;
      for (let s = 0; s < VOICE_HD_OUT_FRAME_SAMPLES; s++) {
        assert.equal(
          dv.getInt16(VOICE_V2_HEADER_BYTES + s * 2, true),
          expectedFrame[s],
          `PCM mismatch at frame ${idx} sample ${s}`
        );
      }
    }

    // B. Legacy-only room: legacy peer receives V1 16 kHz ADPCM; V2 is NOT encoded!
    modernRx.length = 0;
    legacyRx.length = 0;
    v1Encodes = 0;
    v2Encodes = 0;
    bot.voiceChannels.clear();
    bot.voiceChannels.set("peer-legacy", legacyDc);
    assert.equal(bot.sendVoicePcm24k(frame1), 1);
    assert.equal(v2Encodes, 0, "V2 must NOT be encoded when only legacy peers are in voice");
    assert.equal(v1Encodes, 1);
    assert.equal(legacyRx.length, 1);
    assert.equal(legacyRx[0][0], 0x56);
    assert.equal(legacyRx[0][1], 0x31); // 'V1'
    const openedV1 = legacyNode.wasm.openVoicePacket("bot-hd-1", legacyRx[0]);
    assert.ok(openedV1);
    assert.equal(openedV1.pcm.length, VOICE_FRAME_SAMPLES);
    assert.ok(openedV1.rms > 2000, `expected non-silent decoded V1 fallback audio, got rms=${openedV1.rms}`);

    // C. Mixed room (v2pcm peer + legacy peer): V2 goes ONLY to modern, V1 goes ONLY to legacy (zero cross-sending!)
    modernRx.length = 0;
    legacyRx.length = 0;
    v1Encodes = 0;
    v2Encodes = 0;
    bot.voiceChannels.set("peer-modern", modernDc);
    bot.voiceChannels.set("peer-legacy", legacyDc);
    assert.equal(bot.sendVoicePcm24k(frame1), 2);
    assert.equal(v2Encodes, 1);
    assert.equal(v1Encodes, 1);
    assert.equal(modernRx.length, 1);
    assert.equal(legacyRx.length, 1);
    assert.equal(modernRx[0][1], 0x32); // V2 only
    assert.equal(legacyRx[0][1], 0x31); // V1 only
    const mixedPlain = modernNode.wasm.openVoiceRaw("bot-hd-1", modernRx[0]);
    assert.equal(mixedPlain[0], VOICE_V2_CODEC_PCM16);
    assert.equal(mixedPlain[1], 24);
    const mixedLegacy = legacyNode.wasm.openVoicePacket("bot-hd-1", legacyRx[0]);
    assert.equal(mixedLegacy.pcm.length, VOICE_FRAME_SAMPLES);

    // D. VoiceAudioPacer 3 ms cosine fade-in (72 samples @ 24 kHz) & soft-knee peak limiting when gain !== 1
    const pacedFrames = [];
    bot.pacer.onFrame = (s) => pacedFrames.push(new Int16Array(s));
    bot.setAudioGain(1.35);
    const loudDc = Buffer.alloc(VOICE_HD_OUT_FRAME_BYTES);
    for (let i = 0; i < VOICE_HD_OUT_FRAME_SAMPLES; i++) loudDc.writeInt16LE(25000, i * 2);
    bot.pacer.pushBytes(loudDc);
    bot.pacer.stop();
    assert.equal(pacedFrames.length, 1);
    assert.equal(pacedFrames[0][0], 0, "sample 0 must start at 0 via 3 ms cosine fade-in (no DC click)");
    assert.ok(pacedFrames[0][36] > 10000 && pacedFrames[0][36] < 25000, "midpoint of 72-sample fade-in must ramp smoothly");
    assert.ok(
      pacedFrames[0][100] > 30145 && pacedFrames[0][100] < 32650,
      `soft-knee limiter should compress 33750 gently into (30145, 32650), got ${pacedFrames[0][100]}`
    );
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

  it("absorbs WebRTC jitter with jitterBufferFrames=3, applies decay on underrun, and flushes short trailing bursts", () => {
    const mixer = new VoiceRoomMixer({
      echoSuppression: false,
      jitterBufferFrames: 3,
      maxBufferedFramesPerPeer: 16,
    });

    const f1 = new Int16Array(VOICE_FRAME_SAMPLES).fill(1000);
    const f2 = new Int16Array(VOICE_FRAME_SAMPLES).fill(1200);
    const f3 = new Int16Array(VOICE_FRAME_SAMPLES).fill(1400);
    const f4 = new Int16Array(VOICE_FRAME_SAMPLES).fill(1600);

    // Push 2 frames (< 3): buffer holds until primed
    mixer.pushPeerAudio("peer-a", f1, 1000, 1000);
    assert.equal(mixer.produceFrame(1000).isSilence, true);
    assert.equal(mixer.getBufferedFrames(), 1);

    mixer.pushPeerAudio("peer-a", f2, 1200, 1020);
    assert.equal(mixer.produceFrame(1020).isSilence, true);
    assert.equal(mixer.getBufferedFrames(), 2);

    // 3rd frame primes the jitter buffer and immediately begins smooth playback
    mixer.pushPeerAudio("peer-a", f3, 1400, 1040);
    const out1 = mixer.produceFrame(1040);
    assert.equal(out1.isSilence, false);
    assert.equal(out1.pcm[0], 1000);
    assert.equal(out1.underrunCount, 0);
    assert.equal(out1.bufferedFrames, 2);

    // 40ms jitter gap (two ticks with no incoming packets) -> zero dropouts, zero underruns
    const out2 = mixer.produceFrame(1060);
    assert.equal(out2.isSilence, false);
    assert.equal(out2.pcm[0], 1200);
    assert.equal(out2.underrunCount, 0);

    const out3 = mixer.produceFrame(1080);
    assert.equal(out3.isSilence, false);
    assert.equal(out3.pcm[0], 1400);
    assert.equal(out3.underrunCount, 0);

    // Late packet arrives right on time -> continues cleanly with zero underruns
    mixer.pushPeerAudio("peer-a", f4, 1600, 1100);
    const out4 = mixer.produceFrame(1100);
    assert.equal(out4.isSilence, false);
    assert.equal(out4.pcm[0], 1600);
    assert.equal(out4.underrunCount, 0);

    // Genuine underrun after draining: 1st tick emits gentle 0.35x decay instead of hard zero
    const u1 = mixer.produceFrame(1120);
    assert.equal(u1.isSilence, false);
    assert.equal(u1.pcm[0], Math.round(1600 * 0.35));
    assert.equal(u1.underrunCount, 1);

    // 2nd & 3rd empty ticks emit silence and unprime peer after 3 underrun ticks (60ms)
    const u2 = mixer.produceFrame(1140);
    assert.equal(u2.isSilence, true);
    assert.equal(u2.underrunCount, 2);

    const u3 = mixer.produceFrame(1160);
    assert.equal(u3.isSilence, true);
    assert.equal(u3.underrunCount, 3);

    // Further idle ticks do NOT increment underrunCount once unprimed
    const idle = mixer.produceFrame(1180);
    assert.equal(idle.isSilence, true);
    assert.equal(idle.underrunCount, 3);

    // Short trailing 1-frame burst while unprimed flushes once jitterBufferFrames * 20ms (60ms) elapses
    const trailing = new Int16Array(VOICE_FRAME_SAMPLES).fill(2000);
    mixer.pushPeerAudio("peer-a", trailing, 2000, 2000);
    assert.equal(mixer.produceFrame(2020).isSilence, true);
    assert.equal(mixer.produceFrame(2040).isSilence, true);
    const flushed = mixer.produceFrame(2060);
    assert.equal(flushed.isSilence, false);
    assert.equal(flushed.pcm[0], 2000);
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
      // 1. Handshake: describe -> info (advertises 24 kHz TTS snd_format while mic capture stays 16 kHz)
      client.write(encodeWyomingEvent("describe"));
      const infoEv = await waitEvent("info");
      assert.equal(infoEv.data.satellite.name, "test-p2p-sat");
      assert.equal(infoEv.data.satellite.area, "Office");
      assert.equal(infoEv.data.satellite.supports_trigger, true);
      assert.deepEqual(infoEv.data.satellite.snd_format, { rate: 24000, width: 2, channels: 1 });

      // 2. HA starts satellite -> satellite arms wake-word pipeline with 16 kHz mic capture
      client.write(encodeWyomingEvent("run-satellite"));
      const wakeRun = await waitEvent("run-pipeline");
      assert.equal(wakeRun.data.start_stage, "wake");
      assert.equal(wakeRun.data.end_stage, "tts");
      const wakeAudioStartEv = await waitEvent("audio-start");
      assert.equal(wakeAudioStartEv.data.rate, 16000);
      assert.equal(sat.sendAudioChunk(Buffer.alloc(640)), true);
      const micChunkEv = await waitEvent("audio-chunk");
      assert.equal(micChunkEv.data.rate, 16000);
      assert.equal(micChunkEv.payload.length, 640);

      // 3. Button activation skips wake word -> start_stage = "asr", restart_on_end = false
      assert.equal(sat.triggerListenNow({ wakeWordName: "button" }), true);
      const asrRun = await waitEvent("run-pipeline");
      assert.equal(asrRun.data.start_stage, "asr");
      assert.equal(asrRun.data.restart_on_end, false);

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

  it("delays audio-start after run-pipeline, sends restart_on_end=false on wake/asr, accelerates triggerListenNow on stale error + transcribe, recovers from silent processing timeout, and survives unhandled ECONNRESET", async () => {
    const sat = new WyomingSatelliteServer({
      host: "127.0.0.1",
      port: 0,
      name: "delay-test-sat",
      area: "Lab",
      wakeWordEnabled: true,
      rearmDelayMs: 100,
      audioStartDelayMs: 120,
      interruptDelayMs: 300,
      processingTimeoutMs: 70,
    });
    const { port } = await sat.start();

    const received = [];
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
          const idx = received.findIndex((e) => e.type === type);
          if (idx !== -1) {
            clearTimeout(timer);
            client.off("data", onData);
            const [ev] = received.splice(idx, 1);
            resolve(ev);
          }
        };
        client.on("data", onData);
        check();
      });

    client.on("data", (chunk) => {
      const ts = Date.now();
      for (const ev of dec.push(chunk)) {
        received.push({ ...ev, ts });
      }
    });

    try {
      // 1. run-satellite -> run-pipeline(wake, restart_on_end=false) followed by delayed audio-start
      client.write(encodeWyomingEvent("run-satellite"));
      const wakeEv = await waitEvent("run-pipeline");
      assert.equal(wakeEv.data.start_stage, "wake");
      assert.equal(wakeEv.data.restart_on_end, false);
      const wakeAudioStart = await waitEvent("audio-start");
      assert.ok(
        wakeAudioStart.ts - wakeEv.ts >= 70,
        `expected delayed audio-start after run-pipeline, delta was ${wakeAudioStart.ts - wakeEv.ts}ms`
      );

      // 2. triggerListenNow while streaming -> audio-stop first, stale wake-word-timeout error
      //    accelerates run-pipeline(asr, restart_on_end=false) past the 300ms fallback,
      //    and incoming transcribe immediately triggers audio-start ahead of the 120ms audioStartDelayMs!
      const pipelineErrors = [];
      const stageEvents = [];
      sat.on("pipelineError", (e) => pipelineErrors.push(e));
      sat.on("sttStart", () => stageEvents.push("sttStart"));
      sat.on("voiceStarted", () => stageEvents.push("voiceStarted"));
      sat.on("voiceStopped", () => stageEvents.push("voiceStopped"));
      sat.on("synthesize", () => stageEvents.push("synthesize"));
      sat.on("wakeListening", () => stageEvents.push("wakeListening"));

      received.length = 0;
      assert.equal(sat.triggerListenNow({ wakeWordName: "button" }), true);
      const stopEv = await waitEvent("audio-stop");
      // Simulate HA Core aborting the prior wake pipeline right after receiving audio-stop
      const errSentAt = Date.now();
      client.write(encodeWyomingEvent("error", { code: "wake-word-timeout", text: "wake stream stopped" }));
      const asrEv = await waitEvent("run-pipeline");
      assert.equal(asrEv.data.start_stage, "asr");
      assert.equal(asrEv.data.restart_on_end, false);
      assert.ok(asrEv.ts >= stopEv.ts, "expected audio-stop before new run-pipeline");
      assert.ok(
        asrEv.ts - errSentAt < 180,
        `expected stale error to accelerate run-pipeline below 300ms fallback, delta was ${asrEv.ts - errSentAt}ms`
      );

      // Send transcribe immediately -> audio-start should fire right away (well below 120ms audioStartDelayMs)
      const transcribeSentAt = Date.now();
      client.write(encodeWyomingEvent("transcribe"));
      const asrAudioStart = await waitEvent("audio-start");
      assert.ok(
        asrAudioStart.ts - transcribeSentAt < 75,
        `expected transcribe to trigger immediate audio-start, delta was ${asrAudioStart.ts - transcribeSentAt}ms`
      );
      assert.equal(pipelineErrors.length, 0, "expected aborted wake stream error to be ignored during Listen Now");
      assert.equal(sat.pipelineMode, "asr");
      assert.ok(stageEvents.includes("sttStart"), "expected sttStart event on transcribe");

      client.write(encodeWyomingEvent("voice-started"));
      client.write(encodeWyomingEvent("voice-stopped"));
      client.write(encodeWyomingEvent("synthesize", { text: "Done." }));
      await new Promise((r) => setTimeout(r, 25));
      assert.ok(stageEvents.includes("voiceStarted"));
      assert.ok(stageEvents.includes("voiceStopped"));
      assert.ok(stageEvents.includes("synthesize"));

      // 3. TTS completes -> notifyAudioPlayed sends played and re-arms start_stage="wake" (restart_on_end=false)
      received.length = 0;
      client.write(encodeWyomingEvent("audio-start", { rate: 16000, width: 2, channels: 1 }));
      client.write(encodeWyomingEvent("audio-stop"));
      await new Promise((r) => setTimeout(r, 30));
      sat.notifyAudioPlayed();
      await waitEvent("played");
      const rearmEv = await waitEvent("run-pipeline");
      assert.equal(rearmEv.data.start_stage, "wake");
      assert.equal(rearmEv.data.restart_on_end, false);
      // Incoming detect immediately triggers audio-start ahead of audioStartDelayMs
      const detectSentAt = Date.now();
      client.write(encodeWyomingEvent("detect"));
      const rearmAudioStart = await waitEvent("audio-start");
      assert.ok(
        rearmAudioStart.ts - detectSentAt < 75,
        `expected detect to trigger immediate audio-start, delta was ${rearmAudioStart.ts - detectSentAt}ms`
      );
      assert.ok(stageEvents.includes("wakeListening"));

      // 4. Silent intent recovery: transcript with no TTS/error recovers back to wake after processingTimeoutMs
      received.length = 0;
      client.write(encodeWyomingEvent("transcript", { text: "turn off office light" }));
      await waitEvent("audio-stop");
      assert.equal(sat.pipelineMode, "processing");
      const silentRearmEv = await waitEvent("run-pipeline", 1500);
      assert.equal(silentRearmEv.data.start_stage, "wake");
      assert.equal(silentRearmEv.data.restart_on_end, false);
      await waitEvent("audio-start");

      // 5. Unhandled ECONNRESET on standalone WyomingSatelliteServer (no 'error' listener) must NOT throw
      assert.equal(sat.listenerCount("error"), 0);
      sat.activeSocket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      client.resetAndDestroy();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(sat.isConnected(), false);
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
      assert.deepEqual(statusRes.state.audio, {
        lastRms: 0,
        peakRms: 0,
        activeFrames: 0,
        silenceFrames: 0,
        underrunCount: 0,
        bufferedFrames: 0,
      });

      // Audio diagnostics update as frames flow through the mixer
      const testMixer = new VoiceRoomMixer({ echoSuppression: false, jitterBufferFrames: 3 });
      assistant.mixer = testMixer;
      assistant._recordAudioFrame(testMixer.produceFrame(1000)); // silence
      const loudFrame = new Int16Array(VOICE_FRAME_SAMPLES).fill(2500);
      testMixer.pushPeerAudio("peer-1", loudFrame, 2500, 1020);
      testMixer.pushPeerAudio("peer-1", loudFrame, 2500, 1040);
      testMixer.pushPeerAudio("peer-1", loudFrame, 2500, 1060);
      assistant._recordAudioFrame(testMixer.produceFrame(1060)); // active, 2 buffered
      const audioStatus = await fetch(`http://127.0.0.1:${ui.port}/api/status`).then((r) => r.json());
      assert.equal(audioStatus.state.audio.lastRms, 2500);
      assert.equal(audioStatus.state.audio.peakRms, 2500);
      assert.equal(audioStatus.state.audio.activeFrames, 1);
      assert.equal(audioStatus.state.audio.silenceFrames, 1);
      assert.equal(audioStatus.state.audio.underrunCount, 0);
      assert.equal(audioStatus.state.audio.bufferedFrames, 2);
      assistant.mixer = null;

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

  it("handles Wyoming socket ECONNRESET gracefully without crashing and accepts reconnections", async () => {
    const assistant = new HomeAssistantVoiceAssistant({
      wyomingHost: "127.0.0.1",
      wyomingPort: 0,
      uiHost: "127.0.0.1",
      uiPort: 0,
    });
    const { wyoming } = await assistant.start();

    const c1 = net.createConnection({ host: "127.0.0.1", port: wyoming.port });
    let c2 = null;
    try {
      await new Promise((r) => c1.once("connect", r));
      c1.write(encodeWyomingEvent("run-satellite"));
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(assistant.wyoming.isReady(), true);

      // Emit explicit ECONNRESET on active server socket + hard TCP RST from client
      assistant.wyoming.activeSocket.emit(
        "error",
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
      );
      c1.resetAndDestroy();
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(assistant.wyoming.isConnected(), false);
      const stateAfterReset = assistant.getApiState();
      assert.ok(
        stateAfterReset.recentLog.some((e) => e.speaker === "Wyoming" && /ECONNRESET/i.test(e.text)),
        "expected ECONNRESET to be logged gracefully"
      );

      // Verify satellite server is still healthy and accepts a fresh HA reconnection
      c2 = net.createConnection({ host: "127.0.0.1", port: wyoming.port });
      const dec = new WyomingFrameDecoder();
      const infoPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for info after reconnect")), 2000);
        c2.on("data", (chunk) => {
          for (const ev of dec.push(chunk)) {
            if (ev.type === "info") {
              clearTimeout(timer);
              resolve(ev);
            }
          }
        });
      });
      await new Promise((r) => c2.once("connect", r));
      c2.write(encodeWyomingEvent("describe"));
      const info = await infoPromise;
      assert.equal(info.type, "info");
      assert.equal(info.data.satellite.supports_trigger, true);
    } finally {
      c1.destroy();
      if (c2) c2.destroy();
      await assistant.stop();
    }
  });

  it("formats wake-word IDs, discovers live wake word via assist_pipeline/pipeline/list + state_changed, emits voiceControls, and restarts wake listening on change", async () => {
    // 1. formatWakeWordLabel
    assert.equal(formatWakeWordLabel("hey_jarvis"), "Hey Jarvis");
    assert.equal(formatWakeWordLabel("okay_nabu"), "Okay Nabu");
    assert.equal(formatWakeWordLabel("hey_mycroft_v0.1"), "Hey Mycroft");
    assert.equal(formatWakeWordLabel("alexa_v0.1"), "Alexa");
    assert.equal(formatWakeWordLabel(""), "");
    assert.equal(formatWakeWordLabel(null), "");
    assert.equal(formatWakeWordLabel(undefined), "");

    // Fallback WAKE_WORD_LABEL via CLI/env args
    const cliArgs = parseHaCliArgs(["--wake-word-label", "Hey Jarvis"]);
    assert.equal(cliArgs.wakeWordLabel, "Hey Jarvis");

    // 2. Mock HA WebSocket with select.voice_room_p2p_direct_voice_assistant + assist_pipeline/pipeline/list
    const mockHaWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => mockHaWss.once("listening", r));
    const haPort = mockHaWss.address().port;

    let serverWs = null;
    mockHaWss.on("connection", (ws) => {
      serverWs = ws;
      ws.send(JSON.stringify({ type: "auth_required" }));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        if (m.type === "auth") {
          ws.send(JSON.stringify({ type: "auth_ok" }));
        } else if (m.type === "subscribe_events") {
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
        } else if (m.type === "get_states") {
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: [
              { entity_id: "input_text.p2p_voice_room_link", state: "" },
              { entity_id: "select.voice_room_p2p_direct_voice_assistant", state: "preferred" },
            ],
          }));
        } else if (m.type === "assist_pipeline/pipeline/list") {
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: {
              preferred_pipeline: "p-default",
              pipelines: [
                {
                  id: "p-default",
                  name: "Home Assistant",
                  wake_word_entity: "wake_word.openwakeword",
                  wake_word_id: "okay_nabu",
                },
                {
                  id: "p-office",
                  name: "Office Assist",
                  wake_word_entity: "wake_word.openwakeword",
                  wake_word_id: "hey_jarvis_v0.1",
                },
              ],
            },
          }));
        }
      });
    });

    const assistant = new HomeAssistantVoiceAssistant({
      wyomingHost: "127.0.0.1",
      wyomingPort: 0,
      wyomingName: "p2p-direct-voice",
      uiHost: "127.0.0.1",
      uiPort: 0,
      haUrl: `http://127.0.0.1:${haPort}`,
      haToken: "tok",
    });

    const { wyoming, ui } = await assistant.start();
    const wyClient = net.createConnection({ host: "127.0.0.1", port: wyoming.port });
    const dec = new WyomingFrameDecoder();
    const wyEvents = [];
    wyClient.on("data", (chunk) => {
      wyEvents.push(...dec.push(chunk));
    });

    try {
      await new Promise((r) => setTimeout(r, 120));

      // Resolved preferred pipeline -> Okay Nabu
      const st1 = await fetch(`http://127.0.0.1:${ui.port}/api/status`).then((r) => r.json());
      assert.deepEqual(st1.state.wakeWord, {
        id: "okay_nabu",
        label: "Okay Nabu",
        pipelineName: "Home Assistant",
      });

      // Before Wyoming connects -> voiceControls shows Waiting HA with Listen Now disabled
      const waitingCard = assistant.buildChatCard();
      assert.equal(waitingCard.voiceControls.status, "Waiting HA");
      assert.equal(waitingCard.voiceControls.statusIcon, "mic");
      assert.equal(waitingCard.voiceControls.statusTone, "ochre");
      assert.equal(waitingCard.voiceControls.activity, "idle");
      assert.equal(waitingCard.voiceControls.buttons.length, 3);
      assert.equal(waitingCard.voiceControls.buttons[0].id, "ha:listen");
      assert.equal(waitingCard.voiceControls.buttons[0].disabled, true);

      // Connect Wyoming satellite -> enters wake mode
      wyClient.write(encodeWyomingEvent("run-satellite"));
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(assistant.wyoming.pipelineMode, "wake");

      const wakeCard = assistant.buildChatCard();
      assert.equal(wakeCard.voiceControls.status, "Okay Nabu");
      assert.equal(wakeCard.voiceControls.statusIcon, "bolt");
      assert.equal(wakeCard.voiceControls.statusTone, "cobalt");
      assert.equal(wakeCard.voiceControls.activity, "idle");
      assert.equal(wakeCard.voiceControls.buttons[0].disabled, false);
      assert.equal(wakeCard.voiceControls.buttons[1].id, "ha:toggle_wake");
      assert.equal(wakeCard.voiceControls.buttons[2].id, "ha:stop_audio");
      const wakeStat = wakeCard.blocks[0].items.find((i) => i.label === "Wake Word");
      assert.equal(wakeStat.value, "Okay Nabu");
      assert.match(wakeCard.footer, /Say "Okay Nabu", click Listen Now, or type \/ai <msg>/);

      // Live state_changed on select.voice_room_p2p_direct_voice_assistant -> "Office Assist" (hey_jarvis_v0.1)
      wyEvents.length = 0;
      serverWs.send(JSON.stringify({
        type: "event",
        event: {
          event_type: "state_changed",
          data: {
            entity_id: "select.voice_room_p2p_direct_voice_assistant",
            new_state: { state: "Office Assist" },
          },
        },
      }));
      // Wait for clean audio-stop -> interruptDelayMs (150ms) -> run-pipeline(wake) reload
      await new Promise((r) => setTimeout(r, 260));

      const st2 = await fetch(`http://127.0.0.1:${ui.port}/api/status`).then((r) => r.json());
      assert.deepEqual(st2.state.wakeWord, {
        id: "hey_jarvis_v0.1",
        label: "Hey Jarvis",
        pipelineName: "Office Assist",
      });

      // Verified wake listening restarted (audio-stop + run-pipeline wake with restart_on_end=false)
      assert.ok(wyEvents.some((e) => e.type === "audio-stop"), "expected audio-stop when wake word changed");
      assert.ok(
        wyEvents.some(
          (e) => e.type === "run-pipeline" && e.data?.start_stage === "wake" && e.data?.restart_on_end === false
        ),
        "expected run-pipeline(wake, restart_on_end=false) reload when wake word changed"
      );

      // Verify updated voiceControls & card states (Hey Jarvis, Listening..., Thinking..., Speaking, Muted, Button Only)
      const jarvisCard = assistant.buildChatCard();
      assert.equal(jarvisCard.voiceControls.status, "Hey Jarvis");
      assert.equal(jarvisCard.voiceControls.statusIcon, "bolt");
      assert.equal(jarvisCard.voiceControls.statusTone, "cobalt");
      assert.equal(jarvisCard.voiceControls.activity, "idle");
      assert.match(jarvisCard.footer, /Say "Hey Jarvis", click Listen Now, or type \/ai <msg>/);

      assistant.setMuted(true);
      const mutedCard = assistant.buildChatCard();
      assert.equal(mutedCard.voiceControls.status, "Muted");
      assert.equal(mutedCard.voiceControls.statusIcon, "mic-off");
      assert.equal(mutedCard.voiceControls.statusTone, "coral");
      assert.equal(mutedCard.voiceControls.activity, "idle");
      assistant.setMuted(false);

      assistant.wyoming.pipelineMode = "asr";
      const asrCard = assistant.buildChatCard();
      assert.equal(asrCard.voiceControls.status, "Listening...");
      assert.equal(asrCard.voiceControls.activity, "listening");
      assert.equal(assistant.getApiState().thinking, false);

      assistant.wyoming.pipelineMode = "processing";
      const thinkingCard = assistant.buildChatCard();
      assert.equal(thinkingCard.badge, "THINKING");
      assert.equal(thinkingCard.color, "cyan");
      assert.equal(thinkingCard.voiceControls.status, "Thinking...");
      assert.equal(thinkingCard.voiceControls.statusTone, "cyan");
      assert.equal(thinkingCard.voiceControls.activity, "thinking");
      assert.equal(assistant.getApiState().thinking, true);

      assistant.wyoming.pipelineMode = "speaking";
      const speakingVc = assistant.buildChatCard().voiceControls;
      assert.equal(speakingVc.status, "Speaking");
      assert.equal(speakingVc.statusIcon, "volume");
      assert.equal(speakingVc.activity, "speaking");
      assert.equal(assistant.getApiState().thinking, false);

      assistant.wyoming.pipelineMode = "idle";
      assistant.setWakeWordEnabled(false);
      const btnOnlyCard = assistant.buildChatCard();
      assert.equal(btnOnlyCard.voiceControls.status, "Button Only");
      assert.equal(btnOnlyCard.voiceControls.activity, "idle");
      assert.equal(btnOnlyCard.voiceControls.buttons[1].label, "Wake: Off");

      // Verify HomeAssistantWsClient standalone export + named selector matching
      assert.equal(assistant.haClient instanceof HomeAssistantWsClient, true);
      assert.equal(assistant.haClient.assistantSelectEntity, "select.voice_room_p2p_direct_voice_assistant");
    } finally {
      wyClient.destroy();
      await assistant.stop();
      await new Promise((r) => mockHaWss.close(r));
    }
  });

  it("integrates HA timer_list entities: subscribe snapshots, live deltas, unavailable->available resubscribe, Wyoming dedupe, card.timers contract, room actions, and /api/timer/* endpoints", async () => {
    // 1. Pure helpers & CLI allowlist
    assert.equal(
      formatTimerListSourceLabel("timer_list.kitchen_kitchen_assist_timers", "kitchen_assist Timers"),
      "Kitchen Assist"
    );
    assert.equal(
      formatTimerListSourceLabel("timer_list.living_living_assist_timers", "Living Room Timers"),
      "Living Room"
    );
    assert.equal(formatTimerListSourceLabel("timer_list.office_timers", ""), "Office");
    assert.equal(formatTimerDurationLabel(300), "5m Timer");
    assert.equal(formatTimerDurationLabel(90), "1m 30s Timer");
    assert.equal(formatTimerDurationLabel(3600), "1h Timer");
    assert.equal(formatTimerDurationLabel(45), "45s Timer");
    assert.equal(formatTimerDurationLabel(0), "Timer");

    const cli = parseHaCliArgs(["--timer-list-entities", "timer_list.a, timer_list.b"]);
    assert.deepEqual(cli.timerListEntities, ["timer_list.a", "timer_list.b"]);

    // 2. Mock HA WebSocket server implementing timer_list/item/subscribe + timer_list.* services
    const mockHaWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => mockHaWss.once("listening", r));
    const haPort = mockHaWss.address().port;

    let serverWs = null;
    const subIdsByEntity = new Map();
    const subscribeCounts = new Map();
    const serviceCalls = [];
    const nowIsoPlus = (sec) => new Date(Date.now() + sec * 1000).toISOString();

    mockHaWss.on("connection", (ws) => {
      serverWs = ws;
      ws.send(JSON.stringify({ type: "auth_required" }));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        if (m.type === "auth") {
          ws.send(JSON.stringify({ type: "auth_ok" }));
        } else if (m.type === "subscribe_events") {
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
        } else if (m.type === "unsubscribe_events") {
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
        } else if (m.type === "get_states") {
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: [
              { entity_id: "input_text.p2p_voice_room_link", state: "" },
              {
                entity_id: "timer_list.kitchen_kitchen_assist_timers",
                state: "2",
                attributes: {
                  friendly_name: "kitchen_assist Timers",
                  supported_features:
                    TIMER_LIST_FEATURES.CREATE_TIMER |
                    TIMER_LIST_FEATURES.PAUSE_TIMER |
                    TIMER_LIST_FEATURES.CANCEL_TIMER |
                    TIMER_LIST_FEATURES.ADD_TIME,
                },
              },
              {
                entity_id: "timer_list.living_living_assist_timers",
                state: "0",
                attributes: {
                  friendly_name: "Living Room Timers",
                  supported_features: TIMER_LIST_FEATURES.CANCEL_TIMER,
                },
              },
            ],
          }));
        } else if (m.type === "assist_pipeline/pipeline/list") {
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: { preferred_pipeline: "", pipelines: [] },
          }));
        } else if (m.type === "timer_list/item/subscribe") {
          const eid = m.entity_id;
          subIdsByEntity.set(eid, m.id);
          subscribeCounts.set(eid, (subscribeCounts.get(eid) || 0) + 1);
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
          if (eid === "timer_list.kitchen_kitchen_assist_timers") {
            ws.send(JSON.stringify({
              id: m.id,
              type: "event",
              event: {
                type: "timers",
                timers: [
                  {
                    timer_id: "tl-1:alpha",
                    name: "Pasta",
                    status: "active",
                    created_duration: 300,
                    total_duration: 300,
                    finishes_at: nowIsoPlus(240),
                    remaining: 240,
                  },
                  {
                    timer_id: "tl-paused",
                    name: "",
                    status: "paused",
                    created_duration: 180,
                    total_duration: 180,
                    paused_remaining: 95,
                    remaining: 95,
                  },
                  {
                    timer_id: "tl-archived-done",
                    name: "Old Timer",
                    status: "finished",
                    created_duration: 60,
                    total_duration: 60,
                    remaining: 0,
                  },
                  {
                    timer_id: "tl-archived-cancel",
                    name: "Cancelled",
                    status: "cancelled",
                    created_duration: 60,
                    total_duration: 60,
                    remaining: 0,
                  },
                ],
              },
            }));
          } else {
            ws.send(JSON.stringify({
              id: m.id,
              type: "event",
              event: { type: "timers", timers: [] },
            }));
          }
        } else if (m.type === "call_service") {
          serviceCalls.push(m);
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
        }
      });
    });

    const assistant = new HomeAssistantVoiceAssistant({
      wyomingHost: "127.0.0.1",
      wyomingPort: 0,
      uiHost: "127.0.0.1",
      uiPort: 0,
      haUrl: `http://127.0.0.1:${haPort}`,
      haToken: "tok",
    });

    const { ui } = await assistant.start();
    try {
      await new Promise((r) => setTimeout(r, 140));

      // Both timer_list entities discovered & subscribed; archived items filtered out
      const st1 = await fetch(`http://127.0.0.1:${ui.port}/api/status`).then((r) => r.json());
      assert.equal(st1.state.timerLists.length, 2);
      assert.equal(st1.state.timers.length, 2);
      // Sorted: active soonest-finishing first, then paused
      assert.equal(st1.state.timers[0].id, "tl-1:alpha");
      assert.equal(st1.state.timers[0].name, "Pasta");
      assert.equal(st1.state.timers[0].sourceLabel, "Kitchen Assist");
      assert.equal(st1.state.timers[0].paused, false);
      assert.equal(st1.state.timers[1].id, "tl-paused");
      assert.equal(st1.state.timers[1].name, "3m Timer");
      assert.equal(st1.state.timers[1].paused, true);
      assert.equal(st1.state.timers[1].remainingSec, 95);
      assert.equal(st1.state.timers[1].endsAtMs, 0);

      // Merge + deduplicate with Wyoming native timers (same ID prefers timer_list; distinct Wyoming timer coexists)
      assistant.wyoming.emit("timerStarted", {
        id: "tl-1:alpha",
        name: "Duplicate Pasta",
        totalSeconds: 300,
        commandText: "",
      });
      assistant.wyoming.emit("timerStarted", {
        id: "wy-only-1",
        name: "Eggs",
        totalSeconds: 120,
        commandText: "",
      });

      const merged = assistant.getAllActiveTimers();
      assert.equal(merged.length, 3);
      assert.equal(merged[0].id, "wy-only-1"); // finishes in ~120s (< 240s)
      assert.equal(merged[0].source, "wyoming");
      assert.equal(merged[1].id, "tl-1:alpha");
      assert.equal(merged[1].source, "timer_list"); // deduped in favor of timer_list!
      assert.equal(merged[2].id, "tl-paused"); // paused last

      // Verify buildChatCard().timers exact shared contract & feature-gated actions
      const card = assistant.buildChatCard();
      assert.equal(Array.isArray(card.timers), true);
      assert.equal(card.timers.length, 3);
      const timerStat = card.blocks[0].items.find((i) => i.label === "Timers");
      assert.equal(timerStat.value, "3");

      const wyCardTimer = card.timers[0];
      assert.equal(wyCardTimer.id, "wy-only-1");
      assert.equal(wyCardTimer.actions.length, 1);
      assert.equal(wyCardTimer.actions[0].id, "ha:timer:dismiss:wy-only-1");

      const pastaCardTimer = card.timers[1];
      assert.equal(pastaCardTimer.id, "timer_list.kitchen_kitchen_assist_timers:tl-1:alpha");
      assert.equal(pastaCardTimer.label, "Pasta");
      assert.equal(pastaCardTimer.source, "Kitchen Assist");
      assert.equal(pastaCardTimer.color, "cobalt");
      assert.deepEqual(
        pastaCardTimer.actions.map((a) => a.id),
        [
          "ha:tl:pause:timer_list.kitchen_kitchen_assist_timers:tl-1:alpha",
          "ha:tl:add60:timer_list.kitchen_kitchen_assist_timers:tl-1:alpha",
          "ha:tl:cancel:timer_list.kitchen_kitchen_assist_timers:tl-1:alpha",
        ]
      );
      const pastaBlock = card.blocks.find((b) => b.type === "timer" && b.label === "Pasta · Kitchen Assist");
      assert.ok(pastaBlock, "expected timer block with source suffix in card.blocks");

      const pausedCardTimer = card.timers[2];
      assert.equal(pausedCardTimer.paused, true);
      assert.equal(pausedCardTimer.color, "ochre");
      assert.equal(pausedCardTimer.actions[0].label, "Resume");
      assert.equal(pausedCardTimer.actions[0].icon, "play");

      // Test _onRoomInteraction for ha:tl:pause / unpause / add60 / cancel (even with ":" inside timerId!)
      serviceCalls.length = 0;
      assistant._onRoomInteraction({
        mode: "action",
        actionId: "ha:tl:pause:timer_list.kitchen_kitchen_assist_timers:tl-1:alpha",
      });
      assistant._onRoomInteraction({
        mode: "action",
        actionId: "ha:tl:unpause:timer_list.kitchen_kitchen_assist_timers:tl-paused",
      });
      assistant._onRoomInteraction({
        mode: "action",
        actionId: "ha:tl:add60:timer_list.kitchen_kitchen_assist_timers:tl-1:alpha",
      });
      assistant._onRoomInteraction({
        mode: "action",
        actionId: "ha:tl:cancel:timer_list.kitchen_kitchen_assist_timers:tl-1:alpha",
      });
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(serviceCalls.length, 4);
      assert.deepEqual(
        serviceCalls.map((c) => [c.domain, c.service, c.target.entity_id, c.service_data]),
        [
          ["timer_list", "pause_timer", "timer_list.kitchen_kitchen_assist_timers", { timer_id: "tl-1:alpha" }],
          ["timer_list", "unpause_timer", "timer_list.kitchen_kitchen_assist_timers", { timer_id: "tl-paused" }],
          ["timer_list", "add_time", "timer_list.kitchen_kitchen_assist_timers", { timer_id: "tl-1:alpha", duration: 60 }],
          ["timer_list", "cancel_timer", "timer_list.kitchen_kitchen_assist_timers", { timer_id: "tl-1:alpha" }],
        ]
      );

      // Test HTTP endpoints: /api/timer/create, pause, unpause, add-time, cancel + Ingress HTML check
      serviceCalls.length = 0;
      const createRes = await fetch(`http://127.0.0.1:${ui.port}/api/timer/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Coffee", duration: "4m" }),
      }).then((r) => r.json());
      assert.equal(createRes.ok, true);

      const pauseRes = await fetch(`http://127.0.0.1:${ui.port}/api/timer/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: "timer_list.kitchen_kitchen_assist_timers", timerId: "tl-1:alpha" }),
      }).then((r) => r.json());
      assert.equal(pauseRes.ok, true);

      const unpauseRes = await fetch(`http://127.0.0.1:${ui.port}/api/timer/unpause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: "timer_list.kitchen_kitchen_assist_timers", timerId: "tl-paused" }),
      }).then((r) => r.json());
      assert.equal(unpauseRes.ok, true);

      const addRes = await fetch(`http://127.0.0.1:${ui.port}/api/timer/add-time`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: "timer_list.kitchen_kitchen_assist_timers", timerId: "tl-1:alpha", duration: 60 }),
      }).then((r) => r.json());
      assert.equal(addRes.ok, true);

      const cancelRes = await fetch(`http://127.0.0.1:${ui.port}/api/timer/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: "timer_list.kitchen_kitchen_assist_timers", timerId: "tl-1:alpha" }),
      }).then((r) => r.json());
      assert.equal(cancelRes.ok, true);

      assert.deepEqual(
        serviceCalls.map((c) => [c.service, c.target.entity_id, c.service_data]),
        [
          ["create_timer", "timer_list.kitchen_kitchen_assist_timers", { duration: 240, name: "Coffee" }],
          ["pause_timer", "timer_list.kitchen_kitchen_assist_timers", { timer_id: "tl-1:alpha" }],
          ["unpause_timer", "timer_list.kitchen_kitchen_assist_timers", { timer_id: "tl-paused" }],
          ["add_time", "timer_list.kitchen_kitchen_assist_timers", { timer_id: "tl-1:alpha", duration: 60 }],
          ["cancel_timer", "timer_list.kitchen_kitchen_assist_timers", { timer_id: "tl-1:alpha" }],
        ]
      );

      // Control Panel HTML remains strictly Ingress-safe (relative ./api/ only, no absolute /api/)
      const html = await fetch(`http://127.0.0.1:${ui.port}/`).then((r) => r.text());
      assert.match(html, /fetch\("\.\/api\/"/);
      assert.equal(html.includes('"/api/'), false, "Control Panel HTML must not contain absolute /api/ paths");
      assert.match(html, /id="timer-create-bar"/);

      // Live delta events: created, paused, unpaused, time_changed, finished (triggers chime + lastReply), cancelled, removed
      const kitchenSubId = subIdsByEntity.get("timer_list.kitchen_kitchen_assist_timers");
      const livingSubId = subIdsByEntity.get("timer_list.living_living_assist_timers");
      let chimeCount = 0;
      assistant.bot = {
        inVoice: true,
        getPeers: () => [],
        playChime: (kind) => {
          if (kind === "timer") chimeCount += 1;
        },
        updateBotMessage: () => {},
        sendBotMessage: () => ({ id: "msg-1" }),
      };
      assistant.roomState = "connected";

      // Created on Living Room (CANCEL_TIMER only -> only 1 action button!)
      serverWs.send(JSON.stringify({
        id: livingSubId,
        type: "event",
        event: {
          type: "change",
          event_type: "created",
          timer: {
            timer_id: "lr-1",
            name: "Laundry",
            status: "active",
            created_duration: 600,
            total_duration: 600,
            finishes_at: nowIsoPlus(600),
            remaining: 600,
          },
        },
      }));
      await new Promise((r) => setTimeout(r, 40));
      const lrCardTimer = assistant.buildChatCard().timers.find((t) => t.label === "Laundry");
      assert.ok(lrCardTimer);
      assert.equal(lrCardTimer.source, "Living Room");
      assert.deepEqual(lrCardTimer.actions.map((a) => a.label), ["Cancel"]);

      // Paused -> Unpaused -> Time changed on Kitchen
      serverWs.send(JSON.stringify({
        id: kitchenSubId,
        type: "event",
        event: {
          type: "change",
          event_type: "paused",
          timer: {
            timer_id: "tl-1:alpha",
            name: "Pasta",
            status: "paused",
            created_duration: 300,
            total_duration: 300,
            paused_remaining: 200,
            remaining: 200,
          },
        },
      }));
      serverWs.send(JSON.stringify({
        id: kitchenSubId,
        type: "event",
        event: {
          type: "change",
          event_type: "unpaused",
          timer: {
            timer_id: "tl-1:alpha",
            name: "Pasta",
            status: "active",
            created_duration: 300,
            total_duration: 300,
            finishes_at: nowIsoPlus(200),
            remaining: 200,
          },
        },
      }));
      serverWs.send(JSON.stringify({
        id: kitchenSubId,
        type: "event",
        event: {
          type: "change",
          event_type: "time_changed",
          delta: 60,
          timer: {
            timer_id: "tl-1:alpha",
            name: "Pasta",
            status: "active",
            created_duration: 300,
            total_duration: 360,
            finishes_at: nowIsoPlus(260),
            remaining: 260,
          },
        },
      }));
      await new Promise((r) => setTimeout(r, 40));
      const updatedPasta = assistant.haClient.getTimerListTimers().find((t) => t.id === "tl-1:alpha");
      assert.equal(updatedPasta.totalSeconds, 360);
      assert.equal(updatedPasta.paused, false);

      // Finished -> removes timer, plays chime, updates lastReply
      serverWs.send(JSON.stringify({
        id: kitchenSubId,
        type: "event",
        event: {
          type: "change",
          event_type: "finished",
          timer: {
            timer_id: "tl-1:alpha",
            name: "Pasta",
            status: "finished",
            created_duration: 300,
            total_duration: 360,
            remaining: 0,
          },
        },
      }));
      // Cancelled & removed
      serverWs.send(JSON.stringify({
        id: kitchenSubId,
        type: "event",
        event: {
          type: "change",
          event_type: "cancelled",
          timer: { timer_id: "tl-paused", name: "", status: "cancelled" },
        },
      }));
      serverWs.send(JSON.stringify({
        id: livingSubId,
        type: "event",
        event: {
          type: "change",
          event_type: "removed",
          timer: { timer_id: "lr-1", name: "Laundry", status: "cancelled" },
        },
      }));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(chimeCount, 1);
      assert.match(assistant.lastReply, /Timer finished: Pasta \(Kitchen Assist\)/);
      assert.equal(assistant.haClient.getTimerListTimers().length, 0);

      // Clear Wyoming timers too -> buildChatCard().timers must be []
      assistant.activeTimers.clear();
      assert.deepEqual(assistant.buildChatCard().timers, []);

      // state_changed: unavailable -> clears & unsubscribes; unavailable -> available -> resubscribes!
      const prevSubCount = subscribeCounts.get("timer_list.kitchen_kitchen_assist_timers") || 0;
      serverWs.send(JSON.stringify({
        type: "event",
        event: {
          event_type: "state_changed",
          data: {
            entity_id: "timer_list.kitchen_kitchen_assist_timers",
            old_state: { state: "1", attributes: { friendly_name: "kitchen_assist Timers", supported_features: 15 } },
            new_state: { state: "unavailable", attributes: { friendly_name: "kitchen_assist Timers", supported_features: 15 } },
          },
        },
      }));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(
        assistant.haClient.getTimerLists().find((t) => t.entityId === "timer_list.kitchen_kitchen_assist_timers").available,
        false
      );

      serverWs.send(JSON.stringify({
        type: "event",
        event: {
          event_type: "state_changed",
          data: {
            entity_id: "timer_list.kitchen_kitchen_assist_timers",
            old_state: { state: "unavailable", attributes: { friendly_name: "kitchen_assist Timers", supported_features: 15 } },
            new_state: { state: "2", attributes: { friendly_name: "kitchen_assist Timers", supported_features: 15 } },
          },
        },
      }));
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(
        subscribeCounts.get("timer_list.kitchen_kitchen_assist_timers"),
        prevSubCount + 1,
        "expected timer_list entity to resubscribe after transitioning unavailable -> available"
      );
      assert.equal(assistant.haClient.getTimerListTimers().length, 2);

      // Detach mock bot cleanly before stop()
      assistant.bot = null;
      assistant.roomState = "disconnected";
    } finally {
      await assistant.stop();
      await new Promise((r) => mockHaWss.close(r));
    }
  });

  it("relays HA p2p_voice_send_chat events to room chat with chunking and exposes POST /api/chat", async () => {
    const mockHaWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => mockHaWss.once("listening", r));
    const haPort = mockHaWss.address().port;

    let serverWs = null;
    const subscribedEventTypes = [];
    mockHaWss.on("connection", (ws) => {
      serverWs = ws;
      ws.send(JSON.stringify({ type: "auth_required" }));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        if (m.type === "auth") {
          ws.send(JSON.stringify({ type: "auth_ok" }));
        } else if (m.type === "subscribe_events") {
          subscribedEventTypes.push(m.event_type);
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
        } else if (m.type === "get_states") {
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: [] }));
        } else if (m.type === "assist_pipeline/pipeline/list") {
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: { preferred_pipeline: "", pipelines: [] },
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
      haToken: "tok",
    });

    const { ui } = await assistant.start();
    try {
      await new Promise((r) => setTimeout(r, 120));
      assert.ok(subscribedEventTypes.includes("p2p_voice_send_chat"), "expected subscription to p2p_voice_send_chat");

      // POST /api/chat when empty -> 400
      const emptyRes = await fetch(`http://127.0.0.1:${ui.port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "   " }),
      });
      assert.equal(emptyRes.status, 400);
      assert.equal((await emptyRes.json()).ok, false);

      // POST /api/chat when disconnected -> 409
      const disconnRes = await fetch(`http://127.0.0.1:${ui.port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello room" }),
      });
      assert.equal(disconnRes.status, 409);
      assert.equal((await disconnRes.json()).ok, false);

      // Connect mock bot
      const sentTexts = [];
      let nextMsgSeq = 1;
      assistant.bot = {
        inVoice: true,
        getPeers: () => [],
        sendText: (t) => {
          sentTexts.push(t);
          return { id: `chat-${nextMsgSeq++}` };
        },
      };
      assistant.roomState = "connected";

      // HA custom event p2p_voice_send_chat -> calls bot.sendText with title + markdown code block
      const mdCode = "```python\nprint('hello from HA')\n```";
      serverWs.send(JSON.stringify({
        type: "event",
        event: {
          event_type: "p2p_voice_send_chat",
          data: { title: "Python Example", message: mdCode },
        },
      }));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(sentTexts.length, 1);
      assert.equal(sentTexts[0], `Python Example\n${mdCode}`);

      // POST /api/chat when connected -> 200
      const okRes = await fetch(`http://127.0.0.1:${ui.port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Shopping List", text: "- Milk\n- Eggs" }),
      });
      assert.equal(okRes.status, 200);
      const okBody = await okRes.json();
      assert.equal(okBody.ok, true);
      assert.equal(okBody.chunks, 1);
      assert.deepEqual(okBody.ids, ["chat-2"]);
      assert.equal(sentTexts[1], "Shopping List\n- Milk\n- Eggs");

      // Long message (>12,000 chars) splits cleanly on newline boundaries
      sentTexts.length = 0;
      const longMsg = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}: ${"x".repeat(50)}`).join("\n");
      assert.ok(longMsg.length > 12000);
      const chunkRes = assistant.sendRoomChat(longMsg, { title: "Long Report" });
      assert.equal(chunkRes.ok, true);
      assert.equal(chunkRes.chunks, 2);
      assert.equal(sentTexts.length, 2);
      assert.ok(sentTexts.every((c) => c.length <= 12000));
      assert.ok(sentTexts[0].startsWith("Long Report\nLine 1:"));
      assert.ok(sentTexts[1].endsWith(longMsg.split("\n").at(-1)));

      assistant.bot = null;
      assistant.roomState = "disconnected";
    } finally {
      await assistant.stop();
      await new Promise((r) => mockHaWss.close(r));
    }
  });

  it("parses WAV PCM16 headers cleanly, runs /ai (and legacy /ha) through assist_pipeline/run with live thinking activity transitions, WAV TTS + MP3 fallback + chat reply, and /listen", async () => {
    const buildWav = ({ sampleRate = 22050, channels = 1, bitsPerSample = 16, audioFormat = 1, pcmBytes, extraChunks = [] }) => {
      const fmt = Buffer.alloc(16);
      fmt.writeUInt16LE(audioFormat, 0);
      fmt.writeUInt16LE(channels, 2);
      fmt.writeUInt32LE(sampleRate, 4);
      fmt.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 8);
      fmt.writeUInt16LE((channels * bitsPerSample) / 8, 12);
      fmt.writeUInt16LE(bitsPerSample, 14);

      const parts = [];
      const addChunk = (id, data) => {
        const hdr = Buffer.alloc(8);
        hdr.write(id, 0, 4, "ascii");
        hdr.writeUInt32LE(data.length, 4);
        parts.push(hdr, data);
        if (data.length & 1) parts.push(Buffer.alloc(1));
      };
      for (const ch of extraChunks) addChunk(ch.id, ch.data);
      addChunk("fmt ", fmt);
      addChunk("data", pcmBytes);
      const body = Buffer.concat(parts);
      const riff = Buffer.alloc(12);
      riff.write("RIFF", 0, 4, "ascii");
      riff.writeUInt32LE(4 + body.length, 4);
      riff.write("WAVE", 8, 4, "ascii");
      return Buffer.concat([riff, body]);
    };

    // 1. Unit-test parseWavPcm16
    const rawPcm = makeSinePcm(22050, 40, 1);
    const stdWav = buildWav({ sampleRate: 22050, channels: 1, pcmBytes: rawPcm });
    const parsedStd = parseWavPcm16(stdWav);
    assert.ok(parsedStd);
    assert.equal(parsedStd.sampleRate, 22050);
    assert.equal(parsedStd.channels, 1);
    assert.deepEqual(parsedStd.pcm, rawPcm);

    const extraWav = buildWav({
      sampleRate: 16000,
      channels: 2,
      pcmBytes: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      extraChunks: [
        { id: "JUNK", data: Buffer.from("odd") }, // odd length tests RIFF word alignment
        { id: "LIST", data: Buffer.from("INFOmeta") },
      ],
    });
    const parsedExtra = parseWavPcm16(extraWav);
    assert.ok(parsedExtra);
    assert.equal(parsedExtra.sampleRate, 16000);
    assert.equal(parsedExtra.channels, 2);
    assert.deepEqual(parsedExtra.pcm, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

    assert.equal(parseWavPcm16(Buffer.from("ID3\x03\x00mp3data")), null);
    assert.equal(parseWavPcm16(buildWav({ audioFormat: 3, bitsPerSample: 32, pcmBytes: Buffer.alloc(16) })), null);
    assert.equal(parseWavPcm16(buildWav({ bitsPerSample: 8, pcmBytes: Buffer.alloc(16) })), null);

    // 2. Combined Mock HA HTTP + WebSocket server
    let fetchedAuth = "";
    const httpServer = http.createServer((req, res) => {
      fetchedAuth = req.headers.authorization || "";
      if (req.url === "/api/tts_proxy/reply.wav") {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(stdWav);
        return;
      }
      if (req.url === "/api/tts_proxy/reply.mp3") {
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(Buffer.from("ID3\x03\x00fake-mp3-audio"));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    const wss = new WebSocketServer({ server: httpServer, path: "/api/websocket" });
    await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
    const haPort = httpServer.address().port;

    const pipelineRequests = [];
    const serviceCalls = [];
    let mode = "wav"; // wav | mp3 | tts_fail_once | thinking_fail_once | unknown_cmd
    const heldPipelineResolvers = [];
    let holdPipeline = false;

    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "auth_required" }));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        if (m.type === "auth") {
          ws.send(JSON.stringify({ type: "auth_ok" }));
        } else if (m.type === "subscribe_events") {
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
        } else if (m.type === "get_states") {
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: [
              { entity_id: "select.voice_room_p2p_direct_voice_assistant", state: "Assist LLM" },
              { entity_id: "assist_satellite.voice_room_p2p_direct_voice", state: "idle" },
            ],
          }));
        } else if (m.type === "config/entity_registry/get") {
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: { entity_id: m.entity_id, device_id: "dev-sat-42" },
          }));
        } else if (m.type === "assist_pipeline/pipeline/list") {
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: {
              preferred_pipeline: "p-assist",
              pipelines: [
                {
                  id: "p-assist",
                  name: "Assist LLM",
                  tts_engine: "tts.piper",
                  wake_word_entity: "wake_word.openwakeword",
                  wake_word_id: "hey_jarvis",
                },
              ],
            },
          }));
        } else if (m.type === "assist_pipeline/run") {
          pipelineRequests.push(m);
          if (mode === "unknown_cmd") {
            ws.send(JSON.stringify({
              id: m.id,
              type: "result",
              success: false,
              error: { code: "unknown_command", message: "Unknown command." },
            }));
            return;
          }
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));

          if (mode === "tts_fail_once" && m.end_stage === "tts") {
            ws.send(JSON.stringify({
              id: m.id,
              type: "event",
              event: { type: "error", data: { code: "tts-failed", message: "TTS engine offline" } },
            }));
            return;
          }
          if (mode === "thinking_fail_once" && m.conversation_id) {
            ws.send(JSON.stringify({
              id: m.id,
              type: "event",
              event: { type: "error", data: { code: "intent-failed", message: "Invalid thinking signature block_binding" } },
            }));
            return;
          }

          const finishPipelineRun = () => {
            ws.send(JSON.stringify({
              id: m.id,
              type: "event",
              event: {
                type: "intent-end",
                data: {
                  intent_output: {
                    conversation_id: m.conversation_id || "conv-fresh-1",
                    response: {
                      response_type: "action_done",
                      speech: { plain: { speech: `Handled: ${m.input.text}` } },
                    },
                  },
                },
              },
            }));
            if (m.end_stage === "tts") {
              ws.send(JSON.stringify({
                id: m.id,
                type: "event",
                event: {
                  type: "tts-end",
                  data: {
                    tts_output:
                      mode === "mp3"
                        ? {
                            media_id: "media-source://tts/google_mp3_1",
                            url: "/api/tts_proxy/reply.mp3",
                            mime_type: "audio/mpeg",
                          }
                        : {
                            media_id: "media-source://tts/piper_wav_1",
                            url: "/api/tts_proxy/reply.wav",
                            mime_type: "audio/wav",
                          },
                  },
                },
              }));
            }
            ws.send(JSON.stringify({ id: m.id, type: "event", event: { type: "run-end", data: {} } }));
          };
          if (holdPipeline) {
            heldPipelineResolvers.push(finishPipelineRun);
          } else {
            finishPipelineRun();
          }
        } else if (m.type === "conversation/process") {
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: {
              conversation_id: "conv-fallback",
              response: {
                response_type: "action_done",
                speech: { plain: { speech: `Fallback: ${m.text}` } },
              },
            },
          }));
        } else if (m.type === "call_service") {
          serviceCalls.push(m);
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
        }
      });
    });

    const assistant = new HomeAssistantVoiceAssistant({
      name: "ha",
      wyomingHost: "127.0.0.1",
      wyomingPort: 0,
      wyomingName: "p2p-direct-voice",
      uiHost: "127.0.0.1",
      uiPort: 0,
      haUrl: `http://127.0.0.1:${haPort}`,
      haToken: "tok-pipeline",
    });

    const { ui } = await assistant.start();
    try {
      await new Promise((r) => setTimeout(r, 140));

      // Pipeline & satellite entity/device discovered
      const st = await fetch(`http://127.0.0.1:${ui.port}/api/status`).then((r) => r.json());
      assert.deepEqual(st.state.pipeline, {
        id: "p-assist",
        name: "Assist LLM",
        ttsEngine: "tts.piper",
      });
      assert.equal(assistant.haClient.satelliteEntityId, "assist_satellite.voice_room_p2p_direct_voice");
      assert.equal(assistant.haClient.satelliteDeviceId, "dev-sat-42");

      const card = assistant.buildChatCard();
      assert.deepEqual(card.assistantMeta, {
        pipelineName: "Assist LLM",
        wakeWordLabel: "Hey Jarvis",
        commands: ["/ai", "/listen"],
      });
      assert.equal(card.voiceControls.activity, "idle");

      // Attach mock room bot capturing PCM playback, chat sends, and card syncs
      const pushedPcm = [];
      let audioEndMarked = 0;
      const rawChatSends = [];
      const cardUpdates = [];
      let cardSent = 0;
      let listenTriggers = 0;
      assistant.wyoming.triggerListenNow = () => {
        listenTriggers += 1;
        return true;
      };
      assistant.wyoming.isReady = () => true;
      assistant.bot = {
        peerId: "bot-self",
        inVoice: true,
        getPeers: () => [],
        stopAudio: () => {},
        setVoiceMuted: () => {},
        pushPcmBytes: (buf, opts) => pushedPcm.push({ buf, opts }),
        markAudioStreamEnd: () => { audioEndMarked += 1; },
        playChime: () => {},
        sendRaw: (type, payload) => {
          rawChatSends.push({ type, payload });
          return { id: `m-${rawChatSends.length}` };
        },
        sendBotMessage: () => {
          cardSent += 1;
          return { id: `card-${cardSent}` };
        },
        updateBotMessage: (_id, updatedCard) => {
          cardUpdates.push(updatedCard);
        },
      };
      assistant.roomState = "connected";
      assistant.controlMsgId = "card-initial";

      // 3. `/ai <message>` triggers assist_pipeline/run -> WAV PCM16 playback + normal chat reply with replyTo
      mode = "wav";
      assistant._onRoomMessage({
        type: "chat",
        author: "peer-alice",
        authorName: "Alice",
        payload: { text: "/ai Turn on the desk lamp" },
      });
      await new Promise((r) => setTimeout(r, 120));

      assert.equal(pipelineRequests.length, 1);
      assert.equal(pipelineRequests[0].start_stage, "intent");
      assert.equal(pipelineRequests[0].end_stage, "tts");
      assert.equal(pipelineRequests[0].pipeline, "p-assist");
      assert.equal(pipelineRequests[0].device_id, "dev-sat-42");
      assert.deepEqual(pipelineRequests[0].input, { text: "Turn on the desk lamp" });
      assert.equal(fetchedAuth, "Bearer tok-pipeline");
      assert.equal(pushedPcm.length, 1);
      assert.equal(pushedPcm[0].opts.sampleRate, 22050);
      assert.equal(pushedPcm[0].opts.channels, 1);
      assert.equal(audioEndMarked, 1);
      assert.equal(rawChatSends.length, 1);
      assert.equal(rawChatSends[0].type, "chat");
      assert.equal(rawChatSends[0].payload.text, "Handled: Turn on the desk lamp");
      assert.equal(rawChatSends[0].payload.assistant, true);
      assert.deepEqual(rawChatSends[0].payload.replyTo, {
        toName: "Alice",
        botName: "ha",
        label: "Assist LLM",
        pipeline: "Assist LLM",
        spoken: true,
      });

      // 3b. In-flight askText() transitions voiceControls.activity: idle -> thinking -> idle (even for overlapping calls & when muted)
      assert.equal(assistant.buildChatCard().voiceControls.activity, "idle");
      assert.equal(assistant.getApiState().thinking, false);
      cardUpdates.length = 0;
      holdPipeline = true;
      const ask1 = assistant.askText("First held query", { speakerName: "Alice", speak: false });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(heldPipelineResolvers.length, 1);
      const midCard1 = assistant.buildChatCard();
      assert.equal(midCard1.badge, "THINKING");
      assert.equal(midCard1.color, "cyan");
      assert.equal(midCard1.voiceControls.status, "Thinking...");
      assert.equal(midCard1.voiceControls.statusTone, "cyan");
      assert.equal(midCard1.voiceControls.activity, "thinking");
      assert.equal(assistant.getApiState().thinking, true);
      assert.equal(assistant.textThinking, true);
      assert.ok(
        cardUpdates.some((c) => c.voiceControls?.activity === "thinking"),
        "expected syncChatCard to broadcast activity='thinking' while askText is in-flight"
      );

      // Even if muted during a text query, thinking badge/activity remains active
      assistant.setMuted(true);
      assert.equal(assistant.buildChatCard().voiceControls.activity, "thinking");
      assert.equal(assistant.buildChatCard().badge, "THINKING");
      assert.equal(assistant.buildChatCard().voiceControls.status, "Thinking...");
      assistant.setMuted(false);

      // Overlapping second query keeps thinking active until BOTH resolve
      const ask2 = assistant.askText("Second held query", { speakerName: "Alice", speak: false });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(heldPipelineResolvers.length, 2);

      // Finish first query -> still thinking because second is still in flight!
      heldPipelineResolvers.shift()();
      await ask1;
      assert.equal(assistant.buildChatCard().voiceControls.activity, "thinking");
      assert.equal(assistant.getApiState().thinking, true);

      // Finish second query -> transitions back to idle cleanly!
      heldPipelineResolvers.shift()();
      await ask2;
      holdPipeline = false;
      assert.equal(assistant.buildChatCard().voiceControls.activity, "idle");
      assert.equal(assistant.getApiState().thinking, false);
      assert.equal(assistant.textThinking, false);
      assert.equal(cardUpdates.at(-1)?.voiceControls?.activity, "idle");

      // If runTextPipeline throws/rejects, thinking counter still unwinds to idle cleanly
      const origRunTextPipeline = assistant.haClient.runTextPipeline.bind(assistant.haClient);
      assistant.haClient.runTextPipeline = async () => {
        assert.equal(assistant.buildChatCard().voiceControls.activity, "thinking");
        throw new Error("Simulated pipeline failure");
      };
      await assert.rejects(() => assistant.askText("Failing query", { speakerName: "Alice", speak: false }), /Simulated pipeline failure/);
      assistant.haClient.runTextPipeline = origRunTextPipeline;
      assert.equal(assistant.buildChatCard().voiceControls.activity, "idle");
      assert.equal(assistant.getApiState().thinking, false);

      // 4. Non-WAV MP3 fallback -> calls assist_satellite.announce(preannounce: false, media_id)
      mode = "mp3";
      serviceCalls.length = 0;
      const mp3Res = await assistant.askText("What time is it?", { speakerName: "Alice" });
      assert.equal(mp3Res.spoken, true);
      assert.equal(mp3Res.postedToChat, true);
      assert.equal(serviceCalls.length, 1);
      assert.equal(serviceCalls[0].domain, "assist_satellite");
      assert.equal(serviceCalls[0].service, "announce");
      assert.deepEqual(serviceCalls[0].target, { entity_id: "assist_satellite.voice_room_p2p_direct_voice" });
      assert.deepEqual(serviceCalls[0].service_data, {
        media_id: "media-source://tts/google_mp3_1",
        preannounce: false,
      });

      // 5. TTS error resilience: retries once with end_stage="intent" so written reply still succeeds
      mode = "tts_fail_once";
      pipelineRequests.length = 0;
      const ttsRetryRes = await assistant.askText("Check weather", { speakerName: "Alice" });
      assert.equal(pipelineRequests.length, 2);
      assert.equal(pipelineRequests[0].end_stage, "tts");
      assert.equal(pipelineRequests[1].end_stage, "intent");
      assert.equal(ttsRetryRes.text, "Handled: Check weather");
      assert.equal(ttsRetryRes.spoken, false);
      assert.equal(ttsRetryRes.postedToChat, true);

      // 6. Stale Anthropic thinking/signature error resilience: retries once without conversation_id
      mode = "thinking_fail_once";
      pipelineRequests.length = 0;
      assistant.conversationId = "stale-conv-id";
      const thinkRetryRes = await assistant.askText("Summarize notes", { speakerName: "Alice" });
      assert.equal(pipelineRequests.length, 2);
      assert.equal(pipelineRequests[0].conversation_id, "stale-conv-id");
      assert.equal(pipelineRequests[1].conversation_id, undefined);
      assert.equal(thinkRetryRes.text, "Handled: Summarize notes");

      // 7. unknown_command fallback -> conversation/process
      mode = "unknown_cmd";
      const fbRes = await assistant.askText("Legacy ping", { speakerName: "Alice" });
      assert.equal(fbRes.text, "Fallback: Legacy ping");

      // 8. `/listen`, `/ai` (refresh), and legacy `/ha` & `/ha <message>` backwards-compatible aliases
      assistant._onRoomMessage({
        type: "chat",
        author: "peer-alice",
        authorName: "Alice",
        payload: { text: "/listen" },
      });
      assert.equal(listenTriggers, 1);

      const cardsBeforeAi = cardSent;
      assistant._onRoomMessage({
        type: "chat",
        author: "peer-alice",
        authorName: "Alice",
        payload: { text: "/ai" },
      });
      assert.equal(cardSent, cardsBeforeAi + 1);

      assistant._onRoomMessage({
        type: "chat",
        author: "peer-alice",
        authorName: "Alice",
        payload: { text: "/ha" },
      });
      assert.equal(cardSent, cardsBeforeAi + 2);

      mode = "wav";
      pipelineRequests.length = 0;
      assistant._onRoomMessage({
        type: "chat",
        author: "peer-alice",
        authorName: "Alice",
        payload: { text: "/ha Legacy alias check" },
      });
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(pipelineRequests.length, 1);
      assert.deepEqual(pipelineRequests[0].input, { text: "Legacy alias check" });

      assistant.bot = null;
      assistant.roomState = "disconnected";
    } finally {
      await assistant.stop();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => httpServer.close(r));
    }
  });

  it("enforces admin-only Disable Entity Controls via chat-only pipeline switching, room lockdown, state persistence, restore, and fail-closed strict lock", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-ha-lock-"));
    const stateFile = path.join(tmpDir, "p2p-voice-state.json");

    const cliLock = parseHaCliArgs(["--no-control-pipeline", "Custom Chat Only", "--state-file", stateFile]);
    assert.equal(cliLock.noControlPipeline, "Custom Chat Only");
    assert.equal(cliLock.stateFile, stateFile);

    // 1. Mock HA WS with normal pipeline + auto-discovered "P2P Chat Only (No Controls)" pipeline + timer_list
    const mockHaWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => mockHaWss.once("listening", r));
    const haPort = mockHaWss.address().port;

    let currentSelectState = "Assist LLM";
    let includeNoControlPipeline = true;
    const serviceCalls = [];
    const pipelineRuns = [];

    mockHaWss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "auth_required" }));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        if (m.type === "auth") {
          ws.send(JSON.stringify({ type: "auth_ok" }));
        } else if (m.type === "subscribe_events") {
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
        } else if (m.type === "get_states") {
          const selectOpts = includeNoControlPipeline
            ? ["preferred", "Assist LLM", "P2P Chat Only (No Controls)"]
            : ["preferred", "Assist LLM"];
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: [
              {
                entity_id: "select.voice_room_p2p_direct_voice_assistant",
                state: currentSelectState,
                attributes: { options: selectOpts },
              },
              {
                entity_id: "timer_list.kitchen_timers",
                state: "1",
                attributes: {
                  friendly_name: "Kitchen Timers",
                  supported_features:
                    TIMER_LIST_FEATURES.CREATE_TIMER |
                    TIMER_LIST_FEATURES.PAUSE_TIMER |
                    TIMER_LIST_FEATURES.CANCEL_TIMER |
                    TIMER_LIST_FEATURES.ADD_TIME,
                },
              },
            ],
          }));
        } else if (m.type === "assist_pipeline/pipeline/list") {
          const pipelines = [
            {
              id: "p-assist",
              name: "Assist LLM",
              tts_engine: "tts.piper",
              wake_word_entity: "wake_word.openwakeword",
              wake_word_id: "hey_jarvis",
            },
          ];
          if (includeNoControlPipeline) {
            pipelines.push({
              id: "p-no-ctrl",
              name: "P2P Chat Only (No Controls)",
              tts_engine: "tts.piper",
              wake_word_entity: "wake_word.openwakeword",
              wake_word_id: "hey_jarvis",
            });
          }
          ws.send(JSON.stringify({
            id: m.id,
            type: "result",
            success: true,
            result: { preferred_pipeline: "p-assist", pipelines },
          }));
        } else if (m.type === "timer_list/item/subscribe") {
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
          ws.send(JSON.stringify({
            id: m.id,
            type: "event",
            event: {
              type: "timers",
              timers: [
                {
                  timer_id: "t-pasta",
                  name: "Pasta",
                  status: "active",
                  created_duration: 300,
                  total_duration: 300,
                  finishes_at: new Date(Date.now() + 240_000).toISOString(),
                  remaining: 240,
                },
              ],
            },
          }));
        } else if (m.type === "call_service") {
          serviceCalls.push(m);
          if (m.domain === "select" && m.service === "select_option") {
            currentSelectState = m.service_data.option;
          }
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
        } else if (m.type === "assist_pipeline/run") {
          pipelineRuns.push(m);
          ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
          ws.send(JSON.stringify({
            id: m.id,
            type: "event",
            event: {
              type: "intent-end",
              data: {
                intent_output: {
                  conversation_id: "conv-safe-1",
                  response: {
                    response_type: "action_done",
                    speech: { plain: { speech: `Reply via ${m.pipeline}` } },
                  },
                },
              },
            },
          }));
          ws.send(JSON.stringify({ id: m.id, type: "event", event: { type: "run-end", data: {} } }));
        }
      });
    });

    let a1 = null;
    let a2 = null;
    let a3 = null;
    try {
      // Instance 1: auto-discovers "P2P Chat Only (No Controls)", locks via POST /api/entity-controls
      a1 = new HomeAssistantVoiceAssistant({
        wyomingHost: "127.0.0.1",
        wyomingPort: 0,
        uiHost: "127.0.0.1",
        uiPort: 0,
        haUrl: `http://127.0.0.1:${haPort}`,
        haToken: "tok",
        stateFile,
      });
      const { ui: ui1 } = await a1.start();
      await new Promise((r) => setTimeout(r, 140));

      assert.equal(a1.haClient.noControlPipeline?.id, "p-no-ctrl");
      assert.equal(a1.haClient.noControlPipeline?.name, "P2P Chat Only (No Controls)");

      // Check Control Panel HTML contains admin controls bar, `/ai` strict-lock hint & strictly relative ./api/
      const html = await fetch(`http://127.0.0.1:${ui1.port}/`).then((r) => r.text());
      assert.match(html, /id="controls-banner"/);
      assert.match(html, /id="btn-entity-controls"/);
      assert.match(html, /api\("entity-controls"/);
      assert.match(html, /Voice & \/ai blocked/);
      assert.equal(html.includes('"/api/'), false);

      // Attach mock room bot & ready Wyoming
      const chatPosts = [];
      a1.wyoming.isReady = () => true;
      a1.wyoming.triggerListenNow = () => true;
      a1.bot = {
        peerId: "bot-1",
        inVoice: true,
        getPeers: () => [],
        playChime: () => {},
        sendRaw: (type, payload) => {
          chatPosts.push({ type, payload });
          return { id: `c-${chatPosts.length}` };
        },
        updateBotMessage: () => {},
        sendBotMessage: () => ({ id: "card-1" }),
      };
      a1.roomState = "connected";
      a1.conversationId = "old-tool-bearing-conv";

      // Lock entity controls via Ingress API
      const lockRes = await fetch(`http://127.0.0.1:${ui1.port}/api/entity-controls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      }).then((r) => r.json());

      assert.equal(lockRes.ok, true);
      assert.deepEqual(lockRes.state.entityControls, {
        disabled: true,
        mode: "chat_only_pipeline",
        noControlPipelineName: "P2P Chat Only (No Controls)",
        previousPipelineName: "Assist LLM",
      });
      assert.equal(a1.conversationId, null, "conversationId must reset when locking");

      // Switched select.*_assistant via select.select_option
      const selCall = serviceCalls.find((c) => c.domain === "select" && c.service === "select_option");
      assert.ok(selCall);
      assert.equal(selCall.target.entity_id, "select.voice_room_p2p_direct_voice_assistant");
      assert.equal(selCall.service_data.option, "P2P Chat Only (No Controls)");

      // `/ai` is forced onto no-control pipeline ID
      pipelineRuns.length = 0;
      const askRes = await a1.askText("Turn off the kitchen lights", { speakerName: "Alice" });
      assert.equal(pipelineRuns.length, 1);
      assert.equal(pipelineRuns[0].pipeline, "p-no-ctrl");
      assert.equal(askRes.text, "Reply via p-no-ctrl");
      assert.equal(chatPosts[0].payload.replyTo.pipeline, "P2P Chat Only (No Controls)");

      // Listen Now still works safely in chat-only pipeline mode
      assert.equal(a1.triggerListenNow({ speakerName: "Alice" }).ok, true);

      // buildChatCard() strips all ha:tl:* actions, notes disabled in footer, NEVER exposes unlock button
      const lockedCard = a1.buildChatCard();
      assert.equal(lockedCard.timers.length, 1);
      assert.equal(lockedCard.timers[0].label, "Pasta");
      assert.deepEqual(lockedCard.timers[0].actions, []);
      assert.match(lockedCard.footer, /Entity controls disabled · Chat only/);
      const allCardBtnIds = [
        ...lockedCard.voiceControls.buttons.map((b) => b.id),
        ...lockedCard.buttons.flatMap((g) => g.buttons.map((b) => b.id)),
      ];
      assert.equal(
        allCardBtnIds.some((id) => /control|lock|unlock|enable/i.test(id)),
        false,
        "public room card must NEVER expose entity-controls unlock button"
      );

      // Room timer interactions (pause/cancel) are blocked
      serviceCalls.length = 0;
      a1._onRoomInteraction({ mode: "action", actionId: "ha:tl:pause:timer_list.kitchen_timers:t-pasta" });
      a1._onRoomInteraction({ mode: "action", actionId: "ha:tl:cancel:timer_list.kitchen_timers:t-pasta" });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(serviceCalls.filter((c) => c.domain === "timer_list").length, 0);

      // Detach mock bot & stop instance 1
      a1.bot = null;
      a1.roomState = "disconnected";
      await a1.stop();
      a1 = null;

      // Verify state file persisted cleanly
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.deepEqual(saved, {
        entityControlsDisabled: true,
        previousPipelineName: "Assist LLM",
      });

      // 2. Fresh instance 2 sharing same stateFile enforces lock on startup even if HA reverted selector
      currentSelectState = "Assist LLM";
      serviceCalls.length = 0;
      a2 = new HomeAssistantVoiceAssistant({
        wyomingHost: "127.0.0.1",
        wyomingPort: 0,
        uiHost: "127.0.0.1",
        uiPort: 0,
        haUrl: `http://127.0.0.1:${haPort}`,
        haToken: "tok",
        stateFile,
      });
      assert.equal(a2.entityControlsDisabled, true);
      assert.equal(a2.previousPipelineName, "Assist LLM");
      const { ui: ui2 } = await a2.start();
      await new Promise((r) => setTimeout(r, 160));

      assert.ok(
        serviceCalls.some(
          (c) =>
            c.domain === "select" &&
            c.service === "select_option" &&
            c.service_data.option === "P2P Chat Only (No Controls)"
        ),
        "expected persisted lock to enforce chat-only pipeline on startup"
      );

      // Re-enable entity controls via POST /api/entity-controls { disabled: false }
      serviceCalls.length = 0;
      const unlockRes = await fetch(`http://127.0.0.1:${ui2.port}/api/entity-controls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: false }),
      }).then((r) => r.json());
      assert.equal(unlockRes.ok, true);
      assert.equal(unlockRes.state.entityControls.disabled, false);
      assert.equal(unlockRes.state.entityControls.mode, "enabled");
      assert.equal(unlockRes.state.entityControls.previousPipelineName, "");
      assert.ok(
        serviceCalls.some(
          (c) => c.domain === "select" && c.service === "select_option" && c.service_data.option === "Assist LLM"
        ),
        "expected unlocking to restore previous pipeline via select.select_option"
      );

      // Room timer controls & card timer actions are re-enabled
      const unlockedCard = a2.buildChatCard();
      assert.equal(unlockedCard.timers[0].actions.length, 3);
      serviceCalls.length = 0;
      a2._onRoomInteraction({ mode: "action", actionId: "ha:tl:pause:timer_list.kitchen_timers:t-pasta" });
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(serviceCalls.some((c) => c.domain === "timer_list" && c.service === "pause_timer"));

      await a2.stop();
      a2 = null;

      // 3. Fail-closed strict lock when NO chat-only/no-control pipeline exists on HA
      includeNoControlPipeline = false;
      currentSelectState = "Assist LLM";
      pipelineRuns.length = 0;
      a3 = new HomeAssistantVoiceAssistant({
        wyomingHost: "127.0.0.1",
        wyomingPort: 0,
        uiHost: "127.0.0.1",
        uiPort: 0,
        haUrl: `http://127.0.0.1:${haPort}`,
        haToken: "tok",
      });
      const { ui: ui3 } = await a3.start();
      await new Promise((r) => setTimeout(r, 140));
      assert.equal(a3.haClient.noControlPipeline, null);
      a3.wyoming.isReady = () => true;
      a3.wyoming.triggerListenNow = () => true;

      const strictRes = await fetch(`http://127.0.0.1:${ui3.port}/api/entity-controls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }).then((r) => r.json());
      assert.equal(strictRes.ok, true);
      assert.equal(strictRes.state.entityControls.disabled, true);
      assert.equal(strictRes.state.entityControls.mode, "strict_lock");
      assert.equal(a3.wyoming.wakeWordEnabled, false, "strict lock must pause Wyoming wake listening");

      // Room attempt to re-enable wake word must remain paused under strict lock
      a3.setWakeWordEnabled(true);
      assert.equal(a3.wyoming.wakeWordEnabled, false);

      // triggerListenNow and askText both fail closed without calling HA
      const listenBlocked = a3.triggerListenNow({ speakerName: "Alice" });
      assert.equal(listenBlocked.ok, false);
      assert.match(listenBlocked.error, /Entity controls are disabled/i);

      const askBlocked = await a3.askText("Unlock front door", { speakerName: "Alice" });
      assert.equal(askBlocked.blocked, true);
      assert.match(askBlocked.text, /Entity controls are currently disabled/i);
      assert.equal(pipelineRuns.length, 0, "strict lock must never call HA assist_pipeline/run");

      // Re-enabling restores wake listening cleanly
      const strictUnlock = await fetch(`http://127.0.0.1:${ui3.port}/api/entity-controls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }).then((r) => r.json());
      assert.equal(strictUnlock.state.entityControls.disabled, false);
      assert.equal(a3.wyoming.wakeWordEnabled, true);

      await a3.stop();
      a3 = null;
    } finally {
      if (a1) await a1.stop();
      if (a2) await a2.stop();
      if (a3) await a3.stop();
      await new Promise((r) => mockHaWss.close(r));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
