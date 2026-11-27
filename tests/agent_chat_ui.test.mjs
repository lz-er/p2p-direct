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
  it("detects connected assistant via assistantMeta and falls back to ha:listen voiceControls", () => {
    const peers = [{ peerId: "bot-ha", authorName: "ha", isBot: true }];
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
            commands: ["/ha", "/listen"],
          },
        },
      },
    ];

    const detected = detectRoomAssistant(messages, peers);
    assert.deepEqual(detected, {
      peerId: "bot-ha",
      name: "ha",
      pipelineName: "Assist LLM",
      wakeWordLabel: "Hey Jarvis",
      commands: ["/ha", "/listen"],
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
    assert.deepEqual(fallback.commands, ["/ha", "/listen"]);
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

    // Assistant left room
    assert.equal(detectRoomAssistant([haMsg], []), null);
    assert.equal(detectRoomAssistant([haMsg], [{ peerId: "human-1", authorName: "Alice" }]), null);

    // Non-assistant bot only
    assert.equal(detectRoomAssistant([musicMsg], [{ peerId: "bot-music", authorName: "Jukebox", isBot: true }]), null);

    // Deleted / tombstoned card
    assert.equal(
      detectRoomAssistant(
        [haMsg, { id: "del-1", type: "msg-delete", payload: { targetId: "m-ha-1" } }],
        [{ peerId: "bot-ha", authorName: "ha", isBot: true }]
      ),
      null
    );
  });
});

describe("Agent Chat UI — parseChatCommandPrefix & getSlashCommandSuggestions", () => {
  it("parses /ha, /assist, !ha, !assist, /listen, !listen and ignores normal text", () => {
    assert.deepEqual(parseChatCommandPrefix("/ha turn on office lights"), {
      cmd: "/ha",
      displayCmd: "/ha",
      rest: "turn on office lights",
      isAssistantPrompt: true,
    });
    assert.deepEqual(parseChatCommandPrefix("/assist what is the weather?"), {
      cmd: "/assist",
      displayCmd: "/assist",
      rest: "what is the weather?",
      isAssistantPrompt: true,
    });
    assert.deepEqual(parseChatCommandPrefix("!ha set a 5 min pasta timer"), {
      cmd: "!ha",
      displayCmd: "!ha",
      rest: "set a 5 min pasta timer",
      isAssistantPrompt: true,
    });
    assert.deepEqual(parseChatCommandPrefix("/listen"), {
      cmd: "/listen",
      displayCmd: "/listen",
      rest: "",
      isAssistantPrompt: false,
    });
    assert.deepEqual(parseChatCommandPrefix("/ha"), {
      cmd: "/ha",
      displayCmd: "/ha",
      rest: "",
      isAssistantPrompt: false,
    });
    assert.equal(parseChatCommandPrefix("/hacker news"), null);
    assert.equal(parseChatCommandPrefix("just chatting"), null);
  });

  it("filters slash command suggestions cleanly for /, /h, /a, /l and closes once space is typed", () => {
    const assistant = { peerId: "bot-ha", name: "Home Assistant", pipelineName: "Assist LLM", wakeWordLabel: "Alexa" };

    const all = getSlashCommandSuggestions("/", { assistant, warframeEnabled: false });
    assert.equal(all.length, 3);
    assert.equal(all[0].command, "/ha ");
    assert.equal(all[0].submit, false);
    assert.match(all[0].desc, /Home Assistant \(Assist LLM\)/);
    assert.equal(all[1].command, "/listen");
    assert.equal(all[1].submit, true);
    assert.equal(all[2].command, "/ha");
    assert.equal(all[2].submit, true);

    const hOnly = getSlashCommandSuggestions("/h", { assistant });
    assert.deepEqual(hOnly.map((x) => x.command), ["/ha ", "/ha"]);

    const aOnly = getSlashCommandSuggestions("/a", { assistant });
    assert.deepEqual(aOnly.map((x) => x.command), ["/ha ", "/ha"]);

    const lOnly = getSlashCommandSuggestions("/l", { assistant });
    assert.deepEqual(lOnly.map((x) => x.command), ["/listen"]);

    assert.deepEqual(getSlashCommandSuggestions("/ha turn on lights", { assistant }), []);
    assert.deepEqual(getSlashCommandSuggestions("hello", { assistant }), []);
    assert.deepEqual(getSlashCommandSuggestions("/", { assistant: null, warframeEnabled: false }), []);
  });
});

describe("Agent Chat UI — renderChatPayload & syncAssistantComposerUi", () => {
  it("renders /ha user prompt pill, assistant reply banner with VOICE badge, and syntax-highlighted code inside replies", () => {
    const app = new P2PDirectApp();

    // 1. User prompt with `/ha` prefix + URL
    const promptRendered = app.renderChatPayload({
      text: "/ha check https://voice.dequ.org status",
    });
    assert.match(promptRendered.html, /<span class="chat-cmd-pill">\/ha<\/span>/);
    assert.match(promptRendered.html, /href="https:\/\/voice\.dequ\.org\/"/);
    assert.match(promptRendered.html, /chat-link-cards/);

    // 2. Assistant normal-chat reply with `assistant: true`, `replyTo` (`toName`, `pipeline`, `spoken: true`), and fenced Python code
    const replyRendered = app.renderChatPayload({
      text: "Here is the snippet:\n```python:parallelogram.py\ndef is_parallelogram(a, b, c, d):\n    return a + c == b + d\n```",
      assistant: true,
      replyTo: {
        toName: "Alice",
        botName: "ha",
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

  it("syncs #btn-composer-ha, #composer-agent-pill, and placeholder on assistant join/toggle/leave", () => {
    const app = new P2PDirectApp();
    const attrs = {};
    app.el = {
      "btn-composer-ha": {
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
    };
    app.status = {
      peerId: "self",
      authorName: "Alice",
      peers: [{ peerId: "bot-ha", authorName: "ha", isBot: true }],
    };
    app.logMessages = [
      {
        id: "m-ha",
        type: "bot",
        author: "bot-ha",
        payload: { assistantMeta: { pipelineName: "Assist LLM", wakeWordLabel: "Alexa", commands: ["/ha", "/listen"] } },
      },
    ];

    app.syncAssistantComposerUi();
    assert.equal(app.el["btn-composer-ha"].classList.contains("hidden"), false);
    assert.equal(app.el["composer-agent-pill"].classList.contains("hidden"), true);
    assert.match(app.el["btn-composer-ha"].title, /Assist LLM/);

    // Toggle Direct Assistant Mode ON
    app.setComposerAgentMode(true, { focus: true });
    assert.equal(app.composerAgentMode, true);
    assert.equal(app.el["composer-agent-pill"].classList.contains("hidden"), false);
    assert.equal(app.el["chat-composer-form"].classList.contains("is-agent-mode"), true);
    assert.equal(attrs["aria-pressed"], "true");
    assert.equal(app.el["chat-text-input"].focused, true);
    assert.match(app.el["chat-text-input"].placeholder, /Ask ha \(Assist LLM · voice \+ chat\)/);

    // Assistant leaves room -> button hides and agent mode cleanly resets
    app.status.peers = [];
    app.syncAssistantComposerUi();
    assert.equal(app.composerAgentMode, false);
    assert.equal(app.el["btn-composer-ha"].classList.contains("hidden"), true);
    assert.equal(app.el["composer-agent-pill"].classList.contains("hidden"), true);
    assert.equal(app.el["chat-composer-form"].classList.contains("is-agent-mode"), false);
    assert.equal(app.el["chat-text-input"].placeholder, "Write a message…");
  });
});
