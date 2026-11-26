use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;

use crate::crypto::{
    KEY_LEN, NONCE_LEN, SafeCsprng, aead_open, aead_seal, parse_fixed_12,
};
use crate::deflate::{base64url_decode, base64url_encode_into};
use crate::json::{JsonValue, parse_json, write_json_string, write_json_value};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LogOrderKey {
    pub lamport: u64,
    pub ts: u64,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LogMessage {
    pub id: String,
    pub msg_type: String,
    pub lamport: u64,
    pub ts: u64,
    pub author: String,
    pub author_name: String,
    pub payload: JsonValue,
}

impl LogMessage {
    pub fn order_key(&self) -> LogOrderKey {
        LogOrderKey {
            lamport: self.lamport,
            ts: self.ts,
            id: self.id.clone(),
        }
    }

    pub fn write_json(&self, out: &mut String) {
        out.push_str("{\"id\":");
        write_json_string(out, &self.id);
        out.push_str(",\"type\":");
        write_json_string(out, &self.msg_type);
        let _ = write!(
            out,
            ",\"lamport\":{},\"ts\":{},\"author\":",
            self.lamport, self.ts
        );
        write_json_string(out, &self.author);
        out.push_str(",\"authorName\":");
        write_json_string(out, &self.author_name);
        out.push_str(",\"payload\":");
        write_json_value(out, &self.payload);
        out.push('}');
    }

    pub fn to_json_string(&self) -> String {
        let cap = self
            .payload
            .estimated_json_len()
            .saturating_add(self.id.len())
            .saturating_add(self.author.len())
            .saturating_add(self.author_name.len())
            .saturating_add(128);
        let mut out = String::with_capacity(cap);
        self.write_json(&mut out);
        out
    }

    pub fn to_meta_json_string(&self) -> String {
        let mut out = String::with_capacity(192);
        out.push_str("{\"id\":");
        write_json_string(&mut out, &self.id);
        out.push_str(",\"type\":");
        write_json_string(&mut out, &self.msg_type);
        let _ = write!(
            out,
            ",\"lamport\":{},\"ts\":{},\"author\":",
            self.lamport, self.ts
        );
        write_json_string(&mut out, &self.author);
        out.push_str(",\"authorName\":");
        write_json_string(&mut out, &self.author_name);
        out.push('}');
        out
    }

    pub fn to_json_value(&self) -> JsonValue {
        let mut map = BTreeMap::new();
        map.insert("id".to_owned(), JsonValue::string(&self.id));
        map.insert("type".to_owned(), JsonValue::string(&self.msg_type));
        map.insert("lamport".to_owned(), JsonValue::from_u64(self.lamport));
        map.insert("ts".to_owned(), JsonValue::from_u64(self.ts));
        map.insert("author".to_owned(), JsonValue::string(&self.author));
        map.insert(
            "authorName".to_owned(),
            JsonValue::string(&self.author_name),
        );
        map.insert("payload".to_owned(), self.payload.clone());
        JsonValue::Object(map)
    }

    pub fn from_json_value(val: &JsonValue) -> Result<Self, String> {
        let id = val
            .get_str("id")
            .ok_or_else(|| "log message missing string field 'id'".to_owned())?
            .to_owned();
        if id.trim().is_empty() {
            return Err("log message 'id' must not be empty".to_owned());
        }

        let msg_type = val
            .get_str("type")
            .ok_or_else(|| "log message missing string field 'type'".to_owned())?
            .to_owned();
        if msg_type.trim().is_empty() {
            return Err("log message 'type' must not be empty".to_owned());
        }

        let lamport = val
            .get_u64("lamport")
            .ok_or_else(|| "log message missing integer field 'lamport'".to_owned())?;
        let ts = val
            .get_u64("ts")
            .ok_or_else(|| "log message missing integer field 'ts'".to_owned())?;

        let author = val
            .get_str("author")
            .ok_or_else(|| "log message missing string field 'author'".to_owned())?
            .to_owned();
        if author.trim().is_empty() {
            return Err("log message 'author' must not be empty".to_owned());
        }

        let author_name = val
            .get_str("authorName")
            .ok_or_else(|| "log message missing string field 'authorName'".to_owned())?
            .to_owned();

        let payload = val
            .get("payload")
            .cloned()
            .ok_or_else(|| "log message missing field 'payload'".to_owned())?;

        Ok(Self {
            id,
            msg_type,
            lamport,
            ts,
            author,
            author_name,
            payload,
        })
    }
}

/// End-to-end encrypted log entry sealed with ChaCha20-Poly1305.
/// Associated data binds `(id, lamport, ts)` so ordering metadata cannot be tampered with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedLogRecord {
    pub id: String,
    pub lamport: u64,
    pub ts: u64,
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

impl SealedLogRecord {
    pub fn build_aad(id: &str, lamport: u64, ts: u64) -> crate::crypto::AadBuf {
        let mut aad = crate::crypto::AadBuf::new();
        aad.push_bytes(b"p2p-log-v1|");
        aad.push_bytes(id.as_bytes());
        aad.push_bytes(b"|");
        aad.push_u64_dec(lamport);
        aad.push_bytes(b"|");
        aad.push_u64_dec(ts);
        aad
    }

    pub fn seal(msg: &LogMessage, log_key: &[u8; KEY_LEN], rng: &mut SafeCsprng) -> Self {
        let nonce = rng.next_nonce();
        let aad = Self::build_aad(&msg.id, msg.lamport, msg.ts);
        let plaintext = msg.to_json_string();
        let ciphertext = aead_seal(log_key, &nonce, aad.as_slice(), plaintext.as_bytes());
        Self {
            id: msg.id.clone(),
            lamport: msg.lamport,
            ts: msg.ts,
            nonce,
            ciphertext,
        }
    }

    pub fn open(&self, log_key: &[u8; KEY_LEN]) -> Result<LogMessage, String> {
        let aad = Self::build_aad(&self.id, self.lamport, self.ts);
        let plain_bytes = aead_open(log_key, &self.nonce, aad.as_slice(), &self.ciphertext)?;
        let plain_str = std::str::from_utf8(&plain_bytes)
            .map_err(|_| "decrypted log record is not valid UTF-8".to_owned())?;
        let val = parse_json(plain_str)?;
        let msg = LogMessage::from_json_value(&val)?;
        if msg.id != self.id || msg.lamport != self.lamport || msg.ts != self.ts {
            return Err("sealed log record metadata mismatch with authenticated plaintext".to_owned());
        }
        Ok(msg)
    }

    pub fn write_parts_json(
        out: &mut String,
        id: &str,
        lamport: u64,
        ts: u64,
        nonce: &[u8; NONCE_LEN],
        ciphertext: &[u8],
    ) {
        out.push_str("{\"id\":");
        write_json_string(out, id);
        let _ = write!(out, ",\"lamport\":{lamport},\"ts\":{ts},\"n\":\"");
        base64url_encode_into(nonce, out);
        out.push_str("\",\"c\":\"");
        base64url_encode_into(ciphertext, out);
        out.push_str("\"}");
    }

    pub fn write_json(&self, out: &mut String) {
        Self::write_parts_json(
            out,
            &self.id,
            self.lamport,
            self.ts,
            &self.nonce,
            &self.ciphertext,
        );
    }

    pub fn to_json_string(&self) -> String {
        let mut out = String::with_capacity(self.ciphertext.len().div_ceil(3) * 4 + 128);
        self.write_json(&mut out);
        out
    }

    pub fn from_json_value(val: &JsonValue) -> Result<Self, String> {
        let id = val
            .get_str("id")
            .ok_or_else(|| "sealed record missing 'id'".to_owned())?
            .to_owned();
        if id.trim().is_empty() {
            return Err("sealed record 'id' must not be empty".to_owned());
        }
        let lamport = val
            .get_u64("lamport")
            .ok_or_else(|| "sealed record missing 'lamport'".to_owned())?;
        let ts = val
            .get_u64("ts")
            .ok_or_else(|| "sealed record missing 'ts'".to_owned())?;
        let nonce_b64 = val
            .get_str("n")
            .ok_or_else(|| "sealed record missing nonce 'n'".to_owned())?;
        let ct_b64 = val
            .get_str("c")
            .ok_or_else(|| "sealed record missing ciphertext 'c'".to_owned())?;
        let nonce = parse_fixed_12(&base64url_decode(nonce_b64)?, "sealed record nonce")?;
        let ciphertext = base64url_decode(ct_b64)?;
        Ok(Self {
            id,
            lamport,
            ts,
            nonce,
            ciphertext,
        })
    }
}

pub const MSG_TYPE_DELETE: &str = "msg-delete";
pub const MSG_TYPE_EDIT: &str = "msg-edit";
pub const MSG_TYPE_BOT_UPDATE: &str = "bot-update";

pub fn is_edit_log_type(msg_type: &str) -> bool {
    msg_type == MSG_TYPE_EDIT || msg_type == MSG_TYPE_BOT_UPDATE
}

pub fn is_internal_log_type(msg_type: &str) -> bool {
    msg_type == MSG_TYPE_DELETE || is_edit_log_type(msg_type)
}

fn extract_target_id(payload: &JsonValue) -> Option<&str> {
    payload
        .get_str("targetId")
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn extract_edit_payload(msg: &LogMessage) -> Option<&JsonValue> {
    if msg.msg_type == MSG_TYPE_EDIT {
        msg.payload
            .get("payload")
            .or_else(|| msg.payload.get("card"))
    } else if msg.msg_type == MSG_TYPE_BOT_UPDATE {
        msg.payload
            .get("card")
            .or_else(|| msg.payload.get("payload"))
    } else {
        None
    }
}

fn apply_edit_payload(msg_type: &str, current: &JsonValue, edit_val: &JsonValue) -> JsonValue {
    if msg_type == "chat"
        && let (JsonValue::Object(cur_map), JsonValue::Object(edit_map)) = (current, edit_val)
    {
        let mut merged = cur_map.clone();
        for (k, v) in edit_map {
            merged.insert(k.clone(), v.clone());
        }
        return JsonValue::Object(merged);
    }
    edit_val.clone()
}

fn compact_media_value(val: &JsonValue, max_data_url_len: usize) -> JsonValue {
    match val {
        JsonValue::Object(map) => {
            let mut out = BTreeMap::new();
            for (k, v) in map {
                if k == "dataUrl"
                    && let JsonValue::String(s) = v
                    && s.len() > max_data_url_len
                {
                    out.insert(
                        k.clone(),
                        JsonValue::String(format!("[media data omitted · {} chars]", s.len())),
                    );
                } else {
                    out.insert(k.clone(), compact_media_value(v, max_data_url_len));
                }
            }
            JsonValue::Object(out)
        }
        JsonValue::Array(items) => JsonValue::Array(
            items
                .iter()
                .map(|item| compact_media_value(item, max_data_url_len))
                .collect(),
        ),
        _ => val.clone(),
    }
}

fn format_edit_rev(edits: &[&LogMessage]) -> String {
    if let Some(last) = edits.last() {
        format!("{}:{}:{}", last.lamport, edits.len(), last.id)
    } else {
        "0".to_owned()
    }
}

fn write_folded_message_json(
    m: &LogMessage,
    base_payload: &JsonValue,
    edits: &[&LogMessage],
    out: &mut String,
) {
    let mut current_payload = base_payload.clone();
    let mut step_snapshots: Vec<(&LogMessage, JsonValue)> = Vec::with_capacity(edits.len());
    for edit_msg in edits {
        if let Some(edit_val) = extract_edit_payload(edit_msg) {
            current_payload = apply_edit_payload(&m.msg_type, &current_payload, edit_val);
            step_snapshots.push((edit_msg, compact_media_value(&current_payload, 2048)));
        }
    }

    let Some((last_edit, _)) = step_snapshots.last() else {
        m.write_json(out);
        return;
    };

    out.push_str("{\"id\":");
    write_json_string(out, &m.id);
    out.push_str(",\"type\":");
    write_json_string(out, &m.msg_type);
    let _ = write!(out, ",\"lamport\":{},\"ts\":{},\"author\":", m.lamport, m.ts);
    write_json_string(out, &m.author);
    out.push_str(",\"authorName\":");
    write_json_string(out, &m.author_name);
    out.push_str(",\"payload\":");
    write_json_value(out, &current_payload);
    let _ = write!(
        out,
        ",\"updatedLamport\":{},\"updatedTs\":{},\"editedBy\":",
        last_edit.lamport, last_edit.ts
    );
    write_json_string(out, &last_edit.author);
    out.push_str(",\"editedByName\":");
    write_json_string(out, &last_edit.author_name);
    let _ = write!(out, ",\"editCount\":{},\"originalPayload\":", step_snapshots.len());
    let compact_orig = compact_media_value(base_payload, 2048);
    write_json_value(out, &compact_orig);
    out.push_str(",\"edits\":[");
    for (idx, (em, snap)) in step_snapshots.iter().enumerate() {
        if idx > 0 {
            out.push(',');
        }
        out.push_str("{\"id\":");
        write_json_string(out, &em.id);
        let _ = write!(out, ",\"lamport\":{},\"ts\":{},\"author\":", em.lamport, em.ts);
        write_json_string(out, &em.author);
        out.push_str(",\"authorName\":");
        write_json_string(out, &em.author_name);
        out.push_str(",\"payload\":");
        write_json_value(out, snap);
        out.push('}');
    }
    out.push_str("]}");
}

#[derive(Debug, Clone)]
struct StoredEntry {
    message: LogMessage,
    sealed: Option<SealedLogRecord>,
    payload_deferred: bool,
}

/// Deterministic append-only event-sourced replicated log ordered strictly by `(lamport, ts, id)`.
///
/// Original messages, edits (`msg-edit`, plus legacy `bot-update`), and deletions (`msg-delete`)
/// are all stored immutably in the raw event log so Raw JSON inspection shows the full history.
/// The parsed view deterministically folds edits (tracking who edited what) and hides deleted targets.
#[derive(Debug, Clone, Default)]
pub struct ReplicatedLog {
    entries: BTreeMap<LogOrderKey, StoredEntry>,
    by_id: HashMap<String, LogOrderKey>,
    tombstones: HashSet<String>,
    lamport: u64,
}

impl ReplicatedLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Count of parsed visible (non-deleted, non-mutation) messages in the log.
    pub fn len(&self) -> usize {
        self.entries
            .values()
            .filter(|e| {
                !is_internal_log_type(&e.message.msg_type)
                    && !self.tombstones.contains(&e.message.id)
            })
            .count()
    }

    /// Count of all raw stored records including originals, `msg-edit`, `bot-update`, and `msg-delete`.
    pub fn stored_len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn lamport(&self) -> u64 {
        self.lamport
    }

    pub fn observe_lamport(&mut self, remote_lamport: u64) {
        if remote_lamport > self.lamport {
            self.lamport = remote_lamport;
        }
    }

    pub fn contains_id(&self, id: &str) -> bool {
        self.by_id.contains_key(id)
    }

    pub fn is_deleted(&self, id: &str) -> bool {
        self.tombstones.contains(id)
    }

    /// Returns true if `id` is stored in the raw log OR has been marked deleted via a tombstone.
    pub fn contains_or_deleted(&self, id: &str) -> bool {
        self.by_id.contains_key(id) || self.tombstones.contains(id)
    }

    pub fn get_by_id(&self, id: &str) -> Option<&LogMessage> {
        let key = self.by_id.get(id)?;
        self.entries.get(key).map(|e| &e.message)
    }

    pub fn get_sealed_by_id(&self, id: &str) -> Option<&SealedLogRecord> {
        let key = self.by_id.get(id)?;
        self.entries.get(key)?.sealed.as_ref()
    }

    /// Inserts a message idempotently (without a sealed copy). Returns `Ok(true)` if newly added.
    pub fn insert(&mut self, msg: LogMessage) -> Result<bool, String> {
        self.insert_with_sealed(msg, None)
    }

    /// Inserts a message alongside its authenticated AEAD-sealed record.
    ///
    /// Append-only invariant: original messages, `msg-edit` records, and `msg-delete` records
    /// are all retained in `entries` so raw log views and late joiners converge identically.
    pub fn insert_with_sealed(
        &mut self,
        msg: LogMessage,
        sealed: Option<SealedLogRecord>,
    ) -> Result<bool, String> {
        if msg.id.trim().is_empty() {
            return Err("message id must not be empty".to_owned());
        }
        if msg.msg_type.trim().is_empty() {
            return Err("message type must not be empty".to_owned());
        }
        if msg.author.trim().is_empty() {
            return Err("message author must not be empty".to_owned());
        }

        self.observe_lamport(msg.lamport);
        if self.by_id.contains_key(&msg.id) {
            return Ok(false);
        }

        if msg.msg_type == MSG_TYPE_DELETE {
            let Some(target_id) = extract_target_id(&msg.payload).map(str::to_owned) else {
                return Err("msg-delete record missing non-empty payload.targetId".to_owned());
            };
            if target_id == msg.id {
                return Err("msg-delete record cannot target itself".to_owned());
            }
            self.tombstones.insert(target_id);
        } else if is_edit_log_type(&msg.msg_type) {
            let Some(target_id) = extract_target_id(&msg.payload) else {
                return Err(format!(
                    "{} record missing non-empty payload.targetId",
                    msg.msg_type
                ));
            };
            if target_id == msg.id {
                return Err(format!("{} record cannot target itself", msg.msg_type));
            }
            if extract_edit_payload(&msg).is_none() {
                return Err(format!("{} record missing edited payload", msg.msg_type));
            }
        }

        let key = msg.order_key();
        self.by_id.insert(msg.id.clone(), key.clone());
        self.entries.insert(
            key,
            StoredEntry {
                message: msg,
                sealed,
                payload_deferred: false,
            },
        );
        Ok(true)
    }

    /// Inserts an already-authenticated AEAD-sealed bulk record with metadata only, deferring
    /// in-memory `JsonValue` payload materialization until/unless explicitly requested.
    pub fn insert_deferred_sealed(
        &mut self,
        meta_msg: LogMessage,
        sealed: SealedLogRecord,
    ) -> Result<bool, String> {
        if meta_msg.id.trim().is_empty() {
            return Err("message id must not be empty".to_owned());
        }
        if meta_msg.msg_type.trim().is_empty() || is_internal_log_type(&meta_msg.msg_type) {
            return Err("deferred sealed insert only supports non-internal messages".to_owned());
        }
        if meta_msg.author.trim().is_empty() {
            return Err("message author must not be empty".to_owned());
        }
        if sealed.id != meta_msg.id || sealed.lamport != meta_msg.lamport || sealed.ts != meta_msg.ts {
            return Err("deferred sealed metadata mismatch".to_owned());
        }
        self.observe_lamport(meta_msg.lamport);
        if self.by_id.contains_key(&meta_msg.id) {
            return Ok(false);
        }
        let key = meta_msg.order_key();
        self.by_id.insert(meta_msg.id.clone(), key.clone());
        self.entries.insert(
            key,
            StoredEntry {
                message: meta_msg,
                sealed: Some(sealed),
                payload_deferred: true,
            },
        );
        Ok(true)
    }

    /// Materializes any deferred bulk payloads by decrypting their sealed records under `log_key`
    /// (called before rotating keys so `reseal_all` remains 100% lossless).
    pub fn materialize_deferred(&mut self, log_key: &[u8; KEY_LEN]) {
        for entry in self.entries.values_mut() {
            if entry.payload_deferred
                && let Some(ref sealed) = entry.sealed
                && let Ok(full_msg) = sealed.open(log_key)
            {
                entry.message = full_msg;
                entry.payload_deferred = false;
            }
        }
    }

    /// Verifies and decrypts an AEAD-sealed record, inserting it idempotently.
    pub fn insert_sealed(
        &mut self,
        record: SealedLogRecord,
        log_key: &[u8; KEY_LEN],
    ) -> Result<Option<LogMessage>, String> {
        if self.contains_id(&record.id) {
            self.observe_lamport(record.lamport);
            return Ok(None);
        }
        let msg = record.open(log_key)?;
        if self.insert_with_sealed(msg.clone(), Some(record))? {
            Ok(Some(msg))
        } else {
            Ok(None)
        }
    }

    /// Re-seals all stored messages under a new log key (used when adopting or rotating mesh keys).
    pub fn reseal_all(&mut self, log_key: &[u8; KEY_LEN], rng: &mut SafeCsprng) {
        for entry in self.entries.values_mut() {
            if !entry.payload_deferred {
                entry.sealed = Some(SealedLogRecord::seal(&entry.message, log_key, rng));
            }
        }
    }

    /// Advances the local Lamport clock by 1 and appends a newly authored local message.
    pub fn append_local(
        &mut self,
        id: String,
        msg_type: String,
        ts: u64,
        author: String,
        author_name: String,
        payload: JsonValue,
    ) -> Result<LogMessage, String> {
        if id.trim().is_empty() {
            return Err("local message id must not be empty".to_owned());
        }
        if self.by_id.contains_key(&id) {
            return Err(format!("duplicate local message id '{id}'"));
        }
        let next_lamport = self.lamport.saturating_add(1);
        let msg = LogMessage {
            id,
            msg_type,
            lamport: next_lamport,
            ts,
            author,
            author_name,
            payload,
        };
        let inserted = self.insert(msg.clone())?;
        if !inserted {
            return Err("failed to insert local message".to_owned());
        }
        Ok(msg)
    }

    /// Appends a local message and immediately seals it with `log_key`.
    #[allow(clippy::too_many_arguments)]
    pub fn append_local_sealed(
        &mut self,
        id: String,
        msg_type: String,
        ts: u64,
        author: String,
        author_name: String,
        payload: JsonValue,
        log_key: &[u8; KEY_LEN],
        rng: &mut SafeCsprng,
    ) -> Result<(LogMessage, SealedLogRecord), String> {
        if id.trim().is_empty() {
            return Err("local message id must not be empty".to_owned());
        }
        if self.by_id.contains_key(&id) {
            return Err(format!("duplicate local message id '{id}'"));
        }
        let next_lamport = self.lamport.saturating_add(1);
        let msg = LogMessage {
            id,
            msg_type,
            lamport: next_lamport,
            ts,
            author,
            author_name,
            payload,
        };
        let sealed = SealedLogRecord::seal(&msg, log_key, rng);
        let inserted = self.insert_with_sealed(msg.clone(), Some(sealed.clone()))?;
        if !inserted {
            return Err("failed to insert local sealed message".to_owned());
        }
        Ok((msg, sealed))
    }

    /// Iterates parsed visible (non-deleted, non-mutation) log messages in deterministic `(lamport, ts, id)` order.
    pub fn ordered(&self) -> impl Iterator<Item = &LogMessage> {
        self.entries
            .values()
            .filter(|e| {
                !is_internal_log_type(&e.message.msg_type)
                    && !self.tombstones.contains(&e.message.id)
            })
            .map(|e| &e.message)
    }

    /// Iterates ALL raw stored records (originals, `msg-edit`, `bot-update`, and `msg-delete`)
    /// in deterministic `(lamport, ts, id)` order.
    pub fn raw_ordered(&self) -> impl Iterator<Item = &LogMessage> {
        self.entries.values().map(|e| &e.message)
    }

    /// Returns all stored record IDs (including tombstones and edits for sync) in deterministic order.
    pub fn ids_ordered(&self) -> Vec<String> {
        self.entries.values().map(|e| e.message.id.clone()).collect()
    }

    /// Returns all messages that are absent from `remote_known`, ordered by `(lamport, ts, id)`.
    pub fn missing_for(&self, remote_known: &HashSet<String>) -> Vec<LogMessage> {
        self.entries
            .values()
            .filter(|e| !remote_known.contains(&e.message.id))
            .map(|e| e.message.clone())
            .collect()
    }

    /// Returns sealed records absent from `remote_known`, sealing any unsealed entry on demand.
    pub fn missing_sealed_for(
        &mut self,
        remote_known: &HashSet<String>,
        log_key: &[u8; KEY_LEN],
        rng: &mut SafeCsprng,
    ) -> Vec<SealedLogRecord> {
        let mut out = Vec::new();
        for entry in self.entries.values_mut() {
            if !remote_known.contains(&entry.message.id) {
                let rec = match &entry.sealed {
                    Some(existing) => existing.clone(),
                    None => {
                        let created = SealedLogRecord::seal(&entry.message, log_key, rng);
                        entry.sealed = Some(created.clone());
                        created
                    }
                };
                out.push(rec);
            }
        }
        out
    }

    /// Returns all messages matching a list of requested IDs, ordered deterministically.
    pub fn select_by_ids(&self, ids: &[String]) -> Vec<LogMessage> {
        let mut selected: BTreeMap<LogOrderKey, LogMessage> = BTreeMap::new();
        for id in ids {
            if let Some(msg) = self.get_by_id(id) {
                selected.insert(msg.order_key(), msg.clone());
            }
        }
        selected.into_values().collect()
    }

    /// Returns sealed records matching requested IDs, ordered deterministically.
    pub fn select_sealed_by_ids(
        &mut self,
        ids: &[String],
        log_key: &[u8; KEY_LEN],
        rng: &mut SafeCsprng,
    ) -> Vec<SealedLogRecord> {
        let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let mut out = Vec::new();
        for entry in self.entries.values_mut() {
            if wanted.contains(entry.message.id.as_str()) {
                let rec = match &entry.sealed {
                    Some(existing) => existing.clone(),
                    None => {
                        let created = SealedLogRecord::seal(&entry.message, log_key, rng);
                        entry.sealed = Some(created.clone());
                        created
                    }
                };
                out.push(rec);
            }
        }
        out
    }

    fn collect_edits_by_target(&self) -> HashMap<&str, Vec<&LogMessage>> {
        let mut edits_by_target: HashMap<&str, Vec<&LogMessage>> = HashMap::new();
        for entry in self.entries.values() {
            if is_edit_log_type(&entry.message.msg_type)
                && let Some(target_id) = extract_target_id(&entry.message.payload)
                && extract_edit_payload(&entry.message).is_some()
            {
                edits_by_target
                    .entry(target_id)
                    .or_default()
                    .push(&entry.message);
            }
        }
        edits_by_target
    }

    /// Serializes parsed visible decrypted log messages as a JSON array in canonical order,
    /// omitting deleted messages and mutation records while deterministically folding all
    /// `msg-edit` / `bot-update` revisions onto their target message with full attribution.
    pub fn write_messages_json_array(&self, out: &mut String) {
        self.write_messages_json_array_with_key(None, out);
    }

    /// Same as `write_messages_json_array`, transparently opening any deferred bulk records with `log_key`.
    pub fn write_messages_json_array_with_key(
        &self,
        log_key: Option<&[u8; KEY_LEN]>,
        out: &mut String,
    ) {
        let edits_by_target = self.collect_edits_by_target();

        out.push('[');
        let mut first = true;
        for entry in self.entries.values() {
            if is_internal_log_type(&entry.message.msg_type)
                || self.tombstones.contains(&entry.message.id)
            {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            if let Some(edits) = edits_by_target.get(entry.message.id.as_str()) {
                if entry.payload_deferred
                    && let (Some(key), Some(sealed)) = (log_key, entry.sealed.as_ref())
                    && let Ok(full_msg) = sealed.open(key)
                {
                    write_folded_message_json(&full_msg, &full_msg.payload, edits, out);
                } else {
                    write_folded_message_json(&entry.message, &entry.message.payload, edits, out);
                }
            } else if entry.payload_deferred
                && let (Some(key), Some(sealed)) = (log_key, entry.sealed.as_ref())
                && let Ok(full_msg) = sealed.open(key)
            {
                full_msg.write_json(out);
            } else {
                entry.message.write_json(out);
            }
        }
        out.push(']');
    }

    /// Serializes EVERY raw append-only event record (originals, `msg-edit`, `bot-update`, `msg-delete`)
    /// in strict canonical `(lamport, ts, id)` order.
    pub fn write_raw_messages_json_array_with_key(
        &self,
        log_key: Option<&[u8; KEY_LEN]>,
        compact_media: bool,
        out: &mut String,
    ) {
        out.push('[');
        for (idx, entry) in self.entries.values().enumerate() {
            if idx > 0 {
                out.push(',');
            }
            let opened = if entry.payload_deferred
                && let (Some(key), Some(sealed)) = (log_key, entry.sealed.as_ref())
            {
                sealed.open(key).ok()
            } else {
                None
            };
            let msg = opened.as_ref().unwrap_or(&entry.message);
            if compact_media {
                let mut compact_msg = msg.clone();
                compact_msg.payload = compact_media_value(&msg.payload, 2048);
                compact_msg.write_json(out);
            } else {
                msg.write_json(out);
            }
        }
        out.push(']');
    }

    /// Serializes an incremental log delta (`{"order":[...],"changed":[...]}`) containing ONLY
    /// messages whose ID is absent from `known_versions` or whose edit revision changed.
    /// Eliminates re-serializing multi-megabyte GIF/video attachments already cached in JS.
    pub fn write_messages_delta_json(
        &self,
        known_versions: &HashMap<&str, u64>,
        out: &mut String,
    ) {
        self.write_messages_delta_json_with_revs(known_versions, None, None, out);
    }

    /// Same as `write_messages_delta_json`, transparently opening any unknown deferred bulk records.
    pub fn write_messages_delta_json_with_key(
        &self,
        known_versions: &HashMap<&str, u64>,
        log_key: Option<&[u8; KEY_LEN]>,
        out: &mut String,
    ) {
        self.write_messages_delta_json_with_revs(known_versions, None, log_key, out);
    }

    /// Incremental log delta supporting exact string edit revisions (`"<lamport>:<count>:<lastEditId>"`)
    /// so even concurrent same-Lamport edits are never missed, plus backwards-compatible numeric `known_versions`.
    pub fn write_messages_delta_json_with_revs(
        &self,
        known_versions: &HashMap<&str, u64>,
        known_revs: Option<&HashMap<&str, &str>>,
        log_key: Option<&[u8; KEY_LEN]>,
        out: &mut String,
    ) {
        let edits_by_target = self.collect_edits_by_target();

        out.push_str("{\"order\":[");
        let mut first_order = true;
        for entry in self.entries.values() {
            if is_internal_log_type(&entry.message.msg_type)
                || self.tombstones.contains(&entry.message.id)
            {
                continue;
            }
            if !first_order {
                out.push(',');
            }
            first_order = false;
            write_json_string(out, &entry.message.id);
        }
        out.push_str("],\"changed\":[");
        let mut first_changed = true;
        for entry in self.entries.values() {
            if is_internal_log_type(&entry.message.msg_type)
                || self.tombstones.contains(&entry.message.id)
            {
                continue;
            }
            let edits = edits_by_target.get(entry.message.id.as_str());
            let unchanged = if let Some(revs) = known_revs {
                let current_rev = edits.map(|v| format_edit_rev(v)).unwrap_or_else(|| "0".to_owned());
                revs.get(entry.message.id.as_str())
                    .is_some_and(|known| *known == current_rev.as_str())
            } else {
                let effective_ver = edits
                    .and_then(|v| v.last())
                    .map(|u| u.lamport)
                    .unwrap_or(0);
                known_versions
                    .get(entry.message.id.as_str())
                    .copied()
                    == Some(effective_ver)
            };
            if unchanged {
                continue;
            }
            if !first_changed {
                out.push(',');
            }
            first_changed = false;
            if let Some(edits_vec) = edits {
                if entry.payload_deferred
                    && let (Some(key), Some(sealed)) = (log_key, entry.sealed.as_ref())
                    && let Ok(full_msg) = sealed.open(key)
                {
                    write_folded_message_json(&full_msg, &full_msg.payload, edits_vec, out);
                } else {
                    write_folded_message_json(&entry.message, &entry.message.payload, edits_vec, out);
                }
            } else if entry.payload_deferred
                && let (Some(key), Some(sealed)) = (log_key, entry.sealed.as_ref())
                && let Ok(full_msg) = sealed.open(key)
            {
                full_msg.write_json(out);
            } else {
                entry.message.write_json(out);
            }
        }
        out.push_str("]}");
    }

    /// Serializes a plaintext JSON snapshot (for explicit user decrypted export),
    /// containing both parsed `messages` and the full immutable `rawMessages` event log.
    pub fn export_snapshot_json(&self) -> String {
        self.export_snapshot_json_with_key(None)
    }

    pub fn export_snapshot_json_with_key(&self, log_key: Option<&[u8; KEY_LEN]>) -> String {
        let mut out = String::with_capacity(self.entries.len().saturating_mul(256) + 96);
        let _ = write!(
            out,
            "{{\"version\":1,\"lamport\":{},\"messages\":",
            self.lamport
        );
        self.write_messages_json_array_with_key(log_key, &mut out);
        out.push_str(",\"rawMessages\":");
        self.write_raw_messages_json_array_with_key(log_key, false, &mut out);
        out.push('}');
        out
    }

    /// Serializes an end-to-end encrypted snapshot containing ONLY ChaCha20-Poly1305 sealed records.
    pub fn export_encrypted_snapshot_json(
        &mut self,
        log_key: &[u8; KEY_LEN],
        key_fingerprint: &str,
        rng: &mut SafeCsprng,
    ) -> String {
        let mut out = String::with_capacity(self.entries.len().saturating_mul(256) + 128);
        out.push_str("{\"version\":2,\"e2ee\":\"chacha20-poly1305\",\"keyFingerprint\":");
        write_json_string(&mut out, key_fingerprint);
        let _ = write!(out, ",\"lamport\":{},\"records\":[", self.lamport);
        for (idx, entry) in self.entries.values_mut().enumerate() {
            if idx > 0 {
                out.push(',');
            }
            let rec = match &entry.sealed {
                Some(existing) => existing,
                None => {
                    let created = SealedLogRecord::seal(&entry.message, log_key, rng);
                    entry.sealed = Some(created);
                    match &entry.sealed {
                        Some(r) => r,
                        None => continue,
                    }
                }
            };
            rec.write_json(&mut out);
        }
        out.push_str("]}");
        out
    }

    /// Merges a plaintext v1 snapshot into this log (preferring full `rawMessages` when present).
    pub fn import_snapshot_value(&mut self, val: &JsonValue) -> Result<usize, String> {
        if let Some(lp) = val.get_u64("lamport") {
            self.observe_lamport(lp);
        }
        let msgs = val
            .get("rawMessages")
            .and_then(JsonValue::as_array)
            .or_else(|| val.get("messages").and_then(JsonValue::as_array))
            .ok_or_else(|| "snapshot missing 'messages' array".to_owned())?;
        let mut added = 0usize;
        for item in msgs {
            let msg = LogMessage::from_json_value(item)?;
            if self.insert(msg)? {
                added += 1;
            }
        }
        Ok(added)
    }

    /// Verifies and decrypts an E2EE v2 snapshot (with ChaCha20-Poly1305 `records`).
    pub fn import_encrypted_snapshot_value(
        &mut self,
        val: &JsonValue,
        log_key: &[u8; KEY_LEN],
    ) -> Result<usize, String> {
        if let Some(lp) = val.get_u64("lamport") {
            self.observe_lamport(lp);
        }
        let recs = val
            .get("records")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| "encrypted snapshot missing 'records' array".to_owned())?;
        let mut added = 0usize;
        for item in recs {
            let sealed = SealedLogRecord::from_json_value(item)?;
            if self.insert_sealed(sealed, log_key)?.is_some() {
                added += 1;
            }
        }
        Ok(added)
    }
}
