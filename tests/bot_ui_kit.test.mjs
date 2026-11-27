import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.__P2P_NO_AUTO_BOOT__ = true;
const { formatBotRichText } = await import("../app.js");
const { renderIconSvg, resolveIconAndText, stripBotEmojis } = await import("../icons.js");

describe("Interactive Bot Card UI Kit — formatBotRichText & Flat Metro SVG Icons", () => {
  it("renders inline action links, inline edit links, inline SVG icons, and safe https URLs", () => {
    const html = formatBotRichText(
      ":icon[star-filled] Click [Open Bash](action:sts2:open:/cards/bash) or [Mark Ready](edit:badge=READY&color=mint) or [Docs](https://voice.dequ.org)."
    );
    assert.match(html, /<svg class="bot-inline-icon"/);
    assert.match(html, /class="bot-inline-action" data-bot-inline-action="sts2:open:\/cards\/bash">Open Bash<\/button>/);
    assert.match(html, /class="bot-inline-action is-edit" data-bot-inline-edit="badge=READY&amp;color=mint">Mark Ready<\/button>/);
    assert.match(html, /class="bot-inline-url" href="https:\/\/voice\.dequ\.org" target="_blank" rel="noopener noreferrer">Docs<\/a>/);
  });

  it("blocks XSS payloads, raw HTML, and javascript: URLs strictly", () => {
    const html = formatBotRichText(
      '<img src=x onerror=alert(1)> [Evil](javascript:alert(1)) [AlsoEvil](data:text/html,<script>1</script>) **safe** `code`'
    );
    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /<a\b/i);
    assert.doesNotMatch(html, /href=/i);
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /<strong>safe<\/strong>/);
    assert.match(html, /<code>code<\/code>/);
  });

  it("strips all pictorial emojis from bot text and maps leading external-bot emojis to Flat Metro SVG icons", () => {
    assert.equal(stripBotEmojis("🎲 Roll d20 🔥💧"), "Roll d20");
    assert.deepEqual(resolveIconAndText("🪙 Flip Coin"), { icon: "coin", text: "Flip Coin" });
    assert.deepEqual(resolveIconAndText("🔥 Hot Deal", "trophy"), { icon: "trophy", text: "Hot Deal" });
    assert.match(renderIconSvg("dice"), /<svg class="metro-icon"/);
    assert.equal(renderIconSvg("unknown-nonexistent-icon"), "");
    const cleanHtml = formatBotRichText("Rain 💧 70% 🚀");
    assert.doesNotMatch(cleanHtml, /\p{Extended_Pictographic}/u);
    assert.match(cleanHtml, /Rain 70%/);
  });
});
