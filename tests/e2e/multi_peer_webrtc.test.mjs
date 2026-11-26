/**
 * Layer 4 Real Multi-Tab Chromium E2E Tests:
 *   a) 3-peer isolated WebRTC DataChannel mesh + matching E2EE safety codes & peer count
 *   b) Real E2EE chat message delivery across peers
 *   c) Watch Together sync across tabs (YouTube + SoundCloud from chat links, play/pause/seek,
 *      and local-only `↻ Reload` on Peer B without disrupting Peer A)
 *   d) Live Service Worker update lifecycle (dynamically reading `vN` from `sw.js`, checking
 *      Normal vs Advanced visibility, bumping `vN` -> `v(N+1)` via static_server hook,
 *      verifying ochre `Update v(N+1)` / `Reload`, clicking Reload, and asserting clean activation)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mqttTopicMatches, startLocalMqttBroker } from "./local_mqtt_broker.mjs";
import { startStaticServer } from "./static_server.mjs";
import { launchChrome } from "./cdp_client.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INIT_NO_STUN = "window.__P2P_ICE_SERVERS__ = [];";

function readCurrentSwVersion() {
  const swSource = readFileSync(join(ROOT_DIR, "sw.js"), "utf8");
  const match = swSource.match(/const\s+CACHE_NAME\s*=\s*"p2p-direct-shell-v(\d+)"\s*;/);
  assert.ok(match, "sw.js must define CACHE_NAME = 'p2p-direct-shell-v<N>'");
  const num = Number(match[1]);
  assert.ok(Number.isInteger(num) && num > 0, `Invalid SW version number: ${match[1]}`);
  return {
    num,
    current: `v${num}`,
    next: `v${num + 1}`,
  };
}

async function waitForAppReady(page, label = "app ready") {
  await page.waitFor(
    `(() => {
      const pid = document.getElementById("peer-id-display")?.textContent?.trim() || "";
      return pid.length > 0 && pid !== "loading…" && pid !== "loading...";
    })()`,
    { timeoutMs: 15000, label }
  );
}

test("Real multi-tab Chromium E2E: WebRTC mesh, E2EE chat, Watch Together, and live SW update", async (t) => {
  const mqttBroker = await startLocalMqttBroker();
  const staticServer = await startStaticServer({ rootDir: ROOT_DIR });
  const browser = await launchChrome();

  const peerPages = [];
  try {
    let roomUrl = "";

    await t.test("0) Local MQTT 3.1.1 broker handles CONNECT/SUBSCRIBE/PUBLISH(+/#)/PINGREQ/UNSUBSCRIBE/DISCONNECT", async () => {
      assert.equal(mqttTopicMatches("p2pdirect/v1/abc", "p2pdirect/v1/abc"), true);
      assert.equal(mqttTopicMatches("p2pdirect/+/abc", "p2pdirect/v1/abc"), true);
      assert.equal(mqttTopicMatches("p2pdirect/+/abc", "p2pdirect/v1/def"), false);
      assert.equal(mqttTopicMatches("p2pdirect/#", "p2pdirect/v1/abc/def"), true);
      assert.equal(mqttTopicMatches("a/b/#", "a/b"), true);
      assert.equal(mqttTopicMatches("#", "$SYS/broker/load"), false);
      assert.equal(mqttTopicMatches("+/load", "$SYS/load"), false);

      const ws = new WebSocket(mqttBroker.url, "mqtt");
      ws.binaryType = "arraybuffer";
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("MQTT WebSocket connect failed"));
      });
      const rx = [];
      ws.onmessage = (ev) => rx.push(new Uint8Array(ev.data));
      const waitCount = async (n) => {
        const deadline = Date.now() + 3000;
        while (rx.length < n && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.ok(rx.length >= n, `Expected >= ${n} MQTT packets, got ${rx.length}`);
      };

      // CONNECT (MQTT 3.1.1, CleanSession=1, KeepAlive=30, clientId="t1")
      ws.send(new Uint8Array([0x10, 14, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 2, 0, 30, 0, 2, 0x74, 0x31]));
      await waitCount(1);
      assert.equal((rx[0][0] >> 4) & 0x0f, 2, "Expected CONNACK");

      // SUBSCRIBE "p2pdirect/+/probe"
      const filter = new TextEncoder().encode("p2pdirect/+/probe");
      const sub = new Uint8Array(2 + 2 + 2 + filter.length + 1);
      sub[0] = 0x82;
      sub[1] = 2 + 2 + filter.length + 1;
      sub[2] = 0;
      sub[3] = 1;
      sub[4] = 0;
      sub[5] = filter.length;
      sub.set(filter, 6);
      sub[6 + filter.length] = 0;
      ws.send(sub);
      await waitCount(2);
      assert.equal((rx[1][0] >> 4) & 0x0f, 9, "Expected SUBACK");

      // PUBLISH QoS 0 to "p2pdirect/v1/probe" -> matches wildcard '+'
      const topic = new TextEncoder().encode("p2pdirect/v1/probe");
      const pub = new Uint8Array(2 + 2 + topic.length + 2);
      pub[0] = 0x30;
      pub[1] = 2 + topic.length + 2;
      pub[2] = 0;
      pub[3] = topic.length;
      pub.set(topic, 4);
      pub[4 + topic.length] = 0x4f;
      pub[5 + topic.length] = 0x4b;
      ws.send(pub);
      await waitCount(3);
      assert.equal((rx[2][0] >> 4) & 0x0f, 3, "Expected wildcard-matched PUBLISH");

      // PINGREQ -> PINGRESP
      ws.send(new Uint8Array([0xc0, 0x00]));
      await waitCount(4);
      assert.equal((rx[3][0] >> 4) & 0x0f, 13, "Expected PINGRESP");

      // UNSUBSCRIBE -> UNSUBACK
      const unsub = new Uint8Array(2 + 2 + 2 + filter.length);
      unsub[0] = 0xa2;
      unsub[1] = 2 + 2 + filter.length;
      unsub[2] = 0;
      unsub[3] = 2;
      unsub[4] = 0;
      unsub[5] = filter.length;
      unsub.set(filter, 6);
      ws.send(unsub);
      await waitCount(5);
      assert.equal((rx[4][0] >> 4) & 0x0f, 11, "Expected UNSUBACK");

      // DISCONNECT
      const closedPromise = new Promise((resolve) => {
        ws.onclose = resolve;
      });
      ws.send(new Uint8Array([0xe0, 0x00]));
      await closedPromise;
      assert.ok(mqttBroker.stats.disconnectPackets >= 1, "Broker should record DISCONNECT");
    });

    await t.test("a & b) 3-peer real WebRTC DataChannel mesh, matching E2EE fingerprints, and E2EE chat", async () => {
      const peerA = await browser.newPage({ initScripts: [INIT_NO_STUN] });
      const peerB = await browser.newPage({ initScripts: [INIT_NO_STUN] });
      const peerC = await browser.newPage({ initScripts: [INIT_NO_STUN] });
      peerPages.push(peerA, peerB, peerC);

      const entryUrl = `${staticServer.url}?relay=${encodeURIComponent(mqttBroker.url)}`;
      await peerA.goto(entryUrl);
      await waitForAppReady(peerA, "Peer A WASM init");

      // Set Alice's display name and create room via Lobby form
      await peerA.fill("#author-name-input", "Alice");
      await peerA.fill("#lobby-room-name-input", "E2E Mesh Room");
      await peerA.evaluate(`document.getElementById("lobby-create-form").requestSubmit()`);

      await peerA.waitFor(
        `document.documentElement.getAttribute("data-in-room") === "true" && /#room=P2P1:/i.test(window.location.hash)`,
        { timeoutMs: 10000, label: "Peer A creates room" }
      );
      roomUrl = await peerA.evaluate("window.location.href");
      assert.match(roomUrl, /relay=/, "Room URL should preserve local ?relay= query param");
      assert.match(roomUrl, /#room=P2P1:/i, "Room URL should contain P2P1 invite hash");

      // Join Peer B and Peer C in isolated browser contexts
      await Promise.all([peerB.goto(roomUrl), peerC.goto(roomUrl)]);
      await Promise.all([
        waitForAppReady(peerB, "Peer B WASM init"),
        waitForAppReady(peerC, "Peer C WASM init"),
      ]);
      await peerB.fill("#author-name-input", "Bob");
      await peerC.fill("#author-name-input", "Carol");

      // Wait for full 3-peer Direct WebRTC DataChannel mesh convergence (each peer sees 2 Direct P2P peers)
      await Promise.all(
        [
          ["Peer A", peerA],
          ["Peer B", peerB],
          ["Peer C", peerC],
        ].map(([name, page]) =>
          page.waitFor(
            `Number(document.getElementById("peer-count-display")?.textContent?.trim()) === 2 &&
             /2\\s+Direct\\s+P2P/i.test(document.getElementById("topology-summary")?.textContent || "")`,
            { timeoutMs: 20000, label: `${name} reaches 2 Direct P2P WebRTC peers` }
          )
        )
      );

      // Verify all 3 peers converged to identical room E2EE fingerprints, matching pairwise X25519
      // safety codes, and direct WebRTC DataChannels
      const snapshots = await Promise.all(
        [peerA, peerB, peerC].map((page) =>
          page.evaluate(`(() => {
            const peerId = document.getElementById("peer-id-display")?.textContent?.trim() || "";
            const fp = document.getElementById("key-fp-display")?.textContent?.trim() || "";
            const peerCount = Number(document.getElementById("peer-count-display")?.textContent?.trim() || "0");
            const topo = document.getElementById("topology-summary")?.textContent?.trim() || "";
            const safetyByPeer = {};
            for (const li of document.querySelectorAll("#peer-list li")) {
              const txt = li.textContent || "";
              const pidMatch = txt.match(/\\b(p-[0-9a-f]{12})\\b/i);
              const codeMatch = txt.match(/code\\s+([0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4})/i);
              if (pidMatch && codeMatch) safetyByPeer[pidMatch[1]] = codeMatch[1];
            }
            const statusText = document.getElementById("simple-room-badge")?.textContent?.trim() || "";
            return { peerId, fp, peerCount, topo, safetyByPeer, statusText };
          })()`)
        )
      );

      assert.ok(snapshots[0].fp && snapshots[0].fp !== "…", "E2EE room fingerprint must be populated");
      assert.equal(snapshots[1].fp, snapshots[0].fp, "Peer B E2EE room fingerprint must match Peer A");
      assert.equal(snapshots[2].fp, snapshots[0].fp, "Peer C E2EE room fingerprint must match Peer A");
      for (let i = 0; i < snapshots.length; i++) {
        assert.match(snapshots[i].topo, /2\s+Direct\s+P2P/i, `Peer ${i} must use Direct WebRTC DataChannels`);
        for (let j = i + 1; j < snapshots.length; j++) {
          const codeIJ = snapshots[i].safetyByPeer[snapshots[j].peerId];
          const codeJI = snapshots[j].safetyByPeer[snapshots[i].peerId];
          assert.ok(codeIJ, `Missing pairwise safety code between peer ${i} and peer ${j}`);
          assert.equal(
            codeIJ,
            codeJI,
            `Pairwise X25519 safety codes must match between peer ${i} and peer ${j}`
          );
        }
      }
      assert.ok(
        mqttBroker.stats.publishPackets > 0,
        "Isolated browser contexts must rendezvous over the local MQTT broker"
      );

      // Real E2EE chat delivery across all 3 tabs
      const msgFromA = "Encrypted hello from Alice to the 3-peer mesh!";
      await peerA.fill("#chat-text-input", msgFromA);
      await peerA.evaluate(`document.getElementById("chat-composer-form").requestSubmit()`);

      await Promise.all([
        peerB.waitFor(
          `document.getElementById("log-feed")?.textContent?.includes(${JSON.stringify(msgFromA)})`,
          { timeoutMs: 10000, label: "Peer B receives Alice's E2EE chat message" }
        ),
        peerC.waitFor(
          `document.getElementById("log-feed")?.textContent?.includes(${JSON.stringify(msgFromA)})`,
          { timeoutMs: 10000, label: "Peer C receives Alice's E2EE chat message" }
        ),
      ]);

      const msgFromB = "Bob confirms direct E2EE delivery!";
      await peerB.fill("#chat-text-input", msgFromB);
      await peerB.evaluate(`document.getElementById("chat-composer-form").requestSubmit()`);

      await Promise.all([
        peerA.waitFor(
          `document.getElementById("log-feed")?.textContent?.includes(${JSON.stringify(msgFromB)})`,
          { timeoutMs: 10000, label: "Peer A receives Bob's reply" }
        ),
        peerC.waitFor(
          `document.getElementById("log-feed")?.textContent?.includes(${JSON.stringify(msgFromB)})`,
          { timeoutMs: 10000, label: "Peer C receives Bob's reply" }
        ),
      ]);

      for (const [label, page] of [
        ["Peer A", peerA],
        ["Peer B", peerB],
        ["Peer C", peerC],
      ]) {
        assert.deepEqual(page.pageErrors, [], `${label} had uncaught page errors`);
      }
    });

    await t.test("c) Watch Together sync across tabs + local-only Reload isolation", async () => {
      const [peerA, peerB, peerC] = peerPages;

      // 1. Peer A posts a YouTube link in chat and starts Watch Together from the chat media card
      const ytUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      await peerA.fill("#chat-text-input", `Watch this together ${ytUrl}`);
      await peerA.evaluate(`document.getElementById("chat-composer-form").requestSubmit()`);

      await peerA.waitFor(
        `Boolean(document.querySelector('[data-watch-play*="dQw4w9WgXcQ"]'))`,
        { timeoutMs: 8000, label: "YouTube Watch card rendered in chat" }
      );
      await peerA.click('[data-watch-play*="dQw4w9WgXcQ"]');

      // All 3 tabs mount the stub YouTube player and begin playing
      await Promise.all(
        [
          ["Peer A", peerA],
          ["Peer B", peerB],
          ["Peer C", peerC],
        ].map(([name, page]) =>
          page.waitFor(
            `(() => {
              const panel = document.getElementById("watch-panel");
              const yt = window.__STUB_YT_PLAYERS__?.at(-1);
              return Boolean(
                panel &&
                !panel.classList.contains("hidden") &&
                panel.classList.contains("provider-youtube") &&
                yt &&
                yt.getPlayerState() === 1
              );
            })()`,
            { timeoutMs: 12000, label: `${name} mounts & plays YouTube Watch Together` }
          )
        )
      );

      // 2. Peer A seeks forward (+10s twice -> >= 18s) and Peer B & C follow
      await peerA.click("#btn-watch-fwd10");
      await new Promise((r) => setTimeout(r, 120));
      await peerA.click("#btn-watch-fwd10");

      await Promise.all(
        [
          ["Peer B", peerB],
          ["Peer C", peerC],
        ].map(([name, page]) =>
          page.waitFor(
            `(window.__STUB_YT_PLAYERS__?.at(-1)?.getCurrentTime() || 0) >= 16`,
            { timeoutMs: 10000, label: `${name} syncs +20s seek from Peer A` }
          )
        )
      );

      // 3. Peer A pauses -> Peer B & C pause
      await peerA.click("#btn-watch-play");
      await Promise.all(
        [
          ["Peer A", peerA],
          ["Peer B", peerB],
          ["Peer C", peerC],
        ].map(([name, page]) =>
          page.waitFor(
            `window.__STUB_YT_PLAYERS__?.at(-1)?.getPlayerState() === 2 &&
             document.getElementById("btn-watch-play")?.textContent?.includes("Play")`,
            { timeoutMs: 10000, label: `${name} pauses in sync` }
          )
        )
      );

      // 4. Peer B resumes -> Peer A & C resume
      await peerB.click("#btn-watch-play");
      await Promise.all(
        [
          ["Peer A", peerA],
          ["Peer B", peerB],
          ["Peer C", peerC],
        ].map(([name, page]) =>
          page.waitFor(
            `window.__STUB_YT_PLAYERS__?.at(-1)?.getPlayerState() === 1 &&
             document.getElementById("btn-watch-play")?.textContent?.includes("Pause")`,
            { timeoutMs: 10000, label: `${name} resumes in sync` }
          )
        )
      );

      // 5. Local-only `↻ Reload` on Peer B must NOT disrupt Peer A's playback!
      const peerABefore = await peerA.evaluate(`(() => {
        const yt = window.__STUB_YT_PLAYERS__.at(-1);
        return {
          playerCount: window.__STUB_YT_PLAYERS__.length,
          state: yt.getPlayerState(),
          timeSec: yt.getCurrentTime(),
          pauseCalls: yt.calls.filter((c) => c[0] === "pauseVideo").length,
          seekCalls: yt.calls.filter((c) => c[0] === "seekTo").length,
        };
      })()`);
      const peerBPlayerCountBefore = await peerB.evaluate("window.__STUB_YT_PLAYERS__.length");

      await peerB.click("#btn-watch-spotify-reload");

      // Wait for Peer B to tear down & recreate a fresh YouTube stub player and resync to Playing
      await peerB.waitFor(
        `window.__STUB_YT_PLAYERS__.length > ${peerBPlayerCountBefore} &&
         window.__STUB_YT_PLAYERS__.at(-1).getPlayerState() === 1 &&
         window.__STUB_YT_PLAYERS__.at(-1).getCurrentTime() >= 16`,
        { timeoutMs: 10000, label: "Peer B reloads locally and resyncs to room" }
      );

      // Let 600ms pass to verify Peer B's reload never leaked a pause/rewind to Peer A
      await new Promise((r) => setTimeout(r, 600));

      const peerAAfter = await peerA.evaluate(`(() => {
        const yt = window.__STUB_YT_PLAYERS__.at(-1);
        return {
          playerCount: window.__STUB_YT_PLAYERS__.length,
          state: yt.getPlayerState(),
          timeSec: yt.getCurrentTime(),
          pauseCalls: yt.calls.filter((c) => c[0] === "pauseVideo").length,
          seekCalls: yt.calls.filter((c) => c[0] === "seekTo").length,
        };
      })()`);

      assert.equal(
        peerAAfter.playerCount,
        peerABefore.playerCount,
        "Peer B local Reload must not remount Peer A's player"
      );
      assert.equal(peerAAfter.state, 1, "Peer A must remain continuously Playing during Peer B Reload");
      assert.equal(
        peerAAfter.pauseCalls,
        peerABefore.pauseCalls,
        "Peer B local Reload must not trigger pauseVideo() on Peer A"
      );
      assert.equal(
        peerAAfter.seekCalls,
        peerABefore.seekCalls,
        "Peer B local Reload must not trigger seekTo() rollback on Peer A"
      );
      assert.ok(
        peerAAfter.timeSec >= peerABefore.timeSec,
        `Peer A playhead must advance monotonically (${peerABefore.timeSec.toFixed(2)}s -> ${peerAAfter.timeSec.toFixed(2)}s)`
      );

      // 6. Switch to a SoundCloud link posted in chat by Peer C and verify synced play & pause
      const scUrl = "https://soundcloud.com/stubartist/stub-track";
      await peerC.fill("#chat-text-input", `SoundCloud check ${scUrl}`);
      await peerC.evaluate(`document.getElementById("chat-composer-form").requestSubmit()`);

      await peerC.waitFor(
        `Boolean(document.querySelector('[data-watch-play*="soundcloud.com/stubartist/stub-track"]'))`,
        { timeoutMs: 8000, label: "SoundCloud Watch card rendered in chat" }
      );
      await peerC.click('[data-watch-play*="soundcloud.com/stubartist/stub-track"]');

      await Promise.all(
        [
          ["Peer A", peerA],
          ["Peer B", peerB],
          ["Peer C", peerC],
        ].map(([name, page]) =>
          page.waitFor(
            `(() => {
              const panel = document.getElementById("watch-panel");
              const w = window.__STUB_SC_WIDGETS__?.at(-1);
              return Boolean(
                panel &&
                panel.classList.contains("provider-soundcloud") &&
                w &&
                w.paused === false
              );
            })()`,
            { timeoutMs: 12000, label: `${name} mounts & plays SoundCloud Watch Together` }
          )
        )
      );

      // Pause SoundCloud on Peer C -> verify Peer A & Peer B pause
      await peerC.click("#btn-watch-play");
      await Promise.all(
        [
          ["Peer A", peerA],
          ["Peer B", peerB],
        ].map(([name, page]) =>
          page.waitFor(
            `window.__STUB_SC_WIDGETS__?.at(-1)?.paused === true`,
            { timeoutMs: 10000, label: `${name} pauses SoundCloud in sync` }
          )
        )
      );

      for (const [label, page] of [
        ["Peer A", peerA],
        ["Peer B", peerB],
        ["Peer C", peerC],
      ]) {
        assert.deepEqual(page.pageErrors, [], `${label} had uncaught page errors during Watch Together`);
      }
    });

    await t.test("d) Live Service Worker version visibility, update detection, and clean reload activation", async () => {
      const { current: curVer, next: nextVer } = readCurrentSwVersion();
      const swPage = await browser.newPage({ initScripts: [INIT_NO_STUN], stubEmbeds: false });

      try {
        await swPage.goto(staticServer.url);
        await waitForAppReady(swPage, "SW test page init");

        // Wait for real Service Worker registration & clients.claim()
        await swPage.waitFor(
          `Boolean(navigator.serviceWorker && navigator.serviceWorker.controller)`,
          { timeoutMs: 15000, label: "Service Worker controller claims page" }
        );

        // Verify Normal Mode hides #app-version-chip and #adv-version-footer
        const normalVis = await swPage.evaluate(`(() => {
          const adv = document.documentElement.getAttribute("data-advanced");
          const chipDisplay = getComputedStyle(document.getElementById("app-version-chip")).display;
          const footerDisplay = getComputedStyle(document.getElementById("adv-version-footer")).display;
          return { adv, chipDisplay, footerDisplay };
        })()`);
        assert.equal(normalVis.adv, "false", "App should start in Normal Mode");
        assert.equal(normalVis.chipDisplay, "none", "#app-version-chip must be hidden in Normal Mode");
        assert.equal(normalVis.footerDisplay, "none", "#adv-version-footer must be hidden in Normal Mode");

        // Enable Advanced Mode and verify synced SW vN indicator
        await swPage.click("#btn-advanced-toggle");

        const syncedInfo = await swPage.waitFor(
          `(() => {
            const chip = document.getElementById("app-version-chip");
            const footer = document.getElementById("adv-version-footer");
            const swText = document.getElementById("adv-version-sw")?.textContent?.trim();
            const chipVer = document.getElementById("app-version-display")?.textContent?.trim();
            const footVer = document.getElementById("adv-version-number")?.textContent?.trim();
            const btnText = document.getElementById("btn-version-action")?.textContent?.trim();
            if (swText !== ${JSON.stringify(`SW ${curVer}`)}) return null;
            return {
              chipDisplay: getComputedStyle(chip).display,
              footerDisplay: getComputedStyle(footer).display,
              chipSynced: chip.classList.contains("is-synced"),
              footerSynced: footer.classList.contains("is-synced"),
              chipVer,
              footVer,
              swText,
              btnText,
            };
          })()`,
          { timeoutMs: 15000, label: `Advanced Mode shows synced SW ${curVer}` }
        );

        assert.notEqual(syncedInfo.chipDisplay, "none", "#app-version-chip must be visible in Advanced Mode");
        assert.notEqual(syncedInfo.footerDisplay, "none", "#adv-version-footer must be visible in Advanced Mode");
        assert.equal(syncedInfo.chipVer, curVer);
        assert.equal(syncedInfo.footVer, curVer);
        assert.equal(syncedInfo.swText, `SW ${curVer}`);
        assert.equal(syncedInfo.chipSynced, true);
        assert.equal(syncedInfo.footerSynced, true);
        assert.equal(syncedInfo.btnText, "Check");

        // Dynamically bump served sw.js CACHE_NAME vN -> v(N+1) without touching disk!
        staticServer.setSwVersionOverride(nextVer, { syncAppVersion: true });

        // Trigger live update check via the UI button
        await swPage.click("#btn-version-action");

        // Wait for new SW to install, skipWaiting/claim, and surface the ochre update badge + Reload button
        const updateUi = await swPage.waitFor(
          `(() => {
            const chip = document.getElementById("app-version-chip");
            const footer = document.getElementById("adv-version-footer");
            const swText = document.getElementById("adv-version-sw")?.textContent?.trim();
            const btnText = document.getElementById("btn-version-action")?.textContent?.trim();
            if (swText !== ${JSON.stringify(`Update ${nextVer}`)} || btnText !== "Reload") return null;
            return {
              swText,
              btnText,
              chipWarn: chip.classList.contains("is-warn"),
              footerWarn: footer.classList.contains("is-warn"),
            };
          })()`,
          { timeoutMs: 15000, label: `Ochre Update ${nextVer} badge and Reload button` }
        );

        assert.equal(updateUi.swText, `Update ${nextVer}`);
        assert.equal(updateUi.btnText, "Reload");
        assert.equal(updateUi.chipWarn, true, "#app-version-chip must show ochre is-warn class");
        assert.equal(updateUi.footerWarn, true, "#adv-version-footer must show ochre is-warn class");

        // Click Reload and assert the reloaded document activates cleanly on v(N+1)
        const reloadDone = swPage.waitForLoadEvent(15000);
        await swPage.click("#btn-version-action");
        await reloadDone;
        await waitForAppReady(swPage, "Reloaded page WASM init");

        const postReload = await swPage.waitFor(
          `(async () => {
            const ctrl = navigator.serviceWorker?.controller;
            if (!ctrl) return null;
            const swText = document.getElementById("adv-version-sw")?.textContent?.trim();
            if (swText !== ${JSON.stringify(`SW ${nextVer}`)}) return null;
            const swReply = await new Promise((resolve) => {
              const ch = new MessageChannel();
              ch.port1.onmessage = (e) => resolve(e.data);
              ctrl.postMessage({ type: "p2p-get-version" }, [ch.port2]);
              setTimeout(() => resolve(null), 1500);
            });
            const cacheKeys = await caches.keys();
            return {
              swText,
              chipVer: document.getElementById("app-version-display")?.textContent?.trim(),
              footerSynced: document.getElementById("adv-version-footer")?.classList.contains("is-synced"),
              footerWarn: document.getElementById("adv-version-footer")?.classList.contains("is-warn"),
              btnText: document.getElementById("btn-version-action")?.textContent?.trim(),
              swReply,
              cacheKeys,
            };
          })()`,
          { timeoutMs: 15000, label: `Reloaded page settles cleanly on SW ${nextVer}` }
        );

        assert.equal(postReload.swText, `SW ${nextVer}`);
        assert.equal(postReload.chipVer, nextVer);
        assert.equal(postReload.footerSynced, true, "Reloaded page should return to green synced state");
        assert.equal(postReload.footerWarn, false, "Reloaded page should clear ochre warn state");
        assert.equal(postReload.btnText, "Check");
        assert.equal(postReload.swReply?.version, nextVer);
        assert.equal(postReload.swReply?.cacheName, `p2p-direct-shell-${nextVer}`);
        assert.ok(
          postReload.cacheKeys.includes(`p2p-direct-shell-${nextVer}`),
          `Cache Storage must contain p2p-direct-shell-${nextVer}, got ${JSON.stringify(postReload.cacheKeys)}`
        );
        assert.deepEqual(swPage.pageErrors, [], "Reloaded page must activate with zero uncaught page errors");
      } finally {
        staticServer.clearSwVersionOverride();
        await swPage.close();
      }
    });
  } finally {
    await browser.close();
    await staticServer.close();
    await mqttBroker.close();
  }
});
