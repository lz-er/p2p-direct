import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.__P2P_NO_AUTO_BOOT__ = true;
const {
  P2PDirectApp,
  formatChatTextPayload,
  formatBotRichText,
  renderCodeBlockHtml,
  normalizeCodeBlockInfo,
  highlightCodeToHtml,
} = await import("../app.js");

function decodeHtmlText(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

describe("Code Highlighter — normalizeCodeBlockInfo", () => {
  it("normalizes languages, aliases, colon filenames, title attributes, and plain filenames safely", () => {
    assert.deepEqual(normalizeCodeBlockInfo(""), { lang: "text", displayLang: "CODE", title: "" });
    assert.deepEqual(normalizeCodeBlockInfo("python"), { lang: "python", displayLang: "PYTHON", title: "" });
    assert.deepEqual(normalizeCodeBlockInfo("py"), { lang: "python", displayLang: "PY", title: "" });
    assert.deepEqual(normalizeCodeBlockInfo("c++"), { lang: "cpp", displayLang: "C++", title: "" });
    assert.deepEqual(normalizeCodeBlockInfo("tsx"), { lang: "ts", displayLang: "TSX", title: "" });
    assert.deepEqual(normalizeCodeBlockInfo("yml"), { lang: "yaml", displayLang: "YML", title: "" });
    assert.deepEqual(normalizeCodeBlockInfo("sh"), { lang: "bash", displayLang: "SH", title: "" });
    assert.deepEqual(normalizeCodeBlockInfo("ps1"), { lang: "powershell", displayLang: "PS1", title: "" });

    assert.deepEqual(normalizeCodeBlockInfo("python:parallelogram.py"), {
      lang: "python",
      displayLang: "PYTHON",
      title: "parallelogram.py",
    });
    assert.deepEqual(normalizeCodeBlockInfo('python title="parallelogram.py"'), {
      lang: "python",
      displayLang: "PYTHON",
      title: "parallelogram.py",
    });
    assert.deepEqual(normalizeCodeBlockInfo("yaml automations/lights.yaml 🚀"), {
      lang: "yaml",
      displayLang: "YAML",
      title: "automations/lights.yaml",
    });

    const sanitized = normalizeCodeBlockInfo('py"><script>alert(1)</script>');
    assert.equal(sanitized.displayLang, "PYSCRIPTALERT1SCRIPT");
    assert.doesNotMatch(sanitized.displayLang, /[<>"]/);
  });
});

describe("Code Highlighter — highlightCodeToHtml & strict byte-for-byte round-trip invariant", () => {
  const samples = [
    {
      name: "Python",
      lang: "python",
      code: '@dataclass\ndef is_parallelogram(p1: tuple, p2: tuple) -> bool:\n    # check midpoint & <edge> cases\n    msg = f"ok: {p1} & {p2}"\n    return True if p1 != None else False\n',
      expectClasses: ["tok-dec", "tok-kw", "tok-fn", "tok-type", "tok-cmt", "tok-str", "tok-const"],
    },
    {
      name: "JavaScript / TypeScript",
      lang: "ts",
      code: 'export async function fetchCount(url: string): Promise<number> {\n  // linear-time & safe\n  const label = `url=${url}`;\n  return url.length > 0 ? 42 : 0;\n}',
      expectClasses: ["tok-kw", "tok-fn", "tok-type", "tok-cmt", "tok-str", "tok-prop", "tok-num"],
    },
    {
      name: "Rust / C++",
      lang: "rust",
      code: '#[derive(Debug)]\npub fn sum_slice<\'a>(xs: &\'a [u32], cfg: &Config) -> u32 {\n    println!("limit={}", cfg.limit);\n    xs.iter().copied().sum()\n}',
      expectClasses: ["tok-dec", "tok-kw", "tok-fn", "tok-type", "tok-str", "tok-prop"],
    },
    {
      name: "JSON",
      lang: "json",
      code: '{\n  "wake_word": "Hey Jarvis",\n  "enabled": true,\n  "timeout_ms": 4000,\n  "error": null\n}',
      expectClasses: ["tok-prop", "tok-str", "tok-const", "tok-num"],
    },
    {
      name: "YAML + HA Jinja",
      lang: "yaml",
      code: '# Home Assistant script\nalias: "Notify Room"\nsequence:\n  - event: p2p_voice_send_chat\n    event_data:\n      message: "{{ states(\'sensor.temp\') }} °C"\n      enabled: true\n      retries: 3\n      secret_key: !secret room_key\n      raw_block: {% if is_state("light.desk", "on") %}1{% endif %}',
      expectClasses: ["tok-cmt", "tok-prop", "tok-str", "tok-dec", "tok-const", "tok-num"],
    },
    {
      name: "HTML / XML",
      lang: "html",
      code: '<!DOCTYPE html>\n<!-- header -->\n<div class="box" data-id="1">&amp; <span>Hello</span></div>',
      expectClasses: ["tok-dec", "tok-cmt", "tok-tag", "tok-prop", "tok-str", "tok-const"],
    },
    {
      name: "CSS",
      lang: "css",
      code: '/* Flat Metro */\n@media (max-width: 640px) {\n  .chat-code-block {\n    background: #0e0f12;\n    border-width: 2px !important;\n    --accent: var(--cobalt);\n  }\n}',
      expectClasses: ["tok-cmt", "tok-kw", "tok-tag", "tok-prop", "tok-num", "tok-fn"],
    },
    {
      name: "Bash / Shell",
      lang: "bash",
      code: '# deploy script\nexport ROOM_URL="https://voice.dequ.org"\nif [ -n "$ROOM_URL" ]; then\n  curl --silent -f "$ROOM_URL" | jq .\nfi',
      expectClasses: ["tok-cmt", "tok-kw", "tok-prop", "tok-str", "tok-fn", "tok-dec"],
    },
    {
      name: "SQL",
      lang: "sql",
      code: "-- active timers\nSELECT id, COUNT(*) AS total\nFROM timers\nWHERE status = 'active' AND remaining_sec > 0\nORDER BY remaining_sec ASC;",
      expectClasses: ["tok-cmt", "tok-kw", "tok-fn", "tok-str", "tok-num"],
    },
    {
      name: "Diff",
      lang: "diff",
      code: "--- a/app.js\n+++ b/app.js\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;",
      expectClasses: ["tok-cmt", "tok-dec", "tok-del", "tok-add"],
    },
    {
      name: "XSS payload inside Python & HTML",
      lang: "html",
      code: '<script>alert("xss")</script><img src=x onerror=\'alert(1)\'> & "quotes"',
      expectClasses: ["tok-tag", "tok-prop", "tok-str"],
    },
  ];

  for (const s of samples) {
    it(`highlights ${s.name} accurately and preserves exact byte-for-byte text round-trip`, () => {
      const html = highlightCodeToHtml(s.code, s.lang);
      for (const cls of s.expectClasses) {
        assert.match(html, new RegExp(`class="${cls}"`), `Expected .${cls} in ${s.name}`);
      }
      // Must NEVER contain raw unescaped dangerous tags outside our own <span class="tok-*">
      const withoutOurSpans = html.replace(/<span class="tok-[a-z]+">|<\/span>/g, "");
      assert.doesNotMatch(withoutOurSpans, /[<>]/, `Unescaped angle bracket leaked in ${s.name}`);
      // STRICT byte-for-byte round-trip invariant
      assert.equal(decodeHtmlText(html), s.code, `Round-trip mismatch for ${s.name}`);
    });
  }

  it("falls back safely to plain escaped text for >40,000 char inputs while preserving round-trip", () => {
    const huge = "const x = '<tag>';\n".repeat(2500); // > 47,500 chars
    assert.ok(huge.length > 40_000);
    const html = highlightCodeToHtml(huge, "js");
    assert.doesNotMatch(html, /<span class="tok-/);
    assert.equal(decodeHtmlText(html), huge);
  });
});

describe("Chat & Bot Markdown Code Blocks — fences, gutter, wrap, copy & XSS", () => {
  it("renders backtick & tilde fences, indented fences, title, line count, and sibling line-number gutter", () => {
    const py = formatChatTextPayload(
      'Here is the check:\n  ```python:parallelogram.py\ndef is_parallelogram(a, b, c, d):\n    return a + c == b + d\n  ```\nDone!'
    );
    assert.match(py.html, /Here is the check:/);
    assert.match(py.html, /<div class="chat-code-block" data-code-lang="python">/);
    assert.match(py.html, /<span class="chat-code-lang">PYTHON<\/span>/);
    assert.match(py.html, /<span class="chat-code-title" title="parallelogram\.py">parallelogram\.py<\/span>/);
    assert.match(py.html, /<span class="chat-code-lines">2 lines<\/span>/);
    assert.match(py.html, /data-chat-wrap-code aria-pressed="false"/);
    assert.match(py.html, /data-chat-copy-code aria-label="Copy code">Copy<\/button>/);
    assert.match(py.html, /<div class="chat-code-gutter" aria-hidden="true"><span>1<\/span><span>2<\/span><\/div>/);
    assert.match(py.html, /<span class="tok-kw">def<\/span>/);
    assert.match(py.html, /Done!/);
    assert.deepEqual(py.links, []);

    // Tilde fence (`~~~`) with 3 lines
    const tilde = formatChatTextPayload("~~~python\nx = 1\ny = 2\nz = 3\n~~~");
    assert.match(tilde.html, /<span class="chat-code-lang">PYTHON<\/span>/);
    assert.match(tilde.html, /<span class="chat-code-lines">3 lines<\/span>/);
    assert.match(tilde.html, /<span>1<\/span><span>2<\/span><span>3<\/span>/);

    // Single-line block omits gutter cleanly
    const single = renderCodeBlockHtml("plain snippet", "");
    assert.match(single, /<span class="chat-code-lang">CODE<\/span>/);
    assert.match(single, /<span class="chat-code-lines">1 line<\/span>/);
    assert.doesNotMatch(single, /chat-code-gutter/);
  });

  it("handles unclosed trailing fences gracefully (chunked bot output) and CRLF line endings", () => {
    const res = formatChatTextPayload("Part 1:\r\n```python\r\ndef part_one():\r\n    return 42");
    assert.match(res.html, /<span class="chat-code-lang">PYTHON<\/span>/);
    const codeMatch = res.html.match(/<pre class="chat-code-pre"><code>([\s\S]*?)<\/code><\/pre>/);
    assert.ok(codeMatch);
    assert.equal(decodeHtmlText(codeMatch[1]), "def part_one():\n    return 42");
  });

  it("strictly XSS-escapes HTML/script payloads in code blocks, titles, language tags, and inline code", () => {
    const res = formatChatTextPayload(
      'Check `<img src=x onerror=alert(1)>`:\n```py title="<img src=x>"\n<script>alert("xss")</script>\n```'
    );
    assert.doesNotMatch(res.html, /<script/i);
    assert.doesNotMatch(res.html, /<img\b/i);
    assert.match(res.html, /<code class="chat-inline-code">&lt;img src=x onerror=alert\(1\)&gt;<\/code>/);
    assert.match(res.html, /<span class="chat-code-title" title="&lt;img src=x&gt;">&lt;img src=x&gt;<\/span>/);
    assert.match(res.html, /&lt;script&gt;/);
  });

  it("extracts URLs outside fences into links while keeping URLs inside fences and inline code raw", () => {
    const text = [
      "Docs: https://docs.python.org/3/",
      "Inline: `https://internal.example.local/secret`",
      "```python",
      'URL = "https://code-only.example.com/api"',
      "```",
      "Also see https://voice.dequ.org/guide",
    ].join("\n");

    const { html, links } = formatChatTextPayload(text);
    assert.equal(links.length, 2);
    assert.equal(links[0].href, "https://docs.python.org/3/");
    assert.equal(links[1].href, "https://voice.dequ.org/guide");
    assert.match(html, /href="https:\/\/docs\.python\.org\/3\/"/);
    assert.match(html, /href="https:\/\/voice\.dequ\.org\/guide"/);
    assert.doesNotMatch(html, /href="https:\/\/internal\.example\.local/);
    assert.doesNotMatch(html, /href="https:\/\/code-only\.example\.com/);
    assert.match(html, /<code class="chat-inline-code">https:\/\/internal\.example\.local\/secret<\/code>/);
  });

  it("preserves exact plain-text and link behavior when no backticks/tildes are present", () => {
    const { html, links } = formatChatTextPayload("Hello <world> visit https://voice.dequ.org!");
    assert.equal(links.length, 1);
    assert.equal(links[0].href, "https://voice.dequ.org/");
    assert.match(html, /Hello &lt;world&gt; visit <a class="chat-link" href="https:\/\/voice\.dequ\.org\/"/);
    assert.doesNotMatch(html, /chat-code-block|chat-inline-code/);
  });

  it("renders fenced code blocks cleanly inside bot cards via formatBotRichText", () => {
    const html = formatBotRichText(
      "**Assist:** Here is your YAML:\n```yaml:light.yaml\nalias: Desk\nenabled: true\n```\nClick [Open](https://voice.dequ.org)"
    );
    assert.match(html, /<strong>Assist:<\/strong> Here is your YAML:/);
    assert.match(html, /<div class="chat-code-block" data-code-lang="yaml">/);
    assert.match(html, /<span class="chat-code-title" title="light\.yaml">light\.yaml<\/span>/);
    assert.match(html, /<span class="tok-prop">alias<\/span>/);
    assert.match(html, /<span class="tok-const">true<\/span>/);
    assert.match(html, /class="bot-inline-url" href="https:\/\/voice\.dequ\.org"/);
  });

  it("toggles .is-wrapped on handleChatCodeWrapClick and copies pure code (zero line numbers) on handleChatCodeCopyClick", async () => {
    const app = new P2PDirectApp();
    let toastMsg = "";
    app.showToast = (m) => {
      toastMsg = m;
    };

    const blockClasses = new Set();
    const blockMock = {
      classList: {
        toggle(c) {
          if (blockClasses.has(c)) {
            blockClasses.delete(c);
            return false;
          }
          blockClasses.add(c);
          return true;
        },
      },
      querySelector(q) {
        // Gutter is sibling outside `pre > code`, so `pre > code` has ZERO line numbers
        return q === "pre > code" ? { textContent: "def hi():\n    return 1" } : null;
      },
    };

    // 1. Wrap toggle
    const wrapAttrs = {};
    const wrapClasses = new Set();
    const wrapBtn = {
      textContent: "Wrap",
      setAttribute(k, v) {
        wrapAttrs[k] = v;
      },
      classList: {
        toggle(c, force) {
          if (force) wrapClasses.add(c);
          else wrapClasses.delete(c);
        },
      },
      closest(sel) {
        return sel === ".chat-code-block" ? blockMock : null;
      },
    };
    assert.equal(app.handleChatCodeWrapClick(wrapBtn), true);
    assert.equal(blockClasses.has("is-wrapped"), true);
    assert.equal(wrapAttrs["aria-pressed"], "true");
    assert.equal(wrapBtn.textContent, "Wrapped");
    assert.equal(wrapClasses.has("is-active"), true);

    assert.equal(app.handleChatCodeWrapClick(wrapBtn), false);
    assert.equal(blockClasses.has("is-wrapped"), false);
    assert.equal(wrapAttrs["aria-pressed"], "false");
    assert.equal(wrapBtn.textContent, "Wrap");

    // 2. Copy pure code
    let copiedPayload = "";
    const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          async writeText(val) {
            copiedPayload = val;
          },
        },
      },
    });
    try {
      const copyClasses = new Set();
      const copyBtn = {
        textContent: "Copy",
        isConnected: false,
        classList: {
          toggle(c, force) {
            if (force) copyClasses.add(c);
            else copyClasses.delete(c);
          },
          remove(c) {
            copyClasses.delete(c);
          },
        },
        closest(sel) {
          return sel === ".chat-code-block" ? blockMock : null;
        },
      };
      await app.handleChatCodeCopyClick(copyBtn);
      assert.equal(copiedPayload, "def hi():\n    return 1");
      assert.equal(copyBtn.textContent, "Copied");
      assert.equal(copyClasses.has("is-copied"), true);
      assert.equal(toastMsg, "Copied code snippet");
      if (copyBtn._copyResetTimer) clearTimeout(copyBtn._copyResetTimer);
    } finally {
      if (origNavDesc) Object.defineProperty(globalThis, "navigator", origNavDesc);
      else delete globalThis.navigator;
    }
  });
});
