use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;

use crate::crypto::{
    KEY_LEN, NONCE_LEN, SafeCsprng, aead_open, aead_seal, parse_fixed_12,
};
use crate::deflate::{base64url_decode, base64url_encode};
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
        let mut out = String::with_capacity(192);
        self.write_json(&mut out);
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
    fn aad_bytes(id: &str, lamport: u64, ts: u64) -> Vec<u8> {
        format!("p2p-log-v1|{id}|{lamport}|{ts}").into_bytes()
    }

    pub fn seal(msg: &LogMessage, log_key: &[u8; KEY_LEN], rng: &mut SafeCsprng) -> Self {
        let nonce = rng.next_nonce();
        let aad = Self::aad_bytes(&msg.id, msg.lamport, msg.ts);
        let plaintext = msg.to_json_string();
        let ciphertext = aead_seal(log_key, &nonce, &aad, plaintext.as_bytes());
        Self {
            id: msg.id.clone(),
            lamport: msg.lamport,
            ts: msg.ts,
            nonce,
            ciphertext,
        }
    }

    pub fn open(&self, log_key: &[u8; KEY_LEN]) -> Result<LogMessage, String> {
        let aad = Self::aad_bytes(&self.id, self.lamport, self.ts);
        let plain_bytes = aead_open(log_key, &self.nonce, &aad, &self.ciphertext)?;
        let plain_str = std::str::from_utf8(&plain_bytes)
            .map_err(|_| "decrypted log record is not valid UTF-8".to_owned())?;
        let val = parse_json(plain_str)?;
        let msg = LogMessage::from_json_value(&val)?;
        if msg.id != self.id || msg.lamport != self.lamport || msg.ts != self.ts {
            return Err("sealed log record metadata mismatch with authenticated plaintext".to_owned());
        }
        Ok(msg)
    }

    pub fn write_json(&self, out: &mut String) {
        out.push_str("{\"id\":");
        write_json_string(out, &self.id);
        let _ = write!(out, ",\"lamport\":{},\"ts\":{},\"n\":", self.lamport, self.ts);
        write_json_string(out, &base64url_encode(&self.nonce));
        out.push_str(",\"c\":");
        write_json_string(out, &base64url_encode(&self.ciphertext));
        out.push('}');
    }

    pub fn to_json_string(&self) -> String {
        let mut out = String::with_capacity(self.ciphertext.len() * 2 + 96);
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
pub const MSG_TYPE_BOT_UPDATE: &str = "bot-update";

pub fn is_internal_log_type(msg_type: &str) -> bool {
    msg_type == MSG_TYPE_DELETE || msg_type == MSG_TYPE_BOT_UPDATE
}

fn extract_target_id(payload: &JsonValue) -> Option<&str> {
    payload
        .get_str("targetId")
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone)]
struct StoredEntry {
    message: LogMessage,
    sealed: Option<SealedLogRecord>,
}

/// Deterministic append-only replicated log ordered strictly by `(lamport, ts, id)`,
/// supporting authenticated CRDT deletion tombstones (`msg-delete`) that scrub deleted
/// payloads from memory and live bot card updates (`bot-update`) folded deterministically.
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

    /// Count of visible (non-deleted, non-internal) messages in the log.
    pub fn len(&self) -> usize {
        self.entries
            .values()
            .filter(|e| !is_internal_log_type(&e.message.msg_type))
            .count()
    }

    /// Count of all stored records including deletion tombstones and bot updates (for sync).
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

    /// Returns true if `id` is currently stored OR has been deleted via a tombstone.
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

    /// Scrubs a deleted target message (and any `bot-update` records targeting it) from RAM.
    fn scrub_target(&mut self, target_id: &str) {
        if let Some(old_key) = self.by_id.remove(target_id) {
            self.entries.remove(&old_key);
        }
        let orphan_updates: Vec<(String, LogOrderKey)> = self
            .entries
            .iter()
            .filter_map(|(k, e)| {
                if e.message.msg_type == MSG_TYPE_BOT_UPDATE
                    && extract_target_id(&e.message.payload) == Some(target_id)
                {
                    Some((e.message.id.clone(), k.clone()))
                } else {
                    None
                }
            })
            .collect();
        for (upd_id, upd_key) in orphan_updates {
            self.entries.remove(&upd_key);
            self.by_id.remove(&upd_id);
            self.tombstones.insert(upd_id);
        }
    }

    /// Inserts a message idempotently (without a sealed copy). Returns `Ok(true)` if newly added.
    pub fn insert(&mut self, msg: LogMessage) -> Result<bool, String> {
        self.insert_with_sealed(msg, None)
    }

    /// Inserts a message alongside its authenticated AEAD-sealed record.
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
        if self.by_id.contains_key(&msg.id) || self.tombstones.contains(&msg.id) {
            return Ok(false);
        }

        if msg.msg_type == MSG_TYPE_DELETE {
            let Some(target_id) = extract_target_id(&msg.payload).map(str::to_owned) else {
                return Err("msg-delete record missing non-empty payload.targetId".to_owned());
            };
            if target_id == msg.id {
                return Err("msg-delete record cannot target itself".to_owned());
            }
            self.tombstones.insert(target_id.clone());
            self.scrub_target(&target_id);
        } else if msg.msg_type == MSG_TYPE_BOT_UPDATE {
            let Some(target_id) = extract_target_id(&msg.payload) else {
                return Err("bot-update record missing non-empty payload.targetId".to_owned());
            };
            if self.tombstones.contains(target_id) {
                // Target message was already deleted; record update ID as tombstoned and ignore.
                self.tombstones.insert(msg.id);
                return Ok(false);
            }
        }

        let key = msg.order_key();
        self.by_id.insert(msg.id.clone(), key.clone());
        self.entries.insert(
            key,
            StoredEntry {
                message: msg,
                sealed,
            },
        );
        Ok(true)
    }

    /// Verifies and decrypts an AEAD-sealed record, inserting it idempotently.
    pub fn insert_sealed(
        &mut self,
        record: SealedLogRecord,
        log_key: &[u8; KEY_LEN],
    ) -> Result<Option<LogMessage>, String> {
        if self.contains_or_deleted(&record.id) {
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
            entry.sealed = Some(SealedLogRecord::seal(&entry.message, log_key, rng));
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
        if self.by_id.contains_key(&id) || self.tombstones.contains(&id) {
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
        if self.by_id.contains_key(&id) || self.tombstones.contains(&id) {
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

    /// Iterates visible (non-deleted, non-internal) log messages in deterministic `(lamport, ts, id)` order.
    pub fn ordered(&self) -> impl Iterator<Item = &LogMessage> {
        self.entries
            .values()
            .filter(|e| !is_internal_log_type(&e.message.msg_type))
            .map(|e| &e.message)
    }

    /// Returns all stored record IDs (including tombstones and updates for sync) in deterministic order.
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

    /// Serializes visible decrypted log messages as a JSON array in canonical order,
    /// omitting deletion tombstones and deterministically folding the latest `bot-update`
    /// onto its target message while preserving original chronological position.
    pub fn write_messages_json_array(&self, out: &mut String) {
        let mut latest_bot_updates: HashMap<&str, (&LogMessage, &JsonValue)> = HashMap::new();
        for entry in self.entries.values() {
            if entry.message.msg_type == MSG_TYPE_BOT_UPDATE
                && let Some(target_id) = extract_target_id(&entry.message.payload)
            {
                let card = entry
                    .message
                    .payload
                    .get("card")
                    .unwrap_or(&entry.message.payload);
                latest_bot_updates.insert(target_id, (&entry.message, card));
            }
        }

        out.push('[');
        let mut first = true;
        for entry in self.entries.values() {
            if is_internal_log_type(&entry.message.msg_type) {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            if let Some((upd_msg, card_payload)) = latest_bot_updates.get(entry.message.id.as_str())
            {
                let m = &entry.message;
                out.push_str("{\"id\":");
                write_json_string(out, &m.id);
                out.push_str(",\"type\":");
                write_json_string(out, &m.msg_type);
                let _ = write!(
                    out,
                    ",\"lamport\":{},\"ts\":{},\"author\":",
                    m.lamport, m.ts
                );
                write_json_string(out, &m.author);
                out.push_str(",\"authorName\":");
                write_json_string(out, &m.author_name);
                out.push_str(",\"payload\":");
                write_json_value(out, card_payload);
                let _ = write!(
                    out,
                    ",\"updatedLamport\":{},\"updatedTs\":{}}}",
                    upd_msg.lamport, upd_msg.ts
                );
            } else {
                entry.message.write_json(out);
            }
        }
        out.push(']');
    }

    /// Serializes a plaintext JSON snapshot (for explicit user decrypted export).
    pub fn export_snapshot_json(&self) -> String {
        let mut out = String::with_capacity(self.entries.len().saturating_mul(160) + 64);
        let _ = write!(
            out,
            "{{\"version\":1,\"lamport\":{},\"messages\":",
            self.lamport
        );
        self.write_messages_json_array(&mut out);
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

    /// Merges a plaintext v1 snapshot into this log.
    pub fn import_snapshot_value(&mut self, val: &JsonValue) -> Result<usize, String> {
        if let Some(lp) = val.get_u64("lamport") {
            self.observe_lamport(lp);
        }
        let msgs = val
            .get("messages")
            .and_then(JsonValue::as_array)
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
