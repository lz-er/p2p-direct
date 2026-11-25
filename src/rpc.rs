use std::fmt::Write as _;

use crate::codec::{
    PROTOCOL_VERSION, SignalCodeKind, SignalCodePayload, decode_signal_code, encode_fragment_url,
    encode_signal_code, extract_fragment_code,
};
use crate::crypto::{
    derive_invite_wrap_key, derive_mesh_key_from_passphrase, parse_fixed_32,
};
use crate::deflate::{base64url_decode, base64url_encode};
use crate::json::{JsonValue, parse_json, write_json_string};
use crate::mesh::{MeshConfig, MeshNode, actions_to_json_array};
use crate::protocol::RelaySignalType;

pub fn dispatch_rpc(state: &mut Option<MeshNode>, req_json: &str) -> String {
    match dispatch_inner(state, req_json) {
        Ok(resp) => resp,
        Err(msg) => error_json(&msg),
    }
}

fn error_json(message: &str) -> String {
    let mut out = String::with_capacity(message.len() + 32);
    out.push_str("{\"ok\":false,\"error\":");
    write_json_string(&mut out, message);
    out.push('}');
    out
}

fn dispatch_inner(state: &mut Option<MeshNode>, req_json: &str) -> Result<String, String> {
    let val = parse_json(req_json)?;
    let cmd = val
        .get_str("cmd")
        .ok_or_else(|| "RPC request missing string field 'cmd'".to_owned())?;

    match cmd {
        "init" => {
            let peer_id = val
                .get_str("peerId")
                .ok_or_else(|| "init missing 'peerId'".to_owned())?
                .to_owned();
            if peer_id.trim().is_empty() {
                return Err("init 'peerId' must not be empty".to_owned());
            }
            let author_name = val.get_str("authorName").unwrap_or("Peer").to_owned();
            let room = val.get_str("room").unwrap_or("default").to_owned();
            let auto_mesh = val.get_bool("autoMeshEnabled").unwrap_or(true);

            let secret_b64 = val
                .get_str("x25519Secret")
                .ok_or_else(|| "init missing base64url 'x25519Secret'".to_owned())?;
            let x25519_secret =
                parse_fixed_32(&base64url_decode(secret_b64)?, "x25519Secret")?;

            let entropy = match val.get_str("entropy") {
                Some(e) if !e.is_empty() => base64url_decode(e)?,
                _ => Vec::new(),
            };

            let (mesh_key, passphrase_mode) = match val.get_str("passphrase") {
                Some(pass) if !pass.is_empty() => (derive_mesh_key_from_passphrase(pass), true),
                _ => {
                    let mk_b64 = val
                        .get_str("meshKey")
                        .ok_or_else(|| "init missing base64url 'meshKey'".to_owned())?;
                    let mk = parse_fixed_32(&base64url_decode(mk_b64)?, "meshKey")?;
                    (mk, val.get_bool("passphraseMode").unwrap_or(false))
                }
            };

            let mut config = MeshConfig {
                auto_mesh_enabled: auto_mesh,
                ..MeshConfig::default()
            };
            if let Some(max_p) = val.get_u64("maxDirectPeers") {
                config.max_direct_peers = (max_p as usize).clamp(1, 64);
            }
            let mut node = MeshNode::new(
                peer_id,
                author_name,
                room,
                x25519_secret,
                mesh_key,
                &entropy,
                config,
            );
            if passphrase_mode {
                node.set_mesh_key(mesh_key, true)?;
            }
            let status = node.status_json();
            *state = Some(node);
            Ok(format!("{{\"ok\":true,\"status\":{status}}}"))
        }
        "set_profile" => {
            let node = require_node(state)?;
            if let Some(name) = val.get_str("authorName") {
                node.set_author_name(name.to_owned());
            }
            if let Some(room) = val.get_str("room") {
                node.set_room(room.to_owned());
            }
            if let Some(enabled) = val.get_bool("autoMeshEnabled") {
                node.set_auto_mesh_enabled(enabled);
            }
            let status = node.status_json();
            Ok(format!("{{\"ok\":true,\"status\":{status}}}"))
        }
        "set_passphrase" => {
            let node = require_node(state)?;
            if let Some(e) = val.get_str("entropy")
                && let Ok(bytes) = base64url_decode(e)
            {
                node.reseed_entropy(&bytes);
            }
            match val.get_str("passphrase") {
                Some(pass) if !pass.is_empty() => {
                    node.set_passphrase(pass)?;
                }
                _ => {
                    let new_key = match val.get_str("meshKey") {
                        Some(mk_b64) if !mk_b64.is_empty() => {
                            Some(parse_fixed_32(&base64url_decode(mk_b64)?, "meshKey")?)
                        }
                        _ => None,
                    };
                    node.clear_passphrase(new_key)?;
                }
            }
            let status = node.status_json();
            let mk_b64 = base64url_encode(&node.mesh_key());
            let mut out = String::with_capacity(status.len() + 96);
            out.push_str("{\"ok\":true,\"meshKey\":");
            write_json_string(&mut out, &mk_b64);
            out.push_str(",\"status\":");
            out.push_str(&status);
            out.push('}');
            Ok(out)
        }
        "set_mesh_key" => {
            let node = require_node(state)?;
            let mk_b64 = val
                .get_str("meshKey")
                .ok_or_else(|| "set_mesh_key missing 'meshKey'".to_owned())?;
            let mk = parse_fixed_32(&base64url_decode(mk_b64)?, "meshKey")?;
            let pass_mode = val.get_bool("passphraseMode").unwrap_or(false);
            if let Some(e) = val.get_str("entropy")
                && let Ok(bytes) = base64url_decode(e)
            {
                node.reseed_entropy(&bytes);
            }
            node.set_mesh_key(mk, pass_mode)?;
            let status = node.status_json();
            Ok(format!("{{\"ok\":true,\"status\":{status}}}"))
        }
        "reseed" => {
            let node = require_node(state)?;
            if let Some(e) = val.get_str("entropy") {
                let bytes = base64url_decode(e)?;
                node.reseed_entropy(&bytes);
            }
            Ok("{\"ok\":true}".to_owned())
        }
        "import_snapshot" => {
            let node = require_node(state)?;
            let snap = val
                .get("snapshot")
                .ok_or_else(|| "import_snapshot missing 'snapshot'".to_owned())?;
            let added = node.import_persistence(snap)?;
            let status = node.status_json();
            let log = node.log_json();
            Ok(format!(
                "{{\"ok\":true,\"added\":{added},\"status\":{status},\"log\":{log}}}"
            ))
        }
        "export_snapshot" => {
            let node = require_node(state)?;
            let snap = node.export_persistence();
            Ok(format!("{{\"ok\":true,\"snapshot\":{snap}}}"))
        }
        "export_decrypted" => {
            let node = require_node(state)?;
            let snap = node.export_decrypted_json();
            Ok(format!("{{\"ok\":true,\"snapshot\":{snap}}}"))
        }
        "get_state" => {
            let node = require_node(state)?;
            let status = node.status_json();
            let log = node.log_json();
            Ok(format!(
                "{{\"ok\":true,\"status\":{status},\"log\":{log}}}"
            ))
        }
        "clear_log" => {
            let node = require_node(state)?;
            node.reset_local_log();
            let status = node.status_json();
            Ok(format!("{{\"ok\":true,\"status\":{status},\"log\":[]}}"))
        }
        "publish" => {
            let node = require_node(state)?;
            if let Some(e) = val.get_str("entropy")
                && let Ok(bytes) = base64url_decode(e)
            {
                node.reseed_entropy(&bytes);
            }
            let msg_type = val
                .get_str("type")
                .ok_or_else(|| "publish missing string field 'type'".to_owned())?
                .to_owned();
            let payload = val
                .get("payload")
                .cloned()
                .ok_or_else(|| "publish missing field 'payload'".to_owned())?;
            let ts = val
                .get_u64("ts")
                .ok_or_else(|| "publish missing integer field 'ts'".to_owned())?;
            let custom_id = val.get_str("id").map(str::to_owned);
            let (msg, actions) = node.publish_local(msg_type, payload, ts, custom_id)?;
            let msg_json = msg.to_json_string();
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            Ok(format!(
                "{{\"ok\":true,\"message\":{msg_json},\"actions\":{actions_json},\"status\":{status}}}"
            ))
        }
        "peer_connected" => {
            let node = require_node(state)?;
            let peer_id = val
                .get_str("peerId")
                .ok_or_else(|| "peer_connected missing 'peerId'".to_owned())?
                .to_owned();
            let author_name = val.get_str("authorName").unwrap_or("Peer").to_owned();
            let pk_b64 = val
                .get_str("peerPubKey")
                .ok_or_else(|| "peer_connected missing X25519 'peerPubKey'".to_owned())?;
            let peer_pub_key = parse_fixed_32(&base64url_decode(pk_b64)?, "peerPubKey")?;
            let via_auto_mesh = val.get_bool("viaAutoMesh").unwrap_or(false);
            let introduced_by = val.get_str("introducedBy").map(str::to_owned);
            let actions = node.on_peer_connected(
                peer_id,
                author_name,
                peer_pub_key,
                via_auto_mesh,
                introduced_by,
            )?;
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            Ok(format!(
                "{{\"ok\":true,\"actions\":{actions_json},\"status\":{status}}}"
            ))
        }
        "peer_disconnected" => {
            let node = require_node(state)?;
            let peer_id = val
                .get_str("peerId")
                .ok_or_else(|| "peer_disconnected missing 'peerId'".to_owned())?;
            let actions = node.on_peer_disconnected(peer_id);
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            Ok(format!(
                "{{\"ok\":true,\"actions\":{actions_json},\"status\":{status}}}"
            ))
        }
        "wire_message" => {
            let node = require_node(state)?;
            let from_peer = val
                .get_str("fromPeer")
                .ok_or_else(|| "wire_message missing 'fromPeer'".to_owned())?;
            let frame = val
                .get_str("frame")
                .ok_or_else(|| "wire_message missing 'frame'".to_owned())?;
            let now_ms = val.get_u64("nowMs").unwrap_or(0);
            let actions = node.on_wire_message(from_peer, frame, now_ms)?;
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            Ok(format!(
                "{{\"ok\":true,\"actions\":{actions_json},\"status\":{status}}}"
            ))
        }
        "request_sync" => {
            let node = require_node(state)?;
            let actions = node.request_sync_all();
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            Ok(format!(
                "{{\"ok\":true,\"actions\":{actions_json},\"status\":{status}}}"
            ))
        }
        "tick" => {
            let node = require_node(state)?;
            let now_ms = val.get_u64("nowMs").unwrap_or(0);
            let run_sync = val.get_bool("runSync").unwrap_or(false);
            let actions = node.on_anti_entropy_tick(now_ms, run_sync);
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            Ok(format!(
                "{{\"ok\":true,\"actions\":{actions_json},\"status\":{status}}}"
            ))
        }
        "keepalive_ping" => {
            let node = require_node(state)?;
            let now_ms = val.get_u64("nowMs").unwrap_or(0);
            let actions = node.send_keepalive_pings(now_ms);
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            Ok(format!(
                "{{\"ok\":true,\"actions\":{actions_json},\"status\":{status}}}"
            ))
        }
        "send_relay_signal" => {
            let node = require_node(state)?;
            let to_peer_id = val
                .get_str("toPeerId")
                .ok_or_else(|| "send_relay_signal missing 'toPeerId'".to_owned())?
                .to_owned();
            let sig_str = val
                .get_str("signalType")
                .ok_or_else(|| "send_relay_signal missing 'signalType'".to_owned())?;
            let signal_type = RelaySignalType::from_str_kind(sig_str)
                .ok_or_else(|| format!("invalid signalType '{sig_str}'"))?;
            let sdp = val.get_str("sdp").map(str::to_owned);
            let candidate = match val.get("candidate") {
                Some(JsonValue::Null) | None => None,
                Some(c) => Some(c.clone()),
            };
            let preferred_via = val.get_str("viaPeerId").map(str::to_owned);
            let actions =
                node.send_relay_signal(to_peer_id, signal_type, sdp, candidate, preferred_via)?;
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            Ok(format!(
                "{{\"ok\":true,\"actions\":{actions_json},\"status\":{status}}}"
            ))
        }
        "encode_signal" => {
            let node = require_node(state)?;
            if let Some(e) = val.get_str("entropy")
                && let Ok(bytes) = base64url_decode(e)
            {
                node.reseed_entropy(&bytes);
            }
            let kind_str = val
                .get_str("kind")
                .ok_or_else(|| "encode_signal missing 'kind'".to_owned())?;
            let kind = SignalCodeKind::from_str_kind(kind_str)
                .ok_or_else(|| format!("invalid signal kind '{kind_str}'"))?;
            let sdp = val
                .get_str("sdp")
                .ok_or_else(|| "encode_signal missing 'sdp'".to_owned())?
                .to_owned();
            let invite_id = val.get_str("inviteId").unwrap_or("").to_owned();
            let base_url = val.get_str("baseUrl").unwrap_or("");
            let wrap_key = node.invite_wrap_key();
            let include_mesh_key = kind == SignalCodeKind::Offer && wrap_key.is_none();
            let payload = SignalCodePayload {
                version: PROTOCOL_VERSION,
                kind,
                peer_id: node.peer_id().to_owned(),
                author_name: node.author_name().to_owned(),
                room: node.room().to_owned(),
                invite_id,
                pub_key: node.public_key(),
                mesh_key: if include_mesh_key {
                    Some(node.mesh_key())
                } else {
                    None
                },
                sdp,
            };
            let code = encode_signal_code(&payload, wrap_key.as_ref(), node.rng_mut())?;
            let url = if base_url.is_empty() {
                format!("#{}={code}", kind.fragment_key())
            } else {
                encode_fragment_url(base_url, &payload, wrap_key.as_ref(), node.rng_mut())?
            };
            let mut out = String::with_capacity(code.len() + url.len() + 96);
            out.push_str("{\"ok\":true,\"code\":");
            write_json_string(&mut out, &code);
            out.push_str(",\"url\":");
            write_json_string(&mut out, &url);
            let _ = write!(
                out,
                ",\"encrypted\":{},\"rawBytes\":{},\"codeChars\":{}}}",
                wrap_key.is_some(),
                payload.sdp.len(),
                code.len()
            );
            Ok(out)
        }
        "decode_signal" => {
            let input = val
                .get_str("input")
                .ok_or_else(|| "decode_signal missing 'input'".to_owned())?;
            let wrap_key = match val.get_str("passphrase") {
                Some(pass) if !pass.is_empty() => {
                    Some(derive_invite_wrap_key(&derive_mesh_key_from_passphrase(pass)))
                }
                _ => state.as_ref().and_then(MeshNode::invite_wrap_key),
            };
            let (sig, was_encrypted) = decode_signal_code(input, wrap_key.as_ref())?;
            let mut out = String::with_capacity(sig.sdp.len() + 288);
            let _ = write!(
                out,
                "{{\"ok\":true,\"signal\":{{\"version\":{},\"kind\":",
                sig.version
            );
            write_json_string(&mut out, sig.kind.as_str());
            out.push_str(",\"peerId\":");
            write_json_string(&mut out, &sig.peer_id);
            out.push_str(",\"authorName\":");
            write_json_string(&mut out, &sig.author_name);
            out.push_str(",\"room\":");
            write_json_string(&mut out, &sig.room);
            out.push_str(",\"inviteId\":");
            write_json_string(&mut out, &sig.invite_id);
            out.push_str(",\"pubKey\":");
            write_json_string(&mut out, &base64url_encode(&sig.pub_key));
            out.push_str(",\"meshKey\":");
            match &sig.mesh_key {
                Some(mk) => write_json_string(&mut out, &base64url_encode(mk)),
                None => out.push_str("null"),
            }
            let _ = write!(out, ",\"encrypted\":{was_encrypted},\"sdp\":");
            write_json_string(&mut out, &sig.sdp);
            out.push_str("}}");
            Ok(out)
        }
        "extract_fragment" => {
            let hash = val.get_str("hash").unwrap_or("");
            match extract_fragment_code(hash) {
                Some((kind, code)) => {
                    let mut out = String::with_capacity(code.len() + 64);
                    out.push_str("{\"ok\":true,\"found\":true,\"kind\":");
                    write_json_string(&mut out, kind.as_str());
                    out.push_str(",\"code\":");
                    write_json_string(&mut out, &code);
                    out.push('}');
                    Ok(out)
                }
                None => Ok("{\"ok\":true,\"found\":false}".to_owned()),
            }
        }
        other => Err(format!("unknown RPC command '{other}'")),
    }
}

fn require_node(state: &mut Option<MeshNode>) -> Result<&mut MeshNode, String> {
    state
        .as_mut()
        .ok_or_else(|| "mesh node is not initialized; call 'init' first".to_owned())
}
