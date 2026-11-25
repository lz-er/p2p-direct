use std::fmt::Write as _;

use crate::crypto::{
    AadBuf, KEY_LEN, NONCE_LEN, aead_open, aead_open_into, aead_seal, aead_seal_into,
    parse_fixed_12, parse_fixed_32,
};
use crate::deflate::{base64url_decode, base64url_encode_into};
use crate::json::{JsonValue, parse_json, write_json_string, write_json_value};
use crate::log::SealedLogRecord;
use crate::media::MediaSyncState;

pub const DEFAULT_GOSSIP_TTL: u32 = 16;
pub const DEFAULT_RELAY_TTL: u32 = 8;
pub const DEFAULT_INV_CHUNK_IDS: usize = 200;
pub const DEFAULT_BATCH_MAX_MSGS: usize = 16;
pub const DEFAULT_BATCH_MAX_BYTES: usize = 11_000;

fn build_directional_aad(prefix: &[u8], sender_id: &str, receiver_id: &str, seq: u64) -> AadBuf {
    let mut aad = AadBuf::new();
    aad.push_bytes(prefix);
    aad.push_bytes(sender_id.as_bytes());
    aad.push_bytes(b"->");
    aad.push_bytes(receiver_id.as_bytes());
    aad.push_bytes(b"|");
    aad.push_u64_dec(seq);
    aad
}

#[inline(always)]
fn zc_skip_ws(bytes: &[u8], pos: &mut usize) {
    while let Some(&b) = bytes.get(*pos) {
        if matches!(b, b' ' | b'\t' | b'\r' | b'\n') {
            *pos += 1;
        } else {
            break;
        }
    }
}

#[inline(always)]
fn zc_read_plain_str<'a>(raw: &'a str, bytes: &[u8], pos: &mut usize) -> Option<&'a str> {
    if bytes.get(*pos) != Some(&b'"') {
        return None;
    }
    *pos += 1;
    let start = *pos;
    let mut advance = 0usize;
    for &b in &bytes[start..] {
        if (0x20..0x80).contains(&b) && b != b'"' && b != b'\\' {
            advance += 1;
        } else {
            break;
        }
    }
    *pos += advance;
    if bytes.get(*pos) != Some(&b'"') {
        return None;
    }
    let s = &raw[start..*pos];
    *pos += 1;
    Some(s)
}

#[inline(always)]
fn zc_read_u64(bytes: &[u8], pos: &mut usize) -> Option<u64> {
    let start = *pos;
    let mut val = 0u64;
    while let Some(&b) = bytes.get(*pos) {
        if b.is_ascii_digit() {
            val = val.checked_mul(10)?.checked_add(u64::from(b - b'0'))?;
            *pos += 1;
        } else {
            break;
        }
    }
    if *pos == start { None } else { Some(val) }
}

/// Zero-copy fast scanner for standard compact `{"kind":"e2ee","v":...,"s":...,"n":"...","c":"..."}`
/// JSON objects. Borrows `"n"` and `"c"` directly from `raw` so multi-MB GIF envelopes never
/// allocate a redundant 2+ MB `String` copy inside a `BTreeMap` before Base64 decoding.
/// Returns `None` if input uses escapes or unexpected syntax (caller falls back to `parse_json`).
fn parse_e2ee_envelope_zero_copy(raw: &str) -> Option<Result<EncryptedWireEnvelope, String>> {
    let bytes = raw.as_bytes();
    let mut pos = 0usize;

    zc_skip_ws(bytes, &mut pos);
    if bytes.get(pos) != Some(&b'{') {
        return None;
    }
    pos += 1;

    let mut kind: Option<&str> = None;
    let mut version: Option<u64> = None;
    let mut seq: Option<u64> = None;
    let mut nonce_b64: Option<&str> = None;
    let mut ct_b64: Option<&str> = None;

    zc_skip_ws(bytes, &mut pos);
    if bytes.get(pos) == Some(&b'}') {
        return None;
    }
    loop {
        zc_skip_ws(bytes, &mut pos);
        let key = zc_read_plain_str(raw, bytes, &mut pos)?;
        zc_skip_ws(bytes, &mut pos);
        if bytes.get(pos) != Some(&b':') {
            return None;
        }
        pos += 1;
        zc_skip_ws(bytes, &mut pos);
        match key {
            "kind" => kind = Some(zc_read_plain_str(raw, bytes, &mut pos)?),
            "v" => version = Some(zc_read_u64(bytes, &mut pos)?),
            "s" => seq = Some(zc_read_u64(bytes, &mut pos)?),
            "n" => nonce_b64 = Some(zc_read_plain_str(raw, bytes, &mut pos)?),
            "c" => ct_b64 = Some(zc_read_plain_str(raw, bytes, &mut pos)?),
            _ => return None,
        }
        zc_skip_ws(bytes, &mut pos);
        match bytes.get(pos) {
            Some(&b',') => {
                pos += 1;
                continue;
            }
            Some(&b'}') => {
                pos += 1;
                break;
            }
            _ => return None,
        }
    }
    zc_skip_ws(bytes, &mut pos);
    if pos != bytes.len() {
        return None;
    }

    let kind_str = kind?;
    if kind_str != "e2ee" {
        return Some(Err(format!(
            "rejected unencrypted wire frame kind '{kind_str}' (E2EE required)"
        )));
    }
    let v = version?;
    let s = seq?;
    let n_str = nonce_b64?;
    let c_str = ct_b64?;
    let nonce = match base64url_decode(n_str).and_then(|b| parse_fixed_12(&b, "wire nonce")) {
        Ok(n) => n,
        Err(e) => return Some(Err(e)),
    };
    let ciphertext = match base64url_decode(c_str) {
        Ok(c) => c,
        Err(e) => return Some(Err(e)),
    };
    Some(Ok(EncryptedWireEnvelope {
        version: v,
        seq: s,
        nonce,
        ciphertext,
    }))
}

/// Zero-copy fast scanner for `WireFrame::Msg` so multi-MB encrypted log records decode
/// directly from borrowed `"c"` slices without allocating a 2 MB temporary `String`.
fn parse_msg_wire_zero_copy(raw: &str) -> Option<Result<WireFrame, String>> {
    let bytes = raw.as_bytes();
    let mut pos = 0usize;
    zc_skip_ws(bytes, &mut pos);
    if bytes.get(pos) != Some(&b'{') {
        return None;
    }
    pos += 1;

    let mut kind: Option<&str> = None;
    let mut origin: Option<&str> = None;
    let mut ttl: Option<u64> = None;
    let mut path: Option<Vec<String>> = None;
    let mut rec_id: Option<&str> = None;
    let mut rec_lamport: Option<u64> = None;
    let mut rec_ts: Option<u64> = None;
    let mut rec_nonce_b64: Option<&str> = None;
    let mut rec_ct_b64: Option<&str> = None;

    zc_skip_ws(bytes, &mut pos);
    if bytes.get(pos) == Some(&b'}') {
        return None;
    }
    loop {
        zc_skip_ws(bytes, &mut pos);
        let key = zc_read_plain_str(raw, bytes, &mut pos)?;
        zc_skip_ws(bytes, &mut pos);
        if bytes.get(pos) != Some(&b':') {
            return None;
        }
        pos += 1;
        zc_skip_ws(bytes, &mut pos);
        match key {
            "kind" => {
                let k = zc_read_plain_str(raw, bytes, &mut pos)?;
                if k != "msg" {
                    return None;
                }
                kind = Some(k);
            }
            "origin" => origin = Some(zc_read_plain_str(raw, bytes, &mut pos)?),
            "ttl" => ttl = Some(zc_read_u64(bytes, &mut pos)?),
            "path" => {
                if bytes.get(pos) != Some(&b'[') {
                    return None;
                }
                pos += 1;
                let mut arr = Vec::new();
                zc_skip_ws(bytes, &mut pos);
                if bytes.get(pos) == Some(&b']') {
                    pos += 1;
                } else {
                    loop {
                        zc_skip_ws(bytes, &mut pos);
                        let item = zc_read_plain_str(raw, bytes, &mut pos)?;
                        arr.push(item.to_owned());
                        zc_skip_ws(bytes, &mut pos);
                        match bytes.get(pos) {
                            Some(&b',') => {
                                pos += 1;
                                continue;
                            }
                            Some(&b']') => {
                                pos += 1;
                                break;
                            }
                            _ => return None,
                        }
                    }
                }
                path = Some(arr);
            }
            "record" => {
                if bytes.get(pos) != Some(&b'{') {
                    return None;
                }
                pos += 1;
                zc_skip_ws(bytes, &mut pos);
                if bytes.get(pos) == Some(&b'}') {
                    return None;
                }
                loop {
                    zc_skip_ws(bytes, &mut pos);
                    let rkey = zc_read_plain_str(raw, bytes, &mut pos)?;
                    zc_skip_ws(bytes, &mut pos);
                    if bytes.get(pos) != Some(&b':') {
                        return None;
                    }
                    pos += 1;
                    zc_skip_ws(bytes, &mut pos);
                    match rkey {
                        "id" => rec_id = Some(zc_read_plain_str(raw, bytes, &mut pos)?),
                        "lamport" => rec_lamport = Some(zc_read_u64(bytes, &mut pos)?),
                        "ts" => rec_ts = Some(zc_read_u64(bytes, &mut pos)?),
                        "n" => rec_nonce_b64 = Some(zc_read_plain_str(raw, bytes, &mut pos)?),
                        "c" => rec_ct_b64 = Some(zc_read_plain_str(raw, bytes, &mut pos)?),
                        _ => return None,
                    }
                    zc_skip_ws(bytes, &mut pos);
                    match bytes.get(pos) {
                        Some(&b',') => {
                            pos += 1;
                            continue;
                        }
                        Some(&b'}') => {
                            pos += 1;
                            break;
                        }
                        _ => return None,
                    }
                }
            }
            _ => return None,
        }
        zc_skip_ws(bytes, &mut pos);
        match bytes.get(pos) {
            Some(&b',') => {
                pos += 1;
                continue;
            }
            Some(&b'}') => {
                pos += 1;
                break;
            }
            _ => return None,
        }
    }
    zc_skip_ws(bytes, &mut pos);
    if pos != bytes.len() || kind != Some("msg") {
        return None;
    }

    let origin_str = origin?;
    let id_str = rec_id?;
    if id_str.trim().is_empty() {
        return Some(Err("sealed record 'id' must not be empty".to_owned()));
    }
    let lamport = rec_lamport?;
    let ts = rec_ts?;
    let nonce = match base64url_decode(rec_nonce_b64?)
        .and_then(|b| parse_fixed_12(&b, "sealed record nonce"))
    {
        Ok(n) => n,
        Err(e) => return Some(Err(e)),
    };
    let ciphertext = match base64url_decode(rec_ct_b64?) {
        Ok(c) => c,
        Err(e) => return Some(Err(e)),
    };
    let ttl_u32 = ttl
        .unwrap_or(u64::from(DEFAULT_GOSSIP_TTL))
        .min(u64::from(u32::MAX)) as u32;
    Some(Ok(WireFrame::Msg {
        origin: origin_str.to_owned(),
        ttl: ttl_u32,
        path: path.unwrap_or_default(),
        record: SealedLogRecord {
            id: id_str.to_owned(),
            lamport,
            ts,
            nonce,
            ciphertext,
        },
    }))
}

/// Outer ChaCha20-Poly1305 AEAD envelope wrapping EVERY frame sent over WebRTC DataChannels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedWireEnvelope {
    pub version: u64,
    pub seq: u64,
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

impl EncryptedWireEnvelope {
    fn build_aad(sender_id: &str, receiver_id: &str, seq: u64) -> AadBuf {
        build_directional_aad(b"p2p-wire-v1|", sender_id, receiver_id, seq)
    }

    pub fn seal(
        tx_key: &[u8; KEY_LEN],
        seq: u64,
        nonce: [u8; NONCE_LEN],
        sender_id: &str,
        receiver_id: &str,
        plaintext_frame: &str,
    ) -> Self {
        let aad = Self::build_aad(sender_id, receiver_id, seq);
        let ciphertext = aead_seal(tx_key, &nonce, aad.as_slice(), plaintext_frame.as_bytes());
        Self {
            version: 1,
            seq,
            nonce,
            ciphertext,
        }
    }

    pub fn open(
        &self,
        rx_key: &[u8; KEY_LEN],
        sender_id: &str,
        receiver_id: &str,
    ) -> Result<String, String> {
        if self.version != 1 {
            return Err(format!("unsupported e2ee envelope version {}", self.version));
        }
        let aad = Self::build_aad(sender_id, receiver_id, self.seq);
        let plain = aead_open(rx_key, &self.nonce, aad.as_slice(), &self.ciphertext)?;
        String::from_utf8(plain)
            .map_err(|_| "decrypted wire frame is not valid UTF-8".to_owned())
    }

    pub fn to_json_string(&self) -> String {
        let mut out = String::with_capacity(self.ciphertext.len().div_ceil(3) * 4 + 96);
        let _ = write!(
            out,
            "{{\"kind\":\"e2ee\",\"v\":{},\"s\":{},\"n\":\"",
            self.version, self.seq
        );
        base64url_encode_into(&self.nonce, &mut out);
        out.push_str("\",\"c\":\"");
        base64url_encode_into(&self.ciphertext, &mut out);
        out.push_str("\"}");
        out
    }

    pub fn parse_json(raw: &str) -> Result<Self, String> {
        if let Some(fast) = parse_e2ee_envelope_zero_copy(raw) {
            return fast;
        }
        let val = parse_json(raw)?;
        let kind = val
            .get_str("kind")
            .ok_or_else(|| "wire message missing 'kind' (only encrypted 'e2ee' frames allowed)".to_owned())?;
        if kind != "e2ee" {
            return Err(format!(
                "rejected unencrypted wire frame kind '{kind}' (E2EE required)"
            ));
        }
        let version = val
            .get_u64("v")
            .ok_or_else(|| "e2ee envelope missing version 'v'".to_owned())?;
        let seq = val
            .get_u64("s")
            .ok_or_else(|| "e2ee envelope missing sequence 's'".to_owned())?;
        let nonce_b64 = val
            .get_str("n")
            .ok_or_else(|| "e2ee envelope missing nonce 'n'".to_owned())?;
        let ct_b64 = val
            .get_str("c")
            .ok_or_else(|| "e2ee envelope missing ciphertext 'c'".to_owned())?;
        let nonce = parse_fixed_12(&base64url_decode(nonce_b64)?, "wire nonce")?;
        let ciphertext = base64url_decode(ct_b64)?;
        Ok(Self {
            version,
            seq,
            nonce,
            ciphertext,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerSummary {
    pub peer_id: String,
    pub author_name: String,
    pub pub_key: [u8; KEY_LEN],
    pub is_bot: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelaySignalType {
    Offer,
    Answer,
    Ice,
}

impl RelaySignalType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Offer => "offer",
            Self::Answer => "answer",
            Self::Ice => "ice",
        }
    }

    pub fn from_str_kind(s: &str) -> Option<Self> {
        match s {
            "offer" => Some(Self::Offer),
            "answer" => Some(Self::Answer),
            "ice" => Some(Self::Ice),
            _ => None,
        }
    }
}

/// Inner payload of a `RelaySignal`, AEAD-encrypted end-to-end between `from` and `to`
/// so intermediate relay peers cannot read WebRTC SDP or ICE candidates.
#[derive(Debug, Clone, PartialEq)]
pub struct RelaySignalBody {
    pub signal_type: RelaySignalType,
    pub sdp: Option<String>,
    pub candidate: Option<JsonValue>,
}

impl RelaySignalBody {
    pub fn to_json_string(&self) -> String {
        let mut out = String::with_capacity(256);
        out.push_str("{\"signalType\":");
        write_json_string(&mut out, self.signal_type.as_str());
        out.push_str(",\"sdp\":");
        match &self.sdp {
            Some(s) => write_json_string(&mut out, s),
            None => out.push_str("null"),
        }
        out.push_str(",\"candidate\":");
        match &self.candidate {
            Some(c) => write_json_value(&mut out, c),
            None => out.push_str("null"),
        }
        out.push('}');
        out
    }

    pub fn parse_json(raw: &str) -> Result<Self, String> {
        let val = parse_json(raw)?;
        let sig_str = req_str(&val, "signalType")?;
        let signal_type = RelaySignalType::from_str_kind(&sig_str)
            .ok_or_else(|| format!("unknown relay signalType '{sig_str}'"))?;
        let sdp = val.get_str("sdp").map(str::to_owned);
        let candidate = match val.get("candidate") {
            Some(JsonValue::Null) | None => None,
            Some(other) => Some(other.clone()),
        };
        Ok(Self {
            signal_type,
            sdp,
            candidate,
        })
    }
}

pub const VOICE_PACKET_MAGIC: [u8; 2] = *b"V1";
pub const VOICE_V2_PACKET_MAGIC: [u8; 2] = *b"V2";
pub const VOICE_PACKET_HEADER_LEN: usize = 2 + 8 + NONCE_LEN;

/// Seals a raw IMA ADPCM voice frame directly into `out` with zero intermediate heap allocations:
/// `[b'V', b'1', seq_u64_le (8B), nonce (12B), ciphertext + 16B Poly1305 tag]`.
pub fn seal_voice_packet_into(
    tx_key: &[u8; KEY_LEN],
    seq: u64,
    nonce: [u8; NONCE_LEN],
    sender_id: &str,
    receiver_id: &str,
    adpcm_payload: &[u8],
    out: &mut Vec<u8>,
) {
    let aad = build_directional_aad(b"p2p-voice-v1|", sender_id, receiver_id, seq);
    out.reserve(VOICE_PACKET_HEADER_LEN + adpcm_payload.len() + 16);
    out.extend_from_slice(&VOICE_PACKET_MAGIC);
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&nonce);
    aead_seal_into(tx_key, &nonce, aad.as_slice(), adpcm_payload, out);
}

/// Seals a raw IMA ADPCM voice frame into a compact binary ChaCha20-Poly1305 packet:
/// `[b'V', b'1', seq_u64_le (8B), nonce (12B), ciphertext + 16B Poly1305 tag]`.
pub fn seal_voice_packet(
    tx_key: &[u8; KEY_LEN],
    seq: u64,
    nonce: [u8; NONCE_LEN],
    sender_id: &str,
    receiver_id: &str,
    adpcm_payload: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(VOICE_PACKET_HEADER_LEN + adpcm_payload.len() + 16);
    seal_voice_packet_into(tx_key, seq, nonce, sender_id, receiver_id, adpcm_payload, &mut out);
    out
}

/// Seals an opaque high-definition codec payload (e.g. 48 kHz Opus) directly into `out`
/// with zero intermediate heap allocations:
/// `[b'V', b'2', seq_u64_le (8B), nonce (12B), ciphertext + 16B Poly1305 tag]`.
pub fn seal_voice_v2_packet_into(
    tx_key: &[u8; KEY_LEN],
    seq: u64,
    nonce: [u8; NONCE_LEN],
    sender_id: &str,
    receiver_id: &str,
    raw_payload: &[u8],
    out: &mut Vec<u8>,
) {
    let aad = build_directional_aad(b"p2p-voice-v2|", sender_id, receiver_id, seq);
    out.reserve(VOICE_PACKET_HEADER_LEN + raw_payload.len() + 16);
    out.extend_from_slice(&VOICE_V2_PACKET_MAGIC);
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&nonce);
    aead_seal_into(tx_key, &nonce, aad.as_slice(), raw_payload, out);
}

/// Seals an opaque high-definition codec payload (e.g. 48 kHz Opus) into a binary `V2`
/// ChaCha20-Poly1305 packet:
/// `[b'V', b'2', seq_u64_le (8B), nonce (12B), ciphertext + 16B Poly1305 tag]`.
pub fn seal_voice_v2_packet(
    tx_key: &[u8; KEY_LEN],
    seq: u64,
    nonce: [u8; NONCE_LEN],
    sender_id: &str,
    receiver_id: &str,
    raw_payload: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(VOICE_PACKET_HEADER_LEN + raw_payload.len() + 16);
    seal_voice_v2_packet_into(tx_key, seq, nonce, sender_id, receiver_id, raw_payload, &mut out);
    out
}

fn parse_voice_header_with_magic<'a>(
    packet: &'a [u8],
    expected_magic: &[u8; 2],
    label: &str,
) -> Result<(u64, [u8; NONCE_LEN], &'a [u8]), String> {
    if packet.len() < VOICE_PACKET_HEADER_LEN + 16 {
        return Err(format!("voice packet shorter than {label} E2EE minimum length"));
    }
    if packet.get(0..2) != Some(&expected_magic[..]) {
        return Err(format!("rejected voice packet without {label} E2EE magic header"));
    }
    let seq_slice = packet
        .get(2..10)
        .ok_or_else(|| "voice packet missing sequence".to_owned())?;
    let mut seq_arr = [0u8; 8];
    seq_arr.copy_from_slice(seq_slice);
    let seq = u64::from_le_bytes(seq_arr);

    let nonce_slice = packet
        .get(10..VOICE_PACKET_HEADER_LEN)
        .ok_or_else(|| "voice packet missing nonce".to_owned())?;
    let nonce = parse_fixed_12(nonce_slice, "voice nonce")?;
    let ct = packet
        .get(VOICE_PACKET_HEADER_LEN..)
        .ok_or_else(|| "voice packet missing ciphertext".to_owned())?;
    Ok((seq, nonce, ct))
}

/// Parses a binary `V1` E2EE voice packet header into `(seq, nonce, ciphertext_with_tag)`.
pub fn parse_voice_packet_header(packet: &[u8]) -> Result<(u64, [u8; NONCE_LEN], &[u8]), String> {
    parse_voice_header_with_magic(packet, &VOICE_PACKET_MAGIC, "V1")
}

/// Parses a binary `V2` E2EE voice packet header into `(seq, nonce, ciphertext_with_tag)`.
pub fn parse_voice_v2_packet_header(
    packet: &[u8],
) -> Result<(u64, [u8; NONCE_LEN], &[u8]), String> {
    parse_voice_header_with_magic(packet, &VOICE_V2_PACKET_MAGIC, "V2")
}

/// Authenticates and decrypts the ADPCM payload of a parsed `V1` E2EE voice packet into `out`.
pub fn open_voice_packet_ciphertext_into(
    rx_key: &[u8; KEY_LEN],
    seq: u64,
    nonce: &[u8; NONCE_LEN],
    sender_id: &str,
    receiver_id: &str,
    ciphertext: &[u8],
    out: &mut Vec<u8>,
) -> Result<(), String> {
    let aad = build_directional_aad(b"p2p-voice-v1|", sender_id, receiver_id, seq);
    aead_open_into(rx_key, nonce, aad.as_slice(), ciphertext, out)
}

/// Authenticates and decrypts the ADPCM payload of a parsed `V1` E2EE voice packet.
pub fn open_voice_packet_ciphertext(
    rx_key: &[u8; KEY_LEN],
    seq: u64,
    nonce: &[u8; NONCE_LEN],
    sender_id: &str,
    receiver_id: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    let aad = build_directional_aad(b"p2p-voice-v1|", sender_id, receiver_id, seq);
    aead_open(rx_key, nonce, aad.as_slice(), ciphertext)
}

/// Authenticates and decrypts the raw codec payload of a parsed `V2` E2EE voice packet into `out`.
pub fn open_voice_v2_packet_ciphertext_into(
    rx_key: &[u8; KEY_LEN],
    seq: u64,
    nonce: &[u8; NONCE_LEN],
    sender_id: &str,
    receiver_id: &str,
    ciphertext: &[u8],
    out: &mut Vec<u8>,
) -> Result<(), String> {
    let aad = build_directional_aad(b"p2p-voice-v2|", sender_id, receiver_id, seq);
    aead_open_into(rx_key, nonce, aad.as_slice(), ciphertext, out)
}

/// Authenticates and decrypts the raw codec payload of a parsed `V2` E2EE voice packet.
pub fn open_voice_v2_packet_ciphertext(
    rx_key: &[u8; KEY_LEN],
    seq: u64,
    nonce: &[u8; NONCE_LEN],
    sender_id: &str,
    receiver_id: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    let aad = build_directional_aad(b"p2p-voice-v2|", sender_id, receiver_id, seq);
    aead_open(rx_key, nonce, aad.as_slice(), ciphertext)
}

/// Serializes a `WireFrame::Msg` directly from borrowed ciphertext bytes (zero multi-MB clone!).
#[allow(clippy::too_many_arguments)]
pub fn write_msg_wire_json_borrowed(
    origin: &str,
    ttl: u32,
    path: &[String],
    rec_id: &str,
    rec_lamport: u64,
    rec_ts: u64,
    rec_nonce: &[u8; NONCE_LEN],
    rec_ciphertext: &[u8],
) -> String {
    let cap = rec_ciphertext.len().div_ceil(3) * 4 + 256;
    let mut out = String::with_capacity(cap);
    out.push_str("{\"kind\":\"msg\",\"origin\":");
    write_json_string(&mut out, origin);
    let _ = write!(out, ",\"ttl\":{ttl},\"path\":");
    write_string_array(&mut out, path);
    out.push_str(",\"record\":");
    SealedLogRecord::write_parts_json(
        &mut out,
        rec_id,
        rec_lamport,
        rec_ts,
        rec_nonce,
        rec_ciphertext,
    );
    out.push('}');
    out
}

pub const MAX_COLOR_SYNC_CLAIMS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerColorClaim {
    pub peer_id: String,
    pub color_idx: u32,
    /// `0` = tentative (pre-room / unresolved); `>= 1` = committed room Lamport order.
    pub claimed_lamport: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WireFrame {
    Hello {
        peer_id: String,
        author_name: String,
        room: String,
        pub_key: [u8; KEY_LEN],
        lamport: u64,
        log_count: usize,
        in_voice: bool,
        voice_muted: bool,
        is_bot: bool,
        peers: Vec<PeerSummary>,
    },
    Msg {
        origin: String,
        ttl: u32,
        path: Vec<String>,
        record: SealedLogRecord,
    },
    SyncInv {
        from: String,
        inv_id: String,
        part: usize,
        total_parts: usize,
        lamport: u64,
        ids: Vec<String>,
    },
    SyncReq {
        from: String,
        ids: Vec<String>,
    },
    SyncBatch {
        from: String,
        batch_id: String,
        chunk: usize,
        total_chunks: usize,
        records: Vec<SealedLogRecord>,
    },
    MeshIntro {
        via: String,
        peer_id: String,
        author_name: String,
        pub_key: [u8; KEY_LEN],
        is_bot: bool,
    },
    RelaySignal {
        from: String,
        from_name: String,
        from_pub_key: [u8; KEY_LEN],
        to: String,
        via: String,
        hops: Vec<String>,
        ttl: u32,
        sealed_nonce: [u8; NONCE_LEN],
        sealed_ciphertext: Vec<u8>,
    },
    Ping {
        ts: u64,
    },
    Pong {
        ts: u64,
        peer_ts: Option<u64>,
    },
    VoiceState {
        in_voice: bool,
        muted: bool,
    },
    BotAction {
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
    },
    MediaSync {
        origin: String,
        ttl: u32,
        state: MediaSyncState,
    },
    ColorSync {
        origin: String,
        ttl: u32,
        claims: Vec<PeerColorClaim>,
    },
}

impl WireFrame {
    pub fn to_json_string(&self) -> String {
        let cap = match self {
            Self::Msg { record, .. } => record.ciphertext.len().div_ceil(3) * 4 + 256,
            Self::SyncBatch { records, .. } => {
                let bytes: usize = records
                    .iter()
                    .map(|r| r.ciphertext.len().div_ceil(3) * 4 + 128)
                    .sum();
                bytes.saturating_add(160)
            }
            Self::RelaySignal {
                sealed_ciphertext, ..
            } => sealed_ciphertext.len().div_ceil(3) * 4 + 320,
            Self::MediaSync { state, .. } => 384 + state.queue.len() * 192,
            Self::ColorSync { claims, .. } => 96 + claims.len().saturating_mul(48),
            _ => 256,
        };
        let mut out = String::with_capacity(cap);
        match self {
            Self::Hello {
                peer_id,
                author_name,
                room,
                pub_key,
                lamport,
                log_count,
                in_voice,
                voice_muted,
                is_bot,
                peers,
            } => {
                out.push_str("{\"kind\":\"hello\",\"peerId\":");
                write_json_string(&mut out, peer_id);
                out.push_str(",\"authorName\":");
                write_json_string(&mut out, author_name);
                out.push_str(",\"room\":");
                write_json_string(&mut out, room);
                out.push_str(",\"pubKey\":\"");
                base64url_encode_into(pub_key, &mut out);
                let _ = write!(
                    out,
                    "\",\"lamport\":{lamport},\"logCount\":{log_count},\"inVoice\":{in_voice},\"voiceMuted\":{voice_muted},\"isBot\":{is_bot},\"peers\":["
                );
                for (i, p) in peers.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str("{\"peerId\":");
                    write_json_string(&mut out, &p.peer_id);
                    out.push_str(",\"authorName\":");
                    write_json_string(&mut out, &p.author_name);
                    out.push_str(",\"pubKey\":\"");
                    base64url_encode_into(&p.pub_key, &mut out);
                    let _ = write!(out, "\",\"isBot\":{}}}", p.is_bot);
                }
                out.push_str("]}");
            }
            Self::Msg {
                origin,
                ttl,
                path,
                record,
            } => {
                out.push_str("{\"kind\":\"msg\",\"origin\":");
                write_json_string(&mut out, origin);
                let _ = write!(out, ",\"ttl\":{ttl},\"path\":");
                write_string_array(&mut out, path);
                out.push_str(",\"record\":");
                record.write_json(&mut out);
                out.push('}');
            }
            Self::SyncInv {
                from,
                inv_id,
                part,
                total_parts,
                lamport,
                ids,
            } => {
                out.push_str("{\"kind\":\"sync-inv\",\"from\":");
                write_json_string(&mut out, from);
                out.push_str(",\"invId\":");
                write_json_string(&mut out, inv_id);
                let _ = write!(
                    out,
                    ",\"part\":{part},\"totalParts\":{total_parts},\"lamport\":{lamport},\"ids\":"
                );
                write_string_array(&mut out, ids);
                out.push('}');
            }
            Self::SyncReq { from, ids } => {
                out.push_str("{\"kind\":\"sync-req\",\"from\":");
                write_json_string(&mut out, from);
                out.push_str(",\"ids\":");
                write_string_array(&mut out, ids);
                out.push('}');
            }
            Self::SyncBatch {
                from,
                batch_id,
                chunk,
                total_chunks,
                records,
            } => {
                out.push_str("{\"kind\":\"sync-batch\",\"from\":");
                write_json_string(&mut out, from);
                out.push_str(",\"batchId\":");
                write_json_string(&mut out, batch_id);
                let _ = write!(
                    out,
                    ",\"chunk\":{chunk},\"totalChunks\":{total_chunks},\"records\":["
                );
                for (i, rec) in records.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    rec.write_json(&mut out);
                }
                out.push_str("]}");
            }
            Self::MeshIntro {
                via,
                peer_id,
                author_name,
                pub_key,
                is_bot,
            } => {
                out.push_str("{\"kind\":\"mesh-intro\",\"via\":");
                write_json_string(&mut out, via);
                out.push_str(",\"peerId\":");
                write_json_string(&mut out, peer_id);
                out.push_str(",\"authorName\":");
                write_json_string(&mut out, author_name);
                out.push_str(",\"pubKey\":\"");
                base64url_encode_into(pub_key, &mut out);
                let _ = write!(out, "\",\"isBot\":{is_bot}}}");
            }
            Self::RelaySignal {
                from,
                from_name,
                from_pub_key,
                to,
                via,
                hops,
                ttl,
                sealed_nonce,
                sealed_ciphertext,
            } => {
                out.push_str("{\"kind\":\"relay-signal\",\"from\":");
                write_json_string(&mut out, from);
                out.push_str(",\"fromName\":");
                write_json_string(&mut out, from_name);
                out.push_str(",\"fromPubKey\":\"");
                base64url_encode_into(from_pub_key, &mut out);
                out.push_str("\",\"to\":");
                write_json_string(&mut out, to);
                out.push_str(",\"via\":");
                write_json_string(&mut out, via);
                out.push_str(",\"hops\":");
                write_string_array(&mut out, hops);
                let _ = write!(out, ",\"ttl\":{ttl},\"sn\":\"");
                base64url_encode_into(sealed_nonce, &mut out);
                out.push_str("\",\"sc\":\"");
                base64url_encode_into(sealed_ciphertext, &mut out);
                out.push_str("\"}");
            }
            Self::Ping { ts } => {
                let _ = write!(out, "{{\"kind\":\"ping\",\"t\":{ts}}}");
            }
            Self::Pong { ts, peer_ts } => {
                if let Some(pt) = peer_ts {
                    let _ = write!(out, "{{\"kind\":\"pong\",\"t\":{ts},\"pt\":{pt}}}");
                } else {
                    let _ = write!(out, "{{\"kind\":\"pong\",\"t\":{ts}}}");
                }
            }
            Self::VoiceState { in_voice, muted } => {
                let _ = write!(
                    out,
                    "{{\"kind\":\"voice-state\",\"inVoice\":{in_voice},\"muted\":{muted}}}"
                );
            }
            Self::BotAction {
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
                out.push_str("{\"kind\":\"bot-action\",\"actionUid\":");
                write_json_string(&mut out, action_uid);
                out.push_str(",\"from\":");
                write_json_string(&mut out, from);
                out.push_str(",\"fromName\":");
                write_json_string(&mut out, from_name);
                out.push_str(",\"to\":");
                write_json_string(&mut out, to);
                out.push_str(",\"messageId\":");
                write_json_string(&mut out, message_id);
                out.push_str(",\"actionId\":");
                write_json_string(&mut out, action_id);
                out.push_str(",\"label\":");
                write_json_string(&mut out, label);
                out.push_str(",\"value\":");
                write_json_value(&mut out, value);
                let _ = write!(out, ",\"ts\":{ts},\"ttl\":{ttl},\"hops\":");
                write_string_array(&mut out, hops);
                out.push('}');
            }
            Self::MediaSync { origin, ttl, state } => {
                out.push_str("{\"kind\":\"media-sync\",\"origin\":");
                write_json_string(&mut out, origin);
                let _ = write!(out, ",\"ttl\":{ttl},\"state\":");
                state.write_json(&mut out, state.anchor_local_ms);
                out.push('}');
            }
            Self::ColorSync {
                origin,
                ttl,
                claims,
            } => {
                out.push_str("{\"kind\":\"color-sync\",\"origin\":");
                write_json_string(&mut out, origin);
                let _ = write!(out, ",\"ttl\":{ttl},\"claims\":[");
                for (i, c) in claims.iter().take(MAX_COLOR_SYNC_CLAIMS).enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str("{\"p\":");
                    write_json_string(&mut out, &c.peer_id);
                    let _ = write!(out, ",\"c\":{},\"l\":{}}}", c.color_idx, c.claimed_lamport);
                }
                out.push_str("]}");
            }
        }
        out
    }

    pub fn parse_json(raw: &str) -> Result<Self, String> {
        if let Some(fast) = parse_msg_wire_zero_copy(raw) {
            return fast;
        }
        let val = parse_json(raw)?;
        let kind = val
            .get_str("kind")
            .ok_or_else(|| "wire frame missing string field 'kind'".to_owned())?;
        match kind {
            "hello" => {
                let peer_id = req_str(&val, "peerId")?;
                let author_name = val.get_str("authorName").unwrap_or("Peer").to_owned();
                let room = val.get_str("room").unwrap_or("default").to_owned();
                let pk_b64 = req_str(&val, "pubKey")?;
                let pub_key = parse_fixed_32(&base64url_decode(&pk_b64)?, "hello pubKey")?;
                let lamport = val.get_u64("lamport").unwrap_or(0);
                let log_count = val.get_u64("logCount").unwrap_or(0) as usize;
                let in_voice = val.get_bool("inVoice").unwrap_or(false);
                let voice_muted = val.get_bool("voiceMuted").unwrap_or(false);
                let is_bot = val.get_bool("isBot").unwrap_or(false);
                let mut peers = Vec::new();
                if let Some(arr) = val.get("peers").and_then(JsonValue::as_array) {
                    for item in arr {
                        if let Some(pid) = item.get_str("peerId")
                            && !pid.trim().is_empty()
                            && let Some(p_pk_b64) = item.get_str("pubKey")
                            && let Ok(pk_bytes) = base64url_decode(p_pk_b64)
                            && let Ok(p_pk) = parse_fixed_32(&pk_bytes, "peer summary pubKey")
                        {
                            peers.push(PeerSummary {
                                peer_id: pid.to_owned(),
                                author_name: item
                                    .get_str("authorName")
                                    .unwrap_or("Peer")
                                    .to_owned(),
                                pub_key: p_pk,
                                is_bot: item.get_bool("isBot").unwrap_or(false),
                            });
                        }
                    }
                }
                Ok(Self::Hello {
                    peer_id,
                    author_name,
                    room,
                    pub_key,
                    lamport,
                    log_count,
                    in_voice,
                    voice_muted,
                    is_bot,
                    peers,
                })
            }
            "msg" => {
                let origin = req_str(&val, "origin")?;
                let ttl = val
                    .get_u64("ttl")
                    .unwrap_or(u64::from(DEFAULT_GOSSIP_TTL))
                    .min(u64::from(u32::MAX)) as u32;
                let path = parse_string_array(val.get("path"));
                let rec_val = val
                    .get("record")
                    .ok_or_else(|| "msg frame missing 'record' object".to_owned())?;
                let record = SealedLogRecord::from_json_value(rec_val)?;
                Ok(Self::Msg {
                    origin,
                    ttl,
                    path,
                    record,
                })
            }
            "sync-inv" => {
                let from = req_str(&val, "from")?;
                let inv_id = val.get_str("invId").unwrap_or("inv-0").to_owned();
                let part = val.get_u64("part").unwrap_or(0) as usize;
                let total_parts = (val.get_u64("totalParts").unwrap_or(1) as usize).max(1);
                let lamport = val.get_u64("lamport").unwrap_or(0);
                let ids = parse_string_array(val.get("ids"));
                Ok(Self::SyncInv {
                    from,
                    inv_id,
                    part,
                    total_parts,
                    lamport,
                    ids,
                })
            }
            "sync-req" => {
                let from = req_str(&val, "from")?;
                let ids = parse_string_array(val.get("ids"));
                Ok(Self::SyncReq { from, ids })
            }
            "sync-batch" => {
                let from = req_str(&val, "from")?;
                let batch_id = val.get_str("batchId").unwrap_or("batch-0").to_owned();
                let chunk = val.get_u64("chunk").unwrap_or(0) as usize;
                let total_chunks = (val.get_u64("totalChunks").unwrap_or(1) as usize).max(1);
                let arr = val
                    .get("records")
                    .and_then(JsonValue::as_array)
                    .ok_or_else(|| "sync-batch missing 'records' array".to_owned())?;
                let mut records = Vec::with_capacity(arr.len());
                for item in arr {
                    records.push(SealedLogRecord::from_json_value(item)?);
                }
                Ok(Self::SyncBatch {
                    from,
                    batch_id,
                    chunk,
                    total_chunks,
                    records,
                })
            }
            "mesh-intro" => {
                let via = req_str(&val, "via")?;
                let peer_id = req_str(&val, "peerId")?;
                let author_name = val.get_str("authorName").unwrap_or("Peer").to_owned();
                let pk_b64 = req_str(&val, "pubKey")?;
                let pub_key = parse_fixed_32(&base64url_decode(&pk_b64)?, "mesh-intro pubKey")?;
                let is_bot = val.get_bool("isBot").unwrap_or(false);
                Ok(Self::MeshIntro {
                    via,
                    peer_id,
                    author_name,
                    pub_key,
                    is_bot,
                })
            }
            "relay-signal" => {
                let from = req_str(&val, "from")?;
                let from_name = val.get_str("fromName").unwrap_or("Peer").to_owned();
                let pk_b64 = req_str(&val, "fromPubKey")?;
                let from_pub_key =
                    parse_fixed_32(&base64url_decode(&pk_b64)?, "relay-signal fromPubKey")?;
                let to = req_str(&val, "to")?;
                let via = val.get_str("via").unwrap_or("").to_owned();
                let hops = parse_string_array(val.get("hops"));
                let ttl = val
                    .get_u64("ttl")
                    .unwrap_or(u64::from(DEFAULT_RELAY_TTL))
                    .min(u64::from(u32::MAX)) as u32;
                let sn_b64 = req_str(&val, "sn")?;
                let sc_b64 = req_str(&val, "sc")?;
                let sealed_nonce =
                    parse_fixed_12(&base64url_decode(&sn_b64)?, "relay-signal nonce")?;
                let sealed_ciphertext = base64url_decode(&sc_b64)?;
                Ok(Self::RelaySignal {
                    from,
                    from_name,
                    from_pub_key,
                    to,
                    via,
                    hops,
                    ttl,
                    sealed_nonce,
                    sealed_ciphertext,
                })
            }
            "ping" => Ok(Self::Ping {
                ts: val.get_u64("t").unwrap_or(0),
            }),
            "pong" => Ok(Self::Pong {
                ts: val.get_u64("t").unwrap_or(0),
                peer_ts: val.get_u64("pt"),
            }),
            "voice-state" => Ok(Self::VoiceState {
                in_voice: val.get_bool("inVoice").unwrap_or(false),
                muted: val.get_bool("muted").unwrap_or(false),
            }),
            "bot-action" => {
                let action_uid = req_str(&val, "actionUid")?;
                let from = req_str(&val, "from")?;
                let from_name = val.get_str("fromName").unwrap_or("Peer").to_owned();
                let to = req_str(&val, "to")?;
                let message_id = req_str(&val, "messageId")?;
                let action_id = req_str(&val, "actionId")?;
                let label = val.get_str("label").unwrap_or("").to_owned();
                let value = val.get("value").cloned().unwrap_or(JsonValue::Null);
                let ts = val.get_u64("ts").unwrap_or(0);
                let hops = parse_string_array(val.get("hops"));
                let ttl = val
                    .get_u64("ttl")
                    .unwrap_or(u64::from(DEFAULT_RELAY_TTL))
                    .min(u64::from(u32::MAX)) as u32;
                Ok(Self::BotAction {
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
                })
            }
            "media-sync" => {
                let origin = req_str(&val, "origin")?;
                let ttl = val
                    .get_u64("ttl")
                    .unwrap_or(u64::from(DEFAULT_GOSSIP_TTL))
                    .min(u64::from(u32::MAX)) as u32;
                let state_val = val
                    .get("state")
                    .ok_or_else(|| "media-sync frame missing 'state' object".to_owned())?;
                let state = MediaSyncState::from_json_value(state_val, 0, 0)?;
                Ok(Self::MediaSync { origin, ttl, state })
            }
            "color-sync" => {
                let origin = req_str(&val, "origin")?;
                let ttl = val
                    .get_u64("ttl")
                    .unwrap_or(u64::from(DEFAULT_GOSSIP_TTL))
                    .min(u64::from(u32::MAX)) as u32;
                let mut claims = Vec::new();
                if let Some(arr) = val.get("claims").and_then(JsonValue::as_array) {
                    for item in arr.iter().take(MAX_COLOR_SYNC_CLAIMS) {
                        if let Some(pid) = item.get_str("p")
                            && !pid.trim().is_empty()
                        {
                            let color_idx = item
                                .get_u64("c")
                                .unwrap_or(0)
                                .min(u64::from(u32::MAX))
                                as u32;
                            let claimed_lamport = item.get_u64("l").unwrap_or(0);
                            claims.push(PeerColorClaim {
                                peer_id: pid.to_owned(),
                                color_idx,
                                claimed_lamport,
                            });
                        }
                    }
                }
                Ok(Self::ColorSync {
                    origin,
                    ttl,
                    claims,
                })
            }
            other => Err(format!("unknown wire frame kind '{other}'")),
        }
    }
}

pub fn chunk_inv_ids(ids: &[String], max_ids_per_chunk: usize) -> Vec<Vec<String>> {
    let limit = max_ids_per_chunk.max(1);
    if ids.is_empty() {
        return vec![Vec::new()];
    }
    let mut chunks = Vec::with_capacity(ids.len().div_ceil(limit));
    for slice in ids.chunks(limit) {
        chunks.push(slice.to_vec());
    }
    chunks
}

pub fn chunk_sealed_records(
    records: &[SealedLogRecord],
    max_msgs_per_chunk: usize,
    max_bytes_per_chunk: usize,
) -> Vec<Vec<SealedLogRecord>> {
    if records.is_empty() {
        return Vec::new();
    }
    let msg_limit = max_msgs_per_chunk.max(1);
    let byte_limit = max_bytes_per_chunk.max(512);

    let mut chunks: Vec<Vec<SealedLogRecord>> = Vec::new();
    let mut current: Vec<SealedLogRecord> = Vec::new();
    let mut current_bytes: usize = 160;

    for rec in records {
        let est_size = rec.to_json_string().len() + 2;
        let would_overflow_count = current.len() >= msg_limit;
        let would_overflow_bytes =
            !current.is_empty() && current_bytes.saturating_add(est_size) > byte_limit;
        if would_overflow_count || would_overflow_bytes {
            chunks.push(current);
            current = Vec::new();
            current_bytes = 160;
        }
        current.push(rec.clone());
        current_bytes = current_bytes.saturating_add(est_size);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn req_str(val: &JsonValue, key: &str) -> Result<String, String> {
    let s = val
        .get_str(key)
        .ok_or_else(|| format!("wire frame missing string field '{key}'"))?;
    if s.trim().is_empty() {
        return Err(format!("wire frame field '{key}' must not be empty"));
    }
    Ok(s.to_owned())
}

fn parse_string_array(val: Option<&JsonValue>) -> Vec<String> {
    let Some(arr) = val.and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        if let Some(s) = item.as_str() {
            out.push(s.to_owned());
        }
    }
    out
}

fn write_string_array(out: &mut String, items: &[String]) {
    out.push('[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_json_string(out, item);
    }
    out.push(']');
}
