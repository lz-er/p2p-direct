use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;

use crate::json::{JsonValue, write_json_string, write_json_value};
use crate::log::{LogMessage, ReplicatedLog};
use crate::protocol::{
    DEFAULT_BATCH_MAX_BYTES, DEFAULT_BATCH_MAX_MSGS, DEFAULT_GOSSIP_TTL, DEFAULT_INV_CHUNK_IDS,
    DEFAULT_RELAY_TTL, PeerSummary, RelaySignalType, WireFrame, chunk_inv_ids,
    chunk_sync_messages,
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
    pub gossip_forwards: u64,
    pub gossip_duplicates_dropped: u64,
    pub sync_inv_sent: u64,
    pub sync_inv_received: u64,
    pub sync_batches_sent: u64,
    pub sync_batches_received: u64,
    pub auto_mesh_intros_sent: u64,
    pub auto_mesh_offers_created: u64,
    pub relay_signals_forwarded: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MeshAction {
    SendWire {
        peer_id: String,
        frame: String,
    },
    LogUpdated {
        added_ids: Vec<String>,
        total_count: usize,
        lamport: u64,
    },
    AutoMeshCreateOffer {
        target_peer_id: String,
        target_name: String,
        via_peer_id: String,
    },
    AutoMeshAcceptOffer {
        from_peer_id: String,
        from_name: String,
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
                let _ = write!(out, "],\"totalCount\":{total_count},\"lamport\":{lamport}}}");
            }
            Self::AutoMeshCreateOffer {
                target_peer_id,
                target_name,
                via_peer_id,
            } => {
                out.push_str("{\"action\":\"auto_mesh_create_offer\",\"targetPeerId\":");
                write_json_string(out, target_peer_id);
                out.push_str(",\"targetName\":");
                write_json_string(out, target_name);
                out.push_str(",\"viaPeerId\":");
                write_json_string(out, via_peer_id);
                out.push('}');
            }
            Self::AutoMeshAcceptOffer {
                from_peer_id,
                from_name,
                via_peer_id,
                sdp,
            } => {
                out.push_str("{\"action\":\"auto_mesh_accept_offer\",\"fromPeerId\":");
                write_json_string(out, from_peer_id);
                out.push_str(",\"fromName\":");
                write_json_string(out, from_name);
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
    let mut out = String::with_capacity(actions.len().saturating_mul(128) + 8);
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
    known_ids: HashSet<String>,
    pending_inv: Option<PendingInventory>,
    we_sent_inv: bool,
}

#[derive(Debug, Clone)]
pub struct IndirectPeerRoute {
    pub peer_id: String,
    pub author_name: String,
    pub via_peer_id: String,
}

#[derive(Debug, Clone)]
pub struct PendingAutoMesh {
    pub target_peer_id: String,
    pub target_name: String,
    pub via_peer_id: String,
    pub initiated_by_self: bool,
    pub started_at_ms: u64,
}

pub struct MeshNode {
    peer_id: String,
    author_name: String,
    room: String,
    config: MeshConfig,
    log: ReplicatedLog,
    peers: BTreeMap<String, ConnectedPeer>,
    indirect_routes: BTreeMap<String, IndirectPeerRoute>,
    auto_mesh_pending: BTreeMap<String, PendingAutoMesh>,
    stats: MeshStats,
    seq: u64,
}

impl MeshNode {
    pub fn new(peer_id: String, author_name: String, room: String, config: MeshConfig) -> Self {
        Self {
            peer_id,
            author_name,
            room,
            config,
            log: ReplicatedLog::new(),
            peers: BTreeMap::new(),
            indirect_routes: BTreeMap::new(),
            auto_mesh_pending: BTreeMap::new(),
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

    pub fn set_author_name(&mut self, name: String) {
        if !name.trim().is_empty() {
            self.author_name = name;
        }
    }

    pub fn set_room(&mut self, room: String) {
        if !room.trim().is_empty() {
            self.room = room;
        }
    }

    pub fn set_auto_mesh_enabled(&mut self, enabled: bool) {
        self.config.auto_mesh_enabled = enabled;
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

    fn next_seq(&mut self) -> u64 {
        self.seq = self.seq.saturating_add(1);
        self.seq
    }

    fn emit_wire(&mut self, actions: &mut Vec<MeshAction>, peer_id: &str, frame: &WireFrame) {
        self.stats.frames_sent = self.stats.frames_sent.saturating_add(1);
        actions.push(MeshAction::SendWire {
            peer_id: peer_id.to_owned(),
            frame: frame.to_json_string(),
        });
    }

    /// Loads persisted replicated log state from a snapshot JSON value.
    pub fn import_persistence(&mut self, val: &JsonValue) -> Result<usize, String> {
        self.log.import_snapshot_value(val)
    }

    /// Exports persisted replicated log state as canonical JSON.
    pub fn export_persistence(&self) -> String {
        self.log.export_snapshot_json()
    }

    /// Clears only this node's local replicated log so re-syncing pulls history from surviving peers.
    pub fn reset_local_log(&mut self) {
        self.log = ReplicatedLog::new();
        for peer in self.peers.values_mut() {
            peer.known_ids.clear();
            peer.pending_inv = None;
            peer.we_sent_inv = false;
        }
    }

    /// Appends a new local structured JSON message and gossips it to all connected peers.
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

        let msg = self.log.append_local(
            id,
            msg_type,
            ts_ms,
            self.peer_id.clone(),
            self.author_name.clone(),
            payload,
        )?;

        let mut actions = Vec::new();
        actions.push(MeshAction::LogUpdated {
            added_ids: vec![msg.id.clone()],
            total_count: self.log.len(),
            lamport: self.log.lamport(),
        });

        let wire = WireFrame::Msg {
            origin: self.peer_id.clone(),
            ttl: self.config.gossip_ttl,
            path: vec![self.peer_id.clone()],
            message: msg.clone(),
        };

        let peer_ids: Vec<String> = self.peers.keys().cloned().collect();
        for pid in peer_ids {
            if let Some(peer) = self.peers.get_mut(&pid) {
                peer.known_ids.insert(msg.id.clone());
            }
            self.emit_wire(&mut actions, &pid, &wire);
        }

        actions.push(MeshAction::Telemetry {
            event: "publish".to_owned(),
            detail: format!("Published {} (L={}) to {} peers", msg.id, msg.lamport, self.peers.len()),
        });

        Ok((msg, actions))
    }

    /// Called when a direct WebRTC DataChannel opens with `peer_id`.
    pub fn on_peer_connected(
        &mut self,
        peer_id: String,
        author_name: String,
        via_auto_mesh: bool,
        introduced_by: Option<String>,
    ) -> Vec<MeshAction> {
        let mut actions = Vec::new();
        if peer_id.trim().is_empty() || peer_id == self.peer_id {
            return actions;
        }

        let resolved_intro = introduced_by.or_else(|| {
            self.auto_mesh_pending
                .get(&peer_id)
                .map(|p| p.via_peer_id.clone())
        });
        self.auto_mesh_pending.remove(&peer_id);
        self.indirect_routes.remove(&peer_id);

        // Snapshot other connected peers to advertise in Hello
        let other_peers: Vec<PeerSummary> = self
            .peers
            .values()
            .filter(|p| p.peer_id != peer_id)
            .map(|p| PeerSummary {
                peer_id: p.peer_id.clone(),
                author_name: p.author_name.clone(),
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
                known_ids: HashSet::new(),
                pending_inv: None,
                we_sent_inv: true,
            },
        );

        let hello = WireFrame::Hello {
            peer_id: self.peer_id.clone(),
            author_name: self.author_name.clone(),
            room: self.room.clone(),
            lamport: self.log.lamport(),
            log_count: self.log.len(),
            peers: other_peers,
        };
        self.emit_wire(&mut actions, &peer_id, &hello);

        self.send_sync_inv_to(&peer_id, &mut actions);

        actions.push(MeshAction::Telemetry {
            event: "peer_connected".to_owned(),
            detail: format!(
                "Direct channel open with {} ({}){}",
                clean_name,
                peer_id,
                if via_auto_mesh { " [auto-mesh]" } else { " [manual]" }
            ),
        });

        actions
    }

    /// Called when a direct WebRTC DataChannel closes or errors.
    pub fn on_peer_disconnected(&mut self, peer_id: &str) -> Vec<MeshAction> {
        let mut actions = Vec::new();
        let removed = self.peers.remove(peer_id);
        self.auto_mesh_pending.remove(peer_id);

        // Remove indirect routes that depended on the departed peer
        self.indirect_routes
            .retain(|_, route| route.via_peer_id != peer_id);

        // Cancel pending auto-mesh handshakes whose relay departed
        self.auto_mesh_pending
            .retain(|_, pending| pending.via_peer_id != peer_id);

        if let Some(peer) = removed {
            actions.push(MeshAction::Telemetry {
                event: "peer_disconnected".to_owned(),
                detail: format!(
                    "Disconnected from {} ({}); {} direct peers remaining, {} log entries retained",
                    peer.author_name,
                    peer.peer_id,
                    self.peers.len(),
                    self.log.len()
                ),
            });
        }
        actions
    }

    /// Sends fresh anti-entropy `sync-inv` frames to all connected peers.
    pub fn request_sync_all(&mut self) -> Vec<MeshAction> {
        let mut actions = Vec::new();
        let peer_ids: Vec<String> = self.peers.keys().cloned().collect();
        for pid in peer_ids {
            if let Some(p) = self.peers.get_mut(&pid) {
                p.we_sent_inv = true;
            }
            self.send_sync_inv_to(&pid, &mut actions);
        }
        actions
    }

    /// Periodic maintenance tick: expire timed-out auto-mesh negotiations and trigger anti-entropy.
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

        // Re-evaluate known indirect peers in case a previous attempt timed out
        if self.config.auto_mesh_enabled {
            let candidates: Vec<(String, String, String)> = self
                .indirect_routes
                .values()
                .map(|r| (r.peer_id.clone(), r.author_name.clone(), r.via_peer_id.clone()))
                .collect();
            for (pid, name, via) in candidates {
                if self.peers.contains_key(&via) {
                    self.consider_auto_mesh_peer(&pid, &name, &via, now_ms, &mut actions);
                }
            }
        }

        if run_sync {
            let sync_actions = self.request_sync_all();
            actions.extend(sync_actions);
        }

        actions
    }

    /// Sends a local WebRTC SDP offer/answer or ICE candidate to a remote target via relayed mesh.
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
                to: to_peer_id.clone(),
                via: hop.clone(),
                hops: vec![self.peer_id.clone()],
                ttl: self.config.relay_ttl,
                signal_type,
                sdp: sdp.clone(),
                candidate: candidate.clone(),
            };
            self.emit_wire(&mut actions, &hop, &frame);
        }

        Ok(actions)
    }

    /// Processes an incoming wire JSON frame received over the direct DataChannel from `from_peer`.
    pub fn on_wire_message(
        &mut self,
        from_peer: &str,
        raw_json: &str,
        now_ms: u64,
    ) -> Result<Vec<MeshAction>, String> {
        let frame = WireFrame::parse_json(raw_json)?;
        self.stats.frames_received = self.stats.frames_received.saturating_add(1);

        let mut actions = Vec::new();
        match frame {
            WireFrame::Hello {
                peer_id,
                author_name,
                room: _,
                lamport,
                log_count: _,
                peers,
            } => {
                self.handle_hello(from_peer, &peer_id, &author_name, lamport, peers, now_ms, &mut actions);
            }
            WireFrame::Msg {
                origin,
                ttl,
                path,
                message,
            } => {
                self.handle_gossip_msg(from_peer, origin, ttl, path, message, &mut actions)?;
            }
            WireFrame::SyncInv {
                from: _,
                inv_id,
                part,
                total_parts,
                lamport,
                ids,
            } => {
                self.handle_sync_inv(from_peer, inv_id, part, total_parts, lamport, ids, &mut actions);
            }
            WireFrame::SyncReq { from: _, ids } => {
                self.handle_sync_req(from_peer, &ids, &mut actions);
            }
            WireFrame::SyncBatch {
                from: _,
                batch_id,
                chunk,
                total_chunks,
                messages,
            } => {
                self.handle_sync_batch(
                    from_peer,
                    &batch_id,
                    chunk,
                    total_chunks,
                    messages,
                    &mut actions,
                )?;
            }
            WireFrame::MeshIntro {
                via: _,
                peer_id,
                author_name,
            } => {
                self.consider_auto_mesh_peer(&peer_id, &author_name, from_peer, now_ms, &mut actions);
            }
            WireFrame::RelaySignal {
                from,
                from_name,
                to,
                via: _,
                hops,
                ttl,
                signal_type,
                sdp,
                candidate,
            } => {
                self.handle_relay_signal(
                    from_peer,
                    from,
                    from_name,
                    to,
                    hops,
                    ttl,
                    signal_type,
                    sdp,
                    candidate,
                    now_ms,
                    &mut actions,
                );
            }
        }

        Ok(actions)
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
        messages: &[LogMessage],
        actions: &mut Vec<MeshAction>,
    ) {
        if messages.is_empty() {
            return;
        }
        let chunks = chunk_sync_messages(
            messages,
            self.config.batch_max_msgs,
            self.config.batch_max_bytes,
        );
        let total_chunks = chunks.len();
        let batch_seq = self.next_seq();
        let batch_id = format!("batch-{}-{}", self.peer_id, batch_seq);

        for (chunk_idx, batch_msgs) in chunks.into_iter().enumerate() {
            if let Some(peer) = self.peers.get_mut(peer_id) {
                for m in &batch_msgs {
                    peer.known_ids.insert(m.id.clone());
                }
            }
            let frame = WireFrame::SyncBatch {
                from: self.peer_id.clone(),
                batch_id: batch_id.clone(),
                chunk: chunk_idx,
                total_chunks,
                messages: batch_msgs,
            };
            self.stats.sync_batches_sent = self.stats.sync_batches_sent.saturating_add(1);
            self.emit_wire(actions, peer_id, &frame);
        }

        actions.push(MeshAction::Telemetry {
            event: "sync_batch_sent".to_owned(),
            detail: format!(
                "Backfilled {} messages in {} chunk(s) to {}",
                messages.len(),
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
        remote_lamport: u64,
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

        if let Some(peer) = self.peers.get_mut(&effective_peer) {
            if !author_name.trim().is_empty() {
                peer.author_name = author_name.to_owned();
            }
            peer.remote_peers = remote_peers.clone();
        }

        actions.push(MeshAction::Telemetry {
            event: "hello".to_owned(),
            detail: format!(
                "Handshake from {} ({}) with {} known neighbor(s)",
                author_name,
                effective_peer,
                remote_peers.len()
            ),
        });

        if !self.config.auto_mesh_enabled {
            return;
        }

        // Introduce the newly connected peer to all our other direct peers (and vice versa)
        let other_peers: Vec<(String, String)> = self
            .peers
            .values()
            .filter(|p| p.peer_id != effective_peer)
            .map(|p| (p.peer_id.clone(), p.author_name.clone()))
            .collect();

        for (other_id, other_name) in other_peers {
            let intro_to_other = WireFrame::MeshIntro {
                via: self.peer_id.clone(),
                peer_id: effective_peer.clone(),
                author_name: author_name.to_owned(),
            };
            self.stats.auto_mesh_intros_sent = self.stats.auto_mesh_intros_sent.saturating_add(1);
            self.emit_wire(actions, &other_id, &intro_to_other);

            let intro_to_new = WireFrame::MeshIntro {
                via: self.peer_id.clone(),
                peer_id: other_id,
                author_name: other_name,
            };
            self.stats.auto_mesh_intros_sent = self.stats.auto_mesh_intros_sent.saturating_add(1);
            self.emit_wire(actions, &effective_peer, &intro_to_new);
        }

        // Also consider connecting to any peers that `effective_peer` advertised in Hello
        for summary in remote_peers {
            self.consider_auto_mesh_peer(
                &summary.peer_id,
                &summary.author_name,
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
        message: LogMessage,
        actions: &mut Vec<MeshAction>,
    ) -> Result<(), String> {
        if let Some(peer) = self.peers.get_mut(from_peer) {
            peer.known_ids.insert(message.id.clone());
        }

        let inserted = self.log.insert(message.clone())?;
        if !inserted {
            self.stats.gossip_duplicates_dropped =
                self.stats.gossip_duplicates_dropped.saturating_add(1);
            return Ok(());
        }

        actions.push(MeshAction::LogUpdated {
            added_ids: vec![message.id.clone()],
            total_count: self.log.len(),
            lamport: self.log.lamport(),
        });

        // Strict loop-free multi-hop forwarding
        if ttl <= 1 || path.iter().any(|p| p == &self.peer_id) {
            return Ok(());
        }

        let mut next_path = path;
        if !next_path.iter().any(|p| p == from_peer) {
            next_path.push(from_peer.to_owned());
        }
        next_path.push(self.peer_id.clone());
        let next_ttl = ttl - 1;

        let forward_frame = WireFrame::Msg {
            origin,
            ttl: next_ttl,
            path: next_path.clone(),
            message: message.clone(),
        };

        let targets: Vec<String> = self
            .peers
            .iter()
            .filter(|(pid, peer)| {
                pid.as_str() != from_peer
                    && !next_path.iter().any(|h| h == pid.as_str())
                    && !peer.known_ids.contains(&message.id)
            })
            .map(|(pid, _)| pid.clone())
            .collect();

        for target in targets {
            if let Some(peer) = self.peers.get_mut(&target) {
                peer.known_ids.insert(message.id.clone());
            }
            self.stats.gossip_forwards = self.stats.gossip_forwards.saturating_add(1);
            self.emit_wire(actions, &target, &forward_frame);
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
            // 1. Push all local messages (old & new) that `from_peer` is missing, in chunked sync-batch frames
            let missing_for_remote = self.log.missing_for(&remote_ids);
            if !missing_for_remote.is_empty() {
                self.send_sync_batches_to(from_peer, &missing_for_remote, actions);
            }

            // 2. If this was a one-sided anti-entropy inv (we did not concurrently send ours), request any IDs we lack
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
        let messages = self.log.select_by_ids(requested_ids);
        self.send_sync_batches_to(from_peer, &messages, actions);
    }

    fn handle_sync_batch(
        &mut self,
        from_peer: &str,
        batch_id: &str,
        chunk: usize,
        total_chunks: usize,
        messages: Vec<LogMessage>,
        actions: &mut Vec<MeshAction>,
    ) -> Result<(), String> {
        self.stats.sync_batches_received = self.stats.sync_batches_received.saturating_add(1);

        let mut added: Vec<LogMessage> = Vec::new();
        for msg in messages {
            if let Some(peer) = self.peers.get_mut(from_peer) {
                peer.known_ids.insert(msg.id.clone());
            }
            if self.log.insert(msg.clone())? {
                added.push(msg);
            }
        }

        if added.is_empty() {
            return Ok(());
        }

        let added_ids: Vec<String> = added.iter().map(|m| m.id.clone()).collect();
        actions.push(MeshAction::LogUpdated {
            added_ids,
            total_count: self.log.len(),
            lamport: self.log.lamport(),
        });

        actions.push(MeshAction::Telemetry {
            event: "sync_batch_received".to_owned(),
            detail: format!(
                "Applied {} message(s) from {} ({} chunk {}/{})",
                added.len(),
                from_peer,
                batch_id,
                chunk + 1,
                total_chunks
            ),
        });

        // Loop-free multi-hop propagation of newly learned backfill messages to other connected peers
        let other_peers: Vec<String> = self
            .peers
            .keys()
            .filter(|pid| pid.as_str() != from_peer)
            .cloned()
            .collect();

        for target in other_peers {
            let to_forward: Vec<LogMessage> = match self.peers.get(&target) {
                Some(peer) => added
                    .iter()
                    .filter(|m| !peer.known_ids.contains(&m.id))
                    .cloned()
                    .collect(),
                None => Vec::new(),
            };
            if to_forward.is_empty() {
                continue;
            }
            if to_forward.len() <= 3 {
                for m in to_forward {
                    if let Some(peer) = self.peers.get_mut(&target) {
                        peer.known_ids.insert(m.id.clone());
                    }
                    let gossip = WireFrame::Msg {
                        origin: m.author.clone(),
                        ttl: self.config.gossip_ttl.saturating_sub(1).max(1),
                        path: vec![from_peer.to_owned(), self.peer_id.clone()],
                        message: m,
                    };
                    self.stats.gossip_forwards = self.stats.gossip_forwards.saturating_add(1);
                    self.emit_wire(actions, &target, &gossip);
                }
            } else {
                self.send_sync_batches_to(&target, &to_forward, actions);
            }
        }

        Ok(())
    }

    fn consider_auto_mesh_peer(
        &mut self,
        target_peer_id: &str,
        target_name: &str,
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

        // Glare-free deterministic initiator rule: lexicographically smaller peerId initiates
        if self.peer_id.as_str() < target_peer_id {
            self.auto_mesh_pending.insert(
                target_peer_id.to_owned(),
                PendingAutoMesh {
                    target_peer_id: target_peer_id.to_owned(),
                    target_name: clean_name.clone(),
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
                via_peer_id: via_peer_id.to_owned(),
            });
            actions.push(MeshAction::Telemetry {
                event: "auto_mesh_init".to_owned(),
                detail: format!(
                    "Auto-meshing directly with {} ({}) via {}",
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
        to: String,
        hops: Vec<String>,
        ttl: u32,
        signal_type: RelaySignalType,
        sdp: Option<String>,
        candidate: Option<JsonValue>,
        now_ms: u64,
        actions: &mut Vec<MeshAction>,
    ) {
        if to == self.peer_id {
            // Delivered to us!
            if self.peers.contains_key(&from) {
                // Already directly connected
                return;
            }
            self.indirect_routes.insert(
                from.clone(),
                IndirectPeerRoute {
                    peer_id: from.clone(),
                    author_name: from_name.clone(),
                    via_peer_id: from_link.to_owned(),
                },
            );
            match signal_type {
                RelaySignalType::Offer => {
                    if let Some(offer_sdp) = sdp {
                        self.auto_mesh_pending.insert(
                            from.clone(),
                            PendingAutoMesh {
                                target_peer_id: from.clone(),
                                target_name: from_name.clone(),
                                via_peer_id: from_link.to_owned(),
                                initiated_by_self: false,
                                started_at_ms: now_ms,
                            },
                        );
                        actions.push(MeshAction::AutoMeshAcceptOffer {
                            from_peer_id: from.clone(),
                            from_name: from_name.clone(),
                            via_peer_id: from_link.to_owned(),
                            sdp: offer_sdp,
                        });
                        actions.push(MeshAction::Telemetry {
                            event: "auto_mesh_offer_recv".to_owned(),
                            detail: format!(
                                "Received relayed auto-mesh offer from {} ({}) via {}",
                                from_name, from, from_link
                            ),
                        });
                    }
                }
                RelaySignalType::Answer => {
                    if let Some(answer_sdp) = sdp {
                        actions.push(MeshAction::AutoMeshApplyAnswer {
                            from_peer_id: from.clone(),
                            sdp: answer_sdp,
                        });
                        actions.push(MeshAction::Telemetry {
                            event: "auto_mesh_answer_recv".to_owned(),
                            detail: format!(
                                "Received relayed auto-mesh answer from {} ({}) via {}",
                                from_name, from, from_link
                            ),
                        });
                    }
                }
                RelaySignalType::Ice => {
                    if let Some(cand) = candidate {
                        actions.push(MeshAction::AutoMeshAddIce {
                            from_peer_id: from,
                            candidate: cand,
                        });
                    }
                }
            }
            return;
        }

        // Intermediate relay node: forward loop-free toward `to`
        if ttl <= 1 || hops.iter().any(|h| h == &self.peer_id) {
            return;
        }

        let mut next_hops = hops;
        if !next_hops.iter().any(|h| h == from_link) {
            next_hops.push(from_link.to_owned());
        }
        next_hops.push(self.peer_id.clone());

        let forwarded = WireFrame::RelaySignal {
            from: from.clone(),
            from_name,
            to: to.clone(),
            via: self.peer_id.clone(),
            hops: next_hops.clone(),
            ttl: ttl - 1,
            signal_type,
            sdp,
            candidate,
        };

        // Prefer direct delivery if we are directly connected to `to`
        if self.peers.contains_key(&to) && to != from_link {
            self.stats.relay_signals_forwarded =
                self.stats.relay_signals_forwarded.saturating_add(1);
            self.emit_wire(actions, &to, &forwarded);
            return;
        }

        // Next prefer known indirect route to `to`
        if let Some(route) = self.indirect_routes.get(&to) {
            let next = route.via_peer_id.clone();
            if self.peers.contains_key(&next)
                && next != from_link
                && !next_hops.iter().any(|h| h == &next)
            {
                self.stats.relay_signals_forwarded =
                    self.stats.relay_signals_forwarded.saturating_add(1);
                self.emit_wire(actions, &next, &forwarded);
                return;
            }
        }

        // Otherwise loop-free flood across remaining direct neighbors
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
    }

    /// Serializes full node status, peers, topology, and counters for the UI.
    pub fn status_json(&self) -> String {
        let mut out = String::with_capacity(512);
        out.push_str("{\"peerId\":");
        write_json_string(&mut out, &self.peer_id);
        out.push_str(",\"authorName\":");
        write_json_string(&mut out, &self.author_name);
        out.push_str(",\"room\":");
        write_json_string(&mut out, &self.room);
        let _ = write!(
            out,
            ",\"lamport\":{},\"logCount\":{},\"autoMeshEnabled\":{},\"peers\":[",
            self.log.lamport(),
            self.log.len(),
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
            let _ = write!(out, ",\"viaAutoMesh\":{},\"introducedBy\":", peer.via_auto_mesh);
            match &peer.introduced_by {
                Some(intro) => write_json_string(&mut out, intro),
                None => out.push_str("null"),
            }
            let _ = write!(out, ",\"knownCount\":{},\"remotePeers\":[", peer.known_ids.len());
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
        let _ = write!(
            out,
            "],\"stats\":{{\"framesSent\":{},\"framesReceived\":{},\"gossipForwards\":{},\"gossipDuplicatesDropped\":{},\"syncInvSent\":{},\"syncInvReceived\":{},\"syncBatchesSent\":{},\"syncBatchesReceived\":{},\"autoMeshIntrosSent\":{},\"autoMeshOffersCreated\":{},\"relaySignalsForwarded\":{}}}}}",
            self.stats.frames_sent,
            self.stats.frames_received,
            self.stats.gossip_forwards,
            self.stats.gossip_duplicates_dropped,
            self.stats.sync_inv_sent,
            self.stats.sync_inv_received,
            self.stats.sync_batches_sent,
            self.stats.sync_batches_received,
            self.stats.auto_mesh_intros_sent,
            self.stats.auto_mesh_offers_created,
            self.stats.relay_signals_forwarded
        );
        out
    }

    /// Serializes the entire ordered replicated log as a JSON string.
    pub fn log_json(&self) -> String {
        let mut out = String::with_capacity(self.log.len().saturating_mul(160) + 8);
        self.log.write_messages_json_array(&mut out);
        out
    }

    /// Serializes a subset of log messages by ID as a JSON array string.
    pub fn messages_by_ids_json(&self, ids: &[String]) -> String {
        let selected = self.log.select_by_ids(ids);
        let mut out = String::with_capacity(selected.len().saturating_mul(160) + 8);
        out.push('[');
        for (i, m) in selected.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            m.write_json(&mut out);
        }
        out.push(']');
        out
    }
}
