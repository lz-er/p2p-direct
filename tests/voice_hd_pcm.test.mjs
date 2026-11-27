import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.__P2P_NO_AUTO_BOOT__ = true;
const {
  P2PDirectApp,
  VOICE_V2_CODEC_OPUS48,
  VOICE_V2_CODEC_PCM16,
  VOICE_V2_HEADER_BYTES,
  decodeVoiceV2Pcm16Payload,
  formatVoiceCodecLabel,
} = await import("../app.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS_PATH = path.resolve(__dirname, "..", "app.js");

function buildV2Pcm16Payload({
  codecId = VOICE_V2_CODEC_PCM16,
  sampleRateKhz = 24,
  rms = 1234,
  tsSamples = 480,
  samples = new Int16Array(480),
  extraTailBytes = 0,
} = {}) {
  const buf = new Uint8Array(VOICE_V2_HEADER_BYTES + samples.length * 2 + extraTailBytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf[0] = codecId;
  buf[1] = sampleRateKhz;
  dv.setUint16(2, rms, true);
  dv.setUint32(4, tsSamples >>> 0, true);
  for (let i = 0; i < samples.length; i++) {
    dv.setInt16(VOICE_V2_HEADER_BYTES + i * 2, samples[i], true);
  }
  return buf;
}

function createMockEl() {
  return {
    innerHTML: "",
    textContent: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

describe("Voice V2 Lossless PCM16 — decodeVoiceV2Pcm16Payload", () => {
  it("decodes a 24 kHz 480-sample PCM16 payload with exact header & float32 samples", () => {
    const samples = new Int16Array(480);
    samples[0] = -32768;
    samples[1] = 0;
    samples[2] = 16384;
    samples[3] = 32767;
    for (let i = 4; i < 480; i++) {
      samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 12000);
    }

    const raw = buildV2Pcm16Payload({
      sampleRateKhz: 24,
      rms: 8485,
      tsSamples: 9600,
      samples,
    });
    assert.equal(raw.byteLength, 968);

    // Also verify subarray with non-zero byteOffset works identically
    const padded = new Uint8Array(raw.byteLength + 12);
    padded.set(raw, 7);
    const slice = padded.subarray(7, 7 + raw.byteLength);

    const decoded = decodeVoiceV2Pcm16Payload(slice);
    assert.ok(decoded);
    assert.equal(decoded.codec, "pcm24");
    assert.equal(decoded.sampleRate, 24000);
    assert.equal(decoded.sampleRateKhz, 24);
    assert.equal(decoded.rms, 8485);
    assert.equal(decoded.tsSamples, 9600);
    assert.ok(decoded.float32 instanceof Float32Array);
    assert.equal(decoded.float32.length, 480);
    assert.equal(decoded.float32[0], -1);
    assert.equal(decoded.float32[1], 0);
    assert.equal(decoded.float32[2], 0.5);
    assert.ok(Math.abs(decoded.float32[3] - 32767 / 32768) < 1e-6);
    assert.ok(Math.abs(decoded.float32[25] - samples[25] / 32768) < 1e-6);
  });

  it("classifies 48 kHz and 16 kHz payloads and clamps sampleRateKhz to 8..48 (default 24)", () => {
    const pcm48 = decodeVoiceV2Pcm16Payload(
      buildV2Pcm16Payload({ sampleRateKhz: 48, samples: new Int16Array([1024, -1024]) })
    );
    assert.equal(pcm48.codec, "pcm48");
    assert.equal(pcm48.sampleRate, 48000);
    assert.equal(pcm48.sampleRateKhz, 48);

    const pcm16 = decodeVoiceV2Pcm16Payload(
      buildV2Pcm16Payload({ sampleRateKhz: 16, samples: new Int16Array([2048, -2048]) })
    );
    assert.equal(pcm16.codec, "pcm16");
    assert.equal(pcm16.sampleRate, 16000);
    assert.equal(pcm16.sampleRateKhz, 16);

    const defaultRate = decodeVoiceV2Pcm16Payload(
      buildV2Pcm16Payload({ sampleRateKhz: 0, samples: new Int16Array([512]) })
    );
    assert.equal(defaultRate.codec, "pcm24");
    assert.equal(defaultRate.sampleRate, 24000);

    const clampedLow = decodeVoiceV2Pcm16Payload(
      buildV2Pcm16Payload({ sampleRateKhz: 4, samples: new Int16Array([512]) })
    );
    assert.equal(clampedLow.codec, "pcm16");
    assert.equal(clampedLow.sampleRate, 8000);

    const clampedHigh = decodeVoiceV2Pcm16Payload(
      buildV2Pcm16Payload({ sampleRateKhz: 96, samples: new Int16Array([512]) })
    );
    assert.equal(clampedHigh.codec, "pcm48");
    assert.equal(clampedHigh.sampleRate, 48000);
  });

  it("rejects invalid codecId, truncated buffers, and empty PCM payloads", () => {
    assert.equal(decodeVoiceV2Pcm16Payload(null), null);
    assert.equal(decodeVoiceV2Pcm16Payload(undefined), null);
    assert.equal(decodeVoiceV2Pcm16Payload(new Uint8Array(0)), null);
    assert.equal(decodeVoiceV2Pcm16Payload(new Uint8Array(VOICE_V2_HEADER_BYTES - 1)), null);

    // Header only (0 PCM bytes)
    assert.equal(
      decodeVoiceV2Pcm16Payload(buildV2Pcm16Payload({ samples: new Int16Array(0) })),
      null
    );

    // Header + 1 odd byte (0 complete Int16 samples)
    assert.equal(
      decodeVoiceV2Pcm16Payload(buildV2Pcm16Payload({ samples: new Int16Array(0), extraTailBytes: 1 })),
      null
    );

    // Wrong codecId (Opus 48k or unknown)
    assert.equal(
      decodeVoiceV2Pcm16Payload(
        buildV2Pcm16Payload({ codecId: VOICE_V2_CODEC_OPUS48, samples: new Int16Array(10) })
      ),
      null
    );
    assert.equal(
      decodeVoiceV2Pcm16Payload(buildV2Pcm16Payload({ codecId: 99, samples: new Int16Array(10) })),
      null
    );
  });
});

describe("Voice V2 Lossless PCM16 — formatVoiceCodecLabel", () => {
  it("formats short, pill, and verbose labels across opus48, pcm48, pcm24, pcm16, adpcm16", () => {
    assert.equal(formatVoiceCodecLabel("opus48"), "OPUS 48K");
    assert.equal(formatVoiceCodecLabel("pcm48"), "PCM 48K");
    assert.equal(formatVoiceCodecLabel("pcm24"), "PCM 24K");
    assert.equal(formatVoiceCodecLabel("pcm16"), "PCM 16K");
    assert.equal(formatVoiceCodecLabel("adpcm16"), "ADPCM 16K");
    assert.equal(formatVoiceCodecLabel(""), "ADPCM 16K");

    assert.equal(formatVoiceCodecLabel("opus48", { pill: true }), "opus 48k");
    assert.equal(formatVoiceCodecLabel("pcm48", { pill: true }), "pcm 48k");
    assert.equal(formatVoiceCodecLabel("pcm24", { pill: true }), "pcm 24k");
    assert.equal(formatVoiceCodecLabel("pcm16", { pill: true }), "pcm 16k");
    assert.equal(formatVoiceCodecLabel("adpcm16", { pill: true }), "adpcm 16k");

    assert.equal(
      formatVoiceCodecLabel("opus48", { verbose: true }),
      "48 kHz Opus · 96 kbps (V2)"
    );
    assert.equal(
      formatVoiceCodecLabel("opus48", { verbose: true, isRelayed: true }),
      "48 kHz Opus · 48 kbps (V2)"
    );
    assert.equal(
      formatVoiceCodecLabel("opus48", { verbose: true, opusBitrateKbps: 128 }),
      "48 kHz Opus · 128 kbps (V2)"
    );
    assert.equal(
      formatVoiceCodecLabel("pcm48", { verbose: true }),
      "48 kHz Lossless PCM (V2)"
    );
    assert.equal(
      formatVoiceCodecLabel("pcm24", { verbose: true }),
      "24 kHz Lossless PCM (V2)"
    );
    assert.equal(
      formatVoiceCodecLabel("pcm16", { verbose: true }),
      "16 kHz Lossless PCM (V2)"
    );
    assert.equal(
      formatVoiceCodecLabel("adpcm16", { verbose: true }),
      "16 kHz IMA-ADPCM (V1)"
    );
  });
});

describe("Voice V2 Lossless PCM16 — runtime handling & UI codec display", () => {
  it("routes incoming V2 PCM24 packets to mixer without flipping bot TX codec to opus48", () => {
    const app = new P2PDirectApp();
    const botId = "peer-assist-bot";
    app.voice.inVoice = true;
    app.voice.opusSupported = true;
    app.voice.audioCtx = {};
    app.status = {
      peerId: "peer-self",
      authorName: "Alice",
      peers: [
        {
          peerId: botId,
          authorName: "Assist Bot",
          isBot: true,
          inVoice: true,
          voiceMuted: false,
          safetyCode: "1234",
        },
      ],
      pendingAutoMesh: [],
    };
    app.el = {
      "peer-list": createMockEl(),
      "topology-inspector": createMockEl(),
    };
    app.topo.selectedId = botId;

    const samples = new Int16Array(480);
    samples[0] = 16384;
    const plain1 = buildV2Pcm16Payload({ sampleRateKhz: 24, rms: 4200, tsSamples: 480, samples });
    const plain2 = buildV2Pcm16Payload({ sampleRateKhz: 24, rms: 4500, tsSamples: 1920, samples });
    const payloads = [plain1, plain2];
    let openCalls = 0;

    app.wasm = {
      openVoiceRaw: () => payloads[openCalls++],
    };

    const mixer = {
      codec: "adpcm16",
      muted: false,
      volume: 1,
      rms: 0,
      peakRms: 0,
      packetsReceived: 0,
      decodedFrames: 0,
      lostFrames: 0,
      decodeErrors: 0,
      lastTsSamples: null,
      lastTsAt: 0,
      lastPktBytes: 0,
      lastAudioAt: 0,
      rxWindow: [],
    };
    app.voice.peerMixers.set(botId, mixer);
    app.ensurePeerVoiceMixer = () => mixer;

    const pushed = [];
    app._pushDecodedPcmToMixer = (m, float32, sampleRate, isRelayed) => {
      pushed.push({ codec: m.codec, len: float32.length, first: float32[0], sampleRate, isRelayed });
    };

    const wireV2 = new Uint8Array(990);
    wireV2[0] = 0x56; // 'V'
    wireV2[1] = 0x32; // '2'

    app.handleIncomingVoicePacket(botId, wireV2);
    app.handleIncomingVoicePacket(botId, wireV2);

    // Directionality invariant: bot TX codec stays adpcm16 so browser mic still sends 16 kHz V1 ADPCM
    assert.equal(app.peerVoiceCodec.has(botId), false);
    assert.equal(app.getPeerVoiceCodec(botId), "adpcm16");

    // Mixer updated with live PCM24 state, stats, and lost-frame tracking (480 -> 1920 = 2 lost 480-sample frames)
    assert.equal(mixer.codec, "pcm24");
    assert.equal(mixer.rms, 4500);
    assert.equal(mixer.packetsReceived, 2);
    assert.equal(mixer.decodedFrames, 2);
    assert.equal(mixer.lostFrames, 2);
    assert.equal(mixer.lastTsSamples, 1920);

    // AudioWorklet feeder received 24 kHz Float32 frames
    assert.equal(pushed.length, 2);
    assert.equal(pushed[0].sampleRate, 24000);
    assert.equal(pushed[0].len, 480);
    assert.equal(pushed[0].first, 0.5);

    // Live UI surfaces reflect PCM 24K instead of ADPCM 16K
    assert.match(app.el["peer-list"].innerHTML, />pcm 24k</);
    assert.match(app.el["topology-inspector"].innerHTML, /24 kHz Lossless PCM \(V2\)/);
    const advHtml = app._buildPeerVoiceAdvStatsHtml(app.status.peers[0], mixer, false, performance.now());
    assert.match(advHtml, />PCM 24K</);
  });

  it("still records opus48 capability when a V2 Opus packet arrives", () => {
    const app = new P2PDirectApp();
    const humanId = "peer-human";
    app.voice.inVoice = true;
    app.voice.opusSupported = true;
    app.voice.deafened = true; // skip WebCodecs AudioDecoder instantiation in Node
    app.status = { peerId: "peer-self", authorName: "Alice", peers: [] };

    const opusPlain = new Uint8Array(VOICE_V2_HEADER_BYTES + 12);
    opusPlain[0] = VOICE_V2_CODEC_OPUS48;
    opusPlain[1] = 48;
    app.wasm = { openVoiceRaw: () => opusPlain };

    const mixer = {
      codec: "adpcm16",
      muted: false,
      volume: 1,
      rms: 0,
      peakRms: 0,
      packetsReceived: 0,
      decodedFrames: 0,
      lostFrames: 0,
      decodeErrors: 0,
      lastTsSamples: null,
      lastTsAt: 0,
      lastPktBytes: 0,
      lastAudioAt: 0,
      rxWindow: [],
    };
    app.ensurePeerVoiceMixer = () => mixer;

    const wireV2 = new Uint8Array(40);
    wireV2[0] = 0x56;
    wireV2[1] = 0x32;
    app.handleIncomingVoicePacket(humanId, wireV2);

    assert.equal(app.peerVoiceCodec.get(humanId), "opus48");
    assert.equal(mixer.codec, "opus48");
  });
});

describe("Voice V2 Lossless PCM16 — app.js static invariants", () => {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");

  it("advertises v2pcm: true alongside every vcodec: this.getLocalVoiceCodec() signal", () => {
    const matches = [...src.matchAll(/vcodec:\s*this\.getLocalVoiceCodec\(\),[\r\n]+\s*v2pcm:\s*true,/g)];
    const allVcodec = [...src.matchAll(/vcodec:\s*this\.getLocalVoiceCodec\(\)/g)];
    assert.ok(allVcodec.length >= 6, `Expected >= 6 signaling sites, found ${allVcodec.length}`);
    assert.equal(
      matches.length,
      allVcodec.length,
      "Every signaling message emitting vcodec must also advertise v2pcm: true"
    );
  });

  it("never calls recordPeerVoiceCodec(peerId, \"opus48\") before checking plain[0] in handleIncomingVoicePacket", () => {
    const startIdx = src.indexOf("handleIncomingVoicePacket(peerId, rawData)");
    const endIdx = src.indexOf("toggleVoiceMute()", startIdx);
    assert.ok(startIdx > 0 && endIdx > startIdx, "Could not locate handleIncomingVoicePacket");
    const fnBody = src.slice(startIdx, endIdx);

    const openIdx = fnBody.indexOf("this.wasm.openVoiceRaw(peerId, pktBytes)");
    const pcmIdx = fnBody.indexOf("VOICE_V2_CODEC_PCM16");
    const opusCheckIdx = fnBody.indexOf("VOICE_V2_CODEC_OPUS48");
    const recordOpusIdx = fnBody.indexOf('this.recordPeerVoiceCodec(peerId, "opus48")');

    assert.ok(openIdx > 0, "Expected openVoiceRaw inside handleIncomingVoicePacket");
    assert.ok(pcmIdx > openIdx, "Expected VOICE_V2_CODEC_PCM16 check after openVoiceRaw");
    assert.ok(opusCheckIdx > pcmIdx, "Expected VOICE_V2_CODEC_OPUS48 check after PCM16 branch");
    assert.ok(
      recordOpusIdx > opusCheckIdx,
      "recordPeerVoiceCodec(peerId, \"opus48\") must ONLY run after verifying VOICE_V2_CODEC_OPUS48"
    );
  });
});
