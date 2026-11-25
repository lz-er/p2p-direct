use std::fmt::Write as _;

use crate::crypto::{
    KEY_LEN, NONCE_LEN, aead_open, aead_seal, parse_fixed_12, parse_fixed_32,
};
use crate::deflate::{base64url_decode, base64url_encode};
use crate::json::{JsonValue, parse_json, write_json_string, write_json_value};
use crate::log::SealedLogRecord;

pub const DEFAULT_GOSSIP_TTL: u32 = 16;
pub const DEFAULT_RELAY_TTL: u32 = 8;
pub const DEFAULT_INV_CHUNK_IDS: usize = 200;
pub const DEFAULT_BATCH_MAX_MSGS: usize = 16;
pub const DEFAULT_BATCH_MAX_BYTES: usize = 11_000;

/// Outer ChaCha20-Poly1305 AEAD envelope wrapping EVERY frame sent over WebRTC DataChannels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedWireEnvelope {
    pub version: u64,
    pub seq: u64,
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

impl EncryptedWireEnvelope {
    fn aad_bytes(sender_id: &str, receiver_id: &str, seq: u64) -> Vec<u8> {
        format!("p2p-wire-v1|{sender_id}->{receiver_id}|{seq}").into_bytes()
    }

    pub fn seal(
        tx_key: &[u8; KEY_LEN],
        seq: u64,
        nonce: [u8; NONCE_LEN],
        sender_id: &str,
        receiver_id: &str,
        plaintext_frame: &str,
    ) -> Self {
        let aad = Self::aad_bytes(sender_id, receiver_id, seq);
        let ciphertext = aead_seal(tx_key, &nonce, &aad, plaintext_frame.as_bytes());
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
        let aad = Self::aad_bytes(sender_id, receiver_id, self.seq);
        let plain = aead_open(rx_key, &self.nonce, &aad, &self.ciphertext)?;
        String::from_utf8(plain)
            .map_err(|_| "decrypted wire frame is not valid UTF-8".to_owned())
    }

    pub fn to_json_string(&self) -> String {
        let mut out = String::with_capacity(self.ciphertext.len() * 2 + 64);
        let _ = write!(
            out,
            "{{\"kind\":\"e2ee\",\"v\":{},\"s\":{},\"n\":",
            self.version, self.seq
        );
        write_json_string(&mut out, &base64url_encode(&self.nonce));
        out.push_str(",\"c\":");
        write_json_string(&mut out, &base64url_encode(&self.ciphertext));
        out.push('}');
        out
    }

    pub fn parse_json(raw: &str) -> Result<Self, String> {
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

#[derive(Debug, Clone, PartialEq)]
pub enum WireFrame {
    Hello {
        peer_id: String,
        author_name: String,
        room: String,
        pub_key: [u8; KEY_LEN],
        lamport: u64,
        log_count: usize,
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
}

impl WireFrame {
    pub fn to_json_string(&self) -> String {
        let mut out = String::with_capacity(256);
        match self {
            Self::Hello {
                peer_id,
                author_name,
                room,
                pub_key,
                lamport,
                log_count,
                peers,
            } => {
                out.push_str("{\"kind\":\"hello\",\"peerId\":");
                write_json_string(&mut out, peer_id);
                out.push_str(",\"authorName\":");
                write_json_string(&mut out, author_name);
                out.push_str(",\"room\":");
                write_json_string(&mut out, room);
                out.push_str(",\"pubKey\":");
                write_json_string(&mut out, &base64url_encode(pub_key));
                let _ = write!(
                    out,
                    ",\"lamport\":{lamport},\"logCount\":{log_count},\"peers\":["
                );
                for (i, p) in peers.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str("{\"peerId\":");
                    write_json_string(&mut out, &p.peer_id);
                    out.push_str(",\"authorName\":");
                    write_json_string(&mut out, &p.author_name);
                    out.push_str(",\"pubKey\":");
                    write_json_string(&mut out, &base64url_encode(&p.pub_key));
                    out.push('}');
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
            } => {
                out.push_str("{\"kind\":\"mesh-intro\",\"via\":");
                write_json_string(&mut out, via);
                out.push_str(",\"peerId\":");
                write_json_string(&mut out, peer_id);
                out.push_str(",\"authorName\":");
                write_json_string(&mut out, author_name);
                out.push_str(",\"pubKey\":");
                write_json_string(&mut out, &base64url_encode(pub_key));
                out.push('}');
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
                out.push_str(",\"fromPubKey\":");
                write_json_string(&mut out, &base64url_encode(from_pub_key));
                out.push_str(",\"to\":");
                write_json_string(&mut out, to);
                out.push_str(",\"via\":");
                write_json_string(&mut out, via);
                out.push_str(",\"hops\":");
                write_string_array(&mut out, hops);
                let _ = write!(out, ",\"ttl\":{ttl},\"sn\":");
                write_json_string(&mut out, &base64url_encode(sealed_nonce));
                out.push_str(",\"sc\":");
                write_json_string(&mut out, &base64url_encode(sealed_ciphertext));
                out.push('}');
            }
        }
        out
    }

    pub fn parse_json(raw: &str) -> Result<Self, String> {
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
                Ok(Self::MeshIntro {
                    via,
                    peer_id,
                    author_name,
                    pub_key,
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
