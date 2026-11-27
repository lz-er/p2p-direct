import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.__P2P_NO_AUTO_BOOT__ = true;
const {
  P2PDirectApp,
  sanitizeBotVoiceControls,
  extractPeerVoiceControls,
  buildVoiceControlsSignature,
  renderVoiceBotControlsHtml,
} = await import("../app.js");

function createMockClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...cls) => cls.forEach((c) => set.add(c)),
    remove: (...cls) => cls.forEach((c) => set.delete(c)),
    toggle: (cls, force) => {
      if (force === undefined) {
        if (set.has(cls)) {
          set.delete(cls);
          return false;
        }
        set.add(cls);
        return true;
      }
      if (force) set.add(cls);
      else set.delete(cls);
      return Boolean(force);
    },
    contains: (cls) => set.has(cls),
  };
}

function createMockElement() {
  let _innerHtml = "";
  const listeners = new Map();
  return {
    classList: createMockClassList(),
    className: "",
    textContent: "",
    dataset: {},
    innerHTMLSetCount: 0,
    get innerHTML() {
      return _innerHtml;
    },
    set innerHTML(val) {
      _innerHtml = String(val ?? "");
      this.innerHTMLSetCount += 1;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchClick(target) {
      for (const fn of listeners.get("click") || []) {
        fn({ target });
      }
    },
  };
}

function createTestApp({ inVoice = true, peers = [], logMessages = [], statusMessages = null } = {}) {
  const app = new P2PDirectApp();
  app.el = {
    "voice-panel": createMockElement(),
    "voice-status-badge": createMockElement(),
    "voice-join-card": createMockElement(),
    "voice-participant-list": createMockElement(),
    "voice-join-hint": createMockElement(),
    "voice-packet-stats": createMockElement(),
  };
  app.voice.inVoice = inVoice;
  app.status = {
    peerId: "self-peer",
    authorName: "Leo",
    peers,
    stats: { voicePacketsSent: 0, voicePacketsReceived: 0 },
    ...(statusMessages !== null ? { messages: statusMessages } : {}),
  };
  app.logMessages = logMessages;
  return app;
}

describe("Voice-Channel Bot Controls — sanitization & extraction", () => {
  it("sanitizes valid HA voiceControls, strips emojis, validates icons, and caps buttons to 4", () => {
    const clean = sanitizeBotVoiceControls({
      status: "🎤 Hey Jarvis 🚀",
      statusIcon: "mic",
      statusTone: "cobalt",
      buttons: [
        null,
        { id: "ha:listen", label: "Listen Now", icon: "mic", style: "primary", disabled: false },
        { id: "ha:toggle_wake", label: "⚡ Wake: On", icon: "bolt", style: "success" },
        { id: "ha:stop_audio", label: "Stop", icon: "close", style: "secondary" },
        {
          id: "ha:ask",
          label: "Quick Ask",
          icon: "not-a-real-icon",
          style: "unknown-style",
          mode: "reply",
          replyText: "Turn on living room lights",
          url: "javascript:alert(1)",
        },
        { id: "ha:fifth", label: "Overflow 5th", icon: "check", style: "danger" },
      ],
    });

    assert.ok(clean);
    assert.equal(clean.status, "Hey Jarvis");
    assert.equal(clean.statusIcon, "mic");
    assert.equal(clean.statusTone, "cobalt");
    assert.equal(clean.buttons.length, 4);
    assert.equal(clean.buttons[0].id, "ha:listen");
    assert.equal(clean.buttons[0].style, "primary");
    assert.equal(clean.buttons[0].mode, "action");
    assert.equal(clean.buttons[1].label, "Wake: On");
    assert.equal(clean.buttons[1].icon, "bolt");
    assert.equal(clean.buttons[1].style, "success");
    assert.equal(clean.buttons[3].id, "ha:ask");
    assert.equal(clean.buttons[3].icon, "");
    assert.equal(clean.buttons[3].style, "secondary");
    assert.equal(clean.buttons[3].mode, "reply");
    assert.equal(clean.buttons[3].replyText, "Turn on living room lights");
    assert.equal(clean.buttons[3].url, undefined);
  });

  it("rejects empty/invalid voiceControls and invalid icon names cleanly", () => {
    assert.equal(sanitizeBotVoiceControls(null), null);
    assert.equal(sanitizeBotVoiceControls([]), null);
    assert.equal(sanitizeBotVoiceControls({ status: "   ", buttons: [] }), null);
    assert.equal(sanitizeBotVoiceControls({ buttons: [null, {}] }), null);

    const unknownIcon = sanitizeBotVoiceControls({
      status: "Now Playing",
      statusIcon: "music",
      statusTone: "neon-invalid",
    });
    assert.ok(unknownIcon);
    assert.equal(unknownIcon.status, "Now Playing");
    assert.equal(unknownIcon.statusIcon, "");
    assert.equal(unknownIcon.statusTone, "cobalt");
  });

  it("extracts latest non-deleted bot voiceControls for both `bot` and `bot_message` card shapes", () => {
    const messages = [
      {
        id: "m1",
        type: "bot",
        author: "bot-ha",
        payload: {
          title: "HA",
          voiceControls: { status: "Old Wake", statusIcon: "mic", statusTone: "ink" },
        },
      },
      {
        id: "m2",
        type: "bot_message",
        author: "bot-ha",
        payload: {
          card: {
            voiceControls: {
              status: "Hey Jarvis",
              statusIcon: "bolt",
              statusTone: "mint",
              buttons: [{ id: "ha:listen", label: "Listen Now", icon: "mic", style: "primary" }],
            },
          },
        },
      },
      {
        id: "m3",
        type: "bot",
        author: "bot-other",
        payload: { voiceControls: { status: "Other Bot", statusTone: "coral" } },
      },
      {
        id: "m4",
        type: "bot",
        author: "bot-ha",
        deleted: true,
        payload: { voiceControls: { status: "Deleted Card", statusTone: "coral" } },
      },
      {
        id: "m5",
        type: "bot",
        author: "bot-ha",
        payload: { title: "Announcement without voiceControls" },
      },
      {
        id: "m6",
        type: "bot",
        author: "bot-ha",
        payload: { voiceControls: { status: "Tombstoned Card" } },
      },
      {
        id: "del-m6",
        type: "msg-delete",
        author: "bot-ha",
        payload: { targetId: "m6" },
      },
    ];

    const vc = extractPeerVoiceControls(messages, "bot-ha");
    assert.ok(vc);
    assert.equal(vc.messageId, "m2");
    assert.equal(vc.status, "Hey Jarvis");
    assert.equal(vc.statusIcon, "bolt");
    assert.equal(vc.statusTone, "mint");
    assert.equal(vc.buttons.length, 1);
    assert.equal(vc.buttons[0].id, "ha:listen");

    assert.equal(extractPeerVoiceControls(messages, "human-1"), null);
  });

  it("changes buildVoiceControlsSignature when wake word, tone, button label, or disabled flips", () => {
    const base = {
      messageId: "ha-1",
      status: "Hey Jarvis",
      statusIcon: "bolt",
      statusTone: "cobalt",
      buttons: [
        { id: "ha:listen", label: "Listen Now", icon: "mic", style: "primary", disabled: false, active: false, mode: "action" },
        { id: "ha:toggle_wake", label: "Wake: On", icon: "bolt", style: "success", disabled: false, active: false, mode: "action" },
      ],
    };
    const sigBase = buildVoiceControlsSignature(base);
    assert.equal(sigBase, buildVoiceControlsSignature({ ...base, buttons: base.buttons.map((b) => ({ ...b })) }));

    assert.notEqual(sigBase, buildVoiceControlsSignature({ ...base, status: "Listening..." }));
    assert.notEqual(sigBase, buildVoiceControlsSignature({ ...base, statusTone: "mint" }));
    assert.notEqual(
      sigBase,
      buildVoiceControlsSignature({
        ...base,
        buttons: [{ ...base.buttons[0], disabled: true }, base.buttons[1]],
      })
    );
    assert.notEqual(
      sigBase,
      buildVoiceControlsSignature({
        ...base,
        buttons: [base.buttons[0], { ...base.buttons[1], label: "Wake: Off", style: "secondary" }],
      })
    );
  });

  it("renders XSS-safe Flat Metro HTML with SVG icons, zero emojis, and data attributes", () => {
    const vc = sanitizeBotVoiceControls({
      status: '<img src=x onerror=alert(1)> Hey Jarvis 🎤',
      statusIcon: "mic",
      statusTone: "mint",
      buttons: [
        { id: 'ha:"listen"', label: "<b>Listen</b>", icon: "mic", style: "primary", disabled: true },
      ],
    });
    const html = renderVoiceBotControlsHtml('peer<"1">', { messageId: 'msg<"1">', ...vc });

    assert.doesNotMatch(html, /<img\b/i);
    assert.doesNotMatch(html, /<b>/i);
    assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
    assert.match(html, /class="voice-bot-status is-tone-mint"/);
    assert.match(html, /<svg class="voice-bot-svg"/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; Hey Jarvis/);
    assert.match(html, /data-voice-bot-msg-id="msg&lt;&quot;1&quot;&gt;"/);
    assert.match(html, /data-voice-bot-action-id="ha:&quot;listen&quot;"/);
    assert.match(html, /data-voice-bot-peer-id="peer&lt;&quot;1&quot;&gt;"/);
    assert.match(html, /disabled>/);
  });
});

describe("Voice-Channel Bot Controls — renderVoicePanel & interaction dispatch", () => {
  it("renders voiceControls in both active-call and pre-join preview modes without rebuilding on unchanged ticks", () => {
    const botMsg = {
      id: "ha-card-1",
      type: "bot",
      author: "bot-ha",
      authorName: "Home Assistant",
      payload: {
        title: "Home Assistant",
        voiceControls: {
          status: "Hey Jarvis",
          statusIcon: "bolt",
          statusTone: "cobalt",
          buttons: [
            { id: "ha:listen", label: "Listen Now", icon: "mic", style: "primary", disabled: false },
            { id: "ha:toggle_wake", label: "Wake: On", icon: "bolt", style: "success" },
          ],
        },
      },
    };
    const peers = [{ peerId: "bot-ha", authorName: "Home Assistant", inVoice: true, voiceMuted: false, isBot: true }];

    // 1. Pre-join preview mode (`inVoice: false`) using status.messages fallback
    const previewApp = createTestApp({ inVoice: false, peers, logMessages: [], statusMessages: [botMsg] });
    previewApp.renderVoicePanel();
    const previewList = previewApp.el["voice-participant-list"];
    assert.equal(previewList.innerHTMLSetCount, 1);
    assert.match(previewList.innerHTML, /is-channel-preview/);
    assert.match(previewList.innerHTML, /has-bot-controls/);
    assert.match(previewList.innerHTML, /Hey Jarvis/);
    assert.match(previewList.innerHTML, /data-voice-bot-action-id="ha:listen"/);
    assert.match(previewList.innerHTML, /data-voice-bot-msg-id="ha-card-1"/);

    // 2. Active voice mode (`inVoice: true`) using live logMessages
    const app = createTestApp({ inVoice: true, peers, logMessages: [botMsg] });
    app.renderVoicePanel();
    const listEl = app.el["voice-participant-list"];
    assert.equal(listEl.innerHTMLSetCount, 1);
    assert.match(listEl.innerHTML, /voice-peer-mixer/);
    assert.match(listEl.innerHTML, /Hey Jarvis/);
    assert.match(listEl.innerHTML, /Listen Now/);

    // Re-rendering with no change must NOT rebuild DOM (prevents audio/meter flicker)
    app.renderVoicePanel();
    assert.equal(listEl.innerHTMLSetCount, 1);

    // Updating the bot card (e.g. wake word toggled off & status Listening...) triggers clean rebuild
    app.logMessages = [
      {
        ...botMsg,
        payload: {
          ...botMsg.payload,
          voiceControls: {
            status: "Listening...",
            statusIcon: "mic",
            statusTone: "mint",
            buttons: [
              { id: "ha:listen", label: "Listen Now", icon: "mic", style: "primary", disabled: true },
              { id: "ha:toggle_wake", label: "Wake: Off", icon: "bolt", style: "secondary" },
            ],
          },
        },
      },
    ];
    app.renderVoicePanel();
    assert.equal(listEl.innerHTMLSetCount, 2);
    assert.match(listEl.innerHTML, /is-tone-mint/);
    assert.match(listEl.innerHTML, /Listening\.\.\./);
    assert.match(listEl.innerHTML, /Wake: Off/);
    assert.match(listEl.innerHTML, /data-voice-bot-action-id="ha:listen"[^>]*disabled/);

    // Deleting the bot card removes voiceControls cleanly
    app.logMessages = [];
    app.renderVoicePanel();
    assert.equal(listEl.innerHTMLSetCount, 3);
    assert.doesNotMatch(listEl.innerHTML, /voice-bot-controls/);
  });

  it("dispatches silent action and chat reply clicks identically to chat card buttons and ignores disabled buttons", () => {
    const wasmCalls = [];
    const botMsg = {
      id: "ha-card-9",
      type: "bot",
      author: "bot-ha",
      authorName: "Home Assistant",
      payload: {
        voiceControls: {
          status: "Hey Jarvis",
          statusIcon: "mic",
          statusTone: "cobalt",
          buttons: [
            { id: "ha:listen", label: "Listen Now", icon: "mic", style: "primary", disabled: false },
            {
              id: "ha:reply_cmd",
              label: "Lights On",
              icon: "lamp",
              style: "success",
              mode: "reply",
              replyText: "Turn on desk lamp",
            },
            { id: "ha:disabled_btn", label: "Busy", icon: "close", style: "secondary", disabled: true },
          ],
        },
      },
    };

    const app = createTestApp({
      inVoice: true,
      peers: [{ peerId: "bot-ha", authorName: "Home Assistant", inVoice: true, isBot: true }],
      logMessages: [botMsg],
    });
    app.executeActions = () => {};
    app.renderAll = () => {};
    app.wasm = {
      call(cmd) {
        wasmCalls.push(cmd);
        return { status: app.status, actions: [] };
      },
    };

    // 1. Default silent action callback (`send_bot_action`)
    const actionBtn = {
      disabled: false,
      isConnected: false,
      innerHTML: "Listen Now",
      textContent: "Listen Now",
      classList: createMockClassList(),
      dataset: {
        voiceBotMsgId: "ha-card-9",
        voiceBotActionId: "ha:listen",
        voiceBotPeerId: "bot-ha",
        voiceBotBtnIdx: "0",
      },
    };
    app.handleVoiceBotButtonClick(actionBtn);
    assert.equal(wasmCalls.length, 1);
    assert.equal(wasmCalls[0].cmd, "send_bot_action");
    assert.equal(wasmCalls[0].toPeerId, "bot-ha");
    assert.equal(wasmCalls[0].messageId, "ha-card-9");
    assert.equal(wasmCalls[0].actionId, "ha:listen");
    assert.equal(wasmCalls[0].label, "Listen Now");
    assert.equal(actionBtn.classList.contains("is-sent"), true);

    // 2. Reply-mode button publishes chat reply with `replyTo`
    const replyBtn = {
      disabled: false,
      isConnected: false,
      classList: createMockClassList(),
      dataset: {
        voiceBotMsgId: "ha-card-9",
        voiceBotActionId: "ha:reply_cmd",
        voiceBotPeerId: "bot-ha",
        voiceBotBtnIdx: "1",
      },
    };
    app.handleVoiceBotButtonClick(replyBtn);
    assert.equal(wasmCalls.length, 2);
    assert.equal(wasmCalls[1].cmd, "publish");
    assert.equal(wasmCalls[1].type, "chat");
    assert.equal(wasmCalls[1].payload.text, "Turn on desk lamp");
    assert.equal(wasmCalls[1].payload.replyTo.messageId, "ha-card-9");
    assert.equal(wasmCalls[1].payload.replyTo.botPeerId, "bot-ha");
    assert.equal(wasmCalls[1].payload.replyTo.actionId, "ha:reply_cmd");

    // 3. Disabled button does not dispatch anything
    const disabledBtn = {
      disabled: false, // even if DOM disabled attr were tampered with, sanitized model enforces disabled!
      isConnected: false,
      classList: createMockClassList(),
      dataset: {
        voiceBotMsgId: "ha-card-9",
        voiceBotActionId: "ha:disabled_btn",
        voiceBotPeerId: "bot-ha",
        voiceBotBtnIdx: "2",
      },
    };
    app.handleVoiceBotButtonClick(disabledBtn);
    assert.equal(wasmCalls.length, 2);
  });

  it("refreshes voice panel from renderMessageUpdate when a remote bot in voice updates its card", () => {
    const botMsg = {
      id: "ha-card-2",
      type: "bot",
      author: "bot-ha",
      authorName: "Home Assistant",
      payload: {
        voiceControls: { status: "Hey Jarvis", statusIcon: "bolt", statusTone: "cobalt" },
      },
    };
    const app = createTestApp({
      inVoice: false,
      peers: [{ peerId: "bot-ha", authorName: "Home Assistant", inVoice: true, isBot: true }],
      logMessages: [botMsg],
    });
    app.renderStats = () => {};
    app.renderTypeFilterOptions = () => {};
    app.renderLog = () => {};

    app.renderVoicePanel();
    const listEl = app.el["voice-participant-list"];
    assert.equal(listEl.innerHTMLSetCount, 1);
    assert.match(listEl.innerHTML, /Hey Jarvis/);

    // Unrelated human message arrives -> renderMessageUpdate does NOT rebuild voice panel DOM
    app.logMessages = [
      botMsg,
      { id: "chat-1", type: "chat", author: "self-peer", payload: { text: "hello" } },
    ];
    app.renderMessageUpdate();
    assert.equal(listEl.innerHTMLSetCount, 1);

    // Bot edits its card -> renderMessageUpdate immediately updates voice panel DOM
    app.logMessages = [
      {
        ...botMsg,
        payload: {
          voiceControls: { status: "Speaking", statusIcon: "volume", statusTone: "mint" },
        },
      },
      app.logMessages[1],
    ];
    app.renderMessageUpdate();
    assert.equal(listEl.innerHTMLSetCount, 2);
    assert.match(listEl.innerHTML, /Speaking/);
    assert.match(listEl.innerHTML, /is-tone-mint/);
  });
});
