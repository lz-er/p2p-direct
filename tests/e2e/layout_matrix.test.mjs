/**
 * Layer 4 Real Chromium 6-Viewport Crowded-UI Layout Matrix.
 *
 * Sweeps 6 critical viewports (360x640, 390x844, 844x390 landscape phone, 1024x768,
 * 1280x800, 1920x1080) across crowded UI combinations:
 *   Lobby vs In-Room x Normal vs Advanced x Active Voice (header chip + 4 tiles)
 *   + #btn-pwa-install visible + 32-char display name x Watch states
 *   (YouTube 16:9 theater + notice banner + queue, Spotify single 152px + session banner,
 *    SoundCloud SNIP banner, Minimized).
 *
 * Asserts deterministic DOM geometry on every cell with zero uncaught page errors.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startLocalMqttBroker } from "./local_mqtt_broker.mjs";
import { startStaticServer } from "./static_server.mjs";
import { launchChrome } from "./cdp_client.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INIT_NO_STUN = "window.__P2P_ICE_SERVERS__ = [];";
const LONG_NAME_32 = "Alexandria-Maximilian-Vance-0032";

const VIEWPORTS = [
  { name: "360x640", width: 360, height: 640, mobile: true },
  { name: "390x844", width: 390, height: 844, mobile: true },
  { name: "844x390", width: 844, height: 390, mobile: true, shortLandscape: true },
  { name: "1024x768", width: 1024, height: 768, mobile: false },
  { name: "1280x800", width: 1280, height: 800, mobile: false },
  { name: "1920x1080", width: 1920, height: 1080, mobile: false },
];

async function waitForAppReady(page) {
  await page.waitFor(
    `(() => {
      const pid = document.getElementById("peer-id-display")?.textContent?.trim() || "";
      return pid.length > 0 && pid !== "loading…" && pid !== "loading...";
    })()`,
    { timeoutMs: 15000, label: "layout page WASM init" }
  );
}

async function flushLayout(page) {
  await page.evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
  );
}

async function applyCrowdedHeaderAndVoice(page, { inRoom, advanced }) {
  await page.evaluate(`(() => {
    const html = document.documentElement;
    html.setAttribute("data-advanced", ${JSON.stringify(advanced ? "true" : "false")});
    html.setAttribute("data-mobile-tab", "chat");

    const advBtn = document.getElementById("btn-advanced-toggle");
    if (advBtn) advBtn.setAttribute("aria-pressed", ${JSON.stringify(advanced ? "true" : "false")});

    // 32-char display name + Install PWA button visible
    const nameInput = document.getElementById("author-name-input");
    if (nameInput) {
      nameInput.value = ${JSON.stringify(LONG_NAME_32)};
    }
    const installBtn = document.getElementById("btn-pwa-install");
    if (installBtn) installBtn.classList.remove("hidden");

    const voiceChip = document.getElementById("voice-header-chip");
    const voiceCount = document.getElementById("voice-header-count");
    const voiceList = document.getElementById("voice-participant-list");
    const joinCard = document.getElementById("voice-join-card");
    const voiceBadge = document.getElementById("voice-status-badge");
    const peerCount = document.getElementById("peer-count-display");

    if (${JSON.stringify(inRoom)}) {
      if (peerCount) peerCount.textContent = "4";
      if (voiceChip) voiceChip.classList.remove("hidden");
      if (voiceCount) voiceCount.textContent = "4";
      if (voiceBadge) voiceBadge.textContent = "4 Live";
      if (joinCard) joinCard.classList.add("hidden");
      if (voiceList) {
        voiceList.classList.remove("hidden");
        const names = [
          ${JSON.stringify(LONG_NAME_32)},
          "Beatrice-Voice-Participant",
          "Christopher-Audio-Peer",
          "Delilah-Mesh-Speaker",
        ];
        voiceList.innerHTML = names.map((nm, idx) => \`
          <li class="voice-card tone-\${idx % 6}\${idx === 0 ? " is-self" : ""}" data-voice-row="v-\${idx}">
            <div class="voice-tile-top">
              <span class="tile-mono">\${nm.slice(0, 2).toUpperCase()}</span>
              <span class="tile-status-tag"><span>Live</span></span>
            </div>
            <div class="tile-lower">
              <div class="voice-tile-mid">
                <span class="voice-card-name">\${nm}</span>
              </div>
              <div class="tile-control-slot">
                <div class="voice-peer-mixer">
                  <button type="button" class="tile-mute-btn">Mute</button>
                  <input type="range" class="voice-volume-slider" min="0" max="150" value="100" />
                </div>
              </div>
              <div class="voice-eq" aria-hidden="true">
                <span class="voice-eq-bar"></span>
                <span class="voice-eq-bar"></span>
                <span class="voice-eq-bar"></span>
              </div>
            </div>
          </li>
        \`).join("");
      }
    }
  })()`);
}

async function injectNoticeAndQueue(page, { provider, tag, text, queueCount = 0 }) {
  await page.evaluate(`(() => {
    const bar = document.getElementById("watch-spotify-session-bar");
    const tagEl = document.getElementById("watch-provider-notice-tag");
    const textEl = document.getElementById("watch-spotify-session-text");
    const reloadBtn = document.getElementById("btn-watch-spotify-session-reload");
    if (bar) {
      bar.classList.remove(
        "hidden",
        "provider-spotify",
        "provider-youtube",
        "provider-ytmusic",
        "provider-soundcloud",
        "provider-twitch"
      );
      bar.classList.add("provider-" + ${JSON.stringify(provider)});
      if (tagEl) tagEl.textContent = ${JSON.stringify(tag)};
      if (textEl) textEl.textContent = ${JSON.stringify(text)};
      if (reloadBtn) reloadBtn.classList.remove("hidden");
    }

    const qSec = document.getElementById("watch-queue-section");
    const qHead = document.getElementById("watch-queue-head");
    const qCount = document.getElementById("watch-queue-count");
    const qList = document.getElementById("watch-queue-list");
    const count = ${Number(queueCount) || 0};
    if (qSec && qHead && qCount && qList) {
      if (count > 0) {
        qSec.classList.remove("hidden");
        qHead.classList.remove("hidden");
        qList.classList.remove("hidden");
        qCount.textContent = "Up Next (" + count + ")";
        qList.innerHTML = Array.from({ length: count }, (_, i) => \`
          <li class="watch-queue-item">
            <span class="watch-queue-title">Queued Track #\${i + 1} — Synced E2EE Queue Item</span>
            <div class="watch-queue-actions">
              <button type="button" class="media-ctrl-btn">▶</button>
              <button type="button" class="media-ctrl-btn">×</button>
            </div>
          </li>
        \`).join("");
      } else {
        qSec.classList.add("hidden");
        qHead.classList.add("hidden");
        qList.classList.add("hidden");
        qList.innerHTML = "";
      }
    }
  })()`);
}

async function inspectCellGeometry(page) {
  return page.evaluate(`(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrollWidth = document.documentElement.scrollWidth;
    const advMode = document.documentElement.getAttribute("data-advanced") === "true";
    const inRoom = document.documentElement.getAttribute("data-in-room") === "true";

    // 1. Visible header.topbar controls (zero pairwise overlap or horizontal clipping)
    const header = document.querySelector("header.topbar");
    const headerRect = header.getBoundingClientRect();
    const topbarControls = [];
    const collectIfVisible = (el, label) => {
      if (!el) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      topbarControls.push({
        label,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      });
    };
    collectIfVisible(header.querySelector(".name-hero-wrap"), ".name-hero-wrap");
    const idBar = header.querySelector(".identity-bar");
    if (idBar) {
      for (const child of Array.from(idBar.children)) {
        const tag = child.id ? "#" + child.id : child.className || child.tagName;
        collectIfVisible(child, tag);
      }
    }

    const topbarOverlaps = [];
    for (let i = 0; i < topbarControls.length; i++) {
      for (let j = i + 1; j < topbarControls.length; j++) {
        const a = topbarControls[i];
        const b = topbarControls[j];
        const overlapW = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapH = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapW > 1.5 && overlapH > 1.5) {
          topbarOverlaps.push({
            a: a.label,
            b: b.label,
            overlapW: Number(overlapW.toFixed(1)),
            overlapH: Number(overlapH.toFixed(1)),
          });
        }
      }
    }

    const topbarClipped = topbarControls
      .filter((c) => c.left < headerRect.left - 1.5 || c.right > headerRect.right + 1.5 || c.right > vw + 1.5)
      .map((c) => ({
        label: c.label,
        left: Number(c.left.toFixed(1)),
        right: Number(c.right.toFixed(1)),
        headerRight: Number(headerRect.right.toFixed(1)),
        vw,
      }));

    // 2. .advanced-only visibility check when Advanced Mode is off
    const leakedAdvanced = [];
    const advEls = Array.from(document.querySelectorAll(".advanced-only"));
    if (!advMode) {
      for (const el of advEls) {
        const d = getComputedStyle(el).display;
        if (d !== "none") {
          leakedAdvanced.push({
            id: el.id || "",
            cls: el.className || "",
            display: d,
          });
        }
      }
    }

    // 3. Watch panel geometry
    const watchPanel = document.getElementById("watch-panel");
    const watchVisible = Boolean(
      watchPanel &&
      !watchPanel.classList.contains("hidden") &&
      getComputedStyle(watchPanel).display !== "none"
    );
    const watchMinimized = Boolean(watchPanel && watchPanel.classList.contains("is-minimized"));
    const split = document.getElementById("watch-chat-split");
    const isSideEligible = Boolean(split && split.classList.contains("is-watch-side-eligible"));
    const splitCols = split ? getComputedStyle(split).gridTemplateColumns : "";
    const isSideBySideActive = Boolean(
      isSideEligible &&
      split &&
      getComputedStyle(split).display === "grid" &&
      splitCols.trim().split(/\s+/).length >= 2
    );

    const stageWrapEl = document.getElementById("watch-stage-wrap");
    const stageEl = document.getElementById("watch-embed-stage");
    const noticeEl = document.getElementById("watch-spotify-session-bar");
    const transportEl = document.getElementById("watch-transport");

    const rectObj = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      if (cs.display === "none") return null;
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
      };
    };

    const stageWrapRect = rectObj(stageWrapEl);
    const stageRect = rectObj(stageEl);
    const noticeRect = rectObj(noticeEl);
    const transportRect = rectObj(transportEl);

    let noticeOverlapsTransport = false;
    if (noticeRect && transportRect) {
      const ow = Math.min(noticeRect.right, transportRect.right) - Math.max(noticeRect.left, transportRect.left);
      const oh = Math.min(noticeRect.bottom, transportRect.bottom) - Math.max(noticeRect.top, transportRect.top);
      noticeOverlapsTransport = ow > 1.5 && oh > 1.5;
    }

    // 4. Chat feed & composer usability
    const logFeedRect = rectObj(document.getElementById("log-feed"));
    const composerRect = rectObj(document.getElementById("chat-composer-dropzone"));
    const chatInputRect = rectObj(document.getElementById("chat-text-input"));
    const sendBtnRect = rectObj(document.getElementById("btn-send-chat"));

    return {
      vw,
      vh,
      scrollWidth,
      advMode,
      inRoom,
      advTotalCount: advEls.length,
      leakedAdvanced,
      topbarControlCount: topbarControls.length,
      topbarOverlaps,
      topbarClipped,
      watchVisible,
      watchMinimized,
      isSideEligible,
      isSideBySideActive,
      stageWrapRect,
      stageRect,
      noticeRect,
      transportRect,
      noticeOverlapsTransport,
      logFeedRect,
      composerRect,
      chatInputRect,
      sendBtnRect,
    };
  })()`);
}

function collectCellViolations(vp, cellName, geom, expectations = {}) {
  const ctx = `[${vp.name} / ${cellName}]`;
  const violations = [];

  if (!(geom.scrollWidth <= geom.vw)) {
    violations.push(
      `${ctx} Horizontal overflow: scrollWidth=${geom.scrollWidth} > innerWidth=${geom.vw}`
    );
  }
  if (!(geom.topbarControlCount >= 2)) {
    violations.push(`${ctx} Expected >= 2 visible topbar controls, got ${geom.topbarControlCount}`);
  }
  if (geom.topbarOverlaps.length > 0) {
    violations.push(
      `${ctx} Pairwise overlap in header.topbar: ${JSON.stringify(geom.topbarOverlaps)}`
    );
  }
  if (geom.topbarClipped.length > 0) {
    violations.push(
      `${ctx} Clipped controls in header.topbar: ${JSON.stringify(geom.topbarClipped)}`
    );
  }

  if (!geom.advMode) {
    if (!(geom.advTotalCount > 0)) {
      violations.push(`${ctx} Expected .advanced-only elements in DOM`);
    }
    if (geom.leakedAdvanced.length > 0) {
      violations.push(
        `${ctx} .advanced-only elements visible in Normal Mode: ${JSON.stringify(geom.leakedAdvanced)}`
      );
    }
  }

  if (expectations.watchExpanded) {
    if (!geom.watchVisible || geom.watchMinimized) {
      violations.push(
        `${ctx} Expected expanded #watch-panel (visible=${geom.watchVisible}, minimized=${geom.watchMinimized})`
      );
    } else if (!geom.stageRect) {
      violations.push(`${ctx} Expected .watch-embed-stage visible`);
    } else {
      const minStageH = expectations.minStageHeight;
      if (geom.stageRect.height < minStageH) {
        violations.push(
          `${ctx} .watch-embed-stage collapsed: height=${geom.stageRect.height.toFixed(1)}px < ${minStageH}px`
        );
      }
      if (geom.stageRect.width < 180) {
        violations.push(
          `${ctx} .watch-embed-stage width too narrow: ${geom.stageRect.width.toFixed(1)}px`
        );
      }
    }
  }

  if (expectations.noticeVisible) {
    if (!geom.noticeRect) {
      violations.push(`${ctx} Expected provider notice bar visible`);
    } else {
      if (geom.noticeRect.height < 24) {
        violations.push(
          `${ctx} Notice bar collapsed to ${geom.noticeRect.height.toFixed(1)}px`
        );
      }
      if (geom.noticeOverlapsTransport) {
        violations.push(`${ctx} Notice bar overlaps .watch-transport`);
      }
      if (geom.stageRect && geom.stageRect.bottom > geom.noticeRect.top + 1.5) {
        violations.push(
          `${ctx} Notice bar overlaps .watch-embed-stage (stageBottom=${geom.stageRect.bottom.toFixed(1)}, noticeTop=${geom.noticeRect.top.toFixed(1)})`
        );
      }
    }
  }

  if (expectations.watchMinimized) {
    if (!geom.watchVisible || !geom.watchMinimized) {
      violations.push(
        `${ctx} Expected minimized #watch-panel (visible=${geom.watchVisible}, minimized=${geom.watchMinimized})`
      );
    }
    // Minimized stage collapses wrapper height to 0 (overflow:hidden) while keeping iframe mounted for audio
    if (geom.stageWrapRect && geom.stageWrapRect.height > 1) {
      violations.push(
        `${ctx} Minimized #watch-stage-wrap should collapse to 0px height, got ${geom.stageWrapRect.height.toFixed(1)}px`
      );
    }
    if (geom.noticeRect !== null) {
      violations.push(`${ctx} Minimized notice bar should be hidden`);
    }
  }

  if (expectations.checkChatUsable) {
    if (!geom.logFeedRect || geom.logFeedRect.height < 40) {
      violations.push(
        `${ctx} #log-feed collapsed: height=${geom.logFeedRect ? geom.logFeedRect.height.toFixed(1) : "null"}px < 40px`
      );
    }
    if (!geom.composerRect || geom.composerRect.height < 40) {
      violations.push(
        `${ctx} Composer collapsed: height=${geom.composerRect ? geom.composerRect.height.toFixed(1) : "null"}px < 40px`
      );
    }
    if (!geom.chatInputRect || geom.chatInputRect.width < 60 || geom.chatInputRect.height < 24) {
      violations.push(
        `${ctx} Chat text input unusable: ${JSON.stringify(geom.chatInputRect)}`
      );
    }
    if (!geom.sendBtnRect || geom.sendBtnRect.width < 36 || geom.sendBtnRect.height < 24) {
      violations.push(
        `${ctx} Chat Send button unusable: ${JSON.stringify(geom.sendBtnRect)}`
      );
    }
  }

  return violations;
}

test("6-Viewport Crowded-UI Layout Matrix across Lobby, Room, Voice, Advanced, and Watch states", async (t) => {
  const mqttBroker = await startLocalMqttBroker();
  const staticServer = await startStaticServer({ rootDir: ROOT_DIR });
  const browser = await launchChrome();

  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      initScripts: [INIT_NO_STUN],
      stubEmbeds: true,
    });

    try {
      const entryUrl = `${staticServer.url}?relay=${encodeURIComponent(mqttBroker.url)}`;
      await page.goto(entryUrl);
      await waitForAppReady(page);
      await page.evaluate("document.fonts?.ready");

      // Phase 1: Lobby cells (Normal + Advanced, crowded topbar) across all 6 viewports
      await t.test("Lobby (Normal & Advanced, 32-char name + Install button) across 6 viewports", async () => {
        const violations = [];
        for (const vp of VIEWPORTS) {
          await page.setViewport({
            width: vp.width,
            height: vp.height,
            deviceScaleFactor: 1,
            mobile: vp.mobile,
          });

          for (const advanced of [false, true]) {
            await applyCrowdedHeaderAndVoice(page, { inRoom: false, advanced });
            await flushLayout(page);
            const geom = await inspectCellGeometry(page);
            violations.push(...collectCellViolations(vp, advanced ? "lobby-advanced" : "lobby-normal", geom));
          }
        }
        assert.deepEqual(violations, [], `Lobby layout violations:\n${violations.join("\n")}`);
      });

      // Transition into a real room and seed chat messages + media cards
      await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await applyCrowdedHeaderAndVoice(page, { inRoom: false, advanced: false });
      await page.fill("#lobby-room-name-input", "Layout Stress Room");
      await page.evaluate(`document.getElementById("lobby-create-form").requestSubmit()`);
      await page.waitFor(
        `document.documentElement.getAttribute("data-in-room") === "true"`,
        { timeoutMs: 10000, label: "Enter room for layout matrix" }
      );

      // Post sample chat + YouTube, Spotify, and SoundCloud links into the room chat
      const ytUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const spUrl = "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT";
      const scUrl = "https://soundcloud.com/stubartist/stub-snip-track";
      for (const text of [
        "Layout matrix chat line #1 — verifying log feed height and wrapping cleanly.",
        "Layout matrix chat line #2 — checking crowded voice + watch + composer coexistence.",
        ytUrl,
        spUrl,
        scUrl,
      ]) {
        await page.fill("#chat-text-input", text);
        await page.evaluate(`document.getElementById("chat-composer-form").requestSubmit()`);
      }

      await page.waitFor(
        `Boolean(document.querySelector('[data-watch-play*="dQw4w9WgXcQ"]')) &&
         Boolean(document.querySelector('[data-watch-play*="open.spotify.com"]')) &&
         Boolean(document.querySelector('[data-watch-play*="soundcloud.com"]'))`,
        { timeoutMs: 10000, label: "All 3 provider watch cards rendered" }
      );

      // Phase 2: In-Room (No Watch, Normal + Advanced, 4 Voice tiles + voice chip) across 6 viewports
      await t.test("In-Room with 4 Voice tiles + crowded header (Normal & Advanced) across 6 viewports", async () => {
        const violations = [];
        for (const vp of VIEWPORTS) {
          await page.setViewport({
            width: vp.width,
            height: vp.height,
            deviceScaleFactor: 1,
            mobile: vp.mobile,
          });
          for (const advanced of [false, true]) {
            await applyCrowdedHeaderAndVoice(page, { inRoom: true, advanced });
            await flushLayout(page);
            const geom = await inspectCellGeometry(page);
            violations.push(
              ...collectCellViolations(vp, advanced ? "room-advanced-voice" : "room-normal-voice", geom, {
                checkChatUsable: true,
              })
            );
          }
        }
        assert.deepEqual(violations, [], `In-Room layout violations:\n${violations.join("\n")}`);
      });

      // Phase 3: YouTube 16:9 theater + notice banner + queue (Normal & Advanced) across 6 viewports
      await t.test("Watch YouTube 16:9 theater + notice banner + queue (Normal & Advanced) across 6 viewports", async () => {
        await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await page.click('[data-watch-play*="dQw4w9WgXcQ"]');
        await page.waitFor(
          `document.getElementById("watch-panel")?.classList.contains("provider-youtube") &&
           !document.getElementById("watch-panel")?.classList.contains("hidden")`,
          { timeoutMs: 10000, label: "YouTube watch panel active" }
        );

        const violations = [];
        for (const vp of VIEWPORTS) {
          await page.setViewport({
            width: vp.width,
            height: vp.height,
            deviceScaleFactor: 1,
            mobile: vp.mobile,
          });
          for (const advanced of [false, true]) {
            await applyCrowdedHeaderAndVoice(page, { inRoom: true, advanced });
            await injectNoticeAndQueue(page, {
              provider: "youtube",
              tag: "YOUTUBE NOTICE",
              text: "Region or embed notice — Reload locally or open directly on YouTube.",
              queueCount: 3,
            });
            await flushLayout(page);
            const geom = await inspectCellGeometry(page);
            // Landscape phone (max-height: 520px) intentionally compacts theater stage min-height to 144px;
            // all standard-height viewports (360x640, 390x844, 1024x768, 1280x800, 1920x1080) >= 200px.
            const minStageHeight = vp.shortLandscape ? 140 : 200;
            violations.push(
              ...collectCellViolations(
                vp,
                advanced ? "watch-yt-theater-advanced" : "watch-yt-theater-normal",
                geom,
                {
                  watchExpanded: true,
                  minStageHeight,
                  noticeVisible: true,
                  checkChatUsable: true,
                }
              )
            );
          }
        }
        assert.deepEqual(violations, [], `YouTube theater layout violations:\n${violations.join("\n")}`);
      });

      // Phase 4: Spotify single 152px + SPOTIFY SESSION banner (Normal & Advanced) across 6 viewports
      await t.test("Watch Spotify single (152px) + session banner across 6 viewports", async () => {
        await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await page.evaluate("window.__STUB_SPOTIFY_PREVIEW__ = true;");
        await page.click('[data-watch-play*="open.spotify.com"]');
        await page.waitFor(
          `document.getElementById("watch-panel")?.classList.contains("provider-spotify")`,
          { timeoutMs: 10000, label: "Spotify watch panel active" }
        );

        const violations = [];
        for (const vp of VIEWPORTS) {
          await page.setViewport({
            width: vp.width,
            height: vp.height,
            deviceScaleFactor: 1,
            mobile: vp.mobile,
          });
          for (const advanced of [false, true]) {
            await applyCrowdedHeaderAndVoice(page, { inRoom: true, advanced });
            await injectNoticeAndQueue(page, {
              provider: "spotify",
              tag: "SPOTIFY SESSION",
              text: "Playing 30s preview — Sign in at open.spotify.com in this browser, then click Reload Session.",
              queueCount: 0,
            });
            await flushLayout(page);
            const geom = await inspectCellGeometry(page);
            violations.push(
              ...collectCellViolations(
                vp,
                advanced ? "watch-spotify-single-advanced" : "watch-spotify-single-normal",
                geom,
                {
                  watchExpanded: true,
                  minStageHeight: 148,
                  noticeVisible: true,
                  checkChatUsable: true,
                }
              )
            );
          }
        }
        assert.deepEqual(violations, [], `Spotify single layout violations:\n${violations.join("\n")}`);
      });

      // Phase 5: SoundCloud single + SNIP banner (Normal & Advanced) across 6 viewports
      await t.test("Watch SoundCloud + SNIP banner across 6 viewports", async () => {
        await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await page.evaluate(`window.__STUB_SC_CONFIG__ = { policy: "SNIP", duration: 30000, full_duration: 180000 };`);
        await page.click('[data-watch-play*="soundcloud.com"]');
        await page.waitFor(
          `document.getElementById("watch-panel")?.classList.contains("provider-soundcloud")`,
          { timeoutMs: 10000, label: "SoundCloud watch panel active" }
        );

        const violations = [];
        for (const vp of VIEWPORTS) {
          await page.setViewport({
            width: vp.width,
            height: vp.height,
            deviceScaleFactor: 1,
            mobile: vp.mobile,
          });
          for (const advanced of [false, true]) {
            await applyCrowdedHeaderAndVoice(page, { inRoom: true, advanced });
            await injectNoticeAndQueue(page, {
              provider: "soundcloud",
              tag: "SOUNDCLOUD SNIP",
              text: "30s Go+ preview — Full track requires SoundCloud Go+ or opening on SoundCloud.",
              queueCount: 0,
            });
            await flushLayout(page);
            const geom = await inspectCellGeometry(page);
            violations.push(
              ...collectCellViolations(
                vp,
                advanced ? "watch-soundcloud-snip-advanced" : "watch-soundcloud-snip-normal",
                geom,
                {
                  watchExpanded: true,
                  minStageHeight: 120,
                  noticeVisible: true,
                  checkChatUsable: true,
                }
              )
            );
          }
        }
        assert.deepEqual(violations, [], `SoundCloud SNIP layout violations:\n${violations.join("\n")}`);
      });

      // Phase 6: Watch Minimized (Normal & Advanced) across 6 viewports
      await t.test("Watch Minimized across 6 viewports", async () => {
        await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await page.click("#btn-watch-minimize");
        await page.waitFor(
          `document.getElementById("watch-panel")?.classList.contains("is-minimized")`,
          { timeoutMs: 5000, label: "Watch panel minimized" }
        );

        const violations = [];
        for (const vp of VIEWPORTS) {
          await page.setViewport({
            width: vp.width,
            height: vp.height,
            deviceScaleFactor: 1,
            mobile: vp.mobile,
          });
          for (const advanced of [false, true]) {
            await applyCrowdedHeaderAndVoice(page, { inRoom: true, advanced });
            await flushLayout(page);
            const geom = await inspectCellGeometry(page);
            violations.push(
              ...collectCellViolations(
                vp,
                advanced ? "watch-minimized-advanced" : "watch-minimized-normal",
                geom,
                {
                  watchMinimized: true,
                  checkChatUsable: true,
                }
              )
            );
          }
        }
        assert.deepEqual(violations, [], `Watch minimized layout violations:\n${violations.join("\n")}`);
      });

      assert.deepEqual(
        page.pageErrors,
        [],
        `Zero uncaught pageerror exceptions expected across entire layout matrix, got: ${JSON.stringify(page.pageErrors)}`
      );
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
    await staticServer.close();
    await mqttBroker.close();
  }
});
