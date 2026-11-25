#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, HashSet};

use p2p_direct::audio::{VoiceCaptureDsp48k, compute_rms_i16, decode_ima_adpcm, encode_ima_adpcm};
use p2p_direct::codec::{
    PROTOCOL_VERSION, SignalCodeKind, SignalCodePayload, decode_signal_code, encode_fragment_url,
    encode_signal_code, extract_fragment_code,
};
use p2p_direct::crypto::{
    SafeCsprng, aead_open, aead_open_into, aead_seal, aead_seal_into, derive_all_link_keys,
    derive_invite_wrap_key, derive_link_keys, derive_log_key, derive_mesh_key_from_passphrase,
    derive_voice_link_keys, hkdf_extract, key_fingerprint, pair_safety_code, sha256, x25519,
    x25519_public_key, x25519_shared_secret,
};
use p2p_direct::deflate::{
    base64url_decode, base64url_encode, deflate_raw, inflate_auto, inflate_raw,
};
use p2p_direct::json::{JsonValue, parse_json, parse_json_object_skipping_field};
use p2p_direct::log::{LogMessage, ReplicatedLog, SealedLogRecord};
use p2p_direct::mesh::{MeshConfig, MeshNode};
use p2p_direct::protocol::{
    EncryptedWireEnvelope, PeerSummary, RelaySignalBody, RelaySignalType, WireFrame, chunk_inv_ids,
    chunk_sealed_records, open_voice_packet_ciphertext, open_voice_v2_packet_ciphertext,
    parse_voice_packet_header, parse_voice_v2_packet_header, seal_voice_packet,
    seal_voice_v2_packet,
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

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    let bytes = s.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err("odd hex length".to_owned());
    }
    let hex_nibble = |b: u8| -> Result<u8, String> {
        match b {
            b'0'..=b'9' => Ok(b - b'0'),
            b'a'..=b'f' => Ok(b - b'a' + 10),
            b'A'..=b'F' => Ok(b - b'A' + 10),
            _ => Err(format!("invalid hex byte 0x{b:02x}")),
        }
    };
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_nibble(*bytes.get(i).ok_or("oob")?)?;
        let lo = hex_nibble(*bytes.get(i + 1).ok_or("oob")?)?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn decode_hex_32(s: &str) -> Result<[u8; 32], String> {
    let v = decode_hex(s)?;
    if v.len() != 32 {
        return Err("expected 32 bytes".to_owned());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&v);
    Ok(arr)
}

fn decode_hex_12(s: &str) -> Result<[u8; 12], String> {
    let v = decode_hex(s)?;
    if v.len() != 12 {
        return Err("expected 12 bytes".to_owned());
    }
    let mut arr = [0u8; 12];
    arr.copy_from_slice(&v);
    Ok(arr)
}

/* ==================== Official Cryptographic RFC Test Vectors ==================== */

#[test]
fn crypto_sha256_and_hkdf_official_vectors() -> TestResult {
    assert_eq!(
        sha256(b"abc").as_slice(),
        decode_hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")?.as_slice()
    );
    assert_eq!(
        sha256(b"").as_slice(),
        decode_hex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")?.as_slice()
    );

    // RFC 5869 Test Case 1 PRK
    let ikm = [0x0bu8; 22];
    let salt = decode_hex("000102030405060708090a0b0c")?;
    let prk = hkdf_extract(&salt, &ikm);
    assert_eq!(
        prk.as_slice(),
        decode_hex("077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5")?.as_slice()
    );
    Ok(())
}

#[test]
fn crypto_rfc8439_chacha20_poly1305_aead_vector() -> TestResult {
    // RFC 8439 Section 2.8.2 Sunscreen test vector
    let key = decode_hex_32("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")?;
    let nonce = decode_hex_12("070000004041424344454647")?;
    let aad = decode_hex("50515253c0c1c2c3c4c5c6c7")?;
    let plaintext = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";

    let expected_ct = decode_hex(
        "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6\
         3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36\
         92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc\
         3ff4def08e4b7a9de576d26586cec64b6116",
    )?;
    let expected_tag = decode_hex("1ae10b594f09e26a7e902ecbd0600691")?;

    let sealed = aead_seal(&key, &nonce, &aad, plaintext);
    assert_eq!(sealed.len(), expected_ct.len() + 16);
    assert_eq!(sealed.get(..expected_ct.len()), Some(expected_ct.as_slice()));
    assert_eq!(sealed.get(expected_ct.len()..), Some(expected_tag.as_slice()));

    let opened = aead_open(&key, &nonce, &aad, &sealed)?;
    assert_eq!(opened.as_slice(), plaintext.as_slice());

    // Tampering with ciphertext, tag, or AAD MUST fail authentication
    let mut bad_ct = sealed.clone();
    if let Some(first) = bad_ct.first_mut() {
        *first ^= 0x01;
    }
    assert!(aead_open(&key, &nonce, &aad, &bad_ct).is_err());

    let mut bad_tag = sealed.clone();
    if let Some(last) = bad_tag.last_mut() {
        *last ^= 0x80;
    }
    assert!(aead_open(&key, &nonce, &aad, &bad_tag).is_err());
    assert!(aead_open(&key, &nonce, b"wrong-aad", &sealed).is_err());
    Ok(())
}

#[test]
fn crypto_rfc7748_x25519_vectors_and_low_order_rejection() -> TestResult {
    // RFC 7748 Section 6.1 Alice & Bob key exchange
    let alice_sk =
        decode_hex_32("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")?;
    let alice_pk_exp =
        decode_hex_32("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")?;
    let bob_sk =
        decode_hex_32("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")?;
    let bob_pk_exp =
        decode_hex_32("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")?;
    let shared_exp =
        decode_hex_32("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")?;

    let alice_pk = x25519_public_key(&alice_sk);
    let bob_pk = x25519_public_key(&bob_sk);
    assert_eq!(alice_pk, alice_pk_exp);
    assert_eq!(bob_pk, bob_pk_exp);

    let s_ab = x25519_shared_secret(&alice_sk, &bob_pk)?;
    let s_ba = x25519_shared_secret(&bob_sk, &alice_pk)?;
    assert_eq!(s_ab, shared_exp);
    assert_eq!(s_ba, shared_exp);

    // Symmetric pair safety code matches on both endpoints
    let mesh_key = [0x42u8; 32];
    assert_eq!(
        pair_safety_code(&alice_pk, &bob_pk, &mesh_key),
        pair_safety_code(&bob_pk, &alice_pk, &mesh_key)
    );

    // RFC 7748 Section 5.2: 1,000-iteration test vector
    let mut k = [0u8; 32];
    k[0] = 9;
    let mut u = k;
    for _ in 0..1000 {
        let next = x25519(&k, &u);
        u = k;
        k = next;
    }
    let exp_1000 =
        decode_hex_32("684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51")?;
    assert_eq!(k, exp_1000);

    // Low-order all-zero point must be rejected
    assert!(x25519_shared_secret(&alice_sk, &[0u8; 32]).is_err());
    Ok(())
}

/* ==================== JSON, DEFLATE, P2P1, Log, Protocol, RPC ==================== */

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
    let c0 = deflate_raw(b"");
    assert_eq!(inflate_raw(&c0)?, b"");

    let c1 = deflate_raw(b"Z");
    assert_eq!(inflate_raw(&c1)?, b"Z");

    let rep = "p2p-direct mesh replicated log ".repeat(200);
    let crep = deflate_raw(rep.as_bytes());
    assert!(crep.len() < rep.len() / 5);
    assert_eq!(inflate_raw(&crep)?, rep.as_bytes());

    let csdp = deflate_raw(SAMPLE_SDP.as_bytes());
    assert!(csdp.len() < (SAMPLE_SDP.len() * 75) / 100);
    assert_eq!(inflate_raw(&csdp)?, SAMPLE_SDP.as_bytes());

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

    assert!(inflate_raw(&[0xFF, 0xFF]).is_err());
    assert!(inflate_raw(&[0x00, 0x05, 0x00, 0x00, 0x00]).is_err());
    Ok(())
}

#[test]
fn inflate_supports_standard_dynamic_huffman_and_zlib_streams() -> TestResult {
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
    let dec = base64url_decode(" SGVs bG8= \n")?;
    assert_eq!(dec, b"Hello");
    assert!(base64url_decode("abcde").is_err());
    Ok(())
}

#[test]
fn p2p1_codec_url_fragments_and_passphrase_encryption() -> TestResult {
    let mut rng = SafeCsprng::from_seed(b"unit-test-codec-seed");
    let pub_key = x25519_public_key(&[0x11u8; 32]);
    let mesh_key = [0x22u8; 32];

    let offer = SignalCodePayload {
        version: PROTOCOL_VERSION,
        kind: SignalCodeKind::Offer,
        peer_id: "p-alice-01".to_owned(),
        author_name: "Alice".to_owned(),
        room: "mesh-alpha".to_owned(),
        invite_id: "inv-99".to_owned(),
        pub_key,
        mesh_key: Some(mesh_key),
        sdp: SAMPLE_SDP.to_owned(),
        relay: None,
    };

    // Standard P2P1 invite carrying X25519 pubKey + meshKey in #offer= fragment
    let code = encode_signal_code(&offer, None, &mut rng)?;
    assert!(code.starts_with("P2P1:"));

    let (decoded_direct, was_enc) = decode_signal_code(&code, None)?;
    assert!(!was_enc);
    assert_eq!(decoded_direct, offer);

    let url = encode_fragment_url("https://lz-er.github.io/p2p-direct/#old=ignored", &offer, None, &mut rng)?;
    assert!(url.starts_with("https://lz-er.github.io/p2p-direct/#offer=P2P1:"));
    let extracted = extract_fragment_code(&url).ok_or("failed to extract #offer fragment")?;
    assert_eq!(extracted.0, SignalCodeKind::Offer);
    assert_eq!(extracted.1, code);
    let (decoded_url, _) = decode_signal_code(&url, None)?;
    assert_eq!(decoded_url, offer);

    // Mismatched fragment key (#answer= carrying an offer) must be rejected
    let mismatched = format!("https://example.test/#answer={code}");
    assert!(decode_signal_code(&mismatched, None).is_err());

    // Passphrase-encrypted P2P1 invite (ChaCha20-Poly1305 wrapped, meshKey omitted!)
    let pass_mk = derive_mesh_key_from_passphrase("correct-horse-battery-staple");
    let wrap_key = derive_invite_wrap_key(&pass_mk);
    let wrong_wrap = derive_invite_wrap_key(&derive_mesh_key_from_passphrase("wrong-pass"));

    let enc_url = encode_fragment_url(
        "https://lz-er.github.io/p2p-direct/",
        &offer,
        Some(&wrap_key),
        &mut rng,
    )?;
    assert!(enc_url.contains("#offer=P2P1:"));

    // Fails without passphrase or with wrong passphrase
    assert!(decode_signal_code(&enc_url, None).is_err());
    assert!(decode_signal_code(&enc_url, Some(&wrong_wrap)).is_err());

    // Succeeds with matching passphrase and omits raw meshKey from wire invite
    let (dec_enc, was_pass_enc) = decode_signal_code(&enc_url, Some(&wrap_key))?;
    assert!(was_pass_enc);
    assert_eq!(dec_enc.peer_id, "p-alice-01");
    assert_eq!(dec_enc.pub_key, pub_key);
    assert_eq!(dec_enc.mesh_key, None);
    assert_eq!(dec_enc.sdp, SAMPLE_SDP);
    Ok(())
}

#[test]
fn long_lived_room_invite_codec_and_encrypted_rendezvous_signals() -> TestResult {
    let mut rng = SafeCsprng::from_seed(b"unit-test-room-invite");
    let mesh_key = [0x6Bu8; 32];

    let room_payload = SignalCodePayload {
        version: PROTOCOL_VERSION,
        kind: SignalCodeKind::Room,
        peer_id: String::new(),
        author_name: String::new(),
        room: "Friday Hangout".to_owned(),
        invite_id: String::new(),
        pub_key: [0u8; 32],
        mesh_key: Some(mesh_key),
        sdp: String::new(),
        relay: Some("wss://relay.example/mqtt".to_owned()),
    };

    let url = encode_fragment_url(
        "https://lz-er.github.io/p2p-direct/",
        &room_payload,
        None,
        &mut rng,
    )?;
    assert!(url.starts_with("https://lz-er.github.io/p2p-direct/#room=P2P1:"));
    // Compact room invite link without SDP stays very short
    assert!(url.len() < 260, "expected compact room URL, got {} chars", url.len());

    let (kind, code) = extract_fragment_code(&url).ok_or("missing #room fragment")?;
    assert_eq!(kind, SignalCodeKind::Room);
    let (decoded, was_enc) = decode_signal_code(&url, None)?;
    assert!(!was_enc);
    assert_eq!(decoded.kind, SignalCodeKind::Room);
    assert_eq!(decoded.room, "Friday Hangout");
    assert_eq!(decoded.mesh_key, Some(mesh_key));
    assert_eq!(decoded.relay.as_deref(), Some("wss://relay.example/mqtt"));

    // #join= alias is also accepted for room invites
    let join_alias = format!("https://lz-er.github.io/p2p-direct/#join={code}");
    let (dec_alias, _) = decode_signal_code(&join_alias, None)?;
    assert_eq!(dec_alias.kind, SignalCodeKind::Room);
    assert_eq!(dec_alias.mesh_key, Some(mesh_key));

    // Passphrase-protected long-lived room invite omits meshKey and requires matching passphrase
    let pass_mk = derive_mesh_key_from_passphrase("secret-room-pass");
    let wrap = derive_invite_wrap_key(&pass_mk);
    let enc_room_url = encode_fragment_url(
        "https://lz-er.github.io/p2p-direct/",
        &room_payload,
        Some(&wrap),
        &mut rng,
    )?;
    assert!(decode_signal_code(&enc_room_url, None).is_err());
    let (dec_pass_room, is_pass_enc) = decode_signal_code(&enc_room_url, Some(&wrap))?;
    assert!(is_pass_enc);
    assert_eq!(dec_pass_room.kind, SignalCodeKind::Room);
    assert_eq!(dec_pass_room.mesh_key, None);
    assert_eq!(dec_pass_room.room, "Friday Hangout");

    // RPC end-to-end: encode_room_invite, seal_room_signal, open_room_signal
    let mut node_a = None;
    let mut node_b = None;
    let mut node_eve = None;
    let mk_b64 = base64url_encode(&mesh_key);
    let eve_mk_b64 = base64url_encode(&[0xEEu8; 32]);
    let init_a = format!(
        r#"{{"cmd":"init","peerId":"p-a","authorName":"Alice","room":"Lounge","x25519Secret":"{}","meshKey":"{mk_b64}","entropy":"{}"}}"#,
        base64url_encode(&[0x11u8; 32]),
        base64url_encode(&[0xA1u8; 32]),
    );
    let init_b = format!(
        r#"{{"cmd":"init","peerId":"p-b","authorName":"Bob","room":"Lounge","x25519Secret":"{}","meshKey":"{mk_b64}","entropy":"{}"}}"#,
        base64url_encode(&[0x22u8; 32]),
        base64url_encode(&[0xB2u8; 32]),
    );
    let init_eve = format!(
        r#"{{"cmd":"init","peerId":"p-eve","authorName":"Eve","room":"Lounge","x25519Secret":"{}","meshKey":"{eve_mk_b64}","entropy":"{}"}}"#,
        base64url_encode(&[0x33u8; 32]),
        base64url_encode(&[0xC3u8; 32]),
    );
    assert_eq!(parse_json(&dispatch_rpc(&mut node_a, &init_a))?.get_bool("ok"), Some(true));
    assert_eq!(parse_json(&dispatch_rpc(&mut node_b, &init_b))?.get_bool("ok"), Some(true));
    assert_eq!(parse_json(&dispatch_rpc(&mut node_eve, &init_eve))?.get_bool("ok"), Some(true));

    let inv_resp = parse_json(&dispatch_rpc(
        &mut node_a,
        r#"{"cmd":"encode_room_invite","room":"Lounge","baseUrl":"https://lz-er.github.io/p2p-direct/"}"#,
    ))?;
    assert_eq!(inv_resp.get_bool("ok"), Some(true));
    let inv_topic = inv_resp.get_str("roomTopic").ok_or("missing roomTopic")?;
    assert_eq!(inv_topic.len(), 32);
    // Opaque topic must not contain room name
    assert!(!inv_topic.to_lowercase().contains("lounge"));

    // Alice seals an SDP offer signal; ciphertext must leak ZERO SDP or IP info
    let sig_plain = r#"{"t":"offer","from":"p-a","to":"p-b","sdp":"v=0\r\nc=IN IP4 198.51.100.99\r\n"}"#;
    let seal_req = format!(
        r#"{{"cmd":"seal_room_signal","payload":{}}}"#,
        JsonValue::string(sig_plain).to_json_string()
    );
    let seal_resp = parse_json(&dispatch_rpc(&mut node_a, &seal_req))?;
    assert_eq!(seal_resp.get_bool("ok"), Some(true));
    let sealed = seal_resp.get_str("sealed").ok_or("missing sealed")?;
    assert!(sealed.starts_with("R1:"));
    assert!(!sealed.contains("198.51.100.99"));
    assert!(!sealed.contains("v=0"));
    assert!(!sealed.contains("offer"));

    // Bob (same room key) decrypts cleanly
    let open_req = format!(
        r#"{{"cmd":"open_room_signal","sealed":{}}}"#,
        JsonValue::string(sealed).to_json_string()
    );
    let open_b = parse_json(&dispatch_rpc(&mut node_b, &open_req))?;
    assert_eq!(open_b.get_bool("ok"), Some(true));
    assert_eq!(open_b.get_str("payload"), Some(sig_plain));

    // Eve (different room key) MUST fail Poly1305 AEAD verification
    let open_eve = parse_json(&dispatch_rpc(&mut node_eve, &open_req))?;
    assert_eq!(open_eve.get_bool("ok"), Some(false));

    // Tampered R1 ciphertext MUST fail verification on Bob
    let mut tampered = sealed.to_owned().into_bytes();
    if let Some(last) = tampered.last_mut() {
        *last = if *last == b'A' { b'B' } else { b'A' };
    }
    let tampered_str = String::from_utf8(tampered).map_err(|_| "utf8")?;
    let tamper_req = format!(
        r#"{{"cmd":"open_room_signal","sealed":{}}}"#,
        JsonValue::string(&tampered_str).to_json_string()
    );
    assert_eq!(
        parse_json(&dispatch_rpc(&mut node_b, &tamper_req))?.get_bool("ok"),
        Some(false)
    );
    Ok(())
}

#[test]
fn replicated_log_deterministic_ordering_and_e2ee_snapshot_persistence() -> TestResult {
    let mut rng = SafeCsprng::from_seed(b"unit-test-log-seed");
    let mesh_key = [0x77u8; 32];
    let log_key = derive_log_key(&mesh_key);
    let wrong_log_key = derive_log_key(&[0x88u8; 32]);
    let fp = key_fingerprint(&mesh_key);

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

    let msgs = vec![
        make_msg("id-b", 2, 1000, "secret-second-tie-b"),
        make_msg("id-a", 2, 1000, "secret-second-tie-a"),
        make_msg("id-z", 1, 2000, "secret-first-high-ts"),
        make_msg("id-x", 1, 1500, "secret-first-low-ts"),
        make_msg("id-c", 2, 999, "secret-second-early-ts"),
        make_msg("id-m", 5, 100, "secret-highest-lamport"),
    ];

    let mut log_fwd = ReplicatedLog::new();
    for m in &msgs {
        let rec = SealedLogRecord::seal(m, &log_key, &mut rng);
        assert!(log_fwd.insert_sealed(rec, &log_key)?.is_some());
    }
    assert!(!log_fwd.insert(msgs[0].clone())?);

    let mut log_rev = ReplicatedLog::new();
    for m in msgs.iter().rev() {
        let rec = SealedLogRecord::seal(m, &log_key, &mut rng);
        assert!(log_rev.insert_sealed(rec, &log_key)?.is_some());
    }

    let expected_ids = vec!["id-x", "id-z", "id-c", "id-a", "id-b", "id-m"];
    let fwd_ids: Vec<&str> = log_fwd.ordered().map(|m| m.id.as_str()).collect();
    let rev_ids: Vec<&str> = log_rev.ordered().map(|m| m.id.as_str()).collect();
    assert_eq!(fwd_ids, expected_ids);
    assert_eq!(rev_ids, expected_ids);

    // Local sealed append strictly exceeds max observed lamport
    let (local, sealed_local) = log_fwd.append_local_sealed(
        "local-6".to_owned(),
        "metric".to_owned(),
        3000,
        "peer-b".to_owned(),
        "Bob".to_owned(),
        parse_json(r#"{"cpu":0.42,"secret":"top-secret-metric"}"#)?,
        &log_key,
        &mut rng,
    )?;
    assert_eq!(local.lamport, 6);

    // Tampering with lamport on sealed record MUST fail AEAD AAD verification
    let mut tampered = sealed_local.clone();
    tampered.lamport = 999;
    assert!(tampered.open(&log_key).is_err());
    assert!(sealed_local.open(&wrong_log_key).is_err());

    // Encrypted snapshot persistence contains ZERO plaintext message bodies!
    let enc_snap_str = log_fwd.export_encrypted_snapshot_json(&log_key, &fp, &mut rng);
    assert!(!enc_snap_str.contains("secret-first-low-ts"));
    assert!(!enc_snap_str.contains("top-secret-metric"));
    assert!(!enc_snap_str.contains("Alice"));
    assert!(enc_snap_str.contains("\"chacha20-poly1305\""));

    let enc_snap_val = parse_json(&enc_snap_str)?;

    // Wrong key cannot import encrypted snapshot
    let mut bad_restore = ReplicatedLog::new();
    assert!(bad_restore.import_encrypted_snapshot_value(&enc_snap_val, &wrong_log_key).is_err());

    // Correct key restores exact deterministic order and fields
    let mut restored = ReplicatedLog::new();
    let added = restored.import_encrypted_snapshot_value(&enc_snap_val, &log_key)?;
    assert_eq!(added, log_fwd.len());
    assert_eq!(restored.ids_ordered(), log_fwd.ids_ordered());
    assert_eq!(restored.lamport(), log_fwd.lamport());

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
fn wire_frames_e2ee_envelope_and_chunking_roundtrip() -> TestResult {
    let mut rng = SafeCsprng::from_seed(b"unit-test-wire-seed");
    let log_key = derive_log_key(&[0x33u8; 32]);
    let pk1 = x25519_public_key(&[0x44u8; 32]);
    let pk2 = x25519_public_key(&[0x55u8; 32]);

    let msg = LogMessage {
        id: "m-1".to_owned(),
        msg_type: "event".to_owned(),
        lamport: 7,
        ts: 1_700_000_000_000,
        author: "p-1".to_owned(),
        author_name: "Node1".to_owned(),
        payload: parse_json(r#"{"k":"v","n":123}"#)?,
    };
    let rec = SealedLogRecord::seal(&msg, &log_key, &mut rng);

    let frames = [
        WireFrame::Hello {
            peer_id: "p-1".to_owned(),
            author_name: "Node1".to_owned(),
            room: "main".to_owned(),
            pub_key: pk1,
            lamport: 7,
            log_count: 1,
            in_voice: true,
            voice_muted: false,
            is_bot: true,
            peers: vec![PeerSummary {
                peer_id: "p-2".to_owned(),
                author_name: "Node2".to_owned(),
                pub_key: pk2,
                is_bot: false,
            }],
        },
        WireFrame::Msg {
            origin: "p-1".to_owned(),
            ttl: 12,
            path: vec!["p-1".to_owned(), "p-2".to_owned()],
            record: rec.clone(),
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
            records: vec![rec.clone()],
        },
        WireFrame::MeshIntro {
            via: "p-2".to_owned(),
            peer_id: "p-3".to_owned(),
            author_name: "Node3".to_owned(),
            pub_key: pk2,
            is_bot: true,
        },
        WireFrame::RelaySignal {
            from: "p-1".to_owned(),
            from_name: "Node1".to_owned(),
            from_pub_key: pk1,
            to: "p-3".to_owned(),
            via: "p-2".to_owned(),
            hops: vec!["p-1".to_owned()],
            ttl: 6,
            sealed_nonce: [0x99u8; 12],
            sealed_ciphertext: vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
        },
        WireFrame::VoiceState {
            in_voice: true,
            muted: true,
        },
        WireFrame::BotAction {
            action_uid: "ba-p1-1000-1".to_owned(),
            from: "p-1".to_owned(),
            from_name: "Node1".to_owned(),
            to: "p-bot".to_owned(),
            message_id: "m-1".to_owned(),
            action_id: "wf:cetus".to_owned(),
            label: "Refresh Cetus".to_owned(),
            value: parse_json(r#"{"zone":"cetus"}"#)?,
            ts: 1_700_000_001_000,
            hops: vec!["p-1".to_owned()],
            ttl: 8,
        },
    ];

    let link_key = [0xAAu8; 32];
    for (idx, frame) in frames.iter().enumerate() {
        let encoded = frame.to_json_string();
        let decoded = WireFrame::parse_json(&encoded)?;
        assert_eq!(&decoded, frame);

        // Wrap in outer E2EE envelope and verify confidentiality + AAD binding
        let env = EncryptedWireEnvelope::seal(
            &link_key,
            (idx + 1) as u64,
            rng.next_nonce(),
            "p-1",
            "p-2",
            &encoded,
        );
        let env_json = env.to_json_string();
        assert!(env_json.contains("\"kind\":\"e2ee\""));
        assert!(!env_json.contains("\"Node1\""));
        let parsed_env = EncryptedWireEnvelope::parse_json(&env_json)?;
        assert!(parsed_env.open(&link_key, "p-2", "p-1").is_err()); // wrong direction AAD rejected
        let decrypted = parsed_env.open(&link_key, "p-1", "p-2")?;
        assert_eq!(decrypted, encoded);
    }

    // Plaintext non-e2ee wire frames MUST be rejected by EncryptedWireEnvelope
    assert!(EncryptedWireEnvelope::parse_json(r#"{"kind":"hello","peerId":"p-1"}"#).is_err());

    let body = RelaySignalBody {
        signal_type: RelaySignalType::Offer,
        sdp: Some("v=0\r\n".to_owned()),
        candidate: None,
    };
    assert_eq!(RelaySignalBody::parse_json(&body.to_json_string())?, body);

    assert_eq!(chunk_inv_ids(&[], 10).len(), 1);
    let many: Vec<SealedLogRecord> = (0..15)
        .map(|i| SealedLogRecord {
            id: format!("msg-{i}"),
            ..rec.clone()
        })
        .collect();
    let chunks = chunk_sealed_records(&many, 4, 12_000);
    assert_eq!(chunks.len(), 4);
    Ok(())
}

#[test]
fn rpc_dispatcher_e2ee_end_to_end() -> TestResult {
    let mut state = None;
    let secret_b64 = base64url_encode(&[0x19u8; 32]);
    let mk_b64 = base64url_encode(&[0x28u8; 32]);
    let ent_b64 = base64url_encode(&[0x37u8; 32]);

    let err_resp = parse_json(&dispatch_rpc(&mut state, r#"{"cmd":"get_state"}"#))?;
    assert_eq!(err_resp.get_bool("ok"), Some(false));

    let init_req = format!(
        r#"{{"cmd":"init","peerId":"p-rpc-1","authorName":"Alice","room":"demo","x25519Secret":"{secret_b64}","meshKey":"{mk_b64}","entropy":"{ent_b64}"}}"#
    );
    let init_resp = parse_json(&dispatch_rpc(&mut state, &init_req))?;
    assert_eq!(init_resp.get_bool("ok"), Some(true));
    assert!(
        init_resp
            .get("status")
            .and_then(|s| s.get("e2ee"))
            .and_then(|e| e.get_str("keyFingerprint"))
            .is_some()
    );

    let pub_resp = parse_json(&dispatch_rpc(
        &mut state,
        r#"{"cmd":"publish","type":"task","payload":{"title":"secret-wasm-task","done":true},"ts":1700000000001}"#,
    ))?;
    assert_eq!(pub_resp.get_bool("ok"), Some(true));

    // Exported snapshot must be ciphertext-only (no plaintext leakage)
    let exp_str = dispatch_rpc(&mut state, r#"{"cmd":"export_snapshot"}"#);
    assert!(!exp_str.contains("secret-wasm-task"));
    let exp = parse_json(&exp_str)?;
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

    // Passphrase mode encrypts P2P1 invite end-to-end
    let pass_resp = parse_json(&dispatch_rpc(
        &mut state,
        r#"{"cmd":"set_passphrase","passphrase":"my-mesh-secret-pass"}"#,
    ))?;
    assert_eq!(pass_resp.get_bool("ok"), Some(true));

    let enc_req = format!(
        r#"{{"cmd":"encode_signal","kind":"offer","inviteId":"i1","sdp":{},"baseUrl":"https://lz-er.github.io/p2p-direct/"}}"#,
        JsonValue::string(SAMPLE_SDP).to_json_string()
    );
    let enc_resp = parse_json(&dispatch_rpc(&mut state, &enc_req))?;
    assert_eq!(enc_resp.get_bool("encrypted"), Some(true));
    let url = enc_resp.get_str("url").ok_or("missing url")?;

    // Decoding with wrong passphrase fails
    let bad_dec_req = format!(
        r#"{{"cmd":"decode_signal","input":{},"passphrase":"wrong"}}"#,
        JsonValue::string(url).to_json_string()
    );
    assert_eq!(
        parse_json(&dispatch_rpc(&mut state, &bad_dec_req))?.get_bool("ok"),
        Some(false)
    );

    // Decoding with matching passphrase succeeds
    let ok_dec_req = format!(
        r#"{{"cmd":"decode_signal","input":{},"passphrase":"my-mesh-secret-pass"}}"#,
        JsonValue::string(url).to_json_string()
    );
    let dec_resp = parse_json(&dispatch_rpc(&mut state, &ok_dec_req))?;
    assert_eq!(dec_resp.get_bool("ok"), Some(true));
    assert_eq!(
        dec_resp.get("signal").and_then(|s| s.get_bool("encrypted")),
        Some(true)
    );

    let voice_resp = parse_json(&dispatch_rpc(
        &mut state,
        r#"{"cmd":"set_voice_state","inVoice":true,"muted":false}"#,
    ))?;
    assert_eq!(voice_resp.get_bool("ok"), Some(true));
    assert_eq!(
        voice_resp
            .get("status")
            .and_then(|s| s.get("voice"))
            .and_then(|v| v.get_bool("inVoice")),
        Some(true)
    );
    Ok(())
}

#[test]
fn ima_adpcm_and_e2ee_voice_packet_roundtrip() -> TestResult {
    // 20ms (320 samples) @ 16 kHz wideband speech-like two-tone signal
    let pcm: Vec<i16> = (0..320)
        .map(|i| {
            let t = (i as f64) / 16_000.0;
            let s = 10_000.0 * (2.0 * std::f64::consts::PI * 440.0 * t).sin()
                + 4_000.0 * (2.0 * std::f64::consts::PI * 1120.0 * t).sin();
            s as i16
        })
        .collect();

    let encoded = encode_ima_adpcm(&pcm);
    // 5-byte header + ceil(319 / 2) = 165 bytes (~4x compression from 640 PCM bytes)
    assert_eq!(encoded.len(), 165);

    let decoded = decode_ima_adpcm(&encoded)?;
    assert_eq!(decoded.len(), pcm.len());

    let orig_rms = compute_rms_i16(&pcm);
    let dec_rms = compute_rms_i16(&decoded);
    assert!(orig_rms > 6_000);
    assert!(
        orig_rms.abs_diff(dec_rms) < 900,
        "decoded RMS {dec_rms} diverged too far from original {orig_rms}"
    );

    // Compute SNR-like correlation: average sample error must stay small relative to signal amplitude
    let mean_abs_err: f64 = pcm
        .iter()
        .zip(decoded.iter())
        .map(|(&a, &b)| (i32::from(a) - i32::from(b)).abs() as f64)
        .sum::<f64>()
        / (pcm.len() as f64);
    assert!(
        mean_abs_err < 1_200.0,
        "IMA ADPCM mean absolute error too high: {mean_abs_err}"
    );

    // Malformed / truncated / out-of-range ADPCM inputs must fail cleanly without panicking
    assert!(decode_ima_adpcm(&[]).is_err());
    assert!(decode_ima_adpcm(&[0, 0, 99, 10, 0, 0, 0, 0, 0, 0]).is_err());
    assert!(decode_ima_adpcm(&[0, 0, 0, 0xFF, 0xFF]).is_err());
    assert!(decode_ima_adpcm(&[0, 0, 0, 100, 0, 1, 2]).is_err());

    // Empty frame roundtrip
    let empty_enc = encode_ima_adpcm(&[]);
    assert_eq!(decode_ima_adpcm(&empty_enc)?, Vec::<i16>::new());

    // Directional X25519 + MeshKey voice key derivation + V1 binary AEAD packet roundtrip
    let sk_a = [0x11u8; 32];
    let sk_b = [0x22u8; 32];
    let pk_a = x25519_public_key(&sk_a);
    let pk_b = x25519_public_key(&sk_b);
    let mesh_key = [0x55u8; 32];
    let (a_tx, a_rx) = derive_voice_link_keys(&sk_a, &pk_b, &mesh_key, "peer-a", "peer-b")?;
    let (b_tx, b_rx) = derive_voice_link_keys(&sk_b, &pk_a, &mesh_key, "peer-b", "peer-a")?;
    assert_eq!(a_tx, b_rx);
    assert_eq!(b_tx, a_rx);
    assert_ne!(a_tx, a_rx);

    let pkt = seal_voice_packet(&a_tx, 42, [0x77u8; 12], "peer-a", "peer-b", &encoded);
    assert_eq!(pkt.len(), 2 + 8 + 12 + encoded.len() + 16);
    let (seq, nonce, ct) = parse_voice_packet_header(&pkt)?;
    assert_eq!(seq, 42);
    assert_eq!(nonce, [0x77u8; 12]);
    // Wrong direction AAD must fail
    assert!(open_voice_packet_ciphertext(&b_rx, seq, &nonce, "peer-b", "peer-a", ct).is_err());
    let opened = open_voice_packet_ciphertext(&b_rx, seq, &nonce, "peer-a", "peer-b", ct)?;
    assert_eq!(opened, encoded);
    Ok(())
}

#[test]
fn replicated_log_delete_tombstones_scrub_and_prevent_zombie_resurrection() -> TestResult {
    let mut log = ReplicatedLog::new();
    let m1 = log.append_local(
        "m-1".to_owned(),
        "chat".to_owned(),
        100,
        "peer-a".to_owned(),
        "Alice".to_owned(),
        parse_json(r#"{"text":"secret message"}"#)?,
    )?;
    let _m2 = log.append_local(
        "m-2".to_owned(),
        "chat".to_owned(),
        200,
        "peer-a".to_owned(),
        "Alice".to_owned(),
        parse_json(r#"{"text":"keep me"}"#)?,
    )?;
    assert_eq!(log.len(), 2);

    // Delete m-1 via CRDT tombstone
    let _t1 = log.append_local(
        "del-1".to_owned(),
        "msg-delete".to_owned(),
        300,
        "peer-b".to_owned(),
        "Bob".to_owned(),
        parse_json(r#"{"targetId":"m-1"}"#)?,
    )?;
    assert_eq!(log.len(), 1);
    assert!(log.is_deleted("m-1"));
    assert!(log.get_by_id("m-1").is_none()); // scrubbed from RAM!
    assert!(log.contains_or_deleted("m-1"));

    // Late re-delivery of m-1 must NOT resurrect it
    assert!(!log.insert(m1)?);
    assert_eq!(log.len(), 1);

    // Out-of-order tombstone arriving BEFORE original message m-3
    let _t3 = log.append_local(
        "del-3".to_owned(),
        "msg-delete".to_owned(),
        350,
        "peer-b".to_owned(),
        "Bob".to_owned(),
        parse_json(r#"{"targetId":"m-3"}"#)?,
    )?;
    let late_m3 = LogMessage {
        id: "m-3".to_owned(),
        msg_type: "chat".to_owned(),
        lamport: 2,
        ts: 250,
        author: "peer-c".to_owned(),
        author_name: "Carol".to_owned(),
        payload: parse_json(r#"{"text":"late arrival"}"#)?,
    };
    assert!(!log.insert(late_m3)?);
    assert_eq!(log.len(), 1);

    // JSON export omits tombstones and deleted content completely
    let mut json_arr = String::new();
    log.write_messages_json_array(&mut json_arr);
    assert!(!json_arr.contains("secret message"));
    assert!(!json_arr.contains("msg-delete"));
    assert!(json_arr.contains("keep me"));
    Ok(())
}

#[test]
fn replicated_log_bot_update_lww_folding_and_scrub_on_delete() -> TestResult {
    let mut log = ReplicatedLog::new();
    let _b1 = log.append_local(
        "bot-msg-1".to_owned(),
        "bot".to_owned(),
        100,
        "bot-1".to_owned(),
        "WarframeBot".to_owned(),
        parse_json(r#"{"title":"Cetus","badge":"DAY"}"#)?,
    )?;
    let _c1 = log.append_local(
        "chat-1".to_owned(),
        "chat".to_owned(),
        150,
        "peer-a".to_owned(),
        "Alice".to_owned(),
        parse_json(r#"{"text":"nice"}"#)?,
    )?;
    let _u1 = log.append_local(
        "upd-1".to_owned(),
        "bot-update".to_owned(),
        200,
        "bot-1".to_owned(),
        "WarframeBot".to_owned(),
        parse_json(r#"{"targetId":"bot-msg-1","card":{"title":"Cetus","badge":"NIGHT"}}"#)?,
    )?;

    // Visible count stays 2 (bot-msg-1 + chat-1), and bot-msg-1 stays at index 0 with NIGHT badge
    assert_eq!(log.len(), 2);
    let mut json_arr = String::new();
    log.write_messages_json_array(&mut json_arr);
    let parsed = parse_json(&json_arr)?;
    let items = parsed.as_array().ok_or("expected array")?;
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].get_str("id"), Some("bot-msg-1"));
    assert_eq!(
        items[0].get("payload").and_then(|p| p.get_str("badge")),
        Some("NIGHT")
    );
    assert_eq!(items[0].get_u64("updatedLamport"), Some(3));
    assert_eq!(items[1].get_str("id"), Some("chat-1"));

    // Deleting bot-msg-1 scrubs both bot-msg-1 AND its bot-update from memory
    let _del = log.append_local(
        "del-bot-1".to_owned(),
        "msg-delete".to_owned(),
        300,
        "peer-a".to_owned(),
        "Alice".to_owned(),
        parse_json(r#"{"targetId":"bot-msg-1"}"#)?,
    )?;
    assert_eq!(log.len(), 1);
    assert!(log.get_by_id("bot-msg-1").is_none());
    assert!(log.get_by_id("upd-1").is_none());
    Ok(())
}

#[test]
fn voice_v2_raw_opus_e2ee_roundtrip_and_replay_protection() -> TestResult {
    let sk_a = [0x31u8; 32];
    let sk_b = [0x42u8; 32];
    let pk_a = x25519_public_key(&sk_a);
    let pk_b = x25519_public_key(&sk_b);
    let mesh_key = [0x66u8; 32];

    // Protocol-level V2 packet header, AAD direction binding, and V1/V2 domain separation
    let (a_tx, _a_rx) = derive_voice_link_keys(&sk_a, &pk_b, &mesh_key, "peer-a", "peer-b")?;
    let (_b_tx, b_rx) = derive_voice_link_keys(&sk_b, &pk_a, &mesh_key, "peer-b", "peer-a")?;
    let sample_opus_payload = [1u8, 48, 0xE8, 0x03, 0xC0, 0x03, 0x00, 0x00, 0xFC, 0xAA, 0xBB, 0xCC];
    let pkt_v2 = seal_voice_v2_packet(&a_tx, 7, [0x21u8; 12], "peer-a", "peer-b", &sample_opus_payload);
    assert_eq!(pkt_v2.get(0..2), Some(&b"V2"[..]));
    assert!(parse_voice_packet_header(&pkt_v2).is_err()); // V1 parser rejects V2 magic
    let (seq, nonce, ct) = parse_voice_v2_packet_header(&pkt_v2)?;
    assert_eq!(seq, 7);
    // V1 opener rejects V2 ciphertext (different AAD domain)
    assert!(open_voice_packet_ciphertext(&b_rx, seq, &nonce, "peer-a", "peer-b", ct).is_err());
    // Wrong direction rejected
    assert!(open_voice_v2_packet_ciphertext(&b_rx, seq, &nonce, "peer-b", "peer-a", ct).is_err());
    let opened = open_voice_v2_packet_ciphertext(&b_rx, seq, &nonce, "peer-a", "peer-b", ct)?;
    assert_eq!(opened.as_slice(), &sample_opus_payload);

    // End-to-end MeshNode seal_voice_raw / open_voice_v2_packet + tamper + replay rejection
    let mut node_a = MeshNode::new(
        "peer-a".to_owned(),
        "Alice".to_owned(),
        "hd-room".to_owned(),
        sk_a,
        mesh_key,
        b"seed-a",
        MeshConfig::default(),
    );
    let mut node_b = MeshNode::new(
        "peer-b".to_owned(),
        "Bob".to_owned(),
        "hd-room".to_owned(),
        sk_b,
        mesh_key,
        b"seed-b",
        MeshConfig::default(),
    );

    let actions_a = node_a.on_peer_connected("peer-b".to_owned(), "Bob".to_owned(), pk_b, false, None)?;
    let actions_b = node_b.on_peer_connected("peer-a".to_owned(), "Alice".to_owned(), pk_a, false, None)?;
    // Exchange Hello frames so both nodes know each other
    for act in actions_a {
        if let p2p_direct::mesh::MeshAction::SendWire { peer_id, frame } = act {
            assert_eq!(peer_id, "peer-b");
            let _ = node_b.on_wire_message("peer-a", &frame, 1_000);
        }
    }
    for act in actions_b {
        if let p2p_direct::mesh::MeshAction::SendWire { peer_id, frame } = act {
            assert_eq!(peer_id, "peer-a");
            let _ = node_a.on_wire_message("peer-b", &frame, 1_000);
        }
    }

    // Both join voice chat and exchange VoiceState frames
    for act in node_a.set_voice_state(true, false) {
        if let p2p_direct::mesh::MeshAction::SendWire { frame, .. } = act {
            let _ = node_b.on_wire_message("peer-a", &frame, 1_001);
        }
    }
    for act in node_b.set_voice_state(true, false) {
        if let p2p_direct::mesh::MeshAction::SendWire { frame, .. } = act {
            let _ = node_a.on_wire_message("peer-b", &frame, 1_001);
        }
    }

    let sealed = node_a.seal_voice_raw(&sample_opus_payload);
    assert_eq!(sealed.len(), 1);
    let (to_peer, wire_pkt) = sealed.into_iter().next().ok_or("missing sealed V2 packet")?;
    assert_eq!(to_peer, "peer-b");
    assert_eq!(wire_pkt.get(0..2), Some(&b"V2"[..]));

    // Tampered ciphertext must fail authentication and NOT poison replay window
    let mut tampered = wire_pkt.clone();
    if let Some(last) = tampered.last_mut() {
        *last ^= 0xFF;
    }
    assert!(node_b.open_voice_v2_packet("peer-a", &tampered).is_err());

    // Authentic packet succeeds
    let plain = node_b.open_voice_v2_packet("peer-a", &wire_pkt)?;
    assert_eq!(plain.as_slice(), &sample_opus_payload);

    // Replayed packet MUST be rejected by anti-replay window
    assert!(node_b.open_voice_v2_packet("peer-a", &wire_pkt).is_err());
    Ok(())
}

#[test]
fn voice_capture_48k_rust_dsp_dc_gate_limiter_and_fir_antialiasing() -> TestResult {
    const FRAME_48K: usize = 960;

    // 1. DC-offset blocker attenuates steady DC bias well below -30 dB after settling
    let mut dsp = VoiceCaptureDsp48k::new();
    let dc_frame = vec![0.4f32; FRAME_48K];
    let mut last_dc_rms = u16::MAX;
    for _ in 0..4 {
        let res = dsp.process_frame(&dc_frame, 0, false, false);
        last_dc_rms = res.raw_rms;
    }
    assert!(
        last_dc_rms < 150,
        "expected DC blocker to crush 0.4 DC bias, got RMS {last_dc_rms}"
    );

    // 2. Smooth hysteresis noise gate: gated -> 5ms cosine fade-in -> 14-frame hold -> 20ms cosine fade-out tail -> gated
    dsp.reset();
    let quiet = vec![0.002f32; FRAME_48K];
    let g0 = dsp.process_frame(&quiet, 10, false, false);
    assert!(g0.gated);
    assert_eq!(g0.active_rms, 0);
    assert!(g0.processed_48k.is_empty());

    let tone_1khz: Vec<f32> = (0..FRAME_48K)
        .map(|i| 0.35 * (2.0 * std::f32::consts::PI * 1000.0 * (i as f32) / 48_000.0).sin())
        .collect();
    let open_frame = dsp.process_frame(&tone_1khz, 10, false, false);
    assert!(!open_frame.gated);
    assert!(!open_frame.is_fade_out_tail);
    assert!(open_frame.raw_rms > 6000);
    assert_eq!(open_frame.active_rms, open_frame.raw_rms);
    assert_eq!(open_frame.processed_48k.len(), FRAME_48K);
    // Sample 0 of cosine fade-in must be exactly 0.0 (click-free opening)
    let first_sample = open_frame.processed_48k.first().copied().ok_or("empty frame")?;
    assert!(first_sample.abs() < 1e-6, "expected 0.0 fade-in start, got {first_sample}");

    // 14 silence frames remain open (280 ms hold time)
    let silence = vec![0.0f32; FRAME_48K];
    for hold_idx in 0..14 {
        let hold_res = dsp.process_frame(&silence, 10, false, false);
        assert!(
            !hold_res.gated && !hold_res.is_fade_out_tail,
            "expected gate hold on frame {hold_idx}"
        );
    }
    // Frame 15 emits the single smooth 20 ms cosine fade-out tail with active_rms == 0
    let tail_res = dsp.process_frame(&tone_1khz, 99, false, false);
    assert!(!tail_res.gated);
    assert!(tail_res.is_fade_out_tail);
    assert_eq!(tail_res.active_rms, 0);
    let tail_end = tail_res.processed_48k.last().copied().ok_or("empty tail")?;
    assert!(
        tail_end.abs() < 0.005,
        "expected fade-out tail to taper near 0.0 at end, got {tail_end}"
    );
    // Next quiet frame is fully gated
    let closed_res = dsp.process_frame(&silence, 10, false, false);
    assert!(closed_res.gated);
    assert!(!closed_res.is_fade_out_tail);

    // 3. Transparent soft-knee safety limiter: bit-transparent <= 0.85, smoothly capped < 1.0 above
    dsp.reset();
    let hot_tone: Vec<f32> = (0..FRAME_48K)
        .map(|i| 2.0 * (2.0 * std::f32::consts::PI * 500.0 * (i as f32) / 48_000.0).sin())
        .collect();
    let lim_res = dsp.process_frame(&hot_tone, 0, false, false);
    let max_abs = lim_res
        .processed_48k
        .iter()
        .fold(0.0f32, |acc, &s| acc.max(s.abs()));
    assert!(
        max_abs > 0.90 && max_abs < 0.995,
        "expected soft-knee limiter peak in (0.90, 0.995), got {max_abs}"
    );

    // Mid-level signal (0.5) stays strictly below knee (0.85) with no clipping distortion
    dsp.reset();
    let mid_tone: Vec<f32> = (0..FRAME_48K)
        .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * (i as f32) / 48_000.0).sin())
        .collect();
    let mid_res = dsp.process_frame(&mid_tone, 0, false, false);
    let mid_peak = mid_res
        .processed_48k
        .iter()
        .fold(0.0f32, |acc, &s| acc.max(s.abs()));
    assert!(
        (mid_peak - 0.5).abs() < 0.03,
        "expected linear pass-through for 0.5 tone, got peak {mid_peak}"
    );

    // 4. 15-tap Blackman-windowed sinc FIR anti-aliasing downsampler (48 kHz -> 16 kHz)
    // Passband 1 kHz tone passes near unity; stopband 14 kHz tone (>8 kHz Nyquist) is heavily rejected
    dsp.reset();
    let _ = dsp.process_frame(&tone_1khz, 0, false, true);
    let pass_res = dsp.process_frame(&tone_1khz, 0, false, true);
    assert_eq!(pass_res.downsampled_16k.len(), 320);
    let pass_rms = compute_rms_i16(&pass_res.downsampled_16k);

    dsp.reset();
    let tone_14khz: Vec<f32> = (0..FRAME_48K)
        .map(|i| 0.35 * (2.0 * std::f32::consts::PI * 14_000.0 * (i as f32) / 48_000.0).sin())
        .collect();
    let _ = dsp.process_frame(&tone_14khz, 0, false, true);
    let stop_res = dsp.process_frame(&tone_14khz, 0, false, true);
    assert_eq!(stop_res.downsampled_16k.len(), 320);
    let stop_rms = compute_rms_i16(&stop_res.downsampled_16k);
    assert!(
        pass_rms > 6000 && stop_rms * 35 < pass_rms,
        "expected strong FIR stopband rejection at 14 kHz: pass_rms={pass_rms}, stop_rms={stop_rms}"
    );

    // 5. Fused MeshNode::process_voice_capture_48k seals V1 ADPCM packets and decrypts cleanly on peer
    let sk_a = [0x51u8; 32];
    let sk_b = [0x62u8; 32];
    let pk_a = x25519_public_key(&sk_a);
    let pk_b = x25519_public_key(&sk_b);
    let mesh_key = [0x77u8; 32];
    let mut node_a = MeshNode::new(
        "peer-a".to_owned(),
        "Alice".to_owned(),
        "dsp-room".to_owned(),
        sk_a,
        mesh_key,
        b"seed-dsp-a",
        MeshConfig::default(),
    );
    let mut node_b = MeshNode::new(
        "peer-b".to_owned(),
        "Bob".to_owned(),
        "dsp-room".to_owned(),
        sk_b,
        mesh_key,
        b"seed-dsp-b",
        MeshConfig::default(),
    );
    for act in node_a.on_peer_connected("peer-b".to_owned(), "Bob".to_owned(), pk_b, false, None)? {
        if let p2p_direct::mesh::MeshAction::SendWire { frame, .. } = act {
            let _ = node_b.on_wire_message("peer-a", &frame, 1_000);
        }
    }
    for act in node_b.on_peer_connected("peer-a".to_owned(), "Alice".to_owned(), pk_a, false, None)? {
        if let p2p_direct::mesh::MeshAction::SendWire { frame, .. } = act {
            let _ = node_a.on_wire_message("peer-b", &frame, 1_000);
        }
    }
    for act in node_a.set_voice_state(true, false) {
        if let p2p_direct::mesh::MeshAction::SendWire { frame, .. } = act {
            let _ = node_b.on_wire_message("peer-a", &frame, 1_001);
        }
    }
    for act in node_b.set_voice_state(true, false) {
        if let p2p_direct::mesh::MeshAction::SendWire { frame, .. } = act {
            let _ = node_a.on_wire_message("peer-b", &frame, 1_001);
        }
    }

    let (cap_res, v1_pkts) = node_a.process_voice_capture_48k(&tone_1khz, 5, true);
    assert!(!cap_res.gated);
    assert_eq!(cap_res.processed_48k.len(), FRAME_48K);
    assert_eq!(v1_pkts.len(), 1);
    let (to_peer, pkt) = v1_pkts.into_iter().next().ok_or("missing V1 packet")?;
    assert_eq!(to_peer, "peer-b");
    assert_eq!(pkt.get(0..2), Some(&b"V1"[..]));
    let (rx_rms, decoded_pcm) = node_b.open_voice_packet("peer-a", &pkt)?;
    assert_eq!(decoded_pcm.len(), 320);
    assert!(rx_rms > 4000, "expected decoded V1 RMS > 4000, got {rx_rms}");

    // Muted node returns gated=true and emits zero V1 packets
    let _ = node_a.set_voice_state(true, true);
    let (muted_res, muted_pkts) = node_a.process_voice_capture_48k(&tone_1khz, 0, true);
    assert!(muted_res.gated);
    assert_eq!(muted_res.raw_rms, 0);
    assert!(muted_pkts.is_empty());
    Ok(())
}

#[test]
fn off_thread_bulk_worker_roundtrip_interops_with_standard_mesh() -> TestResult {
    use p2p_direct::rpc::{
        dispatch_commit_bulk_publish, dispatch_commit_bulk_rx, dispatch_rpc, worker_open_bulk,
        worker_seal_bulk, worker_seal_forward,
    };

    let mk = base64url_encode(&[0x5Au8; 32]);
    let init_node = |id: &str, name: &str, byte: u8| -> Result<(Option<MeshNode>, String), String> {
        let mut st = None;
        let sec = base64url_encode(&[byte; 32]);
        let resp = dispatch_rpc(
            &mut st,
            &format!(
                r#"{{"cmd":"init","peerId":"{id}","authorName":"{name}","room":"bulk","x25519Secret":"{sec}","meshKey":"{mk}","entropy":"{sec}"}}"#
            ),
        );
        let v = parse_json(&resp)?;
        let pk = v
            .get("status")
            .and_then(|s| s.get("e2ee"))
            .and_then(|e| e.get_str("publicKey"))
            .ok_or("missing publicKey")?
            .to_owned();
        Ok((st, pk))
    };

    let (mut a, pk_a) = init_node("alice", "Alice", 0x11)?;
    let (mut b, pk_b) = init_node("bob", "Bob", 0x22)?;
    let (mut c, pk_c) = init_node("carol", "Carol", 0x33)?;

    // Connect chain A <-> B <-> C
    let _ = dispatch_rpc(
        &mut a,
        &format!(r#"{{"cmd":"peer_connected","peerId":"bob","authorName":"Bob","peerPubKey":"{pk_b}"}}"#),
    );
    let _ = dispatch_rpc(
        &mut b,
        &format!(r#"{{"cmd":"peer_connected","peerId":"alice","authorName":"Alice","peerPubKey":"{pk_a}"}}"#),
    );
    let _ = dispatch_rpc(
        &mut b,
        &format!(r#"{{"cmd":"peer_connected","peerId":"carol","authorName":"Carol","peerPubKey":"{pk_c}"}}"#),
    );
    let _ = dispatch_rpc(
        &mut c,
        &format!(r#"{{"cmd":"peer_connected","peerId":"bob","authorName":"Bob","peerPubKey":"{pk_b}"}}"#),
    );

    // 1. Alice prepares bulk GIF publish (reserves lamport & tx_seq)
    let prep_str = dispatch_rpc(
        &mut a,
        r#"{"cmd":"prepare_bulk_publish","type":"chat","ts":5000}"#,
    );
    let prep_val = parse_json(&prep_str)?;
    assert_eq!(prep_val.get_bool("ok"), Some(true));
    let prep = prep_val.get("prep").ok_or("missing prep")?;
    let gif_id = prep.get_str("id").ok_or("missing prep id")?.to_owned();
    let gif_lp = prep.get_u64("lamport").ok_or("missing prep lamport")?;
    let log_nonce = prep.get_str("logNonce").ok_or("missing logNonce")?.to_owned();

    // 2. Concurrent fast chat message on Alice overtakes bulk GIF on p2p-mesh!
    let fast_pub_str = dispatch_rpc(
        &mut a,
        r#"{"cmd":"publish","type":"chat","payload":{"text":"fast overtake"},"ts":5001}"#,
    );
    let fast_pub = parse_json(&fast_pub_str)?;
    let fast_frame = fast_pub
        .get("actions")
        .and_then(JsonValue::as_array)
        .and_then(|arr| arr.iter().find_map(|x| x.get_str("frame")))
        .ok_or("missing fast frame")?;
    let fast_rx = parse_json(&dispatch_rpc(
        &mut b,
        &format!(
            r#"{{"cmd":"wire_message","fromPeer":"alice","frame":{},"nowMs":5010}}"#,
            JsonValue::string(fast_frame).to_json_string()
        ),
    ))?;
    assert_eq!(fast_rx.get_bool("ok"), Some(true));

    // 3. Alice's off-thread worker seals the bulk GIF
    let msg_json = format!(
        r#"{{"id":"{gif_id}","type":"chat","lamport":{gif_lp},"ts":5000,"author":"alice","authorName":"Alice","payload":{{"text":"big gif","images":[{{"name":"cool.gif","dataUrl":"data:image/gif;base64,R0lGODlhAQABAAAAACw="}}]}}}}"#
    );
    let targets = prep.get("targets").ok_or("missing targets")?;
    let seal_hdr = format!(
        r#"{{"meta":{{"id":"{gif_id}","type":"chat","lamport":{gif_lp},"ts":5000,"author":"alice","authorName":"Alice"}},"logKey":{},"logNonce":{},"gossipTtl":16,"targets":{}}}"#,
        JsonValue::string(prep.get_str("logKey").ok_or("missing logKey")?).to_json_string(),
        JsonValue::string(&log_nonce).to_json_string(),
        targets.to_json_string()
    );
    let mut seal_in = Vec::new();
    seal_in.extend_from_slice(&(seal_hdr.len() as u32).to_le_bytes());
    seal_in.extend_from_slice(seal_hdr.as_bytes());
    seal_in.extend_from_slice(msg_json.as_bytes());

    let seal_out = worker_seal_bulk(&seal_in);
    let resp_len = u32::from_le_bytes([seal_out[0], seal_out[1], seal_out[2], seal_out[3]]) as usize;
    let seal_resp = parse_json(
        std::str::from_utf8(&seal_out[4..4 + resp_len]).map_err(|e| e.to_string())?,
    )?;
    assert_eq!(seal_resp.get_bool("ok"), Some(true));
    let sealed_ct = &seal_out[4 + resp_len..];
    let wire_frame = seal_resp
        .get("wireFrames")
        .and_then(JsonValue::as_array)
        .and_then(|arr| arr.first())
        .and_then(|wf| wf.get_str("frame"))
        .ok_or("missing worker wireFrame")?;

    // Alice commits bulk publish (deferred payload in log)
    let commit_pub_hdr = format!(
        r#"{{"meta":{{"id":"{gif_id}","type":"chat","lamport":{gif_lp},"ts":5000,"author":"alice","authorName":"Alice"}},"sealedNonce":{},"sentPeerCount":1}}"#,
        JsonValue::string(&log_nonce).to_json_string()
    );
    let mut commit_pub_in = Vec::new();
    commit_pub_in.extend_from_slice(&(commit_pub_hdr.len() as u32).to_le_bytes());
    commit_pub_in.extend_from_slice(commit_pub_hdr.as_bytes());
    commit_pub_in.extend_from_slice(sealed_ct);
    let cp_res = parse_json(&dispatch_commit_bulk_publish(&mut a, &commit_pub_in))?;
    assert_eq!(cp_res.get_bool("ok"), Some(true));

    // 4. Bob receives the slower bulk GIF out-of-order after fast chat, prepares + opens in worker
    let env_seq = parse_json(wire_frame)?.get_u64("s").ok_or("missing seq")?;
    let rx_prep = parse_json(&dispatch_rpc(
        &mut b,
        &format!(r#"{{"cmd":"prepare_bulk_rx","fromPeer":"alice","seq":{env_seq}}}"#),
    ))?;
    assert_eq!(rx_prep.get_bool("ok"), Some(true));

    let open_hdr = format!(
        r#"{{"fromPeer":"alice","selfPeerId":"bob","rxKey":{},"logKey":{}}}"#,
        JsonValue::string(rx_prep.get_str("rxKey").ok_or("missing rxKey")?).to_json_string(),
        JsonValue::string(rx_prep.get_str("logKey").ok_or("missing logKey")?).to_json_string()
    );
    let mut open_in = Vec::new();
    open_in.extend_from_slice(&(open_hdr.len() as u32).to_le_bytes());
    open_in.extend_from_slice(open_hdr.as_bytes());
    open_in.extend_from_slice(wire_frame.as_bytes());

    let open_out = worker_open_bulk(&open_in);
    let mlen = u32::from_le_bytes([open_out[0], open_out[1], open_out[2], open_out[3]]) as usize;
    let open_meta = parse_json(
        std::str::from_utf8(&open_out[4..4 + mlen]).map_err(|e| e.to_string())?,
    )?;
    assert_eq!(open_meta.get_str("kind"), Some("msg"));
    let jlen_off = 4 + mlen;
    let jlen = u32::from_le_bytes([
        open_out[jlen_off],
        open_out[jlen_off + 1],
        open_out[jlen_off + 2],
        open_out[jlen_off + 3],
    ]) as usize;
    let opened_msg_json =
        std::str::from_utf8(&open_out[jlen_off + 4..jlen_off + 4 + jlen])
            .map_err(|e| e.to_string())?;
    assert!(opened_msg_json.contains("R0lGODlhAQABAAAAACw="));
    let opened_sealed_ct = &open_out[jlen_off + 4 + jlen..];

    // Bob commits bulk rx & gets Carol as multi-hop forward target!
    let commit_rx_hdr = format!(
        r#"{{"fromPeer":"alice","seq":{},"ttl":{},"path":{},"meta":{},"sealedNonce":{}}}"#,
        open_meta.get_u64("seq").ok_or("seq")?,
        open_meta.get_u64("ttl").ok_or("ttl")?,
        open_meta.get("path").ok_or("path")?.to_json_string(),
        open_meta.get("meta").ok_or("meta")?.to_json_string(),
        JsonValue::string(open_meta.get_str("sealedNonce").ok_or("sealedNonce")?).to_json_string()
    );
    let mut commit_rx_in = Vec::new();
    commit_rx_in.extend_from_slice(&(commit_rx_hdr.len() as u32).to_le_bytes());
    commit_rx_in.extend_from_slice(commit_rx_hdr.as_bytes());
    commit_rx_in.extend_from_slice(opened_sealed_ct);
    let cr_res = parse_json(&dispatch_commit_bulk_rx(&mut b, &commit_rx_in))?;
    assert_eq!(cr_res.get_bool("ok"), Some(true));
    assert_eq!(cr_res.get_bool("inserted"), Some(true));

    // Bob's get_state transparently decrypts deferred GIF payload!
    let bob_state = dispatch_rpc(&mut b, r#"{"cmd":"get_state"}"#);
    assert!(bob_state.contains("R0lGODlhAQABAAAAACw="));
    assert!(bob_state.contains("fast overtake"));

    // 5. Bob's worker seals forward frame for Carol, and Carol opens it via standard wire_message!
    let fwd_hdr = format!(
        r#"{{"selfPeerId":"bob","origin":{},"ttl":{},"path":{},"recordMeta":{{"id":"{gif_id}","lamport":{gif_lp},"ts":5000,"nonce":{}}},"targets":{}}}"#,
        JsonValue::string(open_meta.get_str("origin").ok_or("origin")?).to_json_string(),
        cr_res.get_u64("nextTtl").ok_or("nextTtl")?,
        cr_res.get("nextPath").ok_or("nextPath")?.to_json_string(),
        JsonValue::string(open_meta.get_str("sealedNonce").ok_or("sn")?).to_json_string(),
        cr_res.get("forwardTargets").ok_or("ft")?.to_json_string()
    );
    let mut fwd_in = Vec::new();
    fwd_in.extend_from_slice(&(fwd_hdr.len() as u32).to_le_bytes());
    fwd_in.extend_from_slice(fwd_hdr.as_bytes());
    fwd_in.extend_from_slice(opened_sealed_ct);
    let fwd_res = parse_json(&worker_seal_forward(&fwd_in))?;
    let carol_frame = fwd_res
        .get("wireFrames")
        .and_then(JsonValue::as_array)
        .and_then(|arr| arr.first())
        .and_then(|wf| wf.get_str("frame"))
        .ok_or("missing carol forward frame")?;
    let carol_rx = parse_json(&dispatch_rpc(
        &mut c,
        &format!(
            r#"{{"cmd":"wire_message","fromPeer":"bob","frame":{},"nowMs":5050}}"#,
            JsonValue::string(carol_frame).to_json_string()
        ),
    ))?;
    assert_eq!(carol_rx.get_bool("ok"), Some(true));
    assert!(dispatch_rpc(&mut c, r#"{"cmd":"get_state"}"#).contains("R0lGODlhAQABAAAAACw="));

    // 6. Key rotation on Alice preserves deferred GIF record losslessly!
    let new_mk = base64url_encode(&[0x77u8; 32]);
    let rekey = parse_json(&dispatch_rpc(
        &mut a,
        &format!(r#"{{"cmd":"set_mesh_key","meshKey":"{new_mk}","passphraseMode":false}}"#),
    ))?;
    assert_eq!(rekey.get_bool("ok"), Some(true));
    assert!(dispatch_rpc(&mut a, r#"{"cmd":"get_state"}"#).contains("R0lGODlhAQABAAAAACw="));
    Ok(())
}

#[test]
fn fused_aead_matches_boundaries_and_rejects_tampering() -> TestResult {
    let key = [0x42u8; 32];
    let nonce = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC];
    let aad_lens = [0usize, 1, 15, 16, 17, 63, 64, 65];
    let pt_lens = [0usize, 1, 15, 16, 17, 31, 32, 63, 64, 65, 127, 128, 129, 255, 4097];

    let mut sealed_buf = Vec::new();
    let mut opened_buf = Vec::new();

    for &aad_len in &aad_lens {
        let aad: Vec<u8> = (0..aad_len).map(|i| (i.wrapping_mul(37) ^ 0x5A) as u8).collect();
        for &pt_len in &pt_lens {
            let pt: Vec<u8> = (0..pt_len).map(|i| (i.wrapping_mul(131) ^ 0xA5) as u8).collect();
            sealed_buf.clear();
            aead_seal_into(&key, &nonce, &aad, &pt, &mut sealed_buf);
            assert_eq!(sealed_buf.len(), pt_len + 16);

            let sealed_alloc = aead_seal(&key, &nonce, &aad, &pt);
            assert_eq!(sealed_buf, sealed_alloc);

            opened_buf.clear();
            aead_open_into(&key, &nonce, &aad, &sealed_buf, &mut opened_buf)?;
            assert_eq!(opened_buf, pt);
            assert_eq!(aead_open(&key, &nonce, &aad, &sealed_buf)?, pt);

            // Flip one bit in tag or ciphertext and verify strict rejection without mutating `opened_buf`
            let mut tampered = sealed_buf.clone();
            tampered[0] ^= 0x01;
            let pre_len = opened_buf.len();
            assert!(aead_open_into(&key, &nonce, &aad, &tampered, &mut opened_buf).is_err());
            assert_eq!(opened_buf.len(), pre_len);
        }
    }
    Ok(())
}

#[test]
fn derive_all_link_keys_matches_individual_derivations() -> TestResult {
    let mesh_key = [0x99u8; 32];
    let sk_a = [0x12u8; 32];
    let sk_b = [0x34u8; 32];
    let pk_a = x25519_public_key(&sk_a);
    let pk_b = x25519_public_key(&sk_b);

    let (wire_a, voice_a) = derive_all_link_keys(&sk_a, &pk_b, &mesh_key, "alice", "bob")?;
    let wire_a_sep = derive_link_keys(&sk_a, &pk_b, &mesh_key, "alice", "bob")?;
    let voice_a_sep = derive_voice_link_keys(&sk_a, &pk_b, &mesh_key, "alice", "bob")?;

    assert_eq!(wire_a, wire_a_sep);
    assert_eq!(voice_a, voice_a_sep);

    let (wire_b, voice_b) = derive_all_link_keys(&sk_b, &pk_a, &mesh_key, "bob", "alice")?;
    assert_eq!(wire_a.0, wire_b.1);
    assert_eq!(wire_a.1, wire_b.0);
    assert_eq!(voice_a.0, voice_b.1);
    assert_eq!(voice_a.1, voice_b.0);
    Ok(())
}

#[test]
fn zero_copy_wire_parsers_and_skipping_parser_cover_fast_and_fallback_paths() -> TestResult {
    let mut rng = SafeCsprng::from_seed(b"zero-copy-parser-test");
    let mesh_key = [0x33u8; 32];
    let log_key = derive_log_key(&mesh_key);

    let msg = LogMessage {
        id: "m-zc-1".to_owned(),
        msg_type: "chat".to_owned(),
        lamport: 7,
        ts: 123_456,
        author: "alice".to_owned(),
        author_name: "Alice".to_owned(),
        payload: parse_json(r#"{"text":"hello","nested":{"arr":[1,2,"a\"b"],"k":"v"}}"#)?,
    };
    let rec = SealedLogRecord::seal(&msg, &log_key, &mut rng);

    // 1. Compact Msg wire frame exercises zero-copy fast path
    let wire_frame = WireFrame::Msg {
        origin: "alice".to_owned(),
        ttl: 5,
        path: vec!["alice".to_owned(), "bob".to_owned()],
        record: rec.clone(),
    };
    let compact_msg_json = wire_frame.to_json_string();
    let parsed_fast = WireFrame::parse_json(&compact_msg_json)?;
    assert_eq!(parsed_fast, wire_frame);

    // 2. Pretty/whitespace + escaped Msg wire frame exercises full JSON parser fallback
    let pretty_msg_json = format!(
        "{{ \"kind\" : \"msg\" , \"origin\" : \"alice\" , \"ttl\" : 5 , \"path\" : [ \"alice\" , \"bob\" ] , \"record\" : {{ \"id\" : \"m-zc-1\" , \"lamport\" : 7 , \"ts\" : 123456 , \"n\" : \"{}\" , \"c\" : \"{}\" }} }}",
        base64url_encode(&rec.nonce),
        base64url_encode(&rec.ciphertext)
    );
    let parsed_fallback = WireFrame::parse_json(&pretty_msg_json)?;
    assert_eq!(parsed_fallback, wire_frame);

    // 3. Compact and whitespace EncryptedWireEnvelope (fast path + fallback)
    let env = EncryptedWireEnvelope {
        version: 1,
        seq: 42,
        nonce: [0x5Au8; 12],
        ciphertext: vec![0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03],
    };
    let compact_env = env.to_json_string();
    let env_fast = EncryptedWireEnvelope::parse_json(&compact_env)?;
    assert_eq!(env_fast.version, env.version);
    assert_eq!(env_fast.seq, env.seq);
    assert_eq!(env_fast.nonce, env.nonce);
    assert_eq!(env_fast.ciphertext, env.ciphertext);

    let pretty_env = format!(
        "{{ \"kind\": \"e2ee\", \"v\": 1, \"s\": 42, \"n\": \"{}\", \"c\": \"{}\" }}",
        base64url_encode(&env.nonce),
        base64url_encode(&env.ciphertext)
    );
    let env_fallback = EncryptedWireEnvelope::parse_json(&pretty_env)?;
    assert_eq!(env_fallback.seq, env.seq);
    assert_eq!(env_fallback.nonce, env.nonce);
    assert_eq!(env_fallback.ciphertext, env.ciphertext);

    // 4. parse_json_object_skipping_field skips arbitrarily large/nested payload cleanly
    let msg_json = msg.to_json_string();
    let skipped = parse_json_object_skipping_field(&msg_json, "payload")?;
    assert_eq!(skipped.get_str("id"), Some("m-zc-1"));
    assert_eq!(skipped.get_str("type"), Some("chat"));
    assert_eq!(skipped.get_u64("lamport"), Some(7));
    assert_eq!(skipped.get_u64("ts"), Some(123_456));
    assert_eq!(skipped.get_str("author"), Some("alice"));
    assert_eq!(skipped.get_str("authorName"), Some("Alice"));
    assert!(skipped.get("payload").is_none());
    Ok(())
}

#[test]
fn mesh_binary_counters_and_48k_dsp_fast_path_consistency() -> TestResult {
    let mut node = MeshNode::new(
        "p-cnt".to_owned(),
        "Counter".to_owned(),
        "Room".to_owned(),
        [0x21u8; 32],
        [0x43u8; 32],
        &[0x65u8; 32],
        MeshConfig::default(),
    );
    let _ = node.publish_local(
        "chat".to_owned(),
        parse_json(r#"{"text":"hi"}"#)?,
        1000,
        Some("m1".to_owned()),
    )?;
    let mut raw = Vec::new();
    node.write_counters_binary(&mut raw);
    assert_eq!(raw.len(), 88);
    let read_u64 = |idx: usize| -> u64 {
        u64::from_le_bytes([
            raw[idx * 8],
            raw[idx * 8 + 1],
            raw[idx * 8 + 2],
            raw[idx * 8 + 3],
            raw[idx * 8 + 4],
            raw[idx * 8 + 5],
            raw[idx * 8 + 6],
            raw[idx * 8 + 7],
        ])
    };
    let st = node.stats();
    assert_eq!(read_u64(0), st.voice_packets_sent);
    assert_eq!(read_u64(1), st.voice_packets_received);
    assert_eq!(read_u64(2), st.frames_sent);
    assert_eq!(read_u64(3), st.frames_received);
    assert_eq!(read_u64(4), st.e2ee_frames_encrypted);
    assert_eq!(read_u64(5), st.e2ee_frames_decrypted);
    assert_eq!(read_u64(6), st.e2ee_auth_failures);
    assert_eq!(read_u64(7), st.gossip_forwards);
    assert_eq!(read_u64(8), st.gossip_duplicates_dropped);
    assert_eq!(read_u64(9), node.log().len() as u64);
    assert_eq!(read_u64(10), node.log().lamport());

    // Verify VoiceCaptureDsp48k normal (<= 0.85 fast path), clipping (> 0.85 limiter),
    // and fade-out tail produce clean, bounded outputs with accurate downsampled lengths.
    let mut dsp = VoiceCaptureDsp48k::new();
    let quiet: Vec<f32> = (0..960)
        .map(|i| 0.25 * (2.0 * std::f32::consts::PI * 440.0 * (i as f32) / 48_000.0).sin())
        .collect();
    let r1 = dsp.process_frame(&quiet, 2, false, true);
    assert!(!r1.gated);
    assert_eq!(r1.processed_48k.len(), 960);
    assert_eq!(r1.downsampled_16k.len(), 320);

    let loud: Vec<f32> = (0..960)
        .map(|i| 1.8 * (2.0 * std::f32::consts::PI * 440.0 * (i as f32) / 48_000.0).sin())
        .collect();
    let r2 = dsp.process_frame(&loud, 2, false, true);
    assert!(!r2.gated);
    assert!(r2.processed_48k.iter().all(|&s| s.abs() < 1.0));
    assert_eq!(r2.downsampled_16k.len(), 320);

    // Silence drains 14 hold frames then emits a single fade-out tail frame, then gates
    let silence = vec![0.0f32; 960];
    let mut saw_tail = false;
    let mut saw_gated = false;
    for _ in 0..20 {
        let r = dsp.process_frame(&silence, 5, false, false);
        if r.is_fade_out_tail {
            saw_tail = true;
            assert!(!r.gated);
            assert_eq!(r.active_rms, 0);
        } else if r.gated {
            saw_gated = true;
            assert!(r.processed_48k.is_empty());
            break;
        }
    }
    assert!(saw_tail && saw_gated);
    Ok(())
}

#[test]
fn gif_timings_parser_and_frame_index_lookup() -> TestResult {
    use p2p_direct::media::parse_gif_timings;

    // Minimal valid 3-frame GIF89a with delays: 0 cs (-> 100ms), 6 cs (60ms), 25 cs (250ms)
    let mut gif = Vec::new();
    gif.extend_from_slice(b"GIF89a");
    gif.extend_from_slice(&16u16.to_le_bytes()); // width
    gif.extend_from_slice(&12u16.to_le_bytes()); // height
    gif.push(0x80); // GCT present, 2 colors (6 bytes)
    gif.push(0); // bg
    gif.push(0); // aspect
    gif.extend_from_slice(&[0, 0, 0, 255, 255, 255]); // 2-entry GCT

    let delays_cs: [u16; 3] = [0, 6, 25];
    for &cs in &delays_cs {
        // Graphic Control Extension
        gif.extend_from_slice(&[0x21, 0xF9, 0x04, 0x00]);
        gif.extend_from_slice(&cs.to_le_bytes());
        gif.extend_from_slice(&[0x00, 0x00]);
        // Image Descriptor (no LCT) + dummy 1-byte LZW block
        gif.push(0x2C);
        gif.extend_from_slice(&[0, 0, 0, 0, 16, 0, 12, 0, 0]);
        gif.extend_from_slice(&[0x02, 0x02, 0x4C, 0x01, 0x00]);
    }
    gif.push(0x3B); // Trailer

    let timings = parse_gif_timings(&gif)?;
    assert_eq!(timings.width, 16);
    assert_eq!(timings.height, 12);
    assert_eq!(timings.frame_delays_ms, vec![100, 60, 250]);
    assert_eq!(timings.cumulative_ms, vec![100, 160, 410]);
    assert_eq!(timings.total_duration_ms, 410);

    assert_eq!(timings.frame_index_at(0), 0);
    assert_eq!(timings.frame_index_at(99), 0);
    assert_eq!(timings.frame_index_at(100), 1);
    assert_eq!(timings.frame_index_at(159), 1);
    assert_eq!(timings.frame_index_at(160), 2);
    assert_eq!(timings.frame_index_at(409), 2);
    assert_eq!(timings.frame_index_at(410), 0); // wraps modulo 410ms
    assert_eq!(timings.frame_index_at(410 + 120), 1);
    Ok(())
}

#[test]
fn media_sync_clock_skew_independent_gossip_late_joiner_and_delete_pruning() -> TestResult {
    use p2p_direct::media::{MediaSyncState, WatchQueueItem};
    use p2p_direct::mesh::MeshAction;

    let mesh_key = [0x5Au8; 32];
    let sk_a = [0x11u8; 32];
    let sk_b = [0x22u8; 32];
    let sk_c = [0x33u8; 32];
    let pk_a = x25519_public_key(&sk_a);
    let pk_b = x25519_public_key(&sk_b);
    let pk_c = x25519_public_key(&sk_c);

    let mut a = MeshNode::new("alice".into(), "Alice".into(), "R".into(), sk_a, mesh_key, &[1; 16], MeshConfig::default());
    let mut b = MeshNode::new("bob".into(), "Bob".into(), "R".into(), sk_b, mesh_key, &[2; 16], MeshConfig::default());
    let mut c = MeshNode::new("carol".into(), "Carol".into(), "R".into(), sk_c, mesh_key, &[3; 16], MeshConfig::default());

    // Connect Alice <-> Bob; deliberately give Bob a clock 10 HOURS behind Alice!
    let t_a0: u64 = 1_700_000_000_000;
    let t_b0: u64 = t_a0 - 36_000_000; // 10 hours skewed!
    let t_c0: u64 = t_a0 + 72_000_000; // 20 hours ahead!

    let deliver = |src_id: &str, acts: Vec<MeshAction>, dst: &mut MeshNode, now: u64| -> Result<Vec<MeshAction>, String> {
        let mut out = Vec::new();
        for act in acts {
            if let MeshAction::SendWire { peer_id, frame } = act
                && peer_id == dst.peer_id()
            {
                out.extend(dst.on_wire_message(src_id, &frame, now)?);
            }
        }
        Ok(out)
    };

    let a_conn = a.on_peer_connected("bob".into(), "Bob".into(), pk_b, false, None)?;
    let b_conn = b.on_peer_connected("alice".into(), "Alice".into(), pk_a, false, None)?;
    let _ = deliver("alice", a_conn, &mut b, t_b0)?;
    let _ = deliver("bob", b_conn, &mut a, t_a0)?;

    // Measure RTT = 40ms via Ping/Pong (one-way = 20ms)
    let ping_acts = a.send_keepalive_pings(t_a0);
    let pong_acts = deliver("alice", ping_acts, &mut b, t_b0 + 20)?;
    let _ = deliver("bob", pong_acts, &mut a, t_a0 + 40)?;
    let ping_b = b.send_keepalive_pings(t_b0 + 50);
    let pong_a = deliver("bob", ping_b, &mut a, t_a0 + 70)?;
    let _ = deliver("alice", pong_a, &mut b, t_b0 + 90)?;

    // Alice starts a Watch Together YouTube video at 10.0s playing at 1.0x
    let watch_init = MediaSyncState {
        target_id: "watch".into(),
        kind: "watch".into(),
        rev: 0,
        actor: String::new(),
        actor_name: String::new(),
        active: true,
        playing: true,
        position_ms: 10_000,
        rate_milli: 1000,
        loop_enabled: false,
        epoch: 1,
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ".into(),
        provider: "youtube".into(),
        media_id: "dQw4w9WgXcQ".into(),
        title: "Demo".into(),
        source_msg_id: "msg-1".into(),
        queue: vec![WatchQueueItem {
            id: "q1".into(),
            url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT".into(),
            provider: "spotify".into(),
            media_id: "spotify:track:4cOdK2wGLETKBW3PvgPWqT".into(),
            title: "Track".into(),
            added_by: "Alice".into(),
            start_ms: 0,
        }],
        anchor_local_ms: t_a0 + 100,
    };
    let (_, watch_acts) = a.update_media_sync(watch_init, t_a0 + 100);
    let b_rx = deliver("alice", watch_acts, &mut b, t_b0 + 120)?;
    assert!(b_rx.iter().any(|act| matches!(act, MeshAction::MediaSync { state } if state.target_id == "watch")));

    // Despite 10-hour clock skew, Bob's projected position is 10_000 + 20ms one-way RTT = 10_020ms!
    let b_watch = b.media_states().get("watch").ok_or("missing watch on Bob")?;
    assert_eq!(b_watch.projected_position_ms(t_b0 + 120), 10_020);
    // 5 seconds later on Bob's skewed clock, Bob is at 15_020ms!
    assert_eq!(b_watch.projected_position_ms(t_b0 + 5_120), 15_020);

    // Late joiner Carol connects to Bob 5 seconds later (with a clock 20 hours ahead!)
    let b_c = b.on_peer_connected("carol".into(), "Carol".into(), pk_c, false, None)?;
    let c_b = c.on_peer_connected("bob".into(), "Bob".into(), pk_b, false, None)?;
    let _ = deliver("bob", b_c, &mut c, t_c0 + 5_120)?;
    // When Bob receives Carol's Hello, Bob sends projected MediaSync at t_b0 + 5_120 (= 15_020ms)!
    let bob_hello_reply = deliver("carol", c_b, &mut b, t_b0 + 5_120)?;
    let _ = deliver("bob", bob_hello_reply, &mut c, t_c0 + 5_140)?;
    let c_watch = c.media_states().get("watch").ok_or("missing watch on late joiner Carol")?;
    // Carol gets 15_020 + default 20ms one-way = 15_040ms (zero 20-hour skew error!)
    assert_eq!(c_watch.projected_position_ms(t_c0 + 5_140), 15_040);
    assert_eq!(c_watch.queue.len(), 1);

    // Chat video sync state gets pruned automatically when its message is CRDT-deleted
    let (chat_msg, pub_acts) = a.publish_local("chat".into(), parse_json(r#"{"text":"vid"}"#)?, t_a0 + 200, Some("m-vid-1".into()))?;
    let _ = deliver("alice", pub_acts, &mut b, t_b0 + 220)?;
    let vid_st = MediaSyncState {
        target_id: format!("vid:{}:0", chat_msg.id),
        kind: "video".into(),
        rev: 0,
        actor: String::new(),
        actor_name: String::new(),
        active: true,
        playing: true,
        position_ms: 0,
        rate_milli: 1000,
        loop_enabled: true,
        epoch: 1,
        url: String::new(),
        provider: String::new(),
        media_id: String::new(),
        title: String::new(),
        source_msg_id: chat_msg.id.clone(),
        queue: Vec::new(),
        anchor_local_ms: t_a0 + 250,
    };
    let (_, vid_acts) = a.update_media_sync(vid_st, t_a0 + 250);
    let _ = deliver("alice", vid_acts, &mut b, t_b0 + 270)?;
    assert!(a.media_states().contains_key("vid:m-vid-1:0"));
    assert!(b.media_states().contains_key("vid:m-vid-1:0"));

    let (_, del_acts) = a.delete_message("m-vid-1".into(), t_a0 + 300)?;
    let _ = deliver("alice", del_acts, &mut b, t_b0 + 320)?;
    assert!(!a.media_states().contains_key("vid:m-vid-1:0"));
    assert!(!b.media_states().contains_key("vid:m-vid-1:0"));
    Ok(())
}

#[test]
fn peer_color_sync_converges_without_duplicates_across_multihop_and_partitions() -> TestResult {
    use p2p_direct::mesh::MeshAction;
    use std::collections::{BTreeMap, BTreeSet, VecDeque};

    let mesh_key = [0x99u8; 32];
    let cfg = MeshConfig {
        auto_mesh_enabled: false, // test pure multi-hop gossip convergence without auto-mesh shortcuts
        ..Default::default()
    };

    let make_node = |id: &str, name: &str, sk_byte: u8| -> MeshNode {
        MeshNode::new(
            id.to_owned(),
            name.to_owned(),
            "ColorRoom".to_owned(),
            [sk_byte; 32],
            mesh_key,
            &[sk_byte; 32],
            cfg.clone(),
        )
    };

    // Helper to drain all queued WireFrame actions across a map of nodes
    let drain_network = |nodes: &mut BTreeMap<String, MeshNode>,
                         initial: Vec<(String, Vec<MeshAction>)>|
     -> TestResult {
        let mut q: VecDeque<(String, String, String)> = VecDeque::new();
        for (from, acts) in initial {
            for act in acts {
                if let MeshAction::SendWire { peer_id, frame } = act {
                    q.push_back((from.clone(), peer_id, frame));
                }
            }
        }
        let mut hops = 0usize;
        while let Some((from, to, frame)) = q.pop_front() {
            hops += 1;
            assert!(hops < 500, "ColorSync gossip failed to terminate (loop?)");
            if let Some(target) = nodes.get_mut(&to) {
                let next_acts = target.on_wire_message(&from, &frame, 10_000)?;
                for act in next_acts {
                    if let MeshAction::SendWire { peer_id, frame } = act {
                        q.push_back((to.clone(), peer_id, frame));
                    }
                }
            }
        }
        Ok(())
    };

    // 1. Creator "z-alice" commits color 0, then joiner "a-bob" (lexicographically smaller!) joins:
    //    "z-alice" MUST keep color 0, and "a-bob" MUST get color 1!
    let mut nodes: BTreeMap<String, MeshNode> = BTreeMap::new();
    let mut alice = make_node("z-alice", "Alice", 0x11);
    let _ = alice.commit_self_color();
    assert_eq!(alice.color_for_peer("z-alice"), 0);

    let bob = make_node("a-bob", "Bob", 0x22);
    let carol = make_node("m-carol", "Carol", 0x33);
    let dave = make_node("b-dave", "Dave", 0x44);
    let pk_a = alice.public_key();
    let pk_b = bob.public_key();
    let pk_c = carol.public_key();
    let pk_d = dave.public_key();
    nodes.insert("z-alice".into(), alice);
    nodes.insert("a-bob".into(), bob);
    nodes.insert("m-carol".into(), carol);
    nodes.insert("b-dave".into(), dave);

    // Connect linear 4-hop chain: z-alice <-> a-bob <-> m-carol <-> b-dave
    let connect_pair = |nodes: &mut BTreeMap<String, MeshNode>,
                        u: &str,
                        u_name: &str,
                        u_pk: [u8; 32],
                        v: &str,
                        v_name: &str,
                        v_pk: [u8; 32]|
     -> TestResult {
        let a1 = nodes
            .get_mut(u)
            .ok_or("missing u")?
            .on_peer_connected(v.into(), v_name.into(), v_pk, false, None)?;
        let a2 = nodes
            .get_mut(v)
            .ok_or("missing v")?
            .on_peer_connected(u.into(), u_name.into(), u_pk, false, None)?;
        drain_network(nodes, vec![(u.into(), a1), (v.into(), a2)])
    };

    connect_pair(&mut nodes, "z-alice", "Alice", pk_a, "a-bob", "Bob", pk_b)?;
    assert_eq!(nodes["z-alice"].color_for_peer("z-alice"), 0);
    assert_eq!(nodes["a-bob"].color_for_peer("z-alice"), 0);
    assert_eq!(nodes["z-alice"].color_for_peer("a-bob"), 1);
    assert_eq!(nodes["a-bob"].color_for_peer("a-bob"), 1);

    connect_pair(&mut nodes, "a-bob", "Bob", pk_b, "m-carol", "Carol", pk_c)?;
    connect_pair(&mut nodes, "m-carol", "Carol", pk_c, "b-dave", "Dave", pk_d)?;

    // ALL 4 peers across the 4-node chain MUST agree bit-for-bit on ALL 4 unique colors!
    let expected = nodes["z-alice"].peer_colors_map();
    assert_eq!(expected.len(), 4);
    assert_eq!(expected["z-alice"], 0);
    let unique_colors: BTreeSet<u32> = expected.values().copied().collect();
    assert_eq!(unique_colors.len(), 4, "Duplicate peer colors detected: {expected:?}");
    for (pid, node) in &nodes {
        assert_eq!(
            node.peer_colors_map(),
            expected,
            "Node {pid} diverged on peer colors"
        );
    }

    // Verify status_json exposes peerColors cleanly
    let status_val = parse_json(&nodes["b-dave"].status_json())?;
    let pc_obj = status_val
        .get("peerColors")
        .ok_or("status_json missing peerColors")?;
    assert_eq!(pc_obj.get_u64("z-alice"), Some(0));
    assert_eq!(pc_obj.get_u64("a-bob"), Some(1));

    // 2. Partitioned simultaneous creators (both committed color=0, lamport=1 while disconnected)
    //    MUST resolve collision identically with zero duplicates once connected!
    let mut part_nodes: BTreeMap<String, MeshNode> = BTreeMap::new();
    let mut p1 = make_node("p-111", "P1", 0x55);
    let mut p2 = make_node("p-999", "P2", 0x66);
    let _ = p1.commit_self_color();
    let _ = p2.commit_self_color();
    assert_eq!(p1.color_for_peer("p-111"), 0);
    assert_eq!(p2.color_for_peer("p-999"), 0);
    let pk1 = p1.public_key();
    let pk2 = p2.public_key();
    part_nodes.insert("p-111".into(), p1);
    part_nodes.insert("p-999".into(), p2);
    connect_pair(&mut part_nodes, "p-111", "P1", pk1, "p-999", "P2", pk2)?;
    assert_eq!(part_nodes["p-111"].peer_colors_map(), part_nodes["p-999"].peer_colors_map());
    assert_eq!(part_nodes["p-111"].color_for_peer("p-111"), 0);
    assert_eq!(part_nodes["p-111"].color_for_peer("p-999"), 1);

    Ok(())
}




