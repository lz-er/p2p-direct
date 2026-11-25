#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use p2p_direct::json::{JsonValue, parse_json};
use p2p_direct::mesh::{MeshAction, MeshConfig, MeshNode};
use p2p_direct::protocol::RelaySignalType;

type TestResult = Result<(), String>;

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
        self.nodes.insert(
            peer_id.to_owned(),
            MeshNode::new(peer_id.to_owned(), name.to_owned(), "sim-room".to_owned(), config),
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

    fn connect(&mut self, a: &str, b: &str, via_auto_mesh: bool, introducer: Option<&str>) -> TestResult {
        let edge = Self::canonical_edge(a, b);
        if self.links.contains(&edge) {
            return Ok(());
        }
        let name_a = self.node(a)?.author_name().to_owned();
        let name_b = self.node(b)?.author_name().to_owned();
        self.links.insert(edge);

        let acts_a = self.node_mut(a)?.on_peer_connected(
            b.to_owned(),
            name_b,
            via_auto_mesh,
            introducer.map(str::to_owned),
        );
        let acts_b = self.node_mut(b)?.on_peer_connected(
            a.to_owned(),
            name_a,
            via_auto_mesh,
            introducer.map(str::to_owned),
        );
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

    fn publish(&mut self, peer_id: &str, msg_type: &str, payload: JsonValue, ts_override: Option<u64>) -> Result<String, String> {
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
                    let edge = Self::canonical_edge(actor, &peer_id);
                    if self.links.contains(&edge) {
                        self.queue.push_back(QueuedFrame {
                            from: actor.to_owned(),
                            to: peer_id,
                            frame,
                        });
                    }
                }
                MeshAction::AutoMeshCreateOffer {
                    target_peer_id,
                    via_peer_id,
                    ..
                } => {
                    // Simulate browser creating RTCPeerConnection offer and relaying it through `via_peer_id`
                    let fake_sdp = format!("v=0\r\no=offer-{actor}-to-{target_peer_id}\r\n");
                    let relay_acts = self.node_mut(actor)?.send_relay_signal(
                        target_peer_id.clone(),
                        RelaySignalType::Offer,
                        Some(fake_sdp),
                        None,
                        Some(via_peer_id.clone()),
                    )?;
                    self.process_actions(actor, relay_acts)?;

                    // Also trickle a simulated ICE candidate
                    let ice_val = parse_json(r#"{"candidate":"candidate:1 1 udp 2122260223 127.0.0.1 50000 typ host","sdpMid":"0"}"#)?;
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
                    let fake_ans = format!("v=0\r\no=answer-{actor}-to-{from_peer_id}\r\n");
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
                    // WebRTC SDP handshake completed -> schedule direct DataChannel open!
                    self.pending_webrtc.push_back(PendingDirectConn {
                        a: actor.to_owned(),
                        b: from_peer_id,
                        via: "relay".to_owned(),
                    });
                }
                MeshAction::AutoMeshAddIce { .. }
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
                if !self.links.contains(&edge) {
                    continue;
                }
                if !self.nodes.contains_key(&qf.to) {
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

        // Verify strict (lamport, ts, id) deterministic ascending order
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
fn sim_two_peer_bidirectional_backfill() -> TestResult {
    let mut sim = SimNetwork::new(2_000);
    sim.add_node("peer-a", "Alice", MeshConfig::default());
    sim.add_node("peer-b", "Bob", MeshConfig::default());

    for i in 0..10 {
        sim.publish(
            "peer-a",
            "chat",
            parse_json(&format!(r#"{{"text":"alice-{i}"}}"#))?,
            None,
        )?;
    }
    for i in 0..5 {
        sim.publish(
            "peer-b",
            "event",
            parse_json(&format!(r#"{{"seq":{i},"from":"bob"}}"#))?,
            None,
        )?;
    }

    sim.connect("peer-a", "peer-b", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(15)?;
    assert!(sim.node("peer-a")?.stats().sync_batches_sent >= 1);
    assert!(sim.node("peer-b")?.stats().sync_batches_sent >= 1);
    Ok(())
}

#[test]
fn sim_chunked_sync_inv_and_batch_backfill_old_and_new() -> TestResult {
    let small_chunks = MeshConfig {
        inv_chunk_ids: 15,
        batch_max_msgs: 7,
        batch_max_bytes: 2_000,
        ..MeshConfig::default()
    };
    let mut sim = SimNetwork::new(10_000);
    sim.add_node("peer-a", "Alice", small_chunks.clone());
    sim.add_node("peer-b", "Bob", small_chunks);

    // 65 historical messages on Alice before Bob ever joins
    for i in 0..65 {
        sim.publish(
            "peer-a",
            "record",
            parse_json(&format!(r#"{{"index":{i},"body":"historical payload {i}"}}"#))?,
            None,
        )?;
    }

    // Bob joins late with 0 messages -> multi-part sync-inv + multi-chunk sync-batch backfill
    sim.connect("peer-a", "peer-b", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(65)?;
    assert!(
        sim.node("peer-a")?.stats().sync_inv_sent >= 5,
        "expected >=5 sync-inv parts for 65 messages at 15/chunk"
    );
    assert!(
        sim.node("peer-a")?.stats().sync_batches_sent >= 10,
        "expected >=10 sync-batch chunks for 65 messages at 7/chunk"
    );

    // Disconnect Bob, both produce new offline messages
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

    // Reconnect Bob -> both old and new missing messages reconcile
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

    // Ring with cross chords (multiple overlapping cycles!)
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

    // Every node publishes 3 messages
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
    assert!(total_forwards > 0, "expected multi-hop gossip forwards");
    assert!(
        total_drops > 0,
        "expected cyclic duplicate suppression drops"
    );
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

    // Two disconnected clusters: (p1-p2-p3) and (p4-p5-p6)
    sim.connect("p1", "p2", false, None)?;
    sim.connect("p2", "p3", false, None)?;
    sim.connect("p4", "p5", false, None)?;
    sim.connect("p5", "p6", false, None)?;
    sim.drain()?;

    // Publish concurrent messages with identical timestamps & colliding lamport values!
    let shared_ts = Some(1_700_000_555_000);
    for i in 0..4 {
        sim.publish("p1", "chat", parse_json(&format!(r#"{{"c":1,"i":{i}}}"#))?, shared_ts)?;
        sim.publish("p6", "chat", parse_json(&format!(r#"{{"c":2,"i":{i}}}"#))?, shared_ts)?;
        sim.drain()?;
    }
    sim.publish("p3", "state", parse_json(r#"{"cluster":"left"}"#)?, shared_ts)?;
    sim.publish("p4", "state", parse_json(r#"{"cluster":"right"}"#)?, shared_ts)?;
    sim.drain()?;

    // Heal partition via a single bridge link p3 -- p4
    sim.connect("p3", "p4", false, None)?;
    sim.drain()?;

    // All 6 nodes across both formerly partitioned clusters must converge to identical order!
    sim.assert_all_converged(10)?;
    Ok(())
}

#[test]
fn sim_relayed_auto_mesh_introduction_and_log_survival_through_churn() -> TestResult {
    let mut sim = SimNetwork::new(5_000);
    sim.add_node("p-alice", "Alice", MeshConfig::default());
    sim.add_node("p-bob", "Bob", MeshConfig::default());
    sim.add_node("p-carol", "Carol", MeshConfig::default());

    // Alice publishes historical messages before anyone else joins
    for i in 0..5 {
        sim.publish(
            "p-alice",
            "genesis",
            parse_json(&format!(r#"{{"origin":"alice","seq":{i}}}"#))?,
            None,
        )?;
    }

    // Alice -- Bob manual connect
    sim.connect("p-alice", "p-bob", false, None)?;
    sim.drain()?;
    assert_eq!(sim.node("p-bob")?.log().len(), 5);

    // Carol joins Bob manually -> Bob introduces Alice & Carol -> direct WebRTC link Alice <-> Carol forms!
    sim.connect("p-bob", "p-carol", false, None)?;
    sim.drain()?;

    assert!(
        sim.node("p-alice")?.is_connected_to("p-carol"),
        "expected relayed auto-mesh direct connection from Alice to Carol"
    );
    assert!(
        sim.node("p-carol")?.is_connected_to("p-alice"),
        "expected relayed auto-mesh direct connection from Carol to Alice"
    );
    assert!(sim.node("p-bob")?.stats().auto_mesh_intros_sent >= 2);
    assert!(sim.node("p-bob")?.stats().relay_signals_forwarded >= 2);
    sim.assert_all_converged(5)?;

    // Now Bob (the introducer!) leaves completely
    sim.remove_node("p-bob")?;

    // Alice and Carol continue communicating directly without Bob
    sim.publish("p-alice", "chat", parse_json(r#"{"text":"still direct!"}"#)?, None)?;
    sim.publish("p-carol", "chat", parse_json(r#"{"text":"bob is gone, mesh alive"}"#)?, None)?;
    sim.drain()?;
    assert_eq!(sim.node("p-alice")?.log().len(), 7);
    assert_eq!(sim.node("p-carol")?.log().len(), 7);

    // Now Alice (original creator!) leaves too; only Carol remains!
    sim.remove_node("p-alice")?;
    assert_eq!(sim.node("p-carol")?.log().len(), 7);

    // New peer Dave joins Carol (the sole survivor) -> receives all 7 messages including Alice's genesis history!
    sim.add_node("p-dave", "Dave", MeshConfig::default());
    sim.connect("p-carol", "p-dave", false, None)?;
    sim.drain()?;
    sim.assert_all_converged(7)?;

    // Verify Alice's original genesis messages survived on Dave after both Alice & Bob left!
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
fn sim_four_node_chain_auto_meshes_into_full_clique() -> TestResult {
    let mut sim = SimNetwork::new(10_000);
    let ids = ["peer-1", "peer-2", "peer-3", "peer-4"];
    for id in ids {
        sim.add_node(id, id, MeshConfig::default());
    }

    // Initial chain: peer-1 -- peer-2 -- peer-3 -- peer-4
    sim.connect("peer-1", "peer-2", false, None)?;
    sim.drain()?;
    sim.connect("peer-2", "peer-3", false, None)?;
    sim.drain()?;
    sim.connect("peer-3", "peer-4", false, None)?;
    sim.drain()?;

    // Every node should end up directly connected to all 3 other nodes (full K4 mesh!)
    for id in ids {
        let peers = sim.node(id)?.connected_peer_ids();
        assert_eq!(
            peers.len(),
            3,
            "expected full mesh (3 direct peers) on {id}, got {:?}",
            peers
        );
    }

    // Publish from each node and confirm convergence
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

    // Bob wipes local log and requests one-sided anti-entropy sync -> Alice backfills everything!
    sim.node_mut("peer-b")?.reset_local_log();
    assert_eq!(sim.node("peer-b")?.log().len(), 0);
    sim.request_sync("peer-b")?;
    sim.drain()?;
    sim.assert_all_converged(12)?;
    Ok(())
}
