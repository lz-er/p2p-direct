use std::fmt::Write as _;

use crate::json::{JsonValue, parse_json, write_json_string, write_json_value};
use crate::log::LogMessage;

pub const DEFAULT_GOSSIP_TTL: u32 = 16;
pub const DEFAULT_RELAY_TTL: u32 = 8;
pub const DEFAULT_INV_CHUNK_IDS: usize = 200;
pub const DEFAULT_BATCH_MAX_MSGS: usize = 20;
pub const DEFAULT_BATCH_MAX_BYTES: usize = 12_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerSummary {
    pub peer_id: String,
    pub author_name: String,
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

#[derive(Debug, Clone, PartialEq)]
pub enum WireFrame {
    Hello {
        peer_id: String,
        author_name: String,
        room: String,
        lamport: u64,
        log_count: usize,
        peers: Vec<PeerSummary>,
    },
    Msg {
        origin: String,
        ttl: u32,
        path: Vec<String>,
        message: LogMessage,
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
        messages: Vec<LogMessage>,
    },
    MeshIntro {
        via: String,
        peer_id: String,
        author_name: String,
    },
    RelaySignal {
        from: String,
        from_name: String,
        to: String,
        via: String,
        hops: Vec<String>,
        ttl: u32,
        signal_type: RelaySignalType,
        sdp: Option<String>,
        candidate: Option<JsonValue>,
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
                let _ = write!(out, ",\"lamport\":{lamport},\"logCount\":{log_count},\"peers\":[");
                for (i, p) in peers.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str("{\"peerId\":");
                    write_json_string(&mut out, &p.peer_id);
                    out.push_str(",\"authorName\":");
                    write_json_string(&mut out, &p.author_name);
                    out.push('}');
                }
                out.push_str("]}");
            }
            Self::Msg {
                origin,
                ttl,
                path,
                message,
            } => {
                out.push_str("{\"kind\":\"msg\",\"origin\":");
                write_json_string(&mut out, origin);
                let _ = write!(out, ",\"ttl\":{ttl},\"path\":");
                write_string_array(&mut out, path);
                out.push_str(",\"message\":");
                message.write_json(&mut out);
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
                messages,
            } => {
                out.push_str("{\"kind\":\"sync-batch\",\"from\":");
                write_json_string(&mut out, from);
                out.push_str(",\"batchId\":");
                write_json_string(&mut out, batch_id);
                let _ = write!(
                    out,
                    ",\"chunk\":{chunk},\"totalChunks\":{total_chunks},\"messages\":["
                );
                for (i, msg) in messages.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    msg.write_json(&mut out);
                }
                out.push_str("]}");
            }
            Self::MeshIntro {
                via,
                peer_id,
                author_name,
            } => {
                out.push_str("{\"kind\":\"mesh-intro\",\"via\":");
                write_json_string(&mut out, via);
                out.push_str(",\"peerId\":");
                write_json_string(&mut out, peer_id);
                out.push_str(",\"authorName\":");
                write_json_string(&mut out, author_name);
                out.push('}');
            }
            Self::RelaySignal {
                from,
                from_name,
                to,
                via,
                hops,
                ttl,
                signal_type,
                sdp,
                candidate,
            } => {
                out.push_str("{\"kind\":\"relay-signal\",\"from\":");
                write_json_string(&mut out, from);
                out.push_str(",\"fromName\":");
                write_json_string(&mut out, from_name);
                out.push_str(",\"to\":");
                write_json_string(&mut out, to);
                out.push_str(",\"via\":");
                write_json_string(&mut out, via);
                out.push_str(",\"hops\":");
                write_string_array(&mut out, hops);
                let _ = write!(out, ",\"ttl\":{ttl},\"signalType\":");
                write_json_string(&mut out, signal_type.as_str());
                out.push_str(",\"sdp\":");
                match sdp {
                    Some(s) => write_json_string(&mut out, s),
                    None => out.push_str("null"),
                }
                out.push_str(",\"candidate\":");
                match candidate {
                    Some(c) => write_json_value(&mut out, c),
                    None => out.push_str("null"),
                }
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
                let lamport = val.get_u64("lamport").unwrap_or(0);
                let log_count = val.get_u64("logCount").unwrap_or(0) as usize;
                let mut peers = Vec::new();
                if let Some(arr) = val.get("peers").and_then(JsonValue::as_array) {
                    for item in arr {
                        if let Some(pid) = item.get_str("peerId")
                            && !pid.trim().is_empty()
                        {
                            peers.push(PeerSummary {
                                peer_id: pid.to_owned(),
                                author_name: item
                                    .get_str("authorName")
                                    .unwrap_or("Peer")
                                    .to_owned(),
                            });
                        }
                    }
                }
                Ok(Self::Hello {
                    peer_id,
                    author_name,
                    room,
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
                let msg_val = val
                    .get("message")
                    .ok_or_else(|| "msg frame missing 'message' object".to_owned())?;
                let message = LogMessage::from_json_value(msg_val)?;
                Ok(Self::Msg {
                    origin,
                    ttl,
                    path,
                    message,
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
                    .get("messages")
                    .and_then(JsonValue::as_array)
                    .ok_or_else(|| "sync-batch missing 'messages' array".to_owned())?;
                let mut messages = Vec::with_capacity(arr.len());
                for item in arr {
                    messages.push(LogMessage::from_json_value(item)?);
                }
                Ok(Self::SyncBatch {
                    from,
                    batch_id,
                    chunk,
                    total_chunks,
                    messages,
                })
            }
            "mesh-intro" => {
                let via = req_str(&val, "via")?;
                let peer_id = req_str(&val, "peerId")?;
                let author_name = val.get_str("authorName").unwrap_or("Peer").to_owned();
                Ok(Self::MeshIntro {
                    via,
                    peer_id,
                    author_name,
                })
            }
            "relay-signal" => {
                let from = req_str(&val, "from")?;
                let from_name = val.get_str("fromName").unwrap_or("Peer").to_owned();
                let to = req_str(&val, "to")?;
                let via = val.get_str("via").unwrap_or("").to_owned();
                let hops = parse_string_array(val.get("hops"));
                let ttl = val
                    .get_u64("ttl")
                    .unwrap_or(u64::from(DEFAULT_RELAY_TTL))
                    .min(u64::from(u32::MAX)) as u32;
                let sig_str = req_str(&val, "signalType")?;
                let signal_type = RelaySignalType::from_str_kind(&sig_str)
                    .ok_or_else(|| format!("unknown relay signalType '{sig_str}'"))?;
                let sdp = val.get_str("sdp").map(str::to_owned);
                let candidate = match val.get("candidate") {
                    Some(JsonValue::Null) | None => None,
                    Some(other) => Some(other.clone()),
                };
                Ok(Self::RelaySignal {
                    from,
                    from_name,
                    to,
                    via,
                    hops,
                    ttl,
                    signal_type,
                    sdp,
                    candidate,
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

pub fn chunk_sync_messages(
    messages: &[LogMessage],
    max_msgs_per_chunk: usize,
    max_bytes_per_chunk: usize,
) -> Vec<Vec<LogMessage>> {
    if messages.is_empty() {
        return Vec::new();
    }
    let msg_limit = max_msgs_per_chunk.max(1);
    let byte_limit = max_bytes_per_chunk.max(512);

    let mut chunks: Vec<Vec<LogMessage>> = Vec::new();
    let mut current: Vec<LogMessage> = Vec::new();
    let mut current_bytes: usize = 128; // JSON envelope overhead

    for msg in messages {
        let est_size = msg.to_json_string().len() + 2;
        let would_overflow_count = current.len() >= msg_limit;
        let would_overflow_bytes = !current.is_empty() && current_bytes.saturating_add(est_size) > byte_limit;
        if would_overflow_count || would_overflow_bytes {
            chunks.push(current);
            current = Vec::new();
            current_bytes = 128;
        }
        current.push(msg.clone());
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
