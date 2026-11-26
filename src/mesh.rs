use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt::Write as _;

use crate::audio::{
    CaptureDspResult, VoiceCaptureDsp48k, compute_rms_i16, decode_ima_adpcm,
    decode_ima_adpcm_into, encode_ima_adpcm, encode_ima_adpcm_into,
};
use crate::crypto::{
    KEY_LEN, NONCE_LEN, SafeCsprng, aead_open, aead_seal, derive_all_link_keys,
    derive_invite_wrap_key, derive_log_key, derive_mesh_key_from_passphrase,
    derive_relay_signal_key, derive_room_signal_key, derive_room_topic, key_fingerprint,
    pair_safety_code, parse_fixed_12, x25519_public_key,
};
use crate::deflate::{
    base64url_decode, base64url_encode, base64url_encode_into, deflate_raw, inflate_auto,
};
use crate::json::{JsonValue, write_json_string, write_json_value};
use crate::log::{
    LogMessage, MSG_TYPE_DELETE, MSG_TYPE_EDIT, ReplicatedLog, SealedLogRecord, is_edit_log_type,
    is_internal_log_type,
};
use crate::media::{MAX_MEDIA_SYNC_TARGETS, MAX_ONE_WAY_COMPENSATION_MS, MediaSyncState};
use crate::protocol::{
    DEFAULT_BATCH_MAX_BYTES, DEFAULT_BATCH_MAX_MSGS, DEFAULT_GOSSIP_TTL, DEFAULT_INV_CHUNK_IDS,
    DEFAULT_RELAY_TTL, EncryptedWireEnvelope, MAX_COLOR_SYNC_CLAIMS, PeerColorClaim, PeerSummary,
    RelaySignalBody, RelaySignalType, VOICE_PACKET_HEADER_LEN, WireFrame, chunk_inv_ids,
    chunk_sealed_records, open_voice_packet_ciphertext, open_voice_packet_ciphertext_into,
    open_voice_v2_packet_ciphertext, open_voice_v2_packet_ciphertext_into,
    parse_voice_packet_header, parse_voice_v2_packet_header, seal_voice_packet,
    seal_voice_packet_into, seal_voice_v2_packet, seal_voice_v2_packet_into,
};

#[derive(Debug, Clone)]
pub struct MeshConfig {
    pub inv_chunk_ids: usize,
    pub batch_max_msgs: usize,
    pub batch_max_bytes: usize,
    pub gossip_ttl: u32,
    pub relay_ttl: u32,
    pub max_direct_peers: usize,
    pub auto_mesh_enabled: bool,
    pub auto_mesh_timeout_ms: u64,
}

impl Default for MeshConfig {
    fn default() -> Self {
        Self {
            inv_chunk_ids: DEFAULT_INV_CHUNK_IDS,
            batch_max_msgs: DEFAULT_BATCH_MAX_MSGS,
            batch_max_bytes: DEFAULT_BATCH_MAX_BYTES,
            gossip_ttl: DEFAULT_GOSSIP_TTL,
            relay_ttl: DEFAULT_RELAY_TTL,
            max_direct_peers: 12,
            auto_mesh_enabled: true,
            auto_mesh_timeout_ms: 15_000,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MeshStats {
    pub frames_sent: u64,
    pub frames_received: u64,
    pub e2ee_frames_encrypted: u64,
    pub e2ee_frames_decrypted: u64,
    pub e2ee_auth_failures: u64,
    pub relay_signals_encrypted: u64,
    pub gossip_forwards: u64,
    pub gossip_duplicates_dropped: u64,
    pub sync_inv_sent: u64,
    pub sync_inv_received: u64,
    pub sync_batches_sent: u64,
    pub sync_batches_received: u64,
    pub auto_mesh_intros_sent: u64,
    pub auto_mesh_offers_created: u64,
    pub relay_signals_forwarded: u64,
    pub voice_packets_sent: u64,
    pub voice_packets_received: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MeshAction {
    SendWire {
        peer_id: String,
        frame: String,
    },
    LogUpdated {
        added_ids: Vec<String>,
        deleted_ids: Vec<String>,
        total_count: usize,
        lamport: u64,
    },
    AutoMeshCreateOffer {
        target_peer_id: String,
        target_name: String,
        target_pub_key: [u8; KEY_LEN],
        via_peer_id: String,
    },
    AutoMeshAcceptOffer {
        from_peer_id: String,
        from_name: String,
        from_pub_key: [u8; KEY_LEN],
        via_peer_id: String,
        sdp: String,
    },
    AutoMeshApplyAnswer {
        from_peer_id: String,
        sdp: String,
    },
    AutoMeshAddIce {
        from_peer_id: String,
        candidate: JsonValue,
    },
    BotActionReceived {
        action_uid: String,
        from_peer_id: String,
        from_name: String,
        message_id: String,
        action_id: String,
        label: String,
        value: JsonValue,
        ts: u64,
    },
    MediaSync {
        state: MediaSyncState,
    },
    PeerColors {
        colors: BTreeMap<String, u32>,
    },
    Telemetry {
        event: String,
        detail: String,
    },
}

impl MeshAction {
    pub fn write_json(&self, out: &mut String) {
        match self {
            Self::SendWire { peer_id, frame } => {
                out.push_str("{\"action\":\"send_wire\",\"peerId\":");
                write_json_string(out, peer_id);
                out.push_str(",\"frame\":");
                write_json_string(out, frame);
                out.push('}');
            }
            Self::LogUpdated {
                added_ids,
                deleted_ids,
                total_count,
                lamport,
            } => {
                out.push_str("{\"action\":\"log_updated\",\"addedIds\":[");
                for (i, id) in added_ids.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_json_string(out, id);
                }
                out.push_str("],\"deletedIds\":[");
                for (i, id) in deleted_ids.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_json_string(out, id);
                }
                let _ = write!(
                    out,
                    "],\"totalCount\":{total_count},\"lamport\":{lamport}}}"
                );
            }
            Self::AutoMeshCreateOffer {
                target_peer_id,
                target_name,
                target_pub_key,
                via_peer_id,
            } => {
                out.push_str("{\"action\":\"auto_mesh_create_offer\",\"targetPeerId\":");
                write_json_string(out, target_peer_id);
                out.push_str(",\"targetName\":");
                write_json_string(out, target_name);
                out.push_str(",\"targetPubKey\":");
                write_json_string(out, &base64url_encode(target_pub_key));
                out.push_str(",\"viaPeerId\":");
                write_json_string(out, via_peer_id);
                out.push('}');
            }
            Self::AutoMeshAcceptOffer {
                from_peer_id,
                from_name,
                from_pub_key,
                via_peer_id,
                sdp,
            } => {
                out.push_str("{\"action\":\"auto_mesh_accept_offer\",\"fromPeerId\":");
                write_json_string(out, from_peer_id);
                out.push_str(",\"fromName\":");
                write_json_string(out, from_name);
                out.push_str(",\"fromPubKey\":");
                write_json_string(out, &base64url_encode(from_pub_key));
                out.push_str(",\"viaPeerId\":");
                write_json_string(out, via_peer_id);
                out.push_str(",\"sdp\":");
                write_json_string(out, sdp);
                out.push('}');
            }
            Self::AutoMeshApplyAnswer { from_peer_id, sdp } => {
                out.push_str("{\"action\":\"auto_mesh_apply_answer\",\"fromPeerId\":");
                write_json_string(out, from_peer_id);
                out.push_str(",\"sdp\":");
                write_json_string(out, sdp);
                out.push('}');
            }
            Self::AutoMeshAddIce {
                from_peer_id,
                candidate,
            } => {
                out.push_str("{\"action\":\"auto_mesh_add_ice\",\"fromPeerId\":");
                write_json_string(out, from_peer_id);
                out.push_str(",\"candidate\":");
                write_json_value(out, candidate);
                out.push('}');
            }
            Self::BotActionReceived {
                action_uid,
                from_peer_id,
                from_name,
                message_id,
                action_id,
                label,
                value,
                ts,
            } => {
                out.push_str("{\"action\":\"bot_action\",\"actionUid\":");
                write_json_string(out, action_uid);
                out.push_str(",\"fromPeerId\":");
                write_json_string(out, from_peer_id);
                out.push_str(",\"fromName\":");
                write_json_string(out, from_name);
                out.push_str(",\"messageId\":");
                write_json_string(out, message_id);
                out.push_str(",\"actionId\":");
                write_json_string(out, action_id);
                out.push_str(",\"label\":");
                write_json_string(out, label);
                out.push_str(",\"value\":");
                write_json_value(out, value);
                let _ = write!(out, ",\"ts\":{ts}}}");
            }
            Self::MediaSync { state } => {
                out.push_str("{\"action\":\"media_sync\",\"state\":");
                state.write_json(out, state.anchor_local_ms);
                out.push('}');
            }
            Self::PeerColors { colors } => {
                out.push_str("{\"action\":\"peer_colors\",\"colors\":{");
                for (i, (pid, idx)) in colors.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_json_string(out, pid);
                    let _ = write!(out, ":{idx}");
                }
                out.push_str("}}");
            }
            Self::Telemetry { event, detail } => {
                out.push_str("{\"action\":\"telemetry\",\"event\":");
                write_json_string(out, event);
                out.push_str(",\"detail\":");
                write_json_string(out, detail);
                out.push('}');
            }
        }
    }
}

pub fn actions_to_json_array(actions: &[MeshAction]) -> String {
    let cap: usize = actions
        .iter()
        .map(|a| match a {
            MeshAction::SendWire { frame, .. } => frame.len().saturating_add(96),
            _ => 160,
        })
        .sum::<usize>()
        .saturating_add(8);
    let mut out = String::with_capacity(cap);
    out.push('[');
    for (i, act) in actions.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        act.write_json(&mut out);
    }
    out.push(']');
    out
}

/// 256-slot sliding anti-replay window for authenticated per-link sequence numbers.
/// Wide enough that low-priority `p2p-bulk` GIF/video transfers can complete safely
/// while fast chat, presence, and keepalive frames pass ahead on `p2p-mesh`.
#[derive(Debug, Clone, Default)]
struct ReplayWindow {
    max_seq: u64,
    seen_bits: [u64; 4],
}

impl ReplayWindow {
    fn would_accept(&self, seq: u64) -> bool {
        if seq == 0 {
            return false;
        }
        if self.max_seq == 0 || seq > self.max_seq {
            return true;
        }
        let diff = self.max_seq - seq;
        if diff >= 256 {
            return false;
        }
        let word = (diff / 64) as usize;
        let bit = diff % 64;
        (self.seen_bits[word] & (1u64 << bit)) == 0
    }

    fn accept(&mut self, seq: u64) {
        if self.max_seq == 0 {
            self.max_seq = seq;
            self.seen_bits = [1, 0, 0, 0];
            return;
        }
        if seq > self.max_seq {
            let shift = seq - self.max_seq;
            if shift >= 256 {
                self.seen_bits = [1, 0, 0, 0];
            } else {
                let word_shift = (shift / 64) as usize;
                let bit_shift = (shift % 64) as u32;
                let mut next = [0u64; 4];
                for (i, slot) in next.iter_mut().enumerate().skip(word_shift) {
                    let src = i - word_shift;
                    let mut w = self.seen_bits[src] << bit_shift;
                    if bit_shift > 0 && src > 0 {
                        w |= self.seen_bits[src - 1] >> (64 - bit_shift);
                    }
                    *slot = w;
                }
                next[0] |= 1;
                self.seen_bits = next;
            }
            self.max_seq = seq;
        } else {
            let diff = self.max_seq - seq;
            if diff < 256 {
                let word = (diff / 64) as usize;
                let bit = diff % 64;
                self.seen_bits[word] |= 1u64 << bit;
            }
        }
    }
}

#[derive(Debug, Clone)]
struct PeerCryptoState {
    pub_key: [u8; KEY_LEN],
    tx_key: [u8; KEY_LEN],
    rx_key: [u8; KEY_LEN],
    tx_nonce_prefix: [u8; 4],
    tx_seq: u64,
    replay_window: ReplayWindow,
    voice_tx_key: [u8; KEY_LEN],
    voice_rx_key: [u8; KEY_LEN],
    voice_tx_nonce_prefix: [u8; 4],
    voice_tx_seq: u64,
    voice_replay_window: ReplayWindow,
    safety_code: String,
}

impl PeerCryptoState {
    fn next_tx_seq_and_nonce(&mut self) -> (u64, [u8; NONCE_LEN]) {
        self.tx_seq = self.tx_seq.saturating_add(1);
        let mut nonce = [0u8; NONCE_LEN];
        nonce[0..4].copy_from_slice(&self.tx_nonce_prefix);
        nonce[4..12].copy_from_slice(&self.tx_seq.to_le_bytes());
        (self.tx_seq, nonce)
    }

    fn next_voice_tx_seq_and_nonce(&mut self) -> (u64, [u8; NONCE_LEN]) {
        self.voice_tx_seq = self.voice_tx_seq.saturating_add(1);
        let mut nonce = [0u8; NONCE_LEN];
        nonce[0..4].copy_from_slice(&self.voice_tx_nonce_prefix);
        nonce[4..12].copy_from_slice(&self.voice_tx_seq.to_le_bytes());
        (self.voice_tx_seq, nonce)
    }
}

#[derive(Debug, Clone)]
struct PendingInventory {
    inv_id: String,
    total_parts: usize,
    received_parts: HashSet<usize>,
    ids: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct ConnectedPeer {
    pub peer_id: String,
    pub author_name: String,
    pub via_auto_mesh: bool,
    pub introduced_by: Option<String>,
    pub remote_peers: Vec<PeerSummary>,
    pub last_pong_ms: u64,
    pub rtt_ms: Option<u64>,
    pub min_rtt_ms: Option<u64>,
    pub clock_offset_ms: Option<i64>,
    pub in_voice: bool,
    pub voice_muted: bool,
    pub is_bot: bool,
    crypto: PeerCryptoState,
    known_ids: HashSet<String>,
    pending_inv: Option<PendingInventory>,
    we_sent_inv: bool,
}

#[derive(Debug, Clone)]
pub struct IndirectPeerRoute {
    pub peer_id: String,
    pub author_name: String,
    pub pub_key: [u8; KEY_LEN],
    pub via_peer_id: String,
}

#[derive(Debug, Clone)]
pub struct PendingAutoMesh {
    pub target_peer_id: String,
    pub target_name: String,
    pub target_pub_key: [u8; KEY_LEN],
    pub via_peer_id: String,
    pub initiated_by_self: bool,
    pub started_at_ms: u64,
}

pub struct MeshNode {
    peer_id: String,
    author_name: String,
    room: String,
    x25519_secret: [u8; KEY_LEN],
    x25519_public: [u8; KEY_LEN],
    mesh_key: [u8; KEY_LEN],
    log_key: [u8; KEY_LEN],
    room_signal_key: [u8; KEY_LEN],
    room_topic: String,
    key_fp: String,
    passphrase_mode: bool,
    in_voice: bool,
    voice_muted: bool,
    voice_dsp_48k: VoiceCaptureDsp48k,
    is_bot: bool,
    csprng: SafeCsprng,
    config: MeshConfig,
    log: ReplicatedLog,
    peers: BTreeMap<String, ConnectedPeer>,
    known_pub_keys: BTreeMap<String, [u8; KEY_LEN]>,
    indirect_routes: BTreeMap<String, IndirectPeerRoute>,
    auto_mesh_pending: BTreeMap<String, PendingAutoMesh>,
    seen_bot_actions: HashSet<String>,
    media_states: BTreeMap<String, MediaSyncState>,
    peer_colors: BTreeMap<String, PeerColorClaim>,
    stats: MeshStats,
    seq: u64,
}

impl MeshNode {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        peer_id: String,
        author_name: String,
        room: String,
        x25519_secret: [u8; KEY_LEN],
        mesh_key: [u8; KEY_LEN],
        entropy_seed: &[u8],
        config: MeshConfig,
    ) -> Self {
        let x25519_public = x25519_public_key(&x25519_secret);
        let log_key = derive_log_key(&mesh_key);
        let room_signal_key = derive_room_signal_key(&mesh_key);
        let room_topic = derive_room_topic(&mesh_key);
        let key_fp = key_fingerprint(&mesh_key);
        let mut seed_buf = Vec::with_capacity(64 + entropy_seed.len());
        seed_buf.extend_from_slice(&x25519_public);
        seed_buf.extend_from_slice(&mesh_key);
        seed_buf.extend_from_slice(entropy_seed);
        let csprng = SafeCsprng::from_seed(&seed_buf);
        let mut peer_colors = BTreeMap::new();
        peer_colors.insert(
            peer_id.clone(),
            PeerColorClaim {
                peer_id: peer_id.clone(),
                color_idx: 0,
                claimed_lamport: 0,
            },
        );
        Self {
            peer_id,
            author_name,
            room,
            x25519_secret,
            x25519_public,
            mesh_key,
            log_key,
            room_signal_key,
            room_topic,
            key_fp,
            passphrase_mode: false,
            in_voice: false,
            voice_muted: false,
            voice_dsp_48k: VoiceCaptureDsp48k::new(),
            is_bot: false,
            csprng,
            config,
            log: ReplicatedLog::new(),
            peers: BTreeMap::new(),
            known_pub_keys: BTreeMap::new(),
            indirect_routes: BTreeMap::new(),
            auto_mesh_pending: BTreeMap::new(),
            seen_bot_actions: HashSet::new(),
            media_states: BTreeMap::new(),
            peer_colors,
            stats: MeshStats::default(),
            seq: 0,
        }
    }

    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    pub fn author_name(&self) -> &str {
        &self.author_name
    }

    pub fn room(&self) -> &str {
        &self.room
    }

    pub fn public_key(&self) -> [u8; KEY_LEN] {
        self.x25519_public
    }

    pub fn mesh_key(&self) -> [u8; KEY_LEN] {
        self.mesh_key
    }

    pub fn key_fingerprint(&self) -> &str {
        &self.key_fp
    }

    pub fn room_topic(&self) -> &str {
        &self.room_topic
    }

    pub fn passphrase_mode(&self) -> bool {
        self.passphrase_mode
    }

    pub fn in_voice(&self) -> bool {
        self.in_voice
    }

    pub fn voice_muted(&self) -> bool {
        self.voice_muted
    }

    pub fn is_bot(&self) -> bool {
        self.is_bot
    }

    pub fn set_is_bot(&mut self, is_bot: bool) {
        self.is_bot = is_bot;
    }

    pub fn invite_wrap_key(&self) -> Option<[u8; KEY_LEN]> {
        if self.passphrase_mode {
            Some(derive_invite_wrap_key(&self.mesh_key))
        } else {
            None
        }
    }

    pub fn reseed_entropy(&mut self, entropy: &[u8]) {
        self.csprng.reseed(entropy);
    }

    pub fn rng_mut(&mut self) -> &mut SafeCsprng {
        &mut self.csprng
    }

    /// Deflates and ChaCha20-Poly1305 AEAD-seals a room rendezvous signaling payload
    /// under `derive_room_signal_key(&self.mesh_key)` bound to `self.room_topic`.
    pub fn seal_room_signal(&mut self, plaintext: &str) -> String {
        let compressed = deflate_raw(plaintext.as_bytes());
        let nonce = self.csprng.next_nonce();
        let aad = format!("p2p-room-sig-v1|{}", self.room_topic);
        let sealed = aead_seal(&self.room_signal_key, &nonce, aad.as_bytes(), &compressed);
        let mut framed = Vec::with_capacity(NONCE_LEN + sealed.len());
        framed.extend_from_slice(&nonce);
        framed.extend_from_slice(&sealed);
        format!("R1:{}", base64url_encode(&framed))
    }

    /// Authenticates, decrypts, and inflates an `R1:` room rendezvous signaling payload.
    pub fn open_room_signal(&mut self, sealed: &str) -> Result<String, String> {
        let body = sealed
            .trim()
            .strip_prefix("R1:")
            .ok_or_else(|| "room signal must start with 'R1:'".to_owned())?;
        let raw = base64url_decode(body)?;
        let nonce_slice = raw
            .get(..NONCE_LEN)
            .ok_or_else(|| "truncated room signal nonce".to_owned())?;
        let ct_slice = raw
            .get(NONCE_LEN..)
            .ok_or_else(|| "truncated room signal ciphertext".to_owned())?;
        let nonce = parse_fixed_12(nonce_slice, "room signal nonce")?;
        let aad = format!("p2p-room-sig-v1|{}", self.room_topic);
        let compressed = match aead_open(&self.room_signal_key, &nonce, aad.as_bytes(), ct_slice) {
            Ok(bytes) => bytes,
            Err(err) => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(err);
            }
        };
        let plain_bytes = inflate_auto(&compressed)?;
        String::from_utf8(plain_bytes)
            .map_err(|_| "decrypted room signal is not valid UTF-8".to_owned())
    }

    pub fn set_author_name(&mut self, name: String) {
        if !name.trim().is_empty() {
            self.author_name = name;
        }
    }

    /// Broadcasts an updated encrypted `Hello` frame to all currently connected direct peers
    /// so profile changes (such as display name) propagate live across Voice Chat and Peer lists.
    pub fn broadcast_hello_update(&mut self) -> Vec<MeshAction> {
        let mut actions = Vec::new();
        let peer_ids: Vec<String> = self.peers.keys().cloned().collect();
        for pid in peer_ids {
            let other_peers: Vec<PeerSummary> = self
                .peers
                .values()
                .filter(|p| p.peer_id != pid)
                .map(|p| PeerSummary {
                    peer_id: p.peer_id.clone(),
                    author_name: p.author_name.clone(),
                    pub_key: p.crypto.pub_key,
                    is_bot: p.is_bot,
                })
                .collect();
            let hello = WireFrame::Hello {
                peer_id: self.peer_id.clone(),
                author_name: self.author_name.clone(),
                room: self.room.clone(),
                pub_key: self.x25519_public,
                lamport: self.log.lamport(),
                log_count: self.log.len(),
                in_voice: self.in_voice,
                voice_muted: self.voice_muted,
                is_bot: self.is_bot,
                peers: other_peers,
            };
            self.emit_wire(&mut actions, &pid, &hello);
        }
        actions
    }

    pub fn set_room(&mut self, room: String) {
        if !room.trim().is_empty() {
            self.room = room;
        }
    }

    pub fn set_auto_mesh_enabled(&mut self, enabled: bool) {
        self.config.auto_mesh_enabled = enabled;
    }

    /// Updates the 256-bit mesh key, re-sealing local log records and re-keying active links.
    /// Returns immediately as a no-op if the key and passphrase mode are already active so live E2EE links are preserved.
    pub fn set_mesh_key(&mut self, new_mesh_key: [u8; KEY_LEN], passphrase_mode: bool) -> Result<(), String> {
        if self.mesh_key == new_mesh_key && self.passphrase_mode == passphrase_mode {
            return Ok(());
        }
        self.log.materialize_deferred(&self.log_key);
        self.mesh_key = new_mesh_key;
        self.log_key = derive_log_key(&new_mesh_key);
        self.room_signal_key = derive_room_signal_key(&new_mesh_key);
        self.room_topic = derive_room_topic(&new_mesh_key);
        self.key_fp = key_fingerprint(&new_mesh_key);
        self.passphrase_mode = passphrase_mode;
        self.log.reseal_all(&self.log_key, &mut self.csprng);

        // Re-derive per-peer directional wire and voice keys under the new mesh key
        for (pid, peer) in self.peers.iter_mut() {
            let ((tx_key, rx_key), (voice_tx_key, voice_rx_key)) = derive_all_link_keys(
                &self.x25519_secret,
                &peer.crypto.pub_key,
                &self.mesh_key,
                &self.peer_id,
                pid,
            )?;
            let prefix_block = self.csprng.next_bytes_32();
            let mut prefix = [0u8; 4];
            prefix.copy_from_slice(&prefix_block[..4]);
            let mut voice_prefix = [0u8; 4];
            voice_prefix.copy_from_slice(&prefix_block[4..8]);
            peer.crypto.tx_key = tx_key;
            peer.crypto.rx_key = rx_key;
            peer.crypto.tx_nonce_prefix = prefix;
            peer.crypto.tx_seq = 0;
            peer.crypto.replay_window = ReplayWindow::default();
            peer.crypto.voice_tx_key = voice_tx_key;
            peer.crypto.voice_rx_key = voice_rx_key;
            peer.crypto.voice_tx_nonce_prefix = voice_prefix;
            peer.crypto.voice_tx_seq = 0;
            peer.crypto.voice_replay_window = ReplayWindow::default();
            peer.crypto.safety_code =
                pair_safety_code(&self.x25519_public, &peer.crypto.pub_key, &self.mesh_key);
        }
        self.media_states.clear();
        self.reset_peer_colors();
        Ok(())
    }

    /// Derives the 256-bit mesh key from a shared passphrase using PBKDF2-HMAC-SHA256.
    pub fn set_passphrase(&mut self, passphrase: &str) -> Result<(), String> {
        if passphrase.is_empty() {
            return Err("passphrase must not be empty".to_owned());
        }
        let derived = derive_mesh_key_from_passphrase(passphrase);
        self.set_mesh_key(derived, true)
    }

    /// Disables passphrase-wrap mode while keeping or replacing the active random 256-bit mesh key.
    pub fn clear_passphrase(&mut self, new_random_mesh_key: Option<[u8; KEY_LEN]>) -> Result<(), String> {
        let key = new_random_mesh_key.unwrap_or(self.mesh_key);
        self.set_mesh_key(key, false)
    }

    pub fn log(&self) -> &ReplicatedLog {
        &self.log
    }

    pub fn stats(&self) -> &MeshStats {
        &self.stats
    }

    pub fn connected_peer_ids(&self) -> Vec<String> {
        self.peers.keys().cloned().collect()
    }

    pub fn is_connected_to(&self, peer_id: &str) -> bool {
        self.peers.contains_key(peer_id)
    }

    pub fn peer_safety_code(&self, peer_id: &str) -> Option<&str> {
        self.peers.get(peer_id).map(|p| p.crypto.safety_code.as_str())
    }

    fn next_seq(&mut self) -> u64 {
        self.seq = self.seq.saturating_add(1);
        self.seq
    }

    /// Encrypts an already-serialized wire frame with the peer's directional ChaCha20-Poly1305 session key.
    fn emit_wire_plaintext(
        &mut self,
        actions: &mut Vec<MeshAction>,
        peer_id: &str,
        plaintext: &str,
    ) {
        let Some(peer) = self.peers.get_mut(peer_id) else {
            return;
        };
        let (tx_seq, nonce) = peer.crypto.next_tx_seq_and_nonce();
        let env = EncryptedWireEnvelope::seal(
            &peer.crypto.tx_key,
            tx_seq,
            nonce,
            &self.peer_id,
            peer_id,
            plaintext,
        );
        self.stats.frames_sent = self.stats.frames_sent.saturating_add(1);
        self.stats.e2ee_frames_encrypted = self.stats.e2ee_frames_encrypted.saturating_add(1);
        actions.push(MeshAction::SendWire {
            peer_id: peer_id.to_owned(),
            frame: env.to_json_string(),
        });
    }

    /// Encrypts `frame` with the peer's directional X25519+MeshKey ChaCha20-Poly1305 session key.
    fn emit_wire(&mut self, actions: &mut Vec<MeshAction>, peer_id: &str, frame: &WireFrame) {
        let plaintext = frame.to_json_string();
        self.emit_wire_plaintext(actions, peer_id, &plaintext);
    }

    /// Imports an E2EE v2 snapshot (authenticating & decrypting every ChaCha20-Poly1305 record).
    pub fn import_persistence(&mut self, val: &JsonValue) -> Result<usize, String> {
        if val.get("records").is_some() {
            self.log.import_encrypted_snapshot_value(val, &self.log_key)
        } else {
            let added = self.log.import_snapshot_value(val)?;
            self.log.reseal_all(&self.log_key, &mut self.csprng);
            Ok(added)
        }
    }

    /// Exports an E2EE v2 snapshot containing ONLY ChaCha20-Poly1305 ciphertext records (zero plaintext).
    pub fn export_persistence(&mut self) -> String {
        self.log
            .export_encrypted_snapshot_json(&self.log_key, &self.key_fp, &mut self.csprng)
    }

    /// Exports decrypted structured JSON messages (only when explicitly requested by user).
    pub fn export_decrypted_json(&self) -> String {
        self.log.export_snapshot_json_with_key(Some(&self.log_key))
    }

    /// Clears only this node's local replicated log so re-syncing pulls encrypted history from surviving peers.
    pub fn reset_local_log(&mut self) {
        self.log = ReplicatedLog::new();
        self.media_states
            .retain(|k, _| !k.starts_with("vid:") && !k.starts_with("gif:"));
        if self.peers.is_empty() {
            self.reset_peer_colors();
        }
        for peer in self.peers.values_mut() {
            peer.known_ids.clear();
            peer.pending_inv = None;
            peer.we_sent_inv = false;
        }
    }

    fn reset_peer_colors(&mut self) {
        self.peer_colors.clear();
        self.peer_colors.insert(
            self.peer_id.clone(),
            PeerColorClaim {
                peer_id: self.peer_id.clone(),
                color_idx: 0,
                claimed_lamport: 0,
            },
        );
        self.normalize_peer_colors();
    }

    fn incoming_color_claim_wins(existing: &PeerColorClaim, incoming: &PeerColorClaim) -> bool {
        match (existing.claimed_lamport == 0, incoming.claimed_lamport == 0) {
            (true, false) => true,
            (false, true) => false,
            (false, false) => {
                (incoming.claimed_lamport, incoming.color_idx)
                    < (existing.claimed_lamport, existing.color_idx)
            }
            (true, true) => incoming.color_idx < existing.color_idx,
        }
    }

    fn max_committed_color_lamport(&self) -> u64 {
        self.peer_colors
            .values()
            .map(|c| c.claimed_lamport)
            .max()
            .unwrap_or(0)
    }

    /// Deterministically enforces a strict 1-to-1 bijection (`peer_id -> unique color_idx`)
    /// across self, all connected peers, and all message authors in the replicated log.
    /// Returns `true` iff any peer's effective `color_idx` changed.
    fn normalize_peer_colors(&mut self) -> bool {
        let prev_map: BTreeMap<String, u32> = self
            .peer_colors
            .iter()
            .map(|(k, v)| (k.clone(), v.color_idx))
            .collect();

        // Ensure self, all connected peers, and all log authors exist in the registry
        self.peer_colors
            .entry(self.peer_id.clone())
            .or_insert_with(|| PeerColorClaim {
                peer_id: self.peer_id.clone(),
                color_idx: u32::MAX,
                claimed_lamport: 0,
            });
        for pid in self.peers.keys() {
            if self.peer_colors.len() >= MAX_COLOR_SYNC_CLAIMS {
                break;
            }
            self.peer_colors
                .entry(pid.clone())
                .or_insert_with(|| PeerColorClaim {
                    peer_id: pid.clone(),
                    color_idx: u32::MAX,
                    claimed_lamport: 0,
                });
        }
        for msg in self.log.raw_ordered() {
            if self.peer_colors.len() >= MAX_COLOR_SYNC_CLAIMS {
                break;
            }
            if !msg.author.trim().is_empty() {
                self.peer_colors
                    .entry(msg.author.clone())
                    .or_insert_with(|| PeerColorClaim {
                        peer_id: msg.author.clone(),
                        color_idx: u32::MAX,
                        claimed_lamport: 0,
                    });
            }
        }

        // Canonical strict total order: committed claims (lamport >= 1) first by (lamport, peer_id),
        // then tentative claims (lamport == 0) by peer_id.
        let mut ordered: Vec<PeerColorClaim> = self.peer_colors.values().cloned().collect();
        ordered.sort_by(|a, b| {
            (a.claimed_lamport == 0, a.claimed_lamport, a.peer_id.as_str()).cmp(&(
                b.claimed_lamport == 0,
                b.claimed_lamport,
                b.peer_id.as_str(),
            ))
        });

        let mut used: BTreeSet<u32> = BTreeSet::new();
        let mut next_free: u32 = 0;
        for claim in &mut ordered {
            if claim.color_idx != u32::MAX && !used.contains(&claim.color_idx) {
                used.insert(claim.color_idx);
            } else {
                while used.contains(&next_free) {
                    next_free = next_free.saturating_add(1);
                }
                claim.color_idx = next_free;
                used.insert(next_free);
                next_free = next_free.saturating_add(1);
            }
        }

        self.peer_colors.clear();
        for claim in ordered {
            self.peer_colors.insert(claim.peer_id.clone(), claim);
        }

        if prev_map.len() != self.peer_colors.len() {
            return true;
        }
        self.peer_colors
            .iter()
            .any(|(k, v)| prev_map.get(k) != Some(&v.color_idx))
    }

    pub fn peer_colors_map(&self) -> BTreeMap<String, u32> {
        self.peer_colors
            .iter()
            .map(|(k, v)| (k.clone(), v.color_idx))
            .collect()
    }

    pub fn color_for_peer(&self, peer_id: &str) -> u32 {
        self.peer_colors
            .get(peer_id)
            .map(|c| c.color_idx)
            .unwrap_or(0)
    }

    fn build_color_sync_frame(&self, ttl: u32) -> WireFrame {
        let claims: Vec<PeerColorClaim> = self
            .peer_colors
            .values()
            .take(MAX_COLOR_SYNC_CLAIMS)
            .cloned()
            .collect();
        WireFrame::ColorSync {
            origin: self.peer_id.clone(),
            ttl,
            claims,
        }
    }

    fn broadcast_color_sync(
        &mut self,
        actions: &mut Vec<MeshAction>,
        exclude_peer: Option<&str>,
        origin: Option<&str>,
        ttl: u32,
    ) {
        let targets: Vec<String> = self
            .peers
            .keys()
            .filter(|pid| {
                exclude_peer != Some(pid.as_str()) && origin != Some(pid.as_str())
            })
            .cloned()
            .collect();
        if targets.is_empty() {
            return;
        }
        let frame = WireFrame::ColorSync {
            origin: origin.unwrap_or(&self.peer_id).to_owned(),
            ttl,
            claims: self
                .peer_colors
                .values()
                .take(MAX_COLOR_SYNC_CLAIMS)
                .cloned()
                .collect(),
        };
        let plaintext = frame.to_json_string();
        for pid in targets {
            self.emit_wire_plaintext(actions, &pid, &plaintext);
        }
    }

    /// Commits this node's own room color claim if still tentative (`claimed_lamport == 0`),
    /// normalizes for zero duplicates, and gossips to connected peers.
    pub fn commit_self_color(&mut self) -> Vec<MeshAction> {
        let mut actions = Vec::new();
        let is_tentative = self
            .peer_colors
            .get(&self.peer_id)
            .map(|c| c.claimed_lamport == 0)
            .unwrap_or(true);
        if is_tentative {
            let next_l = self.max_committed_color_lamport().saturating_add(1).max(1);
            let existing_idx = self
                .peer_colors
                .get(&self.peer_id)
                .map(|c| c.color_idx)
                .unwrap_or(u32::MAX);
            self.peer_colors.insert(
                self.peer_id.clone(),
                PeerColorClaim {
                    peer_id: self.peer_id.clone(),
                    color_idx: existing_idx,
                    claimed_lamport: next_l,
                },
            );
            let changed = self.normalize_peer_colors();
            if changed {
                actions.push(MeshAction::PeerColors {
                    colors: self.peer_colors_map(),
                });
            }
            let ttl = self.config.gossip_ttl;
            self.broadcast_color_sync(&mut actions, None, None, ttl);
        }
        actions
    }

    fn handle_color_sync(
        &mut self,
        from_peer: &str,
        origin: String,
        ttl: u32,
        incoming_claims: Vec<PeerColorClaim>,
        actions: &mut Vec<MeshAction>,
    ) {
        let mut claims_upgraded = false;
        for claim in incoming_claims.into_iter().take(MAX_COLOR_SYNC_CLAIMS) {
            if claim.peer_id.trim().is_empty() {
                continue;
            }
            match self.peer_colors.get(&claim.peer_id) {
                Some(existing) => {
                    if Self::incoming_color_claim_wins(existing, &claim) {
                        self.peer_colors.insert(claim.peer_id.clone(), claim);
                        claims_upgraded = true;
                    }
                }
                None => {
                    if self.peer_colors.len() < MAX_COLOR_SYNC_CLAIMS {
                        self.peer_colors.insert(claim.peer_id.clone(), claim);
                        claims_upgraded = true;
                    }
                }
            }
        }

        // If self is still tentative and we are now talking to peers, commit self cleanly
        // right after the highest committed Lamport so earlier room members keep their colors.
        let mut self_just_committed = false;
        let self_is_tentative = self
            .peer_colors
            .get(&self.peer_id)
            .map(|c| c.claimed_lamport == 0)
            .unwrap_or(true);
        if self_is_tentative && !self.peers.is_empty() {
            let next_l = self.max_committed_color_lamport().saturating_add(1).max(1);
            // Reset color_idx to u32::MAX so normalize_peer_colors picks the lowest unused slot
            // without colliding with existing committed peers.
            self.peer_colors.insert(
                self.peer_id.clone(),
                PeerColorClaim {
                    peer_id: self.peer_id.clone(),
                    color_idx: u32::MAX,
                    claimed_lamport: next_l,
                },
            );
            self_just_committed = true;
        }

        let colors_changed = self.normalize_peer_colors();
        if colors_changed || self_just_committed {
            actions.push(MeshAction::PeerColors {
                colors: self.peer_colors_map(),
            });
        }

        if self_just_committed {
            // Broadcast our newly committed claim to ALL peers (including `from_peer`)
            let gossip_ttl = self.config.gossip_ttl;
            self.broadcast_color_sync(actions, None, None, gossip_ttl);
        } else if (claims_upgraded || colors_changed) && ttl > 0 {
            self.broadcast_color_sync(actions, Some(from_peer), Some(&origin), ttl - 1);
        }
    }

    fn prune_media_states_for_deleted_msg(&mut self, msg_id: &str) {
        if msg_id.is_empty() {
            return;
        }
        let vid_prefix = format!("vid:{msg_id}:");
        let gif_prefix = format!("gif:{msg_id}:");
        self.media_states
            .retain(|k, _| !k.starts_with(&vid_prefix) && !k.starts_with(&gif_prefix));
    }

    fn prune_media_states_capacity(&mut self) {
        if self.media_states.len() <= MAX_MEDIA_SYNC_TARGETS {
            return;
        }
        // Evict oldest non-"watch" entry by anchor_local_ms
        if let Some(oldest_key) = self
            .media_states
            .iter()
            .filter(|(k, _)| k.as_str() != "watch")
            .min_by_key(|(_, st)| (st.active, st.anchor_local_ms))
            .map(|(k, _)| k.clone())
        {
            self.media_states.remove(&oldest_key);
        }
    }

    /// Appends a new local structured JSON message, AEAD-seals it, and gossips it encrypted to all peers.
    pub fn publish_local(
        &mut self,
        msg_type: String,
        payload: JsonValue,
        ts_ms: u64,
        custom_id: Option<String>,
    ) -> Result<(LogMessage, Vec<MeshAction>), String> {
        let seq = self.next_seq();
        let next_lp = self.log.lamport().saturating_add(1);
        let id = match custom_id {
            Some(cid) if !cid.trim().is_empty() => cid,
            _ => format!("{}-{}-{}-{}", self.peer_id, next_lp, ts_ms, seq),
        };
        let (msg, sealed) = self.log.append_local_sealed(
            id,
            msg_type,
            ts_ms,
            self.peer_id.clone(),
            self.author_name.clone(),
            payload,
            &self.log_key,
            &mut self.csprng,
        )?;

        let mut added_ids = Vec::new();
        let mut deleted_ids = Vec::new();
        if msg.msg_type == MSG_TYPE_DELETE {
            if let Some(target_id) = msg.payload.get_str("targetId") {
                self.prune_media_states_for_deleted_msg(target_id);
                deleted_ids.push(target_id.to_owned());
            }
        } else {
            added_ids.push(msg.id.clone());
        }

        let mut actions = Vec::new();
        actions.push(MeshAction::LogUpdated {
            added_ids,
            deleted_ids,
            total_count: self.log.len(),
            lamport: self.log.lamport(),
        });

        let peer_ids: Vec<String> = self.peers.keys().cloned().collect();
        if !peer_ids.is_empty() {
            let wire = WireFrame::Msg {
                origin: self.peer_id.clone(),
                ttl: self.config.gossip_ttl,
                path: vec![self.peer_id.clone()],
                record: sealed,
            };
            let plaintext = wire.to_json_string();
            for pid in peer_ids {
                if let Some(peer) = self.peers.get_mut(&pid) {
                    peer.known_ids.insert(msg.id.clone());
                }
                self.emit_wire_plaintext(&mut actions, &pid, &plaintext);
            }
        }

        let mut color_actions = self.commit_self_color();
        actions.append(&mut color_actions);

        actions.push(MeshAction::Telemetry {
            event: if msg.msg_type == MSG_TYPE_DELETE {
                "delete_message".to_owned()
            } else if is_edit_log_type(&msg.msg_type) {
                "edit_message".to_owned()
            } else {
                "publish".to_owned()
            },
            detail: format!(
                "Sealed & gossiped {} (L={}) to {} peer(s)",
                msg.id,
                msg.lamport,
                self.peers.len()
            ),
        });

        Ok((msg, actions))
    }

    /// Publishes an authenticated event-sourced edit message (`msg-edit`) targeting `target_id`.
    /// Original messages remain immutable in the raw log while parsed views fold all edits
    /// deterministically with full author/editor attribution (used by both humans and bots).
    pub fn edit_message(
        &mut self,
        target_id: String,
        new_payload: JsonValue,
        ts_ms: u64,
    ) -> Result<(LogMessage, Vec<MeshAction>), String> {
        let clean = target_id.trim().to_owned();
        if clean.is_empty() {
            return Err("edit_message missing non-empty 'targetId'".to_owned());
        }
        if let Some(existing) = self.log.get_by_id(&clean)
            && is_internal_log_type(&existing.msg_type)
        {
            return Err("cannot edit a mutation event record directly".to_owned());
        }
        let mut map = BTreeMap::new();
        map.insert("targetId".to_owned(), JsonValue::string(&clean));
        map.insert("payload".to_owned(), new_payload);
        self.publish_local(MSG_TYPE_EDIT.to_owned(), JsonValue::Object(map), ts_ms, None)
    }

    /// Publishes an authenticated event-sourced deletion message (`msg-delete`) targeting `target_id`.
    /// Original messages remain intact in the raw log while parsed views hide the deleted message
    /// and prune any active synced media state across all peers.
    pub fn delete_message(
        &mut self,
        target_id: String,
        ts_ms: u64,
    ) -> Result<(LogMessage, Vec<MeshAction>), String> {
        let clean = target_id.trim().to_owned();
        if clean.is_empty() {
            return Err("delete_message missing non-empty 'targetId'".to_owned());
        }
        let mut map = BTreeMap::new();
        map.insert("targetId".to_owned(), JsonValue::string(&clean));
        self.publish_local(MSG_TYPE_DELETE.to_owned(), JsonValue::Object(map), ts_ms, None)
    }

    /// Sends an E2EE interactive bot button callback to `to_peer_id` (or `"*"` broadcast),
    /// routing directly or multi-hop through the mesh without polluting the replicated chat log.
    #[allow(clippy::too_many_arguments)]
    pub fn send_bot_action(
        &mut self,
        to_peer_id: String,
        message_id: String,
        action_id: String,
        label: String,
        value: JsonValue,
        ts_ms: u64,
    ) -> Result<(String, Vec<MeshAction>), String> {
        let to_clean = to_peer_id.trim().to_owned();
        if to_clean.is_empty() {
            return Err("send_bot_action missing 'toPeerId'".to_owned());
        }
        if message_id.trim().is_empty() {
            return Err("send_bot_action missing 'messageId'".to_owned());
        }
        if action_id.trim().is_empty() {
            return Err("send_bot_action missing 'actionId'".to_owned());
        }

        let seq = self.next_seq();
        let action_uid = format!("ba-{}-{}-{}", self.peer_id, ts_ms, seq);
        self.record_seen_bot_action(&action_uid);

        let mut actions = Vec::new();
        if to_clean == self.peer_id {
            actions.push(MeshAction::BotActionReceived {
                action_uid: action_uid.clone(),
                from_peer_id: self.peer_id.clone(),
                from_name: self.author_name.clone(),
                message_id,
                action_id,
                label,
                value,
                ts: ts_ms,
            });
            return Ok((action_uid, actions));
        }

        let frame = WireFrame::BotAction {
            action_uid: action_uid.clone(),
            from: self.peer_id.clone(),
            from_name: self.author_name.clone(),
            to: to_clean.clone(),
            message_id,
            action_id,
            label,
            value,
            ts: ts_ms,
            hops: vec![self.peer_id.clone()],
            ttl: self.config.relay_ttl,
        };

        let next_hops: Vec<String> = if to_clean != "*" && self.peers.contains_key(&to_clean) {
            vec![to_clean]
        } else if to_clean != "*"
            && let Some(route) = self.indirect_routes.get(&to_clean)
            && self.peers.contains_key(&route.via_peer_id)
        {
            vec![route.via_peer_id.clone()]
        } else {
            self.peers.keys().cloned().collect()
        };

        for hop in next_hops {
            self.emit_wire(&mut actions, &hop, &frame);
        }

        Ok((action_uid, actions))
    }

    fn record_seen_bot_action(&mut self, action_uid: &str) -> bool {
        if self.seen_bot_actions.contains(action_uid) {
            return false;
        }
        if self.seen_bot_actions.len() >= 512 {
            self.seen_bot_actions.clear();
        }
        self.seen_bot_actions.insert(action_uid.to_owned());
        true
    }

    /// Called when a direct WebRTC DataChannel opens with `peer_id` and its verified X25519 `peer_pub_key`.
    pub fn on_peer_connected(
        &mut self,
        peer_id: String,
        author_name: String,
        peer_pub_key: [u8; KEY_LEN],
        via_auto_mesh: bool,
        introduced_by: Option<String>,
    ) -> Result<Vec<MeshAction>, String> {
        let mut actions = Vec::new();
        if peer_id.trim().is_empty() || peer_id == self.peer_id {
            return Ok(actions);
        }

        let ((tx_key, rx_key), (voice_tx_key, voice_rx_key)) = derive_all_link_keys(
            &self.x25519_secret,
            &peer_pub_key,
            &self.mesh_key,
            &self.peer_id,
            &peer_id,
        )?;
        let safety_code = pair_safety_code(&self.x25519_public, &peer_pub_key, &self.mesh_key);
        let prefix_block = self.csprng.next_bytes_32();
        let mut tx_nonce_prefix = [0u8; 4];
        tx_nonce_prefix.copy_from_slice(&prefix_block[..4]);
        let mut voice_tx_nonce_prefix = [0u8; 4];
        voice_tx_nonce_prefix.copy_from_slice(&prefix_block[4..8]);

        self.known_pub_keys.insert(peer_id.clone(), peer_pub_key);

        let resolved_intro = introduced_by.or_else(|| {
            self.auto_mesh_pending
                .get(&peer_id)
                .map(|p| p.via_peer_id.clone())
        });
        self.auto_mesh_pending.remove(&peer_id);
        self.indirect_routes.remove(&peer_id);

        let other_peers: Vec<PeerSummary> = self
            .peers
            .values()
            .filter(|p| p.peer_id != peer_id)
            .map(|p| PeerSummary {
                peer_id: p.peer_id.clone(),
                author_name: p.author_name.clone(),
                pub_key: p.crypto.pub_key,
                is_bot: p.is_bot,
            })
            .collect();

        let clean_name = if author_name.trim().is_empty() {
            "Peer".to_owned()
        } else {
            author_name
        };

        self.peers.insert(
            peer_id.clone(),
            ConnectedPeer {
                peer_id: peer_id.clone(),
                author_name: clean_name.clone(),
                via_auto_mesh,
                introduced_by: resolved_intro,
                remote_peers: Vec::new(),
                last_pong_ms: 0,
                rtt_ms: None,
                min_rtt_ms: None,
                clock_offset_ms: None,
                in_voice: false,
                voice_muted: false,
                is_bot: false,
                crypto: PeerCryptoState {
                    pub_key: peer_pub_key,
                    tx_key,
                    rx_key,
                    tx_nonce_prefix,
                    tx_seq: 0,
                    replay_window: ReplayWindow::default(),
                    voice_tx_key,
                    voice_rx_key,
                    voice_tx_nonce_prefix,
                    voice_tx_seq: 0,
                    voice_replay_window: ReplayWindow::default(),
                    safety_code: safety_code.clone(),
                },
                known_ids: HashSet::new(),
                pending_inv: None,
                we_sent_inv: true,
            },
        );

        let hello = WireFrame::Hello {
            peer_id: self.peer_id.clone(),
            author_name: self.author_name.clone(),
            room: self.room.clone(),
            pub_key: self.x25519_public,
            lamport: self.log.lamport(),
            log_count: self.log.len(),
            in_voice: self.in_voice,
            voice_muted: self.voice_muted,
            is_bot: self.is_bot,
            peers: other_peers,
        };
        self.emit_wire(&mut actions, &peer_id, &hello);

        self.send_sync_inv_to(&peer_id, &mut actions);
        if self.normalize_peer_colors() {
            actions.push(MeshAction::PeerColors {
                colors: self.peer_colors_map(),
            });
        }
        let color_sync = self.build_color_sync_frame(self.config.gossip_ttl);
        self.emit_wire(&mut actions, &peer_id, &color_sync);

        actions.push(MeshAction::Telemetry {
            event: "peer_connected".to_owned(),
            detail: format!(
                "E2EE X25519 channel open with {} ({}) [safety {}]{}",
                clean_name,
                peer_id,
                safety_code,
                if via_auto_mesh {
                    " [auto-mesh]"
                } else {
                    " [manual]"
                }
            ),
        });

        Ok(actions)
    }

    /// Updates local voice-call membership/mute state and broadcasts an encrypted `VoiceState` frame to all direct peers.
    pub fn set_voice_state(&mut self, in_voice: bool, muted: bool) -> Vec<MeshAction> {
        let effective_muted = if in_voice { muted } else { false };
        if !in_voice || effective_muted || !self.in_voice {
            self.voice_dsp_48k.reset();
        }
        self.in_voice = in_voice;
        self.voice_muted = effective_muted;

        let mut actions = Vec::new();
        let frame = WireFrame::VoiceState {
            in_voice: self.in_voice,
            muted: self.voice_muted,
        };
        let peer_ids: Vec<String> = self.peers.keys().cloned().collect();
        for pid in peer_ids {
            self.emit_wire(&mut actions, &pid, &frame);
        }

        if self.in_voice {
            let mut color_actions = self.commit_self_color();
            actions.append(&mut color_actions);
        }

        let detail = if !self.in_voice {
            "Left E2EE voice chat".to_owned()
        } else if self.voice_muted {
            "In E2EE voice chat (mic muted)".to_owned()
        } else {
            "Joined E2EE voice chat (mic live)".to_owned()
        };
        actions.push(MeshAction::Telemetry {
            event: "voice_state".to_owned(),
            detail,
        });
        actions
    }

    /// Applies a local synchronized media state update (video, GIF, or Watch Together),
    /// increments its deterministic LWW revision counter, and gossips it end-to-end encrypted
    /// to all connected peers in the room. Volume/mute are never synchronized.
    pub fn update_media_sync(
        &mut self,
        mut incoming: MediaSyncState,
        now_ms: u64,
    ) -> (MediaSyncState, Vec<MeshAction>) {
        let prev_rev = self
            .media_states
            .get(&incoming.target_id)
            .map(|s| s.rev)
            .unwrap_or(0);
        incoming.rev = prev_rev.max(incoming.rev).saturating_add(1);
        incoming.actor = self.peer_id.clone();
        incoming.actor_name = self.author_name.clone();
        incoming.anchor_local_ms = now_ms;

        self.media_states
            .insert(incoming.target_id.clone(), incoming.clone());
        self.prune_media_states_capacity();

        let mut actions = Vec::new();
        let peer_ids: Vec<String> = self.peers.keys().cloned().collect();
        if !peer_ids.is_empty() {
            let wire = WireFrame::MediaSync {
                origin: self.peer_id.clone(),
                ttl: self.config.gossip_ttl,
                state: incoming.clone(),
            };
            let plaintext = wire.to_json_string();
            for pid in peer_ids {
                self.emit_wire_plaintext(&mut actions, &pid, &plaintext);
            }
        }
        actions.push(MeshAction::MediaSync {
            state: incoming.clone(),
        });
        (incoming, actions)
    }

    /// Serializes all tracked room media sync states with positions projected to `now_ms`.
    pub fn media_states_json(&self, now_ms: u64) -> String {
        let mut out = String::with_capacity(self.media_states.len().saturating_mul(256) + 2);
        out.push('[');
        for (i, st) in self.media_states.values().enumerate() {
            if i > 0 {
                out.push(',');
            }
            st.write_json(&mut out, now_ms);
        }
        out.push(']');
        out
    }

    /// Returns a read-only reference to all tracked room media sync states.
    pub fn media_states(&self) -> &BTreeMap<String, MediaSyncState> {
        &self.media_states
    }

    /// Encodes a 16 kHz mono signed 16-bit PCM frame with IMA ADPCM once and seals a binary `V1`
    /// ChaCha20-Poly1305 packet for each connected peer currently participating in voice chat.
    /// Returns `(local_rms, vec_of_(peer_id, sealed_v1_packet))`.
    pub fn seal_voice_pcm(&mut self, pcm: &[i16]) -> (u16, Vec<(String, Vec<u8>)>) {
        let rms = compute_rms_i16(pcm);
        if !self.in_voice || self.voice_muted || pcm.is_empty() {
            return (rms, Vec::new());
        }
        let voice_peer_count = self.peers.values().filter(|p| p.in_voice).count();
        if voice_peer_count == 0 {
            return (rms, Vec::new());
        }

        let adpcm = encode_ima_adpcm(pcm);
        let mut packets = Vec::with_capacity(voice_peer_count);
        for (pid, peer) in self.peers.iter_mut() {
            if !peer.in_voice {
                continue;
            }
            let (seq, nonce) = peer.crypto.next_voice_tx_seq_and_nonce();
            let pkt = seal_voice_packet(
                &peer.crypto.voice_tx_key,
                seq,
                nonce,
                &self.peer_id,
                pid,
                &adpcm,
            );
            self.stats.voice_packets_sent = self.stats.voice_packets_sent.saturating_add(1);
            packets.push((pid.clone(), pkt));
        }
        (rms, packets)
    }

    /// Authenticates, anti-replay-checks, decrypts, and IMA-ADPCM-decodes an incoming binary `V1` voice packet.
    /// Returns `Ok((rms, pcm_samples))`. If local node is not currently in voice chat, silently returns empty PCM.
    pub fn open_voice_packet(
        &mut self,
        from_peer: &str,
        packet: &[u8],
    ) -> Result<(u16, Vec<i16>), String> {
        if !self.in_voice {
            return Ok((0, Vec::new()));
        }

        let (seq, nonce, ct) = match parse_voice_packet_header(packet) {
            Ok(parts) => parts,
            Err(err) => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(err);
            }
        };

        let (voice_rx_key, replay_ok) = match self.peers.get(from_peer) {
            Some(peer) => (
                peer.crypto.voice_rx_key,
                peer.crypto.voice_replay_window.would_accept(seq),
            ),
            None => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(format!(
                    "received voice packet from unconnected peer '{from_peer}'"
                ));
            }
        };

        if !replay_ok {
            self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
            return Err(format!(
                "rejected replayed or out-of-window voice sequence {seq} from {from_peer}"
            ));
        }

        let adpcm = match open_voice_packet_ciphertext(
            &voice_rx_key,
            seq,
            &nonce,
            from_peer,
            &self.peer_id,
            ct,
        ) {
            Ok(plain) => plain,
            Err(err) => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(err);
            }
        };

        if let Some(peer) = self.peers.get_mut(from_peer) {
            peer.crypto.voice_replay_window.accept(seq);
        }

        let pcm = decode_ima_adpcm(&adpcm)?;
        let rms = compute_rms_i16(&pcm);
        self.stats.voice_packets_received = self.stats.voice_packets_received.saturating_add(1);
        Ok((rms, pcm))
    }

    /// Runs the full 48 kHz microphone capture DSP chain in safe Rust (DC blocker, RMS meter,
    /// smooth hysteresis noise gate with cosine fade-in/fade-out, soft-knee safety limiter,
    /// and optional alias-free 15-tap FIR decimation + V1 ADPCM E2EE sealing for legacy/bot peers).
    pub fn process_voice_capture_48k(
        &mut self,
        samples_48k: &[f32],
        gate_pct: u8,
        need_v1: bool,
    ) -> (CaptureDspResult, Vec<(String, Vec<u8>)>) {
        let muted = !self.in_voice || self.voice_muted;
        let dsp = self
            .voice_dsp_48k
            .process_frame(samples_48k, gate_pct, muted, need_v1);
        let v1_packets = if need_v1 && !dsp.gated && !dsp.downsampled_16k.is_empty() {
            self.seal_voice_pcm(&dsp.downsampled_16k).1
        } else {
            Vec::new()
        };
        (dsp, v1_packets)
    }

    /// Seals an opaque encoded high-definition voice payload (e.g. 48 kHz Opus from WebCodecs)
    /// into a binary `V2` ChaCha20-Poly1305 packet for each connected peer currently in voice chat.
    pub fn seal_voice_raw(&mut self, raw_payload: &[u8]) -> Vec<(String, Vec<u8>)> {
        if !self.in_voice || self.voice_muted || raw_payload.is_empty() {
            return Vec::new();
        }
        let voice_peer_count = self.peers.values().filter(|p| p.in_voice).count();
        if voice_peer_count == 0 {
            return Vec::new();
        }
        let mut packets = Vec::with_capacity(voice_peer_count);
        for (pid, peer) in self.peers.iter_mut() {
            if !peer.in_voice {
                continue;
            }
            let (seq, nonce) = peer.crypto.next_voice_tx_seq_and_nonce();
            let pkt = seal_voice_v2_packet(
                &peer.crypto.voice_tx_key,
                seq,
                nonce,
                &self.peer_id,
                pid,
                raw_payload,
            );
            self.stats.voice_packets_sent = self.stats.voice_packets_sent.saturating_add(1);
            packets.push((pid.clone(), pkt));
        }
        packets
    }

    /// Authenticates, anti-replay-checks, and decrypts an incoming binary `V2` raw voice packet.
    pub fn open_voice_v2_packet(
        &mut self,
        from_peer: &str,
        packet: &[u8],
    ) -> Result<Vec<u8>, String> {
        if !self.in_voice {
            return Ok(Vec::new());
        }
        let (seq, nonce, ct) = match parse_voice_v2_packet_header(packet) {
            Ok(parts) => parts,
            Err(err) => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(err);
            }
        };
        let (voice_rx_key, replay_ok) = match self.peers.get(from_peer) {
            Some(peer) => (
                peer.crypto.voice_rx_key,
                peer.crypto.voice_replay_window.would_accept(seq),
            ),
            None => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(format!(
                    "received V2 voice packet from unconnected peer '{from_peer}'"
                ));
            }
        };
        if !replay_ok {
            self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
            return Err(format!(
                "rejected replayed or out-of-window V2 voice sequence {seq} from {from_peer}"
            ));
        }
        let plain = match open_voice_v2_packet_ciphertext(
            &voice_rx_key,
            seq,
            &nonce,
            from_peer,
            &self.peer_id,
            ct,
        ) {
            Ok(p) => p,
            Err(err) => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(err);
            }
        };
        if let Some(peer) = self.peers.get_mut(from_peer) {
            peer.crypto.voice_replay_window.accept(seq);
        }
        self.stats.voice_packets_received = self.stats.voice_packets_received.saturating_add(1);
        Ok(plain)
    }

    /// Zero-allocation binary bridge fast-path for `OP_VOICE_ENCODE_SEAL`:
    /// encodes 16 kHz PCM with IMA ADPCM and writes `[rms:u16][peerCount:u16][[pidLen][pid][pktLen][V1 pkt]...]`
    /// directly into `out` reusing `adpcm_scratch`.
    pub fn seal_voice_pcm_wire(
        &mut self,
        pcm: &[i16],
        adpcm_scratch: &mut Vec<u8>,
        out: &mut Vec<u8>,
        max_out: usize,
    ) {
        out.clear();
        let rms = compute_rms_i16(pcm);
        out.extend_from_slice(&rms.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // patched below

        if !self.in_voice || self.voice_muted || pcm.is_empty() {
            return;
        }
        let has_voice_peer = self.peers.values().any(|p| p.in_voice);
        if !has_voice_peer {
            return;
        }

        encode_ima_adpcm_into(pcm, adpcm_scratch);
        let pkt_len = VOICE_PACKET_HEADER_LEN + adpcm_scratch.len() + 16;
        if pkt_len > usize::from(u16::MAX) {
            return;
        }

        let mut fit_count: u16 = 0;
        let self_peer_id = &self.peer_id;
        for (pid, peer) in self.peers.iter_mut() {
            if !peer.in_voice {
                continue;
            }
            let pid_bytes = pid.as_bytes();
            if pid_bytes.len() > usize::from(u16::MAX) {
                continue;
            }
            let needed = out.len().saturating_add(4 + pid_bytes.len() + pkt_len);
            if needed > max_out {
                break;
            }
            let (seq, nonce) = peer.crypto.next_voice_tx_seq_and_nonce();
            out.extend_from_slice(&(pid_bytes.len() as u16).to_le_bytes());
            out.extend_from_slice(pid_bytes);
            out.extend_from_slice(&(pkt_len as u16).to_le_bytes());
            seal_voice_packet_into(
                &peer.crypto.voice_tx_key,
                seq,
                nonce,
                self_peer_id,
                pid,
                adpcm_scratch,
                out,
            );
            self.stats.voice_packets_sent = self.stats.voice_packets_sent.saturating_add(1);
            fit_count = fit_count.saturating_add(1);
        }
        out[2..4].copy_from_slice(&fit_count.to_le_bytes());
    }

    /// Zero-allocation binary bridge fast-path for `OP_VOICE_OPEN_DECODE`:
    /// writes `[rms:u16][sampleCount:u16][i16 LE samples...]` directly into `out`.
    pub fn open_voice_packet_wire(
        &mut self,
        from_peer: &str,
        packet: &[u8],
        adpcm_scratch: &mut Vec<u8>,
        pcm_scratch: &mut Vec<i16>,
        out: &mut Vec<u8>,
        max_out: usize,
    ) -> Result<(), String> {
        out.clear();
        if !self.in_voice {
            out.extend_from_slice(&[0, 0, 0, 0]);
            return Ok(());
        }

        let (seq, nonce, ct) = match parse_voice_packet_header(packet) {
            Ok(parts) => parts,
            Err(err) => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(err);
            }
        };

        let (voice_rx_key, replay_ok) = match self.peers.get(from_peer) {
            Some(peer) => (
                peer.crypto.voice_rx_key,
                peer.crypto.voice_replay_window.would_accept(seq),
            ),
            None => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(format!(
                    "received voice packet from unconnected peer '{from_peer}'"
                ));
            }
        };

        if !replay_ok {
            self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
            return Err(format!(
                "rejected replayed or out-of-window voice sequence {seq} from {from_peer}"
            ));
        }

        adpcm_scratch.clear();
        if let Err(err) = open_voice_packet_ciphertext_into(
            &voice_rx_key,
            seq,
            &nonce,
            from_peer,
            &self.peer_id,
            ct,
            adpcm_scratch,
        ) {
            self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
            return Err(err);
        }

        if let Some(peer) = self.peers.get_mut(from_peer) {
            peer.crypto.voice_replay_window.accept(seq);
        }

        decode_ima_adpcm_into(adpcm_scratch, pcm_scratch)?;
        let rms = compute_rms_i16(pcm_scratch);
        self.stats.voice_packets_received = self.stats.voice_packets_received.saturating_add(1);

        let max_samples = (max_out.saturating_sub(4)) / 2;
        let count = pcm_scratch.len().min(max_samples).min(usize::from(u16::MAX));
        out.reserve(4 + count * 2);
        out.extend_from_slice(&rms.to_le_bytes());
        out.extend_from_slice(&(count as u16).to_le_bytes());
        for &sample in &pcm_scratch[..count] {
            out.extend_from_slice(&sample.to_le_bytes());
        }
        Ok(())
    }

    /// Zero-allocation binary bridge fast-path for `OP_VOICE_SEAL_RAW`:
    /// writes `[peerCount:u16][[pidLen:u16][pid][pktLen:u16][V2 pkt]...]` directly into `out`.
    pub fn seal_voice_raw_wire(&mut self, raw_payload: &[u8], out: &mut Vec<u8>, max_out: usize) {
        out.clear();
        out.extend_from_slice(&0u16.to_le_bytes()); // patched below

        if !self.in_voice || self.voice_muted || raw_payload.is_empty() {
            return;
        }
        let pkt_len = VOICE_PACKET_HEADER_LEN + raw_payload.len() + 16;
        if pkt_len > usize::from(u16::MAX) {
            return;
        }

        let mut fit_count: u16 = 0;
        let self_peer_id = &self.peer_id;
        for (pid, peer) in self.peers.iter_mut() {
            if !peer.in_voice {
                continue;
            }
            let pid_bytes = pid.as_bytes();
            if pid_bytes.len() > usize::from(u16::MAX) {
                continue;
            }
            let needed = out.len().saturating_add(4 + pid_bytes.len() + pkt_len);
            if needed > max_out {
                break;
            }
            let (seq, nonce) = peer.crypto.next_voice_tx_seq_and_nonce();
            out.extend_from_slice(&(pid_bytes.len() as u16).to_le_bytes());
            out.extend_from_slice(pid_bytes);
            out.extend_from_slice(&(pkt_len as u16).to_le_bytes());
            seal_voice_v2_packet_into(
                &peer.crypto.voice_tx_key,
                seq,
                nonce,
                self_peer_id,
                pid,
                raw_payload,
                out,
            );
            self.stats.voice_packets_sent = self.stats.voice_packets_sent.saturating_add(1);
            fit_count = fit_count.saturating_add(1);
        }
        out[0..2].copy_from_slice(&fit_count.to_le_bytes());
    }

    /// Zero-allocation binary bridge fast-path for `OP_VOICE_OPEN_RAW`:
    /// writes decrypted V2 codec payload bytes directly into `out`.
    pub fn open_voice_v2_packet_into(
        &mut self,
        from_peer: &str,
        packet: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), String> {
        out.clear();
        if !self.in_voice {
            return Ok(());
        }
        let (seq, nonce, ct) = match parse_voice_v2_packet_header(packet) {
            Ok(parts) => parts,
            Err(err) => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(err);
            }
        };
        let (voice_rx_key, replay_ok) = match self.peers.get(from_peer) {
            Some(peer) => (
                peer.crypto.voice_rx_key,
                peer.crypto.voice_replay_window.would_accept(seq),
            ),
            None => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(format!(
                    "received V2 voice packet from unconnected peer '{from_peer}'"
                ));
            }
        };
        if !replay_ok {
            self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
            return Err(format!(
                "rejected replayed or out-of-window V2 voice sequence {seq} from {from_peer}"
            ));
        }
        if let Err(err) = open_voice_v2_packet_ciphertext_into(
            &voice_rx_key,
            seq,
            &nonce,
            from_peer,
            &self.peer_id,
            ct,
            out,
        ) {
            self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
            return Err(err);
        }
        if let Some(peer) = self.peers.get_mut(from_peer) {
            peer.crypto.voice_replay_window.accept(seq);
        }
        self.stats.voice_packets_received = self.stats.voice_packets_received.saturating_add(1);
        Ok(())
    }

    /// Zero-allocation binary bridge fast-path for `OP_VOICE_PROCESS_CAPTURE_48K`:
    /// runs the full 48 kHz Rust DSP chain and writes the binary response (12-byte header +
    /// optional processed 48 kHz f32 samples + optional V1 ADPCM E2EE packets) directly into `out`.
    #[allow(clippy::too_many_arguments)]
    pub fn process_voice_capture_48k_wire(
        &mut self,
        samples_48k: &[f32],
        gate_pct: u8,
        need_v1: bool,
        return_48k: bool,
        adpcm_scratch: &mut Vec<u8>,
        out: &mut Vec<u8>,
        max_out: usize,
    ) {
        out.clear();
        let muted = !self.in_voice || self.voice_muted;
        let meta = self
            .voice_dsp_48k
            .process_frame_in_place(samples_48k, gate_pct, muted, need_v1);
        let out_flags: u8 = u8::from(meta.gated) | (u8::from(meta.is_fade_out_tail) << 1);

        let processed = self.voice_dsp_48k.processed_48k();
        let emit_samples = if return_48k && !meta.gated {
            processed
                .len()
                .min((max_out.saturating_sub(12)) / 4)
                .min(usize::from(u16::MAX))
        } else {
            0
        };

        out.reserve(12 + emit_samples * 4);
        out.extend_from_slice(&meta.raw_rms.to_le_bytes());
        out.extend_from_slice(&meta.active_rms.to_le_bytes());
        out.push(out_flags);
        out.push(0);
        out.extend_from_slice(&(emit_samples as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // fit_v1 patched below at [8..10]
        out.extend_from_slice(&[0u8, 0u8]);
        for &s in &processed[..emit_samples] {
            out.extend_from_slice(&s.to_le_bytes());
        }

        if !need_v1 || meta.gated || muted {
            return;
        }
        let downsampled = self.voice_dsp_48k.downsampled_16k();
        if downsampled.is_empty() || !self.peers.values().any(|p| p.in_voice) {
            return;
        }

        encode_ima_adpcm_into(downsampled, adpcm_scratch);
        let pkt_len = VOICE_PACKET_HEADER_LEN + adpcm_scratch.len() + 16;
        if pkt_len > usize::from(u16::MAX) {
            return;
        }

        let mut fit_v1: u16 = 0;
        let self_peer_id = &self.peer_id;
        for (pid, peer) in self.peers.iter_mut() {
            if !peer.in_voice {
                continue;
            }
            let pid_bytes = pid.as_bytes();
            if pid_bytes.len() > usize::from(u16::MAX) {
                continue;
            }
            let needed = out.len().saturating_add(4 + pid_bytes.len() + pkt_len);
            if needed > max_out {
                break;
            }
            let (seq, nonce) = peer.crypto.next_voice_tx_seq_and_nonce();
            out.extend_from_slice(&(pid_bytes.len() as u16).to_le_bytes());
            out.extend_from_slice(pid_bytes);
            out.extend_from_slice(&(pkt_len as u16).to_le_bytes());
            seal_voice_packet_into(
                &peer.crypto.voice_tx_key,
                seq,
                nonce,
                self_peer_id,
                pid,
                adpcm_scratch,
                out,
            );
            self.stats.voice_packets_sent = self.stats.voice_packets_sent.saturating_add(1);
            fit_v1 = fit_v1.saturating_add(1);
        }
        out[8..10].copy_from_slice(&fit_v1.to_le_bytes());
    }

    /// Writes a compact 88-byte binary counter snapshot (`11 × u64 LE`) directly into `out`
    /// so periodic UI stats polling avoids JSON serialization and parsing completely.
    pub fn write_counters_binary(&self, out: &mut Vec<u8>) {
        out.clear();
        out.reserve(88);
        let fields: [u64; 11] = [
            self.stats.voice_packets_sent,
            self.stats.voice_packets_received,
            self.stats.frames_sent,
            self.stats.frames_received,
            self.stats.e2ee_frames_encrypted,
            self.stats.e2ee_frames_decrypted,
            self.stats.e2ee_auth_failures,
            self.stats.gossip_forwards,
            self.stats.gossip_duplicates_dropped,
            self.log.len() as u64,
            self.log.lamport(),
        ];
        for v in fields {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }

    /// Called when a direct WebRTC DataChannel closes or errors.
    pub fn on_peer_disconnected(&mut self, peer_id: &str) -> Vec<MeshAction> {
        let mut actions = Vec::new();
        let removed = self.peers.remove(peer_id);
        self.auto_mesh_pending.remove(peer_id);

        self.indirect_routes
            .retain(|_, route| route.via_peer_id != peer_id);
        self.auto_mesh_pending
            .retain(|_, pending| pending.via_peer_id != peer_id);

        if let Some(peer) = removed {
            actions.push(MeshAction::Telemetry {
                event: "peer_disconnected".to_owned(),
                detail: format!(
                    "Disconnected from {} ({}); {} direct peer(s) remaining, {} encrypted log entries retained",
                    peer.author_name,
                    peer.peer_id,
                    self.peers.len(),
                    self.log.len()
                ),
            });
        }
        actions
    }

    /// Sends fresh encrypted anti-entropy `sync-inv` and `color-sync` frames to all connected peers.
    pub fn request_sync_all(&mut self) -> Vec<MeshAction> {
        self.request_sync_all_at(0)
    }

    /// Full anti-entropy reconciliation across all connected peers: chat log (`sync-inv`),
    /// canonical peer color registry (`color-sync`), and active media sync states (`media-sync`).
    pub fn request_sync_all_at(&mut self, now_ms: u64) -> Vec<MeshAction> {
        let mut actions = Vec::new();
        let peer_ids: Vec<String> = self.peers.keys().cloned().collect();
        if peer_ids.is_empty() {
            return actions;
        }
        let color_sync_json = self
            .build_color_sync_frame(self.config.gossip_ttl)
            .to_json_string();
        let media_snapshots: Vec<String> = if now_ms > 0 && !self.media_states.is_empty() {
            self.media_states
                .values()
                .map(|st| {
                    let mut proj = st.clone();
                    proj.position_ms = st.projected_position_ms(now_ms);
                    proj.anchor_local_ms = now_ms;
                    WireFrame::MediaSync {
                        origin: self.peer_id.clone(),
                        ttl: 0,
                        state: proj,
                    }
                    .to_json_string()
                })
                .collect()
        } else {
            Vec::new()
        };

        for pid in peer_ids {
            if let Some(p) = self.peers.get_mut(&pid) {
                p.we_sent_inv = true;
            }
            self.send_sync_inv_to(&pid, &mut actions);
            self.emit_wire_plaintext(&mut actions, &pid, &color_sync_json);
            for ms_json in &media_snapshots {
                self.emit_wire_plaintext(&mut actions, &pid, ms_json);
            }
        }
        actions
    }

    /// Sends encrypted keepalive `Ping` frames across all direct peers to keep background connections warm.
    pub fn send_keepalive_pings(&mut self, now_ms: u64) -> Vec<MeshAction> {
        let mut actions = Vec::new();
        let peer_ids: Vec<String> = self.peers.keys().cloned().collect();
        let frame = WireFrame::Ping { ts: now_ms };
        for pid in peer_ids {
            self.emit_wire(&mut actions, &pid, &frame);
        }
        actions
    }

    /// Periodic maintenance tick: expire timed-out auto-mesh attempts and trigger anti-entropy.
    pub fn on_anti_entropy_tick(&mut self, now_ms: u64, run_sync: bool) -> Vec<MeshAction> {
        let mut actions = Vec::new();
        let timeout = self.config.auto_mesh_timeout_ms;
        let expired: Vec<String> = self
            .auto_mesh_pending
            .iter()
            .filter(|(_, p)| now_ms.saturating_sub(p.started_at_ms) >= timeout)
            .map(|(k, _)| k.clone())
            .collect();
        for pid in expired {
            self.auto_mesh_pending.remove(&pid);
            actions.push(MeshAction::Telemetry {
                event: "auto_mesh_timeout".to_owned(),
                detail: format!("Cleared stale auto-mesh attempt for {pid}"),
            });
        }

        if self.config.auto_mesh_enabled {
            let candidates: Vec<(String, String, [u8; KEY_LEN], String)> = self
                .indirect_routes
                .values()
                .map(|r| {
                    (
                        r.peer_id.clone(),
                        r.author_name.clone(),
                        r.pub_key,
                        r.via_peer_id.clone(),
                    )
                })
                .collect();
            for (pid, name, pk, via) in candidates {
                if self.peers.contains_key(&via) {
                    self.consider_auto_mesh_peer(&pid, &name, pk, &via, now_ms, &mut actions);
                }
            }
        }

        if run_sync {
            let sync_actions = self.request_sync_all_at(now_ms);
            actions.extend(sync_actions);
        }

        actions
    }

    /// End-to-end encrypts a WebRTC SDP offer/answer or ICE candidate for `to_peer_id`
    /// using `X25519(self_sk, target_pk) || mesh_key` so relay introducers cannot read it.
    pub fn send_relay_signal(
        &mut self,
        to_peer_id: String,
        signal_type: RelaySignalType,
        sdp: Option<String>,
        candidate: Option<JsonValue>,
        preferred_via: Option<String>,
    ) -> Result<Vec<MeshAction>, String> {
        if to_peer_id.trim().is_empty() || to_peer_id == self.peer_id {
            return Err("invalid relay target peer id".to_owned());
        }

        let target_pub_key = self
            .known_pub_keys
            .get(&to_peer_id)
            .copied()
            .or_else(|| self.auto_mesh_pending.get(&to_peer_id).map(|p| p.target_pub_key))
            .or_else(|| self.indirect_routes.get(&to_peer_id).map(|r| r.pub_key))
            .ok_or_else(|| format!("unknown X25519 public key for relay target {to_peer_id}"))?;

        let relay_key = derive_relay_signal_key(
            &self.x25519_secret,
            &target_pub_key,
            &self.mesh_key,
            &self.peer_id,
            &to_peer_id,
        )?;
        let body = RelaySignalBody {
            signal_type,
            sdp,
            candidate,
        };
        let body_json = body.to_json_string();
        let sealed_nonce = self.csprng.next_nonce();
        let aad = format!("p2p-relay-v1|{}->{}", self.peer_id, to_peer_id);
        let sealed_ciphertext = aead_seal(&relay_key, &sealed_nonce, aad.as_bytes(), body_json.as_bytes());
        self.stats.relay_signals_encrypted = self.stats.relay_signals_encrypted.saturating_add(1);

        let mut actions = Vec::new();
        let mut next_hops: Vec<String> = Vec::new();

        if let Some(pref) = preferred_via
            && self.peers.contains_key(&pref)
        {
            next_hops.push(pref);
        }
        if next_hops.is_empty()
            && let Some(pending) = self.auto_mesh_pending.get(&to_peer_id)
            && self.peers.contains_key(&pending.via_peer_id)
        {
            next_hops.push(pending.via_peer_id.clone());
        }
        if next_hops.is_empty()
            && let Some(route) = self.indirect_routes.get(&to_peer_id)
            && self.peers.contains_key(&route.via_peer_id)
        {
            next_hops.push(route.via_peer_id.clone());
        }
        if next_hops.is_empty() {
            if self.peers.contains_key(&to_peer_id) {
                next_hops.push(to_peer_id.clone());
            } else {
                next_hops.extend(self.peers.keys().cloned());
            }
        }

        if next_hops.is_empty() {
            return Err(format!(
                "no connected relay peer available to reach {to_peer_id}"
            ));
        }

        for hop in next_hops {
            let frame = WireFrame::RelaySignal {
                from: self.peer_id.clone(),
                from_name: self.author_name.clone(),
                from_pub_key: self.x25519_public,
                to: to_peer_id.clone(),
                via: hop.clone(),
                hops: vec![self.peer_id.clone()],
                ttl: self.config.relay_ttl,
                sealed_nonce,
                sealed_ciphertext: sealed_ciphertext.clone(),
            };
            self.emit_wire(&mut actions, &hop, &frame);
        }

        Ok(actions)
    }

    /// Authenticates, anti-replay-checks, decrypts, and dispatches an incoming E2EE wire frame.
    pub fn on_wire_message(
        &mut self,
        from_peer: &str,
        raw_json: &str,
        now_ms: u64,
    ) -> Result<Vec<MeshAction>, String> {
        let env = match EncryptedWireEnvelope::parse_json(raw_json) {
            Ok(e) => e,
            Err(err) => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(err);
            }
        };

        let (rx_key, replay_ok) = match self.peers.get(from_peer) {
            Some(peer) => (
                peer.crypto.rx_key,
                peer.crypto.replay_window.would_accept(env.seq),
            ),
            None => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(format!("received wire frame from unconnected peer '{from_peer}'"));
            }
        };

        if !replay_ok {
            self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
            return Err(format!(
                "rejected replayed or out-of-window wire sequence {} from {from_peer}",
                env.seq
            ));
        }

        let decrypted_json = match env.open(&rx_key, from_peer, &self.peer_id) {
            Ok(plain) => plain,
            Err(err) => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(err);
            }
        };

        if let Some(peer) = self.peers.get_mut(from_peer) {
            peer.crypto.replay_window.accept(env.seq);
        }

        let frame = WireFrame::parse_json(&decrypted_json)?;
        self.stats.frames_received = self.stats.frames_received.saturating_add(1);
        self.stats.e2ee_frames_decrypted = self.stats.e2ee_frames_decrypted.saturating_add(1);

        let mut actions = Vec::new();
        match frame {
            WireFrame::Hello {
                peer_id,
                author_name,
                room: _,
                pub_key,
                lamport,
                log_count: _,
                in_voice,
                voice_muted,
                is_bot,
                peers,
            } => {
                self.handle_hello(
                    from_peer,
                    &peer_id,
                    &author_name,
                    pub_key,
                    lamport,
                    in_voice,
                    voice_muted,
                    is_bot,
                    peers,
                    now_ms,
                    &mut actions,
                );
            }
            WireFrame::Msg {
                origin,
                ttl,
                path,
                record,
            } => {
                self.handle_gossip_msg(from_peer, origin, ttl, path, record, &mut actions)?;
            }
            WireFrame::SyncInv {
                from: _,
                inv_id,
                part,
                total_parts,
                lamport,
                ids,
            } => {
                self.handle_sync_inv(
                    from_peer,
                    inv_id,
                    part,
                    total_parts,
                    lamport,
                    ids,
                    &mut actions,
                );
            }
            WireFrame::SyncReq { from: _, ids } => {
                self.handle_sync_req(from_peer, &ids, &mut actions);
            }
            WireFrame::SyncBatch {
                from: _,
                batch_id,
                chunk,
                total_chunks,
                records,
            } => {
                self.handle_sync_batch(
                    from_peer,
                    &batch_id,
                    chunk,
                    total_chunks,
                    records,
                    &mut actions,
                )?;
            }
            WireFrame::MeshIntro {
                via: _,
                peer_id,
                author_name,
                pub_key,
                is_bot: _,
            } => {
                self.consider_auto_mesh_peer(
                    &peer_id,
                    &author_name,
                    pub_key,
                    from_peer,
                    now_ms,
                    &mut actions,
                );
            }
            WireFrame::RelaySignal {
                from,
                from_name,
                from_pub_key,
                to,
                via: _,
                hops,
                ttl,
                sealed_nonce,
                sealed_ciphertext,
            } => {
                self.handle_relay_signal(
                    from_peer,
                    from,
                    from_name,
                    from_pub_key,
                    to,
                    hops,
                    ttl,
                    sealed_nonce,
                    sealed_ciphertext,
                    now_ms,
                    &mut actions,
                )?;
            }
            WireFrame::Ping { ts } => {
                let pong = WireFrame::Pong {
                    ts,
                    peer_ts: Some(now_ms),
                };
                self.emit_wire(&mut actions, from_peer, &pong);
            }
            WireFrame::Pong { ts, peer_ts } => {
                if let Some(peer) = self.peers.get_mut(from_peer) {
                    peer.last_pong_ms = now_ms;
                    if now_ms >= ts && ts > 0 {
                        let rtt = now_ms - ts;
                        peer.rtt_ms = Some(rtt);
                        if let Some(t2) = peer_ts {
                            let mid = ts.saturating_add(rtt / 2);
                            let offset = (i128::from(t2) - i128::from(mid))
                                .clamp(i128::from(i64::MIN), i128::from(i64::MAX))
                                as i64;
                            let accept = match peer.min_rtt_ms {
                                None => true,
                                Some(best) => rtt <= best.saturating_add(15),
                            };
                            if peer.min_rtt_ms.is_none_or(|best| rtt < best) {
                                peer.min_rtt_ms = Some(rtt);
                            }
                            if accept {
                                peer.clock_offset_ms = Some(offset);
                            }
                        }
                    }
                }
            }
            WireFrame::VoiceState { in_voice, muted } => {
                if let Some(peer) = self.peers.get_mut(from_peer) {
                    peer.in_voice = in_voice;
                    peer.voice_muted = if in_voice { muted } else { false };
                    let name = peer.author_name.clone();
                    let status_label = if !in_voice {
                        "left voice chat"
                    } else if muted {
                        "muted mic in voice chat"
                    } else {
                        "joined E2EE voice chat"
                    };
                    actions.push(MeshAction::Telemetry {
                        event: "peer_voice_state".to_owned(),
                        detail: format!("{name} ({from_peer}) {status_label}"),
                    });
                }
            }
            WireFrame::BotAction {
                action_uid,
                from,
                from_name,
                to,
                message_id,
                action_id,
                label,
                value,
                ts,
                hops,
                ttl,
            } => {
                self.handle_bot_action(
                    from_peer,
                    action_uid,
                    from,
                    from_name,
                    to,
                    message_id,
                    action_id,
                    label,
                    value,
                    ts,
                    hops,
                    ttl,
                    &mut actions,
                );
            }
            WireFrame::MediaSync { origin, ttl, state } => {
                self.handle_media_sync(from_peer, origin, ttl, state, now_ms, &mut actions);
            }
            WireFrame::ColorSync {
                origin,
                ttl,
                claims,
            } => {
                self.handle_color_sync(from_peer, origin, ttl, claims, &mut actions);
            }
        }

        Ok(actions)
    }

    fn handle_media_sync(
        &mut self,
        from_peer: &str,
        origin: String,
        ttl: u32,
        mut incoming: MediaSyncState,
        now_ms: u64,
        actions: &mut Vec<MeshAction>,
    ) {
        let one_way_ms = self
            .peers
            .get(from_peer)
            .and_then(|p| p.rtt_ms)
            .map(|r| r / 2)
            .unwrap_or(20)
            .min(MAX_ONE_WAY_COMPENSATION_MS);
        if incoming.active && incoming.playing {
            let delta = ((u128::from(one_way_ms) * u128::from(incoming.rate_milli)) / 1000u128)
                as u64;
            incoming.position_ms = incoming.position_ms.saturating_add(delta);
        }
        incoming.anchor_local_ms = now_ms;

        if let Some(existing) = self.media_states.get(&incoming.target_id)
            && !incoming.is_strictly_newer_than(existing)
        {
            return;
        }

        self.media_states
            .insert(incoming.target_id.clone(), incoming.clone());
        self.prune_media_states_capacity();

        actions.push(MeshAction::MediaSync {
            state: incoming.clone(),
        });

        if ttl > 0 {
            let forward_targets: Vec<String> = self
                .peers
                .keys()
                .filter(|pid| pid.as_str() != from_peer && pid.as_str() != origin.as_str())
                .cloned()
                .collect();
            if !forward_targets.is_empty() {
                let wire = WireFrame::MediaSync {
                    origin,
                    ttl: ttl - 1,
                    state: incoming,
                };
                let plaintext = wire.to_json_string();
                for pid in forward_targets {
                    self.emit_wire_plaintext(actions, &pid, &plaintext);
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_bot_action(
        &mut self,
        from_link: &str,
        action_uid: String,
        from: String,
        from_name: String,
        to: String,
        message_id: String,
        action_id: String,
        label: String,
        value: JsonValue,
        ts: u64,
        hops: Vec<String>,
        ttl: u32,
        actions: &mut Vec<MeshAction>,
    ) {
        if !self.record_seen_bot_action(&action_uid) {
            return;
        }

        if to == self.peer_id || to == "*" {
            actions.push(MeshAction::BotActionReceived {
                action_uid: action_uid.clone(),
                from_peer_id: from.clone(),
                from_name: from_name.clone(),
                message_id: message_id.clone(),
                action_id: action_id.clone(),
                label: label.clone(),
                value: value.clone(),
                ts,
            });
            if to == self.peer_id {
                return;
            }
        }

        if ttl <= 1 || hops.iter().any(|h| h == &self.peer_id) {
            return;
        }

        let mut next_hops = hops;
        if !next_hops.iter().any(|h| h == from_link) {
            next_hops.push(from_link.to_owned());
        }
        next_hops.push(self.peer_id.clone());

        let forwarded = WireFrame::BotAction {
            action_uid,
            from,
            from_name,
            to: to.clone(),
            message_id,
            action_id,
            label,
            value,
            ts,
            hops: next_hops.clone(),
            ttl: ttl - 1,
        };

        if to != "*" && self.peers.contains_key(&to) && to != from_link {
            self.emit_wire(actions, &to, &forwarded);
            return;
        }

        if to != "*"
            && let Some(route) = self.indirect_routes.get(&to)
        {
            let next = route.via_peer_id.clone();
            if self.peers.contains_key(&next)
                && next != from_link
                && !next_hops.iter().any(|h| h == &next)
            {
                self.emit_wire(actions, &next, &forwarded);
                return;
            }
        }

        let targets: Vec<String> = self
            .peers
            .keys()
            .filter(|pid| {
                pid.as_str() != from_link && !next_hops.iter().any(|h| h == pid.as_str())
            })
            .cloned()
            .collect();

        for target in targets {
            self.emit_wire(actions, &target, &forwarded);
        }
    }

    fn send_sync_inv_to(&mut self, peer_id: &str, actions: &mut Vec<MeshAction>) {
        let ids = self.log.ids_ordered();
        let chunks = chunk_inv_ids(&ids, self.config.inv_chunk_ids);
        let total_parts = chunks.len();
        let inv_seq = self.next_seq();
        let inv_id = format!("inv-{}-{}", self.peer_id, inv_seq);

        for (part, chunk_ids) in chunks.into_iter().enumerate() {
            let frame = WireFrame::SyncInv {
                from: self.peer_id.clone(),
                inv_id: inv_id.clone(),
                part,
                total_parts,
                lamport: self.log.lamport(),
                ids: chunk_ids,
            };
            self.stats.sync_inv_sent = self.stats.sync_inv_sent.saturating_add(1);
            self.emit_wire(actions, peer_id, &frame);
        }
    }

    fn send_sync_batches_to(
        &mut self,
        peer_id: &str,
        records: &[SealedLogRecord],
        actions: &mut Vec<MeshAction>,
    ) {
        if records.is_empty() {
            return;
        }
        let chunks = chunk_sealed_records(
            records,
            self.config.batch_max_msgs,
            self.config.batch_max_bytes,
        );
        let total_chunks = chunks.len();
        let batch_seq = self.next_seq();
        let batch_id = format!("batch-{}-{}", self.peer_id, batch_seq);

        for (chunk_idx, batch_recs) in chunks.into_iter().enumerate() {
            if let Some(peer) = self.peers.get_mut(peer_id) {
                for r in &batch_recs {
                    peer.known_ids.insert(r.id.clone());
                }
            }
            let frame = WireFrame::SyncBatch {
                from: self.peer_id.clone(),
                batch_id: batch_id.clone(),
                chunk: chunk_idx,
                total_chunks,
                records: batch_recs,
            };
            self.stats.sync_batches_sent = self.stats.sync_batches_sent.saturating_add(1);
            self.emit_wire(actions, peer_id, &frame);
        }

        actions.push(MeshAction::Telemetry {
            event: "sync_batch_sent".to_owned(),
            detail: format!(
                "Backfilled {} E2EE record(s) in {} chunk(s) to {}",
                records.len(),
                total_chunks,
                peer_id
            ),
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_hello(
        &mut self,
        from_peer: &str,
        announced_id: &str,
        author_name: &str,
        peer_pub_key: [u8; KEY_LEN],
        remote_lamport: u64,
        remote_in_voice: bool,
        remote_voice_muted: bool,
        remote_is_bot: bool,
        remote_peers: Vec<PeerSummary>,
        now_ms: u64,
        actions: &mut Vec<MeshAction>,
    ) {
        self.log.observe_lamport(remote_lamport);
        let effective_peer = if self.peers.contains_key(from_peer) {
            from_peer.to_owned()
        } else {
            announced_id.to_owned()
        };

        let verified_pub_key = self
            .peers
            .get(&effective_peer)
            .map(|p| p.crypto.pub_key)
            .unwrap_or(peer_pub_key);
        self.known_pub_keys
            .insert(effective_peer.clone(), verified_pub_key);

        if let Some(peer) = self.peers.get_mut(&effective_peer) {
            if !author_name.trim().is_empty() {
                peer.author_name = author_name.to_owned();
            }
            peer.in_voice = remote_in_voice;
            peer.voice_muted = if remote_in_voice {
                remote_voice_muted
            } else {
                false
            };
            peer.is_bot = remote_is_bot;
            peer.remote_peers = remote_peers.clone();
        }

        actions.push(MeshAction::Telemetry {
            event: "hello".to_owned(),
            detail: format!(
                "Authenticated E2EE handshake from {} ({}) with {} neighbor(s)",
                author_name,
                effective_peer,
                remote_peers.len()
            ),
        });

        // Reconcile canonical peer colors immediately upon handshake so every peer converges
        // to the exact same duplicate-free color mapping.
        if self.normalize_peer_colors() {
            actions.push(MeshAction::PeerColors {
                colors: self.peer_colors_map(),
            });
        }
        let color_sync = self.build_color_sync_frame(self.config.gossip_ttl);
        self.emit_wire(actions, &effective_peer, &color_sync);

        // Reconcile active room media sync states (videos, GIFs, Watch Together) with the peer
        // immediately upon handshake, projected to `now_ms` so late joiners land in lockstep.
        if !self.media_states.is_empty() {
            let snapshots: Vec<MediaSyncState> = self
                .media_states
                .values()
                .map(|st| {
                    let mut proj = st.clone();
                    proj.position_ms = st.projected_position_ms(now_ms);
                    proj.anchor_local_ms = now_ms;
                    proj
                })
                .collect();
            for st in snapshots {
                let wire = WireFrame::MediaSync {
                    origin: self.peer_id.clone(),
                    ttl: 0,
                    state: st,
                };
                self.emit_wire(actions, &effective_peer, &wire);
            }
        }

        if !self.config.auto_mesh_enabled {
            return;
        }

        let other_peers: Vec<(String, String, [u8; KEY_LEN], bool)> = self
            .peers
            .values()
            .filter(|p| p.peer_id != effective_peer)
            .map(|p| {
                (
                    p.peer_id.clone(),
                    p.author_name.clone(),
                    p.crypto.pub_key,
                    p.is_bot,
                )
            })
            .collect();

        for (other_id, other_name, other_pk, other_is_bot) in other_peers {
            let intro_to_other = WireFrame::MeshIntro {
                via: self.peer_id.clone(),
                peer_id: effective_peer.clone(),
                author_name: author_name.to_owned(),
                pub_key: verified_pub_key,
                is_bot: remote_is_bot,
            };
            self.stats.auto_mesh_intros_sent = self.stats.auto_mesh_intros_sent.saturating_add(1);
            self.emit_wire(actions, &other_id, &intro_to_other);

            let intro_to_new = WireFrame::MeshIntro {
                via: self.peer_id.clone(),
                peer_id: other_id,
                author_name: other_name,
                pub_key: other_pk,
                is_bot: other_is_bot,
            };
            self.stats.auto_mesh_intros_sent = self.stats.auto_mesh_intros_sent.saturating_add(1);
            self.emit_wire(actions, &effective_peer, &intro_to_new);
        }

        for summary in remote_peers {
            self.consider_auto_mesh_peer(
                &summary.peer_id,
                &summary.author_name,
                summary.pub_key,
                &effective_peer,
                now_ms,
                actions,
            );
        }
    }

    fn handle_gossip_msg(
        &mut self,
        from_peer: &str,
        origin: String,
        ttl: u32,
        path: Vec<String>,
        record: SealedLogRecord,
        actions: &mut Vec<MeshAction>,
    ) -> Result<(), String> {
        let msg_id = record.id.clone();
        if let Some(peer) = self.peers.get_mut(from_peer) {
            peer.known_ids.insert(msg_id.clone());
        }

        if self.log.contains_id(&msg_id) {
            self.stats.gossip_duplicates_dropped =
                self.stats.gossip_duplicates_dropped.saturating_add(1);
            return Ok(());
        }

        let inserted = match self.log.insert_sealed(record, &self.log_key) {
            Ok(opt) => opt,
            Err(err) => {
                self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                return Err(err);
            }
        };

        let Some(inserted_msg) = inserted else {
            self.stats.gossip_duplicates_dropped =
                self.stats.gossip_duplicates_dropped.saturating_add(1);
            return Ok(());
        };

        let mut added_ids = Vec::new();
        let mut deleted_ids = Vec::new();
        if inserted_msg.msg_type == MSG_TYPE_DELETE {
            if let Some(target_id) = inserted_msg.payload.get_str("targetId") {
                self.prune_media_states_for_deleted_msg(target_id);
                deleted_ids.push(target_id.to_owned());
            }
        } else {
            added_ids.push(msg_id.clone());
        }

        actions.push(MeshAction::LogUpdated {
            added_ids,
            deleted_ids,
            total_count: self.log.len(),
            lamport: self.log.lamport(),
        });
        if self.normalize_peer_colors() {
            actions.push(MeshAction::PeerColors {
                colors: self.peer_colors_map(),
            });
        }

        if ttl <= 1 || path.iter().any(|p| p == &self.peer_id) {
            return Ok(());
        }

        let mut next_path = path;
        if !next_path.iter().any(|p| p == from_peer) {
            next_path.push(from_peer.to_owned());
        }
        next_path.push(self.peer_id.clone());
        let next_ttl = ttl - 1;

        let targets: Vec<String> = self
            .peers
            .iter()
            .filter(|(pid, peer)| {
                pid.as_str() != from_peer
                    && !next_path.iter().any(|h| h == pid.as_str())
                    && !peer.known_ids.contains(&msg_id)
            })
            .map(|(pid, _)| pid.clone())
            .collect();

        if targets.is_empty() {
            return Ok(());
        }

        let Some(sealed_for_forward) = self.log.get_sealed_by_id(&msg_id).cloned() else {
            return Ok(());
        };

        let forward_frame = WireFrame::Msg {
            origin,
            ttl: next_ttl,
            path: next_path,
            record: sealed_for_forward,
        };
        let plaintext = forward_frame.to_json_string();

        for target in targets {
            if let Some(peer) = self.peers.get_mut(&target) {
                peer.known_ids.insert(msg_id.clone());
            }
            self.stats.gossip_forwards = self.stats.gossip_forwards.saturating_add(1);
            self.emit_wire_plaintext(actions, &target, &plaintext);
        }

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_sync_inv(
        &mut self,
        from_peer: &str,
        inv_id: String,
        part: usize,
        total_parts: usize,
        remote_lamport: u64,
        ids: Vec<String>,
        actions: &mut Vec<MeshAction>,
    ) {
        self.stats.sync_inv_received = self.stats.sync_inv_received.saturating_add(1);
        self.log.observe_lamport(remote_lamport);

        let Some(peer) = self.peers.get_mut(from_peer) else {
            return;
        };

        let is_new_session = match &peer.pending_inv {
            Some(existing) => existing.inv_id != inv_id,
            None => true,
        };
        if is_new_session {
            peer.pending_inv = Some(PendingInventory {
                inv_id: inv_id.clone(),
                total_parts: total_parts.max(1),
                received_parts: HashSet::new(),
                ids: HashSet::new(),
            });
        }

        let mut completed_remote_ids: Option<HashSet<String>> = None;
        let mut should_send_req = false;

        if let Some(pending) = peer.pending_inv.as_mut() {
            pending.received_parts.insert(part);
            for id in ids {
                peer.known_ids.insert(id.clone());
                pending.ids.insert(id);
            }
            if pending.received_parts.len() >= pending.total_parts {
                completed_remote_ids = Some(pending.ids.clone());
                should_send_req = !peer.we_sent_inv;
                peer.we_sent_inv = false;
                peer.pending_inv = None;
            }
        }

        if let Some(remote_ids) = completed_remote_ids {
            let missing_for_remote =
                self.log
                    .missing_sealed_for(&remote_ids, &self.log_key, &mut self.csprng);
            if !missing_for_remote.is_empty() {
                self.send_sync_batches_to(from_peer, &missing_for_remote, actions);
            }

            if should_send_req {
                let mut missing_locally: Vec<String> = remote_ids
                    .into_iter()
                    .filter(|id| !self.log.contains_id(id))
                    .collect();
                missing_locally.sort();
                if !missing_locally.is_empty() {
                    for chunk in missing_locally.chunks(self.config.inv_chunk_ids.max(1)) {
                        let req = WireFrame::SyncReq {
                            from: self.peer_id.clone(),
                            ids: chunk.to_vec(),
                        };
                        self.emit_wire(actions, from_peer, &req);
                    }
                }
            }
        }
    }

    fn handle_sync_req(
        &mut self,
        from_peer: &str,
        requested_ids: &[String],
        actions: &mut Vec<MeshAction>,
    ) {
        if !self.peers.contains_key(from_peer) || requested_ids.is_empty() {
            return;
        }
        let records =
            self.log
                .select_sealed_by_ids(requested_ids, &self.log_key, &mut self.csprng);
        self.send_sync_batches_to(from_peer, &records, actions);
    }

    fn handle_sync_batch(
        &mut self,
        from_peer: &str,
        batch_id: &str,
        chunk: usize,
        total_chunks: usize,
        records: Vec<SealedLogRecord>,
        actions: &mut Vec<MeshAction>,
    ) -> Result<(), String> {
        self.stats.sync_batches_received = self.stats.sync_batches_received.saturating_add(1);

        let mut added_records: Vec<(LogMessage, SealedLogRecord)> = Vec::new();
        for rec in records {
            if let Some(peer) = self.peers.get_mut(from_peer) {
                peer.known_ids.insert(rec.id.clone());
            }
            if self.log.contains_id(&rec.id) {
                continue;
            }
            match self.log.insert_sealed(rec.clone(), &self.log_key) {
                Ok(Some(msg)) => added_records.push((msg, rec)),
                Ok(None) => {}
                Err(err) => {
                    self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                    return Err(err);
                }
            }
        }

        if added_records.is_empty() {
            return Ok(());
        }

        let mut added_ids: Vec<String> = Vec::new();
        let mut deleted_ids: Vec<String> = Vec::new();
        for (m, _) in &added_records {
            if m.msg_type == MSG_TYPE_DELETE {
                if let Some(target_id) = m.payload.get_str("targetId") {
                    self.prune_media_states_for_deleted_msg(target_id);
                    deleted_ids.push(target_id.to_owned());
                }
            } else {
                added_ids.push(m.id.clone());
            }
        }
        actions.push(MeshAction::LogUpdated {
            added_ids,
            deleted_ids,
            total_count: self.log.len(),
            lamport: self.log.lamport(),
        });
        if self.normalize_peer_colors() {
            actions.push(MeshAction::PeerColors {
                colors: self.peer_colors_map(),
            });
        }

        actions.push(MeshAction::Telemetry {
            event: "sync_batch_received".to_owned(),
            detail: format!(
                "Decrypted & applied {} record(s) from {} ({} chunk {}/{})",
                added_records.len(),
                from_peer,
                batch_id,
                chunk + 1,
                total_chunks
            ),
        });

        let other_peers: Vec<String> = self
            .peers
            .keys()
            .filter(|pid| pid.as_str() != from_peer)
            .cloned()
            .collect();

        for target in other_peers {
            let to_forward: Vec<(LogMessage, SealedLogRecord)> = match self.peers.get(&target) {
                Some(peer) => added_records
                    .iter()
                    .filter(|(m, _)| !peer.known_ids.contains(&m.id))
                    .cloned()
                    .collect(),
                None => Vec::new(),
            };
            if to_forward.is_empty() {
                continue;
            }
            if to_forward.len() <= 3 {
                for (m, rec) in to_forward {
                    if let Some(peer) = self.peers.get_mut(&target) {
                        peer.known_ids.insert(m.id.clone());
                    }
                    let gossip = WireFrame::Msg {
                        origin: m.author,
                        ttl: self.config.gossip_ttl.saturating_sub(1).max(1),
                        path: vec![from_peer.to_owned(), self.peer_id.clone()],
                        record: rec,
                    };
                    self.stats.gossip_forwards = self.stats.gossip_forwards.saturating_add(1);
                    self.emit_wire(actions, &target, &gossip);
                }
            } else {
                let sealed_only: Vec<SealedLogRecord> =
                    to_forward.into_iter().map(|(_, r)| r).collect();
                self.send_sync_batches_to(&target, &sealed_only, actions);
            }
        }

        Ok(())
    }

    fn consider_auto_mesh_peer(
        &mut self,
        target_peer_id: &str,
        target_name: &str,
        target_pub_key: [u8; KEY_LEN],
        via_peer_id: &str,
        now_ms: u64,
        actions: &mut Vec<MeshAction>,
    ) {
        if !self.config.auto_mesh_enabled
            || target_peer_id.trim().is_empty()
            || target_peer_id == self.peer_id
            || self.peers.contains_key(target_peer_id)
        {
            return;
        }

        self.known_pub_keys
            .insert(target_peer_id.to_owned(), target_pub_key);

        let clean_name = if target_name.trim().is_empty() {
            "Peer".to_owned()
        } else {
            target_name.to_owned()
        };

        self.indirect_routes.insert(
            target_peer_id.to_owned(),
            IndirectPeerRoute {
                peer_id: target_peer_id.to_owned(),
                author_name: clean_name.clone(),
                pub_key: target_pub_key,
                via_peer_id: via_peer_id.to_owned(),
            },
        );

        if self.auto_mesh_pending.contains_key(target_peer_id) {
            return;
        }
        if self.peers.len().saturating_add(self.auto_mesh_pending.len())
            >= self.config.max_direct_peers
        {
            return;
        }

        if self.peer_id.as_str() < target_peer_id {
            self.auto_mesh_pending.insert(
                target_peer_id.to_owned(),
                PendingAutoMesh {
                    target_peer_id: target_peer_id.to_owned(),
                    target_name: clean_name.clone(),
                    target_pub_key,
                    via_peer_id: via_peer_id.to_owned(),
                    initiated_by_self: true,
                    started_at_ms: now_ms,
                },
            );
            self.stats.auto_mesh_offers_created =
                self.stats.auto_mesh_offers_created.saturating_add(1);
            actions.push(MeshAction::AutoMeshCreateOffer {
                target_peer_id: target_peer_id.to_owned(),
                target_name: clean_name.clone(),
                target_pub_key,
                via_peer_id: via_peer_id.to_owned(),
            });
            actions.push(MeshAction::Telemetry {
                event: "auto_mesh_init".to_owned(),
                detail: format!(
                    "Initiating E2EE relayed auto-mesh with {} ({}) via {}",
                    clean_name, target_peer_id, via_peer_id
                ),
            });
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_relay_signal(
        &mut self,
        from_link: &str,
        from: String,
        from_name: String,
        from_pub_key: [u8; KEY_LEN],
        to: String,
        hops: Vec<String>,
        ttl: u32,
        sealed_nonce: [u8; NONCE_LEN],
        sealed_ciphertext: Vec<u8>,
        now_ms: u64,
        actions: &mut Vec<MeshAction>,
    ) -> Result<(), String> {
        if to == self.peer_id {
            if self.peers.contains_key(&from) {
                return Ok(());
            }
            self.known_pub_keys.insert(from.clone(), from_pub_key);
            self.indirect_routes.insert(
                from.clone(),
                IndirectPeerRoute {
                    peer_id: from.clone(),
                    author_name: from_name.clone(),
                    pub_key: from_pub_key,
                    via_peer_id: from_link.to_owned(),
                },
            );

            // Decrypt the end-to-end sealed SDP/ICE body that was opaque to the relay node(s)
            let relay_key = derive_relay_signal_key(
                &self.x25519_secret,
                &from_pub_key,
                &self.mesh_key,
                &from,
                &self.peer_id,
            )?;
            let aad = format!("p2p-relay-v1|{from}->{}", self.peer_id);
            let plain_bytes = match aead_open(&relay_key, &sealed_nonce, aad.as_bytes(), &sealed_ciphertext) {
                Ok(b) => b,
                Err(err) => {
                    self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
                    return Err(err);
                }
            };
            let plain_str = std::str::from_utf8(&plain_bytes)
                .map_err(|_| "decrypted relay signal is not valid UTF-8".to_owned())?;
            let body = RelaySignalBody::parse_json(plain_str)?;

            match body.signal_type {
                RelaySignalType::Offer => {
                    if let Some(offer_sdp) = body.sdp {
                        self.auto_mesh_pending.insert(
                            from.clone(),
                            PendingAutoMesh {
                                target_peer_id: from.clone(),
                                target_name: from_name.clone(),
                                target_pub_key: from_pub_key,
                                via_peer_id: from_link.to_owned(),
                                initiated_by_self: false,
                                started_at_ms: now_ms,
                            },
                        );
                        actions.push(MeshAction::AutoMeshAcceptOffer {
                            from_peer_id: from.clone(),
                            from_name: from_name.clone(),
                            from_pub_key,
                            via_peer_id: from_link.to_owned(),
                            sdp: offer_sdp,
                        });
                        actions.push(MeshAction::Telemetry {
                            event: "auto_mesh_offer_recv".to_owned(),
                            detail: format!(
                                "Decrypted E2EE relayed offer from {} ({}) via {}",
                                from_name, from, from_link
                            ),
                        });
                    }
                }
                RelaySignalType::Answer => {
                    if let Some(answer_sdp) = body.sdp {
                        actions.push(MeshAction::AutoMeshApplyAnswer {
                            from_peer_id: from.clone(),
                            sdp: answer_sdp,
                        });
                        actions.push(MeshAction::Telemetry {
                            event: "auto_mesh_answer_recv".to_owned(),
                            detail: format!(
                                "Decrypted E2EE relayed answer from {} ({}) via {}",
                                from_name, from, from_link
                            ),
                        });
                    }
                }
                RelaySignalType::Ice => {
                    if let Some(cand) = body.candidate {
                        actions.push(MeshAction::AutoMeshAddIce {
                            from_peer_id: from,
                            candidate: cand,
                        });
                    }
                }
            }
            return Ok(());
        }

        // Intermediate relay: forward opaque AEAD ciphertext without decrypting it!
        if ttl <= 1 || hops.iter().any(|h| h == &self.peer_id) {
            return Ok(());
        }

        let mut next_hops = hops;
        if !next_hops.iter().any(|h| h == from_link) {
            next_hops.push(from_link.to_owned());
        }
        next_hops.push(self.peer_id.clone());

        let forwarded = WireFrame::RelaySignal {
            from,
            from_name,
            from_pub_key,
            to: to.clone(),
            via: self.peer_id.clone(),
            hops: next_hops.clone(),
            ttl: ttl - 1,
            sealed_nonce,
            sealed_ciphertext,
        };

        if self.peers.contains_key(&to) && to != from_link {
            self.stats.relay_signals_forwarded =
                self.stats.relay_signals_forwarded.saturating_add(1);
            self.emit_wire(actions, &to, &forwarded);
            return Ok(());
        }

        if let Some(route) = self.indirect_routes.get(&to) {
            let next = route.via_peer_id.clone();
            if self.peers.contains_key(&next)
                && next != from_link
                && !next_hops.iter().any(|h| h == &next)
            {
                self.stats.relay_signals_forwarded =
                    self.stats.relay_signals_forwarded.saturating_add(1);
                self.emit_wire(actions, &next, &forwarded);
                return Ok(());
            }
        }

        let targets: Vec<String> = self
            .peers
            .keys()
            .filter(|pid| {
                pid.as_str() != from_link && !next_hops.iter().any(|h| h == pid.as_str())
            })
            .cloned()
            .collect();

        for target in targets {
            self.stats.relay_signals_forwarded =
                self.stats.relay_signals_forwarded.saturating_add(1);
            self.emit_wire(actions, &target, &forwarded);
        }

        Ok(())
    }

    /// Serializes full node status, E2EE metadata, voice state, peers, topology, and counters for the UI.
    pub fn status_json(&self) -> String {
        let mut out = String::with_capacity(896);
        out.push_str("{\"peerId\":");
        write_json_string(&mut out, &self.peer_id);
        out.push_str(",\"authorName\":");
        write_json_string(&mut out, &self.author_name);
        out.push_str(",\"room\":");
        write_json_string(&mut out, &self.room);
        let _ = write!(out, ",\"isBot\":{}", self.is_bot);
        out.push_str(",\"e2ee\":{\"cipher\":\"X25519 + ChaCha20-Poly1305\",\"keyFingerprint\":");
        write_json_string(&mut out, &self.key_fp);
        out.push_str(",\"roomTopic\":");
        write_json_string(&mut out, &self.room_topic);
        out.push_str(",\"publicKey\":\"");
        base64url_encode_into(&self.x25519_public, &mut out);
        let _ = write!(
            out,
            "\",\"passphraseMode\":{}}},\"voice\":{{\"inVoice\":{},\"muted\":{}}},\"lamport\":{},\"logCount\":{},\"rawLogCount\":{},\"autoMeshEnabled\":{},\"peers\":[",
            self.passphrase_mode,
            self.in_voice,
            self.voice_muted,
            self.log.lamport(),
            self.log.len(),
            self.log.stored_len(),
            self.config.auto_mesh_enabled
        );
        for (i, peer) in self.peers.values().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"peerId\":");
            write_json_string(&mut out, &peer.peer_id);
            out.push_str(",\"authorName\":");
            write_json_string(&mut out, &peer.author_name);
            out.push_str(",\"safetyCode\":");
            write_json_string(&mut out, &peer.crypto.safety_code);
            out.push_str(",\"publicKey\":\"");
            base64url_encode_into(&peer.crypto.pub_key, &mut out);
            let _ = write!(
                out,
                "\",\"isBot\":{},\"viaAutoMesh\":{},\"introducedBy\":",
                peer.is_bot,
                peer.via_auto_mesh
            );
            match &peer.introduced_by {
                Some(intro) => write_json_string(&mut out, intro),
                None => out.push_str("null"),
            }
            let _ = write!(
                out,
                ",\"knownCount\":{},\"lastPongMs\":{},\"inVoice\":{},\"voiceMuted\":{},\"rttMs\":",
                peer.known_ids.len(),
                peer.last_pong_ms,
                peer.in_voice,
                peer.voice_muted
            );
            match peer.rtt_ms {
                Some(r) => {
                    let _ = write!(out, "{r}");
                }
                None => out.push_str("null"),
            }
            out.push_str(",\"remotePeers\":[");
            for (j, rp) in peer.remote_peers.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                out.push_str("{\"peerId\":");
                write_json_string(&mut out, &rp.peer_id);
                out.push_str(",\"authorName\":");
                write_json_string(&mut out, &rp.author_name);
                out.push('}');
            }
            out.push_str("]}");
        }
        out.push_str("],\"pendingAutoMesh\":[");
        for (i, p) in self.auto_mesh_pending.values().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"peerId\":");
            write_json_string(&mut out, &p.target_peer_id);
            out.push_str(",\"authorName\":");
            write_json_string(&mut out, &p.target_name);
            out.push_str(",\"viaPeerId\":");
            write_json_string(&mut out, &p.via_peer_id);
            let _ = write!(out, ",\"initiatedBySelf\":{}}}", p.initiated_by_self);
        }
        out.push_str("],\"indirectPeers\":[");
        for (i, r) in self.indirect_routes.values().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"peerId\":");
            write_json_string(&mut out, &r.peer_id);
            out.push_str(",\"authorName\":");
            write_json_string(&mut out, &r.author_name);
            out.push_str(",\"viaPeerId\":");
            write_json_string(&mut out, &r.via_peer_id);
            out.push('}');
        }
        out.push_str("],\"peerColors\":{");
        for (i, (pid, claim)) in self.peer_colors.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            write_json_string(&mut out, pid);
            let _ = write!(out, ":{}", claim.color_idx);
        }
        let _ = write!(
            out,
            "}},\"stats\":{{\"framesSent\":{},\"framesReceived\":{},\"e2eeFramesEncrypted\":{},\"e2eeFramesDecrypted\":{},\"e2eeAuthFailures\":{},\"relaySignalsEncrypted\":{},\"gossipForwards\":{},\"gossipDuplicatesDropped\":{},\"syncInvSent\":{},\"syncInvReceived\":{},\"syncBatchesSent\":{},\"syncBatchesReceived\":{},\"autoMeshIntrosSent\":{},\"autoMeshOffersCreated\":{},\"relaySignalsForwarded\":{},\"voicePacketsSent\":{},\"voicePacketsReceived\":{}}}}}",
            self.stats.frames_sent,
            self.stats.frames_received,
            self.stats.e2ee_frames_encrypted,
            self.stats.e2ee_frames_decrypted,
            self.stats.e2ee_auth_failures,
            self.stats.relay_signals_encrypted,
            self.stats.gossip_forwards,
            self.stats.gossip_duplicates_dropped,
            self.stats.sync_inv_sent,
            self.stats.sync_inv_received,
            self.stats.sync_batches_sent,
            self.stats.sync_batches_received,
            self.stats.auto_mesh_intros_sent,
            self.stats.auto_mesh_offers_created,
            self.stats.relay_signals_forwarded,
            self.stats.voice_packets_sent,
            self.stats.voice_packets_received
        );
        out
    }

    /// Reserves message metadata, Lamport timestamp, nonces, and per-peer wire keys/sequences so
    /// heavy ChaCha20-Poly1305 sealing of large GIF/video payloads can run on a dedicated Web Worker
    /// without blocking real-time 48 kHz voice on the main thread.
    pub fn prepare_bulk_publish(
        &mut self,
        msg_type: String,
        ts_ms: u64,
        custom_id: Option<String>,
    ) -> Result<BulkPublishPrep, String> {
        if msg_type.trim().is_empty() || is_internal_log_type(&msg_type) {
            return Err("bulk publish only supports non-internal message types".to_owned());
        }
        let seq = self.next_seq();
        let next_lp = self.log.lamport().saturating_add(1);
        let id = match custom_id {
            Some(cid) if !cid.trim().is_empty() => cid,
            _ => format!("{}-{}-{}-{}", self.peer_id, next_lp, ts_ms, seq),
        };
        if self.log.contains_id(&id) {
            return Err(format!("duplicate local message id '{id}'"));
        }
        self.log.observe_lamport(next_lp);
        let log_nonce = self.csprng.next_nonce();

        let peer_ids: Vec<String> = self.peers.keys().cloned().collect();
        let mut peer_targets = Vec::with_capacity(peer_ids.len());
        for pid in peer_ids {
            if let Some(peer) = self.peers.get_mut(&pid) {
                let (tx_seq, wire_nonce) = peer.crypto.next_tx_seq_and_nonce();
                peer.known_ids.insert(id.clone());
                peer_targets.push(BulkPeerKeyTarget {
                    peer_id: pid,
                    tx_key: peer.crypto.tx_key,
                    tx_seq,
                    wire_nonce,
                });
            }
        }

        Ok(BulkPublishPrep {
            id,
            msg_type,
            lamport: next_lp,
            ts: ts_ms,
            author: self.peer_id.clone(),
            author_name: self.author_name.clone(),
            log_key: self.log_key,
            log_nonce,
            gossip_ttl: self.config.gossip_ttl,
            peer_targets,
        })
    }

    /// Commits a worker-sealed bulk message record into the replicated log with deferred payload
    /// materialization (zero main-thread encryption or multi-MB JSON parsing).
    pub fn commit_bulk_publish(
        &mut self,
        meta_msg: LogMessage,
        sealed: SealedLogRecord,
        sent_peer_count: usize,
    ) -> Result<Vec<MeshAction>, String> {
        let msg_id = meta_msg.id.clone();
        let lamport = meta_msg.lamport;
        self.log.insert_deferred_sealed(meta_msg, sealed)?;
        self.stats.frames_sent = self.stats.frames_sent.saturating_add(sent_peer_count as u64);
        self.stats.e2ee_frames_encrypted = self
            .stats
            .e2ee_frames_encrypted
            .saturating_add(sent_peer_count as u64);
        let mut actions = self.commit_self_color();
        actions.push(MeshAction::Telemetry {
            event: "publish".to_owned(),
            detail: format!(
                "Sealed & gossiped {} (L={}) to {} peer(s) [off-thread bulk worker]",
                msg_id, lamport, sent_peer_count
            ),
        });
        Ok(actions)
    }

    /// Validates peer connectivity and anti-replay window before dispatching a large encrypted
    /// bulk wire frame to the off-thread crypto worker for ChaCha20-Poly1305 decryption.
    pub fn prepare_bulk_rx(
        &self,
        from_peer: &str,
        seq: u64,
    ) -> Result<([u8; KEY_LEN], [u8; KEY_LEN]), String> {
        let Some(peer) = self.peers.get(from_peer) else {
            return Err(format!("received wire frame from unconnected peer '{from_peer}'"));
        };
        if !peer.crypto.replay_window.would_accept(seq) {
            return Err(format!(
                "rejected replayed or out-of-window wire sequence {seq} from {from_peer}"
            ));
        }
        Ok((peer.crypto.rx_key, self.log_key))
    }

    /// Commits an already-authenticated bulk `WireFrame::Msg` opened by the off-thread crypto worker,
    /// advancing anti-replay state, storing the sealed record for future sync, and returning any
    /// multi-hop gossip forward targets so forwarding also runs off the main thread.
    #[allow(clippy::too_many_arguments)]
    pub fn commit_bulk_rx(
        &mut self,
        from_peer: &str,
        seq: u64,
        ttl: u32,
        path: Vec<String>,
        meta_msg: LogMessage,
        sealed: SealedLogRecord,
    ) -> Result<(bool, Vec<BulkPeerKeyTarget>, Vec<String>, u32), String> {
        let msg_id = meta_msg.id.clone();
        let Some(peer) = self.peers.get_mut(from_peer) else {
            self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
            return Err(format!("received wire frame from unconnected peer '{from_peer}'"));
        };
        if !peer.crypto.replay_window.would_accept(seq) {
            self.stats.e2ee_auth_failures = self.stats.e2ee_auth_failures.saturating_add(1);
            return Err(format!(
                "rejected replayed or out-of-window wire sequence {seq} from {from_peer}"
            ));
        }
        peer.crypto.replay_window.accept(seq);
        peer.known_ids.insert(msg_id.clone());
        self.stats.frames_received = self.stats.frames_received.saturating_add(1);
        self.stats.e2ee_frames_decrypted = self.stats.e2ee_frames_decrypted.saturating_add(1);

        if self.log.contains_id(&msg_id) {
            self.stats.gossip_duplicates_dropped =
                self.stats.gossip_duplicates_dropped.saturating_add(1);
            return Ok((false, Vec::new(), Vec::new(), 0));
        }

        let inserted = self.log.insert_deferred_sealed(meta_msg, sealed)?;
        if !inserted {
            self.stats.gossip_duplicates_dropped =
                self.stats.gossip_duplicates_dropped.saturating_add(1);
            return Ok((false, Vec::new(), Vec::new(), 0));
        }
        let _ = self.normalize_peer_colors();

        if ttl <= 1 || path.iter().any(|p| p == &self.peer_id) {
            return Ok((true, Vec::new(), Vec::new(), 0));
        }

        let mut next_path = path;
        if !next_path.iter().any(|p| p == from_peer) {
            next_path.push(from_peer.to_owned());
        }
        next_path.push(self.peer_id.clone());
        let next_ttl = ttl - 1;

        let target_ids: Vec<String> = self
            .peers
            .iter()
            .filter(|(pid, peer)| {
                pid.as_str() != from_peer
                    && !next_path.iter().any(|h| h == pid.as_str())
                    && !peer.known_ids.contains(&msg_id)
            })
            .map(|(pid, _)| pid.clone())
            .collect();

        let mut forward_targets = Vec::with_capacity(target_ids.len());
        for target in target_ids {
            if let Some(peer) = self.peers.get_mut(&target) {
                let (tx_seq, wire_nonce) = peer.crypto.next_tx_seq_and_nonce();
                peer.known_ids.insert(msg_id.clone());
                self.stats.gossip_forwards = self.stats.gossip_forwards.saturating_add(1);
                self.stats.frames_sent = self.stats.frames_sent.saturating_add(1);
                self.stats.e2ee_frames_encrypted =
                    self.stats.e2ee_frames_encrypted.saturating_add(1);
                forward_targets.push(BulkPeerKeyTarget {
                    peer_id: target,
                    tx_key: peer.crypto.tx_key,
                    tx_seq,
                    wire_nonce,
                });
            }
        }

        Ok((true, forward_targets, next_path, next_ttl))
    }

    /// Serializes the parsed visible replicated log (with edits folded & deleted targets hidden).
    pub fn log_json(&self) -> String {
        let mut out = String::with_capacity(self.log.len().saturating_mul(160) + 8);
        self.log
            .write_messages_json_array_with_key(Some(&self.log_key), &mut out);
        out
    }

    /// Serializes ALL raw append-only event records (originals, `msg-edit`, `bot-update`, `msg-delete`)
    /// in strict `(lamport, ts, id)` order.
    pub fn raw_log_json(&self, compact_media: bool) -> String {
        let mut out = String::with_capacity(self.log.stored_len().saturating_mul(160) + 8);
        self.log.write_raw_messages_json_array_with_key(
            Some(&self.log_key),
            compact_media,
            &mut out,
        );
        out
    }

    /// Serializes only newly added or updated log entries relative to `known_versions`.
    pub fn log_delta_json(&self, known_versions: &std::collections::HashMap<&str, u64>) -> String {
        let mut out = String::with_capacity(self.log.len().saturating_mul(32) + 64);
        self.log
            .write_messages_delta_json_with_key(known_versions, Some(&self.log_key), &mut out);
        out
    }

    /// Serializes incremental log delta using exact revision strings (`"<lamport>:<count>:<lastEditId>"`)
    /// when supplied, falling back to numeric `known_versions`.
    pub fn log_delta_json_with_revs(
        &self,
        known_versions: &std::collections::HashMap<&str, u64>,
        known_revs: Option<&std::collections::HashMap<&str, &str>>,
    ) -> String {
        let mut out = String::with_capacity(self.log.len().saturating_mul(32) + 64);
        self.log.write_messages_delta_json_with_revs(
            known_versions,
            known_revs,
            Some(&self.log_key),
            &mut out,
        );
        out
    }
}

/// Directional ChaCha20-Poly1305 key & nonce bundle for sealing one peer's wire envelope off-thread.
#[derive(Debug, Clone)]
pub struct BulkPeerKeyTarget {
    pub peer_id: String,
    pub tx_key: [u8; KEY_LEN],
    pub tx_seq: u64,
    pub wire_nonce: [u8; NONCE_LEN],
}

/// Metadata & key material returned by `prepare_bulk_publish` for off-thread worker sealing.
#[derive(Debug, Clone)]
pub struct BulkPublishPrep {
    pub id: String,
    pub msg_type: String,
    pub lamport: u64,
    pub ts: u64,
    pub author: String,
    pub author_name: String,
    pub log_key: [u8; KEY_LEN],
    pub log_nonce: [u8; NONCE_LEN],
    pub gossip_ttl: u32,
    pub peer_targets: Vec<BulkPeerKeyTarget>,
}

#[cfg(test)]
mod replay_window_tests {
    use super::ReplayWindow;

    #[test]
    fn accepts_out_of_order_bulk_frame_up_to_255_behind_and_rejects_replays() {
        let mut rw = ReplayWindow::default();
        assert!(!rw.would_accept(0));
        assert!(rw.would_accept(1));
        rw.accept(1);
        assert!(!rw.would_accept(1));

        // Simulate 200 fast chat/keepalive frames arriving on p2p-mesh while seq=2 (GIF) is in flight on p2p-bulk
        for seq in 3..=202 {
            assert!(rw.would_accept(seq));
            rw.accept(seq);
        }
        // seq=2 is 200 slots behind max_seq=202 (< 256): MUST be accepted once, then rejected on replay!
        assert!(rw.would_accept(2));
        rw.accept(2);
        assert!(!rw.would_accept(2));

        // Advance past 256 slots beyond seq=5 -> seq=5 now rejected as too old
        rw.accept(262);
        assert!(!rw.would_accept(5));
        assert!(rw.would_accept(250));
        rw.accept(250);
        assert!(!rw.would_accept(250));
    }
}
