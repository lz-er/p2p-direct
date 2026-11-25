#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use p2p_direct::crypto::sha256;
use p2p_direct::json::{JsonValue, parse_json};
use p2p_direct::mesh::{MeshAction, MeshConfig, MeshNode};
use p2p_direct::protocol::RelaySignalType;

type TestResult = Result<(), String>;

const SIM_MESH_KEY: [u8; 32] = [0x5Au8; 32];

#[derive(Debug, Clone)]
struct QueuedFrame {
    from: String,
    to: String,
    frame: String,
}

#[derive(Debug, Clone)]
struct PendingDirectConn {
    a: String,
    b: String,
    via: String,
}

struct SimNetwork {
    nodes: BTreeMap<String, MeshNode>,
    links: BTreeSet<(String, String)>,
    queue: VecDeque<QueuedFrame>,
    pending_webrtc: VecDeque<PendingDirectConn>,
    captured_wire_frames: Vec<QueuedFrame>,
    now_ms: u64,
    total_frames_delivered: usize,
    max_frames_limit: usize,
}

impl SimNetwork {
    fn new(max_frames_limit: usize) -> Self {
        Self {
            nodes: BTreeMap::new(),
            links: BTreeSet::new(),
            queue: VecDeque::new(),
            pending_webrtc: VecDeque::new(),
            captured_wire_frames: Vec::new(),
            now_ms: 1_700_000_000_000,
            total_frames_delivered: 0,
            max_frames_limit,
        }
    }

    fn canonical_edge(a: &str, b: &str) -> (String, String) {
        if a <= b {
            (a.to_owned(), b.to_owned())
        } else {
            (b.to_owned(), a.to_owned())
        }
    }

    fn add_node(&mut self, peer_id: &str, name: &str, config: MeshConfig) {
        self.add_node_with_key(peer_id, name, SIM_MESH_KEY, config);
    }

    fn add_node_with_key(
        &mut self,
        peer_id: &str,
        name: &str,
        mesh_key: [u8; 32],
        config: MeshConfig,
    ) {
        let sk = sha256(format!("sim-x25519-secret-{peer_id}").as_bytes());
        let seed = sha256(format!("sim-entropy-{peer_id}").as_bytes());
        self.nodes.insert(
            peer_id.to_owned(),
            MeshNode::new(
                peer_id.to_owned(),
                name.to_owned(),
                "sim-room".to_owned(),
                sk,
                mesh_key,
                &seed,
                config,
            ),
        );
    }

    fn node(&self, peer_id: &str) -> Result<&MeshNode, String> {
        self.nodes
            .get(peer_id)
            .ok_or_else(|| format!("missing sim node {peer_id}"))
    }

    fn node_mut(&mut self, peer_id: &str) -> Result<&mut MeshNode, String> {
        self.nodes
            .get_mut(peer_id)
            .ok_or_else(|| format!("missing sim node {peer_id}"))
    }

    fn connect(
        &mut self,
        a: &str,
        b: &str,
        via_auto_mesh: bool,
        introducer: Option<&str>,
    ) -> TestResult {
        let edge = Self::canonical_edge(a, b);
        if self.links.contains(&edge) {
            return Ok(());
        }
        let name_a = self.node(a)?.author_name().to_owned();
        let name_b = self.node(b)?.author_name().to_owned();
        let pk_a = self.node(a)?.public_key();
        let pk_b = self.node(b)?.public_key();
        self.links.insert(edge);

        let acts_a = self.node_mut(a)?.on_peer_connected(
            b.to_owned(),
            name_b,
            pk_b,
            via_auto_mesh,
            introducer.map(str::to_owned),
        )?;
        let acts_b = self.node_mut(b)?.on_peer_connected(
            a.to_owned(),
            name_a,
            pk_a,
            via_auto_mesh,
            introducer.map(str::to_owned),
        )?;
        self.process_actions(a, acts_a)?;
        self.process_actions(b, acts_b)?;
        Ok(())
    }

    fn disconnect(&mut self, a: &str, b: &str) -> TestResult {
        let edge = Self::canonical_edge(a, b);
        self.links.remove(&edge);
        if let Some(na) = self.nodes.get_mut(a) {
            let _ = na.on_peer_disconnected(b);
        }
        if let Some(nb) = self.nodes.get_mut(b) {
            let _ = nb.on_peer_disconnected(a);
        }
        Ok(())
    }

    fn remove_node(&mut self, peer_id: &str) -> TestResult {
        let peers: Vec<String> = self
            .links
            .iter()
            .filter_map(|(u, v)| {
                if u == peer_id {
                    Some(v.clone())
                } else if v == peer_id {
                    Some(u.clone())
                } else {
                    None
                }
            })
            .collect();
        for p in peers {
            self.disconnect(peer_id, &p)?;
        }
        self.nodes.remove(peer_id);
        Ok(())
    }

    fn publish(
        &mut self,
        peer_id: &str,
        msg_type: &str,
        payload: JsonValue,
        ts_override: Option<u64>,
    ) -> Result<String, String> {
        let ts = match ts_override {
            Some(v) => v,
            None => {
                self.now_ms += 10;
                self.now_ms
            }
        };
        let (msg, actions) = self
            .node_mut(peer_id)?
            .publish_local(msg_type.to_owned(), payload, ts, None)?;
        self.process_actions(peer_id, actions)?;
        Ok(msg.id)
    }

    fn request_sync(&mut self, peer_id: &str) -> TestResult {
        let actions = self.node_mut(peer_id)?.request_sync_all();
        self.process_actions(peer_id, actions)
    }

    fn process_actions(&mut self, actor: &str, actions: Vec<MeshAction>) -> TestResult {
        for act in actions {
            match act {
                MeshAction::SendWire { peer_id, frame } => {
                    // EVERY single frame crossing the wire MUST be an outer E2EE envelope!
                    let parsed = parse_json(&frame)?;
                    if parsed.get_str("kind") != Some("e2ee") {
                        return Err(format!("non-E2EE frame leaked onto wire: {frame}"));
                    }
                    let edge = Self::canonical_edge(actor, &peer_id);
                    if self.links.contains(&edge) {
                        let qf = QueuedFrame {
                            from: actor.to_owned(),
                            to: peer_id,
                            frame,
                        };
                        self.captured_wire_frames.push(qf.clone());
                        self.queue.push_back(qf);
                    }
                }
                MeshAction::AutoMeshCreateOffer {
                    target_peer_id,
                    via_peer_id,
                    ..
                } => {
                    let fake_sdp = format!(
                        "v=0\r\no=CONFIDENTIAL-OFFER-SDP-{actor}-to-{target_peer_id}\r\n"
                    );
                    let relay_acts = self.node_mut(actor)?.send_relay_signal(
                        target_peer_id.clone(),
                        RelaySignalType::Offer,
                        Some(fake_sdp),
                        None,
                        Some(via_peer_id.clone()),
                    )?;
                    self.process_actions(actor, relay_acts)?;

                    let ice_val = parse_json(
                        r#"{"candidate":"candidate:1 1 udp 2122260223 10.99.88.77 50000 typ host","sdpMid":"0"}"#,
                    )?;
                    let ice_acts = self.node_mut(actor)?.send_relay_signal(
                        target_peer_id,
                        RelaySignalType::Ice,
                        None,
                        Some(ice_val),
                        Some(via_peer_id),
                    )?;
                    self.process_actions(actor, ice_acts)?;
                }
                MeshAction::AutoMeshAcceptOffer {
                    from_peer_id,
                    via_peer_id,
                    ..
                } => {
                    let fake_ans = format!(
                        "v=0\r\no=CONFIDENTIAL-ANSWER-SDP-{actor}-to-{from_peer_id}\r\n"
                    );
                    let relay_acts = self.node_mut(actor)?.send_relay_signal(
                        from_peer_id,
                        RelaySignalType::Answer,
                        Some(fake_ans),
                        None,
                        Some(via_peer_id),
                    )?;
                    self.process_actions(actor, relay_acts)?;
                }
                MeshAction::AutoMeshApplyAnswer { from_peer_id, .. } => {
                    self.pending_webrtc.push_back(PendingDirectConn {
                        a: actor.to_owned(),
                        b: from_peer_id,
                        via: "relay".to_owned(),
                    });
                }
                MeshAction::BotActionReceived { .. }
                | MeshAction::AutoMeshAddIce { .. }
                | MeshAction::LogUpdated { .. }
                | MeshAction::Telemetry { .. } => {}
            }
        }
        Ok(())
    }

    fn drain(&mut self) -> TestResult {
        while !self.queue.is_empty() || !self.pending_webrtc.is_empty() {
            while let Some(qf) = self.queue.pop_front() {
                self.total_frames_delivered += 1;
                if self.total_frames_delivered > self.max_frames_limit {
                    return Err(format!(
                        "simulation exceeded max frame limit {} (possible gossip or relay loop!)",
                        self.max_frames_limit
                    ));
                }
                let edge = Self::canonical_edge(&qf.from, &qf.to);
                if !self.links.contains(&edge) || !self.nodes.contains_key(&qf.to) {
                    continue;
                }
                self.now_ms += 1;
                let now = self.now_ms;
                let actions = self
                    .node_mut(&qf.to)?
                    .on_wire_message(&qf.from, &qf.frame, now)?;
                self.process_actions(&qf.to, actions)?;
            }

            if let Some(conn) = self.pending_webrtc.pop_front()
                && self.nodes.contains_key(&conn.a)
                && self.nodes.contains_key(&conn.b)
            {
                self.connect(&conn.a, &conn.b, true, Some(&conn.via))?;
            }
        }
        Ok(())
    }

    fn assert_all_converged(&self, expected_count: usize) -> TestResult {
        let mut iter = self.nodes.values();
        let first = iter.next().ok_or("no nodes in simulation")?;
        let baseline: Vec<_> = first.log().ordered().cloned().collect();
        if baseline.len() != expected_count {
            return Err(format!(
                "expected {} messages on {}, got {}",
                expected_count,
                first.peer_id(),
                baseline.len()
            ));
        }

        for pair in baseline.windows(2) {
            if let (Some(a), Some(b)) = (pair.first(), pair.get(1)) {
                assert!(
                    a.order_key() < b.order_key(),
                    "log out of deterministic order: {:?} >= {:?}",
                    a.order_key(),
                    b.order_key()
                );
            }
        }

        for node in iter {
            let current: Vec<_> = node.log().ordered().cloned().collect();
            assert_eq!(
                current,
                baseline,
                "node {} diverged from node {}",
                node.peer_id(),
                first.peer_id()
            );
        }
        Ok(())
    }
}

#[test]
fn sim_two_peer_bidirectional_backfill_zero_plaintext_on_wire() -> TestResult {
    let mut sim = SimNetwork::new(2_000);
    sim.add_node("peer-a", "Alice", MeshConfig::default());
    sim.add_node("peer-b", "Bob", MeshConfig::default());

    for i in 0..10 {
        sim.publish(
            "peer-a",
            "chat",
            parse_json(&format!(r#"{{"text":"TOPSECRET_ALICE_{i}"}}"#))?,
            None,
        )?;
    }
    for i in 0..5 {
        sim.publish(
            "peer-b",
            "event",
            parse_json(&format!(r#"{{"seq":{i},"secret":"TOPSECRET_BOB_{i}"}}"#))?,
            None,
        )?;
    }

    sim.connect("peer-a", "peer-b", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(15)?;

    // Safety numbers MUST match on both peers
    assert_eq!(
        sim.node("peer-a")?.peer_safety_code("peer-b"),
        sim.node("peer-b")?.peer_safety_code("peer-a")
    );

    // Audit EVERY captured wire frame: ZERO plaintext keywords or secrets may appear!
    assert!(!sim.captured_wire_frames.is_empty());
    for qf in &sim.captured_wire_frames {
        assert!(!qf.frame.contains("TOPSECRET_ALICE"));
        assert!(!qf.frame.contains("TOPSECRET_BOB"));
        assert!(!qf.frame.contains("\"sync-batch\""));
        assert!(!qf.frame.contains("\"hello\""));
    }

    assert!(sim.node("peer-a")?.stats().e2ee_frames_encrypted >= 2);
    assert!(sim.node("peer-b")?.stats().e2ee_frames_decrypted >= 2);
    assert_eq!(sim.node("peer-a")?.stats().e2ee_auth_failures, 0);
    Ok(())
}

#[test]
fn sim_e2ee_rejects_plaintext_tampering_replay_and_wrong_key() -> TestResult {
    let mut sim = SimNetwork::new(2_000);
    sim.add_node("peer-a", "Alice", MeshConfig::default());
    sim.add_node("peer-b", "Bob", MeshConfig::default());

    sim.connect("peer-a", "peer-b", false, None)?;
    sim.drain()?;

    sim.publish(
        "peer-a",
        "chat",
        parse_json(r#"{"text":"authentic-e2ee-msg"}"#)?,
        None,
    )?;
    let last_frame = sim
        .captured_wire_frames
        .last()
        .cloned()
        .ok_or("no captured wire frame")?;
    sim.drain()?;
    sim.assert_all_converged(1)?;

    // 1. Replaying an already-delivered authentic frame MUST be rejected!
    assert!(
        sim.node_mut("peer-b")?
            .on_wire_message("peer-a", &last_frame.frame, 1_700_000_009_000)
            .is_err()
    );

    // 2. Sending an unencrypted plaintext frame MUST be rejected!
    assert!(
        sim.node_mut("peer-b")?
            .on_wire_message(
                "peer-a",
                r#"{"kind":"sync-inv","from":"peer-a","ids":[]}"#,
                1_700_000_009_001
            )
            .is_err()
    );

    // 3. Tampering with ciphertext in transit MUST fail Poly1305 AEAD auth!
    let mut tampered = last_frame.frame.clone();
    if let Some(pos) = tampered.find("\"c\":\"") {
        let idx = pos + 5;
        let mut bytes = tampered.into_bytes();
        if let Some(b) = bytes.get_mut(idx) {
            *b = if *b == b'A' { b'B' } else { b'A' };
        }
        tampered = String::from_utf8(bytes).map_err(|_| "utf8 err")?;
    }
    assert!(
        sim.node_mut("peer-b")?
            .on_wire_message("peer-a", &tampered, 1_700_000_009_002)
            .is_err()
    );
    assert!(sim.node("peer-b")?.stats().e2ee_auth_failures >= 3);

    // 4. An unauthorized peer with a DIFFERENT mesh key cannot decrypt frames from Alice!
    let wrong_key = [0x99u8; 32];
    sim.add_node_with_key("peer-eve", "Eve", wrong_key, MeshConfig::default());
    sim.connect("peer-a", "peer-eve", false, None)?;
    // Delivering Alice's frame to Eve MUST fail AEAD authentication
    let frame_to_eve = sim.queue.pop_front().ok_or("expected frame to eve")?;
    assert!(
        sim.node_mut(&frame_to_eve.to)?
            .on_wire_message(&frame_to_eve.from, &frame_to_eve.frame, 1_700_000_010_000)
            .is_err()
    );
    assert_eq!(sim.node("peer-eve")?.log().len(), 0);
    Ok(())
}

#[test]
fn sim_chunked_sync_inv_and_batch_backfill_old_and_new() -> TestResult {
    let small_chunks = MeshConfig {
        inv_chunk_ids: 15,
        batch_max_msgs: 7,
        batch_max_bytes: 3_000,
        ..MeshConfig::default()
    };
    let mut sim = SimNetwork::new(10_000);
    sim.add_node("peer-a", "Alice", small_chunks.clone());
    sim.add_node("peer-b", "Bob", small_chunks);

    for i in 0..65 {
        sim.publish(
            "peer-a",
            "record",
            parse_json(&format!(r#"{{"index":{i},"body":"historical payload {i}"}}"#))?,
            None,
        )?;
    }

    sim.connect("peer-a", "peer-b", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(65)?;
    assert!(sim.node("peer-a")?.stats().sync_inv_sent >= 5);
    assert!(sim.node("peer-a")?.stats().sync_batches_sent >= 10);

    sim.disconnect("peer-a", "peer-b")?;
    for i in 0..10 {
        sim.publish(
            "peer-a",
            "record",
            parse_json(&format!(r#"{{"newA":{i}}}"#))?,
            None,
        )?;
    }
    for i in 0..8 {
        sim.publish(
            "peer-b",
            "record",
            parse_json(&format!(r#"{{"newB":{i}}}"#))?,
            None,
        )?;
    }

    sim.connect("peer-a", "peer-b", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(83)?;
    Ok(())
}

#[test]
fn sim_loop_free_multi_hop_gossip_in_cyclic_topology() -> TestResult {
    let gossip_only = MeshConfig {
        auto_mesh_enabled: false,
        gossip_ttl: 16,
        ..MeshConfig::default()
    };
    let mut sim = SimNetwork::new(2_000);
    let ids = ["n1", "n2", "n3", "n4", "n5", "n6"];
    for id in ids {
        sim.add_node(id, id, gossip_only.clone());
    }

    let edges = [
        ("n1", "n2"),
        ("n2", "n3"),
        ("n3", "n4"),
        ("n4", "n5"),
        ("n5", "n6"),
        ("n6", "n1"),
        ("n2", "n5"),
        ("n3", "n6"),
    ];
    for (u, v) in edges {
        sim.connect(u, v, false, None)?;
    }
    sim.drain()?;

    for (idx, id) in ids.iter().enumerate() {
        for j in 0..3 {
            sim.publish(
                id,
                "gossip",
                parse_json(&format!(r#"{{"from":"{id}","n":{j},"idx":{idx}}}"#))?,
                None,
            )?;
        }
    }
    sim.drain()?;
    sim.assert_all_converged(18)?;

    let total_forwards: u64 = ids
        .iter()
        .filter_map(|id| sim.node(id).ok())
        .map(|n| n.stats().gossip_forwards)
        .sum();
    let total_drops: u64 = ids
        .iter()
        .filter_map(|id| sim.node(id).ok())
        .map(|n| n.stats().gossip_duplicates_dropped)
        .sum();
    assert!(total_forwards > 0);
    assert!(total_drops > 0);
    Ok(())
}

#[test]
fn sim_partition_divergent_edits_with_tie_collisions_and_heal() -> TestResult {
    let gossip_only = MeshConfig {
        auto_mesh_enabled: false,
        ..MeshConfig::default()
    };
    let mut sim = SimNetwork::new(5_000);
    for id in ["p1", "p2", "p3", "p4", "p5", "p6"] {
        sim.add_node(id, id, gossip_only.clone());
    }

    sim.connect("p1", "p2", false, None)?;
    sim.connect("p2", "p3", false, None)?;
    sim.connect("p4", "p5", false, None)?;
    sim.connect("p5", "p6", false, None)?;
    sim.drain()?;

    let shared_ts = Some(1_700_000_555_000);
    for i in 0..4 {
        sim.publish(
            "p1",
            "chat",
            parse_json(&format!(r#"{{"c":1,"i":{i}}}"#))?,
            shared_ts,
        )?;
        sim.publish(
            "p6",
            "chat",
            parse_json(&format!(r#"{{"c":2,"i":{i}}}"#))?,
            shared_ts,
        )?;
        sim.drain()?;
    }
    sim.publish("p3", "state", parse_json(r#"{"cluster":"left"}"#)?, shared_ts)?;
    sim.publish("p4", "state", parse_json(r#"{"cluster":"right"}"#)?, shared_ts)?;
    sim.drain()?;

    sim.connect("p3", "p4", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(10)?;
    Ok(())
}

#[test]
fn sim_relayed_auto_mesh_e2ee_and_log_survival_through_churn() -> TestResult {
    let mut sim = SimNetwork::new(5_000);
    sim.add_node("p-alice", "Alice", MeshConfig::default());
    sim.add_node("p-bob", "Bob", MeshConfig::default());
    sim.add_node("p-carol", "Carol", MeshConfig::default());

    for i in 0..5 {
        sim.publish(
            "p-alice",
            "genesis",
            parse_json(&format!(r#"{{"origin":"alice","seq":{i}}}"#))?,
            None,
        )?;
    }

    sim.connect("p-alice", "p-bob", false, None)?;
    sim.drain()?;
    assert_eq!(sim.node("p-bob")?.log().len(), 5);

    sim.connect("p-bob", "p-carol", false, None)?;
    sim.drain()?;

    assert!(sim.node("p-alice")?.is_connected_to("p-carol"));
    assert!(sim.node("p-carol")?.is_connected_to("p-alice"));
    assert!(sim.node("p-alice")?.stats().relay_signals_encrypted >= 1);
    assert!(sim.node("p-bob")?.stats().relay_signals_forwarded >= 2);
    // Verify Alice & Carol derived matching X25519 safety codes on their auto-meshed link
    assert_eq!(
        sim.node("p-alice")?.peer_safety_code("p-carol"),
        sim.node("p-carol")?.peer_safety_code("p-alice")
    );
    // Verify no confidential SDP/ICE leaked onto any wire frame
    for qf in &sim.captured_wire_frames {
        assert!(!qf.frame.contains("CONFIDENTIAL-OFFER-SDP"));
        assert!(!qf.frame.contains("CONFIDENTIAL-ANSWER-SDP"));
        assert!(!qf.frame.contains("10.99.88.77"));
    }
    sim.assert_all_converged(5)?;

    // Bob (introducer) departs completely
    sim.remove_node("p-bob")?;

    sim.publish("p-alice", "chat", parse_json(r#"{"text":"still direct & E2EE!"}"#)?, None)?;
    sim.publish("p-carol", "chat", parse_json(r#"{"text":"bob is gone, mesh alive"}"#)?, None)?;
    sim.drain()?;
    assert_eq!(sim.node("p-alice")?.log().len(), 7);
    assert_eq!(sim.node("p-carol")?.log().len(), 7);

    // Alice (original creator) leaves too; Dave joins Carol and recovers all 7 encrypted records
    sim.remove_node("p-alice")?;
    sim.add_node("p-dave", "Dave", MeshConfig::default());
    sim.connect("p-carol", "p-dave", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(7)?;

    let genesis_count = sim
        .node("p-dave")?
        .log()
        .ordered()
        .filter(|m| m.msg_type == "genesis" && m.author == "p-alice")
        .count();
    assert_eq!(genesis_count, 5);
    Ok(())
}

#[test]
fn sim_four_node_chain_auto_meshes_into_full_e2ee_clique() -> TestResult {
    let mut sim = SimNetwork::new(10_000);
    let ids = ["peer-1", "peer-2", "peer-3", "peer-4"];
    for id in ids {
        sim.add_node(id, id, MeshConfig::default());
    }

    sim.connect("peer-1", "peer-2", false, None)?;
    sim.drain()?;
    sim.connect("peer-2", "peer-3", false, None)?;
    sim.drain()?;
    sim.connect("peer-3", "peer-4", false, None)?;
    sim.drain()?;

    for id in ids {
        let peers = sim.node(id)?.connected_peer_ids();
        assert_eq!(peers.len(), 3, "expected 3 direct E2EE peers on {id}");
        assert_eq!(sim.node(id)?.stats().e2ee_auth_failures, 0);
    }

    for id in ids {
        sim.publish(id, "clique", parse_json(&format!(r#"{{"by":"{id}"}}"#))?, None)?;
    }
    sim.drain()?;
    sim.assert_all_converged(4)?;
    Ok(())
}

#[test]
fn sim_local_wipe_and_one_sided_sync_recovery() -> TestResult {
    let mut sim = SimNetwork::new(2_000);
    sim.add_node("peer-a", "Alice", MeshConfig::default());
    sim.add_node("peer-b", "Bob", MeshConfig::default());

    sim.connect("peer-a", "peer-b", false, None)?;
    sim.drain()?;

    for i in 0..12 {
        sim.publish("peer-a", "log", parse_json(&format!(r#"{{"n":{i}}}"#))?, None)?;
    }
    sim.drain()?;
    sim.assert_all_converged(12)?;

    sim.node_mut("peer-b")?.reset_local_log();
    assert_eq!(sim.node("peer-b")?.log().len(), 0);
    sim.request_sync("peer-b")?;
    sim.drain()?;
    sim.assert_all_converged(12)?;
    Ok(())
}

#[test]
fn sim_keepalive_ping_pong_and_rapid_rejoin_same_peer_id() -> TestResult {
    let mut sim = SimNetwork::new(5_000);
    sim.add_node("peer-a", "Alice", MeshConfig::default());
    sim.add_node("peer-b", "Bob", MeshConfig::default());
    sim.add_node("peer-c", "Carol", MeshConfig::default());

    sim.connect("peer-a", "peer-b", false, None)?;
    sim.connect("peer-a", "peer-c", false, None)?;
    sim.drain()?;

    // 1. Encrypted keepalive ping/pong keeps links warm and measures RTT
    let ping_acts = sim.node_mut("peer-a")?.send_keepalive_pings(1_700_000_000_000);
    sim.process_actions("peer-a", ping_acts)?;
    sim.drain()?;
    let status_a = parse_json(&sim.node("peer-a")?.status_json())?;
    let peers_arr = status_a
        .get("peers")
        .and_then(JsonValue::as_array)
        .ok_or("missing peers")?;
    for p in peers_arr {
        assert!(
            p.get_u64("lastPongMs").unwrap_or(0) > 0,
            "expected encrypted pong response from peer"
        );
    }

    // 2. Calling set_mesh_key with the SAME key must be a no-op and NOT break live peer-a <-> peer-c link!
    sim.node_mut("peer-a")?.set_mesh_key(SIM_MESH_KEY, false)?;
    sim.publish("peer-a", "chat", parse_json(r#"{"text":"after-noop-set-key"}"#)?, None)?;
    sim.drain()?;
    sim.assert_all_converged(1)?;

    // 3. Simulate Bob closing his tab and reopening with the SAME peerId & persisted encrypted snapshot,
    //    even while Alice still has Bob's old connection entry before timeout!
    let bob_snap = parse_json(&sim.node_mut("peer-b")?.export_persistence())?;
    let bob_sk = sha256(b"sim-x25519-secret-peer-b");
    let bob_pk = sim.node("peer-b")?.public_key();
    let alice_pk = sim.node("peer-a")?.public_key();

    // Alice publishes a message while Bob is offline
    sim.disconnect("peer-b", "peer-c")?;
    sim.nodes.remove("peer-b");
    sim.publish("peer-a", "chat", parse_json(r#"{"text":"missed-while-tab-closed"}"#)?, None)?;
    sim.drain()?;

    // Bob reopens tab from persisted encrypted snapshot (same peerId, same keys)
    let mut bob_reopened = MeshNode::new(
        "peer-b".to_owned(),
        "Bob".to_owned(),
        "sim-room".to_owned(),
        bob_sk,
        SIM_MESH_KEY,
        b"reopened-tab-entropy",
        MeshConfig::default(),
    );
    let restored = bob_reopened.import_persistence(&bob_snap)?;
    assert_eq!(restored, 1);
    sim.nodes.insert("peer-b".to_owned(), bob_reopened);

    // Reconnect directly onto Alice WITHOUT calling on_peer_disconnected on Alice first (supersedes stale link!)
    let acts_a = sim.node_mut("peer-a")?.on_peer_connected(
        "peer-b".to_owned(),
        "Bob".to_owned(),
        bob_pk,
        false,
        None,
    )?;
    let acts_b = sim.node_mut("peer-b")?.on_peer_connected(
        "peer-a".to_owned(),
        "Alice".to_owned(),
        alice_pk,
        false,
        None,
    )?;
    sim.process_actions("peer-a", acts_a)?;
    sim.process_actions("peer-b", acts_b)?;
    sim.drain()?;

    // Bob catches up on missed messages AND auto-meshes back to Carol!
    sim.assert_all_converged(2)?;
    assert!(sim.node("peer-b")?.is_connected_to("peer-c"));
    assert_eq!(sim.node("peer-a")?.stats().e2ee_auth_failures, 0);
    assert_eq!(sim.node("peer-b")?.stats().e2ee_auth_failures, 0);
    Ok(())
}

#[test]
fn sim_multi_peer_realtime_e2ee_voice_chat() -> TestResult {
    let mut sim = SimNetwork::new(2_000);
    sim.add_node("peer-a", "Alice", MeshConfig::default());
    sim.add_node("peer-b", "Bob", MeshConfig::default());
    sim.add_node("peer-c", "Carol", MeshConfig::default());
    sim.add_node("peer-d", "Dave", MeshConfig::default());

    // Build mesh: A-B, A-C, A-D -> auto-mesh turns it into a full mesh!
    sim.connect("peer-a", "peer-b", false, None)?;
    sim.connect("peer-a", "peer-c", false, None)?;
    sim.connect("peer-a", "peer-d", false, None)?;
    sim.drain()?;

    // Alice, Bob, and Carol join voice chat simultaneously; Dave stays out of voice
    for pid in ["peer-a", "peer-b", "peer-c"] {
        let acts = sim.node_mut(pid)?.set_voice_state(true, false);
        sim.process_actions(pid, acts)?;
    }
    sim.drain()?;

    // Generate distinct 20ms (320-sample) 16 kHz sine waves for Alice (440 Hz), Bob (660 Hz), Carol (880 Hz)
    let make_tone = |freq_hz: f64| -> Vec<i16> {
        (0..320)
            .map(|i| {
                let t = (i as f64) / 16_000.0;
                (12_000.0 * (2.0 * std::f64::consts::PI * freq_hz * t).sin()) as i16
            })
            .collect()
    };
    let tone_a = make_tone(440.0);
    let tone_b = make_tone(660.0);
    let tone_c = make_tone(880.0);

    // Every speaker talks simultaneously: each seals for the other 2 voice peers (and NOT for Dave!)
    let speakers = [("peer-a", &tone_a), ("peer-b", &tone_b), ("peer-c", &tone_c)];
    let mut captured_for_tamper: Option<(String, String, Vec<u8>)> = None;

    for (sender, pcm) in speakers {
        let (local_rms, pkts) = sim.node_mut(sender)?.seal_voice_pcm(pcm);
        assert!(local_rms > 6_000, "sender {sender} should have strong RMS");
        assert_eq!(pkts.len(), 2, "sender {sender} must send only to the 2 other voice peers");
        for (target, pkt) in pkts {
            assert_ne!(target, "peer-d", "Dave is not in voice and must not receive voice packets");
            assert_eq!(pkt.get(0..2), Some(&b"V1"[..]));
            if captured_for_tamper.is_none() {
                captured_for_tamper = Some((sender.to_owned(), target.clone(), pkt.clone()));
            }
            let (rx_rms, decoded_pcm) = sim.node_mut(&target)?.open_voice_packet(sender, &pkt)?;
            assert_eq!(decoded_pcm.len(), 320);
            assert!(
                rx_rms > 5_000,
                "receiver {target} must decode audible E2EE voice from {sender}"
            );
        }
    }

    // Verify stats on all 3 voice participants
    for pid in ["peer-a", "peer-b", "peer-c"] {
        let st = sim.node(pid)?.stats();
        assert_eq!(st.voice_packets_sent, 2);
        assert_eq!(st.voice_packets_received, 2);
        assert_eq!(st.e2ee_auth_failures, 0);
    }
    assert_eq!(sim.node("peer-d")?.stats().voice_packets_received, 0);

    // Replay & Tamper resistance on E2EE voice packets
    let (sender, target, orig_pkt) = captured_for_tamper.ok_or("missing captured voice pkt")?;
    // 1. Replaying the same voice packet MUST fail anti-replay check
    assert!(
        sim.node_mut(&target)?
            .open_voice_packet(&sender, &orig_pkt)
            .is_err()
    );
    // 2. Flipping a bit in ciphertext of a fresh packet MUST fail Poly1305 AEAD check
    let (_, fresh_pkts) = sim.node_mut(&sender)?.seal_voice_pcm(&tone_a);
    let (_, mut tampered) = fresh_pkts
        .into_iter()
        .find(|(p, _)| p == &target)
        .ok_or("missing fresh packet for target")?;
    if let Some(last) = tampered.last_mut() {
        *last ^= 0xFF;
    }
    assert!(
        sim.node_mut(&target)?
            .open_voice_packet(&sender, &tampered)
            .is_err()
    );
    assert!(sim.node(&target)?.stats().e2ee_auth_failures >= 2);

    // Muting Alice stops outbound voice packets immediately while keeping local RMS meter working
    let mute_acts = sim.node_mut("peer-a")?.set_voice_state(true, true);
    sim.process_actions("peer-a", mute_acts)?;
    sim.drain()?;
    let (muted_rms, muted_pkts) = sim.node_mut("peer-a")?.seal_voice_pcm(&tone_a);
    assert!(muted_rms > 6_000);
    assert!(muted_pkts.is_empty());

    // A brand-new peer joining the mesh while Bob & Carol are in voice learns their voice state via Hello!
    sim.add_node("peer-e", "EveJoiner", MeshConfig::default());
    sim.connect("peer-e", "peer-b", false, None)?;
    sim.drain()?;
    let status_e = parse_json(&sim.node("peer-e")?.status_json())?;
    let peers_e = status_e
        .get("peers")
        .and_then(JsonValue::as_array)
        .ok_or("missing peers in peer-e status")?;
    let bob_entry = peers_e
        .iter()
        .find(|p| p.get_str("peerId") == Some("peer-b"))
        .ok_or("missing peer-b in peer-e status")?;
    assert_eq!(bob_entry.get_bool("inVoice"), Some(true));
    assert_eq!(bob_entry.get_bool("voiceMuted"), Some(false));
    Ok(())
}

#[test]
fn sim_long_lived_room_invite_first_joiner_and_subsequent_joiners() -> TestResult {
    use p2p_direct::codec::{
        PROTOCOL_VERSION, SignalCodeKind, SignalCodePayload, decode_signal_code,
        encode_fragment_url,
    };
    use p2p_direct::crypto::SafeCsprng;

    // 1. A long-lived #room=P2P1:... invite link is generated once (e.g., ahead of time)
    let room_mesh_key = sha256(b"long-lived-room-secret-key-2026");
    let mut rng = SafeCsprng::from_seed(b"sim-room-invite-seed");
    let invite_payload = SignalCodePayload {
        version: PROTOCOL_VERSION,
        kind: SignalCodeKind::Room,
        peer_id: String::new(),
        author_name: String::new(),
        room: "Permanent Study Mesh".to_owned(),
        invite_id: String::new(),
        pub_key: [0u8; 32],
        mesh_key: Some(room_mesh_key),
        sdp: String::new(),
        relay: None,
    };
    let room_url = encode_fragment_url(
        "https://lz-er.github.io/p2p-direct/",
        &invite_payload,
        None,
        &mut rng,
    )?;

    let mut sim = SimNetwork::new(5_000);

    // 2. First person (Alice) opens the link -> creates the mesh & publishes initial history
    let (dec_a, _) = decode_signal_code(&room_url, None)?;
    let key_a = dec_a.mesh_key.ok_or("missing key for Alice")?;
    sim.add_node_with_key("peer-a", "Alice", key_a, MeshConfig::default());
    sim.publish(
        "peer-a",
        "chat",
        parse_json(r#"{"text":"I opened the room first and created the mesh!"}"#)?,
        None,
    )?;
    let topic_a = sim.node("peer-a")?.room_topic().to_owned();

    // 3. Second person (Bob) opens the EXACT same link -> derives identical opaque topic,
    //    exchanges AEAD-sealed R1: rendezvous signals, connects P2P, and backfills Alice's message!
    let (dec_b, _) = decode_signal_code(&room_url, None)?;
    let key_b = dec_b.mesh_key.ok_or("missing key for Bob")?;
    sim.add_node_with_key("peer-b", "Bob", key_b, MeshConfig::default());
    assert_eq!(sim.node("peer-b")?.room_topic(), topic_a);

    let sealed_hello_b = sim
        .node_mut("peer-b")?
        .seal_room_signal(r#"{"t":"hello","from":"peer-b","name":"Bob"}"#);
    assert!(sealed_hello_b.starts_with("R1:"));
    assert!(!sealed_hello_b.contains("Bob"));
    assert!(!sealed_hello_b.contains("peer-b"));

    let opened_on_a = sim.node_mut("peer-a")?.open_room_signal(&sealed_hello_b)?;
    let parsed_hello = parse_json(&opened_on_a)?;
    assert_eq!(parsed_hello.get_str("from"), Some("peer-b"));

    sim.connect("peer-a", "peer-b", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(1)?;

    // 4. Original first-joiner (Alice) leaves completely; Bob keeps the room alive and posts a message
    sim.remove_node("peer-a")?;
    sim.publish(
        "peer-b",
        "chat",
        parse_json(r#"{"text":"Alice left, but the room stays alive!"}"#)?,
        None,
    )?;

    // 5. Third person (Carol) arrives later with ONLY the same #room= link -> connects to Bob
    //    and receives BOTH Alice's original message AND Bob's message!
    let (dec_c, _) = decode_signal_code(&room_url, None)?;
    let key_c = dec_c.mesh_key.ok_or("missing key for Carol")?;
    sim.add_node_with_key("peer-c", "Carol", key_c, MeshConfig::default());
    assert_eq!(sim.node("peer-c")?.room_topic(), topic_a);

    let sealed_offer_bc = sim
        .node_mut("peer-b")?
        .seal_room_signal(r#"{"t":"offer","from":"peer-b","to":"peer-c","sdp":"v=0\r\nSECRET-SDP\r\n"}"#);
    assert!(!sealed_offer_bc.contains("SECRET-SDP"));
    let opened_on_c = sim.node_mut("peer-c")?.open_room_signal(&sealed_offer_bc)?;
    assert!(opened_on_c.contains("SECRET-SDP"));

    sim.connect("peer-b", "peer-c", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(2)?;
    Ok(())
}

#[test]
fn sim_delete_message_syncs_across_partition_and_late_joiner() -> TestResult {
    let mut sim = SimNetwork::new(20_000);
    sim.add_node("peer-a", "Alice", MeshConfig::default());
    sim.add_node("peer-b", "Bob", MeshConfig::default());
    sim.connect("peer-a", "peer-b", false, None)?;
    sim.drain()?;

    let m1_id = sim.publish("peer-a", "chat", parse_json(r#"{"text":"erase me"}"#)?, None)?;
    let _m2_id = sim.publish("peer-b", "chat", parse_json(r#"{"text":"keep me"}"#)?, None)?;
    sim.drain()?;
    sim.assert_all_converged(2)?;

    // Partition peer-b while peer-a deletes m1
    sim.disconnect("peer-a", "peer-b")?;
    let (_, del_acts) = sim.node_mut("peer-a")?.delete_message(m1_id.clone(), 9_000)?;
    sim.process_actions("peer-a", del_acts)?;
    assert_eq!(sim.node("peer-a")?.log().len(), 1);
    assert_eq!(sim.node("peer-b")?.log().len(), 2);

    // Reconnect -> anti-entropy syncs tombstone so Bob scrubs m1 (zero resurrection!)
    sim.connect("peer-a", "peer-b", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(1)?;
    assert!(!sim.node("peer-b")?.log_json().contains("erase me"));
    assert!(sim.node("peer-b")?.log_json().contains("keep me"));

    // Late joiner Carol joins Bob -> receives only m2 (m1 never resurrects)
    sim.add_node("peer-c", "Carol", MeshConfig::default());
    sim.connect("peer-b", "peer-c", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(1)?;
    assert!(!sim.node("peer-c")?.log_json().contains("erase me"));
    assert!(sim.node("peer-c")?.log_json().contains("keep me"));
    Ok(())
}

#[test]
fn sim_bot_identity_and_multihop_bot_action_delivery() -> TestResult {
    let cfg = MeshConfig {
        auto_mesh_enabled: false, // keep strict 2-hop topology: Alice -- Bob -- Bot
        ..MeshConfig::default()
    };
    let mut sim = SimNetwork::new(20_000);
    sim.add_node("peer-a", "Alice", cfg.clone());
    sim.add_node("peer-b", "Bob", cfg.clone());
    sim.add_node("peer-bot", "WarframeBot", cfg);
    sim.node_mut("peer-bot")?.set_is_bot(true);

    sim.connect("peer-a", "peer-b", false, None)?;
    sim.connect("peer-b", "peer-bot", false, None)?;
    sim.drain()?;

    // Verify Bob sees peer-bot as isBot:true in status_json
    let bob_status = parse_json(&sim.node("peer-b")?.status_json())?;
    let bob_peers = bob_status
        .get("peers")
        .and_then(|v| v.as_array())
        .ok_or("missing peers")?;
    let bot_entry = bob_peers
        .iter()
        .find(|p| p.get_str("peerId") == Some("peer-bot"))
        .ok_or("missing bot peer")?;
    assert_eq!(bot_entry.get_bool("isBot"), Some(true));

    // Bot publishes a bot card with buttons -> gossips across Bob to Alice
    let bot_msg_id = sim.publish(
        "peer-bot",
        "bot",
        parse_json(r#"{"title":"Cetus","buttons":[[{"id":"wf:refresh","label":"Refresh"}]]}"#)?,
        None,
    )?;
    sim.drain()?;
    sim.assert_all_converged(1)?;

    // Alice (not directly connected to Bot!) clicks Refresh -> multi-hop BotAction reaches Bot!
    let (uid, acts) = sim.node_mut("peer-a")?.send_bot_action(
        "peer-bot".to_owned(),
        bot_msg_id.clone(),
        "wf:refresh".to_owned(),
        "Refresh".to_owned(),
        parse_json(r#"{"zone":"cetus"}"#)?,
        12_345,
    )?;
    // Manually route wire frames to capture the final BotActionReceived action on peer-bot
    let mut bot_received = None;
    let mut queue: Vec<(String, String, String)> = Vec::new();
    for act in acts {
        if let MeshAction::SendWire { peer_id, frame } = act {
            queue.push(("peer-a".to_owned(), peer_id, frame));
        }
    }
    let mut idx = 0;
    while idx < queue.len() {
        let (from, to, frame) = queue[idx].clone();
        idx += 1;
        let next_acts = sim.node_mut(&to)?.on_wire_message(&from, &frame, 12_346)?;
        for a in next_acts {
            match a {
                MeshAction::SendWire { peer_id, frame } => queue.push((to.clone(), peer_id, frame)),
                MeshAction::BotActionReceived {
                    action_uid,
                    from_peer_id,
                    message_id,
                    action_id,
                    ..
                } if to == "peer-bot" => {
                    bot_received = Some((action_uid, from_peer_id, message_id, action_id));
                }
                _ => {}
            }
        }
    }
    assert_eq!(
        bot_received,
        Some((uid, "peer-a".to_owned(), bot_msg_id, "wf:refresh".to_owned()))
    );
    Ok(())
}

