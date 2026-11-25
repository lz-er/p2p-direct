#!/usr/bin/env node
/**
 * Self-Hostable Voice Music Bot for p2p-direct (`voice.dequ.org`).
 *
 * Commands in room chat:
 *   !join                 — Join the room's E2EE voice channel
 *   !leave                — Stop playback and leave voice channel
 *   !play <file-or-url>   — Queue & stream any audio file or stream URL via ffmpeg
 *   !demo                 — Play a built-in synth chime melody (requires zero external files or ffmpeg)
 *   !pause / !resume      — Pause or resume playback
 *   !skip / !stop         — Skip track or clear queue
 *   !np / !queue          — Show interactive Now Playing control card
 *
 * Usage:
 *   node bot/examples/music-bot.mjs --room "https://voice.dequ.org/#room=P2P1:..."
 */

import path from "node:path";
import { P2PBot } from "../sdk.mjs";
import { parseCliArgs } from "../bridge.mjs";

const DEMO_MELODY = [
  { freqHz: 261.63, durationMs: 260 }, // C4
  { freqHz: 329.63, durationMs: 260 }, // E4
  { freqHz: 392.0, durationMs: 260 }, // G4
  { freqHz: 523.25, durationMs: 420 }, // C5
  { freqHz: 392.0, durationMs: 220 }, // G4
  { freqHz: 440.0, durationMs: 260 }, // A4
  { freqHz: 523.25, durationMs: 600 }, // C5
];

const args = parseCliArgs(process.argv.slice(2));
if (!args.room || args.help) {
  console.log('Usage: node bot/examples/music-bot.mjs --room "<room-invite-url>" [--passphrase "..."]');
  process.exit(args.help ? 0 : 1);
}

const bot = new P2PBot({
  roomLink: args.room,
  passphrase: args.passphrase,
  name: args.name === "P2PBot" ? "Signal Jukebox" : args.name,
  relay: args.relay || undefined,
});

const queue = [];
let currentTrack = null; // { title, source, isDemo, requestedBy }
let paused = false;
let controlMsgId = null;

function buildPlayerCard() {
  const statusBadge = !bot.inVoice
    ? "OFFLINE"
    : !currentTrack
      ? "IDLE"
      : paused
        ? "PAUSED"
        : "PLAYING";
  const color = !currentTrack ? "cobalt" : paused ? "ochre" : "mint";

  const fields = [
    {
      label: "Now Playing",
      value: currentTrack ? `**${currentTrack.title}**` : "Nothing playing — send `!play <path/url>` or `!demo`",
      inline: false,
    },
    {
      label: "Voice Channel",
      value: bot.inVoice ? "Connected (16 kHz E2EE)" : "Not in voice",
      inline: true,
    },
    {
      label: "Queue",
      value: queue.length === 0 ? "Empty" : `${queue.length} track(s) waiting`,
      inline: true,
    },
  ];
  if (currentTrack?.requestedBy) {
    fields.push({ label: "Requested By", value: currentTrack.requestedBy, inline: true });
  }

  return {
    subtitle: "VOICE MUSIC BOT",
    title: "Signal Jukebox",
    badge: statusBadge,
    color,
    text: "Control playback directly with the buttons below or type `!play <file/url>` / `!demo`.",
    fields,
    buttons: [
      [
        {
          id: paused ? "music:resume" : "music:pause",
          label: paused ? "Resume" : "Pause",
          style: paused ? "success" : "warning",
          disabled: !currentTrack,
        },
        { id: "music:skip", label: "Skip", style: "secondary", disabled: !currentTrack },
        { id: "music:stop", label: "Stop", style: "danger", disabled: !currentTrack && queue.length === 0 },
        { id: "music:demo", label: "Play Demo", style: "primary" },
      ],
      [
        {
          id: bot.inVoice ? "music:leave" : "music:join",
          label: bot.inVoice ? "Leave Voice" : "Join Voice",
          style: "secondary",
        },
        { id: "music:delete", label: "Dismiss", style: "secondary" },
      ],
    ],
    footer: "Powered by p2p-direct Bot SDK · 100% E2EE",
  };
}

function syncPlayerCard(createIfMissing = false) {
  const card = buildPlayerCard();
  if (controlMsgId) {
    bot.updateBotMessage(controlMsgId, card);
  } else if (createIfMissing) {
    const sent = bot.sendBotMessage(card);
    controlMsgId = sent.id;
  }
}

function startNextTrack() {
  if (queue.length === 0) {
    currentTrack = null;
    paused = false;
    syncPlayerCard(false);
    return;
  }
  const next = queue.shift();
  currentTrack = next;
  paused = false;
  if (!bot.inVoice) {
    bot.joinVoice({ muted: false });
  }
  if (next.isDemo) {
    bot.playMelody(DEMO_MELODY, { amplitude: 0.28 });
  } else {
    bot.playAudioFile(next.source, { gain: 0.9 });
  }
  syncPlayerCard(true);
}

bot.on("audioEnd", () => {
  if (currentTrack) {
    startNextTrack();
  }
});

bot.on("ready", (info) => {
  console.log(`[music-bot] Online as "${info.authorName}" (${info.peerId}) in room "${info.room}"`);
  console.log("[music-bot] Type !demo, !play <file-or-url>, !join, !leave, or !np in chat.");
});

bot.on("message", (msg) => {
  if (msg.type !== "chat" || !msg.payload || typeof msg.payload.text !== "string") return;
  const text = msg.payload.text.trim();
  const lower = text.toLowerCase();

  if (lower === "!join") {
    bot.joinVoice({ muted: false });
    syncPlayerCard(true);
  } else if (lower === "!leave") {
    queue.length = 0;
    currentTrack = null;
    paused = false;
    bot.leaveVoice();
    syncPlayerCard(false);
  } else if (lower === "!demo") {
    queue.push({ title: "Signal Blocks Synth Chime (Demo)", isDemo: true, requestedBy: msg.authorName });
    if (!currentTrack) {
      startNextTrack();
    } else {
      syncPlayerCard(true);
    }
  } else if (lower.startsWith("!play ")) {
    const src = text.slice(6).trim();
    if (!src) return;
    const title = /^https?:\/\//i.test(src) ? src : path.basename(src);
    queue.push({ title, source: src, isDemo: false, requestedBy: msg.authorName });
    if (!currentTrack) {
      startNextTrack();
    } else {
      syncPlayerCard(true);
    }
  } else if (lower === "!pause" && currentTrack) {
    paused = true;
    bot.pauseAudio();
    syncPlayerCard(true);
  } else if (lower === "!resume" && currentTrack) {
    paused = false;
    bot.resumeAudio();
    syncPlayerCard(true);
  } else if (lower === "!skip" && currentTrack) {
    bot.stopAudio();
    startNextTrack();
  } else if (lower === "!stop") {
    queue.length = 0;
    currentTrack = null;
    paused = false;
    bot.stopAudio();
    syncPlayerCard(false);
  } else if (lower === "!np" || lower === "!queue" || lower === "!music") {
    controlMsgId = null;
    syncPlayerCard(true);
  }
});

bot.on("interaction", (ev) => {
  if (ev.mode !== "action") return;
  if (ev.actionId === "music:pause" && currentTrack) {
    paused = true;
    bot.pauseAudio();
    syncPlayerCard(false);
  } else if (ev.actionId === "music:resume" && currentTrack) {
    paused = false;
    bot.resumeAudio();
    syncPlayerCard(false);
  } else if (ev.actionId === "music:skip") {
    bot.stopAudio();
    startNextTrack();
  } else if (ev.actionId === "music:stop") {
    queue.length = 0;
    currentTrack = null;
    paused = false;
    bot.stopAudio();
    syncPlayerCard(false);
  } else if (ev.actionId === "music:demo") {
    queue.push({ title: "Signal Blocks Synth Chime (Demo)", isDemo: true, requestedBy: ev.fromName });
    if (!currentTrack) {
      startNextTrack();
    } else {
      syncPlayerCard(false);
    }
  } else if (ev.actionId === "music:join") {
    bot.joinVoice({ muted: false });
    syncPlayerCard(false);
  } else if (ev.actionId === "music:leave") {
    queue.length = 0;
    currentTrack = null;
    paused = false;
    bot.leaveVoice();
    syncPlayerCard(false);
  } else if (ev.actionId === "music:delete") {
    if (ev.messageId) {
      bot.deleteMessage(ev.messageId);
      if (controlMsgId === ev.messageId) controlMsgId = null;
    }
  }
});

bot.on("messageDelete", ({ targetId }) => {
  if (controlMsgId === targetId) {
    controlMsgId = null;
  }
});

bot.connect().catch((err) => {
  console.error("[music-bot] Failed:", err.message);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await bot.disconnect();
  process.exit(0);
});
