use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;

use crate::json::{JsonValue, write_json_string, write_json_value};

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
        let _ = write!(out, ",\"lamport\":{},\"ts\":{},\"author\":", self.lamport, self.ts);
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

/// Deterministic append-only replicated log ordered strictly by `(lamport, ts, id)`.
#[derive(Debug, Clone, Default)]
pub struct ReplicatedLog {
    entries: BTreeMap<LogOrderKey, LogMessage>,
    by_id: HashMap<String, LogOrderKey>,
    lamport: u64,
}

impl ReplicatedLog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
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

    pub fn get_by_id(&self, id: &str) -> Option<&LogMessage> {
        let key = self.by_id.get(id)?;
        self.entries.get(key)
    }

    /// Inserts a message idempotently. Returns `Ok(true)` if newly added, `Ok(false)` if duplicate.
    pub fn insert(&mut self, msg: LogMessage) -> Result<bool, String> {
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

        let key = msg.order_key();
        self.by_id.insert(msg.id.clone(), key.clone());
        self.entries.insert(key, msg);
        Ok(true)
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

    /// Iterates all log messages in deterministic `(lamport, ts, id)` order.
    pub fn ordered(&self) -> impl Iterator<Item = &LogMessage> {
        self.entries.values()
    }

    /// Returns all message IDs in deterministic `(lamport, ts, id)` order.
    pub fn ids_ordered(&self) -> Vec<String> {
        self.entries.values().map(|m| m.id.clone()).collect()
    }

    /// Returns all messages that are absent from `remote_known`, ordered by `(lamport, ts, id)`.
    pub fn missing_for(&self, remote_known: &HashSet<String>) -> Vec<LogMessage> {
        self.entries
            .values()
            .filter(|m| !remote_known.contains(&m.id))
            .cloned()
            .collect()
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

    /// Serializes the entire log as a JSON array string in canonical field order.
    pub fn write_messages_json_array(&self, out: &mut String) {
        out.push('[');
        for (idx, msg) in self.entries.values().enumerate() {
            if idx > 0 {
                out.push(',');
            }
            msg.write_json(out);
        }
        out.push(']');
    }

    /// Serializes a persistence snapshot containing lamport clock and full ordered log.
    pub fn export_snapshot_json(&self) -> String {
        let mut out = String::with_capacity(self.entries.len().saturating_mul(160) + 64);
        let _ = write!(out, "{{\"version\":1,\"lamport\":{},\"messages\":", self.lamport);
        self.write_messages_json_array(&mut out);
        out.push('}');
        out
    }

    /// Merges a persistence snapshot into this log. Returns number of newly inserted messages.
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
}
