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

export const SPOTIFY_EMBED_ALLOW =
  "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture; storage-access";

/**
 * Ensures a Spotify embed `<iframe>` has the exact permissions and attributes needed to reuse
 * the user's logged-in Spotify browser session and stream DRM-protected full tracks.
 */
export function configureSpotifyIframeForSession(iframe) {
  if (!iframe || typeof iframe.setAttribute !== "function") return;
  iframe.setAttribute("allow", SPOTIFY_EMBED_ALLOW);
  iframe.setAttribute("loading", "eager");
  iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  if (typeof iframe.getAttribute !== "function" || !iframe.getAttribute("title")) {
    iframe.setAttribute("title", "Spotify player");
  }
  if (typeof iframe.removeAttribute === "function") {
    // `allow` already includes `fullscreen`; removing legacy `allowfullscreen` avoids browser warnings.
    iframe.removeAttribute("allowfullscreen");
    // Never sandbox or make credentialless — Spotify embeds require browser cookies & EME DRM.
    iframe.removeAttribute("sandbox");
    iframe.removeAttribute("credentialless");
  }
  try {
    if ("credentialless" in iframe) {
      iframe.credentialless = false;
    }
  } catch {
    // ignore readonly property in mocked/older environments
  }
}

/**
 * Detects browser and origin characteristics that govern whether Spotify's embed can use
 * the user's logged-in browser session for full-track playback.
 */
export function detectSpotifyBrowserConstraints(envOverride = null) {
  const ua =
    envOverride && typeof envOverride.userAgent === "string"
      ? envOverride.userAgent
      : typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
        ? navigator.userAgent
        : "";
  const hasBrave =
    envOverride && typeof envOverride.isBrave === "boolean"
      ? envOverride.isBrave
      : typeof navigator !== "undefined" && Boolean(navigator.brave);
  const isSecureContext =
    envOverride && typeof envOverride.isSecureContext === "boolean"
      ? envOverride.isSecureContext
      : typeof window !== "undefined" && typeof window.isSecureContext === "boolean"
        ? window.isSecureContext
        : true;

  const isMobile = /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(ua);
  let browser = "other";
  if (hasBrave) {
    browser = "brave";
  } else if (/Firefox\/|FxiOS\//i.test(ua)) {
    browser = "firefox";
  } else if (/Edg\/|EdgA\/|EdgiOS\//i.test(ua)) {
    browser = "edge";
  } else if (
    /Safari\//i.test(ua) &&
    !/Chrome\/|Chromium\/|CriOS\/|Edg\/|OPR\/|Opera|Brave/i.test(ua)
  ) {
    browser = "safari";
  } else if (/Chrome\/|Chromium\/|CriOS\/|OPR\//i.test(ua)) {
    browser = "chrome";
  }

  return {
    browser,
    isMobile,
    isSafari: browser === "safari",
    isSecureContext,
    drmSupported:
      envOverride && typeof envOverride.drmSupported === "boolean"
        ? envOverride.drmSupported
        : null,
  };
}

let spotifyDrmCachedTrue = false;
let spotifyDrmInFlight = null;
/**
 * Probes whether the browser exposes EME / DRM (Widevine, PlayReady, or FairPlay),
 * which Spotify's Harmony embed player requires for full-track logged-in playback.
 * Never permanently caches `false` so enabling DRM and clicking Reload Session re-probes cleanly.
 */
export function probeSpotifyDrmSupport({ force = false } = {}) {
  if (!force && spotifyDrmCachedTrue) return Promise.resolve(true);
  if (!force && spotifyDrmInFlight) return spotifyDrmInFlight;
  const probe = (async () => {
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      return false;
    }
    if (
      typeof navigator === "undefined" ||
      typeof navigator.requestMediaKeySystemAccess !== "function"
    ) {
      return false;
    }
    const candidates = [
      [
        "com.widevine.alpha",
        [
          {
            initDataTypes: ["cenc"],
            audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
          },
        ],
      ],
      [
        "com.microsoft.playready.recommendation",
        [
          {
            initDataTypes: ["cenc"],
            audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
          },
        ],
      ],
      [
        "com.microsoft.playready",
        [
          {
            initDataTypes: ["cenc"],
            audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
          },
        ],
      ],
      [
        "com.apple.fps.1_0",
        [
          {
            audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
          },
        ],
      ],
    ];
    for (const [keySystem, configs] of candidates) {
      try {
        await navigator.requestMediaKeySystemAccess(keySystem, configs);
        spotifyDrmCachedTrue = true;
        return true;
      } catch {
        // try next key system
      }
    }
    if (force) {
      spotifyDrmCachedTrue = false;
    }
    return false;
  })().finally(() => {
    if (spotifyDrmInFlight === probe) {
      spotifyDrmInFlight = null;
    }
  });
  spotifyDrmInFlight = probe;
  return probe;
}

/**
 * Classifies whether the Spotify embed is using a logged-in full-track session or fell back
 * to 30-second preview mode (and why).
 */
export function classifySpotifyPlaybackMode({
  durationMs = 0,
  entityType = "track",
  env = null,
  hasError = false,
  errorMessage = "",
} = {}) {
  const info = env || detectSpotifyBrowserConstraints();
  const dur = Math.max(0, Number(durationMs) || 0);
  const isPodcast = entityType === "episode" || entityType === "show";

  // Actual full-track playback (> 32s) overrides all heuristics.
  if (dur > 32000 && !hasError) {
    return {
      mode: "full",
      isPreview: false,
      browser: info.browser,
      errorMessage: "",
    };
  }
  if (hasError) {
    return {
      mode: "error",
      isPreview: true,
      browser: info.browser,
      errorMessage: String(errorMessage || ""),
    };
  }
  if (info.isMobile) {
    return { mode: "preview-mobile", isPreview: true, browser: info.browser, errorMessage: "" };
  }
  if (info.isSafari) {
    return { mode: "preview-safari", isPreview: true, browser: info.browser, errorMessage: "" };
  }
  if (info.isSecureContext === false) {
    return { mode: "preview-insecure", isPreview: true, browser: info.browser, errorMessage: "" };
  }
  if (info.drmSupported === false) {
    return { mode: "preview-no-drm", isPreview: true, browser: info.browser, errorMessage: "" };
  }
  // Spotify music previews report ~29–30s MP3 duration (~27.5s–31.5s) in `playback_update`.
  if (!isPodcast && dur >= 27500 && dur <= 31500) {
    return { mode: "preview-session", isPreview: true, browser: info.browser, errorMessage: "" };
  }
  return { mode: "checking", isPreview: false, browser: info.browser, errorMessage: "" };
}

/**
 * Returns a concise, browser-specific explanation for why Spotify is in 30s preview mode
 * and how the user can let the embed reuse their logged-in Spotify browser session.
 */
export function formatSpotifySessionGuidance(session) {
  if (!session || !session.isPreview) return "";
  switch (session.mode) {
    case "preview-mobile":
      return "Spotify embeds limit mobile browsers to 30s previews even when logged in. Open in Spotify or use a desktop browser for full embedded tracks.";
    case "preview-safari":
      return "Spotify embeds limit Safari to 30s previews even when logged in. Use Chrome, Firefox, or Edge (with cookies allowed for open.spotify.com) for full tracks.";
    case "preview-insecure":
      return "Spotify full-track DRM & session cookies require HTTPS or localhost. Open this room over HTTPS to use your logged-in Spotify session.";
    case "preview-no-drm":
      return "Browser Protected Content (DRM / Widevine) is disabled — enable DRM in your browser settings for full Spotify tracks, then click Reload Session.";
    case "error":
      return session.errorMessage
        ? `Spotify embed error (${session.errorMessage}). Sign into open.spotify.com in this browser and allow cookies/DRM, then click Reload Session.`
        : "Spotify embed could not start full playback. Sign into open.spotify.com in this browser and allow cookies/DRM, then click Reload Session.";
    case "preview-session":
    default:
      if (session.browser === "firefox") {
        return "Playing 30s preview — Firefox isolates cross-site cookies by default. Click the Shield icon in the address bar to allow cookies for this site while logged into open.spotify.com, then click Reload Session.";
      }
      if (session.browser === "brave") {
        return "Playing 30s preview — Brave Shields block cross-site Spotify cookies. Click the Brave icon → Allow all cookies for this site while logged into open.spotify.com, then click Reload Session.";
      }
      if (session.browser === "edge") {
        return "Playing 30s preview — Sign in at open.spotify.com in this browser and allow third-party cookies for open.spotify.com (tracking prevention / cookie icon), then click Reload Session.";
      }
      return "Playing 30s preview — Sign in at open.spotify.com in this browser and allow third-party cookies for open.spotify.com (eye/cookie icon in address bar), then click Reload Session.";
  }
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

export const WATCH_SYNC_DEFAULTS = Object.freeze({
  POLL_INTERVAL_MS: 333,
  DRASTIC_DRIFT_PLAYING_MS: 3000,
  DRASTIC_DRIFT_PLAYING_SPOTIFY_MS: 4000,
  DRASTIC_DRIFT_PAUSED_MS: 2000,
  MILD_DRIFT_YT_MS: 1200,
  MILD_DRIFT_SC_MS: 1500,
  MILD_DRIFT_TWITCH_MS: 1300,
  MILD_DRIFT_SPOTIFY_MS: 2200,
  RATE_MISMATCH_MILLI: 100,
  CONFIRM_POLLS: 2,
  GRACE_LOCAL_EMBED_MS: 350,
  GRACE_LOCAL_DRIFT_SEEK_MS: 950,
  GRACE_REMOTE_APPLY_MS: 1450,
  GRACE_TRACK_SWITCH_MS: 2200,
  GRACE_INITIAL_MOUNT_MS: 2400,
  GRACE_RESYNC_RETRY_MS: 1600,
  BASE_NEGOTIATION_COOLDOWN_MS: 1800,
  MAX_NEGOTIATION_COOLDOWN_MS: 8000,
  CONVERGED_BACKOFF_RESET_MS: 8000,
  MAX_AUTO_NEGOTIATIONS_IN_WINDOW: 4,
  AUTO_NEGOTIATION_WINDOW_MS: 15000,
  TAB_WAKE_POLL_GAP_MS: 2500,
  CONVERGENCE_POS_TOLERANCE_MS: 2200,
});

function computePeerStaggerMs(peerId) {
  const s = String(peerId || "");
  if (!s) return 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 321;
}

/**
 * Deterministic, clock-skew-independent state divergence detector & shared-state negotiator.
 *
 * Driven by 3 Hz player state snapshots (comparing actual local player state against the room's
 * authoritative `MediaSyncState`). Separates mild local drift catch-up from drastic divergence
 * (play/pause mismatch, large position jump, track/video switch, playback rate mismatch), and
 * prevents multi-peer oscillation via settling grace periods, multi-sample confirmation,
 * autoplay-block / tab-sleep guards, and exponential backoff on LWW tie-break contention.
 */
export class WatchSyncNegotiator {
  constructor(options = {}) {
    this.cfg = { ...WATCH_SYNC_DEFAULTS, ...(options.config || {}) };
    this.getLocalPeerId =
      typeof options.getLocalPeerId === "function"
        ? options.getLocalPeerId
        : () => String(options.localPeerId || "");
    this.explicitStaggerMs =
      typeof options.peerStaggerMs === "number" && Number.isFinite(options.peerStaggerMs)
        ? Math.max(0, options.peerStaggerMs)
        : null;
    this.reset();
  }

  reset() {
    this.currentRev = 0;
    this.convergedToRev = false;
    this.appliedWasInitial = false;
    this.preApplySnapshot = null;
    this.localResyncAttempts = 0;
    this.graceUntilPerf = 0;
    this.negotiationCooldownUntil = 0;
    this.currentBackoffMs = this.cfg.BASE_NEGOTIATION_COOLDOWN_MS;
    this.lastNegotiationPerf = 0;
    this.lastNegotiatedFromRev = -1;
    this.autoNegotiationTimes = [];
    this.convergedSincePerf = 0;
    this.lastPollPerf = 0;
    this.divergenceStreak = 0;
    this.divergenceSignature = "";
  }

  _resetStreak() {
    this.divergenceStreak = 0;
    this.divergenceSignature = "";
  }

  _getStaggerMs() {
    if (this.explicitStaggerMs !== null) return this.explicitStaggerMs;
    return computePeerStaggerMs(this.getLocalPeerId());
  }

  onLocalDriftSeek(nowPerf) {
    this._resetStreak();
    this.graceUntilPerf = Math.max(this.graceUntilPerf, nowPerf + this.cfg.GRACE_LOCAL_DRIFT_SEEK_MS);
  }

  onSharedStateApplied(state, nowPerf, opts = {}) {
    const rev = Number(state?.rev) || 0;
    const source = opts.source || "remote";
    this.currentRev = rev;
    this._resetStreak();

    if (source === "local-embed" || source === "negotiated") {
      this.convergedToRev = true;
      this.appliedWasInitial = false;
      this.localResyncAttempts = 0;
      this.preApplySnapshot = null;
      this.graceUntilPerf = Math.max(this.graceUntilPerf, nowPerf + this.cfg.GRACE_LOCAL_EMBED_MS);
      if (source === "local-embed") {
        // Explicit user click resets automatic-negotiation backoff so controls stay responsive
        this.currentBackoffMs = this.cfg.BASE_NEGOTIATION_COOLDOWN_MS;
        this.autoNegotiationTimes = [];
      }
      return;
    }

    // Detect contention: another peer's remote update arrived shortly after our auto-negotiation
    // (e.g., we lost a simultaneous (rev, actor) LWW tie-break or another peer overrode us).
    if (
      source === "remote" &&
      this.lastNegotiationPerf > 0 &&
      nowPerf - this.lastNegotiationPerf < 5000
    ) {
      this.currentBackoffMs = Math.min(
        this.cfg.MAX_NEGOTIATION_COOLDOWN_MS,
        Math.round(this.currentBackoffMs * 2)
      );
      this.negotiationCooldownUntil = Math.max(
        this.negotiationCooldownUntil,
        nowPerf + this.currentBackoffMs + this._getStaggerMs()
      );
    }

    this.appliedWasInitial = Boolean(opts.isInitial);
    this.localResyncAttempts = 0;

    if (!opts.didMutate) {
      this.convergedToRev = true;
      this.preApplySnapshot = null;
      this.graceUntilPerf = Math.max(this.graceUntilPerf, nowPerf + 500);
      return;
    }

    this.convergedToRev = false;
    this.preApplySnapshot = opts.preApplySnapshot ? { ...opts.preApplySnapshot } : null;
    const graceMs = opts.isInitial
      ? this.cfg.GRACE_INITIAL_MOUNT_MS
      : opts.isTrackSwitch
        ? this.cfg.GRACE_TRACK_SWITCH_MS
        : this.cfg.GRACE_REMOTE_APPLY_MS;
    this.graceUntilPerf = Math.max(this.graceUntilPerf, nowPerf + graceMs);
  }

  _movedSignificantlyFromPreApply(snapshot, sharedState, drasticPosThreshold) {
    const pre = this.preApplySnapshot;
    if (!pre) return false;
    if (
      snapshot.playlistIndex !== undefined &&
      pre.playlistIndex !== undefined &&
      snapshot.playlistIndex !== pre.playlistIndex &&
      snapshot.playlistIndex !== (Number(sharedState.playlistIndex) || 0)
    ) {
      return true;
    }
    if (
      snapshot.trackUri &&
      pre.trackUri &&
      snapshot.trackUri !== pre.trackUri &&
      snapshot.trackUri !== (sharedState.trackUri || "")
    ) {
      return true;
    }
    if (
      snapshot.hasPlayState &&
      typeof pre.playing === "boolean" &&
      Boolean(snapshot.playing) !== pre.playing &&
      Boolean(snapshot.playing) !== Boolean(sharedState.playing)
    ) {
      return true;
    }
    if (
      snapshot.hasPosition &&
      typeof pre.positionMs === "number" &&
      Math.abs(snapshot.positionMs - pre.positionMs) >= drasticPosThreshold
    ) {
      return true;
    }
    return false;
  }

  evaluate(snapshot, sharedState, context = {}) {
    if (!sharedState || !sharedState.active || !snapshot || !snapshot.ready) {
      return { action: "none", reason: "not-ready" };
    }

    const nowPerf = Number(snapshot.observedAt) || 0;
    const wallNowMs = Number(snapshot.wallNowMs) || Date.now();
    const pollGap = this.lastPollPerf > 0 ? nowPerf - this.lastPollPerf : 0;
    this.lastPollPerf = nowPerf;

    const rawExpectedPosMs = projectMediaPositionMs(sharedState, wallNowMs);
    if (
      snapshot.provider === "spotify" &&
      snapshot.durationMs > 0 &&
      snapshot.durationMs <= 35000 &&
      rawExpectedPosMs > snapshot.durationMs
    ) {
      // Logged-out 30s Spotify preview peer cannot seek past preview length — never override full-track peers
      this._resetStreak();
      return { action: "none", reason: "preview-out-of-range" };
    }
    let expectedPosMs = rawExpectedPosMs;
    if (snapshot.durationMs > 0) {
      expectedPosMs = Math.min(expectedPosMs, snapshot.durationMs);
    }
    const driftMs = snapshot.hasPosition ? Math.abs(snapshot.positionMs - expectedPosMs) : 0;
    const playStateMismatch = Boolean(
      snapshot.hasPlayState &&
        !snapshot.buffering &&
        !snapshot.unstarted &&
        !snapshot.ended &&
        Boolean(snapshot.playing) !== Boolean(sharedState.playing)
    );
    const drasticPosThreshold = sharedState.playing
      ? snapshot.provider === "spotify"
        ? this.cfg.DRASTIC_DRIFT_PLAYING_SPOTIFY_MS
        : this.cfg.DRASTIC_DRIFT_PLAYING_MS
      : this.cfg.DRASTIC_DRIFT_PAUSED_MS;
    const positionMismatch = Boolean(
      snapshot.hasPosition &&
        !snapshot.buffering &&
        !snapshot.unstarted &&
        !snapshot.ended &&
        !snapshot.stalled &&
        driftMs >= drasticPosThreshold
    );
    const playlistIdxMismatch = Boolean(
      snapshot.playlistIndex !== undefined &&
        (sharedState.playlistId || (Number(snapshot.playlistCount) || 0) > 1) &&
        snapshot.playlistIndex !== (Number(sharedState.playlistIndex) || 0)
    );
    const trackUriMismatch = Boolean(
      snapshot.trackUri &&
        sharedState.trackUri &&
        snapshot.trackUri !== sharedState.trackUri &&
        (!sharedState.playlistId || snapshot.trackUri !== sharedState.playlistId)
    );
    const trackMismatch = playlistIdxMismatch || trackUriMismatch;
    const rateMismatch = Boolean(
      snapshot.hasRate &&
        Math.abs((Number(snapshot.rateMilli) || 1000) - (Number(sharedState.rateMilli) || 1000)) >=
          this.cfg.RATE_MISMATCH_MILLI
    );
    const isDrastic = playStateMismatch || positionMismatch || trackMismatch || rateMismatch;

    // Backgrounded/sleeping tab wake-up: if the 3 Hz timer was throttled/frozen for > 2.5s,
    // re-sync locally to the room's authoritative state instead of dragging everyone backward.
    if (pollGap > this.cfg.TAB_WAKE_POLL_GAP_MS) {
      this._resetStreak();
      if (isDrastic && !snapshot.ended) {
        this.graceUntilPerf = Math.max(this.graceUntilPerf, nowPerf + this.cfg.GRACE_REMOTE_APPLY_MS);
        return { action: "resync-local", reason: "tab-wake-resync" };
      }
      return { action: "none", reason: "tab-wake-in-sync" };
    }

    // Ignore transient loading / buffering / ended states
    if (snapshot.buffering || snapshot.unstarted || snapshot.ended) {
      this._resetStreak();
      return {
        action: "none",
        reason: snapshot.ended ? "ended" : snapshot.buffering ? "buffering" : "unstarted",
      };
    }

    const isConvergedNow =
      !playStateMismatch &&
      !trackMismatch &&
      !rateMismatch &&
      (!snapshot.hasPosition || driftMs <= this.cfg.CONVERGENCE_POS_TOLERANCE_MS);

    if (isConvergedNow) {
      this.convergedToRev = true;
      this.appliedWasInitial = false;
      this.graceUntilPerf = 0;
      this.localResyncAttempts = 0;
      this._resetStreak();
      if (this.convergedSincePerf === 0) {
        this.convergedSincePerf = nowPerf;
      } else if (nowPerf - this.convergedSincePerf >= this.cfg.CONVERGED_BACKOFF_RESET_MS) {
        this.currentBackoffMs = this.cfg.BASE_NEGOTIATION_COOLDOWN_MS;
      }
      return { action: "none", reason: "in-sync" };
    }

    if (!isDrastic) {
      this._resetStreak();
      return { action: "none", reason: "mild-drift" };
    }

    // Drastic divergence observed
    this.convergedSincePerf = 0;
    if (nowPerf < this.graceUntilPerf) {
      return { action: "none", reason: "in-grace-window" };
    }

    const sig =
      `${trackMismatch ? `t:${snapshot.playlistIndex ?? ""}:${snapshot.trackUri ?? ""}` : ""}` +
      `|${playStateMismatch ? `p:${snapshot.playing ? 1 : 0}` : ""}` +
      `|${positionMismatch ? `d:${snapshot.positionMs >= expectedPosMs ? "+" : "-"}` : ""}` +
      `|${rateMismatch ? `r:${snapshot.rateMilli}` : ""}`;

    if (sig === this.divergenceSignature) {
      this.divergenceStreak += 1;
    } else {
      this.divergenceSignature = sig;
      this.divergenceStreak = 1;
    }

    if (this.divergenceStreak < this.cfg.CONFIRM_POLLS) {
      return { action: "none", reason: "confirming-divergence" };
    }

    // Confirmed drastic divergence — distinguish unconverged remote apply vs genuine divergence
    if (!this.convergedToRev) {
      // Never let a synthetic initial pre-apply snapshot bypass initial/autoplay guards;
      // genuine user clicks still propagate immediately via onUserAction -> local-embed.
      const movedFromPre = this.appliedWasInitial
        ? false
        : this._movedSignificantlyFromPreApply(snapshot, sharedState, drasticPosThreshold);
      if (!movedFromPre) {
        if (this.localResyncAttempts < 1) {
          this.localResyncAttempts += 1;
          this.graceUntilPerf = Math.max(this.graceUntilPerf, nowPerf + this.cfg.GRACE_RESYNC_RETRY_MS);
          this._resetStreak();
          return { action: "resync-local", reason: "unconverged-retry" };
        }
        const hasEverPlayed = Boolean(context.hasEverPlayedLocally);
        if (sharedState.playing && !snapshot.playing && (this.appliedWasInitial || !hasEverPlayed)) {
          // Autoplay-blocked guard: never pause the room just because this browser blocked autoplay
          this._resetStreak();
          this.graceUntilPerf = Math.max(this.graceUntilPerf, nowPerf + 4000);
          return { action: "none", reason: "autoplay-blocked-guard" };
        }
        if (this.appliedWasInitial) {
          this._resetStreak();
          this.graceUntilPerf = Math.max(this.graceUntilPerf, nowPerf + 3000);
          return { action: "none", reason: "initial-unconverged-guard" };
        }
      }
    }

    if (nowPerf < this.negotiationCooldownUntil) {
      return { action: "none", reason: "negotiation-cooldown" };
    }

    this.autoNegotiationTimes = this.autoNegotiationTimes.filter(
      (t) => nowPerf - t < this.cfg.AUTO_NEGOTIATION_WINDOW_MS
    );
    if (this.autoNegotiationTimes.length >= this.cfg.MAX_AUTO_NEGOTIATIONS_IN_WINDOW) {
      this.currentBackoffMs = this.cfg.MAX_NEGOTIATION_COOLDOWN_MS;
      this.negotiationCooldownUntil = nowPerf + this.currentBackoffMs + this._getStaggerMs();
      this._resetStreak();
      return { action: "none", reason: "rate-limited" };
    }

    const reasons = [];
    if (trackMismatch) reasons.push("track-mismatch");
    if (playStateMismatch) reasons.push("play-state");
    if (positionMismatch) reasons.push("position-drift");
    if (rateMismatch) reasons.push("rate-mismatch");

    this.autoNegotiationTimes.push(nowPerf);
    this.lastNegotiationPerf = nowPerf;
    this.lastNegotiatedFromRev = Number(sharedState.rev) || 0;
    this.negotiationCooldownUntil = nowPerf + this.currentBackoffMs + this._getStaggerMs();
    this.graceUntilPerf = Math.max(this.graceUntilPerf, nowPerf + this.cfg.GRACE_LOCAL_EMBED_MS);
    this._resetStreak();

    return {
      action: "negotiate",
      reason: reasons.join("+") || "divergence",
      divergence: {
        playStateMismatch,
        positionMismatch,
        trackMismatch,
        rateMismatch,
        driftMs,
        expectedPosMs,
      },
      proposal: {
        playing: snapshot.hasPlayState ? Boolean(snapshot.playing) : Boolean(sharedState.playing),
        positionMs: snapshot.hasPosition ? Math.max(0, Math.round(snapshot.positionMs)) : expectedPosMs,
        rateMilli: snapshot.hasRate
          ? Math.max(250, Math.min(4000, Math.round(snapshot.rateMilli)))
          : Number(sharedState.rateMilli) || 1000,
        playlistIndex: snapshot.playlistIndex !== undefined ? snapshot.playlistIndex : undefined,
        trackUri: snapshot.trackUri !== undefined ? snapshot.trackUri : undefined,
        trackTitle: snapshot.trackTitle || undefined,
      },
    };
  }
}

function isYouTubeFamily(provider) {
  return provider === "youtube" || provider === "ytmusic";
}

export class WatchTogetherPlayer {
  /**
   * @param {HTMLElement} mountEl - Container element where the embed mounts
   * @param {object} callbacks
   * @param {(ev: {playing: boolean, positionMs: number, rateMilli?: number, ended?: boolean, playlistIndex?: number, trackUri?: string, trackTitle?: string}) => void} callbacks.onUserAction
   * @param {(ev: {playing: boolean, positionMs: number, rateMilli?: number, playlistIndex?: number, trackUri?: string, trackTitle?: string, reason?: string, negotiated?: boolean}) => void} [callbacks.onNegotiateState]
   * @param {(meta: {durationMs: number, positionMs: number, title?: string, ready?: boolean, apiUnavailable?: boolean, playlistCount?: number, playlistIndex?: number, playlistItems?: Array, trackUri?: string, spotifyTrackDetached?: boolean, twitchOffline?: boolean}) => void} callbacks.onTelemetry
   * @param {(muted: boolean) => void} callbacks.onAutoplayMuted
   * @param {() => string} [callbacks.getLocalPeerId]
   * @param {() => number} [callbacks.perfNow]
   * @param {() => number} [callbacks.wallNow]
   */
  constructor(mountEl, callbacks = {}) {
    this.mountEl = mountEl;
    this.onUserAction = callbacks.onUserAction || (() => {});
    this.onNegotiateState =
      typeof callbacks.onNegotiateState === "function"
        ? callbacks.onNegotiateState
        : this.onUserAction;
    this.onTelemetry = callbacks.onTelemetry || (() => {});
    this.onAutoplayMuted = callbacks.onAutoplayMuted || (() => {});
    this._perfNow =
      typeof callbacks.perfNow === "function"
        ? callbacks.perfNow
        : () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    this._wallNow = typeof callbacks.wallNow === "function" ? callbacks.wallNow : () => Date.now();

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
    this.spotifyEntityType = "track";
    this.spotifyIframe = null;
    this.spotifyHasContext = false;
    this.spotifyInitialStartSec = 0;
    this.spotifyLastPosMs = 0;
    this.spotifyLastIsPaused = true;
    this.spotifyAwaitingInitialSettle = false;
    this.spotifyEnv = null;
    this.spotifyHasError = false;
    this.spotifyErrorMessage = "";
    this.spotifySession = null;
    this._nextSpotifyForceDrmProbe = false;
    this.twitchKind = "";
    this.twitchEpoch = 0;
    this.suppressUntilMs = 0;

    // Targeted programmatic command expectation (replaces blunt global echo suppression for YT/SC/Twitch)
    this.expectedCommand = null;
    this._commandSeq = 0;
    this._syncSeq = 0;
    this._syncTimers = new Set();
    this._autoplayTimerId = null;
    this._hasEverPlayedLocally = false;
    this._lastAppliedEpoch = 0;

    // YouTube rebuffer-vs-scrub tracking
    this._ytWasBuffering = false;
    this._ytBufferingFromPosMs = 0;

    // SoundCloud async action & polling race guards
    this._scActionSeq = 0;
    this._scPollSeq = 0;
    this._scPollInFlight = false;
    this._scPollStartedAt = 0;
    this._scPrevPollPlaying = false;
    this._scPrevPollPosMs = -1;
    this._scLastProgressMoveAt = 0;
    this._spPrevPollPosMs = -1;
    this._spLastPosMoveAt = 0;

    // Periodic 3 Hz divergence detector & multi-peer state negotiator
    this.negotiator = new WatchSyncNegotiator({
      getLocalPeerId: callbacks.getLocalPeerId,
      localPeerId: callbacks.localPeerId,
      peerStaggerMs: callbacks.peerStaggerMs,
      config: callbacks.syncConfig,
    });

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
    this.suppressUntilMs = Math.max(this.suppressUntilMs, this._perfNow() + ms);
  }

  _isSuppressed() {
    const now = this._perfNow();
    if (now < this.suppressUntilMs) return true;
    return Boolean(this.expectedCommand && now < this.expectedCommand.expiresAt);
  }

  _scheduleSyncTimer(delayMs, fn) {
    const id = setTimeout(() => {
      this._syncTimers.delete(id);
      if (this._autoplayTimerId === id) {
        this._autoplayTimerId = null;
      }
      fn();
    }, delayMs);
    this._syncTimers.add(id);
    return id;
  }

  _clearAutoplayTimer() {
    if (this._autoplayTimerId !== null) {
      clearTimeout(this._autoplayTimerId);
      this._syncTimers.delete(this._autoplayTimerId);
      this._autoplayTimerId = null;
    }
  }

  _clearSyncTimers() {
    for (const id of this._syncTimers) {
      clearTimeout(id);
    }
    this._syncTimers.clear();
    this._autoplayTimerId = null;
  }

  _setExpectedCommand(spec, windowMs = 950) {
    const now = this._perfNow();
    this.expectedCommand = {
      id: ++this._commandSeq,
      issuedAt: now,
      expiresAt: now + windowMs,
      isInitial: Boolean(spec.isInitial),
      expectTrackSwitch: Boolean(spec.expectTrackSwitch),
      trackSwitchSettled: !spec.expectTrackSwitch,
      expectPlayState: Boolean(spec.expectPlayState),
      targetPlaying: Boolean(spec.targetPlaying),
      playEchoSeen: false,
      expectSeek: Boolean(spec.expectSeek),
      targetPosMs: Number(spec.targetPosMs) || 0,
      seekEchoSeen: false,
      expectRate: Boolean(spec.expectRate),
      targetRateMilli: Number(spec.targetRateMilli) || 1000,
      targetPlaylistIndex: Number(spec.targetPlaylistIndex) || 0,
      targetTrackUri: String(spec.targetTrackUri || ""),
    };
    return this.expectedCommand;
  }

  /**
   * Command-aware echo filter: suppresses ONLY the expected echo of a programmatic command
   * we actually issued, while allowing rapid opposite-direction user clicks (e.g., fast
   * Pause -> Resume inside SoundCloud/YouTube) to propagate immediately.
   */
  _shouldSuppressEmbedEvent(event) {
    const cmd = this.expectedCommand;
    const now = this._perfNow();
    if (!cmd || now >= cmd.expiresAt) {
      this.expectedCommand = null;
      return false;
    }
    const elapsed = now - cmd.issuedAt;

    if (event.kind === "playstate") {
      if (cmd.expectTrackSwitch && !cmd.trackSwitchSettled) {
        return true;
      }
      if (Boolean(event.playing) === cmd.targetPlaying) {
        if (cmd.expectPlayState || cmd.expectSeek || cmd.expectTrackSwitch || cmd.isInitial) {
          cmd.playEchoSeen = true;
          if (
            cmd.expectSeek &&
            typeof event.positionMs === "number" &&
            Math.abs(event.positionMs - cmd.targetPosMs) <= 2200
          ) {
            cmd.seekEchoSeen = true;
          }
          return true;
        }
        return false;
      }
      // Event has the OPPOSITE play/pause state from what we commanded!
      // Once our command echo was observed (or past a brief in-flight race window), this is a genuine user click.
      const inFlightWindowMs = cmd.isInitial ? 450 : 180;
      if (cmd.playEchoSeen || elapsed >= inFlightWindowMs) {
        this.expectedCommand = null;
        this._clearSyncTimers();
        return false;
      }
      return true;
    }

    if (event.kind === "seek") {
      if (cmd.expectTrackSwitch && !cmd.trackSwitchSettled) {
        return true;
      }
      if (cmd.expectSeek) {
        if (Math.abs((Number(event.positionMs) || 0) - cmd.targetPosMs) <= 2200) {
          cmd.seekEchoSeen = true;
          return true;
        }
        if (cmd.seekEchoSeen || elapsed >= 220) {
          this.expectedCommand = null;
          this._clearSyncTimers();
          return false;
        }
        return true;
      }
      return false;
    }

    if (event.kind === "rate") {
      if (cmd.expectRate && Math.abs((Number(event.rateMilli) || 1000) - cmd.targetRateMilli) <= 30) {
        return true;
      }
      return false;
    }

    if (event.kind === "track") {
      if (cmd.expectTrackSwitch) {
        const matchesIdx =
          event.playlistIndex !== undefined && event.playlistIndex === cmd.targetPlaylistIndex;
        const matchesUri =
          Boolean(event.trackUri) && Boolean(cmd.targetTrackUri) && event.trackUri === cmd.targetTrackUri;
        if (matchesIdx || matchesUri || !cmd.trackSwitchSettled || elapsed < 350) {
          return true;
        }
        this.expectedCommand = null;
        this._clearSyncTimers();
        return false;
      }
      return false;
    }

    return false;
  }

  _capturePreApplySnapshot() {
    return {
      playing: Boolean(this.lastKnownPlaying),
      positionMs: Number(this.lastKnownPosMs) || 0,
      playlistIndex: this.lastKnownPlaylistIndex,
      trackUri: this.lastKnownTrackUri || "",
    };
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
    this._suppress(1600);
    this.spotifyShowingTrackUri = "";
    this.spotifyHasContext = false;
    this.spotifyInitialStartSec = 0;
    this.spotifyLastPosMs = 0;
    this.spotifyLastIsPaused = true;
    this.spotifyAwaitingInitialSettle = true;
    try {
      if (typeof this.spotifyCtrl.loadUri === "function") {
        this.spotifyCtrl.loadUri(this.playlistId);
      } else if (typeof this.spotifyCtrl.loadEntity === "function") {
        this.spotifyCtrl.loadEntity(this.playlistId);
      }
      this.onTelemetry({
        durationMs: this.durationMs,
        positionMs: this.lastKnownPosMs,
        ready: this.ready,
        spotifyTrackDetached: false,
        spotifySession: this.spotifySession,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Locally remounts the Spotify embed iframe so the browser sends a fresh request with the
   * user's current Spotify session cookies/permissions, then resyncs to room state.
   * Strictly local — never emits `onUserAction` or disrupts other peers.
   */
  async reloadSpotifySession() {
    if (this.provider !== "spotify" || !this.pendingState || !this.pendingState.active) {
      return false;
    }
    this._nextSpotifyForceDrmProbe = true;
    await this._mountProvider(this.pendingState);
    this._suppress(2500);
    return true;
  }

  _spotifyMatchesPendingState(playing, posMs, playingUri = "") {
    const st = this.pendingState;
    if (!st || !st.active || st.provider !== "spotify") return false;
    if (Boolean(playing) !== Boolean(st.playing)) return false;
    const expectedMs = projectMediaPositionMs(st, this._wallNow());
    if (Math.abs(posMs - expectedMs) > 2500) return false;
    if (this.playlistId && playingUri && st.trackUri && playingUri !== st.trackUri) {
      return false;
    }
    return true;
  }

  _resumeSpotify() {
    if (!this.spotifyCtrl) return;
    // Spotify's `resume` command resumes an active context and automatically starts playback
    // when no context exists yet; calling `play()` immediately after `resume()` restarts from 0:00.
    if (typeof this.spotifyCtrl.resume === "function") {
      this.spotifyCtrl.resume();
    } else if (typeof this.spotifyCtrl.play === "function") {
      this.spotifyCtrl.play();
    }
  }

  /**
   * Synchronizes the embed to an authoritative `MediaSyncState`.
   * @param {object} state
   * @param {number} [nowMs]
   * @param {{source?: "local-embed"|"local-ui"|"remote"|"negotiated"}} [options]
   */
  async applyState(state, nowMs = this._wallNow(), options = {}) {
    if (!state || !state.active || !state.provider || !state.mediaId) {
      this.destroy();
      return;
    }

    const prevState = this.pendingState;
    this.pendingState = state;
    const source = options?.source || "remote";
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

    // If this state update is the self-echo of an event just emitted by this local embed
    // (or a local state negotiation from this player's actual state), do NOT re-command the
    // player and do NOT arm echo suppression — otherwise rapid clicks (< 950ms) get swallowed!
    if (source === "local-embed" || source === "negotiated") {
      const isEpochJump =
        prevState && (Number(state.epoch) || 0) !== (Number(prevState.epoch) || 0);
      if (!isEpochJump) {
        this._lastAppliedEpoch = Number(state.epoch) || 0;
        this._clearSyncTimers();
        this.expectedCommand = null;
        this.suppressUntilMs = 0;
        if (isYouTubeFamily(this.provider) && this.playlistId && this.ytPlayer) {
          try {
            this.ytPlayer.setLoop?.(Boolean(state.loop));
          } catch {
            // ignore
          }
        }
        this.negotiator.onSharedStateApplied(state, this._perfNow(), {
          source,
          didMutate: false,
        });
        if (!this.pollTimer && !(this.provider === "twitch" && this.twitchKind === "clip")) {
          this._startPollLoop(this.generation);
        }
        return;
      }
    }

    this._syncMountedPlayer(state, nowMs, false, { source, prevState });
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
    this.lastKnownPosMs = projectMediaPositionMs(state, this._wallNow());
    this.lastKnownPlaying = Boolean(state.playing);
    this.lastKnownPlaylistIndex = Math.max(0, Number(state.playlistIndex) || 0);
    this.lastKnownTrackUri = state.trackUri || "";
    this.playlistCount = 0;
    this.playlistItems = [];
    this.spotifyShowingTrackUri = "";
    this.spotifyEntityType = "track";
    this.spotifyIframe = null;
    this.spotifyHasContext = false;
    this.spotifyInitialStartSec = 0;
    this.spotifyLastPosMs = 0;
    this.spotifyLastIsPaused = true;
    this.spotifyAwaitingInitialSettle = false;
    this.spotifyEnv = null;
    this.spotifyHasError = false;
    this.spotifyErrorMessage = "";
    this.spotifySession = null;
    this.twitchKind = "";
    this.twitchEpoch = Number(state.epoch) || 0;
    this._lastAppliedEpoch = Number(state.epoch) || 0;
    this._hasEverPlayedLocally = false;
    this._ytWasBuffering = false;
    this._ytBufferingFromPosMs = 0;
    this._scPrevPollPlaying = false;
    this._scPrevPollPosMs = -1;
    this._scLastProgressMoveAt = 0;
    this._spPrevPollPosMs = -1;
    this._spLastPosMoveAt = 0;
    this.negotiator.reset();

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
      const startSec = Math.floor(projectMediaPositionMs(state, this._wallNow()) / 1000);
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
              this._syncMountedPlayer(this.pendingState, this._wallNow(), true, { source: "remote" });
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
            const prevPlaying = this.lastKnownPlaying;
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

            if (code === 3) {
              if (!this._ytWasBuffering) {
                this._ytWasBuffering = true;
                this._ytBufferingFromPosMs = curMs;
              }
              if (
                trackChanged &&
                !this._shouldSuppressEmbedEvent({
                  kind: "track",
                  playlistIndex: this.lastKnownPlaylistIndex,
                  trackUri: this.lastKnownTrackUri,
                })
              ) {
                this.expectedCommand = null;
                this._clearSyncTimers();
                this.onUserAction({
                  playing: true,
                  positionMs: curMs,
                  rateMilli,
                  playlistIndex: this.lastKnownPlaylistIndex,
                  trackUri: this.lastKnownTrackUri,
                  trackTitle: vdata.title || undefined,
                });
              }
              return;
            }

            const wasBuffering = this._ytWasBuffering;
            const bufferingFromPosMs = this._ytBufferingFromPosMs;
            this._ytWasBuffering = false;

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
              this._clearAutoplayTimer();
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

            if (code === 1) {
              this.lastKnownPlaying = true;
              this._hasEverPlayedLocally = true;
              this._clearAutoplayTimer();
              if (
                this._shouldSuppressEmbedEvent({
                  kind: "playstate",
                  playing: true,
                  positionMs: curMs,
                  trackChanged,
                })
              ) {
                return;
              }
              // Distinguish brief local network rebuffering (3 -> 1 at the same spot while already
              // playing) from a user resume or scrubber seek so slow WiFi doesn't drag other peers back.
              if (
                wasBuffering &&
                prevPlaying &&
                !trackChanged &&
                this.pendingState?.playing &&
                Math.abs(curMs - bufferingFromPosMs) < 1500
              ) {
                const expectedMs = projectMediaPositionMs(this.pendingState, this._wallNow());
                const rateDiff = Math.abs(rateMilli - (Number(this.pendingState.rateMilli) || 1000));
                if (rateDiff < 50) {
                  if (Math.abs(curMs - expectedMs) > WATCH_SYNC_DEFAULTS.MILD_DRIFT_YT_MS) {
                    try {
                      this._setExpectedCommand(
                        { expectSeek: true, targetPosMs: expectedMs, targetPlaying: true },
                        850
                      );
                      this.ytPlayer.seekTo?.(expectedMs / 1000, true);
                      this.negotiator.onLocalDriftSeek(this._perfNow());
                    } catch {
                      // ignore
                    }
                  }
                  return;
                }
              }
              this.expectedCommand = null;
              this._clearSyncTimers();
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
              if (
                this._shouldSuppressEmbedEvent({
                  kind: "playstate",
                  playing: false,
                  positionMs: curMs,
                  trackChanged,
                })
              ) {
                return;
              }
              this.expectedCommand = null;
              this._clearSyncTimers();
              this.onUserAction({
                playing: false,
                positionMs: curMs,
                rateMilli,
                playlistIndex: this.playlistId ? this.lastKnownPlaylistIndex : undefined,
                trackUri: this.playlistId ? this.lastKnownTrackUri : undefined,
                trackTitle: vdata.title || undefined,
              });
            } else if (trackChanged && code === 5) {
              if (
                this._shouldSuppressEmbedEvent({
                  kind: "track",
                  playlistIndex: this.lastKnownPlaylistIndex,
                  trackUri: this.lastKnownTrackUri,
                })
              ) {
                return;
              }
              this.expectedCommand = null;
              this._clearSyncTimers();
              this.onUserAction({
                playing: this.lastKnownPlaying,
                positionMs: curMs,
                rateMilli,
                playlistIndex: this.lastKnownPlaylistIndex,
                trackUri: this.lastKnownTrackUri,
                trackTitle: vdata.title || undefined,
              });
            }
          },
          onPlaybackRateChange: (ev) => {
            if (gen !== this.generation) return;
            const curMs = Math.max(0, Math.round((this.ytPlayer?.getCurrentTime?.() || 0) * 1000));
            const rateMilli = Math.round((Number(ev.data) || 1) * 1000);
            if (this._shouldSuppressEmbedEvent({ kind: "rate", rateMilli })) return;
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
    const entityType = parsed?.entityType || "track";
    const isCollection =
      Boolean(state.playlistId) ||
      entityType === "playlist" ||
      entityType === "album" ||
      entityType === "show";
    const height = isCollection ? 352 : 152;
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";

    this.spotifyEntityType = entityType;
    this.spotifyHasContext = false;
    this.spotifyHasError = false;
    this.spotifyErrorMessage = "";
    this.spotifyEnv = detectSpotifyBrowserConstraints();
    this.spotifySession = classifySpotifyPlaybackMode({
      durationMs: 0,
      entityType,
      env: this.spotifyEnv,
    });

    // If joining an active Spotify playlist where a specific trackUri is already playing, start right on it
    const initialUri =
      state.playlistId && state.trackUri && state.trackUri !== state.playlistId
        ? state.trackUri
        : state.mediaId;
    if (state.playlistId && initialUri !== state.playlistId) {
      this.spotifyShowingTrackUri = initialUri;
    }
    const initialStartSec =
      !isCollection || Boolean(this.spotifyShowingTrackUri)
        ? Math.floor(projectMediaPositionMs(state, this._wallNow()) / 1000)
        : 0;
    this.spotifyInitialStartSec = initialStartSec;
    this.spotifyLastPosMs = initialStartSec * 1000;
    this.spotifyLastIsPaused = true;
    this.spotifyAwaitingInitialSettle = true;

    const forceDrmProbe = Boolean(this._nextSpotifyForceDrmProbe);
    this._nextSpotifyForceDrmProbe = false;

    // Non-blocking EME/DRM capability check to surface actionable guidance when DRM is disabled
    probeSpotifyDrmSupport({ force: forceDrmProbe })
      .then((drmSupported) => {
        if (gen !== this.generation || this.provider !== "spotify") return;
        this.spotifyEnv = { ...(this.spotifyEnv || detectSpotifyBrowserConstraints()), drmSupported };
        const nextSession = classifySpotifyPlaybackMode({
          durationMs: this.durationMs,
          entityType: this.spotifyEntityType,
          env: this.spotifyEnv,
          hasError: this.spotifyHasError,
          errorMessage: this.spotifyErrorMessage,
        });
        this.spotifySession = nextSession;
        this.onTelemetry({
          durationMs: this.durationMs,
          positionMs: this.lastKnownPosMs,
          ready: this.ready,
          trackUri: this.lastKnownTrackUri,
          spotifyTrackDetached: Boolean(this.spotifyShowingTrackUri),
          spotifySession: nextSession,
        });
      })
      .catch(() => {
        // ignore probe errors
      });

    try {
      const IFrameAPI = await loadSpotifyIframeApi();
      if (gen !== this.generation) return;

      // Omit `uri` here so Spotify's v1 createController doesn't double-navigate the iframe
      // before we configure session/DRM attributes and attach listeners.
      IFrameAPI.createController(
        holder,
        {
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
          const iframe = ctrl.iframeElement || this.mountEl?.querySelector?.("iframe") || null;
          this.spotifyIframe = iframe;
          configureSpotifyIframeForSession(iframe);

          const updateSpotifySession = (durMs) => {
            const nextSession = classifySpotifyPlaybackMode({
              durationMs: durMs,
              entityType: this.spotifyEntityType,
              env: this.spotifyEnv,
              hasError: this.spotifyHasError,
              errorMessage: this.spotifyErrorMessage,
            });
            this.spotifySession = nextSession;
            return nextSession;
          };

          ctrl.addListener("ready", () => {
            if (gen !== this.generation) return;
            this.ready = true;
            this.onTelemetry({
              durationMs: this.durationMs,
              positionMs: this.lastKnownPosMs,
              ready: true,
              trackUri: this.lastKnownTrackUri,
              spotifyTrackDetached: Boolean(this.spotifyShowingTrackUri),
              spotifySession: this.spotifySession,
            });
            if (this.pendingState) {
              this._syncMountedPlayer(this.pendingState, this._wallNow(), true, { source: "remote" });
            }
          });

          // Spotify fires `playback_started` with `playingURI` whenever a track in a playlist/album starts!
          ctrl.addListener("playback_started", (ev) => {
            if (gen !== this.generation) return;
            const playingUri = String(ev?.data?.playingURI || "").trim();
            if (!playingUri) return;
            this.spotifyHasContext = true;
            this.spotifyHasError = false;
            this.spotifyErrorMessage = "";
            const changed = playingUri !== this.lastKnownTrackUri;
            this.lastKnownTrackUri = playingUri;
            this.lastKnownPlaying = true;
            this.onTelemetry({
              durationMs: this.durationMs,
              positionMs: this.lastKnownPosMs,
              ready: true,
              trackUri: playingUri,
              spotifyTrackDetached: Boolean(this.spotifyShowingTrackUri),
              spotifySession: updateSpotifySession(this.durationMs),
            });
            const matchesPendingTrack =
              Boolean(this.pendingState?.trackUri) && playingUri === this.pendingState.trackUri;
            if (
              changed &&
              this.playlistId &&
              this.ready &&
              !this._isSuppressed() &&
              !matchesPendingTrack
            ) {
              this.spotifyAwaitingInitialSettle = false;
              this.spotifyLastIsPaused = false;
              this.spotifyLastPosMs = 0;
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
            if (playing || posMs > 0 || durMs > 0) {
              this.spotifyHasContext = true;
            }
            if (playing && posMs > 0) {
              this.spotifyHasError = false;
              this.spotifyErrorMessage = "";
            }
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
              spotifySession: updateSpotifySession(this.durationMs),
            });

            if (!this.ready || this._isSuppressed()) {
              this.spotifyLastIsPaused = Boolean(d.isPaused);
              this.spotifyLastPosMs = posMs;
              // Clear initial-settle gate once the embed reaches the expected play/pause state
              // (preserving it when autoplay-blocked paused on a playing room so post-suppress
              // hydration updates are still absorbed without pausing the room).
              if (
                this.ready &&
                !d.isBuffering &&
                (playing || !this.pendingState?.playing) &&
                (durMs > 0 || playing || posMs > 0)
              ) {
                this.spotifyAwaitingInitialSettle = false;
              }
              return;
            }
            // Absorb initial boot/reload hydration updates (paused/buffering/already-matching) so slow
            // iframe loads or autoplay blocks never pause the room, while letting a genuine first Play
            // click on a paused room or new playlist track propagate immediately.
            if (this.spotifyAwaitingInitialSettle) {
              if (
                d.isPaused ||
                d.isBuffering ||
                this._spotifyMatchesPendingState(playing, posMs, playingUri)
              ) {
                this.spotifyLastIsPaused = Boolean(d.isPaused);
                this.spotifyLastPosMs = posMs;
                if (!d.isBuffering) {
                  this.spotifyAwaitingInitialSettle = false;
                }
                return;
              }
              this.spotifyAwaitingInitialSettle = false;
            }
            const stateChanged = Boolean(d.isPaused) !== this.spotifyLastIsPaused;
            const jumped = Math.abs(posMs - this.spotifyLastPosMs) > 2200;
            this.spotifyLastIsPaused = Boolean(d.isPaused);
            this.spotifyLastPosMs = posMs;

            if (durMs > 0 && d.isPaused && posMs >= durMs - 400 && !this.playlistId) {
              this.onUserAction({ playing: false, positionMs: posMs, ended: true });
            } else if (stateChanged || jumped || (uriChanged && this.playlistId)) {
              if (this._spotifyMatchesPendingState(playing, posMs, playingUri)) {
                return;
              }
              this.onUserAction({
                playing,
                positionMs: posMs,
                trackUri: this.playlistId ? this.lastKnownTrackUri : undefined,
              });
            }
          });

          ctrl.addListener("error", (ev) => {
            if (gen !== this.generation) return;
            this.spotifyHasError = true;
            this.spotifyErrorMessage = String(ev?.data?.message || ev?.data?.code || "playback_error");
            this.onTelemetry({
              durationMs: this.durationMs,
              positionMs: this.lastKnownPosMs,
              ready: this.ready,
              trackUri: this.lastKnownTrackUri,
              spotifyTrackDetached: Boolean(this.spotifyShowingTrackUri),
              spotifySession: updateSpotifySession(this.durationMs),
            });
          });

          if (typeof ctrl.loadUri === "function") {
            ctrl.loadUri(initialUri, false, initialStartSec);
          } else if (typeof ctrl.loadEntity === "function") {
            ctrl.loadEntity(initialUri, false, initialStartSec);
          }
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
          this._syncMountedPlayer(this.pendingState, this._wallNow(), true, { source: "remote" });
        }
        this._startPollLoop(gen);
      });

      const readScPosMs = (ev, fallbackMs) => {
        const raw = ev?.currentPosition;
        if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
          return Math.round(raw);
        }
        return Math.max(0, Math.round(Number(fallbackMs) || 0));
      };

      widget.bind(SC.Widget.Events.PLAY, (ev) => {
        if (gen !== this.generation) return;
        const posMs = readScPosMs(ev, this.lastKnownPosMs);
        const actionSeq = ++this._scActionSeq;
        this._scPollSeq += 1; // invalidate any in-flight async poll snapshot
        this.lastKnownPosMs = posMs;
        this.lastKnownPlaying = true;
        this._hasEverPlayedLocally = true;
        this._scLastProgressMoveAt = this._perfNow();

        const isPlaylist = this.playlistCount > 1 || Boolean(this.playlistId);
        let syncIdx = -1;
        if (isPlaylist && ev?.soundId !== undefined && ev.soundId !== null) {
          syncIdx = this.playlistItems.findIndex((it) => it.id === String(ev.soundId));
        }

        const suppressed = this._shouldSuppressEmbedEvent({
          kind: "playstate",
          playing: true,
          positionMs: posMs,
        });

        const emitPlayWithIndex = (resolvedIdx) => {
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
          if (!suppressed) {
            this.expectedCommand = null;
            this._clearSyncTimers();
            this.onUserAction({
              playing: true,
              positionMs: posMs,
              playlistIndex: resolvedIdx,
              trackTitle: title || undefined,
            });
          }
        };

        if (isPlaylist) {
          if (syncIdx >= 0) {
            emitPlayWithIndex(syncIdx);
            return;
          }
          if (typeof widget.getCurrentSoundIndex === "function") {
            let settled = false;
            const fallbackTimer = this._scheduleSyncTimer(160, () => {
              if (settled || gen !== this.generation || actionSeq !== this._scActionSeq) return;
              settled = true;
              emitPlayWithIndex(this.lastKnownPlaylistIndex);
            });
            try {
              widget.getCurrentSoundIndex((idx) => {
                if (settled || gen !== this.generation || actionSeq !== this._scActionSeq) return;
                settled = true;
                clearTimeout(fallbackTimer);
                this._syncTimers.delete(fallbackTimer);
                const resolvedIdx =
                  typeof idx === "number" && idx >= 0 ? idx : this.lastKnownPlaylistIndex;
                emitPlayWithIndex(resolvedIdx);
              });
            } catch {
              if (!settled) {
                settled = true;
                clearTimeout(fallbackTimer);
                this._syncTimers.delete(fallbackTimer);
                emitPlayWithIndex(this.lastKnownPlaylistIndex);
              }
            }
            return;
          }
        }

        if (!suppressed) {
          this.expectedCommand = null;
          this._clearSyncTimers();
          this.onUserAction({
            playing: true,
            positionMs: posMs,
            playlistIndex: isPlaylist ? this.lastKnownPlaylistIndex : undefined,
          });
        }
      });

      widget.bind(SC.Widget.Events.PAUSE, (ev) => {
        if (gen !== this.generation) return;
        const posMs = readScPosMs(ev, this.lastKnownPosMs);
        this._scActionSeq += 1; // cancel any stale in-flight PLAY index lookup
        this._scPollSeq += 1;
        this.lastKnownPosMs = posMs;
        this.lastKnownPlaying = false;
        if (
          !this._shouldSuppressEmbedEvent({
            kind: "playstate",
            playing: false,
            positionMs: posMs,
          })
        ) {
          this.expectedCommand = null;
          this._clearSyncTimers();
          this.onUserAction({
            playing: false,
            positionMs: posMs,
            playlistIndex: this.playlistCount > 1 || this.playlistId ? this.lastKnownPlaylistIndex : undefined,
          });
        }
      });

      widget.bind(SC.Widget.Events.SEEK, (ev) => {
        if (gen !== this.generation) return;
        const posMs = readScPosMs(ev, 0);
        this._scActionSeq += 1;
        this._scPollSeq += 1;
        this.lastKnownPosMs = posMs;
        this._scLastProgressMoveAt = this._perfNow();
        if (!this._shouldSuppressEmbedEvent({ kind: "seek", positionMs: posMs })) {
          this.expectedCommand = null;
          this._clearSyncTimers();
          this.onUserAction({
            playing: this.lastKnownPlaying,
            positionMs: posMs,
            playlistIndex: this.playlistCount > 1 || this.playlistId ? this.lastKnownPlaylistIndex : undefined,
          });
        }
      });

      widget.bind(SC.Widget.Events.FINISH, () => {
        if (gen !== this.generation) return;
        this._scActionSeq += 1;
        this._scPollSeq += 1;
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
        const posMs = readScPosMs(ev, this.lastKnownPosMs);
        if (posMs !== this.lastKnownPosMs) {
          this._scLastProgressMoveAt = this._perfNow();
        }
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

      const initMs = projectMediaPositionMs(state, this._wallNow());
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
          this._syncMountedPlayer(this.pendingState, this._wallNow(), true, { source: "remote" });
        }
        if (this.twitchKind !== "clip") {
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
        this._hasEverPlayedLocally = true;
        this.onTelemetry({
          durationMs: this.durationMs,
          positionMs: posMs,
          ready: true,
          trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
        });
        if (
          this._shouldSuppressEmbedEvent({
            kind: "playstate",
            playing: true,
            positionMs: posMs,
            trackChanged: vidChanged,
          })
        ) {
          return;
        }
        const sharedDisagrees = Boolean(this.pendingState && !this.pendingState.playing);
        if (!wasPlaying || vidChanged || sharedDisagrees) {
          this.expectedCommand = null;
          this._clearSyncTimers();
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
        if (
          this._shouldSuppressEmbedEvent({
            kind: "playstate",
            playing: false,
            positionMs: posMs,
          })
        ) {
          return;
        }
        const sharedDisagrees = Boolean(this.pendingState && this.pendingState.playing);
        if (wasPlaying || sharedDisagrees) {
          this.expectedCommand = null;
          this._clearSyncTimers();
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
        if (!this._shouldSuppressEmbedEvent({ kind: "seek", positionMs: posMs })) {
          this.expectedCommand = null;
          this._clearSyncTimers();
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
          this._setExpectedCommand(
            { expectPlayState: true, targetPlaying: true, isInitial: true },
            950
          );
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
      positionMs: projectMediaPositionMs(state, this._wallNow()),
      ready: false,
      apiUnavailable: true,
      playlistIndex: Number(state.playlistIndex) || 0,
      trackUri: state.trackUri || "",
    });
  }

  _syncMountedPlayer(state, nowMs, isInitial, options = {}) {
    const targetMs = projectMediaPositionMs(state, nowMs);
    const targetSec = targetMs / 1000;
    const rate = (Number(state.rateMilli) || 1000) / 1000;
    const desiredIdx = Math.max(0, Number(state.playlistIndex) || 0);
    const source = options?.source || "remote";
    const forceResync = Boolean(options?.forceResync);
    const prevState = options?.prevState || null;
    const isEpochReplay =
      forceResync ||
      (Number(state.epoch) > 0 &&
        Number(state.epoch) !== (prevState ? Number(prevState.epoch) || 0 : this._lastAppliedEpoch));
    const preApply = isInitial ? null : this._capturePreApplySnapshot();
    const activeCmd =
      this.expectedCommand && this._perfNow() < this.expectedCommand.expiresAt
        ? this.expectedCommand
        : null;
    const hasOppositePendingPlayCmd = Boolean(
      activeCmd && activeCmd.expectPlayState && activeCmd.targetPlaying !== Boolean(state.playing)
    );
    const hasDifferentPendingSeekCmd = Boolean(
      activeCmd && activeCmd.expectSeek && Math.abs(activeCmd.targetPosMs - targetMs) > 1100
    );

    if (this.ready && !this.pollTimer && !(this.provider === "twitch" && this.twitchKind === "clip")) {
      this._startPollLoop(this.generation);
    }

    if (isYouTubeFamily(this.provider) && this.ytPlayer) {
      try {
        if (this.playlistId) {
          this.ytPlayer.setLoop?.(Boolean(state.loop));
          const curIdx =
            typeof this.ytPlayer.getPlaylistIndex === "function"
              ? this.ytPlayer.getPlaylistIndex()
              : this.lastKnownPlaylistIndex;
          if (curIdx !== desiredIdx && desiredIdx >= 0) {
            this._clearSyncTimers();
            const syncSeq = ++this._syncSeq;
            const checkGen = this.generation;
            this._lastAppliedEpoch = Number(state.epoch) || 0;
            const cmd = this._setExpectedCommand(
              {
                expectTrackSwitch: true,
                expectPlayState: true,
                targetPlaying: Boolean(state.playing),
                expectSeek: targetSec > 1.5,
                targetPosMs: targetMs,
                targetPlaylistIndex: desiredIdx,
                targetTrackUri: state.trackUri || "",
                isInitial,
              },
              1700
            );
            if (source !== "resync-local") {
              this.negotiator.onSharedStateApplied(state, this._perfNow(), {
                source,
                didMutate: true,
                isInitial,
                isTrackSwitch: true,
                preApplySnapshot: preApply,
              });
            }
            this.lastKnownPlaylistIndex = desiredIdx;
            if (isInitial && !state.playing && typeof this.ytPlayer.cuePlaylist === "function") {
              this.ytPlayer.cuePlaylist({
                listType: "playlist",
                list: this.playlistId,
                index: desiredIdx,
                startSeconds: targetSec,
              });
              cmd.trackSwitchSettled = true;
              return;
            }
            if (typeof this.ytPlayer.playVideoAt === "function") {
              this.ytPlayer.playVideoAt(desiredIdx);
              if (targetSec > 1.5 || !state.playing) {
                this._scheduleSyncTimer(260, () => {
                  if (syncSeq !== this._syncSeq || checkGen !== this.generation || !this.ytPlayer) {
                    return;
                  }
                  const liveState = this.pendingState || state;
                  const liveTargetSec = projectMediaPositionMs(liveState, this._wallNow()) / 1000;
                  try {
                    if (this.expectedCommand && this.expectedCommand.id === cmd.id) {
                      this.expectedCommand.trackSwitchSettled = true;
                      this.expectedCommand.targetPlaying = Boolean(liveState.playing);
                      this.expectedCommand.targetPosMs = Math.round(liveTargetSec * 1000);
                      this.expectedCommand.expiresAt = Math.max(
                        this.expectedCommand.expiresAt,
                        this._perfNow() + 900
                      );
                    }
                    if (liveTargetSec > 1.5) {
                      this.ytPlayer.seekTo?.(liveTargetSec, true);
                    }
                    if (!liveState.playing) {
                      this.ytPlayer.pauseVideo?.();
                    }
                  } catch {
                    // ignore
                  }
                });
              } else {
                cmd.trackSwitchSettled = true;
              }
              return;
            }
          }
        }

        const curRate = Number(this.ytPlayer.getPlaybackRate?.() || 1);
        const curSec = Number(this.ytPlayer.getCurrentTime?.() || 0);
        const ytState = this.ytPlayer.getPlayerState?.();
        const driftThreshold = isInitial ? 0.5 : 0.9;
        const needRateChange = Math.abs(curRate - rate) > 0.02;
        const needSeek =
          isEpochReplay || hasDifferentPendingSeekCmd || Math.abs(curSec - targetSec) > driftThreshold;
        const isPlayingOrBuffering = ytState === 1 || ytState === 3;
        const needPlayChange =
          hasOppositePendingPlayCmd ||
          (state.playing
            ? !isPlayingOrBuffering || isEpochReplay
            : isPlayingOrBuffering || (needSeek && (ytState === -1 || ytState === 5)));

        this._lastAppliedEpoch = Number(state.epoch) || 0;
        if (!needRateChange && !needSeek && !needPlayChange) {
          if (source !== "resync-local") {
            this.negotiator.onSharedStateApplied(state, this._perfNow(), {
              source,
              didMutate: false,
              isInitial,
              isTrackSwitch: false,
            });
          }
          return;
        }

        this._clearSyncTimers();
        const syncSeq = ++this._syncSeq;
        const checkGen = this.generation;
        this._setExpectedCommand(
          {
            expectPlayState: needPlayChange || isInitial,
            targetPlaying: Boolean(state.playing),
            expectSeek: needSeek,
            targetPosMs: targetMs,
            expectRate: needRateChange,
            targetRateMilli: Number(state.rateMilli) || 1000,
            isInitial,
          },
          isInitial ? 1400 : 950
        );
        if (source !== "resync-local") {
          this.negotiator.onSharedStateApplied(state, this._perfNow(), {
            source,
            didMutate: true,
            isInitial,
            isTrackSwitch: false,
            preApplySnapshot: preApply,
          });
        }

        if (needRateChange) {
          this.ytPlayer.setPlaybackRate?.(rate);
        }
        if (needSeek) {
          this.ytPlayer.seekTo?.(targetSec, true);
        }
        if (state.playing && needPlayChange) {
          this.ytPlayer.playVideo?.();
          // Autoplay-blocked guard: if YouTube stays unstarted/paused after 900ms, retry muted locally
          this._autoplayTimerId = this._scheduleSyncTimer(900, () => {
            if (
              syncSeq !== this._syncSeq ||
              checkGen !== this.generation ||
              !this.pendingState?.playing ||
              !this.ytPlayer
            ) {
              return;
            }
            const stNow = this.ytPlayer.getPlayerState?.();
            if (stNow !== 1 && stNow !== 3) {
              try {
                this._setExpectedCommand(
                  { expectPlayState: true, targetPlaying: true, isInitial: true },
                  850
                );
                this.ytPlayer.mute?.();
                this.ytPlayer.playVideo?.();
                this.localMuted = true;
                this.onAutoplayMuted(true);
              } catch {
                // ignore
              }
            }
          });
        } else if (!state.playing && needPlayChange) {
          this.ytPlayer.pauseVideo?.();
        }
      } catch {
        // ignore
      }
      return;
    }

    if (this.provider === "spotify" && this.spotifyCtrl && source !== "resync-local") {
      const spTrackChange = Boolean(
        this.playlistId &&
          state.trackUri &&
          state.trackUri !== this.playlistId &&
          state.trackUri !== this.lastKnownTrackUri &&
          state.trackUri !== this.spotifyShowingTrackUri
      );
      const spSeek = Math.abs(this.lastKnownPosMs / 1000 - targetSec) > (isInitial ? 1.0 : 1.5);
      const spPlay = Boolean(state.playing) !== Boolean(this.lastKnownPlaying) || isInitial;
      this._lastAppliedEpoch = Number(state.epoch) || 0;
      this.negotiator.onSharedStateApplied(state, this._perfNow(), {
        source,
        didMutate: spTrackChange || spSeek || spPlay || isEpochReplay,
        isInitial,
        isTrackSwitch: spTrackChange,
        preApplySnapshot: preApply,
      });
    }

    if (this.provider === "spotify" && this.spotifyCtrl) {
      this._suppress(isInitial ? 1600 : 650);
      try {
        // Sync active track inside a Spotify playlist/album when another peer picks a specific trackURI
        if (
          this.playlistId &&
          state.trackUri &&
          state.trackUri !== this.playlistId &&
          state.trackUri !== this.lastKnownTrackUri &&
          state.trackUri !== this.spotifyShowingTrackUri
        ) {
          this._suppress(1600);
          this.lastKnownTrackUri = state.trackUri;
          this.spotifyShowingTrackUri = state.trackUri;
          this.spotifyHasContext = false;
          const loadStartSec = targetSec > 1.2 ? Math.floor(targetSec) : 0;
          this.spotifyInitialStartSec = loadStartSec;
          this.spotifyLastPosMs = loadStartSec * 1000;
          this.spotifyLastIsPaused = true;
          this.spotifyAwaitingInitialSettle = true;
          if (typeof this.spotifyCtrl.loadUri === "function") {
            this.spotifyCtrl.loadUri(state.trackUri, false, loadStartSec);
          } else if (typeof this.spotifyCtrl.loadEntity === "function") {
            this.spotifyCtrl.loadEntity(state.trackUri, false, loadStartSec);
          }
          this.onTelemetry({
            durationMs: this.durationMs,
            positionMs: targetMs,
            ready: this.ready,
            trackUri: state.trackUri,
            spotifyTrackDetached: true,
            spotifySession: this.spotifySession,
          });
          if (state.playing) {
            this._resumeSpotify();
          }
          return;
        }

        const curSec = this.lastKnownPosMs / 1000;
        const needsSeek = isInitial
          ? this.spotifyHasContext && Math.abs(curSec - targetSec) > 1.0
          : Math.abs(curSec - targetSec) > 1.5;
        if (needsSeek) {
          this.spotifyCtrl.seek?.(Math.floor(targetSec));
        }
        if (state.playing) {
          if (!this.lastKnownPlaying || isInitial) {
            this._resumeSpotify();
            if (isInitial && !this.spotifyHasContext && Math.abs(targetSec - this.spotifyInitialStartSec) > 2.0) {
              this.spotifyCtrl.seek?.(Math.floor(targetSec));
            }
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
      try {
        const isPlaylist = this.playlistCount > 1 || Boolean(this.playlistId);
        if (isPlaylist && desiredIdx !== this.lastKnownPlaylistIndex) {
          this._clearSyncTimers();
          const syncSeq = ++this._syncSeq;
          const checkGen = this.generation;
          this._scActionSeq += 1;
          this._scPollSeq += 1;
          this._lastAppliedEpoch = Number(state.epoch) || 0;
          const cmd = this._setExpectedCommand(
            {
              expectTrackSwitch: true,
              expectPlayState: true,
              targetPlaying: Boolean(state.playing),
              expectSeek: targetMs > 800,
              targetPosMs: targetMs,
              targetPlaylistIndex: desiredIdx,
              isInitial,
            },
            1700
          );
          if (source !== "resync-local") {
            this.negotiator.onSharedStateApplied(state, this._perfNow(), {
              source,
              didMutate: true,
              isInitial,
              isTrackSwitch: true,
              preApplySnapshot: preApply,
            });
          }
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
          this._scheduleSyncTimer(220, () => {
            if (syncSeq !== this._syncSeq || checkGen !== this.generation || !this.scWidget) return;
            const liveState = this.pendingState || state;
            const liveTargetMs = projectMediaPositionMs(liveState, this._wallNow());
            try {
              if (this.expectedCommand && this.expectedCommand.id === cmd.id) {
                this.expectedCommand.trackSwitchSettled = true;
                this.expectedCommand.targetPlaying = Boolean(liveState.playing);
                this.expectedCommand.targetPosMs = liveTargetMs;
                this.expectedCommand.expiresAt = Math.max(
                  this.expectedCommand.expiresAt,
                  this._perfNow() + 950
                );
              }
              if (liveTargetMs > 800) {
                this.scWidget.seekTo?.(liveTargetMs);
              }
              if (liveState.playing) {
                this.scWidget.play?.();
              } else {
                this.scWidget.pause?.();
              }
            } catch {
              // ignore
            }
          });
          return;
        }

        const alreadyTargetingPlay = Boolean(
          activeCmd &&
            activeCmd.expectPlayState &&
            activeCmd.targetPlaying === Boolean(state.playing)
        );
        // SoundCloud's iframe URL has no start-time parameter and always boots at 0ms, so on
        // initial mount compare against targetMs > 600 rather than synthetic lastKnownPosMs.
        const needSeek = isInitial
          ? targetMs > 600
          : isEpochReplay ||
            hasDifferentPendingSeekCmd ||
            Math.abs(this.lastKnownPosMs - targetMs) > 1100;
        const needPlayChange =
          isInitial ||
          isEpochReplay ||
          hasOppositePendingPlayCmd ||
          (Boolean(state.playing) !== Boolean(this.lastKnownPlaying) && !alreadyTargetingPlay);

        this._lastAppliedEpoch = Number(state.epoch) || 0;
        if (!needSeek && !needPlayChange) {
          if (source !== "resync-local") {
            this.negotiator.onSharedStateApplied(state, this._perfNow(), {
              source,
              didMutate: false,
              isInitial,
              isTrackSwitch: false,
            });
          }
          return;
        }

        this._clearSyncTimers();
        this._syncSeq += 1;
        this._scActionSeq += 1;
        this._scPollSeq += 1;
        this._setExpectedCommand(
          {
            expectPlayState: needPlayChange || isInitial,
            targetPlaying: Boolean(state.playing),
            expectSeek: needSeek,
            targetPosMs: targetMs,
            isInitial,
          },
          isInitial ? 1500 : 1100
        );
        if (source !== "resync-local") {
          this.negotiator.onSharedStateApplied(state, this._perfNow(), {
            source,
            didMutate: true,
            isInitial,
            isTrackSwitch: false,
            preApplySnapshot: preApply,
          });
        }

        if (needSeek) {
          this.scWidget.seekTo?.(targetMs);
          this.lastKnownPosMs = targetMs;
        }
        if (needPlayChange) {
          if (state.playing) {
            this.scWidget.play?.();
          } else {
            this.scWidget.pause?.();
          }
        }
      } catch {
        // ignore
      }
      return;
    }

    if (this.provider === "twitch" && this.twitchPlayer) {
      try {
        if (this.twitchKind === "collection") {
          const desiredVid = normalizeTwitchVideoId(state.trackUri || "");
          const curVid = normalizeTwitchVideoId(
            this.twitchPlayer.getVideo?.() || this.lastKnownTrackUri
          );
          const colId = this.mediaId.startsWith("collection:") ? this.mediaId.slice(11) : "";
          if (desiredVid && colId && desiredVid !== curVid) {
            this._clearSyncTimers();
            const syncSeq = ++this._syncSeq;
            const checkGen = this.generation;
            this._lastAppliedEpoch = Number(state.epoch) || 0;
            const cmd = this._setExpectedCommand(
              {
                expectTrackSwitch: true,
                expectPlayState: true,
                targetPlaying: Boolean(state.playing),
                expectSeek: targetSec > 1.5,
                targetPosMs: targetMs,
                targetTrackUri: desiredVid,
                isInitial,
              },
              1700
            );
            if (source !== "resync-local") {
              this.negotiator.onSharedStateApplied(state, this._perfNow(), {
                source,
                didMutate: true,
                isInitial,
                isTrackSwitch: true,
                preApplySnapshot: preApply,
              });
            }
            this.lastKnownTrackUri = desiredVid;
            this.twitchPlayer.setCollection?.(colId, desiredVid);
            this._scheduleSyncTimer(260, () => {
              if (syncSeq !== this._syncSeq || checkGen !== this.generation || !this.twitchPlayer) {
                return;
              }
              const liveState = this.pendingState || state;
              const liveTargetSec = projectMediaPositionMs(liveState, this._wallNow()) / 1000;
              try {
                if (this.expectedCommand && this.expectedCommand.id === cmd.id) {
                  this.expectedCommand.trackSwitchSettled = true;
                  this.expectedCommand.targetPlaying = Boolean(liveState.playing);
                  this.expectedCommand.targetPosMs = Math.round(liveTargetSec * 1000);
                  this.expectedCommand.expiresAt = Math.max(
                    this.expectedCommand.expiresAt,
                    this._perfNow() + 900
                  );
                }
                if (liveTargetSec > 1.5) {
                  this.twitchPlayer.seek?.(liveTargetSec);
                }
                if (liveState.playing) {
                  this.twitchPlayer.play?.();
                } else {
                  this.twitchPlayer.pause?.();
                }
              } catch {
                // ignore
              }
            });
            return;
          }
        }

        const isSeekable = this.twitchKind === "video" || this.twitchKind === "collection";
        const curSec = isSeekable ? Number(this.twitchPlayer.getCurrentTime?.() || 0) : 0;
        const driftThreshold = isInitial ? 0.6 : 1.0;
        const needSeek =
          isSeekable &&
          (isEpochReplay || hasDifferentPendingSeekCmd || Math.abs(curSec - targetSec) > driftThreshold);
        const isPaused =
          typeof this.twitchPlayer.isPaused === "function"
            ? Boolean(this.twitchPlayer.isPaused())
            : !this.lastKnownPlaying;
        const needPlayChange =
          isInitial ||
          isEpochReplay ||
          hasOppositePendingPlayCmd ||
          (state.playing ? isPaused : !isPaused);

        this._lastAppliedEpoch = Number(state.epoch) || 0;
        if (!needSeek && !needPlayChange) {
          if (source !== "resync-local") {
            this.negotiator.onSharedStateApplied(state, this._perfNow(), {
              source,
              didMutate: false,
              isInitial,
              isTrackSwitch: false,
            });
          }
          return;
        }

        this._clearSyncTimers();
        this._syncSeq += 1;
        this._setExpectedCommand(
          {
            expectPlayState: needPlayChange || isInitial,
            targetPlaying: Boolean(state.playing),
            expectSeek: needSeek,
            targetPosMs: targetMs,
            isInitial,
          },
          isInitial ? 1400 : 950
        );
        if (source !== "resync-local") {
          this.negotiator.onSharedStateApplied(state, this._perfNow(), {
            source,
            didMutate: true,
            isInitial,
            isTrackSwitch: false,
            preApplySnapshot: preApply,
          });
        }

        if (needSeek) {
          this.twitchPlayer.seek?.(targetSec);
        }
        if (needPlayChange) {
          if (state.playing) {
            this.twitchPlayer.play?.();
            this.lastKnownPlaying = true;
          } else {
            this.twitchPlayer.pause?.();
            this.lastKnownPlaying = false;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  /**
   * Periodic mild drift correction (called ~every 1.2s while Watch Together is active & playing).
   * Handles small local clock/buffer skew only; drastic divergence (>= 3s) is deferred to the
   * 3 Hz WatchSyncNegotiator so rapid scrubs or divergent states are negotiated cleanly.
   */
  correctDrift(state, nowMs = this._wallNow()) {
    if (!this.ready || !state || !state.active || !state.playing || this._isSuppressed()) {
      return;
    }
    const targetMs = projectMediaPositionMs(state, nowMs);
    if (isYouTubeFamily(this.provider) && this.ytPlayer) {
      try {
        if (this.ytPlayer.getPlayerState?.() !== 1) return;
        const curMs = Math.round((this.ytPlayer.getCurrentTime?.() || 0) * 1000);
        this.lastKnownPosMs = curMs;
        const drift = Math.abs(curMs - targetMs);
        if (
          drift > WATCH_SYNC_DEFAULTS.MILD_DRIFT_YT_MS &&
          drift < WATCH_SYNC_DEFAULTS.DRASTIC_DRIFT_PLAYING_MS
        ) {
          this._setExpectedCommand(
            { expectSeek: true, targetPosMs: targetMs, targetPlaying: true },
            850
          );
          this.ytPlayer.seekTo?.(targetMs / 1000, true);
          this.negotiator.onLocalDriftSeek(this._perfNow());
        }
      } catch {
        // ignore
      }
    } else if (this.provider === "soundcloud" && this.scWidget) {
      if (!this.lastKnownPlaying) return;
      const checkGen = this.generation;
      const syncSeq0 = this._syncSeq;
      const actionSeq0 = this._scActionSeq;
      const applySoundCloudDrift = (posMs) => {
        if (
          checkGen !== this.generation ||
          syncSeq0 !== this._syncSeq ||
          actionSeq0 !== this._scActionSeq ||
          !this.ready ||
          !this.scWidget ||
          !this.lastKnownPlaying ||
          this._isSuppressed()
        ) {
          return;
        }
        const liveState = this.pendingState || state;
        if (!liveState || !liveState.active || !liveState.playing) return;
        const liveTargetMs = projectMediaPositionMs(liveState, this._wallNow());
        this.lastKnownPosMs = posMs;
        const drift = Math.abs(posMs - liveTargetMs);
        if (
          drift > WATCH_SYNC_DEFAULTS.MILD_DRIFT_SC_MS &&
          drift < WATCH_SYNC_DEFAULTS.DRASTIC_DRIFT_PLAYING_MS
        ) {
          this._setExpectedCommand(
            { expectSeek: true, targetPosMs: liveTargetMs, targetPlaying: true },
            900
          );
          try {
            this.scWidget.seekTo?.(liveTargetMs);
            this.negotiator.onLocalDriftSeek(this._perfNow());
          } catch {
            // ignore
          }
        }
      };
      if (typeof this.scWidget.getPosition === "function") {
        try {
          this.scWidget.getPosition((rawPos) => {
            const posMs = Number(rawPos);
            if (Number.isFinite(posMs) && posMs >= 0) {
              applySoundCloudDrift(Math.round(posMs));
            }
          });
        } catch {
          // ignore
        }
      } else {
        applySoundCloudDrift(this.lastKnownPosMs);
      }
    } else if (this.provider === "spotify" && this.spotifyCtrl) {
      if (!this.lastKnownPlaying) return;
      const drift = Math.abs(this.lastKnownPosMs - targetMs);
      if (
        drift > WATCH_SYNC_DEFAULTS.MILD_DRIFT_SPOTIFY_MS &&
        drift < WATCH_SYNC_DEFAULTS.DRASTIC_DRIFT_PLAYING_SPOTIFY_MS
      ) {
        this._suppress(950);
        try {
          this.spotifyCtrl.seek?.(Math.floor(targetMs / 1000));
          this.negotiator.onLocalDriftSeek(this._perfNow());
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
        const drift = Math.abs(curMs - targetMs);
        if (
          drift > WATCH_SYNC_DEFAULTS.MILD_DRIFT_TWITCH_MS &&
          drift < WATCH_SYNC_DEFAULTS.DRASTIC_DRIFT_PLAYING_MS
        ) {
          this._setExpectedCommand(
            { expectSeek: true, targetPosMs: targetMs, targetPlaying: true },
            850
          );
          this.twitchPlayer.seek?.(targetMs / 1000);
          this.negotiator.onLocalDriftSeek(this._perfNow());
        }
      } catch {
        // ignore
      }
    }
  }

  _handlePolledSnapshot(snapshot) {
    if (!this.pendingState || !this.pendingState.active) return;
    const decision = this.negotiator.evaluate(snapshot, this.pendingState, {
      hasEverPlayedLocally: this._hasEverPlayedLocally,
    });
    if (decision.action === "resync-local") {
      this._syncMountedPlayer(this.pendingState, snapshot.wallNowMs, false, {
        source: "resync-local",
        forceResync: true,
      });
      return;
    }
    if (decision.action === "negotiate" && decision.proposal) {
      this._clearSyncTimers();
      this.expectedCommand = null;
      const p = decision.proposal;
      this.onNegotiateState({
        playing: p.playing,
        positionMs: p.positionMs,
        rateMilli: p.rateMilli,
        playlistIndex: p.playlistIndex,
        trackUri: p.trackUri,
        trackTitle: p.trackTitle,
        reason: decision.reason,
        negotiated: true,
      });
    }
  }

  _pollPlayerStateOnce(gen = this.generation) {
    if (gen !== this.generation || !this.ready) return;

    if (isYouTubeFamily(this.provider) && this.ytPlayer) {
      try {
        const ytState = this.ytPlayer.getPlayerState?.();
        const curMs = Math.max(0, Math.round((this.ytPlayer.getCurrentTime?.() || 0) * 1000));
        const dur = Number(this.ytPlayer.getDuration?.() || 0);
        if (dur > 0) this.durationMs = Math.round(dur * 1000);
        const rateMilli = Math.round((this.ytPlayer.getPlaybackRate?.() || 1) * 1000);
        this.lastKnownPosMs = curMs;
        if (ytState === 1) {
          this.lastKnownPlaying = true;
          this._hasEverPlayedLocally = true;
          this._clearAutoplayTimer();
        } else if (ytState === 2 || ytState === 0) {
          this.lastKnownPlaying = false;
        }

        let vdata = null;
        if (this.playlistId) {
          this._refreshYouTubePlaylistInfo();
          const curIdx = this.ytPlayer.getPlaylistIndex?.();
          vdata = this.ytPlayer.getVideoData?.() || {};
          if (typeof curIdx === "number" && curIdx >= 0) {
            this.lastKnownPlaylistIndex = curIdx;
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

        this._handlePolledSnapshot({
          provider: this.provider,
          ready: true,
          buffering: ytState === 3,
          unstarted: ytState === -1 || ytState === 5,
          ended: ytState === 0,
          stalled: false,
          playing: ytState === 1,
          hasPlayState: ytState === 1 || ytState === 2,
          positionMs: curMs,
          hasPosition: ytState === 1 || ytState === 2 || ytState === 0,
          durationMs: this.durationMs,
          rateMilli,
          hasRate: true,
          playlistCount: this.playlistCount,
          playlistIndex: this.playlistId ? this.lastKnownPlaylistIndex : undefined,
          trackUri: this.playlistId ? this.lastKnownTrackUri : undefined,
          trackTitle: vdata?.title || undefined,
          observedAt: this._perfNow(),
          wallNowMs: this._wallNow(),
        });
      } catch {
        // ignore
      }
      return;
    }

    if (this.provider === "soundcloud" && this.scWidget) {
      const nowPerf = this._perfNow();
      if (this._scPollInFlight && nowPerf - this._scPollStartedAt < 1200) {
        return;
      }
      const hasIsPaused = typeof this.scWidget.isPaused === "function";
      const hasGetPos = typeof this.scWidget.getPosition === "function";
      if (!hasIsPaused && !hasGetPos) return;

      const pollSeq = ++this._scPollSeq;
      const actionSeq0 = this._scActionSeq;
      const syncSeq0 = this._syncSeq;
      this._scPollInFlight = true;
      this._scPollStartedAt = nowPerf;

      const wantIdx =
        (this.playlistCount > 1 || Boolean(this.playlistId)) &&
        typeof this.scWidget.getCurrentSoundIndex === "function";
      let pending = (hasIsPaused ? 1 : 0) + (hasGetPos ? 1 : 0) + (wantIdx ? 1 : 0);
      let pausedVal;
      let posVal;
      let idxVal;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        this._scPollInFlight = false;
        if (
          gen !== this.generation ||
          !this.ready ||
          !this.scWidget ||
          pollSeq !== this._scPollSeq ||
          actionSeq0 !== this._scActionSeq ||
          syncSeq0 !== this._syncSeq
        ) {
          return;
        }
        const obsPerf = this._perfNow();
        const wallNow = this._wallNow();
        const hasPlayState = typeof pausedVal === "boolean";
        const playing = hasPlayState ? !pausedVal : this.lastKnownPlaying;
        const hasPosition = typeof posVal === "number" && Number.isFinite(posVal) && posVal >= 0;
        const posMs = hasPosition ? Math.round(posVal) : this.lastKnownPosMs;

        let stalled = false;
        if (
          playing &&
          hasPosition &&
          this._scPrevPollPlaying &&
          this._scPrevPollPosMs >= 0 &&
          Math.abs(posMs - this._scPrevPollPosMs) < 25 &&
          obsPerf - this._scLastProgressMoveAt > 650
        ) {
          stalled = true;
        }
        if (hasPosition && posMs !== this._scPrevPollPosMs) {
          this._scLastProgressMoveAt = obsPerf;
        }
        this._scPrevPollPlaying = playing;
        this._scPrevPollPosMs = hasPosition ? posMs : this._scPrevPollPosMs;

        if (hasPlayState) {
          this.lastKnownPlaying = playing;
          if (playing) this._hasEverPlayedLocally = true;
        }
        if (hasPosition) {
          this.lastKnownPosMs = posMs;
        }
        let resolvedIdx;
        let trackTitle;
        if (wantIdx && typeof idxVal === "number" && idxVal >= 0) {
          resolvedIdx = idxVal;
          this.lastKnownPlaylistIndex = idxVal;
          const item = this.playlistItems[idxVal];
          if (item) {
            if (item.durationMs > 0) this.durationMs = item.durationMs;
            trackTitle = item.artist ? `${item.artist} — ${item.title}` : item.title;
          }
        }
        this.onTelemetry({
          durationMs: this.durationMs,
          positionMs: this.lastKnownPosMs,
          title: trackTitle || undefined,
          ready: true,
          playlistCount: this.playlistCount,
          playlistIndex: this.lastKnownPlaylistIndex,
          playlistItems: this.playlistItems,
        });

        const ended = Boolean(
          this.durationMs > 0 &&
            hasPlayState &&
            !playing &&
            hasPosition &&
            posMs >= this.durationMs - 400 &&
            !(this.playlistCount > 1 && this.lastKnownPlaylistIndex < this.playlistCount - 1)
        );

        this._handlePolledSnapshot({
          provider: "soundcloud",
          ready: true,
          buffering: false,
          unstarted: false,
          ended,
          stalled,
          playing,
          hasPlayState,
          positionMs: posMs,
          hasPosition,
          durationMs: this.durationMs,
          rateMilli: 1000,
          hasRate: false,
          playlistCount: this.playlistCount,
          playlistIndex: resolvedIdx,
          trackUri: undefined,
          trackTitle,
          observedAt: obsPerf,
          wallNowMs: wallNow,
        });
      };

      const stepDone = () => {
        pending -= 1;
        if (pending <= 0) finish();
      };

      try {
        if (hasIsPaused) {
          this.scWidget.isPaused((p) => {
            pausedVal = Boolean(p);
            stepDone();
          });
        }
        if (hasGetPos) {
          this.scWidget.getPosition((pos) => {
            posVal = Number(pos);
            stepDone();
          });
        }
        if (wantIdx) {
          this.scWidget.getCurrentSoundIndex((idx) => {
            idxVal = Number(idx);
            stepDone();
          });
        }
      } catch {
        this._scPollInFlight = false;
      }
      return;
    }

    if (this.provider === "twitch" && this.twitchPlayer && this.twitchKind !== "clip") {
      try {
        const isLive = this.twitchKind === "channel";
        const isPaused =
          typeof this.twitchPlayer.isPaused === "function"
            ? Boolean(this.twitchPlayer.isPaused())
            : !this.lastKnownPlaying;
        const playing = !isPaused;
        if (playing) this._hasEverPlayedLocally = true;
        this.lastKnownPlaying = playing;

        let curMs = 0;
        if (!isLive) {
          const curSec = Number(this.twitchPlayer.getCurrentTime?.() || 0);
          curMs = Number.isFinite(curSec) && curSec > 0 ? Math.round(curSec * 1000) : 0;
          const durSec = Number(this.twitchPlayer.getDuration?.() || 0);
          if (Number.isFinite(durSec) && durSec > 0) {
            this.durationMs = Math.round(durSec * 1000);
          }
          this.lastKnownPosMs = curMs;
        }

        if (this.twitchKind === "collection") {
          const curVid = normalizeTwitchVideoId(this.twitchPlayer.getVideo?.() || "");
          if (curVid) this.lastKnownTrackUri = curVid;
        }

        this.onTelemetry({
          durationMs: this.durationMs,
          positionMs: curMs,
          ready: true,
          trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
        });

        const ended = Boolean(!isLive && this.durationMs > 0 && isPaused && curMs >= this.durationMs - 400);
        this._handlePolledSnapshot({
          provider: "twitch",
          ready: true,
          buffering: false,
          unstarted: false,
          ended,
          stalled: false,
          playing,
          hasPlayState: typeof this.twitchPlayer.isPaused === "function",
          positionMs: curMs,
          hasPosition: !isLive,
          durationMs: this.durationMs,
          rateMilli: 1000,
          hasRate: false,
          playlistCount: 0,
          playlistIndex: undefined,
          trackUri: this.twitchKind === "collection" ? this.lastKnownTrackUri : undefined,
          observedAt: this._perfNow(),
          wallNowMs: this._wallNow(),
        });
      } catch {
        // ignore
      }
      return;
    }

    if (this.provider === "spotify" && this.spotifyCtrl) {
      if (this.durationMs <= 0) return;
      if (this.spotifyAwaitingInitialSettle) return;
      // Skip divergence negotiation while locally browsing the full playlist tracklist via Show Playlist
      const browsingSpotifyPlaylist = Boolean(
        this.playlistId &&
          !this.spotifyShowingTrackUri &&
          !this.lastKnownPlaying &&
          (this.lastKnownTrackUri === this.playlistId ||
            (this.lastKnownPosMs === 0 &&
              this.pendingState?.trackUri &&
              this.pendingState.trackUri !== this.playlistId))
      );
      if (browsingSpotifyPlaylist) return;
      const obsPerf = this._perfNow();
      if (this.lastKnownPlaying) this._hasEverPlayedLocally = true;
      let stalled = false;
      if (
        this.lastKnownPlaying &&
        this._spPrevPollPosMs >= 0 &&
        Math.abs(this.lastKnownPosMs - this._spPrevPollPosMs) < 25 &&
        this._spLastPosMoveAt > 0 &&
        obsPerf - this._spLastPosMoveAt > 1500
      ) {
        stalled = true;
      }
      if (this.lastKnownPosMs !== this._spPrevPollPosMs) {
        this._spLastPosMoveAt = obsPerf;
      }
      this._spPrevPollPosMs = this.lastKnownPosMs;
      const ended = Boolean(
        !this.lastKnownPlaying &&
          this.durationMs > 0 &&
          this.lastKnownPosMs >= this.durationMs - 400 &&
          !this.playlistId
      );
      this._handlePolledSnapshot({
        provider: "spotify",
        ready: true,
        buffering: false,
        unstarted: false,
        ended,
        stalled,
        playing: Boolean(this.lastKnownPlaying),
        hasPlayState: true,
        positionMs: this.lastKnownPosMs,
        hasPosition: true,
        durationMs: this.durationMs,
        rateMilli: 1000,
        hasRate: false,
        playlistCount: 0,
        playlistIndex: undefined,
        trackUri: this.playlistId ? this.lastKnownTrackUri : undefined,
        observedAt: obsPerf,
        wallNowMs: this._wallNow(),
      });
    }
  }

  _startPollLoop(gen) {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.provider === "twitch" && this.twitchKind === "clip") {
      return;
    }
    this.pollTimer = setInterval(() => {
      this._pollPlayerStateOnce(gen);
    }, WATCH_SYNC_DEFAULTS.POLL_INTERVAL_MS);
  }

  _teardownAdapterOnly() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this._clearSyncTimers();
    this._syncSeq += 1;
    this._scActionSeq += 1;
    this._scPollSeq += 1;
    this._scPollInFlight = false;
    this.expectedCommand = null;
    this.suppressUntilMs = 0;
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
    this.spotifyIframe = null;
    this.spotifyHasContext = false;
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
    this.negotiator.reset();
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
    this.spotifyEntityType = "track";
    this.spotifyIframe = null;
    this.spotifyHasContext = false;
    this.spotifyInitialStartSec = 0;
    this.spotifyLastPosMs = 0;
    this.spotifyLastIsPaused = true;
    this.spotifyAwaitingInitialSettle = false;
    this.spotifyEnv = null;
    this.spotifyHasError = false;
    this.spotifyErrorMessage = "";
    this.spotifySession = null;
    this._nextSpotifyForceDrmProbe = false;
    this.twitchKind = "";
    this.twitchEpoch = 0;
    this._lastAppliedEpoch = 0;
    this._hasEverPlayedLocally = false;
    this._ytWasBuffering = false;
    this._ytBufferingFromPosMs = 0;
    this._scPrevPollPlaying = false;
    this._scPrevPollPosMs = -1;
    this._scLastProgressMoveAt = 0;
    this._spPrevPollPosMs = -1;
    this._spLastPosMoveAt = 0;
    if (this.mountEl) {
      this.mountEl.innerHTML = "";
    }
  }
}
