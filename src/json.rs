use std::collections::BTreeMap;
use std::fmt::Write as _;

const MAX_JSON_DEPTH: usize = 128;

#[derive(Debug, Clone)]
pub enum JsonNumber {
    Int(i64),
    Uint(u64),
    Float(f64),
}

impl PartialEq for JsonNumber {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Int(a), Self::Int(b)) => a == b,
            (Self::Uint(a), Self::Uint(b)) => a == b,
            (Self::Int(a), Self::Uint(b)) => *a >= 0 && (*a as u64) == *b,
            (Self::Uint(a), Self::Int(b)) => *b >= 0 && *a == (*b as u64),
            (Self::Float(a), Self::Float(b)) => a == b,
            (Self::Float(a), Self::Int(b)) | (Self::Int(b), Self::Float(a)) => {
                *a == (*b as f64)
            }
            (Self::Float(a), Self::Uint(b)) | (Self::Uint(b), Self::Float(a)) => {
                *a == (*b as f64)
            }
        }
    }
}

impl JsonNumber {
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Uint(v) => Some(*v),
            Self::Int(v) if *v >= 0 => Some(*v as u64),
            Self::Float(v) if v.is_finite() && *v >= 0.0 && v.fract() == 0.0 && *v <= (u64::MAX as f64) => {
                Some(*v as u64)
            }
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(v) => Some(*v),
            Self::Uint(v) => i64::try_from(*v).ok(),
            Self::Float(v) if v.is_finite() && v.fract() == 0.0 && *v >= (i64::MIN as f64) && *v <= (i64::MAX as f64) => {
                Some(*v as i64)
            }
            _ => None,
        }
    }

    pub fn as_f64(&self) -> f64 {
        match self {
            Self::Int(v) => *v as f64,
            Self::Uint(v) => *v as f64,
            Self::Float(v) => *v,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(JsonNumber),
    String(String),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>),
}

impl JsonValue {
    pub fn object() -> Self {
        Self::Object(BTreeMap::new())
    }

    pub fn from_u64(v: u64) -> Self {
        Self::Number(JsonNumber::Uint(v))
    }

    pub fn from_i64(v: i64) -> Self {
        Self::Number(JsonNumber::Int(v))
    }

    pub fn from_f64(v: f64) -> Self {
        if v.is_finite() {
            Self::Number(JsonNumber::Float(v))
        } else {
            Self::Null
        }
    }

    pub fn string(v: &str) -> Self {
        Self::String(v.to_owned())
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Number(n) => n.as_u64(),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Number(n) => n.as_i64(),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[JsonValue]> {
        match self {
            Self::Array(arr) => Some(arr.as_slice()),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&BTreeMap<String, JsonValue>> {
        match self {
            Self::Object(map) => Some(map),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&JsonValue> {
        self.as_object()?.get(key)
    }

    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key)?.as_str()
    }

    pub fn get_u64(&self, key: &str) -> Option<u64> {
        self.get(key)?.as_u64()
    }

    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.get(key)?.as_bool()
    }

    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        write_json_value(&mut out, self);
        out
    }
}

pub fn parse_json(input: &str) -> Result<JsonValue, String> {
    let mut parser = Parser {
        bytes: input.as_bytes(),
        pos: 0,
        depth: 0,
    };
    parser.skip_ws();
    let value = parser.parse_value()?;
    parser.skip_ws();
    if parser.pos != parser.bytes.len() {
        return Err(format!(
            "unexpected trailing characters at byte {}",
            parser.pos
        ));
    }
    Ok(value)
}

pub fn write_json_string(out: &mut String, s: &str) {
    out.reserve(s.len() + 2);
    out.push('"');
    let bytes = s.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b < 0x20 || b == b'"' || b == b'\\' {
            if i > start {
                out.push_str(&s[start..i]);
            }
            match b {
                b'"' => out.push_str("\\\""),
                b'\\' => out.push_str("\\\\"),
                0x08 => out.push_str("\\b"),
                0x0C => out.push_str("\\f"),
                b'\n' => out.push_str("\\n"),
                b'\r' => out.push_str("\\r"),
                b'\t' => out.push_str("\\t"),
                c => {
                    let _ = write!(out, "\\u{:04x}", u32::from(c));
                }
            }
            start = i + 1;
        }
        i += 1;
    }
    if start < bytes.len() {
        out.push_str(&s[start..]);
    }
    out.push('"');
}

pub fn write_json_value(out: &mut String, value: &JsonValue) {
    match value {
        JsonValue::Null => out.push_str("null"),
        JsonValue::Bool(true) => out.push_str("true"),
        JsonValue::Bool(false) => out.push_str("false"),
        JsonValue::Number(JsonNumber::Int(n)) => {
            let _ = write!(out, "{n}");
        }
        JsonValue::Number(JsonNumber::Uint(n)) => {
            let _ = write!(out, "{n}");
        }
        JsonValue::Number(JsonNumber::Float(n)) => {
            if n.is_finite() {
                let _ = write!(out, "{n}");
            } else {
                out.push_str("null");
            }
        }
        JsonValue::String(s) => write_json_string(out, s),
        JsonValue::Array(items) => {
            out.push('[');
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                write_json_value(out, item);
            }
            out.push(']');
        }
        JsonValue::Object(map) => {
            out.push('{');
            for (idx, (k, v)) in map.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                write_json_string(out, k);
                out.push(':');
                write_json_value(out, v);
            }
            out.push('}');
        }
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn next_byte(&mut self) -> Option<u8> {
        let b = self.bytes.get(self.pos).copied()?;
        self.pos += 1;
        Some(b)
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if matches!(b, b' ' | b'\t' | b'\r' | b'\n') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self) -> Result<JsonValue, String> {
        if self.depth >= MAX_JSON_DEPTH {
            return Err("JSON nesting depth exceeded".to_owned());
        }
        self.skip_ws();
        let b = self
            .peek()
            .ok_or_else(|| "unexpected end of JSON input".to_owned())?;
        match b {
            b'n' => self.parse_literal(b"null", JsonValue::Null),
            b't' => self.parse_literal(b"true", JsonValue::Bool(true)),
            b'f' => self.parse_literal(b"false", JsonValue::Bool(false)),
            b'"' => self.parse_string().map(JsonValue::String),
            b'[' => self.parse_array(),
            b'{' => self.parse_object(),
            b'-' | b'0'..=b'9' => self.parse_number(),
            other => Err(format!(
                "unexpected byte 0x{other:02x} at position {}",
                self.pos
            )),
        }
    }

    fn parse_literal(&mut self, expected: &[u8], val: JsonValue) -> Result<JsonValue, String> {
        let end = self.pos.saturating_add(expected.len());
        match self.bytes.get(self.pos..end) {
            Some(slice) if slice == expected => {
                self.pos = end;
                Ok(val)
            }
            _ => Err(format!("invalid literal at byte {}", self.pos)),
        }
    }

    fn parse_array(&mut self) -> Result<JsonValue, String> {
        self.pos += 1; // consume '['
        self.depth += 1;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            self.depth -= 1;
            return Ok(JsonValue::Array(items));
        }
        loop {
            let item = self.parse_value()?;
            items.push(item);
            self.skip_ws();
            match self.next_byte() {
                Some(b',') => continue,
                Some(b']') => {
                    self.depth -= 1;
                    return Ok(JsonValue::Array(items));
                }
                _ => {
                    self.depth -= 1;
                    return Err(format!("expected ',' or ']' at byte {}", self.pos));
                }
            }
        }
    }

    fn parse_object(&mut self) -> Result<JsonValue, String> {
        self.pos += 1; // consume '{'
        self.depth += 1;
        let mut map = BTreeMap::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            self.depth -= 1;
            return Ok(JsonValue::Object(map));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                self.depth -= 1;
                return Err(format!("expected string key at byte {}", self.pos));
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.next_byte() != Some(b':') {
                self.depth -= 1;
                return Err(format!("expected ':' after key at byte {}", self.pos));
            }
            let val = self.parse_value()?;
            map.insert(key, val);
            self.skip_ws();
            match self.next_byte() {
                Some(b',') => continue,
                Some(b'}') => {
                    self.depth -= 1;
                    return Ok(JsonValue::Object(map));
                }
                _ => {
                    self.depth -= 1;
                    return Err(format!("expected ',' or '}}' at byte {}", self.pos));
                }
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        if self.next_byte() != Some(b'"') {
            return Err(format!("expected '\"' at byte {}", self.pos));
        }
        // Fast path: scan contiguous plain ASCII bytes (e.g., multi-MB base64 GIFs / ciphertexts)
        let fast_start = self.pos;
        while let Some(&b) = self.bytes.get(self.pos) {
            if (0x20..0x80).contains(&b) && b != b'"' && b != b'\\' {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.peek() == Some(b'"') {
            let slice = &self.bytes[fast_start..self.pos];
            self.pos += 1;
            return std::str::from_utf8(slice)
                .map(str::to_owned)
                .map_err(|_| "invalid UTF-8 bytes in string".to_owned());
        }

        let mut out = String::with_capacity(self.pos.saturating_sub(fast_start) + 32);
        if self.pos > fast_start {
            let prefix = std::str::from_utf8(&self.bytes[fast_start..self.pos])
                .map_err(|_| "invalid UTF-8 bytes in string".to_owned())?;
            out.push_str(prefix);
        }

        loop {
            let span_start = self.pos;
            while let Some(&b) = self.bytes.get(self.pos) {
                if (0x20..0x80).contains(&b) && b != b'"' && b != b'\\' {
                    self.pos += 1;
                } else {
                    break;
                }
            }
            if self.pos > span_start {
                let span = std::str::from_utf8(&self.bytes[span_start..self.pos])
                    .map_err(|_| "invalid UTF-8 bytes in string".to_owned())?;
                out.push_str(span);
            }

            let b = self
                .next_byte()
                .ok_or_else(|| "unterminated JSON string".to_owned())?;
            match b {
                b'"' => return Ok(out),
                b'\\' => {
                    let esc = self
                        .next_byte()
                        .ok_or_else(|| "unterminated escape sequence".to_owned())?;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let code = self.parse_hex4()?;
                            if (0xD800..=0xDBFF).contains(&code) {
                                // High surrogate must be followed by \uXXXX low surrogate
                                if self.next_byte() != Some(b'\\')
                                    || self.next_byte() != Some(b'u')
                                {
                                    return Err("missing low surrogate escape".to_owned());
                                }
                                let low = self.parse_hex4()?;
                                if !(0xDC00..=0xDFFF).contains(&low) {
                                    return Err("invalid low surrogate value".to_owned());
                                }
                                let combined = 0x10000
                                    + (((u32::from(code) - 0xD800) << 10)
                                        | (u32::from(low) - 0xDC00));
                                let ch = char::from_u32(combined)
                                    .ok_or_else(|| "invalid unicode scalar".to_owned())?;
                                out.push(ch);
                            } else if (0xDC00..=0xDFFF).contains(&code) {
                                return Err("unpaired low surrogate".to_owned());
                            } else {
                                let ch = char::from_u32(u32::from(code))
                                    .ok_or_else(|| "invalid unicode code point".to_owned())?;
                                out.push(ch);
                            }
                        }
                        other => {
                            return Err(format!("invalid escape \\x{other:02x}"));
                        }
                    }
                }
                c if c < 0x20 => {
                    return Err(format!(
                        "unescaped control character 0x{c:02x} in string"
                    ));
                }
                first => {
                    let start = self.pos - 1;
                    let width = utf8_width(first)
                        .ok_or_else(|| format!("invalid UTF-8 lead byte 0x{first:02x}"))?;
                    let end = start.saturating_add(width);
                    let slice = self
                        .bytes
                        .get(start..end)
                        .ok_or_else(|| "truncated UTF-8 sequence in string".to_owned())?;
                    let s = std::str::from_utf8(slice)
                        .map_err(|_| "invalid UTF-8 bytes in string".to_owned())?;
                    out.push_str(s);
                    self.pos = end;
                }
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u16, String> {
        let mut val: u16 = 0;
        for _ in 0..4 {
            let b = self
                .next_byte()
                .ok_or_else(|| "truncated \\uXXXX escape".to_owned())?;
            let digit = match b {
                b'0'..=b'9' => u16::from(b - b'0'),
                b'a'..=b'f' => u16::from(b - b'a' + 10),
                b'A'..=b'F' => u16::from(b - b'A' + 10),
                _ => return Err("invalid hex digit in \\uXXXX escape".to_owned()),
            };
            val = (val << 4) | digit;
        }
        Ok(val)
    }

    fn parse_number(&mut self) -> Result<JsonValue, String> {
        let start = self.pos;
        let is_neg = if self.peek() == Some(b'-') {
            self.pos += 1;
            true
        } else {
            false
        };

        match self.peek() {
            Some(b'0') => {
                self.pos += 1;
            }
            Some(b'1'..=b'9') => {
                self.pos += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return Err(format!("invalid number at byte {start}")),
        }

        let mut is_float = false;
        if self.peek() == Some(b'.') {
            is_float = true;
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(format!("expected digit after '.' at byte {}", self.pos));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }

        if matches!(self.peek(), Some(b'e' | b'E')) {
            is_float = true;
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(format!("expected exponent digit at byte {}", self.pos));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }

        let slice = self
            .bytes
            .get(start..self.pos)
            .ok_or_else(|| "number slice out of range".to_owned())?;
        let text = std::str::from_utf8(slice)
            .map_err(|_| "invalid UTF-8 in number".to_owned())?;

        if !is_float {
            if is_neg {
                if let Ok(v) = text.parse::<i64>() {
                    return Ok(JsonValue::Number(JsonNumber::Int(v)));
                }
            } else if let Ok(v) = text.parse::<u64>() {
                return Ok(JsonValue::Number(JsonNumber::Uint(v)));
            }
        }

        let f = text
            .parse::<f64>()
            .map_err(|_| format!("invalid floating-point number '{text}'"))?;
        if !f.is_finite() {
            return Err(format!("non-finite number '{text}'"));
        }
        Ok(JsonValue::Number(JsonNumber::Float(f)))
    }
}

fn utf8_width(first: u8) -> Option<usize> {
    if first & 0b1110_0000 == 0b1100_0000 {
        Some(2)
    } else if first & 0b1111_0000 == 0b1110_0000 {
        Some(3)
    } else if first & 0b1111_1000 == 0b1111_0000 {
        Some(4)
    } else {
        None
    }
}
