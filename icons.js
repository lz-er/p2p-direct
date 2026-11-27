/**
 * Flat Metro Geometric SVG Icon Pack (zero emojis, zero external CDNs).
 * Sharp 90-degree linecaps/joins matching the Signal Blocks UI aesthetic.
 */

const ICON_PATHS = {
  play: '<polygon points="6,4 20,12 6,20" fill="currentColor" stroke="none"/>',
  pause: '<rect x="5" y="4" width="5" height="16" fill="currentColor" stroke="none"/><rect x="14" y="4" width="5" height="16" fill="currentColor" stroke="none"/>',
  prev: '<rect x="4" y="4" width="3" height="16" fill="currentColor" stroke="none"/><polygon points="20,4 9,12 20,20" fill="currentColor" stroke="none"/>',
  next: '<polygon points="4,4 15,12 4,20" fill="currentColor" stroke="none"/><rect x="17" y="4" width="3" height="16" fill="currentColor" stroke="none"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  reset: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  check: '<polyline points="4 12 10 18 20 6"/>',
  circle: '<rect x="4" y="4" width="16" height="16"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5l4 4L7 21H3v-4L16.5 3.5z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/>',
  link: '<path d="M18 13v6H5V6h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><rect x="3" y="5" width="2" height="2" fill="currentColor" stroke="none"/><rect x="3" y="11" width="2" height="2" fill="currentColor" stroke="none"/><rect x="3" y="17" width="2" height="2" fill="currentColor" stroke="none"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  star: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.7 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/>',
  "star-filled": '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.7 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2" fill="currentColor"/>',
  trophy: '<path d="M6 4h12v5a6 6 0 0 1-12 0V4z"/><path d="M6 6H3v3a3 3 0 0 0 3 3"/><path d="M18 6h3v3a3 3 0 0 1-3 3"/><line x1="12" y1="15" x2="12" y2="20"/><line x1="8" y1="20" x2="16" y2="20"/>',
  coin: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7" x2="12" y2="17"/><path d="M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><circle cx="17.5" cy="9" r="2.5"/><path d="M22 20v-1.5a3 3 0 0 0-3-3h-1"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><rect x="10.7" y="10.7" width="2.6" height="2.6" fill="currentColor" stroke="none"/>',
  dice: '<rect x="3" y="3" width="18" height="18"/><rect x="7" y="7" width="2.4" height="2.4" fill="currentColor" stroke="none"/><rect x="14.6" y="7" width="2.4" height="2.4" fill="currentColor" stroke="none"/><rect x="10.8" y="10.8" width="2.4" height="2.4" fill="currentColor" stroke="none"/><rect x="7" y="14.6" width="2.4" height="2.4" fill="currentColor" stroke="none"/><rect x="14.6" y="14.6" width="2.4" height="2.4" fill="currentColor" stroke="none"/>',
  shuffle: '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>',
  timer: '<line x1="9" y1="2" x2="15" y2="2"/><circle cx="12" cy="13" r="8"/><line x1="12" y1="9" x2="12" y2="13"/>',
  sun: '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="7.1" y2="7.1"/><line x1="16.9" y1="16.9" x2="19.1" y2="19.1"/><line x1="19.1" y1="4.9" x2="16.9" y2="7.1"/><line x1="7.1" y1="16.9" x2="4.9" y2="19.1"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/>',
  droplet: '<path d="M12 2.5L5.5 11.5a6.5 6.5 0 1 0 13 0L12 2.5z"/>',
  wind: '<path d="M3 8h11a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 12h15a2.5 2.5 0 1 1-2.5 2.5"/><path d="M3 16h8a2 2 0 1 1-2 2"/>',
  cloud: '<path d="M6 19h12a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.8 9.2 4.5 4.5 0 0 0 6 19z"/>',
  book: '<path d="M4 4h11a3 3 0 0 1 3 3v13H6a2 2 0 0 1-2-2V4z"/><line x1="8" y1="4" x2="8" y2="20"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  git: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><line x1="6" y1="8.5" x2="6" y2="15.5"/><path d="M18 8.5V12H6"/>',
  flame: '<path d="M12 2c3 4 6 6.5 6 11a6 6 0 1 1-12 0c0-2.6 1.5-4.7 3-6.5.3 2 1.5 3 2.5 3C10.5 7 11.2 4.3 12 2z"/>',
  shield: '<path d="M12 2L4 5v6c0 5.2 3.4 9.5 8 11 4.6-1.5 8-5.8 8-11V5l-8-3z"/>',
  swords: '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><polyline points="9.5 17.5 21 6 21 3 18 3 6.5 14.5"/><line x1="11" y1="19" x2="5" y2="13"/><line x1="8" y1="16" x2="4" y2="20"/>',
  "bar-chart": '<rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/>',
  info: '<rect x="3" y="3" width="18" height="18"/><line x1="12" y1="11" x2="12" y2="17"/><rect x="10.9" y="7" width="2.2" height="2.2" fill="currentColor" stroke="none"/>',
  alert: '<polygon points="12 3 22 20 2 20"/><line x1="12" y1="9" x2="12" y2="14"/><rect x="10.9" y="16" width="2.2" height="2.2" fill="currentColor" stroke="none"/>',
};

const EMOJI_TO_ICON_PREFIX = [
  ["🪙", "coin"],
  ["👥", "users"],
  ["🎯", "target"],
  ["🎲", "dice"],
  ["🔀", "shuffle"],
  ["🏆", "trophy"],
  ["⭐", "star-filled"],
  ["🌟", "star-filled"],
  ["🔥", "flame"],
  ["💧", "droplet"],
  ["☀", "sun"],
  ["🌙", "moon"],
  ["💨", "wind"],
  ["☁", "cloud"],
  ["⏱", "timer"],
  ["⏰", "clock"],
  ["🕒", "clock"],
  ["📖", "book"],
  ["📚", "book"],
  ["🔍", "search"],
  ["🔎", "search"],
  ["🔗", "link"],
  ["📊", "bar-chart"],
  ["📋", "list"],
  ["🛡", "shield"],
  ["⚔", "swords"],
  ["✅", "check"],
  ["☑", "check"],
  ["✔", "check"],
  ["❌", "close"],
  ["✖", "close"],
  ["➕", "plus"],
  ["🔄", "refresh"],
  ["🔁", "reset"],
  ["▶", "play"],
  ["⏸", "pause"],
  ["⏮", "prev"],
  ["⏭", "next"],
  ["⚠", "alert"],
  ["ℹ", "info"],
  ["✏", "edit"],
  ["🗑", "trash"],
];

// Matches Unicode pictorial emojis, variation selectors, keycap marks, and ZWJ emoji joiners.
const PICTOGRAPHIC_EMOJI_RE = /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*|\uFE0F|[\u{1F1E6}-\u{1F1FF}])/gu;

export const AVAILABLE_ICON_NAMES = Object.freeze(Object.keys(ICON_PATHS));

export function hasIcon(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(ICON_PATHS, name.trim().toLowerCase());
}

export function renderIconSvg(name, { size = 14, className = "metro-icon" } = {}) {
  const key = typeof name === "string" ? name.trim().toLowerCase() : "";
  const body = ICON_PATHS[key];
  if (!body) return "";
  const px = Math.max(10, Math.min(28, Number(size) || 14));
  const cls = String(className || "metro-icon").replace(/[^a-zA-Z0-9 _-]/g, "");
  return `<svg class="${cls}" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${body}</svg>`;
}

/**
 * Strips all pictorial emojis from bot-supplied text so no OS/font emojis render in cards.
 */
export function stripBotEmojis(raw) {
  if (raw == null) return "";
  return String(raw)
    .replace(PICTOGRAPHIC_EMOJI_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
}

/**
 * Resolves an explicit icon name OR maps a leading emoji from an external bot label to a
 * matching Flat Metro SVG icon name, returning `{ icon, text }` with all emojis stripped.
 */
export function resolveIconAndText(rawText, explicitIcon = "") {
  const s = String(rawText ?? "").trim();
  let icon = hasIcon(explicitIcon) ? explicitIcon.trim().toLowerCase() : "";
  if (!icon && s) {
    for (const [prefix, mapped] of EMOJI_TO_ICON_PREFIX) {
      if (s.startsWith(prefix)) {
        icon = mapped;
        break;
      }
    }
  }
  return {
    icon,
    text: stripBotEmojis(s),
  };
}
