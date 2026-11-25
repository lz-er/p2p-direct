use crate::crypto::{
    KEY_LEN, NONCE_LEN, SafeCsprng, aead_open, aead_seal, parse_fixed_12, parse_fixed_32,
};
use crate::deflate::{base64url_decode, base64url_encode, deflate_raw, inflate_auto};
use crate::json::{parse_json, write_json_string};

pub const CODE_PREFIX: &str = "P2P1:";
pub const PROTOCOL_VERSION: u64 = 1;
const E2E_INVITE_MAGIC: &[u8; 4] = b"E2E1";
const E2E_INVITE_AAD: &[u8] = b"P2P1-E2E1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalCodeKind {
    Offer,
    Answer,
    Room,
}

impl SignalCodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Offer => "offer",
            Self::Answer => "answer",
            Self::Room => "room",
        }
    }

    pub fn fragment_key(self) -> &'static str {
        match self {
            Self::Offer => "offer",
            Self::Answer => "answer",
            Self::Room => "room",
        }
    }

    pub fn from_str_kind(s: &str) -> Option<Self> {
        match s {
            "offer" => Some(Self::Offer),
            "answer" => Some(Self::Answer),
            "room" | "join" => Some(Self::Room),
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
    pub pub_key: [u8; KEY_LEN],
    pub mesh_key: Option<[u8; KEY_LEN]>,
    pub sdp: String,
    pub relay: Option<String>,
}

impl SignalCodePayload {
    pub fn to_compact_json(&self) -> String {
        if self.kind == SignalCodeKind::Room {
            let mut out = String::with_capacity(140);
            out.push_str("{\"v\":");
            out.push_str(&self.version.to_string());
            out.push_str(",\"k\":\"room\"");
            if !self.room.is_empty() {
                out.push_str(",\"r\":");
                write_json_string(&mut out, &self.room);
            }
            if let Some(mk) = &self.mesh_key {
                out.push_str(",\"k2\":");
                write_json_string(&mut out, &base64url_encode(mk));
            }
            if let Some(relay) = &self.relay
                && !relay.trim().is_empty()
            {
                out.push_str(",\"u\":");
                write_json_string(&mut out, relay.trim());
            }
            out.push('}');
            return out;
        }

        let mut out = String::with_capacity(self.sdp.len() + 256);
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
        out.push_str(",\"x\":");
        write_json_string(&mut out, &base64url_encode(&self.pub_key));
        if let Some(mk) = &self.mesh_key {
            out.push_str(",\"k2\":");
            write_json_string(&mut out, &base64url_encode(mk));
        }
        if let Some(relay) = &self.relay
            && !relay.trim().is_empty()
        {
            out.push_str(",\"u\":");
            write_json_string(&mut out, relay.trim());
        }
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

/// Encodes a WebRTC offer, answer, or long-lived room invite into a deflate-compressed `P2P1:` code.
/// When `wrap_key` is `Some`, the compressed payload is additionally AEAD-encrypted with ChaCha20-Poly1305.
pub fn encode_signal_code(
    payload: &SignalCodePayload,
    wrap_key: Option<&[u8; KEY_LEN]>,
    rng: &mut SafeCsprng,
) -> Result<String, String> {
    if payload.kind == SignalCodeKind::Room {
        if wrap_key.is_none() && payload.mesh_key.is_none() {
            return Err("room invite requires a mesh_key or passphrase wrap_key".to_owned());
        }
    } else {
        if payload.peer_id.trim().is_empty() {
            return Err("peer_id must not be empty".to_owned());
        }
        if payload.sdp.trim().is_empty() {
            return Err("sdp must not be empty".to_owned());
        }
    }
    let normalized = SignalCodePayload {
        version: PROTOCOL_VERSION,
        kind: payload.kind,
        peer_id: payload.peer_id.clone(),
        author_name: payload.author_name.clone(),
        room: payload.room.clone(),
        invite_id: payload.invite_id.clone(),
        pub_key: payload.pub_key,
        mesh_key: if wrap_key.is_some() {
            None
        } else {
            payload.mesh_key
        },
        sdp: if payload.kind == SignalCodeKind::Room {
            String::new()
        } else {
            compact_sdp_for_wire(&payload.sdp)
        },
        relay: payload
            .relay
            .as_ref()
            .map(|r| r.trim().to_owned())
            .filter(|r| !r.is_empty()),
    };
    let json = normalized.to_compact_json();
    let compressed = deflate_raw(json.as_bytes());
    let wire_bytes = match wrap_key {
        Some(key) => {
            let nonce = rng.next_nonce();
            let sealed = aead_seal(key, &nonce, E2E_INVITE_AAD, &compressed);
            let mut framed = Vec::with_capacity(4 + NONCE_LEN + sealed.len());
            framed.extend_from_slice(E2E_INVITE_MAGIC);
            framed.extend_from_slice(&nonce);
            framed.extend_from_slice(&sealed);
            framed
        }
        None => compressed,
    };
    let encoded = base64url_encode(&wire_bytes);
    Ok(format!("{CODE_PREFIX}{encoded}"))
}

/// Builds a shareable URL with `#offer=P2P1:...`, `#answer=P2P1:...`, or `#room=P2P1:...` fragment.
pub fn encode_fragment_url(
    base_url: &str,
    payload: &SignalCodePayload,
    wrap_key: Option<&[u8; KEY_LEN]>,
    rng: &mut SafeCsprng,
) -> Result<String, String> {
    let code = encode_signal_code(payload, wrap_key, rng)?;
    let base = match base_url.split_once('#') {
        Some((prefix, _)) => prefix,
        None => base_url,
    };
    Ok(format!("{base}#{}={code}", payload.kind.fragment_key()))
}

/// Extracts an `#offer=`, `#answer=`, `#room=`, or `#join=` value from a URL or raw hash fragment.
pub fn extract_fragment_code(input: &str) -> Option<(SignalCodeKind, String)> {
    let trimmed = input.trim();
    let hash_part = match trimmed.split_once('#') {
        Some((_, after)) => after,
        None => {
            if trimmed.starts_with("offer=")
                || trimmed.starts_with("answer=")
                || trimmed.starts_with("room=")
                || trimmed.starts_with("join=")
            {
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

/// Decodes either a raw `P2P1:...` code or a full URL / `#offer=` / `#answer=` / `#room=` fragment.
/// Returns `(payload, was_passphrase_encrypted)`.
pub fn decode_signal_code(
    input: &str,
    wrap_key: Option<&[u8; KEY_LEN]>,
) -> Result<(SignalCodePayload, bool), String> {
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

    let wire_bytes = base64url_decode(body)?;
    let (compressed, was_encrypted) = if wire_bytes.starts_with(E2E_INVITE_MAGIC) {
        let key = wrap_key.ok_or_else(|| {
            "this P2P1 code is passphrase-encrypted — enter the matching mesh passphrase to decrypt"
                .to_owned()
        })?;
        let nonce_slice = wire_bytes
            .get(4..4 + NONCE_LEN)
            .ok_or_else(|| "truncated encrypted P2P1 nonce".to_owned())?;
        let ct_slice = wire_bytes
            .get(4 + NONCE_LEN..)
            .ok_or_else(|| "truncated encrypted P2P1 ciphertext".to_owned())?;
        let nonce = parse_fixed_12(nonce_slice, "P2P1 invite nonce")?;
        let decrypted = aead_open(key, &nonce, E2E_INVITE_AAD, ct_slice).map_err(|_| {
            "failed to decrypt passphrase-protected P2P1 code (wrong passphrase or corrupted code)"
                .to_owned()
        })?;
        (decrypted, true)
    } else {
        (wire_bytes, false)
    };

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

    let mesh_key = match val.get_str("k2") {
        Some(k2_b64) if !k2_b64.is_empty() => {
            Some(parse_fixed_32(&base64url_decode(k2_b64)?, "mesh key")?)
        }
        _ => None,
    };

    let room = val.get_str("r").unwrap_or("default").to_owned();
    let relay = val
        .get_str("u")
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());

    if kind == SignalCodeKind::Room {
        if mesh_key.is_none() && !was_encrypted {
            return Err("room invite is missing its encryption key 'k2'".to_owned());
        }
        return Ok((
            SignalCodePayload {
                version,
                kind,
                peer_id: val.get_str("p").unwrap_or("").to_owned(),
                author_name: val.get_str("n").unwrap_or("").to_owned(),
                room,
                invite_id: val.get_str("i").unwrap_or("").to_owned(),
                pub_key: [0u8; KEY_LEN],
                mesh_key,
                sdp: String::new(),
                relay,
            },
            was_encrypted,
        ));
    }

    let peer_id = val
        .get_str("p")
        .ok_or_else(|| "missing peer id 'p'".to_owned())?
        .to_owned();
    if peer_id.trim().is_empty() {
        return Err("peer id 'p' must not be empty".to_owned());
    }

    let pub_key_b64 = val
        .get_str("x")
        .ok_or_else(|| "missing X25519 public key field 'x'".to_owned())?;
    let pub_key = parse_fixed_32(&base64url_decode(pub_key_b64)?, "X25519 public key")?;

    let author_name = val.get_str("n").unwrap_or("Peer").to_owned();
    let invite_id = val.get_str("i").unwrap_or("").to_owned();
    let sdp = val
        .get_str("s")
        .ok_or_else(|| "missing SDP field 's'".to_owned())?
        .to_owned();
    if sdp.trim().is_empty() {
        return Err("SDP field 's' must not be empty".to_owned());
    }

    Ok((
        SignalCodePayload {
            version,
            kind,
            peer_id,
            author_name,
            room,
            invite_id,
            pub_key,
            mesh_key,
            sdp: normalize_sdp(&sdp),
            relay,
        },
        was_encrypted,
    ))
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
