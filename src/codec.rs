use crate::deflate::{base64url_decode, base64url_encode, deflate_raw, inflate_auto};
use crate::json::{parse_json, write_json_string};

pub const CODE_PREFIX: &str = "P2P1:";
pub const PROTOCOL_VERSION: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalCodeKind {
    Offer,
    Answer,
}

impl SignalCodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Offer => "offer",
            Self::Answer => "answer",
        }
    }

    pub fn fragment_key(self) -> &'static str {
        match self {
            Self::Offer => "offer",
            Self::Answer => "answer",
        }
    }

    pub fn from_str_kind(s: &str) -> Option<Self> {
        match s {
            "offer" => Some(Self::Offer),
            "answer" => Some(Self::Answer),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalCodePayload {
    pub version: u64,
    pub kind: SignalCodeKind,
    pub peer_id: String,
    pub author_name: String,
    pub room: String,
    pub invite_id: String,
    pub sdp: String,
}

impl SignalCodePayload {
    pub fn to_compact_json(&self) -> String {
        let mut out = String::with_capacity(self.sdp.len() + 128);
        out.push_str("{\"v\":");
        out.push_str(&self.version.to_string());
        out.push_str(",\"k\":");
        write_json_string(&mut out, self.kind.as_str());
        out.push_str(",\"p\":");
        write_json_string(&mut out, &self.peer_id);
        out.push_str(",\"n\":");
        write_json_string(&mut out, &self.author_name);
        out.push_str(",\"r\":");
        write_json_string(&mut out, &self.room);
        out.push_str(",\"i\":");
        write_json_string(&mut out, &self.invite_id);
        out.push_str(",\"s\":");
        write_json_string(&mut out, &self.sdp);
        out.push('}');
        out
    }
}

/// Normalizes SDP line endings to `\r\n` and removes empty lines without dropping WebRTC attributes.
pub fn normalize_sdp(sdp: &str) -> String {
    let mut out = String::with_capacity(sdp.len());
    for line in sdp.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            out.push_str(trimmed);
            out.push_str("\r\n");
        }
    }
    out
}

/// Compacts SDP line endings to `\n` for smaller deflate payloads (restored to `\r\n` on decode).
fn compact_sdp_for_wire(sdp: &str) -> String {
    let mut out = String::with_capacity(sdp.len());
    for line in sdp.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            out.push_str(trimmed);
            out.push('\n');
        }
    }
    out
}

/// Encodes a WebRTC offer or answer payload into a deflate-compressed `P2P1:` code.
pub fn encode_signal_code(payload: &SignalCodePayload) -> Result<String, String> {
    if payload.peer_id.trim().is_empty() {
        return Err("peer_id must not be empty".to_owned());
    }
    if payload.sdp.trim().is_empty() {
        return Err("sdp must not be empty".to_owned());
    }
    let normalized = SignalCodePayload {
        version: PROTOCOL_VERSION,
        kind: payload.kind,
        peer_id: payload.peer_id.clone(),
        author_name: payload.author_name.clone(),
        room: payload.room.clone(),
        invite_id: payload.invite_id.clone(),
        sdp: compact_sdp_for_wire(&payload.sdp),
    };
    let json = normalized.to_compact_json();
    let compressed = deflate_raw(json.as_bytes());
    let encoded = base64url_encode(&compressed);
    Ok(format!("{CODE_PREFIX}{encoded}"))
}

/// Builds a shareable URL with `#offer=P2P1:...` or `#answer=P2P1:...` fragment.
pub fn encode_fragment_url(base_url: &str, payload: &SignalCodePayload) -> Result<String, String> {
    let code = encode_signal_code(payload)?;
    let base = match base_url.split_once('#') {
        Some((prefix, _)) => prefix,
        None => base_url,
    };
    Ok(format!("{base}#{}={code}", payload.kind.fragment_key()))
}

/// Extracts an `#offer=` or `#answer=` value from a URL or raw hash fragment.
pub fn extract_fragment_code(input: &str) -> Option<(SignalCodeKind, String)> {
    let trimmed = input.trim();
    let hash_part = match trimmed.split_once('#') {
        Some((_, after)) => after,
        None => {
            if trimmed.starts_with("offer=") || trimmed.starts_with("answer=") {
                trimmed
            } else {
                return None;
            }
        }
    };
    for segment in hash_part.split('&') {
        if let Some((key, val)) = segment.split_once('=')
            && let Some(kind) = SignalCodeKind::from_str_kind(key.trim())
        {
            let decoded_val = percent_decode(val.trim());
            if !decoded_val.is_empty() {
                return Some((kind, decoded_val));
            }
        }
    }
    None
}

/// Decodes either a raw `P2P1:...` code or a full URL / `#offer=` / `#answer=` fragment.
pub fn decode_signal_code(input: &str) -> Result<SignalCodePayload, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("empty invite/reply code".to_owned());
    }

    let (expected_kind, raw_code) = match extract_fragment_code(trimmed) {
        Some((kind, code)) => (Some(kind), code),
        None => (None, trimmed.to_owned()),
    };

    let body = raw_code
        .strip_prefix(CODE_PREFIX)
        .ok_or_else(|| format!("signal code must start with '{CODE_PREFIX}'"))?;

    let compressed = base64url_decode(body)?;
    let raw_bytes = inflate_auto(&compressed)?;
    let json_str = std::str::from_utf8(&raw_bytes)
        .map_err(|_| "decompressed P2P1 payload is not valid UTF-8".to_owned())?;
    let val = parse_json(json_str)?;

    let version = val
        .get_u64("v")
        .ok_or_else(|| "missing or invalid version field 'v'".to_owned())?;
    if version != PROTOCOL_VERSION {
        return Err(format!("unsupported P2P1 protocol version {version}"));
    }

    let kind_str = val
        .get_str("k")
        .ok_or_else(|| "missing signal kind field 'k'".to_owned())?;
    let kind = SignalCodeKind::from_str_kind(kind_str)
        .ok_or_else(|| format!("unknown signal kind '{kind_str}'"))?;

    if let Some(exp) = expected_kind
        && exp != kind
    {
        return Err(format!(
            "URL fragment specifies #{} but P2P1 code contains '{}'",
            exp.fragment_key(),
            kind.as_str()
        ));
    }

    let peer_id = val
        .get_str("p")
        .ok_or_else(|| "missing peer id 'p'".to_owned())?
        .to_owned();
    if peer_id.trim().is_empty() {
        return Err("peer id 'p' must not be empty".to_owned());
    }

    let author_name = val.get_str("n").unwrap_or("Peer").to_owned();
    let room = val.get_str("r").unwrap_or("default").to_owned();
    let invite_id = val.get_str("i").unwrap_or("").to_owned();
    let sdp = val
        .get_str("s")
        .ok_or_else(|| "missing SDP field 's'".to_owned())?
        .to_owned();
    if sdp.trim().is_empty() {
        return Err("SDP field 's' must not be empty".to_owned());
    }

    Ok(SignalCodePayload {
        version,
        kind,
        peer_id,
        author_name,
        room,
        invite_id,
        sdp: normalize_sdp(&sdp),
    })
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes.get(i) == Some(&b'%')
            && let (Some(&h1), Some(&h2)) = (bytes.get(i + 1), bytes.get(i + 2))
            && let (Some(n1), Some(n2)) = (hex_val(h1), hex_val(h2))
        {
            out.push((n1 << 4) | n2);
            i += 3;
            continue;
        }
        if let Some(&b) = bytes.get(i) {
            out.push(b);
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_owned())
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
