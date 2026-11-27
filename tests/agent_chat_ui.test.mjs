import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.__P2P_NO_AUTO_BOOT__ = true;
const {
  P2PDirectApp,
  detectRoomAssistant,
  parseChatCommandPrefix,
  getSlashCommandSuggestions,
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

describe("Agent Chat UI — detectRoomAssistant", () => {
  it("detects connected assistant via assistantMeta and falls back to ha:listen voiceControls with /ai defaults", () => {
    const peers = [{ peerId: "bot-ha", authorName: "Assistant", isBot: true }];
    const messages = [
      {
        id: "m-ha-1",
        type: "bot",
        author: "bot-ha",
        authorName: "Home Assistant",
        payload: {
          title: "Home Assistant",
          assistantMeta: {
            pipelineName: "Assist LLM",
            wakeWordLabel: "Hey Jarvis",
            commands: ["/ai", "/listen"],
          },
        },
      },
    ];

    const detected = detectRoomAssistant(messages, peers);
    assert.deepEqual(detected, {
      peerId: "bot-ha",
      name: "Assistant",
      pipelineName: "Assist LLM",
      wakeWordLabel: "Hey Jarvis",
      commands: ["/ai", "/listen"],
    });

    // Fallback detection via `ha:listen` in voiceControls when assistantMeta is absent
    const fallbackMsgs = [
      {
        id: "m-ha-vc",
        type: "bot",
        author: "bot-ha",
        authorName: "Home Assistant",
        payload: {
          voiceControls: {
            status: "Alexa",
            buttons: [{ id: "ha:listen", label: "Listen Now", icon: "mic", style: "primary" }],
          },
        },
      },
    ];
    const fallback = detectRoomAssistant(fallbackMsgs, peers);
    assert.ok(fallback);
    assert.equal(fallback.peerId, "bot-ha");
    assert.equal(fallback.wakeWordLabel, "Alexa");
    assert.deepEqual(fallback.commands, ["/ai", "/listen"]);
  });

  it("returns null when assistant peer disconnected, card deleted, or only non-assistant bots exist", () => {
    const haMsg = {
      id: "m-ha-1",
      type: "bot",
      author: "bot-ha",
      payload: { assistantMeta: { pipelineName: "Assist LLM", wakeWordLabel: "Alexa" } },
    };
    const musicMsg = {
      id: "m-music",
      type: "bot",
      author: "bot-music",
      payload: { voiceControls: { status: "Now Playing", buttons: [{ id: "music:pause", label: "Pause" }] } },
    };

    assert.equal(detectRoomAssistant([haMsg], []), null);
    assert.equal(detectRoomAssistant([haMsg], [{ peerId: "human-1", authorName: "Alice" }]), null);
    assert.equal(detectRoomAssistant([musicMsg], [{ peerId: "bot-music", authorName: "Jukebox", isBot: true }]), null);
    assert.equal(
      detectRoomAssistant(
        [haMsg, { id: "del-1", type: "msg-delete", payload: { targetId: "m-ha-1" } }],
        [{ peerId: "bot-ha", authorName: "Assistant", isBot: true }]
      ),
      null
    );
  });
});

describe("Agent Chat UI — parseChatCommandPrefix & getSlashCommandSuggestions", () => {
  it("parses /ai, !ai, /assist, !assist, /listen, !listen, legacy /ha & !ha, and ignores normal text", () => {
    assert.deepEqual(parseChatCommandPrefix("/ai turn on office lights"), {
      cmd: "/ai",
      displayCmd: "/ai",
      rest: "turn on office lights",
      isAssistantPrompt: true,
    });
    assert.deepEqual(parseChatCommandPrefix("!ai set a 5 min pasta timer"), {
      cmd: "!ai",
      displayCmd: "!ai",
      rest: "set a 5 min pasta timer",
      isAssistantPrompt: true,
    });
    assert.deepEqual(parseChatCommandPrefix("/assist what is the weather?"), {
      cmd: "/assist",
      displayCmd: "/assist",
      rest: "what is the weather?",
      isAssistantPrompt: true,
    });
    assert.deepEqual(parseChatCommandPrefix("/ha legacy fallback"), {
      cmd: "/ha",
      displayCmd: "/ha",
      rest: "legacy fallback",
      isAssistantPrompt: true,
    });
    assert.deepEqual(parseChatCommandPrefix("/listen"), {
      cmd: "/listen",
      displayCmd: "/listen",
      rest: "",
      isAssistantPrompt: false,
    });
    assert.deepEqual(parseChatCommandPrefix("/ai"), {
      cmd: "/ai",
      displayCmd: "/ai",
      rest: "",
      isAssistantPrompt: false,
    });
    assert.equal(parseChatCommandPrefix("/airline status"), null);
    assert.equal(parseChatCommandPrefix("just chatting"), null);
  });

  it("filters /ai slash command suggestions cleanly for /, /a, /ai, /l and closes once space is typed", () => {
    const assistant = { peerId: "bot-ha", name: "Home Assistant", pipelineName: "Assist LLM", wakeWordLabel: "Alexa" };

    const all = getSlashCommandSuggestions("/", { assistant, warframeEnabled: false });
    assert.equal(all.length, 3);
    assert.equal(all[0].command, "/ai ");
    assert.equal(all[0].label, "/ai <message>");
    assert.equal(all[0].submit, false);
    assert.match(all[0].desc, /Home Assistant \(Assist LLM\)/);
    assert.equal(all[1].command, "/listen");
    assert.equal(all[1].submit, true);
    assert.equal(all[2].command, "/ai");
    assert.equal(all[2].submit, true);

    const aOnly = getSlashCommandSuggestions("/a", { assistant });
    assert.deepEqual(aOnly.map((x) => x.command), ["/ai ", "/ai"]);

    const aiOnly = getSlashCommandSuggestions("/ai", { assistant });
    assert.deepEqual(aiOnly.map((x) => x.command), ["/ai ", "/ai"]);

    const lOnly = getSlashCommandSuggestions("/l", { assistant });
    assert.deepEqual(lOnly.map((x) => x.command), ["/listen"]);

    assert.deepEqual(getSlashCommandSuggestions("/ai turn on lights", { assistant }), []);
    assert.deepEqual(getSlashCommandSuggestions("hello", { assistant }), []);
    assert.deepEqual(getSlashCommandSuggestions("/", { assistant: null, warframeEnabled: false }), []);
  });
});

describe("Agent Chat UI — renderChatPayload, /ai composer & #chat-thinking-bar", () => {
  it("renders /ai user prompt pill, assistant reply banner with VOICE badge, and syntax-highlighted code inside replies", () => {
    const app = new P2PDirectApp();

    const promptRendered = app.renderChatPayload({
      text: "/ai check https://voice.dequ.org status",
    });
    assert.match(promptRendered.html, /<span class="chat-cmd-pill">\/ai<\/span>/);
    assert.match(promptRendered.html, /href="https:\/\/voice\.dequ\.org\/"/);
    assert.match(promptRendered.html, /chat-link-cards/);

    const replyRendered = app.renderChatPayload({
      text: "Here is the snippet:\n```python:parallelogram.py\ndef is_parallelogram(a, b, c, d):\n    return a + c == b + d\n```",
      assistant: true,
      replyTo: {
        toName: "Alice",
        botName: "Assistant",
        label: "Assist LLM",
        pipeline: "Assist LLM",
        spoken: true,
      },
    });
    assert.match(replyRendered.html, /class="chat-reply-banner is-assistant-meta"/);
    assert.match(replyRendered.html, /↳ <strong>Alice<\/strong>/);
    assert.match(replyRendered.html, /class="chat-reply-pipeline">Assist LLM<\/span>/);
    assert.match(replyRendered.html, /class="chat-voice-badge"/);
    assert.match(replyRendered.html, /<span>VOICE<\/span>/);
    assert.match(replyRendered.html, /<div class="chat-code-block" data-code-lang="python">/);
    assert.match(replyRendered.html, /<span class="chat-code-title" title="parallelogram\.py">parallelogram\.py<\/span>/);
    assert.match(replyRendered.html, /<span class="tok-kw">def<\/span>/);
  });

  it("syncs #btn-composer-ai, #composer-agent-pill, and #chat-thinking-bar across idle -> thinking -> idle -> leave", () => {
    const app = new P2PDirectApp();
    const attrs = {};
    app.el = {
      "btn-composer-ai": {
        classList: createMockClassList(["hidden"]),
        title: "",
        setAttribute(k, v) {
          attrs[k] = v;
        },
      },
      "composer-agent-pill": { classList: createMockClassList(["hidden"]) },
      "chat-composer-form": { classList: createMockClassList() },
      "chat-text-input": { value: "", placeholder: "Write a message…", focused: false, focus() { this.focused = true; } },
      "chat-slash-menu": { classList: createMockClassList(["hidden"]), innerHTML: "" },
      "chat-thinking-bar": { classList: createMockClassList(["hidden"]), innerHTML: "" },
    };
    app.status = {
      peerId: "self",
      authorName: "Alice",
      peers: [{ peerId: "bot-ha", authorName: "Assistant", isBot: true }],
    };
    app.logMessages = [
      {
        id: "m-ha",
        type: "bot",
        author: "bot-ha",
        payload: {
          assistantMeta: { pipelineName: "Assist LLM", wakeWordLabel: "Alexa", commands: ["/ai", "/listen"] },
          voiceControls: { status: "Alexa", activity: "idle" },
        },
      },
    ];

    app.syncAssistantComposerUi();
    assert.equal(app.el["btn-composer-ai"].classList.contains("hidden"), false);
    assert.equal(app.el["composer-agent-pill"].classList.contains("hidden"), true);
    assert.equal(app.el["chat-thinking-bar"].classList.contains("hidden"), true);
    assert.match(app.el["btn-composer-ai"].title, /\/ai mode/);
    assert.match(app.el["btn-composer-ai"].title, /Assist LLM/);

    // Bot enters thinking state -> #chat-thinking-bar appears with pulsing dots + name + pipeline
    app.logMessages = [
      {
        id: "m-ha",
        type: "bot",
        author: "bot-ha",
        payload: {
          assistantMeta: { pipelineName: "Assist LLM", wakeWordLabel: "Alexa", commands: ["/ai", "/listen"] },
          voiceControls: { status: "Thinking...", statusTone: "cyan", activity: "thinking" },
        },
      },
    ];
    app.syncAssistantComposerUi();
    assert.equal(app.el["chat-thinking-bar"].classList.contains("hidden"), false);
    assert.match(app.el["chat-thinking-bar"].innerHTML, /voice-bot-thinking-dots/);
    assert.match(app.el["chat-thinking-bar"].innerHTML, /<strong>Assistant<\/strong> is thinking/);
    assert.match(app.el["chat-thinking-bar"].innerHTML, /chat-thinking-pipeline">Assist LLM<\/span>/);

    // Toggle Direct /ai Mode ON
    app.setComposerAgentMode(true, { focus: true });
    assert.equal(app.composerAgentMode, true);
    assert.equal(app.el["composer-agent-pill"].classList.contains("hidden"), false);
    assert.equal(app.el["chat-composer-form"].classList.contains("is-agent-mode"), true);
    assert.equal(attrs["aria-pressed"], "true");
    assert.equal(app.el["chat-text-input"].focused, true);
    assert.match(app.el["chat-text-input"].placeholder, /Ask Assistant \(Assist LLM · voice \+ chat\)/);

    // Bot finishes thinking -> #chat-thinking-bar hides
    app.logMessages = [
      {
        id: "m-ha",
        type: "bot",
        author: "bot-ha",
        payload: {
          assistantMeta: { pipelineName: "Assist LLM", wakeWordLabel: "Alexa", commands: ["/ai", "/listen"] },
          voiceControls: { status: "Speaking", statusTone: "cobalt", activity: "speaking" },
        },
      },
    ];
    app.syncAssistantComposerUi();
    assert.equal(app.el["chat-thinking-bar"].classList.contains("hidden"), true);
    assert.equal(app.el["chat-thinking-bar"].innerHTML, "");

    // Assistant leaves room -> button hides and agent mode cleanly resets
    app.status.peers = [];
    app.syncAssistantComposerUi();
    assert.equal(app.composerAgentMode, false);
    assert.equal(app.el["btn-composer-ai"].classList.contains("hidden"), true);
    assert.equal(app.el["composer-agent-pill"].classList.contains("hidden"), true);
    assert.equal(app.el["chat-composer-form"].classList.contains("is-agent-mode"), false);
    assert.equal(app.el["chat-text-input"].placeholder, "Write a message…");
  });
});
