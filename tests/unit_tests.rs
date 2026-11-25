#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, HashSet};

use p2p_direct::codec::{
    PROTOCOL_VERSION, SignalCodeKind, SignalCodePayload, decode_signal_code, encode_fragment_url,
    encode_signal_code, extract_fragment_code,
};
use p2p_direct::deflate::{
    base64url_decode, base64url_encode, deflate_raw, inflate_auto, inflate_raw,
};
use p2p_direct::json::{JsonValue, parse_json};
use p2p_direct::log::{LogMessage, ReplicatedLog};
use p2p_direct::protocol::{
    PeerSummary, RelaySignalType, WireFrame, chunk_inv_ids, chunk_sync_messages,
};
use p2p_direct::rpc::dispatch_rpc;

type TestResult = Result<(), String>;

const SAMPLE_SDP: &str = "\
v=0\r\n\
o=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n\
s=-\r\n\
t=0 0\r\n\
a=group:BUNDLE 0\r\n\
a=extmap-allow-mixed\r\n\
a=msid-semantic: WMS\r\n\
m=application 54321 UDP/DTLS/SCTP webrtc-datachannel\r\n\
c=IN IP4 192.0.2.10\r\n\
a=candidate:1467250027 1 udp 2122260223 192.168.1.42 54321 typ host generation 0 network-id 1\r\n\
a=candidate:3849281726 1 udp 1686052607 198.51.100.22 54321 typ srflx raddr 192.168.1.42 rport 54321 generation 0 network-id 1\r\n\
a=candidate:2938471625 1 tcp 1518280447 192.168.1.42 9 typ host tcptype active generation 0 network-id 1\r\n\
a=ice-ufrag:aBcD\r\n\
a=ice-pwd:0123456789abcdef01234567\r\n\
a=ice-options:trickle\r\n\
a=fingerprint:sha-256 12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0\r\n\
a=setup:actpass\r\n\
a=mid:0\r\n\
a=sctp-port:5000\r\n\
a=max-message-size:262144\r\n";

#[test]
fn json_roundtrip_escapes_unicode_and_numbers() -> TestResult {
    let raw = r#"{"str":"hello \"world\"\n\t\\/\u0041\uD83D\uDE80","neg":-42,"big":18446744073709551615,"flt":3.25,"arr":[true,false,null,{"nested":1}]}"#;
    let parsed = parse_json(raw)?;
    let s = parsed.get_str("str").ok_or("missing str")?;
    assert_eq!(s, "hello \"world\"\n\t\\/A\u{1F680}");
    assert_eq!(parsed.get("neg").and_then(JsonValue::as_i64), Some(-42));
    assert_eq!(parsed.get_u64("big"), Some(u64::MAX));

    let serialized = parsed.to_json_string();
    let reparsed = parse_json(&serialized)?;
    assert_eq!(parsed, reparsed);
    Ok(())
}

#[test]
fn json_rejects_malformed_and_deep_nesting() {
    assert!(parse_json("").is_err());
    assert!(parse_json("{1:2}").is_err());
    assert!(parse_json("[1,2,]").is_err());
    assert!(parse_json("\"unterminated").is_err());
    assert!(parse_json("true false").is_err());

    let mut deep = String::new();
    for _ in 0..200 {
        deep.push('[');
    }
    for _ in 0..200 {
        deep.push(']');
    }
    assert!(parse_json(&deep).is_err());
}

#[test]
fn deflate_inflate_roundtrip_all_patterns() -> TestResult {
    // Empty
    let c0 = deflate_raw(b"");
    assert_eq!(inflate_raw(&c0)?, b"");

    // Single byte
    let c1 = deflate_raw(b"Z");
    assert_eq!(inflate_raw(&c1)?, b"Z");

    // Repetitive text
    let rep = "p2p-direct mesh replicated log ".repeat(200);
    let crep = deflate_raw(rep.as_bytes());
    assert!(crep.len() < rep.len() / 5);
    assert_eq!(inflate_raw(&crep)?, rep.as_bytes());

    // Realistic SDP compresses well
    let csdp = deflate_raw(SAMPLE_SDP.as_bytes());
    assert!(
        csdp.len() < (SAMPLE_SDP.len() * 75) / 100,
        "expected SDP to compress well: raw={} compressed={}",
        SAMPLE_SDP.len(),
        csdp.len()
    );
    assert_eq!(inflate_raw(&csdp)?, SAMPLE_SDP.as_bytes());

    // Incompressible pseudo-random bytes (exercises stored block fallback & multi-block > 65535)
    let mut prng: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut random_bytes = Vec::with_capacity(70_000);
    for _ in 0..70_000 {
        prng ^= prng << 13;
        prng ^= prng >> 7;
        prng ^= prng << 17;
        random_bytes.push((prng & 0xFF) as u8);
    }
    let crand = deflate_raw(&random_bytes);
    assert_eq!(inflate_raw(&crand)?, random_bytes);

    // Corrupted inputs never panic
    assert!(inflate_raw(&[0xFF, 0xFF]).is_err());
    assert!(inflate_raw(&[0x00, 0x05, 0x00, 0x00, 0x00]).is_err());
    Ok(())
}

#[test]
fn inflate_supports_standard_dynamic_huffman_and_zlib_streams() -> TestResult {
    // Standard RFC 1950 zlib stream for "Hello, WebRTC P2P Mesh!" (from Python zlib.compress)
    let zlib_bytes: &[u8] = &[
        0x78, 0x9c, 0xf3, 0x48, 0xcd, 0xc9, 0xc9, 0xd7, 0x51, 0x08, 0x4f, 0x4d, 0x0a, 0x0a,
        0x71, 0x56, 0x08, 0x30, 0x0a, 0x50, 0xf0, 0x4d, 0x2d, 0xce, 0x50, 0x04, 0x00, 0x62,
        0x48, 0x07, 0x58,
    ];
    let out = inflate_auto(zlib_bytes)?;
    assert_eq!(out, b"Hello, WebRTC P2P Mesh!");
    Ok(())
}

#[test]
fn base64url_roundtrip_all_remainders() -> TestResult {
    for len in 0..=64 {
        let data: Vec<u8> = (0..len).map(|i| ((i * 37 + 11) & 0xFF) as u8).collect();
        let enc = base64url_encode(&data);
        assert!(!enc.contains('='));
        assert!(!enc.contains('+'));
        assert!(!enc.contains('/'));
        let dec = base64url_decode(&enc)?;
        assert_eq!(dec, data);
    }
    // Tolerates whitespace and padding
    let dec = base64url_decode(" SGVs bG8= \n")?;
    assert_eq!(dec, b"Hello");
    assert!(base64url_decode("abcde").is_err());
    Ok(())
}

#[test]
fn p2p1_codec_and_url_fragments_roundtrip() -> TestResult {
    let offer = SignalCodePayload {
        version: PROTOCOL_VERSION,
        kind: SignalCodeKind::Offer,
        peer_id: "p-alice-01".to_owned(),
        author_name: "Alice".to_owned(),
        room: "mesh-alpha".to_owned(),
        invite_id: "inv-99".to_owned(),
        sdp: SAMPLE_SDP.to_owned(),
    };

    let code = encode_signal_code(&offer)?;
    assert!(code.starts_with("P2P1:"));
    assert!(code.len() < SAMPLE_SDP.len());

    let decoded_direct = decode_signal_code(&code)?;
    assert_eq!(decoded_direct, offer);

    let url = encode_fragment_url("https://lz-er.github.io/p2p-direct/#old=ignored", &offer)?;
    assert!(url.starts_with("https://lz-er.github.io/p2p-direct/#offer=P2P1:"));

    let extracted = extract_fragment_code(&url).ok_or("failed to extract #offer fragment")?;
    assert_eq!(extracted.0, SignalCodeKind::Offer);
    assert_eq!(extracted.1, code);

    let decoded_url = decode_signal_code(&url)?;
    assert_eq!(decoded_url, offer);

    // Percent-encoded fragment variant
    let pct_url = format!("https://example.test/#offer={}", code.replace(':', "%3A"));
    let decoded_pct = decode_signal_code(&pct_url)?;
    assert_eq!(decoded_pct, offer);

    // Mismatched fragment key (#answer= carrying an offer) must be rejected
    let mismatched = format!("https://example.test/#answer={code}");
    assert!(decode_signal_code(&mismatched).is_err());

    // Answer roundtrip
    let answer = SignalCodePayload {
        kind: SignalCodeKind::Answer,
        peer_id: "p-bob-02".to_owned(),
        author_name: "Bob".to_owned(),
        ..offer.clone()
    };
    let ans_url = encode_fragment_url("https://lz-er.github.io/p2p-direct/", &answer)?;
    assert!(ans_url.contains("#answer=P2P1:"));
    assert_eq!(decode_signal_code(&ans_url)?, answer);

    // Invalid prefixes rejected
    assert!(decode_signal_code("P2P2:AAAA").is_err());
    assert!(decode_signal_code("").is_err());
    Ok(())
}

#[test]
fn replicated_log_deterministic_ordering_and_schema() -> TestResult {
    let make_msg = |id: &str, lamport: u64, ts: u64, text: &str| {
        let mut payload = BTreeMap::new();
        payload.insert("text".to_owned(), JsonValue::string(text));
        LogMessage {
            id: id.to_owned(),
            msg_type: "chat".to_owned(),
            lamport,
            ts,
            author: "peer-a".to_owned(),
            author_name: "Alice".to_owned(),
            payload: JsonValue::Object(payload),
        }
    };

    // Permuted insertion orders must yield identical (lamport, ts, id) total order
    let msgs = vec![
        make_msg("id-b", 2, 1000, "second tie b"),
        make_msg("id-a", 2, 1000, "second tie a"),
        make_msg("id-z", 1, 2000, "first high ts"),
        make_msg("id-x", 1, 1500, "first low ts"),
        make_msg("id-c", 2, 999, "second early ts"),
        make_msg("id-m", 5, 100, "highest lamport"),
    ];

    let mut log_fwd = ReplicatedLog::new();
    for m in &msgs {
        assert!(log_fwd.insert(m.clone())?);
    }
    // Duplicate insertion is idempotent
    assert!(!log_fwd.insert(msgs[0].clone())?);

    let mut log_rev = ReplicatedLog::new();
    for m in msgs.iter().rev() {
        assert!(log_rev.insert(m.clone())?);
    }

    let expected_ids = vec!["id-x", "id-z", "id-c", "id-a", "id-b", "id-m"];
    let fwd_ids: Vec<&str> = log_fwd.ordered().map(|m| m.id.as_str()).collect();
    let rev_ids: Vec<&str> = log_rev.ordered().map(|m| m.id.as_str()).collect();
    assert_eq!(fwd_ids, expected_ids);
    assert_eq!(rev_ids, expected_ids);
    assert_eq!(log_fwd.lamport(), 5);

    // Local append must strictly exceed max observed lamport
    let local = log_fwd.append_local(
        "local-6".to_owned(),
        "metric".to_owned(),
        3000,
        "peer-b".to_owned(),
        "Bob".to_owned(),
        parse_json(r#"{"cpu":0.42,"tags":["mesh","wasm"]}"#)?,
    )?;
    assert_eq!(local.lamport, 6);

    // Verify exact machine-readable JSON field names
    let parsed_msg = parse_json(&local.to_json_string())?;
    assert_eq!(parsed_msg.get_str("id"), Some("local-6"));
    assert_eq!(parsed_msg.get_str("type"), Some("metric"));
    assert_eq!(parsed_msg.get_u64("lamport"), Some(6));
    assert_eq!(parsed_msg.get_u64("ts"), Some(3000));
    assert_eq!(parsed_msg.get_str("author"), Some("peer-b"));
    assert_eq!(parsed_msg.get_str("authorName"), Some("Bob"));
    assert!(parsed_msg.get("payload").is_some());

    // Snapshot persistence roundtrip
    let snap_str = log_fwd.export_snapshot_json();
    let snap_val = parse_json(&snap_str)?;
    let mut restored = ReplicatedLog::new();
    let added = restored.import_snapshot_value(&snap_val)?;
    assert_eq!(added, log_fwd.len());
    assert_eq!(restored.ids_ordered(), log_fwd.ids_ordered());
    assert_eq!(restored.lamport(), log_fwd.lamport());

    // missing_for returns exact ordered diff
    let known: HashSet<String> = ["id-x", "id-a", "local-6"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    let diff_ids: Vec<String> = restored
        .missing_for(&known)
        .into_iter()
        .map(|m| m.id)
        .collect();
    assert_eq!(diff_ids, vec!["id-z", "id-c", "id-b", "id-m"]);
    Ok(())
}

#[test]
fn wire_frames_and_chunking_roundtrip() -> TestResult {
    let msg = LogMessage {
        id: "m-1".to_owned(),
        msg_type: "event".to_owned(),
        lamport: 7,
        ts: 1_700_000_000_000,
        author: "p-1".to_owned(),
        author_name: "Node1".to_owned(),
        payload: parse_json(r#"{"k":"v","n":123}"#)?,
    };

    let frames = vec![
        WireFrame::Hello {
            peer_id: "p-1".to_owned(),
            author_name: "Node1".to_owned(),
            room: "main".to_owned(),
            lamport: 7,
            log_count: 1,
            peers: vec![PeerSummary {
                peer_id: "p-2".to_owned(),
                author_name: "Node2".to_owned(),
            }],
        },
        WireFrame::Msg {
            origin: "p-1".to_owned(),
            ttl: 12,
            path: vec!["p-1".to_owned(), "p-2".to_owned()],
            message: msg.clone(),
        },
        WireFrame::SyncInv {
            from: "p-1".to_owned(),
            inv_id: "inv-1".to_owned(),
            part: 0,
            total_parts: 2,
            lamport: 7,
            ids: vec!["m-1".to_owned()],
        },
        WireFrame::SyncReq {
            from: "p-2".to_owned(),
            ids: vec!["m-1".to_owned()],
        },
        WireFrame::SyncBatch {
            from: "p-1".to_owned(),
            batch_id: "b-1".to_owned(),
            chunk: 0,
            total_chunks: 1,
            messages: vec![msg.clone()],
        },
        WireFrame::MeshIntro {
            via: "p-2".to_owned(),
            peer_id: "p-3".to_owned(),
            author_name: "Node3".to_owned(),
        },
        WireFrame::RelaySignal {
            from: "p-1".to_owned(),
            from_name: "Node1".to_owned(),
            to: "p-3".to_owned(),
            via: "p-2".to_owned(),
            hops: vec!["p-1".to_owned()],
            ttl: 6,
            signal_type: RelaySignalType::Offer,
            sdp: Some("v=0\r\n".to_owned()),
            candidate: None,
        },
    ];

    for frame in frames {
        let encoded = frame.to_json_string();
        let decoded = WireFrame::parse_json(&encoded)?;
        assert_eq!(decoded, frame);
    }

    // Empty inventory still produces 1 part so joining peers announce empty state
    assert_eq!(chunk_inv_ids(&[], 10).len(), 1);
    assert_eq!(chunk_inv_ids(&["a".to_owned(), "b".to_owned(), "c".to_owned()], 2).len(), 2);

    // Chunk sync messages respects both count and byte budget
    let many: Vec<LogMessage> = (0..15)
        .map(|i| LogMessage {
            id: format!("msg-{i}"),
            ..msg.clone()
        })
        .collect();
    let chunks = chunk_sync_messages(&many, 4, 12_000);
    assert_eq!(chunks.len(), 4);
    let total: usize = chunks.iter().map(Vec::len).sum();
    assert_eq!(total, 15);
    Ok(())
}

#[test]
fn rpc_dispatcher_end_to_end() -> TestResult {
    let mut state = None;

    // Uninitialized command returns ok:false
    let err_resp = parse_json(&dispatch_rpc(&mut state, r#"{"cmd":"get_state"}"#))?;
    assert_eq!(err_resp.get_bool("ok"), Some(false));

    // Init
    let init_resp = parse_json(&dispatch_rpc(
        &mut state,
        r#"{"cmd":"init","peerId":"p-rpc-1","authorName":"Alice","room":"demo"}"#,
    ))?;
    assert_eq!(init_resp.get_bool("ok"), Some(true));

    // Publish structured message
    let pub_resp = parse_json(&dispatch_rpc(
        &mut state,
        r#"{"cmd":"publish","type":"task","payload":{"title":"ship wasm","done":true},"ts":1700000000001}"#,
    ))?;
    assert_eq!(pub_resp.get_bool("ok"), Some(true));
    assert_eq!(
        pub_resp.get("message").and_then(|m| m.get_u64("lamport")),
        Some(1)
    );

    // Encode + decode P2P1 signal via RPC
    let enc_req = format!(
        r#"{{"cmd":"encode_signal","kind":"offer","inviteId":"i1","sdp":{},"baseUrl":"https://lz-er.github.io/p2p-direct/"}}"#,
        JsonValue::string(SAMPLE_SDP).to_json_string()
    );
    let enc_resp = parse_json(&dispatch_rpc(&mut state, &enc_req))?;
    assert_eq!(enc_resp.get_bool("ok"), Some(true));
    let url = enc_resp.get_str("url").ok_or("missing url")?;
    assert!(url.contains("#offer=P2P1:"));

    let dec_req = format!(
        r#"{{"cmd":"decode_signal","input":{}}}"#,
        JsonValue::string(url).to_json_string()
    );
    let dec_resp = parse_json(&dispatch_rpc(&mut state, &dec_req))?;
    assert_eq!(dec_resp.get_bool("ok"), Some(true));
    assert_eq!(
        dec_resp.get("signal").and_then(|s| s.get_str("peerId")),
        Some("p-rpc-1")
    );

    // Export, clear, and re-import snapshot
    let exp = parse_json(&dispatch_rpc(&mut state, r#"{"cmd":"export_snapshot"}"#))?;
    let snap = exp.get("snapshot").ok_or("missing snapshot")?;
    let clr = parse_json(&dispatch_rpc(&mut state, r#"{"cmd":"clear_log"}"#))?;
    assert_eq!(
        clr.get("status").and_then(|s| s.get_u64("logCount")),
        Some(0)
    );
    let imp_req = format!(
        r#"{{"cmd":"import_snapshot","snapshot":{}}}"#,
        snap.to_json_string()
    );
    let imp = parse_json(&dispatch_rpc(&mut state, &imp_req))?;
    assert_eq!(imp.get_u64("added"), Some(1));
    Ok(())
}
