import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.__P2P_NO_AUTO_BOOT__ = true;
const {
  P2PDirectApp,
  sanitizeRoomTimerItem,
  extractActiveRoomTimers,
  buildRoomTimersSignature,
  renderRoomTimersHtml,
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
  return {
    classList: createMockClassList(),
    className: "",
    textContent: "",
    title: "",
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
  };
}

describe("Room Timers — sanitizeRoomTimerItem", () => {
  it("sanitizes valid timer items, strips emojis, validates icons/tones/styles, and caps actions at 3", () => {
    const nowMs = 1_700_000_000_000;
    const item = sanitizeRoomTimerItem(
      {
        id: "timer_list.kitchen:01HZ8",
        label: "🔔 Pasta Boiling 🚀",
        source: "🏠 Kitchen Assist",
        icon: "not-a-valid-icon",
        totalSec: 300,
        remainingSec: 272,
        endsAtMs: nowMs + 272_000,
        paused: false,
        color: "cobalt",
        doneLabel: "✅ READY!",
        actions: [
          null,
          { id: "ha:tl:pause:1", label: "⏸ Pause", icon: "pause", style: "secondary" },
          { id: "ha:tl:add60:1", label: "+1m", icon: "plus", style: "invalid-style" },
          { id: "ha:tl:cancel:1", label: "Cancel", icon: "close", style: "danger" },
          { id: "ha:tl:overflow:1", label: "4th Action", icon: "check", style: "primary" },
        ],
      },
      { msgId: "msg-ha-1", peerId: "bot-ha", authorName: "Home Assistant", sourceKey: "peer:bot-ha", nowMs }
    );

    assert.ok(item);
    assert.equal(item.id, "timer_list.kitchen:01HZ8");
    assert.equal(item.msgId, "msg-ha-1");
    assert.equal(item.label, "Pasta Boiling");
    assert.equal(item.source, "Kitchen Assist");
    // Explicit invalid icon ignored, leading emoji mapped to valid `bell` icon from icons.js
    assert.equal(item.icon, "bell");
    assert.equal(item.totalSec, 300);
    assert.equal(item.remainingSec, 272);
    assert.equal(item.endsAtMs, nowMs + 272_000);
    assert.equal(item.paused, false);
    assert.equal(item.color, "cobalt");
    assert.equal(item.doneLabel, "READY!");
    assert.equal(item.actions.length, 3);
    assert.equal(item.actions[0].label, "Pause");
    assert.equal(item.actions[0].icon, "pause");
    assert.equal(item.actions[1].style, "secondary");
    assert.equal(item.actions[2].style, "danger");
  });

  it("defaults invalid icons to `timer`, invalid colors to `cobalt`, and handles paused timers", () => {
    const nowMs = 1_700_000_000_000;
    const item = sanitizeRoomTimerItem(
      {
        id: "t-paused",
        label: "Tea",
        icon: "nonexistent",
        color: "neon-purple",
        totalSec: 180,
        remainingSec: 95,
        endsAtMs: nowMs + 95_000,
        paused: true,
      },
      { msgId: "m1", nowMs }
    );
    assert.ok(item);
    assert.equal(item.icon, "timer");
    assert.equal(item.color, "cobalt");
    assert.equal(item.paused, true);
    assert.equal(item.endsAtMs, 0);
    assert.equal(item.remainingSec, 95);
    assert.equal(sanitizeRoomTimerItem(null), null);
    assert.equal(sanitizeRoomTimerItem([]), null);
  });
});

describe("Room Timers — extractActiveRoomTimers", () => {
  it("supports authoritative card.timers, empty [] clearing, latest-card-wins per bot, and multi-bot coexistence", () => {
    const nowMs = 1_700_000_000_000;
    const messages = [
      // Older HA card (should be superseded by m-ha-2)
      {
        id: "m-ha-1",
        type: "bot",
        author: "bot-ha",
        authorName: "Home Assistant",
        payload: {
          timers: [
            { id: "stale", label: "Stale Timer", totalSec: 60, endsAtMs: nowMs + 10_000, paused: false },
          ],
        },
      },
      // Newer HA card with 2 timers (one paused, one running)
      {
        id: "m-ha-2",
        type: "bot",
        author: "bot-ha",
        authorName: "Home Assistant",
        payload: {
          timers: [
            {
              id: "ha-paused",
              label: "Dough Proof",
              source: "Kitchen Assist",
              totalSec: 1800,
              remainingSec: 600,
              endsAtMs: 0,
              paused: true,
              color: "ochre",
              actions: [{ id: "ha:tl:unpause:1", label: "Resume", icon: "play", style: "success" }],
            },
            {
              id: "ha-pasta",
              label: "Pasta",
              source: "Kitchen Assist",
              totalSec: 300,
              remainingSec: 200,
              endsAtMs: nowMs + 200_000,
              paused: false,
              color: "cobalt",
              actions: [
                { id: "ha:tl:pause:2", label: "Pause", icon: "pause", style: "secondary" },
                { id: "ha:tl:add60:2", label: "+1m", icon: "plus", style: "secondary" },
                { id: "ha:tl:cancel:2", label: "Cancel", icon: "close", style: "danger" },
              ],
            },
          ],
        },
      },
      // Non-timer HA announcement later should NOT clobber m-ha-2
      {
        id: "m-ha-announce",
        type: "bot",
        author: "bot-ha",
        authorName: "Home Assistant",
        payload: { title: "Lights turned on" },
      },
      // Built-in Pomodoro card (separate source key `builtin:pomodoro`, legacy timer block fallback)
      {
        id: "m-pomo-1",
        type: "bot",
        author: "self-peer",
        authorName: "Leo",
        payload: {
          botId: "pomodoro",
          title: "Focus Sprint",
          blocks: [
            {
              type: "timer",
              id: "pomo-block",
              label: "Focus Block",
              totalSec: 1500,
              endsAtMs: nowMs + 90_000,
              paused: false,
              color: "mint",
              actionId: "pomo:dismiss",
            },
          ],
        },
      },
      // Bot that cleared its timers with authoritative `timers: []`
      {
        id: "m-cleared-1",
        type: "bot",
        author: "bot-cleared",
        payload: {
          timers: [{ id: "old-c", label: "Old Cleared", totalSec: 60, endsAtMs: nowMs + 30_000 }],
        },
      },
      {
        id: "m-cleared-2",
        type: "bot_message",
        author: "bot-cleared",
        payload: { card: { timers: [] } },
      },
    ];

    const timers = extractActiveRoomTimers(messages, nowMs);
    assert.equal(timers.length, 3);
    // Sorted: active soonest-finishing first (Focus Block 90s, Pasta 200s), then paused (Dough Proof)
    assert.equal(timers[0].id, "pomo-block");
    assert.equal(timers[0].sourceKey, "builtin:pomodoro");
    assert.equal(timers[0].actions.length, 1);
    assert.equal(timers[0].actions[0].id, "pomo:dismiss");
    assert.equal(timers[0].actions[0].label, "Dismiss");

    assert.equal(timers[1].id, "ha-pasta");
    assert.equal(timers[1].sourceKey, "peer:bot-ha");
    assert.equal(timers[1].actions.length, 3);

    assert.equal(timers[2].id, "ha-paused");
    assert.equal(timers[2].paused, true);
  });

  it("respects msg-delete tombstones, m.deleted, and caps total timers at 12", () => {
    const nowMs = 1_700_000_000_000;
    const manyTimers = Array.from({ length: 16 }, (_, i) => ({
      id: `t-${i}`,
      label: `Timer ${i}`,
      totalSec: 600,
      endsAtMs: nowMs + (i + 1) * 10_000,
      paused: false,
    }));

    const messages = [
      {
        id: "m-many",
        type: "bot",
        author: "bot-a",
        payload: { timers: manyTimers },
      },
      {
        id: "m-del-flag",
        type: "bot",
        author: "bot-b",
        deleted: true,
        payload: { timers: [{ id: "ghost-1", label: "Ghost Flag", totalSec: 60, endsAtMs: nowMs + 5000 }] },
      },
      {
        id: "m-del-tomb",
        type: "bot",
        author: "bot-c",
        payload: { timers: [{ id: "ghost-2", label: "Ghost Tomb", totalSec: 60, endsAtMs: nowMs + 5000 }] },
      },
      {
        id: "tomb-1",
        type: "msg-delete",
        author: "bot-c",
        payload: { targetId: "m-del-tomb" },
      },
    ];

    const timers = extractActiveRoomTimers(messages, nowMs);
    assert.equal(timers.length, 12);
    assert.equal(timers[0].id, "t-0");
    assert.equal(timers[11].id, "t-11");
    assert.ok(timers.every((t) => !t.id.startsWith("ghost-")));
  });
});

describe("Room Timers — signature, HTML rendering & app integration", () => {
  it("keeps buildRoomTimersSignature stable across 1-second ticks for running timers and changes on state edits", () => {
    const t0 = 1_700_000_000_000;
    const msg = {
      id: "m-ha",
      type: "bot",
      author: "bot-ha",
      payload: {
        timers: [
          {
            id: "pasta",
            label: "Pasta",
            totalSec: 300,
            endsAtMs: t0 + 120_000,
            paused: false,
            color: "cobalt",
            actions: [{ id: "ha:tl:pause:1", label: "Pause", icon: "pause", style: "secondary" }],
          },
        ],
      },
    };

    const sigAt0 = buildRoomTimersSignature(extractActiveRoomTimers([msg], t0));
    const sigAt5s = buildRoomTimersSignature(extractActiveRoomTimers([msg], t0 + 5_000));
    assert.equal(sigAt0, sigAt5s, "signature must stay identical while running timer ticks");

    const pausedMsg = {
      ...msg,
      payload: {
        timers: [{ ...msg.payload.timers[0], paused: true, remainingSec: 115, endsAtMs: 0 }],
      },
    };
    assert.notEqual(sigAt0, buildRoomTimersSignature(extractActiveRoomTimers([pausedMsg], t0 + 5_000)));
  });

  it("renders XSS-safe Flat Metro HTML with zero emojis and exact action data attributes", () => {
    const nowMs = 1_700_000_000_000;
    const timers = extractActiveRoomTimers(
      [
        {
          id: 'msg<"x">',
          type: "bot",
          author: "bot-ha",
          payload: {
            timers: [
              {
                id: 't<"1">',
                label: '<img src=x onerror=alert(1)> Pasta 🍝',
                source: "<b>Kitchen</b> 🏠",
                icon: "timer",
                totalSec: 300,
                endsAtMs: nowMs + 150_000,
                paused: false,
                color: "mint",
                actions: [
                  { id: 'ha:"pause"', label: "⏸ Pause", icon: "pause", style: "warning" },
                ],
              },
            ],
          },
        },
      ],
      nowMs
    );

    const html = renderRoomTimersHtml(timers, nowMs);
    assert.doesNotMatch(html, /<img\b/i);
    assert.doesNotMatch(html, /<b>/i);
    assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
    assert.match(html, /class="room-timer-tile is-mint"/);
    assert.match(html, /data-room-timer-running="1"/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; Pasta/);
    assert.match(html, /&lt;b&gt;Kitchen&lt;\/b&gt;/);
    assert.match(html, /02:30/);
    assert.match(html, /width:50%/);
    assert.match(html, /data-room-timer-msg-id="msg&lt;&quot;x&quot;&gt;"/);
    assert.match(html, /data-room-timer-action-id="ha:&quot;pause&quot;"/);
    assert.match(html, /data-room-timer-label="Pause"/);
    assert.match(html, /data-room-timer-btn-idx="0"/);
  });

  it("wires renderRoomTimers, topbar chip, and handleRoomTimerActionClick without rebuilding on unchanged renders", () => {
    const nowMs = Date.now();
    const wasmCalls = [];
    const app = new P2PDirectApp();
    app.el = {
      "timers-header-chip": createMockElement(),
      "timers-header-value": createMockElement(),
      "timers-header-count": createMockElement(),
      "room-timers-bar": createMockElement(),
      "room-timers-count": createMockElement(),
      "room-timers-grid": createMockElement(),
      "log-feed": createMockElement(),
    };
    app.status = { peerId: "self", authorName: "Leo", peers: [] };
    app.executeActions = () => {};
    app.renderAll = () => {};
    app.wasm = {
      call(cmd) {
        wasmCalls.push(cmd);
        return { status: app.status, actions: [] };
      },
    };

    const msg = {
      id: "ha-msg-1",
      type: "bot",
      author: "bot-ha",
      authorName: "Home Assistant",
      payload: {
        timers: [
          {
            id: "t1",
            label: "Pasta",
            source: "Kitchen",
            totalSec: 300,
            endsAtMs: nowMs + 120_000,
            paused: false,
            color: "cobalt",
            actions: [{ id: "ha:tl:pause:t1", label: "Pause", icon: "pause", style: "secondary" }],
          },
          {
            id: "t2",
            label: "Laundry",
            source: "Hallway",
            totalSec: 600,
            remainingSec: 300,
            paused: true,
            color: "ochre",
          },
        ],
      },
    };
    app.logMessages = [msg];

    app.renderRoomTimers();
    assert.equal(app.el["room-timers-bar"].classList.contains("hidden"), false);
    assert.equal(app.el["room-timers-count"].textContent, "2");
    assert.equal(app.el["room-timers-grid"].innerHTMLSetCount, 1);
    assert.equal(app.el["timers-header-chip"].classList.contains("hidden"), false);
    assert.equal(app.el["timers-header-count"].classList.contains("hidden"), false);
    assert.equal(app.el["timers-header-count"].textContent, "+1");

    // Re-rendering without timer changes must NOT rebuild grid DOM
    app.renderRoomTimers();
    assert.equal(app.el["room-timers-grid"].innerHTMLSetCount, 1);

    // Clicking timer action dispatches standard E2EE `send_bot_action`
    const btnEl = {
      disabled: false,
      isConnected: false,
      innerHTML: "Pause",
      textContent: "Pause",
      classList: createMockClassList(),
      dataset: {
        roomTimerMsgId: "ha-msg-1",
        roomTimerActionId: "ha:tl:pause:t1",
        roomTimerLabel: "Pause",
        roomTimerBtnIdx: "0",
        roomTimerIdx: "0",
      },
    };
    app.handleRoomTimerActionClick(btnEl);
    assert.equal(wasmCalls.length, 1);
    assert.equal(wasmCalls[0].cmd, "send_bot_action");
    assert.equal(wasmCalls[0].toPeerId, "bot-ha");
    assert.equal(wasmCalls[0].messageId, "ha-msg-1");
    assert.equal(wasmCalls[0].actionId, "ha:tl:pause:t1");

    // Clearing timers hides bar & header chip and stops interval cleanly
    app.logMessages = [{ ...msg, payload: { timers: [] } }];
    app.renderRoomTimers();
    assert.equal(app.el["room-timers-bar"].classList.contains("hidden"), true);
    assert.equal(app.el["timers-header-chip"].classList.contains("hidden"), true);
    assert.equal(app._botBlockTickTimer, null);
  });
});
