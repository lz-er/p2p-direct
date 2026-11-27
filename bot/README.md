# p2p-direct Self-Hostable Bot SDK & Local Bridge

Connect self-hosted bots (music bots, Warframe worldstate bots, Discord bridges, polls, soundboards) directly to any **`voice.dequ.org`** room as an ordinary end-to-end encrypted WebRTC peer.

- **Zero servers, zero permissions, zero roles**: a bot joins with the exact same room link (and optional passphrase) as human users.
- **100% shared Rust WASM E2EE engine**: `bot/sdk.mjs` loads `../p2p_mesh.wasm` directly, so every message, button click, deletion tombstone, and 16 kHz voice packet uses identical X25519 + ChaCha20-Poly1305 encryption.
- **Two ways to host**:
  1. **Direct Node.js SDK** (`bot/sdk.mjs`): write bots directly in JavaScript/TypeScript.
  2. **Local WebSocket Bridge** (`bot/bridge.mjs`): run the bridge on `127.0.0.1:8765` and connect bots written in **Python, Rust, Go, C#, or any language** using simple JSON commands + raw binary 16 kHz PCM frames.

## Quick Start

Requires **Node.js 22+**.

```bash
cd bot
npm install
```

### Run the included example bots

```bash
# Warframe Worldstate Bot (!wf, !cetus, !fissures, !sortie, !baro + interactive buttons)
node examples/warframe-bot.mjs --room "https://voice.dequ.org/#room=P2P1:..."

# Voice Music Bot (!demo, !play <file-or-url>, !join, !leave + interactive player buttons)
node examples/music-bot.mjs --room "https://voice.dequ.org/#room=P2P1:..."

# Local WebSocket Bridge (for Python / Rust / Go / Discord bridge bots)
node bridge.mjs --room "https://voice.dequ.org/#room=P2P1:..." --name "MyBot" --port 8765
```

For passphrase-protected rooms, add `--passphrase "your-secret"` (or set `P2P_PASSPHRASE`).

## Writing a Bot in Node.js (`bot/sdk.mjs`)

```js
import { P2PBot } from "./sdk.mjs";

const bot = new P2PBot({
  roomLink: process.env.P2P_ROOM,
  passphrase: process.env.P2P_PASSPHRASE, // optional
  name: "MyBot",
});

bot.on("message", (msg) => {
  if (msg.type === "chat" && msg.payload?.text === "!ping") {
    bot.sendBotMessage({
      subtitle: "STATUS",
      title: "Pong!",
      badge: "ONLINE",
      color: "mint", // cobalt | mint | ochre | coral | cyan | ink
      text: "Click a button below:",
      fields: [{ label: "Peers", value: String(bot.getPeers().length), inline: true }],
      buttons: [
        [
          { id: "refresh", label: "Refresh", style: "primary" }, // silent callback -> triggers "interaction"
          { id: "hi", label: "Say Hi", style: "success", mode: "reply", replyText: "Hello bot!" }, // posts visible chat answer
          { id: "del", label: "Delete", style: "danger" },
        ],
      ],
      footer: "Self-hosted with p2p-direct Bot SDK",
    });
  }
});

bot.on("interaction", (ev) => {
  if (ev.actionId === "del") {
    bot.deleteMessage(ev.messageId);
  } else if (ev.actionId === "refresh") {
    bot.updateBotMessage(ev.messageId, {
      title: "Refreshed!",
      badge: "UPDATED",
      color: "cobalt",
      text: `Updated by **${ev.fromName}** at ${new Date().toISOString()}`,
    });
  }
});

await bot.connect();
```

### Voice Channel Streaming

```js
bot.joinVoice();
bot.playAudioFile("./track.mp3"); // requires ffmpeg on PATH -> streams 16 kHz mono E2EE audio
// Or stream raw 16 kHz mono signed 16-bit little-endian PCM directly:
bot.pushPcmBytes(pcmBuffer);
// Or play a built-in synth chime (no ffmpeg needed):
bot.playTone({ freqHz: 440, durationMs: 1000 });
// Listen to voice audio from users:
bot.on("voiceAudio", ({ peerId, rms, pcm }) => { /* Int16Array @ 16 kHz */ });
```

## Local WebSocket Bridge Protocol (`bot/bridge.mjs`)

Start in standby mode (`node bridge.mjs --port 8765`, no `--room` required) or pre-connected with `--room`, then connect any WebSocket client to `ws://127.0.0.1:8765`:

- **Events received (JSON)**: `ready`, `room_state`, `message`, `message_update`, `message_delete`, `interaction`, `peer_join`, `peer_leave`, `voice_state`, `audio_start`, `audio_end`, `voice_audio` (opt-in), `reply`.
- **Mixed inbound voice audio (binary WebSocket frames, server -> client)**: send `subscribe_mixed_audio { enabled: true }` to receive continuous silence-gap-filled 20 ms 16 kHz mono `Int16LE` PCM frames (640 bytes each) with automatic TTS echo suppression and speaker locking (`lock_speaker` / `unlock_speaker`).
- **Commands sent (JSON text frame)**: `connect_room`, `disconnect_room`, `send_text`, `send_bot_message`, `update_bot_message`, `edit_message`, `delete_message`, `get_raw_log`, `join_voice`, `leave_voice`, `set_voice_muted`, `set_audio_gain`, `set_pcm_input_format`, `mark_audio_stream_end`, `play_audio_file`, `play_tone`, `play_chime`, `pause_audio`, `resume_audio`, `stop_audio`, `subscribe_voice_audio`, `subscribe_mixed_audio`, `lock_speaker`, `unlock_speaker`, `set_allowed_speakers`, `get_status`.
- **Outbound audio streaming (binary WebSocket frames, client -> server)**: send raw `Int16LE` PCM bytes (default 16 kHz mono, or call `set_pcm_input_format { sampleRate, channels }` for e.g. 22050/24000 Hz TTS); the bridge resamples, paces, and E2EE-encrypts them into the room's voice channel automatically.

## Home Assistant Voice Assistant (`bot/ha-assistant.mjs`)

Exposes a full **Wyoming Voice Satellite** (`:10700`), watches a Home Assistant `input_text` room-link helper, and serves an Ingress-ready Flat Metro **Control Panel** (`:8787`):

```bash
node ha-assistant.mjs \
  --ha-url "http://homeassistant.local:8123" \
  --ha-token "<LONG_LIVED_ACCESS_TOKEN>" \
  --room-helper "input_text.p2p_voice_room_link" \
  --wyoming-port 10700 \
  --ui-port 8787
```

- Add **Settings → Devices & Services → Add Integration → Wyoming Protocol** pointing at `<host>:10700`.
- Paste any `https://voice.dequ.org/#room=P2P1:...` invite link into `input_text.p2p_voice_room_link` (or the Control Panel UI) and the assistant joins voice immediately with both **wake-word activation**, **button activation** (`Listen Now`), **LLM/entity control**, and **live ticking Flat Metro timer cards** (`{ type: "timer" }`).

