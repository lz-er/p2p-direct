//! Pure safe Rust synchronized media state engine and GIF89a frame-timing parser.
//!
//! Responsibilities:
//! - Deterministic LWW CRDT state merging for room-wide synchronized videos, GIFs, and
//!   Watch Together sessions (YouTube / Spotify / SoundCloud) — strictly excluding local volume.
//! - Clock-skew-independent position projection (sends live projected `position_ms` at transmit
//!   instant; receiver compensates by peer one-way RTT/2 and re-anchors to its own local clock).
//! - Zero-copy GIF87a/GIF89a frame-delay table parser for frame-accurate multi-peer GIF sync.

use std::fmt::Write as _;

use crate::json::{JsonValue, write_json_string};

pub const MAX_GIF_FRAMES: usize = 4096;
pub const MAX_WATCH_QUEUE_ITEMS: usize = 64;
pub const MAX_MEDIA_SYNC_TARGETS: usize = 256;
pub const MAX_ONE_WAY_COMPENSATION_MS: u64 = 1500;
pub const MIN_RATE_MILLI: u32 = 250;
pub const MAX_RATE_MILLI: u32 = 4000;

/// Parsed frame-delay metadata extracted from a GIF87a / GIF89a byte stream without pixel decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GifTimings {
    pub width: u16,
    pub height: u16,
    pub frame_delays_ms: Vec<u32>,
    pub cumulative_ms: Vec<u64>,
    pub total_duration_ms: u64,
}

impl GifTimings {
    /// Returns the deterministic frame index (`0..frame_delays_ms.len()`) active at `pos_ms`
    /// (wrapping modulo `total_duration_ms`) using binary search over cumulative timestamps.
    pub fn frame_index_at(&self, pos_ms: u64) -> usize {
        if self.frame_delays_ms.len() <= 1 || self.total_duration_ms == 0 {
            return 0;
        }
        let wrapped = pos_ms % self.total_duration_ms;
        // `cumulative_ms[i]` is the exclusive end timestamp of frame `i`.
        let idx = self.cumulative_ms.partition_point(|&end| end <= wrapped);
        idx.min(self.frame_delays_ms.len().saturating_sub(1))
    }

    /// Serializes timings into a compact little-endian binary wire payload:
    /// `[width: u16][height: u16][total_duration_ms: u32][frame_count: u32][delay_ms: u32; N]`.
    pub fn write_binary(&self, out: &mut Vec<u8>) {
        out.clear();
        let count = self.frame_delays_ms.len();
        out.reserve(12 + count * 4);
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        let total_u32 = self.total_duration_ms.min(u64::from(u32::MAX)) as u32;
        out.extend_from_slice(&total_u32.to_le_bytes());
        out.extend_from_slice(&(count as u32).to_le_bytes());
        for &d in &self.frame_delays_ms {
            out.extend_from_slice(&d.to_le_bytes());
        }
    }
}

fn skip_gif_sub_blocks(data: &[u8], pos: &mut usize) {
    while let Some(&sub_len) = data.get(*pos) {
        *pos += 1;
        if sub_len == 0 {
            break;
        }
        let next = pos.saturating_add(usize::from(sub_len));
        if next > data.len() {
            *pos = data.len();
            break;
        }
        *pos = next;
    }
}

/// Parses logical dimensions and exact per-frame display delays (ms) from a GIF87a/GIF89a stream.
/// Matches HTML5/Chromium browser timing semantics: frame delays `< 20 ms` (`< 2` centiseconds)
/// normalize to `100 ms` so synchronized frame indices match native browser playback speed.
pub fn parse_gif_timings(data: &[u8]) -> Result<GifTimings, String> {
    if data.len() < 13 {
        return Err("GIF header shorter than 13 bytes".to_owned());
    }
    let header = &data[..6];
    if header != b"GIF89a" && header != b"GIF87a" {
        return Err("not a GIF87a/GIF89a stream".to_owned());
    }
    let width = u16::from_le_bytes([data[6], data[7]]);
    let height = u16::from_le_bytes([data[8], data[9]]);
    let packed = data[10];
    let mut pos: usize = 13;

    if (packed & 0x80) != 0 {
        let gct_entries = 1usize << (usize::from(packed & 0x07) + 1);
        let gct_bytes = gct_entries * 3;
        if pos.saturating_add(gct_bytes) > data.len() {
            return Err("truncated GIF global color table".to_owned());
        }
        pos += gct_bytes;
    }

    let mut frame_delays_ms: Vec<u32> = Vec::new();
    let mut cumulative_ms: Vec<u64> = Vec::new();
    let mut total_duration_ms: u64 = 0;
    let mut pending_delay_ms: Option<u32> = None;

    while pos < data.len() && frame_delays_ms.len() < MAX_GIF_FRAMES {
        let introducer = data[pos];
        pos += 1;
        match introducer {
            0x21 => {
                // Extension block
                let Some(&label) = data.get(pos) else {
                    break;
                };
                pos += 1;
                if label == 0xF9 {
                    // Graphic Control Extension: [block_size=4, packed, delay_lo, delay_hi, trans_idx, 0]
                    if let Some(&block_size) = data.get(pos)
                        && block_size >= 4
                        && let Some(gce) = data.get(pos + 1..pos + 1 + usize::from(block_size))
                    {
                        let delay_cs = u16::from_le_bytes([gce[1], gce[2]]);
                        // Browser/HTML5 GIF spec: delays < 2 centiseconds default to 100 ms
                        let delay_ms = if delay_cs < 2 {
                            100u32
                        } else {
                            u32::from(delay_cs) * 10
                        };
                        pending_delay_ms = Some(delay_ms);
                    }
                    skip_gif_sub_blocks(data, &mut pos);
                } else {
                    skip_gif_sub_blocks(data, &mut pos);
                }
            }
            0x2C => {
                // Image Descriptor: 9 bytes (left:2, top:2, w:2, h:2, packed:1)
                if pos.saturating_add(9) > data.len() {
                    break;
                }
                let img_packed = data[pos + 8];
                pos += 9;
                if (img_packed & 0x80) != 0 {
                    let lct_entries = 1usize << (usize::from(img_packed & 0x07) + 1);
                    let lct_bytes = lct_entries * 3;
                    if pos.saturating_add(lct_bytes) > data.len() {
                        break;
                    }
                    pos += lct_bytes;
                }
                // LZW minimum code size (1 byte) + image data sub-blocks
                if pos >= data.len() {
                    break;
                }
                pos += 1;
                skip_gif_sub_blocks(data, &mut pos);

                let delay = pending_delay_ms.take().unwrap_or(100);
                frame_delays_ms.push(delay);
                total_duration_ms = total_duration_ms.saturating_add(u64::from(delay));
                cumulative_ms.push(total_duration_ms);
            }
            0x3B => {
                // Trailer
                break;
            }
            0x00 => {
                // Stray zero padding between blocks
            }
            _ => {
                break;
            }
        }
    }

    if frame_delays_ms.is_empty() {
        return Err("GIF stream contains zero image frames".to_owned());
    }

    Ok(GifTimings {
        width,
        height,
        frame_delays_ms,
        cumulative_ms,
        total_duration_ms,
    })
}

/// One queued entry in the room's synchronized Watch Together playlist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchQueueItem {
    pub id: String,
    pub url: String,
    pub provider: String,
    pub media_id: String,
    pub title: String,
    pub added_by: String,
    pub start_ms: u64,
    pub playlist_id: String,
    pub playlist_index: u32,
}

impl WatchQueueItem {
    pub fn write_json(&self, out: &mut String) {
        out.push_str("{\"id\":");
        write_json_string(out, &self.id);
        out.push_str(",\"url\":");
        write_json_string(out, &self.url);
        out.push_str(",\"provider\":");
        write_json_string(out, &self.provider);
        out.push_str(",\"mediaId\":");
        write_json_string(out, &self.media_id);
        out.push_str(",\"title\":");
        write_json_string(out, &self.title);
        out.push_str(",\"addedBy\":");
        write_json_string(out, &self.added_by);
        let _ = write!(out, ",\"startMs\":{}", self.start_ms);
        if !self.playlist_id.is_empty() {
            out.push_str(",\"playlistId\":");
            write_json_string(out, &self.playlist_id);
            let _ = write!(out, ",\"playlistIndex\":{}", self.playlist_index);
        }
        out.push('}');
    }

    pub fn from_json_value(v: &JsonValue) -> Option<Self> {
        let url = v.get_str("url")?.trim();
        if url.is_empty() || url.len() > 2048 {
            return None;
        }
        let provider = v.get_str("provider").unwrap_or("").trim();
        if !matches!(provider, "youtube" | "ytmusic" | "spotify" | "soundcloud") {
            return None;
        }
        let media_id = v.get_str("mediaId").unwrap_or("").trim();
        let id = v.get_str("id").unwrap_or(media_id).trim();
        let title = v.get_str("title").unwrap_or(url).trim();
        let added_by = v.get_str("addedBy").unwrap_or("").trim();
        let start_ms = v.get_u64("startMs").unwrap_or(0);
        let playlist_id = v.get_str("playlistId").unwrap_or("").trim();
        let playlist_index = v.get_u64("playlistIndex").unwrap_or(0).min(10_000) as u32;
        Some(Self {
            id: id.chars().take(96).collect(),
            url: url.to_owned(),
            provider: provider.to_owned(),
            media_id: media_id.chars().take(512).collect(),
            title: title.chars().take(180).collect(),
            added_by: added_by.chars().take(48).collect(),
            start_ms,
            playlist_id: playlist_id.chars().take(512).collect(),
            playlist_index,
        })
    }
}

/// Synchronized playback state for a single shared media target (`"vid:<msgId>:<idx>"`,
/// `"gif:<msgId>:<idx>"`, or `"watch"` for the room Watch Together stage).
///
/// Volume and audio mute state are intentionally omitted so every participant controls their
/// own local listening level independently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaSyncState {
    pub target_id: String,
    pub kind: String,
    pub rev: u64,
    pub actor: String,
    pub actor_name: String,
    pub active: bool,
    pub playing: bool,
    pub position_ms: u64,
    pub rate_milli: u32,
    pub loop_enabled: bool,
    pub epoch: u64,
    pub url: String,
    pub provider: String,
    pub media_id: String,
    pub title: String,
    pub source_msg_id: String,
    pub playlist_id: String,
    pub playlist_index: u32,
    pub track_uri: String,
    pub queue: Vec<WatchQueueItem>,
    /// Local monotonic/wall anchor corresponding to `position_ms` (never compared across peers).
    pub anchor_local_ms: u64,
}

impl MediaSyncState {
    /// Projects the synchronized playback position forward to `now_ms` using fixed-point math.
    pub fn projected_position_ms(&self, now_ms: u64) -> u64 {
        if !self.playing || !self.active {
            return self.position_ms;
        }
        let elapsed = now_ms.saturating_sub(self.anchor_local_ms);
        let rate = u128::from(self.rate_milli.clamp(MIN_RATE_MILLI, MAX_RATE_MILLI));
        let delta = ((u128::from(elapsed) * rate) / 1000u128).min(u128::from(u64::MAX)) as u64;
        self.position_ms.saturating_add(delta)
    }

    /// Deterministic LWW conflict resolution: higher `rev` wins, tie-broken by lexical `actor`.
    pub fn is_strictly_newer_than(&self, other: &Self) -> bool {
        (self.rev, self.actor.as_str()) > (other.rev, other.actor.as_str())
    }

    /// Serializes state with `positionMs` projected to `now_ms`, eliminating wall-clock skew
    /// dependency between sender and receiver devices.
    pub fn write_json(&self, out: &mut String, now_ms: u64) {
        let proj_pos = self.projected_position_ms(now_ms);
        let rate = self.rate_milli.clamp(MIN_RATE_MILLI, MAX_RATE_MILLI);
        out.push_str("{\"targetId\":");
        write_json_string(out, &self.target_id);
        out.push_str(",\"kind\":");
        write_json_string(out, &self.kind);
        let _ = write!(out, ",\"rev\":{},\"actor\":", self.rev);
        write_json_string(out, &self.actor);
        out.push_str(",\"actorName\":");
        write_json_string(out, &self.actor_name);
        let _ = write!(
            out,
            ",\"active\":{},\"playing\":{},\"positionMs\":{},\"rateMilli\":{},\"loop\":{},\"epoch\":{},\"anchorMs\":{}",
            self.active,
            self.playing,
            proj_pos,
            rate,
            self.loop_enabled,
            self.epoch,
            now_ms
        );
        if !self.url.is_empty() {
            out.push_str(",\"url\":");
            write_json_string(out, &self.url);
        }
        if !self.provider.is_empty() {
            out.push_str(",\"provider\":");
            write_json_string(out, &self.provider);
        }
        if !self.media_id.is_empty() {
            out.push_str(",\"mediaId\":");
            write_json_string(out, &self.media_id);
        }
        if !self.title.is_empty() {
            out.push_str(",\"title\":");
            write_json_string(out, &self.title);
        }
        if !self.source_msg_id.is_empty() {
            out.push_str(",\"sourceMsgId\":");
            write_json_string(out, &self.source_msg_id);
        }
        if !self.playlist_id.is_empty() {
            out.push_str(",\"playlistId\":");
            write_json_string(out, &self.playlist_id);
            let _ = write!(out, ",\"playlistIndex\":{}", self.playlist_index);
        } else if self.playlist_index > 0 {
            let _ = write!(out, ",\"playlistIndex\":{}", self.playlist_index);
        }
        if !self.track_uri.is_empty() {
            out.push_str(",\"trackUri\":");
            write_json_string(out, &self.track_uri);
        }
        if !self.queue.is_empty() {
            out.push_str(",\"queue\":[");
            for (idx, item) in self.queue.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                item.write_json(out);
            }
            out.push(']');
        }
        out.push('}');
    }

    /// Parses a wire `MediaSyncState`, compensating for one-way transit delay (`one_way_ms`)
    /// when `playing` is true and re-anchoring to `receive_now_ms` on the receiver's own clock.
    pub fn from_json_value(
        v: &JsonValue,
        receive_now_ms: u64,
        one_way_ms: u64,
    ) -> Result<Self, String> {
        let target_id = v
            .get_str("targetId")
            .ok_or_else(|| "media_sync missing targetId".to_owned())?
            .trim();
        if target_id.is_empty() || target_id.len() > 160 {
            return Err("media_sync invalid targetId".to_owned());
        }
        let kind = v.get_str("kind").unwrap_or("video").trim();
        if !matches!(kind, "video" | "gif" | "watch") {
            return Err(format!("media_sync unsupported kind '{kind}'"));
        }
        let rev = v.get_u64("rev").unwrap_or(1);
        let actor = v.get_str("actor").unwrap_or("").trim();
        let actor_name = v.get_str("actorName").unwrap_or("Peer").trim();
        let active = v.get_bool("active").unwrap_or(true);
        let playing = v.get_bool("playing").unwrap_or(false);
        let raw_pos_ms = v.get_u64("positionMs").unwrap_or(0);
        let rate_milli = (v.get_u64("rateMilli").unwrap_or(1000) as u32)
            .clamp(MIN_RATE_MILLI, MAX_RATE_MILLI);
        let loop_enabled = v.get_bool("loop").unwrap_or(false);
        let epoch = v.get_u64("epoch").unwrap_or(0);

        let transit = one_way_ms.min(MAX_ONE_WAY_COMPENSATION_MS);
        let compensated_pos_ms = if active && playing {
            let delta = ((u128::from(transit) * u128::from(rate_milli)) / 1000u128) as u64;
            raw_pos_ms.saturating_add(delta)
        } else {
            raw_pos_ms
        };

        let url = v.get_str("url").unwrap_or("").trim();
        let provider = v.get_str("provider").unwrap_or("").trim();
        let media_id = v.get_str("mediaId").unwrap_or("").trim();
        let title = v.get_str("title").unwrap_or("").trim();
        let source_msg_id = v.get_str("sourceMsgId").unwrap_or("").trim();
        let playlist_id = v.get_str("playlistId").unwrap_or("").trim();
        let playlist_index = v.get_u64("playlistIndex").unwrap_or(0).min(10_000) as u32;
        let track_uri = v.get_str("trackUri").unwrap_or("").trim();

        let mut queue = Vec::new();
        if let Some(arr) = v.get("queue").and_then(JsonValue::as_array) {
            for item_val in arr.iter().take(MAX_WATCH_QUEUE_ITEMS) {
                if let Some(item) = WatchQueueItem::from_json_value(item_val) {
                    queue.push(item);
                }
            }
        }

        Ok(Self {
            target_id: target_id.to_owned(),
            kind: kind.to_owned(),
            rev,
            actor: actor.chars().take(64).collect(),
            actor_name: actor_name.chars().take(48).collect(),
            active,
            playing,
            position_ms: compensated_pos_ms,
            rate_milli,
            loop_enabled,
            epoch,
            url: url.chars().take(2048).collect(),
            provider: provider.chars().take(32).collect(),
            media_id: media_id.chars().take(512).collect(),
            title: title.chars().take(180).collect(),
            source_msg_id: source_msg_id.chars().take(128).collect(),
            playlist_id: playlist_id.chars().take(512).collect(),
            playlist_index,
            track_uri: track_uri.chars().take(256).collect(),
            queue,
            anchor_local_ms: receive_now_ms,
        })
    }
}
