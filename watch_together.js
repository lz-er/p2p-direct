/**
 * Synchronized Watch Together (YouTube / Spotify / SoundCloud / Twitch) & GIF/Video sync helpers.
 *
 * Design principles:
 * - Zero third-party scripts are loaded until a room actually starts a Watch Together session.
 * - All playback commands (play, pause, seek, speed, loop, replay, queue) are synchronized across
 *   the room via E2EE `media-sync` frames in Safe Rust WASM.
 * - Volume and mute are STRICTLY LOCAL to each user's device and are never transmitted or applied
 *   from remote sync updates.
 */

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const SPOTIFY_HOSTS = new Set(["open.spotify.com", "play.spotify.com"]);

const SOUNDCLOUD_HOSTS = new Set([
  "soundcloud.com",
  "www.soundcloud.com",
  "m.soundcloud.com",
  "on.soundcloud.com",
]);

const TWITCH_HOSTS = new Set([
  "twitch.tv",
  "www.twitch.tv",
  "m.twitch.tv",
  "clips.twitch.tv",
  "player.twitch.tv",
]);

const SOUNDCLOUD_RESERVED_ROOTS = new Set([
  "",
  "discover",
  "search",
  "stream",
  "settings",
  "you",
  "notifications",
  "messages",
  "upload",
  "charts",
  "people",
  "stations",
  "terms-of-use",
  "pages",
]);

const TWITCH_RESERVED_ROOTS = new Set([
  "",
  "directory",
  "downloads",
  "jobs",
  "p",
  "settings",
  "subscriptions",
  "inventory",
  "drops",
  "wallet",
  "turbo",
  "prime",
  "search",
  "login",
  "signup",
  "videos",
  "collections",
  "popout",
  "moderator",
  "u",
  "embed",
  "friends",
  "messages",
  "broadcast",
  "manager",
  "store",
  "bits",
  "team",
  "products",
  "security",
  "annual-recap",
  "activate",
]);

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_LIST_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{15,30}$/;
const SPOTIFY_TYPES = new Set(["track", "album", "playlist", "episode", "show"]);
const SOUNDCLOUD_SECRET_RE = /^s-[A-Za-z0-9_-]{4,64}$/i;
const SOUNDCLOUD_PLAYLIST_TABS = new Set(["likes", "tracks", "popular-tracks"]);
const TWITCH_CHANNEL_RE = /^[a-z0-9_]{2,25}$/i;
const TWITCH_VIDEO_RE = /^\d{5,16}$/;
const TWITCH_COLLECTION_RE = /^[A-Za-z0-9_-]{6,64}$/;
const TWITCH_CLIP_RE = /^[A-Za-z0-9_-]{4,128}$/;

function normalizeTwitchVideoId(raw) {
  const cleaned = String(raw || "").trim().replace(/^v(?=\d+$)/i, "");
  return TWITCH_VIDEO_RE.test(cleaned) ? cleaned : "";
}

function formatTwitchTime(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}h${m}m${s}s`;
}

function parseTwitchMediaKind(mediaId) {
  const s = String(mediaId || "");
  if (s.startsWith("channel:")) {
    const ch = s.slice(8).toLowerCase();
    return TWITCH_CHANNEL_RE.test(ch) ? { kind: "channel", id: ch } : null;
  }
  if (s.startsWith("video:")) {
    const vid = normalizeTwitchVideoId(s.slice(6));
    return vid ? { kind: "video", id: vid } : null;
  }
  if (s.startsWith("collection:")) {
    const col = s.slice(11);
    return TWITCH_COLLECTION_RE.test(col) ? { kind: "collection", id: col } : null;
  }
  if (s.startsWith("clip:")) {
    const slug = s.slice(5);
    return TWITCH_CLIP_RE.test(slug) ? { kind: "clip", id: slug } : null;
  }
  return null;
}

function getTwitchParentHost() {
  if (typeof window !== "undefined" && window.location && window.location.hostname) {
    return window.location.hostname;
  }
  return "localhost";
}

/**
 * Parses YouTube / Twitch `t=` / `start=` timestamp strings (`90`, `90s`, `1m30s`, `1h2m3s`) into ms.
 */
export function parseYouTubeStartMs(raw) {
  if (!raw) return 0;
  const s = String(raw).trim().toLowerCase();
  if (/^\d+$/.test(s)) {
    return Math.min(86400 * 1000, Number(s) * 1000);
  }
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!m) return 0;
  const hours = Number(m[1] || 0);
  const mins = Number(m[2] || 0);
  const secs = Number(m[3] || 0);
  const totalSec = hours * 3600 + mins * 60 + secs;
  return Number.isFinite(totalSec) && totalSec > 0 ? Math.min(86400 * 1000, totalSec * 1000) : 0;
}

/**
 * Parses a YouTube, YouTube Music, Spotify, SoundCloud, or Twitch link (live channel, video,
 * VOD, clip, collection, or playlist) into a normalized Watch Together descriptor, or `null`.
 */
export function parseWatchMediaUrl(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);

  // 1. YouTube & YouTube Music (videos, songs, pure playlists, albums, and video-in-playlist URLs)
  if (YOUTUBE_HOSTS.has(host)) {
    const isYtMusic = host === "music.youtube.com";
    const provider = isYtMusic ? "ytmusic" : "youtube";
    const providerLabel = isYtMusic ? "YouTube Music" : "YouTube";

    let videoId = "";
    if (host === "youtu.be" || host === "www.youtu.be") {
      videoId = segments[0] || "";
    } else if (segments[0] === "watch") {
      videoId = parsed.searchParams.get("v") || "";
    } else if (
      (segments[0] === "shorts" || segments[0] === "live" || segments[0] === "embed") &&
      segments[1] &&
      segments[1] !== "videoseries"
    ) {
      videoId = segments[1];
    }
    const validVideoId = YOUTUBE_ID_RE.test(videoId) ? videoId : "";

    let rawListId = (parsed.searchParams.get("list") || "").trim();
    if (!rawListId && segments[0] === "browse" && segments[1] && segments[1].startsWith("VL")) {
      rawListId = segments[1].slice(2).trim();
    }
    const validListId = YOUTUBE_LIST_ID_RE.test(rawListId) ? rawListId : "";

    const startMs = parseYouTubeStartMs(
      parsed.searchParams.get("t") || parsed.searchParams.get("start") || ""
    );

    if (validListId) {
      const rawIdx = Number(parsed.searchParams.get("index"));
      const playlistIndex =
        Number.isFinite(rawIdx) && rawIdx >= 1 ? Math.min(10000, Math.floor(rawIdx) - 1) : 0;
      const baseOrigin = isYtMusic ? "https://music.youtube.com" : "https://www.youtube.com";
      const canonicalUrl = validVideoId
        ? `${baseOrigin}/watch?v=${validVideoId}&list=${validListId}${playlistIndex > 0 ? `&index=${playlistIndex + 1}` : ""}${startMs > 0 ? `&t=${Math.floor(startMs / 1000)}s` : ""}`
        : `${baseOrigin}/playlist?list=${validListId}`;
      const isAlbumList = isYtMusic && validListId.startsWith("OLAK");
      return {
        provider,
        providerLabel,
        ctaLabel: isYtMusic ? "Listen Playlist" : "Watch Playlist",
        mediaId: `ytpl:${validListId}`,
        isPlaylist: true,
        playlistId: validListId,
        playlistIndex,
        trackUri: validVideoId,
        url: canonicalUrl,
        title: `${providerLabel} ${isAlbumList ? "Album" : "Playlist"} · ${validListId.slice(0, 14)}`,
        subtitle: isAlbumList ? "Album · Playlist" : "Playlist",
        startMs,
      };
    }

    if (!validVideoId) return null;
    const baseOrigin = isYtMusic ? "https://music.youtube.com" : "https://www.youtube.com";
    return {
      provider,
      providerLabel,
      ctaLabel: isYtMusic ? "Listen Together" : "Watch Together",
      mediaId: validVideoId,
      isPlaylist: false,
      playlistId: "",
      playlistIndex: 0,
      trackUri: "",
      url: `${baseOrigin}/watch?v=${validVideoId}${startMs > 0 ? `&t=${Math.floor(startMs / 1000)}s` : ""}`,
      title: `${providerLabel} · ${validVideoId}`,
      subtitle: isYtMusic
        ? "Song"
        : segments[0] === "shorts"
          ? "Short"
          : segments[0] === "live"
            ? "Live"
            : "Video",
      startMs,
    };
  }

  // 2. Spotify (supports /intl-xx/, /embed/, and legacy /user/<user>/playlist/<id> links)
  if (SPOTIFY_HOSTS.has(host)) {
    let segIdx = 0;
    if (segments[segIdx] && /^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[segIdx])) {
      segIdx += 1;
    }
    if (segments[segIdx] === "embed") {
      segIdx += 1;
    }
    if (segments[segIdx] === "user" && segments[segIdx + 1]) {
      segIdx += 2;
    }
    const entityType = (segments[segIdx] || "").toLowerCase();
    const entityId = segments[segIdx + 1] || "";
    if (!SPOTIFY_TYPES.has(entityType) || !SPOTIFY_ID_RE.test(entityId)) {
      return null;
    }
    const isPlaylist =
      entityType === "playlist" || entityType === "album" || entityType === "show";
    const typeTitle = entityType.charAt(0).toUpperCase() + entityType.slice(1);
    const uri = `spotify:${entityType}:${entityId}`;
    return {
      provider: "spotify",
      providerLabel: "Spotify",
      ctaLabel:
        entityType === "playlist"
          ? "Listen Playlist"
          : entityType === "album"
            ? "Listen Album"
            : "Listen Together",
      mediaId: uri,
      entityType,
      isPlaylist,
      playlistId: isPlaylist ? uri : "",
      playlistIndex: 0,
      trackUri: "",
      url: `https://open.spotify.com/${entityType}/${entityId}`,
      title: `Spotify ${typeTitle}`,
      subtitle: isPlaylist ? typeTitle : entityId.slice(0, 12),
      startMs: 0,
    };
  }

  // 3. SoundCloud (tracks, playlists/sets, secret sets /s-xxx, discover/sets, and artist likes/tracks)
  if (SOUNDCLOUD_HOSTS.has(host)) {
    const first = (segments[0] || "").toLowerCase();
    if (host === "on.soundcloud.com") {
      if (!segments[0]) return null;
      const shortUrl = `https://on.soundcloud.com/${segments[0]}`;
      return {
        provider: "soundcloud",
        providerLabel: "SoundCloud",
        ctaLabel: "Listen Together",
        mediaId: shortUrl,
        isPlaylist: false,
        playlistId: "",
        playlistIndex: 0,
        trackUri: "",
        url: shortUrl,
        title: `SoundCloud · ${segments[0]}`,
        subtitle: "Track / Playlist",
        startMs: 0,
      };
    }

    const isDiscoverSet = first === "discover" && segments[1]?.toLowerCase() === "sets" && segments.length >= 3;
    if (!isDiscoverSet && (SOUNDCLOUD_RESERVED_ROOTS.has(first) || segments.length < 2)) {
      return null;
    }

    const second = (segments[1] || "").toLowerCase();
    const isSet = second === "sets" && segments.length >= 3;
    const isCollectionTab = !isDiscoverSet && segments.length === 2 && SOUNDCLOUD_PLAYLIST_TABS.has(second);
    const isPlaylist = isSet || isCollectionTab;

    let cleanPath;
    if (isSet) {
      const secret = segments[3] && SOUNDCLOUD_SECRET_RE.test(segments[3]) ? `/${segments[3]}` : "";
      cleanPath = `${segments[0]}/sets/${segments[2]}${secret}`;
    } else if (isCollectionTab) {
      cleanPath = `${segments[0]}/${segments[1]}`;
    } else {
      const secret = segments[2] && SOUNDCLOUD_SECRET_RE.test(segments[2]) ? `/${segments[2]}` : "";
      cleanPath = `${segments[0]}/${segments[1]}${secret}`;
    }

    const canonical = `https://soundcloud.com/${cleanPath}`;
    const niceArtist = isDiscoverSet ? "SoundCloud" : decodeSafeSlug(segments[0]);
    const niceTrack = decodeSafeSlug(isSet ? segments[2] : segments[1]);
    return {
      provider: "soundcloud",
      providerLabel: "SoundCloud",
      ctaLabel: isPlaylist ? "Listen Playlist" : "Listen Together",
      mediaId: canonical,
      isPlaylist,
      playlistId: isPlaylist ? canonical : "",
      playlistIndex: 0,
      trackUri: "",
      url: canonical,
      title: `${niceArtist} — ${niceTrack}`,
      subtitle: isPlaylist ? "Playlist" : "Track",
      startMs: 0,
    };
  }

  // 4. Twitch (live channels, VODs, collections/playlists, clips, and player.twitch.tv links)
  if (TWITCH_HOSTS.has(host)) {
    const startMs = parseYouTubeStartMs(parsed.searchParams.get("t") || "");

    // 4a. clips.twitch.tv/<slug> or clips.twitch.tv/embed?clip=<slug>
    if (host === "clips.twitch.tv") {
      const slug =
        (segments[0] === "embed" ? parsed.searchParams.get("clip") : segments[0]) || "";
      if (!TWITCH_CLIP_RE.test(slug)) return null;
      return {
        provider: "twitch",
        providerLabel: "Twitch",
        entityType: "clip",
        ctaLabel: "Watch Clip",
        mediaId: `clip:${slug}`,
        isPlaylist: false,
        playlistId: "",
        playlistIndex: 0,
        trackUri: "",
        url: `https://clips.twitch.tv/${slug}`,
        title: `Twitch Clip · ${slug.slice(0, 24)}`,
        subtitle: "Clip",
        startMs: 0,
      };
    }

    // 4b. player.twitch.tv/?channel=<ch> | ?video=<id> | ?collection=<col>
    if (host === "player.twitch.tv") {
      const colRaw = (parsed.searchParams.get("collection") || "").trim();
      const vidId = normalizeTwitchVideoId(parsed.searchParams.get("video") || "");
      const chRaw = (parsed.searchParams.get("channel") || "").trim().toLowerCase();
      if (colRaw && TWITCH_COLLECTION_RE.test(colRaw)) {
        return {
          provider: "twitch",
          providerLabel: "Twitch",
          entityType: "collection",
          ctaLabel: "Watch Collection",
          mediaId: `collection:${colRaw}`,
          isPlaylist: true,
          playlistId: `collection:${colRaw}`,
          playlistIndex: 0,
          trackUri: vidId,
          url: vidId
            ? `https://www.twitch.tv/videos/${vidId}?collection=${colRaw}${startMs > 0 ? `&t=${formatTwitchTime(startMs)}` : ""}`
            : `https://www.twitch.tv/collections/${colRaw}`,
          title: `Twitch Collection · ${colRaw.slice(0, 14)}`,
          subtitle: "Collection",
          startMs,
        };
      }
      if (vidId) {
        return {
          provider: "twitch",
          providerLabel: "Twitch",
          entityType: "video",
          ctaLabel: "Watch Together",
          mediaId: `video:${vidId}`,
          isPlaylist: false,
          playlistId: "",
          playlistIndex: 0,
          trackUri: "",
          url: `https://www.twitch.tv/videos/${vidId}${startMs > 0 ? `?t=${formatTwitchTime(startMs)}` : ""}`,
          title: `Twitch VOD · ${vidId}`,
          subtitle: "VOD",
          startMs,
        };
      }
      if (chRaw && !TWITCH_RESERVED_ROOTS.has(chRaw) && TWITCH_CHANNEL_RE.test(chRaw)) {
        return {
          provider: "twitch",
          providerLabel: "Twitch",
          entityType: "channel",
          ctaLabel: "Watch Live",
          mediaId: `channel:${chRaw}`,
          isPlaylist: false,
          playlistId: "",
          playlistIndex: 0,
          trackUri: "",
          url: `https://www.twitch.tv/${chRaw}`,
          title: `Twitch · ${chRaw}`,
          subtitle: "Live Stream",
          startMs: 0,
        };
      }
      return null;
    }

    const first = (segments[0] || "").toLowerCase();
    const second = (segments[1] || "").toLowerCase();

    // 4c. /<channel>/clip/<slug>
    if (
      segments.length >= 3 &&
      second === "clip" &&
      TWITCH_CHANNEL_RE.test(first) &&
      !TWITCH_RESERVED_ROOTS.has(first) &&
      TWITCH_CLIP_RE.test(segments[2] || "")
    ) {
      const slug = segments[2];
      return {
        provider: "twitch",
        providerLabel: "Twitch",
        entityType: "clip",
        ctaLabel: "Watch Clip",
        mediaId: `clip:${slug}`,
        isPlaylist: false,
        playlistId: "",
        playlistIndex: 0,
        trackUri: "",
        url: `https://www.twitch.tv/${first}/clip/${slug}`,
        title: `Twitch Clip · ${first}`,
        subtitle: "Clip",
        startMs: 0,
      };
    }

    // 4d. /videos/<id>, /<channel>/video/<id>, or /<channel>/v/<id> (optional ?collection=<col> & ?t=)
    let vodId = "";
    if (first === "videos" && segments[1]) {
      vodId = normalizeTwitchVideoId(segments[1]);
    } else if (
      segments.length >= 3 &&
      (second === "video" || second === "v") &&
      TWITCH_CHANNEL_RE.test(first) &&
      !TWITCH_RESERVED_ROOTS.has(first)
    ) {
      vodId = normalizeTwitchVideoId(segments[2]);
    }
    if (vodId) {
      const colRaw = (parsed.searchParams.get("collection") || "").trim();
      const validCol = TWITCH_COLLECTION_RE.test(colRaw) ? colRaw : "";
      if (validCol) {
        return {
          provider: "twitch",
          providerLabel: "Twitch",
          entityType: "collection",
          ctaLabel: "Watch Collection",
          mediaId: `collection:${validCol}`,
          isPlaylist: true,
          playlistId: `collection:${validCol}`,
          playlistIndex: 0,
          trackUri: vodId,
          url: `https://www.twitch.tv/videos/${vodId}?collection=${validCol}${startMs > 0 ? `&t=${formatTwitchTime(startMs)}` : ""}`,
          title: `Twitch Collection · ${validCol.slice(0, 14)}`,
          subtitle: "Collection",
          startMs,
        };
      }
      return {
        provider: "twitch",
        providerLabel: "Twitch",
        entityType: "video",
        ctaLabel: "Watch Together",
        mediaId: `video:${vodId}`,
        isPlaylist: false,
        playlistId: "",
        playlistIndex: 0,
        trackUri: "",
        url: `https://www.twitch.tv/videos/${vodId}${startMs > 0 ? `?t=${formatTwitchTime(startMs)}` : ""}`,
        title: `Twitch VOD · ${vodId}`,
        subtitle: "VOD",
        startMs,
      };
    }

    // 4e. /collections/<colId>
    if (first === "collections" && segments[1] && TWITCH_COLLECTION_RE.test(segments[1])) {
      const colId = segments[1];
      const optVid = normalizeTwitchVideoId(parsed.searchParams.get("video") || "");
      return {
        provider: "twitch",
        providerLabel: "Twitch",
        entityType: "collection",
        ctaLabel: "Watch Collection",
        mediaId: `collection:${colId}`,
        isPlaylist: true,
        playlistId: `collection:${colId}`,
        playlistIndex: 0,
        trackUri: optVid,
        url: `https://www.twitch.tv/collections/${colId}`,
        title: `Twitch Collection · ${colId.slice(0, 14)}`,
        subtitle: "Collection",
        startMs,
      };
    }

    // 4f. Live channel: /<channel> or mobile /<channel>/home
    if (
      (segments.length === 1 || (segments.length === 2 && second === "home")) &&
      !TWITCH_RESERVED_ROOTS.has(first) &&
      TWITCH_CHANNEL_RE.test(first)
    ) {
      return {
        provider: "twitch",
        providerLabel: "Twitch",
        entityType: "channel",
        ctaLabel: "Watch Live",
        mediaId: `channel:${first}`,
        isPlaylist: false,
        playlistId: "",
        playlistIndex: 0,
        trackUri: "",
        url: `https://www.twitch.tv/${first}`,
        title: `Twitch · ${first}`,
        subtitle: "Live Stream",
        startMs: 0,
      };
    }

    return null;
  }

  return null;
}

function decodeSafeSlug(slug) {
  try {
    return decodeURIComponent(slug).replace(/[-_]+/g, " ").trim() || slug;
  } catch {
    return String(slug || "").replace(/[-_]+/g, " ");
  }
}

/**
 * Projects a Rust `MediaSyncState` position forward to `nowMs` on the local clock.
 */
export function projectMediaPositionMs(state, nowMs = Date.now()) {
  if (!state) return 0;
  const base = Number(state.positionMs) || 0;
  if (!state.active || !state.playing) return base;
  const anchor = Number(state.anchorMs) || nowMs;
  const elapsed = Math.max(0, nowMs - anchor);
  const rateMilli = Math.max(250, Math.min(4000, Number(state.rateMilli) || 1000));
  return Math.max(0, Math.round(base + (elapsed * rateMilli) / 1000));
}

/**
 * Binary-searches a Rust-parsed GIF timing table (`cumulativeMs`, `totalDurationMs`) to compute
 * the exact deterministic frame index active at `posMs`.
 */
export function frameIndexForGifTime(timings, posMs) {
  if (!timings || timings.frameCount <= 1 || timings.totalDurationMs <= 0) {
    return 0;
  }
  const wrapped = ((posMs % timings.totalDurationMs) + timings.totalDurationMs) % timings.totalDurationMs;
  const cum = timings.cumulativeMs;
  let lo = 0;
  let hi = timings.frameCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid] <= wrapped) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Formats milliseconds into `M:SS` or `H:MM:SS`.
 */
export function formatClockTime(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ss = s < 10 ? `0${s}` : String(s);
  if (h > 0) {
    const mm = m < 10 ? `0${m}` : String(m);
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

/* ==================== Lazy External Player API Loaders ==================== */

let ytApiPromise = null;
function loadYouTubeIframeApi() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.YT && typeof window.YT.Player === "function") {
    return Promise.resolve(window.YT);
  }
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ytApiPromise = null;
      reject(new Error("YouTube API load timed out"));
    }, 6000);
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      if (typeof prevReady === "function") {
        try {
          prevReady();
        } catch {
          // ignore
        }
      }
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      clearTimeout(timeout);
      ytApiPromise = null;
      reject(new Error("YouTube API script blocked or offline"));
    };
    document.head.appendChild(script);
  });
  return ytApiPromise;
}

let spotifyApiPromise = null;
function loadSpotifyIframeApi() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.__spotifyIframeApi) {
    return Promise.resolve(window.__spotifyIframeApi);
  }
  if (spotifyApiPromise) return spotifyApiPromise;
  spotifyApiPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      spotifyApiPromise = null;
      reject(new Error("Spotify IFrame API load timed out"));
    }, 6000);
    const prevReady = window.onSpotifyIframeApiReady;
    window.onSpotifyIframeApiReady = (IFrameAPI) => {
      clearTimeout(timeout);
      window.__spotifyIframeApi = IFrameAPI;
      if (typeof prevReady === "function") {
        try {
          prevReady(IFrameAPI);
        } catch {
          // ignore
        }
      }
      resolve(IFrameAPI);
    };
    const script = document.createElement("script");
    script.src = "https://open.spotify.com/embed/iframe-api/v1";
    script.async = true;
    script.onerror = () => {
      clearTimeout(timeout);
      spotifyApiPromise = null;
      reject(new Error("Spotify IFrame API blocked or offline"));
    };
    document.head.appendChild(script);
  });
  return spotifyApiPromise;
}

let scApiPromise = null;
function loadSoundCloudWidgetApi() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.SC && typeof window.SC.Widget === "function") {
    return Promise.resolve(window.SC);
  }
  if (scApiPromise) return scApiPromise;
  scApiPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      scApiPromise = null;
      reject(new Error("SoundCloud Widget API load timed out"));
    }, 6000);
    const script = document.createElement("script");
    script.src = "https://w.soundcloud.com/player/api.js";
    script.async = true;
    script.onload = () => {
      clearTimeout(timeout);
      if (window.SC && typeof window.SC.Widget === "function") {
        resolve(window.SC);
      } else {
        scApiPromise = null;
        reject(new Error("SoundCloud Widget API unavailable"));
      }
    };
    script.onerror = () => {
      clearTimeout(timeout);
      scApiPromise = null;
      reject(new Error("SoundCloud Widget API blocked or offline"));
    };
    document.head.appendChild(script);
  });
  return scApiPromise;
}

let twitchApiPromise = null;
function loadTwitchEmbedApi() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.Twitch && typeof window.Twitch.Player === "function") {
    return Promise.resolve(window.Twitch);
  }
  if (twitchApiPromise) return twitchApiPromise;
  twitchApiPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      twitchApiPromise = null;
      reject(new Error("Twitch Embed API load timed out"));
    }, 6000);
    const script = document.createElement("script");
    script.src = "https://player.twitch.tv/js/embed/v1.js";
    script.async = true;
    script.onload = () => {
      clearTimeout(timeout);
      if (window.Twitch && typeof window.Twitch.Player === "function") {
        resolve(window.Twitch);
      } else {
        twitchApiPromise = null;
        reject(new Error("Twitch Embed API unavailable"));
      }
    };
    script.onerror = () => {
      clearTimeout(timeout);
      twitchApiPromise = null;
      reject(new Error("Twitch Embed API blocked or offline"));
    };
    document.head.appendChild(script);
  });
  return twitchApiPromise;
}

/* ==================== Unified Watch Together Player Adapter ==================== */

function isYouTubeFamily(provider) {
  return provider === "youtube" || provider === "ytmusic";
}

export class WatchTogetherPlayer {
  /**
   * @param {HTMLElement} mountEl - Container element where the embed mounts
   * @param {object} callbacks
   * @param {(ev: {playing: boolean, positionMs: number, rateMilli?: number, ended?: boolean, playlistIndex?: number, trackUri?: string, trackTitle?: string}) => void} callbacks.onUserAction
   * @param {(meta: {durationMs: number, positionMs: number, title?: string, ready?: boolean, apiUnavailable?: boolean, playlistCount?: number, playlistIndex?: number, playlistItems?: Array, trackUri?: string, spotifyTrackDetached?: boolean, twitchOffline?: boolean}) => void} callbacks.onTelemetry
   * @param {(muted: boolean) => void} callbacks.onAutoplayMuted
   */
  constructor(mountEl, callbacks = {}) {
    this.mountEl = mountEl;
    this.onUserAction = callbacks.onUserAction || (() => {});
    this.onTelemetry = callbacks.onTelemetry || (() => {});
    this.onAutoplayMuted = callbacks.onAutoplayMuted || (() => {});

    this.provider = "";
    this.mediaId = "";
    this.playlistId = "";
    this.url = "";
    this.generation = 0;
    this.ready = false;
    this.apiUnavailable = false;
    this.durationMs = 0;
    this.lastKnownPosMs = 0;
    this.lastKnownPlaying = false;
    this.lastKnownPlaylistIndex = 0;
    this.lastKnownTrackUri = "";
    this.playlistCount = 0;
    this.playlistItems = [];
    this.spotifyShowingTrackUri = "";
    this.twitchKind = "";
    this.twitchEpoch = 0;
    this.suppressUntilMs = 0;

    // Local-only volume (0..100) & mute — NEVER transmitted or overwritten by remote sync
    this.localVolume = 80;
    this.localMuted = false;

    this.ytPlayer = null;
    this.spotifyCtrl = null;
    this.scWidget = null;
    this.scIframe = null;
    this.twitchPlayer = null;
    this.twitchIframe = null;
    this.pendingState = null;
    this.pollTimer = null;
  }

  _suppress(ms = 900) {
    this.suppressUntilMs = Math.max(this.suppressUntilMs, performance.now() + ms);
  }

  _isSuppressed() {
    return performance.now() < this.suppressUntilMs;
  }

  /**
   * Applies local-only volume (0..100). Never triggers any network sync.
   */
  setLocalVolume(vol0To100) {
    const clean = Math.max(0, Math.min(100, Math.round(Number(vol0To100) || 0)));
    this.localVolume = clean;
    if (clean > 0 && this.localMuted) {
      this.localMuted = false;
      this.onAutoplayMuted(false);
    }
    this._applyLocalVolumeToAdapter();
  }

  /**
   * Applies local-only mute state. Never triggers any network sync.
   */
  setLocalMuted(muted) {
    this.localMuted = Boolean(muted);
    if (!this.localMuted) {
      this.onAutoplayMuted(false);
    }
    this._applyLocalVolumeToAdapter();
  }

  _applyLocalVolumeToAdapter() {
    try {
      if (isYouTubeFamily(this.provider) && this.ytPlayer && this.ready) {
        this.ytPlayer.setVolume(this.localVolume);
        if (this.localMuted) {
          this.ytPlayer.mute();
        } else {
          this.ytPlayer.unMute();
        }
      } else if (this.provider === "soundcloud" && this.scWidget && this.ready) {
        this.scWidget.setVolume(this.localMuted ? 0 : this.localVolume);
      } else if (this.provider === "twitch" && this.twitchPlayer && this.ready) {
        this.twitchPlayer.setVolume?.(Math.max(0, Math.min(1, this.localVolume / 100)));
        this.twitchPlayer.setMuted?.(Boolean(this.localMuted));
      }
    } catch {
      // ignore if player tearing down
    }
  }

  /**
   * For Spotify playlists, switches the local embed back to the full playlist tracklist view
   * so the user can browse and pick another track for the room.
   */
  showSpotifyPlaylistView() {
    if (this.provider !== "spotify" || !this.playlistId || !this.spotifyCtrl) return false;
    this._suppress(1300);
    this.spotifyShowingTrackUri = "";
    try {
      if (typeof this.spotifyCtrl.loadEntity === "function") {
        this.spotifyCtrl.loadEntity(this.playlistId);
      } else if (typeof this.spotifyCtrl.loadUri === "function") {
        this.spotifyCtrl.loadUri(this.playlistId);
      }
      this.onTelemetry({
        durationMs: this.durationMs,
        positionMs: this.lastKnownPosMs,
        ready: this.ready,
        spotifyTrackDetached: false,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Synchronizes the embed to an authoritative `MediaSyncState`.
   */
  async applyState(state, nowMs = Date.now()) {
    if (!state || !state.active || !state.provider || !state.mediaId) {
      this.destroy();
      return;
    }

    this.pendingState = state;
    const isTwitchClipReplay =
      state.provider === "twitch" &&
      this.provider === "twitch" &&
      this.mediaId === state.mediaId &&
      this.twitchKind === "clip" &&
      (Number(state.epoch) || 0) !== this.twitchEpoch;

    const sameMedia =
      !isTwitchClipReplay &&
      this.provider === state.provider &&
      this.mediaId === state.mediaId &&
      (this.playlistId || "") === (state.playlistId || "");

    if (!sameMedia) {
      await this._mountProvider(state);
      return;
    }

    if (this.apiUnavailable) {
      this._renderFallbackStage(state);
      return;
    }

    if (!this.ready) {
      return;
    }
    this._syncMountedPlayer(state, nowMs, false);
  }

  async _mountProvider(state) {
    this._teardownAdapterOnly();
    const gen = ++this.generation;
    this.provider = state.provider;
    this.mediaId = state.mediaId;
    this.playlistId = state.playlistId || "";
    this.url = state.url || "";
    this.ready = false;
    this.apiUnavailable = false;
    this.durationMs = 0;
    this.lastKnownPosMs = projectMediaPositionMs(state, Date.now());
    this.lastKnownPlaying = Boolean(state.playing);
    this.lastKnownPlaylistIndex = Math.max(0, Number(state.playlistIndex) || 0);
    this.lastKnownTrackUri = state.trackUri || "";
    this.playlistCount = 0;
    this.playlistItems = [];
    this.spotifyShowingTrackUri = "";
    this.twitchKind = "";
    this.twitchEpoch = Number(state.epoch) || 0;

    if (!this.mountEl) return;
    this.mountEl.innerHTML = "";

    if (isYouTubeFamily(state.provider)) {
      await this._mountYouTube(state, gen);
    } else if (state.provider === "spotify") {
      await this._mountSpotify(state, gen);
    } else if (state.provider === "soundcloud") {
      await this._mountSoundCloud(state, gen);
    } else if (state.provider === "twitch") {
      await this._mountTwitch(state, gen);
    }
  }

  _refreshYouTubePlaylistInfo() {
    if (!this.ytPlayer || !this.playlistId) return;
    try {
      const list = this.ytPlayer.getPlaylist?.();
      const curIdx = Number(this.ytPlayer.getPlaylistIndex?.());
      const vdata = this.ytPlayer.getVideoData?.() || {};
      if (Array.isArray(list) && list.length > 0) {
        const prevTitles = new Map(this.playlistItems.map((it) => [it.id, it.title]));
        this.playlistCount = list.length;
        this.playlistItems = list.map((vid, idx) => {
          let title = prevTitles.get(vid) || "";
          if (idx === curIdx && vdata.title) {
            title = vdata.title;
          }
          return {
            index: idx,
            id: vid,
            title: title || `Track ${idx + 1} · ${vid}`,
            artist: idx === curIdx && vdata.author ? vdata.author : "",
            durationMs: 0,
          };
        });
      }
    } catch {
      // ignore if player not ready
    }
  }

  async _mountYouTube(state, gen) {
    const holder = document.createElement("div");
    holder.className = "watch-embed-host";
    this.mountEl.appendChild(holder);

    try {
      const YT = await loadYouTubeIframeApi();
      if (gen !== this.generation) return;

      const isPlaylist = Boolean(state.playlistId);
      const startSec = Math.floor(projectMediaPositionMs(state, Date.now()) / 1000);
      const startIdx = Math.max(0, Number(state.playlistIndex) || 0);

      const playerVars = {
        autoplay: 0,
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        enablejsapi: 1,
        origin: typeof window !== "undefined" ? window.location.origin : "",
      };
      const playerOpts = {
        host: "https://www.youtube-nocookie.com",
        width: "100%",
        height: "100%",
        playerVars,
      };

      if (isPlaylist) {
        playerVars.listType = "playlist";
        playerVars.list = state.playlistId;
        playerVars.index = startIdx;
      } else {
        playerOpts.videoId = state.mediaId;
        playerVars.start = startSec;
      }

      this.ytPlayer = new YT.Player(holder, {
        ...playerOpts,
        events: {
          onReady: () => {
            if (gen !== this.generation) return;
            this.ready = true;
            this._applyLocalVolumeToAdapter();

            if (isPlaylist) {
              this._refreshYouTubePlaylistInfo();
              this.ytPlayer.setLoop?.(Boolean(this.pendingState?.loop));
              // If URL had ?v=<videoId>&list=<listId> without &index=, resolve exact 0-based index
              if (
                this.pendingState?.trackUri &&
                (this.pendingState.playlistIndex || 0) === 0 &&
                this.playlistItems.length > 0
              ) {
                const foundIdx = this.playlistItems.findIndex(
                  (it) => it.id === this.pendingState.trackUri
                );
                if (foundIdx > 0) {
                  this.pendingState = { ...this.pendingState, playlistIndex: foundIdx };
                }
              }
              const readyIdx = this.ytPlayer.getPlaylistIndex?.();
              if (typeof readyIdx === "number" && readyIdx >= 0) {
                this.lastKnownPlaylistIndex = readyIdx;
              }
            }

            const dur = Number(this.ytPlayer.getDuration?.() || 0);
            if (dur > 0) this.durationMs = Math.round(dur * 1000);
            const vdata = this.ytPlayer.getVideoData?.() || {};
            if (vdata.video_id) this.lastKnownTrackUri = vdata.video_id;
            this.onTelemetry({
              durationMs: this.durationMs,
              positionMs: this.lastKnownPosMs,
              title: vdata.title || "",
              ready: true,
              playlistCount: this.playlistCount,
              playlistIndex: this.lastKnownPlaylistIndex,
              playlistItems: this.playlistItems,
              trackUri: this.lastKnownTrackUri,
            });
            if (this.pendingState) {
              this._syncMountedPlayer(this.pendingState, Date.now(), true);
            }
            this._startPollLoop(gen);
          },
          onStateChange: (ev) => {
            if (gen !== this.generation) return;
            const code = ev.data;
            const curMs = Math.max(0, Math.round((this.ytPlayer?.getCurrentTime?.() || 0) * 1000));
            const dur = Number(this.ytPlayer?.getDuration?.() || 0);
            if (dur > 0) this.durationMs = Math.round(dur * 1000);
            const rateMilli = Math.round((this.ytPlayer?.getPlaybackRate?.() || 1) * 1000);
            const vdata = this.ytPlayer?.getVideoData?.() || {};
            this.lastKnownPosMs = curMs;

            let trackChanged = false;
            if (this.playlistId) {
              this._refreshYouTubePlaylistInfo();
              const curIdx = this.ytPlayer?.getPlaylistIndex?.();
              if (typeof curIdx === "number" && curIdx >= 0 && curIdx !== this.lastKnownPlaylistIndex) {
                this.lastKnownPlaylistIndex = curIdx;
                trackChanged = true;
              }
              if (vdata.video_id && vdata.video_id !== this.lastKnownTrackUri) {
                this.lastKnownTrackUri = vdata.video_id;
              }
              this.onTelemetry({
                durationMs: this.durationMs,
                positionMs: curMs,
                title: vdata.title || "",
                ready: true,
                playlistCount: this.playlistCount,
                playlistIndex: this.lastKnownPlaylistIndex,
                playlistItems: this.playlistItems,
                trackUri: this.lastKnownTrackUri,
              });
            } else if (vdata.title) {
              this.onTelemetry({
                durationMs: this.durationMs,
                positionMs: curMs,
                title: vdata.title,
                ready: true,
              });
            }

            if (code === 0) {
              // ENDED — in a playlist, YouTube automatically advances unless on the final video
              if (
                this.playlistId &&
                this.playlistCount > 0 &&
                this.lastKnownPlaylistIndex < this.playlistCount - 1
              ) {
                return;
              }
              this.lastKnownPlaying = false;
              this.onUserAction({
                playing: false,
                positionMs: curMs,
                rateMilli,
                ended: true,
                playlistIndex: this.playlistId ? this.lastKnownPlaylistIndex : undefined,
                trackUri: this.playlistId ? this.lastKnownTrackUri : undefined,
              });
              return;
            }
            if (this._isSuppressed()) {
              if (code === 1) this.lastKnownPlaying = true;
              if (code === 2) this.lastKnownPlaying = false;
              return;
            }
            if (code === 1) {
              this.lastKnownPlaying = true;
              this.onUserAction({
                playing: true,
                positionMs: curMs,
                rateMilli,
                playlistIndex: this.playlistId ? this.lastKnownPlaylistIndex : undefined,
                trackUri: this.playlistId ? this.lastKnownTrackUri : undefined,
                trackTitle: vdata.title || undefined,
              });
            } else if (code === 2) {
              this.lastKnownPlaying = false;
              this.onUserAction({
                playing: false,
                positionMs: curMs,
                rateMilli,
                playlistIndex: this.playlistId ? this.lastKnownPlaylistIndex : undefined,
                trackUri: this.playlistId ? this.lastKnownTrackUri : undefined,
                trackTitle: vdata.title || undefined,
              });
            } else if (trackChanged && (code === 3 || code === 5)) {
              this.onUserAction({
                playing: code === 3 || this.lastKnownPlaying,
                positionMs: curMs,
                rateMilli,
                playlistIndex: this.lastKnownPlaylistIndex,
                trackUri: this.lastKnownTrackUri,
                trackTitle: vdata.title || undefined,
              });
            }
          },
          onPlaybackRateChange: (ev) => {
            if (gen !== this.generation || this._isSuppressed()) return;
            const curMs = Math.max(0, Math.round((this.ytPlayer?.getCurrentTime?.() || 0) * 1000));
            const rateMilli = Math.round((Number(ev.data) || 1) * 1000);
            this.onUserAction({
              playing: this.lastKnownPlaying,
              positionMs: curMs,
              rateMilli,
              playlistIndex: this.playlistId ? this.lastKnownPlaylistIndex : undefined,
              trackUri: this.playlistId ? this.lastKnownTrackUri : undefined,
            });
          },
        },
      });
    } catch {
      if (gen !== this.generation) return;
      this.apiUnavailable = true;
      this._renderFallbackStage(state);
    }
  }

  async _mountSpotify(state, gen) {
    const holder = document.createElement("div");
    holder.className = "watch-embed-host is-spotify";
    this.mountEl.appendChild(holder);

    const parsed = parseWatchMediaUrl(state.url);
    const isCollection =
      Boolean(state.playlistId) ||
      (parsed && (parsed.entityType === "playlist" || parsed.entityType === "album" || parsed.entityType === "show"));
    const height = isCollection ? 352 : 152;
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";

    // If joining an active Spotify playlist where a specific trackUri is already playing, start right on it
    const initialUri =
      state.playlistId && state.trackUri && state.trackUri !== state.playlistId
        ? state.trackUri
        : state.mediaId;
    if (state.playlistId && initialUri !== state.playlistId) {
      this.spotifyShowingTrackUri = initialUri;
    }

    try {
      const IFrameAPI = await loadSpotifyIframeApi();
      if (gen !== this.generation) return;

      IFrameAPI.createController(
        holder,
        {
          uri: initialUri,
          width: "100%",
          height,
          theme: isDark ? "dark" : undefined,
        },
        (ctrl) => {
          if (gen !== this.generation) {
            try {
              ctrl.destroy?.();
            } catch {
              // ignore
            }
            return;
          }
          this.spotifyCtrl = ctrl;
          let lastIsPaused = true;
          let lastPosMs = 0;

          ctrl.addListener("ready", () => {
            if (gen !== this.generation) return;
            this.ready = true;
            this.onTelemetry({
              durationMs: this.durationMs,
              positionMs: this.lastKnownPosMs,
              ready: true,
              trackUri: this.lastKnownTrackUri,
              spotifyTrackDetached: Boolean(this.spotifyShowingTrackUri),
            });
            if (this.pendingState) {
              this._syncMountedPlayer(this.pendingState, Date.now(), true);
            }
          });

          // Spotify fires `playback_started` with `playingURI` whenever a track in a playlist/album starts!
          ctrl.addListener("playback_started", (ev) => {
            if (gen !== this.generation) return;
            const playingUri = String(ev?.data?.playingURI || "").trim();
            if (!playingUri) return;
            const changed = playingUri !== this.lastKnownTrackUri;
            this.lastKnownTrackUri = playingUri;
            this.lastKnownPlaying = true;
            this.onTelemetry({
              durationMs: this.durationMs,
              positionMs: this.lastKnownPosMs,
              ready: true,
              trackUri: playingUri,
              spotifyTrackDetached: Boolean(this.spotifyShowingTrackUri),
            });
            if (changed && this.playlistId && !this._isSuppressed()) {
              lastIsPaused = false;
              lastPosMs = 0;
              this.onUserAction({
                playing: true,
                positionMs: 0,
                trackUri: playingUri,
              });
            }
          });

          ctrl.addListener("playback_update", (ev) => {
            if (gen !== this.generation || !ev?.data) return;
            const d = ev.data;
            const posMs = Math.max(0, Number(d.position) || 0);
            const durMs = Math.max(0, Number(d.duration) || 0);
            const playing = !d.isPaused;
            const playingUri = String(d.playingURI || "").trim();
            const uriChanged = Boolean(playingUri && playingUri !== this.lastKnownTrackUri);
            if (playingUri) {
              this.lastKnownTrackUri = playingUri;
            }
            if (durMs > 0) this.durationMs = durMs;
            this.lastKnownPosMs = posMs;
            this.lastKnownPlaying = playing;
            this.onTelemetry({
              durationMs: this.durationMs,
              positionMs: posMs,
              ready: true,
              trackUri: this.lastKnownTrackUri,
              spotifyTrackDetached: Boolean(this.spotifyShowingTrackUri),
            });

            if (this._isSuppressed()) {
              lastIsPaused = Boolean(d.isPaused);
              lastPosMs = posMs;
              return;
            }
            const stateChanged = Boolean(d.isPaused) !== lastIsPaused;
            const jumped = Math.abs(posMs - lastPosMs) > 2200;
            lastIsPaused = Boolean(d.isPaused);
            lastPosMs = posMs;

            if (durMs > 0 && d.isPaused && posMs >= durMs - 400 && !this.playlistId) {
              this.onUserAction({ playing: false, positionMs: posMs, ended: true });
            } else if (stateChanged || jumped || (uriChanged && this.playlistId)) {
              this.onUserAction({
                playing,
                positionMs: posMs,
                trackUri: this.playlistId ? this.lastKnownTrackUri : undefined,
              });
            }
          });
        }
      );
    } catch {
      if (gen !== this.generation) return;
      this.apiUnavailable = true;
      this._renderFallbackStage(state);
    }
  }

  _syncSoundCloudCurrentTrack(gen, emitUserActionIfChanged, playingHint, posMsHint) {
    if (!this.scWidget || gen !== this.generation) return;
    if (typeof this.scWidget.getCurrentSoundIndex !== "function") return;
    try {
      this.scWidget.getCurrentSoundIndex((idx) => {
        if (gen !== this.generation || typeof idx !== "number" || idx < 0) return;
        const idxChanged = idx !== this.lastKnownPlaylistIndex;
        if (idxChanged) {
          this.lastKnownPlaylistIndex = idx;
        }
        const applyMeta = (sound) => {
          if (gen !== this.generation) return;
          if (sound && sound.duration > 0) {
            this.durationMs = Math.round(sound.duration);
          }
          const title = sound?.title
            ? sound.user?.username
              ? `${sound.user.username} — ${sound.title}`
              : sound.title
            : this.playlistItems[idx]
              ? this.playlistItems[idx].artist
                ? `${this.playlistItems[idx].artist} — ${this.playlistItems[idx].title}`
                : this.playlistItems[idx].title
              : "";
          this.onTelemetry({
            durationMs: this.durationMs,
            positionMs: posMsHint !== undefined ? posMsHint : this.lastKnownPosMs,
            title,
            ready: true,
            playlistCount: this.playlistCount,
            playlistIndex: idx,
            playlistItems: this.playlistItems,
          });
          if (emitUserActionIfChanged && idxChanged && !this._isSuppressed()) {
            this.onUserAction({
              playing: playingHint !== undefined ? playingHint : this.lastKnownPlaying,
              positionMs: posMsHint !== undefined ? posMsHint : this.lastKnownPosMs,
              playlistIndex: idx,
              trackTitle: title || undefined,
            });
          }
        };
        if (typeof this.scWidget.getCurrentSound === "function") {
          this.scWidget.getCurrentSound((sound) => applyMeta(sound));
        } else {
          applyMeta(null);
        }
      });
    } catch {
      // ignore
    }
  }

  async _mountSoundCloud(state, gen) {
    const startTrack = Math.max(0, Number(state.playlistIndex) || 0);
    const iframe = document.createElement("iframe");
    iframe.className = `watch-embed-iframe is-soundcloud${state.playlistId ? " is-soundcloud-playlist" : ""}`;
    iframe.setAttribute("allow", "autoplay");
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("frameborder", "no");
    iframe.src =
      `https://w.soundcloud.com/player/?url=${encodeURIComponent(state.url)}` +
      `&color=%23ff5500&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false&visual=false&start_track=${startTrack}`;
    this.scIframe = iframe;
    this.mountEl.appendChild(iframe);

    try {
      const SC = await loadSoundCloudWidgetApi();
      if (gen !== this.generation) return;

      const widget = SC.Widget(iframe);
      this.scWidget = widget;

      widget.bind(SC.Widget.Events.READY, () => {
        if (gen !== this.generation) return;
        this.ready = true;
        this._applyLocalVolumeToAdapter();

        if (typeof widget.getSounds === "function") {
          widget.getSounds((sounds) => {
            if (gen !== this.generation || !Array.isArray(sounds) || sounds.length === 0) return;
            this.playlistCount = sounds.length;
            this.playlistItems = sounds.map((s, idx) => ({
              index: idx,
              id: String(s?.id ?? idx),
              title: s?.title || `Track ${idx + 1}`,
              artist: s?.user?.username || "",
              durationMs: Math.round(Number(s?.duration) || 0),
            }));
            if (sounds.length > 1 && !this.playlistId) {
              this.playlistId = this.url || this.mediaId;
            }
            this.onTelemetry({
              durationMs: this.durationMs,
              positionMs: this.lastKnownPosMs,
              ready: true,
              playlistCount: this.playlistCount,
              playlistIndex: this.lastKnownPlaylistIndex,
              playlistItems: this.playlistItems,
            });
          });
        }

        if (typeof widget.getCurrentSoundIndex === "function") {
          widget.getCurrentSoundIndex((idx) => {
            if (gen !== this.generation) return;
            if (typeof idx === "number" && idx >= 0) {
              this.lastKnownPlaylistIndex = idx;
            }
          });
        }

        widget.getDuration((dur) => {
          if (gen !== this.generation) return;
          if (dur > 0) this.durationMs = Math.round(dur);
          this.onTelemetry({
            durationMs: this.durationMs,
            positionMs: this.lastKnownPosMs,
            ready: true,
            playlistCount: this.playlistCount,
            playlistIndex: this.lastKnownPlaylistIndex,
            playlistItems: this.playlistItems,
          });
        });

        widget.getCurrentSound((sound) => {
          if (gen !== this.generation || !sound) return;
          const title = sound.title
            ? sound.user?.username
              ? `${sound.user.username} — ${sound.title}`
              : sound.title
            : "";
          if (title) {
            this.onTelemetry({
              durationMs: this.durationMs,
              positionMs: this.lastKnownPosMs,
              title,
              ready: true,
              playlistCount: this.playlistCount,
              playlistIndex: this.lastKnownPlaylistIndex,
              playlistItems: this.playlistItems,
            });
          }
        });

        if (this.pendingState) {
          this._syncMountedPlayer(this.pendingState, Date.now(), true);
        }
      });

      widget.bind(SC.Widget.Events.PLAY, (ev) => {
        if (gen !== this.generation) return;
        const posMs = Math.max(0, Math.round(ev?.currentPosition || this.lastKnownPosMs));
        this.lastKnownPosMs = posMs;
        this.lastKnownPlaying = true;
        if (this.playlistCount > 1 || this.playlistId) {
          if (typeof widget.getCurrentSoundIndex === "function") {
            widget.getCurrentSoundIndex((idx) => {
              if (gen !== this.generation) return;
              const resolvedIdx = typeof idx === "number" && idx >= 0 ? idx : this.lastKnownPlaylistIndex;
              this.lastKnownPlaylistIndex = resolvedIdx;
              const item = this.playlistItems[resolvedIdx];
              const title = item
                ? item.artist
                  ? `${item.artist} — ${item.title}`
                  : item.title
                : "";
              if (item && item.durationMs > 0) this.durationMs = item.durationMs;
              this.onTelemetry({
                durationMs: this.durationMs,
                positionMs: posMs,
                title: title || undefined,
                ready: true,
                playlistCount: this.playlistCount,
                playlistIndex: resolvedIdx,
                playlistItems: this.playlistItems,
              });
              if (!this._isSuppressed()) {
                this.onUserAction({
                  playing: true,
                  positionMs: posMs,
                  playlistIndex: resolvedIdx,
                  trackTitle: title || undefined,
                });
              }
            });
            return;
          }
        }
        if (!this._isSuppressed()) {
          this.onUserAction({ playing: true, positionMs: posMs });
        }
      });

      widget.bind(SC.Widget.Events.PAUSE, (ev) => {
        if (gen !== this.generation) return;
        const posMs = Math.max(0, Math.round(ev?.currentPosition || this.lastKnownPosMs));
        this.lastKnownPosMs = posMs;
        this.lastKnownPlaying = false;
        if (!this._isSuppressed()) {
          this.onUserAction({
            playing: false,
            positionMs: posMs,
            playlistIndex: this.playlistCount > 1 || this.playlistId ? this.lastKnownPlaylistIndex : undefined,
          });
        }
      });

      widget.bind(SC.Widget.Events.SEEK, (ev) => {
        if (gen !== this.generation) return;
        const posMs = Math.max(0, Math.round(ev?.currentPosition || 0));
        this.lastKnownPosMs = posMs;
        if (!this._isSuppressed()) {
          this.onUserAction({
            playing: this.lastKnownPlaying,
            positionMs: posMs,
            playlistIndex: this.playlistCount > 1 || this.playlistId ? this.lastKnownPlaylistIndex : undefined,
          });
        }
      });

      widget.bind(SC.Widget.Events.FINISH, () => {
        if (gen !== this.generation) return;
        if (this.playlistCount > 1 && this.lastKnownPlaylistIndex < this.playlistCount - 1) {
          // SoundCloud widget advances to next track inside the playlist; sync next index cleanly
          const nextIdx = this.lastKnownPlaylistIndex + 1;
          this.lastKnownPlaylistIndex = nextIdx;
          this.onUserAction({
            playing: true,
            positionMs: 0,
            playlistIndex: nextIdx,
          });
          return;
        }
        this.lastKnownPlaying = false;
        this.onUserAction({
          playing: false,
          positionMs: this.durationMs,
          ended: true,
          playlistIndex: this.playlistCount > 1 || this.playlistId ? this.lastKnownPlaylistIndex : undefined,
        });
      });

      widget.bind(SC.Widget.Events.PLAY_PROGRESS, (ev) => {
        if (gen !== this.generation || !ev) return;
        const posMs = Math.max(0, Math.round(ev.currentPosition || 0));
        this.lastKnownPosMs = posMs;
        this.onTelemetry({
          durationMs: this.durationMs,
          positionMs: posMs,
          ready: true,
          playlistCount: this.playlistCount,
          playlistIndex: this.lastKnownPlaylistIndex,
        });
      });
    } catch {
      if (gen !== this.generation) return;
      this.apiUnavailable = true;
      this._renderFallbackStage(state);
    }
  }

  async _mountTwitch(state, gen) {
    const info = parseTwitchMediaKind(state.mediaId);
    if (!info) {
      this.apiUnavailable = true;
      this._renderFallbackStage(state);
      return;
    }

    this.twitchKind = info.kind;
    this.twitchEpoch = Number(state.epoch) || 0;
    const parentHost = getTwitchParentHost();

    // Twitch Clips use the official Clips iframe embed (no interactive JS API available).
    // Synced Replay increments `epoch`, which remounts the iframe cleanly across peers.
    if (info.kind === "clip") {
      const iframe = document.createElement("iframe");
      iframe.className = "watch-embed-iframe is-twitch-clip";
      iframe.setAttribute("allowfullscreen", "true");
      iframe.setAttribute("allow", "autoplay; fullscreen");
      iframe.setAttribute("scrolling", "no");
      iframe.setAttribute("frameborder", "0");
      iframe.src =
        `https://clips.twitch.tv/embed?clip=${encodeURIComponent(info.id)}` +
        `&parent=${encodeURIComponent(parentHost)}` +
        `&autoplay=${state.playing ? "true" : "false"}` +
        `&muted=${this.localMuted ? "true" : "false"}`;
      this.twitchIframe = iframe;
      this.mountEl.appendChild(iframe);
      this.ready = true;
      this.onTelemetry({
        durationMs: 0,
        positionMs: 0,
        ready: true,
      });
      return;
    }

    const holder = document.createElement("div");
    holder.id = `watch-twitch-host-${gen}`;
    holder.className = "watch-embed-host is-twitch";
    this.mountEl.appendChild(holder);

    try {
      const Twitch = await loadTwitchEmbedApi();
      if (gen !== this.generation) return;

      const opts = {
        width: "100%",
        height: "100%",
        parent: [parentHost],
        autoplay: Boolean(state.playing),
        muted: Boolean(this.localMuted),
      };

      const initMs = projectMediaPositionMs(state, Date.now());
      if (info.kind === "channel") {
        opts.channel = info.id;
      } else if (info.kind === "video") {
        opts.video = info.id;
        if (initMs > 0) opts.time = formatTwitchTime(initMs);
      } else if (info.kind === "collection") {
        opts.collection = info.id;
        const initVid = normalizeTwitchVideoId(state.trackUri || "");
        if (initVid) opts.video = initVid;
        if (initMs > 0) opts.time = formatTwitchTime(initMs);
      }

      const player = new Twitch.Player(holder.id, opts);
      this.twitchPlayer = player;

      const EV = {
        READY: Twitch.Player.READY || "ready",
        PLAY: Twitch.Player.PLAY || "play",
        PLAYING: Twitch.Player.PLAYING || "playing",
        PAUSE: Twitch.Player.PAUSE || "pause",
        SEEK: Twitch.Player.SEEK || "seek",
        ENDED: Twitch.Player.ENDED || "ended",
        PLAYBACK_BLOCKED: Twitch.Player.PLAYBACK_BLOCKED || "playbackBlocked",
        ONLINE: Twitch.Player.ONLINE || "online",
        OFFLINE: Twitch.Player.OFFLINE || "offline",
      };

      const readPosMs = () => {
        if (this.twitchKind === "channel") return 0;
        const sec = Number(player.getCurrentTime?.() || 0);
        return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
      };
      const readDurMs = () => {
        if (this.twitchKind === "channel") return 0;
        const dur = Number(player.getDuration?.() || 0);
        return Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : 0;
      };
      const readVid = () => normalizeTwitchVideoId(player.getVideo?.() || "");

      player.addEventListener(EV.READY, () => {
        if (gen !== this.generation) return;
        this.ready = true;
        this._applyLocalVolumeToAdapter();
        const durMs = readDurMs();
        if (durMs > 0) this.durationMs = durMs;
        if (this.twitchKind === "collection") {
          const curVid = readVid();
          if (curVid) this.lastKnownTrackUri = curVid;
        }
        this.onTelemetry({
          durationMs: this.durationMs,
          positionMs: readPosMs(),
          ready: true,
          trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
        });
        if (this.pendingState) {
          this._syncMountedPlayer(this.pendingState, Date.now(), true);
        }
        if (this.twitchKind === "video" || this.twitchKind === "collection") {
          this._startPollLoop(gen);
        }
      });

      const handlePlayEvent = () => {
        if (gen !== this.generation) return;
        const posMs = readPosMs();
        const durMs = readDurMs();
        if (durMs > 0) this.durationMs = durMs;
        let vidChanged = false;
        if (this.twitchKind === "collection") {
          const curVid = readVid();
          if (curVid && curVid !== this.lastKnownTrackUri) {
            this.lastKnownTrackUri = curVid;
            vidChanged = true;
          }
        }
        this.lastKnownPosMs = posMs;
        const wasPlaying = this.lastKnownPlaying;
        this.lastKnownPlaying = true;
        this.onTelemetry({
          durationMs: this.durationMs,
          positionMs: posMs,
          ready: true,
          trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
        });
        if (!this._isSuppressed() && (!wasPlaying || vidChanged)) {
          this.onUserAction({
            playing: true,
            positionMs: posMs,
            trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
          });
        }
      };

      player.addEventListener(EV.PLAY, handlePlayEvent);
      player.addEventListener(EV.PLAYING, handlePlayEvent);

      player.addEventListener(EV.PAUSE, () => {
        if (gen !== this.generation) return;
        const posMs = readPosMs();
        this.lastKnownPosMs = posMs;
        const wasPlaying = this.lastKnownPlaying;
        this.lastKnownPlaying = false;
        if (!this._isSuppressed() && wasPlaying) {
          this.onUserAction({
            playing: false,
            positionMs: posMs,
            trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
          });
        }
      });

      player.addEventListener(EV.SEEK, (ev) => {
        if (gen !== this.generation || this.twitchKind === "channel") return;
        const sec =
          typeof ev?.position === "number" ? ev.position : Number(player.getCurrentTime?.() || 0);
        const posMs = Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
        this.lastKnownPosMs = posMs;
        this.onTelemetry({
          durationMs: this.durationMs,
          positionMs: posMs,
          ready: true,
          trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
        });
        if (!this._isSuppressed()) {
          this.onUserAction({
            playing: this.lastKnownPlaying,
            positionMs: posMs,
            trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
          });
        }
      });

      player.addEventListener(EV.ENDED, () => {
        if (gen !== this.generation || this.twitchKind === "channel") return;
        const posMs = readPosMs() || this.durationMs;
        this.lastKnownPlaying = false;
        this.onUserAction({
          playing: false,
          positionMs: posMs,
          ended: true,
          trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
        });
      });

      player.addEventListener(EV.PLAYBACK_BLOCKED, () => {
        if (gen !== this.generation) return;
        try {
          this._suppress(900);
          player.setMuted?.(true);
          player.play?.();
          this.localMuted = true;
          this.onAutoplayMuted(true);
        } catch {
          // ignore
        }
      });

      player.addEventListener(EV.OFFLINE, () => {
        if (gen !== this.generation) return;
        this.onTelemetry({
          durationMs: this.durationMs,
          positionMs: 0,
          ready: this.ready,
          twitchOffline: true,
        });
      });

      player.addEventListener(EV.ONLINE, () => {
        if (gen !== this.generation) return;
        this.onTelemetry({
          durationMs: this.durationMs,
          positionMs: 0,
          ready: this.ready,
          twitchOffline: false,
        });
      });
    } catch {
      if (gen !== this.generation) return;
      this.apiUnavailable = true;
      this._renderFallbackStage(state);
    }
  }

  _renderFallbackStage(state) {
    if (!this.mountEl) return;
    this.mountEl.innerHTML = "";
    const box = document.createElement("div");
    box.className = `watch-fallback-stage provider-${state.provider}`;
    box.dataset.watchFallback = state.provider;
    const tag = document.createElement("span");
    tag.className = "watch-fallback-tag";
    const provTag =
      state.provider === "ytmusic"
        ? "YT MUSIC"
        : state.provider === "twitch" && state.mediaId?.startsWith("channel:")
          ? "TWITCH · LIVE"
          : state.provider === "twitch" && state.mediaId?.startsWith("clip:")
            ? "TWITCH · CLIP"
            : state.provider.toUpperCase();
    const plTag = state.playlistId
      ? state.provider === "twitch"
        ? " · COLLECTION"
        : ` · PLAYLIST · TRACK #${(Number(state.playlistIndex) || 0) + 1}`
      : "";
    tag.textContent = `${provTag}${plTag} · SYNCED TRANSPORT`;
    const title = document.createElement("strong");
    title.className = "watch-fallback-title";
    title.textContent = state.title || state.url;
    const sub = document.createElement("span");
    sub.className = "watch-fallback-sub";
    sub.textContent =
      "Embed script offline or blocked — room play, pause, seek, playlist tracks & queue remain E2EE synchronized.";
    box.appendChild(tag);
    box.appendChild(title);
    box.appendChild(sub);
    this.mountEl.appendChild(box);
    this.onTelemetry({
      durationMs: this.durationMs,
      positionMs: projectMediaPositionMs(state, Date.now()),
      ready: false,
      apiUnavailable: true,
      playlistIndex: Number(state.playlistIndex) || 0,
      trackUri: state.trackUri || "",
    });
  }

  _syncMountedPlayer(state, nowMs, isInitial) {
    const targetMs = projectMediaPositionMs(state, nowMs);
    const targetSec = targetMs / 1000;
    const rate = (Number(state.rateMilli) || 1000) / 1000;
    const desiredIdx = Math.max(0, Number(state.playlistIndex) || 0);

    if (isYouTubeFamily(this.provider) && this.ytPlayer) {
      this._suppress(isInitial ? 1400 : 950);
      try {
        if (this.playlistId) {
          this.ytPlayer.setLoop?.(Boolean(state.loop));
          const curIdx =
            typeof this.ytPlayer.getPlaylistIndex === "function"
              ? this.ytPlayer.getPlaylistIndex()
              : this.lastKnownPlaylistIndex;
          if (curIdx !== desiredIdx && desiredIdx >= 0) {
            this._suppress(1700);
            this.lastKnownPlaylistIndex = desiredIdx;
            if (isInitial && !state.playing && typeof this.ytPlayer.cuePlaylist === "function") {
              this.ytPlayer.cuePlaylist({
                listType: "playlist",
                list: this.playlistId,
                index: desiredIdx,
                startSeconds: targetSec,
              });
              return;
            }
            if (typeof this.ytPlayer.playVideoAt === "function") {
              this.ytPlayer.playVideoAt(desiredIdx);
              const checkGen = this.generation;
              if (targetSec > 1.5 || !state.playing) {
                setTimeout(() => {
                  if (checkGen !== this.generation || !this.ytPlayer) return;
                  try {
                    this._suppress(900);
                    if (targetSec > 1.5) {
                      this.ytPlayer.seekTo?.(targetSec, true);
                    }
                    if (!state.playing) {
                      this.ytPlayer.pauseVideo?.();
                    }
                  } catch {
                    // ignore
                  }
                }, 260);
              }
              return;
            }
          }
        }

        const curRate = Number(this.ytPlayer.getPlaybackRate?.() || 1);
        if (Math.abs(curRate - rate) > 0.02) {
          this.ytPlayer.setPlaybackRate?.(rate);
        }
        const curSec = Number(this.ytPlayer.getCurrentTime?.() || 0);
        const driftThreshold = isInitial ? 0.5 : 0.9;
        if (Math.abs(curSec - targetSec) > driftThreshold) {
          this.ytPlayer.seekTo?.(targetSec, true);
        }
        const ytState = this.ytPlayer.getPlayerState?.();
        if (state.playing) {
          if (ytState !== 1 && ytState !== 3) {
            this.ytPlayer.playVideo?.();
            // Autoplay-blocked guard: if YouTube stays unstarted/paused after 900ms, retry muted locally
            const checkGen = this.generation;
            setTimeout(() => {
              if (checkGen !== this.generation || !this.pendingState?.playing || !this.ytPlayer) return;
              const stNow = this.ytPlayer.getPlayerState?.();
              if (stNow !== 1 && stNow !== 3) {
                try {
                  this._suppress(800);
                  this.ytPlayer.mute?.();
                  this.ytPlayer.playVideo?.();
                  this.localMuted = true;
                  this.onAutoplayMuted(true);
                } catch {
                  // ignore
                }
              }
            }, 900);
          }
        } else if (ytState === 1 || ytState === 3) {
          this.ytPlayer.pauseVideo?.();
        }
      } catch {
        // ignore
      }
      return;
    }

    if (this.provider === "spotify" && this.spotifyCtrl) {
      this._suppress(isInitial ? 800 : 650);
      try {
        // Sync active track inside a Spotify playlist/album when another peer picks a specific trackURI
        if (
          this.playlistId &&
          state.trackUri &&
          state.trackUri !== this.playlistId &&
          state.trackUri !== this.lastKnownTrackUri &&
          state.trackUri !== this.spotifyShowingTrackUri
        ) {
          this._suppress(1200);
          this.lastKnownTrackUri = state.trackUri;
          this.spotifyShowingTrackUri = state.trackUri;
          if (typeof this.spotifyCtrl.loadEntity === "function") {
            this.spotifyCtrl.loadEntity(state.trackUri);
          } else if (typeof this.spotifyCtrl.loadUri === "function") {
            this.spotifyCtrl.loadUri(state.trackUri);
          }
          this.onTelemetry({
            durationMs: this.durationMs,
            positionMs: targetMs,
            ready: this.ready,
            trackUri: state.trackUri,
            spotifyTrackDetached: true,
          });
          if (targetSec > 1.2) {
            this.spotifyCtrl.seek?.(Math.floor(targetSec));
          }
          if (state.playing) {
            this.spotifyCtrl.resume?.();
            this.spotifyCtrl.play?.();
          } else {
            this.spotifyCtrl.pause?.();
          }
          return;
        }

        const curSec = this.lastKnownPosMs / 1000;
        if (Math.abs(curSec - targetSec) > (isInitial ? 1.0 : 1.5)) {
          this.spotifyCtrl.seek?.(Math.floor(targetSec));
        }
        if (state.playing) {
          if (!this.lastKnownPlaying || isInitial) {
            this.spotifyCtrl.resume?.();
            this.spotifyCtrl.play?.();
          }
        } else if (this.lastKnownPlaying || !isInitial) {
          this.spotifyCtrl.pause?.();
        }
      } catch {
        // ignore
      }
      return;
    }

    if (this.provider === "soundcloud" && this.scWidget) {
      this._suppress(isInitial ? 1400 : 950);
      try {
        if ((this.playlistCount > 1 || this.playlistId) && desiredIdx !== this.lastKnownPlaylistIndex) {
          this._suppress(1600);
          this.lastKnownPlaylistIndex = desiredIdx;
          this.scWidget.skip?.(desiredIdx);
          const item = this.playlistItems[desiredIdx];
          if (item) {
            if (item.durationMs > 0) this.durationMs = item.durationMs;
            this.onTelemetry({
              durationMs: this.durationMs,
              positionMs: targetMs,
              title: item.artist ? `${item.artist} — ${item.title}` : item.title,
              ready: true,
              playlistCount: this.playlistCount,
              playlistIndex: desiredIdx,
              playlistItems: this.playlistItems,
            });
          }
          const checkGen = this.generation;
          setTimeout(() => {
            if (checkGen !== this.generation || !this.scWidget) return;
            try {
              this._suppress(900);
              if (targetMs > 800) {
                this.scWidget.seekTo?.(targetMs);
              }
              if (state.playing) {
                this.scWidget.play?.();
              } else {
                this.scWidget.pause?.();
              }
            } catch {
              // ignore
            }
          }, 220);
          return;
        }

        if (Math.abs(this.lastKnownPosMs - targetMs) > (isInitial ? 600 : 1100)) {
          this.scWidget.seekTo?.(targetMs);
        }
        if (state.playing) {
          this.scWidget.play?.();
        } else {
          this.scWidget.pause?.();
        }
      } catch {
        // ignore
      }
      return;
    }

    if (this.provider === "twitch" && this.twitchPlayer) {
      this._suppress(isInitial ? 1400 : 950);
      try {
        if (this.twitchKind === "collection") {
          const desiredVid = normalizeTwitchVideoId(state.trackUri || "");
          const curVid = normalizeTwitchVideoId(
            this.twitchPlayer.getVideo?.() || this.lastKnownTrackUri
          );
          const colId = this.mediaId.startsWith("collection:") ? this.mediaId.slice(11) : "";
          if (desiredVid && colId && desiredVid !== curVid) {
            this._suppress(1600);
            this.lastKnownTrackUri = desiredVid;
            this.twitchPlayer.setCollection?.(colId, desiredVid);
            const checkGen = this.generation;
            setTimeout(() => {
              if (checkGen !== this.generation || !this.twitchPlayer) return;
              try {
                this._suppress(900);
                if (targetSec > 1.5) {
                  this.twitchPlayer.seek?.(targetSec);
                }
                if (state.playing) {
                  this.twitchPlayer.play?.();
                } else {
                  this.twitchPlayer.pause?.();
                }
              } catch {
                // ignore
              }
            }, 260);
            return;
          }
        }

        if (this.twitchKind === "video" || this.twitchKind === "collection") {
          const curSec = Number(this.twitchPlayer.getCurrentTime?.() || 0);
          const driftThreshold = isInitial ? 0.6 : 1.0;
          if (Math.abs(curSec - targetSec) > driftThreshold) {
            this.twitchPlayer.seek?.(targetSec);
          }
        }

        const isPaused =
          typeof this.twitchPlayer.isPaused === "function"
            ? Boolean(this.twitchPlayer.isPaused())
            : !this.lastKnownPlaying;
        if (state.playing) {
          if (isPaused || isInitial) {
            this.twitchPlayer.play?.();
          }
          this.lastKnownPlaying = true;
        } else {
          if (!isPaused || isInitial) {
            this.twitchPlayer.pause?.();
          }
          this.lastKnownPlaying = false;
        }
      } catch {
        // ignore
      }
    }
  }

  /**
   * Periodic drift correction (called ~every 1.5s while Watch Together is active & playing).
   */
  correctDrift(state, nowMs = Date.now()) {
    if (!this.ready || !state || !state.active || !state.playing || this._isSuppressed()) {
      return;
    }
    const targetMs = projectMediaPositionMs(state, nowMs);
    if (isYouTubeFamily(this.provider) && this.ytPlayer) {
      try {
        if (this.ytPlayer.getPlayerState?.() !== 1) return;
        const curMs = Math.round((this.ytPlayer.getCurrentTime?.() || 0) * 1000);
        this.lastKnownPosMs = curMs;
        if (Math.abs(curMs - targetMs) > 1200) {
          this._suppress(800);
          this.ytPlayer.seekTo?.(targetMs / 1000, true);
        }
      } catch {
        // ignore
      }
    } else if (this.provider === "soundcloud" && this.scWidget) {
      if (Math.abs(this.lastKnownPosMs - targetMs) > 1500) {
        this._suppress(850);
        try {
          this.scWidget.seekTo?.(targetMs);
        } catch {
          // ignore
        }
      }
    } else if (this.provider === "spotify" && this.spotifyCtrl) {
      if (Math.abs(this.lastKnownPosMs - targetMs) > 2200) {
        this._suppress(950);
        try {
          this.spotifyCtrl.seek?.(Math.floor(targetMs / 1000));
        } catch {
          // ignore
        }
      }
    } else if (
      this.provider === "twitch" &&
      this.twitchPlayer &&
      (this.twitchKind === "video" || this.twitchKind === "collection")
    ) {
      try {
        if (this.twitchPlayer.isPaused?.()) return;
        const curMs = Math.max(
          0,
          Math.round((Number(this.twitchPlayer.getCurrentTime?.()) || 0) * 1000)
        );
        this.lastKnownPosMs = curMs;
        if (Math.abs(curMs - targetMs) > 1300) {
          this._suppress(850);
          this.twitchPlayer.seek?.(targetMs / 1000);
        }
      } catch {
        // ignore
      }
    }
  }

  _startPollLoop(gen) {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (isYouTubeFamily(this.provider)) {
      this.pollTimer = setInterval(() => {
        if (gen !== this.generation || !this.ytPlayer || !this.ready) return;
        try {
          const curMs = Math.max(0, Math.round((this.ytPlayer.getCurrentTime?.() || 0) * 1000));
          const dur = Number(this.ytPlayer.getDuration?.() || 0);
          if (dur > 0) this.durationMs = Math.round(dur * 1000);
          const prevMs = this.lastKnownPosMs;
          this.lastKnownPosMs = curMs;

          let trackChanged = false;
          let vdata = null;
          if (this.playlistId) {
            this._refreshYouTubePlaylistInfo();
            const curIdx = this.ytPlayer.getPlaylistIndex?.();
            vdata = this.ytPlayer.getVideoData?.() || {};
            if (typeof curIdx === "number" && curIdx >= 0 && curIdx !== this.lastKnownPlaylistIndex) {
              this.lastKnownPlaylistIndex = curIdx;
              trackChanged = true;
            }
            if (vdata.video_id) this.lastKnownTrackUri = vdata.video_id;
          }

          this.onTelemetry({
            durationMs: this.durationMs,
            positionMs: curMs,
            title: vdata?.title || undefined,
            ready: true,
            playlistCount: this.playlistCount,
            playlistIndex: this.lastKnownPlaylistIndex,
            playlistItems: this.playlistItems,
            trackUri: this.lastKnownTrackUri,
          });

          // Detect in-iframe YouTube scrubber seeks or playlist track switches
          if (!this._isSuppressed() && this.pendingState) {
            const ytState = this.ytPlayer.getPlayerState?.();
            const rateMilli = Math.round((this.ytPlayer.getPlaybackRate?.() || 1) * 1000);
            if (trackChanged && (ytState === 1 || ytState === 2 || ytState === 3)) {
              this.onUserAction({
                playing: ytState !== 2,
                positionMs: curMs,
                rateMilli,
                playlistIndex: this.lastKnownPlaylistIndex,
                trackUri: this.lastKnownTrackUri,
                trackTitle: vdata?.title || undefined,
              });
              return;
            }
            const expectedMs = projectMediaPositionMs(this.pendingState, Date.now());
            if (
              (ytState === 1 || ytState === 2) &&
              Math.abs(curMs - prevMs) > 1800 &&
              Math.abs(curMs - expectedMs) > 1500
            ) {
              this.onUserAction({
                playing: ytState === 1,
                positionMs: curMs,
                rateMilli,
                playlistIndex: this.playlistId ? this.lastKnownPlaylistIndex : undefined,
                trackUri: this.playlistId ? this.lastKnownTrackUri : undefined,
              });
            }
          }
        } catch {
          // ignore
        }
      }, 500);
      return;
    }

    if (
      this.provider === "twitch" &&
      (this.twitchKind === "video" || this.twitchKind === "collection")
    ) {
      this.pollTimer = setInterval(() => {
        if (gen !== this.generation || !this.twitchPlayer || !this.ready) return;
        try {
          const curSec = Number(this.twitchPlayer.getCurrentTime?.() || 0);
          const curMs = Number.isFinite(curSec) && curSec > 0 ? Math.round(curSec * 1000) : 0;
          const durSec = Number(this.twitchPlayer.getDuration?.() || 0);
          if (Number.isFinite(durSec) && durSec > 0) {
            this.durationMs = Math.round(durSec * 1000);
          }
          const prevMs = this.lastKnownPosMs;
          this.lastKnownPosMs = curMs;

          let vidChanged = false;
          if (this.twitchKind === "collection") {
            const curVid = normalizeTwitchVideoId(this.twitchPlayer.getVideo?.() || "");
            if (curVid && curVid !== this.lastKnownTrackUri) {
              this.lastKnownTrackUri = curVid;
              vidChanged = true;
            }
          }

          this.onTelemetry({
            durationMs: this.durationMs,
            positionMs: curMs,
            ready: true,
            trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
          });

          if (!this._isSuppressed() && this.pendingState) {
            const isPaused = Boolean(this.twitchPlayer.isPaused?.());
            if (vidChanged) {
              this.onUserAction({
                playing: !isPaused,
                positionMs: curMs,
                trackUri: this.lastKnownTrackUri,
              });
              return;
            }
            const expectedMs = projectMediaPositionMs(this.pendingState, Date.now());
            if (Math.abs(curMs - prevMs) > 1800 && Math.abs(curMs - expectedMs) > 1500) {
              this.onUserAction({
                playing: !isPaused,
                positionMs: curMs,
                trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
              });
            }
          }
        } catch {
          // ignore
        }
      }, 500);
    }
  }

  _teardownAdapterOnly() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ytPlayer) {
      try {
        this.ytPlayer.destroy?.();
      } catch {
        // ignore
      }
      this.ytPlayer = null;
    }
    if (this.spotifyCtrl) {
      try {
        this.spotifyCtrl.destroy?.();
      } catch {
        // ignore
      }
      this.spotifyCtrl = null;
    }
    if (this.twitchPlayer) {
      try {
        this.twitchPlayer.pause?.();
      } catch {
        // ignore
      }
      this.twitchPlayer = null;
    }
    this.twitchIframe = null;
    this.scWidget = null;
    this.scIframe = null;
    this.ready = false;
    this.apiUnavailable = false;
  }

  destroy() {
    this.generation++;
    this._teardownAdapterOnly();
    this.provider = "";
    this.mediaId = "";
    this.playlistId = "";
    this.url = "";
    this.pendingState = null;
    this.durationMs = 0;
    this.lastKnownPosMs = 0;
    this.lastKnownPlaying = false;
    this.lastKnownPlaylistIndex = 0;
    this.lastKnownTrackUri = "";
    this.playlistCount = 0;
    this.playlistItems = [];
    this.spotifyShowingTrackUri = "";
    this.twitchKind = "";
    this.twitchEpoch = 0;
    if (this.mountEl) {
      this.mountEl.innerHTML = "";
    }
  }
}
