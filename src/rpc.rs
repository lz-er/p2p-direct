use std::fmt::Write as _;

use crate::codec::{
    PROTOCOL_VERSION, SignalCodeKind, SignalCodePayload, decode_signal_code, encode_fragment_url,
    encode_signal_code, extract_fragment_code,
};
use crate::crypto::{
    aead_open, aead_seal, derive_invite_wrap_key, derive_mesh_key_from_passphrase, parse_fixed_12,
    parse_fixed_32,
};
use crate::deflate::{base64url_decode, base64url_encode, base64url_encode_into};
use crate::json::{
    JsonValue, parse_json, parse_json_object_skipping_field, write_json_string,
};
use crate::log::{LogMessage, SealedLogRecord, is_internal_log_type};
use crate::media::MediaSyncState;
use crate::mesh::{BulkPeerKeyTarget, MeshConfig, MeshNode, actions_to_json_array};
use crate::protocol::{
    EncryptedWireEnvelope, RelaySignalType, WireFrame, write_msg_wire_json_borrowed,
};

pub fn dispatch_rpc(state: &mut Option<MeshNode>, req_json: &str) -> String {
    match dispatch_inner(state, req_json) {
        Ok(resp) => resp,
        Err(msg) => error_json(&msg),
    }
}

/// Binary fast-path for incoming encrypted wire frames (avoids JSON-escaping & re-parsing multi-MB frames).
pub fn dispatch_wire_message(
    state: &mut Option<MeshNode>,
    from_peer: &str,
    frame: &str,
    now_ms: u64,
) -> String {
    match dispatch_wire_inner(state, from_peer, frame, now_ms) {
        Ok(resp) => resp,
        Err(msg) => error_json(&msg),
    }
}

fn dispatch_wire_inner(
    state: &mut Option<MeshNode>,
    from_peer: &str,
    frame: &str,
    now_ms: u64,
) -> Result<String, String> {
    let node = require_node(state)?;
    let actions = node.on_wire_message(from_peer, frame, now_ms)?;
    let actions_json = actions_to_json_array(&actions);
    let status = node.status_json();
    Ok(format!(
        "{{\"ok\":true,\"actions\":{actions_json},\"status\":{status}}}"
    ))
}

fn error_json(message: &str) -> String {
    let mut out = String::with_capacity(message.len() + 32);
    out.push_str("{\"ok\":false,\"error\":");
    write_json_string(&mut out, message);
    out.push('}');
    out
}

fn dispatch_inner(state: &mut Option<MeshNode>, req_json: &str) -> Result<String, String> {
    let mut val = parse_json(req_json)?;
    let cmd = val
        .get_str("cmd")
        .ok_or_else(|| "RPC request missing string field 'cmd'".to_owned())?
        .to_owned();

    match cmd.as_str() {
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
            if val.get_bool("isBot").unwrap_or(false) {
                node.set_is_bot(true);
            }
            let status = node.status_json();
            *state = Some(node);
            Ok(format!("{{\"ok\":true,\"status\":{status}}}"))
        }
        "set_profile" => {
            let node = require_node(state)?;
            let mut hello_changed = false;
            if let Some(name) = val.get_str("authorName")
                && !name.trim().is_empty()
                && name != node.author_name()
            {
                node.set_author_name(name.to_owned());
                hello_changed = true;
            }
            if let Some(is_bot) = val.get_bool("isBot")
                && is_bot != node.is_bot()
            {
                node.set_is_bot(is_bot);
                hello_changed = true;
            }
            if let Some(room) = val.get_str("room") {
                node.set_room(room.to_owned());
            }
            if let Some(enabled) = val.get_bool("autoMeshEnabled") {
                node.set_auto_mesh_enabled(enabled);
            }
            let actions = if hello_changed {
                node.broadcast_hello_update()
            } else {
                Vec::new()
            };
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            Ok(format!(
                "{{\"ok\":true,\"actions\":{actions_json},\"status\":{status}}}"
            ))
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
        "get_status" => {
            let node = require_node(state)?;
            let status = node.status_json();
            Ok(format!("{{\"ok\":true,\"status\":{status}}}"))
        }
        "get_state" => {
            let node = require_node(state)?;
            let status = node.status_json();
            let log = node.log_json();
            Ok(format!(
                "{{\"ok\":true,\"status\":{status},\"log\":{log}}}"
            ))
        }
        "media_sync_update" => {
            let node = require_node(state)?;
            let now_ms = val.get_u64("nowMs").unwrap_or(0);
            let st_val = val
                .get("state")
                .ok_or_else(|| "media_sync_update missing 'state' object".to_owned())?;
            let incoming = MediaSyncState::from_json_value(st_val, now_ms, 0)?;
            let (applied, actions) = node.update_media_sync(incoming, now_ms);
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            let mut state_json = String::with_capacity(320);
            applied.write_json(&mut state_json, now_ms);
            Ok(format!(
                "{{\"ok\":true,\"state\":{state_json},\"actions\":{actions_json},\"status\":{status}}}"
            ))
        }
        "get_media_sync" => {
            let node = require_node(state)?;
            let now_ms = val.get_u64("nowMs").unwrap_or(0);
            let states = node.media_states_json(now_ms);
            Ok(format!("{{\"ok\":true,\"states\":{states}}}"))
        }
        "get_log_delta" => {
            let node = require_node(state)?;
            let mut known: std::collections::HashMap<&str, u64> = std::collections::HashMap::new();
            if let Some(JsonValue::Object(map)) = val.get("knownVersions") {
                for (k, v) in map {
                    if let Some(ver) = v.as_u64() {
                        known.insert(k.as_str(), ver);
                    }
                }
            }
            let status = node.status_json();
            let delta = node.log_delta_json(&known);
            Ok(format!(
                "{{\"ok\":true,\"status\":{status},\"delta\":{delta}}}"
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
            let ts = val
                .get_u64("ts")
                .ok_or_else(|| "publish missing integer field 'ts'".to_owned())?;
            let custom_id = val.get_str("id").map(str::to_owned);
            let omit_payload = val.get_bool("omitMessagePayload").unwrap_or(false);
            let payload = match &mut val {
                JsonValue::Object(map) => map
                    .remove("payload")
                    .ok_or_else(|| "publish missing field 'payload'".to_owned())?,
                _ => return Err("publish missing field 'payload'".to_owned()),
            };
            let (msg, actions) = node.publish_local(msg_type, payload, ts, custom_id)?;
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            if omit_payload {
                let meta_json = msg.to_meta_json_string();
                Ok(format!(
                    "{{\"ok\":true,\"messageMeta\":{meta_json},\"actions\":{actions_json},\"status\":{status}}}"
                ))
            } else {
                let msg_json = msg.to_json_string();
                Ok(format!(
                    "{{\"ok\":true,\"message\":{msg_json},\"actions\":{actions_json},\"status\":{status}}}"
                ))
            }
        }
        "delete_message" => {
            let node = require_node(state)?;
            if let Some(e) = val.get_str("entropy")
                && let Ok(bytes) = base64url_decode(e)
            {
                node.reseed_entropy(&bytes);
            }
            let target_id = val
                .get_str("targetId")
                .ok_or_else(|| "delete_message missing string field 'targetId'".to_owned())?
                .to_owned();
            let ts = val.get_u64("ts").unwrap_or(0);
            let (tombstone, actions) = node.delete_message(target_id.clone(), ts)?;
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            let mut out = String::with_capacity(actions_json.len() + status.len() + 128);
            out.push_str("{\"ok\":true,\"deletedId\":");
            write_json_string(&mut out, &target_id);
            out.push_str(",\"tombstoneId\":");
            write_json_string(&mut out, &tombstone.id);
            out.push_str(",\"actions\":");
            out.push_str(&actions_json);
            out.push_str(",\"status\":");
            out.push_str(&status);
            out.push('}');
            Ok(out)
        }
        "send_bot_action" => {
            let node = require_node(state)?;
            let to_peer_id = val
                .get_str("toPeerId")
                .ok_or_else(|| "send_bot_action missing string field 'toPeerId'".to_owned())?
                .to_owned();
            let message_id = val
                .get_str("messageId")
                .ok_or_else(|| "send_bot_action missing string field 'messageId'".to_owned())?
                .to_owned();
            let action_id = val
                .get_str("actionId")
                .ok_or_else(|| "send_bot_action missing string field 'actionId'".to_owned())?
                .to_owned();
            let label = val.get_str("label").unwrap_or("").to_owned();
            let value = val.get("value").cloned().unwrap_or(JsonValue::Null);
            let ts = val.get_u64("ts").unwrap_or(0);
            let (action_uid, actions) =
                node.send_bot_action(to_peer_id, message_id, action_id, label, value, ts)?;
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            let mut out = String::with_capacity(actions_json.len() + status.len() + 128);
            out.push_str("{\"ok\":true,\"actionUid\":");
            write_json_string(&mut out, &action_uid);
            out.push_str(",\"actions\":");
            out.push_str(&actions_json);
            out.push_str(",\"status\":");
            out.push_str(&status);
            out.push('}');
            Ok(out)
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
            let now_ms = val.get_u64("nowMs").unwrap_or(0);
            let actions = node.request_sync_all_at(now_ms);
            let actions_json = actions_to_json_array(&actions);
            let status = node.status_json();
            Ok(format!(
                "{{\"ok\":true,\"actions\":{actions_json},\"status\":{status}}}"
            ))
        }
        "commit_peer_color" => {
            let node = require_node(state)?;
            let actions = node.commit_self_color();
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
        "set_voice_state" => {
            let node = require_node(state)?;
            let in_voice = val.get_bool("inVoice").unwrap_or(false);
            let muted = val.get_bool("muted").unwrap_or(false);
            let actions = node.set_voice_state(in_voice, muted);
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
                relay: None,
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
        "encode_room_invite" => {
            let node = require_node(state)?;
            if let Some(e) = val.get_str("entropy")
                && let Ok(bytes) = base64url_decode(e)
            {
                node.reseed_entropy(&bytes);
            }
            if let Some(r) = val.get_str("room")
                && !r.trim().is_empty()
            {
                node.set_room(r.trim().to_owned());
            }
            let relay = val
                .get_str("relay")
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty());
            let base_url = val.get_str("baseUrl").unwrap_or("");
            let wrap_key = node.invite_wrap_key();
            let payload = SignalCodePayload {
                version: PROTOCOL_VERSION,
                kind: SignalCodeKind::Room,
                peer_id: String::new(),
                author_name: String::new(),
                room: node.room().to_owned(),
                invite_id: String::new(),
                pub_key: [0u8; crate::crypto::KEY_LEN],
                mesh_key: if wrap_key.is_none() {
                    Some(node.mesh_key())
                } else {
                    None
                },
                sdp: String::new(),
                relay,
            };
            let code = encode_signal_code(&payload, wrap_key.as_ref(), node.rng_mut())?;
            let url = if base_url.is_empty() {
                format!("#room={code}")
            } else {
                encode_fragment_url(base_url, &payload, wrap_key.as_ref(), node.rng_mut())?
            };
            let status = node.status_json();
            let mut out = String::with_capacity(code.len() + url.len() + status.len() + 160);
            out.push_str("{\"ok\":true,\"code\":");
            write_json_string(&mut out, &code);
            out.push_str(",\"url\":");
            write_json_string(&mut out, &url);
            out.push_str(",\"room\":");
            write_json_string(&mut out, node.room());
            out.push_str(",\"roomTopic\":");
            write_json_string(&mut out, node.room_topic());
            out.push_str(",\"keyFingerprint\":");
            write_json_string(&mut out, node.key_fingerprint());
            let _ = write!(
                out,
                ",\"encrypted\":{},\"codeChars\":{},\"status\":{status}}}",
                wrap_key.is_some(),
                code.len()
            );
            Ok(out)
        }
        "seal_room_signal" => {
            let node = require_node(state)?;
            if let Some(e) = val.get_str("entropy")
                && let Ok(bytes) = base64url_decode(e)
            {
                node.reseed_entropy(&bytes);
            }
            let payload_str = match val.get("payload") {
                Some(JsonValue::String(s)) => s.clone(),
                Some(other) => other.to_json_string(),
                None => return Err("seal_room_signal missing 'payload'".to_owned()),
            };
            let sealed = node.seal_room_signal(&payload_str);
            let mut out = String::with_capacity(sealed.len() + 96);
            out.push_str("{\"ok\":true,\"sealed\":");
            write_json_string(&mut out, &sealed);
            out.push_str(",\"topic\":");
            write_json_string(&mut out, node.room_topic());
            out.push('}');
            Ok(out)
        }
        "open_room_signal" => {
            let node = require_node(state)?;
            let sealed = val
                .get_str("sealed")
                .ok_or_else(|| "open_room_signal missing 'sealed'".to_owned())?;
            let payload = node.open_room_signal(sealed)?;
            let mut out = String::with_capacity(payload.len() + 48);
            out.push_str("{\"ok\":true,\"payload\":");
            write_json_string(&mut out, &payload);
            out.push('}');
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
            let mut out = String::with_capacity(sig.sdp.len() + 320);
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
            out.push_str(",\"relay\":");
            match &sig.relay {
                Some(r) => write_json_string(&mut out, r),
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
        "prepare_bulk_publish" => {
            let node = require_node(state)?;
            if let Some(e) = val.get_str("entropy")
                && let Ok(bytes) = base64url_decode(e)
            {
                node.reseed_entropy(&bytes);
            }
            let msg_type = val
                .get_str("type")
                .ok_or_else(|| "prepare_bulk_publish missing string field 'type'".to_owned())?
                .to_owned();
            let ts = val
                .get_u64("ts")
                .ok_or_else(|| "prepare_bulk_publish missing integer field 'ts'".to_owned())?;
            let custom_id = val.get_str("id").map(str::to_owned);
            let prep = node.prepare_bulk_publish(msg_type, ts, custom_id)?;
            let mut out = String::with_capacity(384 + prep.peer_targets.len() * 140);
            out.push_str("{\"ok\":true,\"prep\":{\"id\":");
            write_json_string(&mut out, &prep.id);
            out.push_str(",\"type\":");
            write_json_string(&mut out, &prep.msg_type);
            let _ = write!(out, ",\"lamport\":{},\"ts\":{},\"author\":", prep.lamport, prep.ts);
            write_json_string(&mut out, &prep.author);
            out.push_str(",\"authorName\":");
            write_json_string(&mut out, &prep.author_name);
            out.push_str(",\"logKey\":");
            write_json_string(&mut out, &base64url_encode(&prep.log_key));
            out.push_str(",\"logNonce\":");
            write_json_string(&mut out, &base64url_encode(&prep.log_nonce));
            let _ = write!(out, ",\"gossipTtl\":{},\"targets\":[", prep.gossip_ttl);
            write_bulk_targets_json(&prep.peer_targets, &mut out);
            out.push_str("]}}");
            Ok(out)
        }
        "prepare_bulk_rx" => {
            let node = require_node(state)?;
            let from_peer = val
                .get_str("fromPeer")
                .ok_or_else(|| "prepare_bulk_rx missing 'fromPeer'".to_owned())?;
            let seq = val
                .get_u64("seq")
                .ok_or_else(|| "prepare_bulk_rx missing 'seq'".to_owned())?;
            let (rx_key, log_key) = node.prepare_bulk_rx(from_peer, seq)?;
            let mut out = String::with_capacity(220);
            out.push_str("{\"ok\":true,\"rxKey\":");
            write_json_string(&mut out, &base64url_encode(&rx_key));
            out.push_str(",\"logKey\":");
            write_json_string(&mut out, &base64url_encode(&log_key));
            out.push_str(",\"selfPeerId\":");
            write_json_string(&mut out, node.peer_id());
            out.push('}');
            Ok(out)
        }
        other => Err(format!("unknown RPC command '{other}'")),
    }
}

fn require_node(state: &mut Option<MeshNode>) -> Result<&mut MeshNode, String> {
    state
        .as_mut()
        .ok_or_else(|| "mesh node is not initialized; call 'init' first".to_owned())
}

fn write_bulk_targets_json(targets: &[BulkPeerKeyTarget], out: &mut String) {
    for (i, t) in targets.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"peerId\":");
        write_json_string(out, &t.peer_id);
        out.push_str(",\"txKey\":");
        write_json_string(out, &base64url_encode(&t.tx_key));
        let _ = write!(out, ",\"txSeq\":{},\"wireNonce\":", t.tx_seq);
        write_json_string(out, &base64url_encode(&t.wire_nonce));
        out.push('}');
    }
}

fn split_framed_input(in_bytes: &[u8]) -> Result<(&str, &[u8]), String> {
    if in_bytes.len() < 4 {
        return Err("truncated framed bulk header".to_owned());
    }
    let header_len = u32::from_le_bytes([in_bytes[0], in_bytes[1], in_bytes[2], in_bytes[3]]) as usize;
    let header_end = 4usize.saturating_add(header_len);
    let (Some(hdr_bytes), Some(tail)) = (in_bytes.get(4..header_end), in_bytes.get(header_end..))
    else {
        return Err("truncated framed bulk payload".to_owned());
    };
    let hdr_str =
        std::str::from_utf8(hdr_bytes).map_err(|_| "invalid UTF-8 bulk header JSON".to_owned())?;
    Ok((hdr_str, tail))
}

fn frame_json_and_tail(json: &str, tail: &[u8]) -> Vec<u8> {
    let jb = json.as_bytes();
    let mut out = Vec::with_capacity(4 + jb.len() + tail.len());
    out.extend_from_slice(&(jb.len() as u32).to_le_bytes());
    out.extend_from_slice(jb);
    out.extend_from_slice(tail);
    out
}

fn parse_meta_msg_from_json(meta: &JsonValue) -> Result<LogMessage, String> {
    let id = meta
        .get_str("id")
        .ok_or_else(|| "bulk meta missing 'id'".to_owned())?
        .to_owned();
    let msg_type = meta
        .get_str("type")
        .ok_or_else(|| "bulk meta missing 'type'".to_owned())?
        .to_owned();
    let lamport = meta
        .get_u64("lamport")
        .ok_or_else(|| "bulk meta missing 'lamport'".to_owned())?;
    let ts = meta
        .get_u64("ts")
        .ok_or_else(|| "bulk meta missing 'ts'".to_owned())?;
    let author = meta
        .get_str("author")
        .ok_or_else(|| "bulk meta missing 'author'".to_owned())?
        .to_owned();
    let author_name = meta.get_str("authorName").unwrap_or(&author).to_owned();
    Ok(LogMessage {
        id,
        msg_type,
        lamport,
        ts,
        author,
        author_name,
        payload: JsonValue::Null,
    })
}

fn parse_targets_from_json(val: &JsonValue) -> Result<Vec<BulkPeerKeyTarget>, String> {
    let mut targets = Vec::new();
    if let Some(arr) = val.get("targets").and_then(JsonValue::as_array) {
        for item in arr {
            let peer_id = item
                .get_str("peerId")
                .ok_or_else(|| "bulk target missing 'peerId'".to_owned())?
                .to_owned();
            let tx_key = parse_fixed_32(
                &base64url_decode(
                    item.get_str("txKey")
                        .ok_or_else(|| "bulk target missing 'txKey'".to_owned())?,
                )?,
                "txKey",
            )?;
            let tx_seq = item
                .get_u64("txSeq")
                .ok_or_else(|| "bulk target missing 'txSeq'".to_owned())?;
            let wire_nonce = parse_fixed_12(
                &base64url_decode(
                    item.get_str("wireNonce")
                        .ok_or_else(|| "bulk target missing 'wireNonce'".to_owned())?,
                )?,
                "wireNonce",
            )?;
            targets.push(BulkPeerKeyTarget {
                peer_id,
                tx_key,
                tx_seq,
                wire_nonce,
            });
        }
    }
    Ok(targets)
}

/// Stateless off-thread worker seal for bulk GIF/video messages.
/// Input: `[u32 headerJsonLen][headerJson][raw canonical LogMessage UTF-8 JSON]`.
/// Output: `[u32 respJsonLen][respJson { ok, wireFrames }][raw sealed ciphertext bytes]`.
pub fn worker_seal_bulk(in_bytes: &[u8]) -> Vec<u8> {
    match worker_seal_bulk_inner(in_bytes) {
        Ok(out) => out,
        Err(err) => frame_json_and_tail(&error_json(&err), &[]),
    }
}

fn worker_seal_bulk_inner(in_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let (hdr_str, msg_json_bytes) = split_framed_input(in_bytes)?;
    let hdr = parse_json(hdr_str)?;
    let meta = hdr
        .get("meta")
        .ok_or_else(|| "worker_seal_bulk missing 'meta'".to_owned())?;
    let meta_msg = parse_meta_msg_from_json(meta)?;
    let log_key = parse_fixed_32(
        &base64url_decode(
            hdr.get_str("logKey")
                .ok_or_else(|| "worker_seal_bulk missing 'logKey'".to_owned())?,
        )?,
        "logKey",
    )?;
    let log_nonce = parse_fixed_12(
        &base64url_decode(
            hdr.get_str("logNonce")
                .ok_or_else(|| "worker_seal_bulk missing 'logNonce'".to_owned())?,
        )?,
        "logNonce",
    )?;
    let gossip_ttl = hdr.get_u64("gossipTtl").unwrap_or(16) as u32;
    let targets = parse_targets_from_json(&hdr)?;

    let log_aad = SealedLogRecord::build_aad(&meta_msg.id, meta_msg.lamport, meta_msg.ts);
    let sealed_ct = aead_seal(&log_key, &log_nonce, log_aad.as_slice(), msg_json_bytes);

    let mut wire_frames: Vec<(String, String)> = Vec::with_capacity(targets.len());
    if !targets.is_empty() {
        let path = [meta_msg.author.clone()];
        let wire_plaintext = write_msg_wire_json_borrowed(
            &meta_msg.author,
            gossip_ttl,
            &path,
            &meta_msg.id,
            meta_msg.lamport,
            meta_msg.ts,
            &log_nonce,
            &sealed_ct,
        );
        for t in targets {
            let env = EncryptedWireEnvelope::seal(
                &t.tx_key,
                t.tx_seq,
                t.wire_nonce,
                &meta_msg.author,
                &t.peer_id,
                &wire_plaintext,
            );
            wire_frames.push((t.peer_id, env.to_json_string()));
        }
    }

    let total_frames_len: usize = wire_frames.iter().map(|(p, f)| p.len() + f.len() + 32).sum();
    let mut resp_json = String::with_capacity(total_frames_len + 64);
    resp_json.push_str("{\"ok\":true,\"wireFrames\":[");
    for (i, (pid, frame)) in wire_frames.iter().enumerate() {
        if i > 0 {
            resp_json.push(',');
        }
        resp_json.push_str("{\"peerId\":");
        write_json_string(&mut resp_json, pid);
        resp_json.push_str(",\"frame\":");
        write_json_string(&mut resp_json, frame);
        resp_json.push('}');
    }
    resp_json.push_str("]}");

    Ok(frame_json_and_tail(&resp_json, &sealed_ct))
}

/// Stateless off-thread worker open for incoming encrypted bulk wire frames.
/// Input: `[u32 headerJsonLen][headerJson { fromPeer, selfPeerId, rxKey, logKey }][raw wire frame UTF-8]`.
/// Output:
/// - For `WireFrame::Msg` (non-internal):
///   `[u32 metaJsonLen][metaJson][u32 msgJsonLen][msgJson UTF-8][raw sealed ciphertext bytes]`
/// - For any non-`Msg` / internal frame:
///   `[u32 metaJsonLen][{"ok":true,"kind":"fallback"}]`
pub fn worker_open_bulk(in_bytes: &[u8]) -> Vec<u8> {
    match worker_open_bulk_inner(in_bytes) {
        Ok(out) => out,
        Err(err) => frame_json_and_tail(&error_json(&err), &[]),
    }
}

fn worker_open_bulk_inner(in_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let (hdr_str, frame_bytes) = split_framed_input(in_bytes)?;
    let hdr = parse_json(hdr_str)?;
    let from_peer = hdr
        .get_str("fromPeer")
        .ok_or_else(|| "worker_open_bulk missing 'fromPeer'".to_owned())?;
    let self_peer = hdr
        .get_str("selfPeerId")
        .ok_or_else(|| "worker_open_bulk missing 'selfPeerId'".to_owned())?;
    let rx_key = parse_fixed_32(
        &base64url_decode(
            hdr.get_str("rxKey")
                .ok_or_else(|| "worker_open_bulk missing 'rxKey'".to_owned())?,
        )?,
        "rxKey",
    )?;
    let log_key = parse_fixed_32(
        &base64url_decode(
            hdr.get_str("logKey")
                .ok_or_else(|| "worker_open_bulk missing 'logKey'".to_owned())?,
        )?,
        "logKey",
    )?;
    let frame_str =
        std::str::from_utf8(frame_bytes).map_err(|_| "invalid UTF-8 wire frame".to_owned())?;

    let env = EncryptedWireEnvelope::parse_json(frame_str)?;
    let decrypted_json = env.open(&rx_key, from_peer, self_peer)?;
    let wire_frame = WireFrame::parse_json(&decrypted_json)?;

    let WireFrame::Msg {
        origin,
        ttl,
        path,
        record,
    } = wire_frame
    else {
        return Ok(frame_json_and_tail("{\"ok\":true,\"kind\":\"fallback\"}", &[]));
    };

    let aad = SealedLogRecord::build_aad(&record.id, record.lamport, record.ts);
    let plain_bytes = aead_open(&log_key, &record.nonce, aad.as_slice(), &record.ciphertext)?;
    let plain_str = std::str::from_utf8(&plain_bytes)
        .map_err(|_| "decrypted log record is not valid UTF-8".to_owned())?;
    let msg_val = parse_json_object_skipping_field(plain_str, "payload")?;
    let meta_msg = parse_meta_msg_from_json(&msg_val)?;
    if meta_msg.id != record.id || meta_msg.lamport != record.lamport || meta_msg.ts != record.ts {
        return Err("sealed log record metadata mismatch with authenticated plaintext".to_owned());
    }
    if is_internal_log_type(&meta_msg.msg_type) {
        return Ok(frame_json_and_tail("{\"ok\":true,\"kind\":\"fallback\"}", &[]));
    }

    let mut meta_json = String::with_capacity(384);
    let _ = write!(meta_json, "{{\"ok\":true,\"kind\":\"msg\",\"seq\":{},\"origin\":", env.seq);
    write_json_string(&mut meta_json, &origin);
    let _ = write!(meta_json, ",\"ttl\":{ttl},\"path\":[");
    for (i, hop) in path.iter().enumerate() {
        if i > 0 {
            meta_json.push(',');
        }
        write_json_string(&mut meta_json, hop);
    }
    meta_json.push_str("],\"sealedNonce\":\"");
    base64url_encode_into(&record.nonce, &mut meta_json);
    meta_json.push_str("\",\"meta\":");
    meta_json.push_str(&meta_msg.to_meta_json_string());
    meta_json.push('}');

    let mj_bytes = meta_json.as_bytes();
    let mut out = Vec::with_capacity(8 + mj_bytes.len() + plain_bytes.len() + record.ciphertext.len());
    out.extend_from_slice(&(mj_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(mj_bytes);
    out.extend_from_slice(&(plain_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&plain_bytes);
    out.extend_from_slice(&record.ciphertext);
    Ok(out)
}

/// Stateless off-thread worker seal for multi-hop bulk gossip forwarding (3+ peer meshes).
/// Input: `[u32 headerJsonLen][headerJson { selfPeerId, origin, ttl, path, recordMeta, targets }][raw sealed ciphertext]`.
/// Output: JSON `{ ok, wireFrames }`.
pub fn worker_seal_forward(in_bytes: &[u8]) -> String {
    match worker_seal_forward_inner(in_bytes) {
        Ok(resp) => resp,
        Err(err) => error_json(&err),
    }
}

fn worker_seal_forward_inner(in_bytes: &[u8]) -> Result<String, String> {
    let (hdr_str, sealed_ct) = split_framed_input(in_bytes)?;
    let hdr = parse_json(hdr_str)?;
    let self_peer = hdr
        .get_str("selfPeerId")
        .ok_or_else(|| "worker_seal_forward missing 'selfPeerId'".to_owned())?;
    let origin = hdr
        .get_str("origin")
        .ok_or_else(|| "worker_seal_forward missing 'origin'".to_owned())?;
    let ttl = hdr.get_u64("ttl").unwrap_or(1) as u32;
    let mut path = Vec::new();
    if let Some(arr) = hdr.get("path").and_then(JsonValue::as_array) {
        for item in arr {
            if let Some(s) = item.as_str() {
                path.push(s.to_owned());
            }
        }
    }
    let rec_meta = hdr
        .get("recordMeta")
        .ok_or_else(|| "worker_seal_forward missing 'recordMeta'".to_owned())?;
    let id = rec_meta
        .get_str("id")
        .ok_or_else(|| "recordMeta missing 'id'".to_owned())?;
    let lamport = rec_meta
        .get_u64("lamport")
        .ok_or_else(|| "recordMeta missing 'lamport'".to_owned())?;
    let ts = rec_meta
        .get_u64("ts")
        .ok_or_else(|| "recordMeta missing 'ts'".to_owned())?;
    let nonce = parse_fixed_12(
        &base64url_decode(
            rec_meta
                .get_str("nonce")
                .ok_or_else(|| "recordMeta missing 'nonce'".to_owned())?,
        )?,
        "recordMeta.nonce",
    )?;
    let targets = parse_targets_from_json(&hdr)?;

    let wire_plaintext =
        write_msg_wire_json_borrowed(origin, ttl, &path, id, lamport, ts, &nonce, sealed_ct);
    let mut out = String::with_capacity(targets.len().saturating_mul(wire_plaintext.len() + 256) + 64);
    out.push_str("{\"ok\":true,\"wireFrames\":[");
    for (i, t) in targets.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let env = EncryptedWireEnvelope::seal(
            &t.tx_key,
            t.tx_seq,
            t.wire_nonce,
            self_peer,
            &t.peer_id,
            &wire_plaintext,
        );
        out.push_str("{\"peerId\":");
        write_json_string(&mut out, &t.peer_id);
        out.push_str(",\"frame\":");
        write_json_string(&mut out, &env.to_json_string());
        out.push('}');
    }
    out.push_str("]}");
    Ok(out)
}

/// Main-thread commit after off-thread bulk publish sealing (< 1 ms, zero crypto/parsing of payload).
pub fn dispatch_commit_bulk_publish(state: &mut Option<MeshNode>, in_bytes: &[u8]) -> String {
    match dispatch_commit_bulk_publish_inner(state, in_bytes) {
        Ok(resp) => resp,
        Err(err) => error_json(&err),
    }
}

fn dispatch_commit_bulk_publish_inner(
    state: &mut Option<MeshNode>,
    in_bytes: &[u8],
) -> Result<String, String> {
    let node = require_node(state)?;
    let (hdr_str, sealed_ct) = split_framed_input(in_bytes)?;
    let hdr = parse_json(hdr_str)?;
    let meta = hdr
        .get("meta")
        .ok_or_else(|| "commit_bulk_publish missing 'meta'".to_owned())?;
    let meta_msg = parse_meta_msg_from_json(meta)?;
    let nonce = parse_fixed_12(
        &base64url_decode(
            hdr.get_str("sealedNonce")
                .ok_or_else(|| "commit_bulk_publish missing 'sealedNonce'".to_owned())?,
        )?,
        "sealedNonce",
    )?;
    let sent_peer_count = hdr.get_u64("sentPeerCount").unwrap_or(0) as usize;
    let sealed = SealedLogRecord {
        id: meta_msg.id.clone(),
        lamport: meta_msg.lamport,
        ts: meta_msg.ts,
        nonce,
        ciphertext: sealed_ct.to_vec(),
    };
    let actions = node.commit_bulk_publish(meta_msg, sealed, sent_peer_count)?;
    let actions_json = actions_to_json_array(&actions);
    let status = node.status_json();
    Ok(format!(
        "{{\"ok\":true,\"actions\":{actions_json},\"status\":{status}}}"
    ))
}

/// Main-thread commit after off-thread bulk RX decryption (< 1 ms, zero crypto/parsing of payload).
pub fn dispatch_commit_bulk_rx(state: &mut Option<MeshNode>, in_bytes: &[u8]) -> String {
    match dispatch_commit_bulk_rx_inner(state, in_bytes) {
        Ok(resp) => resp,
        Err(err) => error_json(&err),
    }
}

fn dispatch_commit_bulk_rx_inner(
    state: &mut Option<MeshNode>,
    in_bytes: &[u8],
) -> Result<String, String> {
    let node = require_node(state)?;
    let (hdr_str, sealed_ct) = split_framed_input(in_bytes)?;
    let hdr = parse_json(hdr_str)?;
    let from_peer = hdr
        .get_str("fromPeer")
        .ok_or_else(|| "commit_bulk_rx missing 'fromPeer'".to_owned())?;
    let seq = hdr
        .get_u64("seq")
        .ok_or_else(|| "commit_bulk_rx missing 'seq'".to_owned())?;
    let ttl = hdr.get_u64("ttl").unwrap_or(1) as u32;
    let mut path = Vec::new();
    if let Some(arr) = hdr.get("path").and_then(JsonValue::as_array) {
        for item in arr {
            if let Some(s) = item.as_str() {
                path.push(s.to_owned());
            }
        }
    }
    let meta = hdr
        .get("meta")
        .ok_or_else(|| "commit_bulk_rx missing 'meta'".to_owned())?;
    let meta_msg = parse_meta_msg_from_json(meta)?;
    let nonce = parse_fixed_12(
        &base64url_decode(
            hdr.get_str("sealedNonce")
                .ok_or_else(|| "commit_bulk_rx missing 'sealedNonce'".to_owned())?,
        )?,
        "sealedNonce",
    )?;
    let sealed = SealedLogRecord {
        id: meta_msg.id.clone(),
        lamport: meta_msg.lamport,
        ts: meta_msg.ts,
        nonce,
        ciphertext: sealed_ct.to_vec(),
    };

    let (inserted, forward_targets, next_path, next_ttl) =
        node.commit_bulk_rx(from_peer, seq, ttl, path, meta_msg, sealed)?;
    let status = node.status_json();
    let mut out = String::with_capacity(status.len() + 256 + forward_targets.len() * 140);
    let _ = write!(
        out,
        "{{\"ok\":true,\"inserted\":{inserted},\"nextTtl\":{next_ttl},\"nextPath\":["
    );
    for (i, hop) in next_path.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_json_string(&mut out, hop);
    }
    out.push_str("],\"forwardTargets\":[");
    write_bulk_targets_json(&forward_targets, &mut out);
    out.push_str("],\"status\":");
    out.push_str(&status);
    out.push('}');
    Ok(out)
}
