/**
 * Zero-dependency, single-pass, linear-time, 100% XSS-safe syntax highlighter
 * for Direct Voice & Chat code blocks (Flat Metro Signal Blocks UI).
 *
 * STRICT INVARIANT:
 * Stripping HTML tags and decoding `&amp;/&lt;/&gt;/&quot;/&#39;` from
 * `highlightCodeToHtml(raw, lang)` ALWAYS equals `raw` byte-for-byte.
 */

import { stripBotEmojis } from "./icons.js";

const MAX_HIGHLIGHT_CHARS = 40_000;

const LANG_ALIASES = Object.freeze({
  py: "python",
  python: "python",
  python3: "python",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  javascript: "js",
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  typescript: "ts",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  "c#": "csharp",
  csharp: "csharp",
  java: "java",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  css: "css",
  scss: "css",
  less: "css",
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  console: "bash",
  powershell: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  sql: "sql",
  sqlite: "sql",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  diff: "diff",
  patch: "diff",
});

function escapeCodeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isIdentStart(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

function isIdentPart(ch) {
  const c = ch.charCodeAt(0);
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    c === 95 ||
    c === 36
  );
}

function isDigit(ch) {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function isHexDigit(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

function isPascalCase(word) {
  return word.length >= 2 && word[0] >= "A" && word[0] <= "Z" && /[a-z]/.test(word);
}

/**
 * Parses a fenced code-block info string into `{ lang, displayLang, title }`.
 * Supports `python`, `py`, `c++`, `python:parallelogram.py`, `python title="parallelogram.py"`,
 * and `python parallelogram.py`.
 */
export function normalizeCodeBlockInfo(rawInfo) {
  const cleaned = stripBotEmojis(String(rawInfo ?? ""))
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim();

  if (!cleaned) {
    return { lang: "text", displayLang: "CODE", title: "" };
  }

  let rawLang = "";
  let rawTitle = "";

  // Extract explicit `title="..."` / `title='...'` / `title=foo.py` first if present
  let rest = cleaned;
  const titleAttrMatch = rest.match(/(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/i);
  if (titleAttrMatch) {
    rawTitle = (titleAttrMatch[1] ?? titleAttrMatch[2] ?? titleAttrMatch[3] ?? "").trim();
    rest = (
      rest.slice(0, titleAttrMatch.index) +
      " " +
      rest.slice(titleAttrMatch.index + titleAttrMatch[0].length)
    ).trim();
  }

  if (rest) {
    const firstSpace = rest.search(/\s/);
    const firstTok = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
    const trailing = firstSpace === -1 ? "" : rest.slice(firstSpace + 1).trim();

    const colonIdx = firstTok.indexOf(":");
    if (colonIdx > 0 && colonIdx < firstTok.length - 1) {
      rawLang = firstTok.slice(0, colonIdx);
      if (!rawTitle) {
        const afterColon = firstTok.slice(colonIdx + 1);
        rawTitle = trailing ? `${afterColon} ${trailing}` : afterColon;
      }
    } else {
      rawLang = firstTok;
      if (!rawTitle && trailing) {
        rawTitle = trailing;
      }
    }
  }

  const sanitizedLang = rawLang.replace(/[^a-zA-Z0-9+#._-]/g, "").slice(0, 20);
  const lower = sanitizedLang.toLowerCase();
  const lang = LANG_ALIASES[lower] || "text";
  const displayLang = sanitizedLang ? sanitizedLang.toUpperCase() : "CODE";
  const title = stripBotEmojis(rawTitle)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 64);

  return { lang, displayLang, title };
}

function makeEmitter(src) {
  const out = [];
  let pos = 0;
  return {
    get pos() {
      return pos;
    },
    emit(cls, endIdx) {
      if (endIdx <= pos) return;
      const escaped = escapeCodeHtml(src.slice(pos, endIdx));
      if (cls) {
        out.push(`<span class="${cls}">${escaped}</span>`);
      } else {
        out.push(escaped);
      }
      pos = endIdx;
    },
    done() {
      if (pos < src.length) {
        out.push(escapeCodeHtml(src.slice(pos)));
        pos = src.length;
      }
      return out.join("");
    },
  };
}

function scanQuotedString(src, start, quote, allowMultiline = false) {
  const n = src.length;
  let j = start + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === "\\" && j + 1 < n) {
      j += 2;
      continue;
    }
    if (ch === quote) {
      return j + 1;
    }
    if (!allowMultiline && ch === "\n") {
      return j;
    }
    j++;
  }
  return n;
}

function scanNumber(src, start) {
  const n = src.length;
  let j = start;
  if (src[j] === "0" && j + 1 < n) {
    const nxt = src[j + 1];
    if (nxt === "x" || nxt === "X") {
      j += 2;
      while (j < n && (isHexDigit(src[j]) || src[j] === "_")) j++;
    } else if (nxt === "b" || nxt === "B") {
      j += 2;
      while (j < n && (src[j] === "0" || src[j] === "1" || src[j] === "_")) j++;
    } else if (nxt === "o" || nxt === "O") {
      j += 2;
      while (j < n && ((src[j] >= "0" && src[j] <= "7") || src[j] === "_")) j++;
    }
  }
  if (j === start) {
    while (j < n && (isDigit(src[j]) || src[j] === "_")) j++;
    if (j < n && src[j] === "." && j + 1 < n && isDigit(src[j + 1])) {
      j++;
      while (j < n && (isDigit(src[j]) || src[j] === "_")) j++;
    }
    if (j < n && (src[j] === "e" || src[j] === "E")) {
      let k = j + 1;
      if (k < n && (src[k] === "+" || src[k] === "-")) k++;
      if (k < n && isDigit(src[k])) {
        j = k;
        while (j < n && (isDigit(src[j]) || src[j] === "_")) j++;
      }
    }
  }
  // Optional numeric type suffix (e.g. 42n, 3j, 10u32, 1.5f64, 100LL)
  if (j < n && /[a-zA-Z]/.test(src[j])) {
    let k = j;
    while (k < n && /[a-zA-Z0-9]/.test(src[k])) k++;
    const suf = src.slice(j, k);
    if (/^(?:n|j|J|f|F|d|D|l|L|u|U|ul|UL|ll|LL|ull|ULL|u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64)$/.test(suf)) {
      j = k;
    }
  }
  return j;
}

/* ---------- Language Tokenizers ---------- */

const PYTHON_KEYWORDS = new Set([
  "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or",
  "is", "import", "from", "as", "with", "try", "except", "finally", "raise", "pass", "break",
  "continue", "yield", "lambda", "async", "await", "global", "nonlocal", "assert", "del",
  "match", "case",
]);
const PYTHON_CONSTANTS = new Set(["True", "False", "None", "Ellipsis", "NotImplemented", "self", "cls"]);
const PYTHON_TYPES = new Set([
  "int", "float", "str", "bool", "list", "dict", "set", "frozenset", "tuple", "bytes",
  "bytearray", "object", "type", "complex", "range", "slice", "memoryview", "Any", "Optional",
  "Union", "List", "Dict", "Tuple", "Set", "Sequence", "Mapping", "Callable", "Iterable",
  "Iterator", "Generator", "Final", "Literal", "Exception", "ValueError", "TypeError",
  "KeyError", "IndexError", "RuntimeError", "OSError",
]);

function highlightPython(src) {
  const em = makeEmitter(src);
  const n = src.length;
  let prevSig = "";

  while (em.pos < n) {
    const i = em.pos;
    const ch = src[i];

    // Comments
    if (ch === "#") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      em.emit("tok-cmt", j);
      continue;
    }

    // String prefixes (f, r, b, u, fr, rf, br, rb) + quotes
    if (
      (ch === '"' || ch === "'") ||
      (/[fFrRbBuU]/.test(ch) &&
        i + 1 < n &&
        (src[i + 1] === '"' ||
          src[i + 1] === "'" ||
          (/[fFrRbBuU]/.test(src[i + 1]) &&
            i + 2 < n &&
            (src[i + 2] === '"' || src[i + 2] === "'"))))
    ) {
      let qPos = i;
      while (qPos < n && /[fFrRbBuU]/.test(src[qPos])) qPos++;
      const q = src[qPos];
      if (src.startsWith(q + q + q, qPos)) {
        const close = src.indexOf(q + q + q, qPos + 3);
        const end = close === -1 ? n : close + 3;
        em.emit("tok-str", end);
      } else {
        em.emit("tok-str", scanQuotedString(src, qPos, q, false));
      }
      prevSig = "str";
      continue;
    }

    // Decorators (`@decorator` at line start / whitespace)
    if (ch === "@" && i + 1 < n && isIdentStart(src[i + 1])) {
      let j = i + 1;
      while (j < n && (isIdentPart(src[j]) || src[j] === ".")) j++;
      em.emit("tok-dec", j);
      prevSig = "dec";
      continue;
    }

    // Numbers
    if (isDigit(ch) || (ch === "." && i + 1 < n && isDigit(src[i + 1]))) {
      em.emit("tok-num", scanNumber(src, i));
      prevSig = "num";
      continue;
    }

    // Identifiers
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === " " || src[k] === "\t")) k++;
      const followedByParen = k < n && src[k] === "(";

      if (PYTHON_KEYWORDS.has(word)) {
        em.emit("tok-kw", j);
      } else if (PYTHON_CONSTANTS.has(word)) {
        em.emit("tok-const", j);
      } else if (prevSig === "def") {
        em.emit("tok-fn", j);
      } else if (prevSig === "class" || PYTHON_TYPES.has(word) || isPascalCase(word)) {
        em.emit("tok-type", j);
      } else if (followedByParen) {
        em.emit("tok-fn", j);
      } else if (prevSig === ".") {
        em.emit("tok-prop", j);
      } else {
        em.emit("", j);
      }
      prevSig = word;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n") {
      let j = i + 1;
      while (j < n && (src[j] === " " || src[j] === "\t" || src[j] === "\n")) j++;
      em.emit("", j);
      continue;
    }

    em.emit("", i + 1);
    prevSig = ch;
  }

  return em.done();
}

const C_FAMILY_KEYWORDS = Object.freeze({
  js: new Set([
    "const", "let", "var", "function", "async", "await", "return", "if", "else", "for", "while",
    "do", "switch", "case", "default", "break", "continue", "try", "catch", "finally", "throw",
    "new", "class", "extends", "import", "export", "from", "as", "of", "in", "typeof",
    "instanceof", "void", "delete", "yield", "static", "get", "set", "debugger", "with",
  ]),
  ts: new Set([
    "const", "let", "var", "function", "async", "await", "return", "if", "else", "for", "while",
    "do", "switch", "case", "default", "break", "continue", "try", "catch", "finally", "throw",
    "new", "class", "extends", "implements", "interface", "type", "enum", "import", "export",
    "from", "as", "of", "in", "typeof", "instanceof", "void", "delete", "yield", "static",
    "readonly", "public", "private", "protected", "abstract", "override", "keyof", "infer",
    "declare", "namespace", "satisfies", "is", "asserts",
  ]),
  c: new Set([
    "auto", "break", "case", "const", "continue", "default", "do", "else", "enum", "extern",
    "for", "goto", "if", "inline", "register", "restrict", "return", "sizeof", "static",
    "struct", "switch", "typedef", "union", "volatile", "while",
  ]),
  cpp: new Set([
    "alignas", "alignof", "auto", "break", "case", "catch", "class", "concept", "const",
    "consteval", "constexpr", "constinit", "continue", "co_await", "co_return", "co_yield",
    "decltype", "default", "delete", "do", "else", "enum", "explicit", "export", "extern",
    "final", "for", "friend", "goto", "if", "inline", "mutable", "namespace", "new", "noexcept",
    "operator", "override", "private", "protected", "public", "requires", "return", "sizeof",
    "static", "static_assert", "struct", "switch", "template", "throw", "try", "typedef",
    "typeid", "typename", "union", "using", "virtual", "volatile", "while",
  ]),
  csharp: new Set([
    "abstract", "as", "async", "await", "base", "break", "case", "catch", "checked", "class",
    "const", "continue", "default", "delegate", "do", "else", "enum", "event", "explicit",
    "extern", "finally", "fixed", "for", "foreach", "goto", "if", "implicit", "in", "interface",
    "internal", "is", "lock", "namespace", "new", "operator", "out", "override", "params",
    "partial", "private", "protected", "public", "readonly", "record", "ref", "return", "sealed",
    "sizeof", "stackalloc", "static", "struct", "switch", "throw", "try", "typeof", "unchecked",
    "unsafe", "using", "var", "virtual", "volatile", "when", "where", "while", "yield",
  ]),
  java: new Set([
    "abstract", "assert", "break", "case", "catch", "class", "const", "continue", "default",
    "do", "else", "enum", "extends", "final", "finally", "for", "if", "implements", "import",
    "instanceof", "interface", "native", "new", "package", "private", "protected", "public",
    "record", "return", "sealed", "static", "strictfp", "switch", "synchronized", "throw",
    "throws", "transient", "try", "var", "volatile", "while", "yield",
  ]),
  rust: new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
    "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut",
    "pub", "ref", "return", "static", "struct", "trait", "type", "unsafe", "use", "where",
    "while",
  ]),
  go: new Set([
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
    "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range",
    "return", "select", "struct", "switch", "type", "var",
  ]),
});

const C_FAMILY_CONSTANTS = new Set([
  "true", "false", "null", "undefined", "NaN", "Infinity", "nil", "NULL", "nullptr",
  "this", "super", "self", "Self", "iota", "Some", "None", "Ok", "Err",
]);

const C_FAMILY_TYPES = new Set([
  "void", "bool", "boolean", "number", "string", "any", "unknown", "never", "bigint", "symbol",
  "int", "long", "short", "char", "float", "double", "signed", "unsigned", "byte", "sbyte",
  "decimal", "object", "rune", "error", "str", "usize", "isize",
  "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "f32", "f64",
  "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
  "float32", "float64", "size_t", "ssize_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t",
  "int8_t", "int16_t", "int32_t", "int64_t", "std",
  "String", "Array", "Map", "Set", "Promise", "Object", "Error", "Date", "RegExp", "JSON",
  "Uint8Array", "Int16Array", "Float32Array", "Vec", "Option", "Result", "Box", "Arc", "Rc",
  "List", "Dictionary", "Task", "Integer", "Boolean",
]);

function highlightCFamily(src, lang) {
  const em = makeEmitter(src);
  const n = src.length;
  const keywords = C_FAMILY_KEYWORDS[lang] || C_FAMILY_KEYWORDS.js;
  const allowBacktickStr = lang === "js" || lang === "ts" || lang === "go";
  const allowPreprocessor = lang === "c" || lang === "cpp" || lang === "csharp";
  let prevSig = "";
  let lineStart = true;

  while (em.pos < n) {
    const i = em.pos;
    const ch = src[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n") {
      let j = i;
      while (j < n && (src[j] === " " || src[j] === "\t" || src[j] === "\n")) {
        if (src[j] === "\n") lineStart = true;
        j++;
      }
      em.emit("", j);
      continue;
    }

    // Line comments //
    if (ch === "/" && i + 1 < n && src[i + 1] === "/") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      em.emit("tok-cmt", j);
      lineStart = false;
      continue;
    }

    // Block comments /* ... */
    if (ch === "/" && i + 1 < n && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      em.emit("tok-cmt", end);
      lineStart = false;
      continue;
    }

    // C/C++/C# preprocessor directive at line start (`#include`, `#define`, `#region`)
    if (allowPreprocessor && lineStart && ch === "#") {
      let j = i + 1;
      while (j < n && (src[j] === " " || src[j] === "\t")) j++;
      while (j < n && isIdentPart(src[j])) j++;
      em.emit("tok-dec", j);
      lineStart = false;
      prevSig = "#";
      continue;
    }

    // Rust attributes (`#[derive(...)]`, `#![allow(...)]`)
    if (lang === "rust" && ch === "#" && i + 1 < n && (src[i + 1] === "[" || (src[i + 1] === "!" && src[i + 2] === "["))) {
      const close = src.indexOf("]", i + 2);
      const end = close === -1 ? n : close + 1;
      em.emit("tok-dec", end);
      lineStart = false;
      prevSig = "attr";
      continue;
    }

    // Decorators / annotations (`@Component`, `@Override`)
    if (ch === "@" && (lang === "js" || lang === "ts" || lang === "java") && i + 1 < n && isIdentStart(src[i + 1])) {
      let j = i + 1;
      while (j < n && (isIdentPart(src[j]) || src[j] === ".")) j++;
      em.emit("tok-dec", j);
      lineStart = false;
      prevSig = "dec";
      continue;
    }

    // Double-quoted strings
    if (ch === '"') {
      em.emit("tok-str", scanQuotedString(src, i, '"', false));
      lineStart = false;
      prevSig = "str";
      continue;
    }

    // Single-quoted strings / char literals (avoid swallowing Rust lifetimes like `'a`)
    if (ch === "'") {
      if (lang === "rust") {
        // Char literal `'x'` or `'\n'` or `'\x7f'`; otherwise lifetime `'a`
        let end = i + 1;
        if (end < n && src[end] === "\\") {
          end += 2;
          while (end < n && src[end] !== "'" && src[end] !== "\n" && end - i < 10) end++;
          if (end < n && src[end] === "'") {
            em.emit("tok-str", end + 1);
            lineStart = false;
            prevSig = "str";
            continue;
          }
        } else if (i + 2 < n && src[i + 2] === "'") {
          em.emit("tok-str", i + 3);
          lineStart = false;
          prevSig = "str";
          continue;
        }
        // Lifetime `'a`, `'static`
        let j = i + 1;
        while (j < n && isIdentPart(src[j])) j++;
        em.emit(j > i + 1 ? "tok-dec" : "", j > i + 1 ? j : i + 1);
        lineStart = false;
        prevSig = "lt";
        continue;
      }
      em.emit("tok-str", scanQuotedString(src, i, "'", false));
      lineStart = false;
      prevSig = "str";
      continue;
    }

    // Backtick template / raw strings
    if (allowBacktickStr && ch === "`") {
      em.emit("tok-str", scanQuotedString(src, i, "`", true));
      lineStart = false;
      prevSig = "str";
      continue;
    }

    // Numbers
    if (isDigit(ch)) {
      em.emit("tok-num", scanNumber(src, i));
      lineStart = false;
      prevSig = "num";
      continue;
    }

    // Identifiers
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === " " || src[k] === "\t")) k++;
      const followedByParen = k < n && src[k] === "(";

      if (lang === "rust" && j < n && src[j] === "!") {
        em.emit("tok-dec", j + 1);
      } else if (keywords.has(word)) {
        em.emit("tok-kw", j);
      } else if (C_FAMILY_CONSTANTS.has(word)) {
        em.emit("tok-const", j);
      } else if (prevSig === "function" || prevSig === "fn" || prevSig === "func") {
        em.emit("tok-fn", j);
      } else if (
        prevSig === "class" ||
        prevSig === "struct" ||
        prevSig === "interface" ||
        prevSig === "enum" ||
        prevSig === "trait" ||
        C_FAMILY_TYPES.has(word) ||
        isPascalCase(word)
      ) {
        em.emit("tok-type", j);
      } else if (followedByParen) {
        em.emit("tok-fn", j);
      } else if (prevSig === ".") {
        em.emit("tok-prop", j);
      } else {
        em.emit("", j);
      }
      lineStart = false;
      prevSig = word;
      continue;
    }

    em.emit("", i + 1);
    lineStart = false;
    prevSig = ch;
  }

  return em.done();
}

function highlightJson(src) {
  const em = makeEmitter(src);
  const n = src.length;

  while (em.pos < n) {
    const i = em.pos;
    const ch = src[i];

    if (ch === "/" && i + 1 < n && src[i + 1] === "/") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      em.emit("tok-cmt", j);
      continue;
    }
    if (ch === "/" && i + 1 < n && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      em.emit("tok-cmt", close === -1 ? n : close + 2);
      continue;
    }
    if (ch === '"') {
      const end = scanQuotedString(src, i, '"', false);
      let k = end;
      while (k < n && (src[k] === " " || src[k] === "\t")) k++;
      em.emit(k < n && src[k] === ":" ? "tok-prop" : "tok-str", end);
      continue;
    }
    if ((ch === "-" && i + 1 < n && isDigit(src[i + 1])) || isDigit(ch)) {
      const startNum = ch === "-" ? i + 1 : i;
      const end = scanNumber(src, startNum);
      em.emit("tok-num", end);
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      if (word === "true" || word === "false" || word === "null") {
        em.emit("tok-const", j);
      } else {
        em.emit("", j);
      }
      continue;
    }
    em.emit("", i + 1);
  }

  return em.done();
}

const YAML_CONSTANTS = new Set(["true", "false", "yes", "no", "on", "off", "null", "True", "False", "NULL", "~"]);

function highlightYaml(src) {
  const em = makeEmitter(src);
  const n = src.length;
  let lineStart = true;

  while (em.pos < n) {
    const i = em.pos;
    const ch = src[i];

    if (ch === "\n") {
      em.emit("", i + 1);
      lineStart = true;
      continue;
    }

    if (lineStart && (ch === " " || ch === "\t")) {
      let j = i + 1;
      while (j < n && (src[j] === " " || src[j] === "\t")) j++;
      em.emit("", j);
      continue;
    }

    // YAML document markers `---` / `...`
    if (lineStart && (src.startsWith("---", i) || src.startsWith("...", i))) {
      const after = i + 3;
      if (after === n || src[after] === "\n" || src[after] === " ") {
        em.emit("tok-dec", after);
        lineStart = false;
        continue;
      }
    }

    // List item prefix `- ` keeps key detection active on the rest of the line
    if (lineStart && ch === "-" && (i + 1 === n || src[i + 1] === " " || src[i + 1] === "\t")) {
      let j = i + 1;
      while (j < n && (src[j] === " " || src[j] === "\t")) j++;
      em.emit("", j);
      continue;
    }

    // HA Jinja comments {# ... #}
    if (ch === "{" && i + 1 < n && src[i + 1] === "#") {
      const close = src.indexOf("#}", i + 2);
      em.emit("tok-cmt", close === -1 ? n : close + 2);
      lineStart = false;
      continue;
    }

    // HA Jinja expressions {{ ... }} and tags {% ... %}
    if (ch === "{" && i + 1 < n && (src[i + 1] === "{" || src[i + 1] === "%")) {
      const closer = src[i + 1] === "{" ? "}}" : "%}";
      const close = src.indexOf(closer, i + 2);
      em.emit("tok-dec", close === -1 ? n : close + 2);
      lineStart = false;
      continue;
    }

    // Comments `# ...`
    if (ch === "#" && (lineStart || i === 0 || src[i - 1] === " " || src[i - 1] === "\t")) {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      em.emit("tok-cmt", j);
      lineStart = false;
      continue;
    }

    // YAML key at start of mapping line (`key:` or `"key":`)
    if (lineStart && ch !== '"' && ch !== "'" && ch !== "{" && ch !== "[") {
      let lineEnd = src.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = n;
      const lineSlice = src.slice(i, lineEnd);
      const keyMatch = lineSlice.match(/^([a-zA-Z0-9_.-]+)(?=\s*:(?:\s|$))/);
      if (keyMatch) {
        em.emit("tok-prop", i + keyMatch[1].length);
        lineStart = false;
        continue;
      }
    }

    // Quoted strings (also highlight Jinja {{...}} / {%...%} inside HA YAML strings!)
    if (ch === '"' || ch === "'") {
      const end = scanQuotedString(src, i, ch, false);
      const rawStr = src.slice(i, end);
      if (rawStr.includes("{{") || rawStr.includes("{%")) {
        // Emit quote + segments with Jinja highlighted cleanly
        let p = i;
        while (p < end) {
          const j1 = src.indexOf("{{", p);
          const j2 = src.indexOf("{%", p);
          let nextJ = -1;
          let closer = "";
          if (j1 !== -1 && j1 < end && (j2 === -1 || j1 < j2)) {
            nextJ = j1;
            closer = "}}";
          } else if (j2 !== -1 && j2 < end) {
            nextJ = j2;
            closer = "%}";
          }
          if (nextJ === -1) {
            em.emit("tok-str", end);
            break;
          }
          if (nextJ > p) em.emit("tok-str", nextJ);
          const close = src.indexOf(closer, nextJ + 2);
          const jEnd = close !== -1 && close + 2 <= end ? close + 2 : end;
          em.emit("tok-dec", jEnd);
          p = jEnd;
        }
      } else {
        em.emit("tok-str", end);
      }
      lineStart = false;
      continue;
    }

    // YAML tags / anchors / aliases (`!secret`, `&ref`, `*ref`)
    if ((ch === "!" || ch === "&" || ch === "*") && i + 1 < n && /[a-zA-Z0-9_-]/.test(src[i + 1])) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_.-]/.test(src[j])) j++;
      em.emit("tok-dec", j);
      lineStart = false;
      continue;
    }

    // Numbers
    if (
      ((ch === "-" && i + 1 < n && isDigit(src[i + 1])) || isDigit(ch)) &&
      (i === 0 || /[\s,:\[{]/.test(src[i - 1]))
    ) {
      const startNum = ch === "-" ? i + 1 : i;
      const end = scanNumber(src, startNum);
      if (end === n || /[\s,\]}\n]/.test(src[end])) {
        em.emit("tok-num", end);
        lineStart = false;
        continue;
      }
    }

    // Boolean / null scalar words
    if ((isIdentStart(ch) || ch === "~") && (i === 0 || /[\s,:\[{]/.test(src[i - 1]))) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_.-]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (YAML_CONSTANTS.has(word) && (j === n || /[\s,\]}\n]/.test(src[j]))) {
        em.emit("tok-const", j);
        lineStart = false;
        continue;
      }
      em.emit("", j);
      lineStart = false;
      continue;
    }

    em.emit("", i + 1);
    lineStart = false;
  }

  return em.done();
}

function highlightHtml(src) {
  const em = makeEmitter(src);
  const n = src.length;

  while (em.pos < n) {
    const i = em.pos;
    const ch = src[i];

    // Comments <!-- ... -->
    if (src.startsWith("<!--", i)) {
      const close = src.indexOf("-->", i + 4);
      em.emit("tok-cmt", close === -1 ? n : close + 3);
      continue;
    }

    // <!DOCTYPE ...>
    if (src.startsWith("<!", i)) {
      const close = src.indexOf(">", i + 2);
      em.emit("tok-dec", close === -1 ? n : close + 1);
      continue;
    }

    // Tags `<tag attr="val">` or `</tag>`
    if (ch === "<" && i + 1 < n && (src[i + 1] === "/" || /[a-zA-Z]/.test(src[i + 1]))) {
      let j = i + 1;
      if (src[j] === "/") j++;
      em.emit("", j); // emit `<` or `</`

      // Tag name
      let nameEnd = j;
      while (nameEnd < n && /[a-zA-Z0-9_.:-]/.test(src[nameEnd])) nameEnd++;
      em.emit("tok-tag", nameEnd);

      // Attributes until `>`
      while (em.pos < n) {
        const p = em.pos;
        const c = src[p];
        if (c === ">") {
          em.emit("", p + 1);
          break;
        }
        if (c === "/" && p + 1 < n && src[p + 1] === ">") {
          em.emit("", p + 2);
          break;
        }
        if (c === '"' || c === "'") {
          em.emit("tok-str", scanQuotedString(src, p, c, true));
          continue;
        }
        if (/[a-zA-Z_:@]/.test(c)) {
          let aEnd = p + 1;
          while (aEnd < n && /[a-zA-Z0-9_.:@-]/.test(src[aEnd])) aEnd++;
          em.emit("tok-prop", aEnd);
          continue;
        }
        em.emit("", p + 1);
      }
      continue;
    }

    // HTML entities `&amp;`, `&#39;`
    if (ch === "&") {
      let j = i + 1;
      if (j < n && src[j] === "#") j++;
      while (j < n && /[a-zA-Z0-9]/.test(src[j]) && j - i < 12) j++;
      if (j < n && src[j] === ";" && j > i + 1) {
        em.emit("tok-const", j + 1);
        continue;
      }
    }

    em.emit("", i + 1);
  }

  return em.done();
}

function highlightCss(src) {
  const em = makeEmitter(src);
  const n = src.length;
  let braceDepth = 0;

  while (em.pos < n) {
    const i = em.pos;
    const ch = src[i];

    if (ch === "/" && i + 1 < n && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      em.emit("tok-cmt", close === -1 ? n : close + 2);
      continue;
    }
    if (ch === '"' || ch === "'") {
      em.emit("tok-str", scanQuotedString(src, i, ch, false));
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      em.emit("", i + 1);
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      em.emit("", i + 1);
      continue;
    }
    // At-rules `@media`, `@keyframes`
    if (ch === "@" && i + 1 < n && /[a-zA-Z-]/.test(src[i + 1])) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_-]/.test(src[j])) j++;
      em.emit("tok-kw", j);
      continue;
    }
    // `!important`
    if (ch === "!" && src.slice(i, i + 10).toLowerCase() === "!important") {
      em.emit("tok-kw", i + 10);
      continue;
    }
    // Hex colors `#0e0f12` inside declarations or `#id` selector outside
    if (ch === "#" && i + 1 < n && /[a-zA-Z0-9_-]/.test(src[i + 1])) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_-]/.test(src[j])) j++;
      const tok = src.slice(i, j);
      em.emit(braceDepth > 0 && /^#[0-9a-fA-F]{3,8}$/.test(tok) ? "tok-num" : "tok-tag", j);
      continue;
    }
    // CSS custom properties `--cobalt`
    if (ch === "-" && i + 2 < n && src[i + 1] === "-" && /[a-zA-Z0-9_-]/.test(src[i + 2])) {
      let j = i + 2;
      while (j < n && /[a-zA-Z0-9_-]/.test(src[j])) j++;
      em.emit("tok-prop", j);
      continue;
    }
    // Numbers with optional CSS units (`12px`, `1.5rem`, `100%`, `-3px`)
    if (isDigit(ch) || (ch === "." && i + 1 < n && isDigit(src[i + 1]))) {
      let j = i;
      while (j < n && (isDigit(src[j]) || src[j] === ".")) j++;
      while (j < n && (/[a-zA-Z%]/.test(src[j]))) j++;
      em.emit("tok-num", j);
      continue;
    }
    // Class selectors `.foo` outside declarations
    if (braceDepth === 0 && ch === "." && i + 1 < n && /[a-zA-Z_-]/.test(src[i + 1])) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_-]/.test(src[j])) j++;
      em.emit("tok-tag", j);
      continue;
    }
    // Identifiers: property name before `:`, CSS function before `(`, or selector tag
    if (/[a-zA-Z_-]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_-]/.test(src[j])) j++;
      let k = j;
      while (k < n && (src[k] === " " || src[k] === "\t")) k++;
      if (k < n && src[k] === "(") {
        em.emit("tok-fn", j);
      } else if (braceDepth > 0 && k < n && src[k] === ":") {
        em.emit("tok-prop", j);
      } else if (braceDepth === 0) {
        em.emit("tok-tag", j);
      } else {
        em.emit("", j);
      }
      continue;
    }
    em.emit("", i + 1);
  }

  return em.done();
}

const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case",
  "esac", "function", "return", "local", "export", "unset", "set", "readonly", "declare",
  "exit", "trap", "break", "continue", "select", "param", "foreach", "switch", "try", "catch",
  "finally", "throw", "filter", "begin", "process", "end", "class", "using",
]);
const SHELL_BUILTINS = new Set([
  "echo", "printf", "cd", "ls", "cat", "grep", "sed", "awk", "curl", "wget", "jq", "git",
  "docker", "node", "npm", "npx", "python", "python3", "pip", "sudo", "chmod", "chown",
  "mkdir", "rm", "cp", "mv", "exec", "eval", "source", "test", "read", "shift", "wait",
]);

function highlightShell(src, isPowerShell = false) {
  const em = makeEmitter(src);
  const n = src.length;

  while (em.pos < n) {
    const i = em.pos;
    const ch = src[i];

    // PowerShell block comment <# ... #>
    if (isPowerShell && ch === "<" && i + 1 < n && src[i + 1] === "#") {
      const close = src.indexOf("#>", i + 2);
      em.emit("tok-cmt", close === -1 ? n : close + 2);
      continue;
    }
    // Line comment #
    if (ch === "#" && (i === 0 || /[\s;|&(]/.test(src[i - 1]))) {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      em.emit("tok-cmt", j);
      continue;
    }
    if (ch === '"' || ch === "'") {
      em.emit("tok-str", scanQuotedString(src, i, ch, false));
      continue;
    }
    // Variables `$VAR`, `${VAR}`, `$env:PATH`, `$true`
    if (ch === "$") {
      let j = i + 1;
      if (j < n && src[j] === "{") {
        const close = src.indexOf("}", j + 1);
        j = close === -1 ? n : close + 1;
      } else if (j < n && /[a-zA-Z0-9_?:@*#!-]/.test(src[j])) {
        while (j < n && /[a-zA-Z0-9_:]/.test(src[j])) j++;
      }
      const tok = src.slice(i, j);
      const low = tok.toLowerCase();
      if (isPowerShell && (low === "$true" || low === "$false" || low === "$null")) {
        em.emit("tok-const", j);
      } else {
        em.emit(j > i + 1 ? "tok-prop" : "", j);
      }
      continue;
    }
    // CLI flags `--flag` or `-x` preceded by whitespace
    if (ch === "-" && (i === 0 || src[i - 1] === " " || src[i - 1] === "\t") && i + 1 < n && /[a-zA-Z-]/.test(src[i + 1])) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_-]/.test(src[j])) j++;
      em.emit("tok-dec", j);
      continue;
    }
    // Numbers
    if (isDigit(ch) && (i === 0 || /[\s=:(,]/.test(src[i - 1]))) {
      em.emit("tok-num", scanNumber(src, i));
      continue;
    }
    // Words / cmdlets / keywords
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_-]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const low = word.toLowerCase();
      if (SHELL_KEYWORDS.has(low)) {
        em.emit("tok-kw", j);
      } else if (low === "true" || low === "false") {
        em.emit("tok-const", j);
      } else if (SHELL_BUILTINS.has(low) || (isPowerShell && /^[A-Z][a-z]+-[A-Z][a-zA-Z]+$/.test(word))) {
        em.emit("tok-fn", j);
      } else if (j < n && src[j] === "=") {
        em.emit("tok-prop", j);
      } else {
        em.emit("", j);
      }
      continue;
    }
    em.emit("", i + 1);
  }

  return em.done();
}

const SQL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS",
  "ON", "AS", "AND", "OR", "NOT", "IN", "IS", "ORDER", "BY", "GROUP", "HAVING", "LIMIT",
  "OFFSET", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE",
  "INDEX", "VIEW", "ALTER", "DROP", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE",
  "CHECK", "CONSTRAINT", "DISTINCT", "UNION", "ALL", "CASE", "WHEN", "THEN", "ELSE", "END",
  "WITH", "RECURSIVE", "RETURNING", "EXISTS", "LIKE", "ILIKE", "BETWEEN", "ASC", "DESC",
  "IF", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "EXPLAIN",
]);
const SQL_CONSTANTS = new Set(["NULL", "TRUE", "FALSE", "CURRENT_TIMESTAMP", "CURRENT_DATE", "DEFAULT"]);
const SQL_TYPES = new Set([
  "INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "SERIAL", "BIGSERIAL", "TEXT", "VARCHAR",
  "CHAR", "CHARACTER", "BOOLEAN", "BOOL", "FLOAT", "DOUBLE", "REAL", "DECIMAL", "NUMERIC",
  "DATE", "TIME", "TIMESTAMP", "TIMESTAMPTZ", "INTERVAL", "JSON", "JSONB", "UUID", "BLOB",
  "BYTEA",
]);

function highlightSql(src) {
  const em = makeEmitter(src);
  const n = src.length;

  while (em.pos < n) {
    const i = em.pos;
    const ch = src[i];

    if (ch === "-" && i + 1 < n && src[i + 1] === "-") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      em.emit("tok-cmt", j);
      continue;
    }
    if (ch === "/" && i + 1 < n && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      em.emit("tok-cmt", close === -1 ? n : close + 2);
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'") {
          if (j + 1 < n && src[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      em.emit("tok-str", j);
      continue;
    }
    if (ch === '"') {
      em.emit("tok-prop", scanQuotedString(src, i, '"', false));
      continue;
    }
    if (isDigit(ch)) {
      em.emit("tok-num", scanNumber(src, i));
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const up = src.slice(i, j).toUpperCase();
      let k = j;
      while (k < n && (src[k] === " " || src[k] === "\t")) k++;
      if (SQL_KEYWORDS.has(up)) {
        em.emit("tok-kw", j);
      } else if (SQL_CONSTANTS.has(up)) {
        em.emit("tok-const", j);
      } else if (SQL_TYPES.has(up)) {
        em.emit("tok-type", j);
      } else if (k < n && src[k] === "(") {
        em.emit("tok-fn", j);
      } else {
        em.emit("", j);
      }
      continue;
    }
    em.emit("", i + 1);
  }

  return em.done();
}

function highlightDiff(src) {
  const em = makeEmitter(src);
  const n = src.length;

  while (em.pos < n) {
    const i = em.pos;
    let lineEnd = src.indexOf("\n", i);
    if (lineEnd === -1) lineEnd = n;
    const line = src.slice(i, lineEnd);

    if (line.startsWith("@@")) {
      em.emit("tok-dec", lineEnd);
    } else if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      em.emit("tok-cmt", lineEnd);
    } else if (line.startsWith("+")) {
      em.emit("tok-add", lineEnd);
    } else if (line.startsWith("-")) {
      em.emit("tok-del", lineEnd);
    } else {
      em.emit("", lineEnd);
    }

    if (em.pos < n && src[em.pos] === "\n") {
      em.emit("", em.pos + 1);
    }
  }

  return em.done();
}

/**
 * Highlights `rawCode` into XSS-safe HTML spans with semantic `.tok-*` classes.
 * Falls back cleanly to plain escaped text for unknown languages or >40,000 char inputs.
 */
export function highlightCodeToHtml(rawCode, lang = "text") {
  const src = String(rawCode ?? "");
  if (!src) return "";

  const key = LANG_ALIASES[String(lang || "").trim().toLowerCase()] || String(lang || "text").trim().toLowerCase();
  if (src.length > MAX_HIGHLIGHT_CHARS || !key || key === "text") {
    return escapeCodeHtml(src);
  }

  switch (key) {
    case "python":
      return highlightPython(src);
    case "js":
    case "ts":
    case "c":
    case "cpp":
    case "csharp":
    case "java":
    case "rust":
    case "go":
      return highlightCFamily(src, key);
    case "json":
      return highlightJson(src);
    case "yaml":
      return highlightYaml(src);
    case "html":
      return highlightHtml(src);
    case "css":
      return highlightCss(src);
    case "bash":
      return highlightShell(src, false);
    case "powershell":
      return highlightShell(src, true);
    case "sql":
      return highlightSql(src);
    case "diff":
      return highlightDiff(src);
    default:
      return escapeCodeHtml(src);
  }
}
