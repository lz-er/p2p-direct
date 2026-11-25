const MAX_INFLATE_BYTES: usize = 2 * 1024 * 1024;
const MAX_HUFF_BITS: usize = 15;
const WINDOW_SIZE: usize = 32_768;
const WINDOW_MASK: usize = WINDOW_SIZE - 1;
const HASH_BITS: usize = 12;
const HASH_SIZE: usize = 1 << HASH_BITS;
const HASH_MASK: usize = HASH_SIZE - 1;
const MAX_MATCH: usize = 258;
const MIN_MATCH: usize = 3;
const MAX_CHAIN: usize = 48;

const LEN_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
    131, 163, 195, 227, 258,
];
const LEN_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

const CODE_LEN_ORDER: [usize; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

fn reverse_bits(code: u16, bits: u8) -> u16 {
    let mut c = code;
    let mut rev: u16 = 0;
    for _ in 0..bits {
        rev = (rev << 1) | (c & 1);
        c >>= 1;
    }
    rev
}

struct BitWriter {
    out: Vec<u8>,
    bit_buf: u64,
    bit_count: u8,
}

impl BitWriter {
    fn new(capacity: usize) -> Self {
        Self {
            out: Vec::with_capacity(capacity),
            bit_buf: 0,
            bit_count: 0,
        }
    }

    fn write_bits(&mut self, value: u32, count: u8) {
        if count == 0 {
            return;
        }
        let mask = if count >= 32 {
            u32::MAX
        } else {
            (1u32 << count) - 1
        };
        self.bit_buf |= u64::from(value & mask) << self.bit_count;
        self.bit_count = self.bit_count.saturating_add(count);
        while self.bit_count >= 8 {
            self.out.push((self.bit_buf & 0xFF) as u8);
            self.bit_buf >>= 8;
            self.bit_count -= 8;
        }
    }

    fn write_huff_code(&mut self, canonical_code: u16, bits: u8) {
        let rev = reverse_bits(canonical_code, bits);
        self.write_bits(u32::from(rev), bits);
    }

    fn finish(mut self) -> Vec<u8> {
        if self.bit_count > 0 {
            self.out.push((self.bit_buf & 0xFF) as u8);
            self.bit_buf = 0;
            self.bit_count = 0;
        }
        self.out
    }
}

fn write_fixed_litlen(bw: &mut BitWriter, sym: u16) {
    if sym <= 143 {
        bw.write_huff_code(0x030 + sym, 8);
    } else if sym <= 255 {
        bw.write_huff_code(0x190 + (sym - 144), 9);
    } else if sym <= 279 {
        bw.write_huff_code(sym - 256, 7);
    } else if sym <= 287 {
        bw.write_huff_code(0x0C0 + (sym - 280), 8);
    }
}

fn write_fixed_match(bw: &mut BitWriter, length: usize, distance: usize) {
    let len_u16 = length as u16;
    let mut len_idx = 0usize;
    for (i, (&base, &extra)) in LEN_BASE.iter().zip(LEN_EXTRA.iter()).enumerate() {
        let max_len = if extra == 0 {
            base
        } else {
            base.saturating_add((1u16 << extra) - 1)
        };
        if len_u16 >= base && len_u16 <= max_len {
            len_idx = i;
            break;
        }
    }
    write_fixed_litlen(bw, 257 + (len_idx as u16));
    if let (Some(&base), Some(&extra)) = (LEN_BASE.get(len_idx), LEN_EXTRA.get(len_idx))
        && extra > 0
    {
        bw.write_bits(u32::from(len_u16.saturating_sub(base)), extra);
    }

    let dist_u16 = distance as u16;
    let mut dist_idx = 0usize;
    for (i, (&base, &extra)) in DIST_BASE.iter().zip(DIST_EXTRA.iter()).enumerate() {
        let max_dist = base.saturating_add((1u16 << extra) - 1);
        if dist_u16 >= base && dist_u16 <= max_dist {
            dist_idx = i;
            break;
        }
    }
    bw.write_huff_code(dist_idx as u16, 5);
    if let (Some(&base), Some(&extra)) = (DIST_BASE.get(dist_idx), DIST_EXTRA.get(dist_idx))
        && extra > 0
    {
        bw.write_bits(u32::from(dist_u16.saturating_sub(base)), extra);
    }
}

fn hash3(data: &[u8], pos: usize) -> Option<usize> {
    let b0 = usize::from(*data.get(pos)?);
    let b1 = usize::from(*data.get(pos + 1)?);
    let b2 = usize::from(*data.get(pos + 2)?);
    Some(((b0 << 8) ^ (b1 << 4) ^ b2) & HASH_MASK)
}

fn find_best_match(
    data: &[u8],
    pos: usize,
    head: &[i32],
    prev: &[i32],
) -> (usize, usize) {
    let remaining = data.len().saturating_sub(pos);
    if remaining < MIN_MATCH {
        return (0, 0);
    }
    let Some(h) = hash3(data, pos) else {
        return (0, 0);
    };
    let max_len = remaining.min(MAX_MATCH);
    let mut cur = match head.get(h) {
        Some(&v) => v,
        None => return (0, 0),
    };
    let mut best_len = 0usize;
    let mut best_dist = 0usize;
    let mut steps = 0usize;

    while cur >= 0 && steps < MAX_CHAIN {
        let cand = cur as usize;
        let dist = pos.saturating_sub(cand);
        if dist == 0 || dist > WINDOW_SIZE {
            break;
        }
        // Quick tail check before full scan
        let tail_ok = if best_len >= MIN_MATCH {
            data.get(cand + best_len) == data.get(pos + best_len)
        } else {
            true
        };
        if tail_ok {
            let mut mlen = 0usize;
            while mlen < max_len {
                if data.get(cand + mlen) == data.get(pos + mlen) {
                    mlen += 1;
                } else {
                    break;
                }
            }
            if mlen >= MIN_MATCH && mlen > best_len {
                best_len = mlen;
                best_dist = dist;
                if best_len == max_len {
                    break;
                }
            }
        }
        cur = prev.get(cand & WINDOW_MASK).copied().unwrap_or(-1);
        steps += 1;
    }

    (best_len, best_dist)
}

fn insert_hash(data: &[u8], pos: usize, head: &mut [i32], prev: &mut [i32]) {
    if let Some(h) = hash3(data, pos)
        && let Some(head_slot) = head.get_mut(h)
    {
        let old = *head_slot;
        if let Some(prev_slot) = prev.get_mut(pos & WINDOW_MASK) {
            *prev_slot = old;
        }
        *head_slot = pos as i32;
    }
}

fn deflate_stored(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() + 16);
    if input.is_empty() {
        out.push(0x01); // BFINAL=1, BTYPE=00
        out.extend_from_slice(&[0x00, 0x00, 0xFF, 0xFF]);
        return out;
    }
    let mut offset = 0usize;
    while offset < input.len() {
        let chunk_len = (input.len() - offset).min(65_535);
        let is_final = offset + chunk_len >= input.len();
        out.push(if is_final { 0x01 } else { 0x00 });
        let len_u16 = chunk_len as u16;
        let nlen_u16 = !len_u16;
        out.extend_from_slice(&len_u16.to_le_bytes());
        out.extend_from_slice(&nlen_u16.to_le_bytes());
        if let Some(slice) = input.get(offset..offset + chunk_len) {
            out.extend_from_slice(slice);
        }
        offset += chunk_len;
    }
    out
}

/// Compresses `input` into a standard RFC 1951 raw DEFLATE byte stream.
pub fn deflate_raw(input: &[u8]) -> Vec<u8> {
    if input.is_empty() {
        let mut bw = BitWriter::new(4);
        bw.write_bits(1, 1); // BFINAL = 1
        bw.write_bits(1, 2); // BTYPE = 01 (fixed Huffman)
        write_fixed_litlen(&mut bw, 256); // EOB
        return bw.finish();
    }

    let mut bw = BitWriter::new(input.len());
    bw.write_bits(1, 1); // BFINAL = 1
    bw.write_bits(1, 2); // BTYPE = 01 (fixed Huffman)

    let mut head = vec![-1i32; HASH_SIZE];
    let mut prev = vec![-1i32; WINDOW_SIZE];
    let mut pos = 0usize;

    while pos < input.len() {
        let (best_len, best_dist) = find_best_match(input, pos, &head, &prev);
        insert_hash(input, pos, &mut head, &mut prev);

        if best_len >= MIN_MATCH {
            // One-step lazy match check for better compression ratio
            let mut use_lazy = false;
            if best_len < MAX_MATCH && pos + 1 + MIN_MATCH <= input.len() {
                let (next_len, _) = find_best_match(input, pos + 1, &head, &prev);
                if next_len > best_len + 1 {
                    use_lazy = true;
                }
            }
            if use_lazy {
                if let Some(&b) = input.get(pos) {
                    write_fixed_litlen(&mut bw, u16::from(b));
                }
                pos += 1;
            } else {
                write_fixed_match(&mut bw, best_len, best_dist);
                for p in (pos + 1)..(pos + best_len) {
                    insert_hash(input, p, &mut head, &mut prev);
                }
                pos += best_len;
            }
        } else {
            if let Some(&b) = input.get(pos) {
                write_fixed_litlen(&mut bw, u16::from(b));
            }
            pos += 1;
        }
    }

    write_fixed_litlen(&mut bw, 256); // End of block
    let compressed = bw.finish();

    let stored_overhead = 5 * (input.len().div_ceil(65_535).max(1));
    if compressed.len() < input.len().saturating_add(stored_overhead) {
        compressed
    } else {
        deflate_stored(input)
    }
}

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    bit_buf: u64,
    bit_count: u8,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            pos: 0,
            bit_buf: 0,
            bit_count: 0,
        }
    }

    fn ensure_bits(&mut self, n: u8) -> Result<(), String> {
        while self.bit_count < n {
            let Some(&b) = self.data.get(self.pos) else {
                return Err("unexpected end of deflate bitstream".to_owned());
            };
            self.pos += 1;
            self.bit_buf |= u64::from(b) << self.bit_count;
            self.bit_count += 8;
        }
        Ok(())
    }

    fn read_bits(&mut self, n: u8) -> Result<u32, String> {
        if n == 0 {
            return Ok(0);
        }
        self.ensure_bits(n)?;
        let mask = (1u64 << n) - 1;
        let val = (self.bit_buf & mask) as u32;
        self.bit_buf >>= n;
        self.bit_count -= n;
        Ok(val)
    }

    fn align_byte(&mut self) {
        let discard = self.bit_count % 8;
        self.bit_buf >>= discard;
        self.bit_count -= discard;
    }

    fn read_aligned_u16(&mut self) -> Result<u16, String> {
        let lo = self.read_bits(8)? as u16;
        let hi = self.read_bits(8)? as u16;
        Ok(lo | (hi << 8))
    }

    fn read_aligned_bytes(&mut self, len: usize, out: &mut Vec<u8>) -> Result<(), String> {
        // Drain any whole bytes sitting in bit_buf first
        let mut remaining = len;
        while remaining > 0 && self.bit_count >= 8 {
            out.push((self.bit_buf & 0xFF) as u8);
            self.bit_buf >>= 8;
            self.bit_count -= 8;
            remaining -= 1;
        }
        if remaining > 0 {
            let end = self
                .pos
                .checked_add(remaining)
                .ok_or_else(|| "deflate stored block length overflow".to_owned())?;
            let slice = self
                .data
                .get(self.pos..end)
                .ok_or_else(|| "truncated deflate stored block".to_owned())?;
            out.extend_from_slice(slice);
            self.pos = end;
        }
        Ok(())
    }
}

struct HuffmanDecoder {
    counts: [u16; MAX_HUFF_BITS + 1],
    symbols: Vec<u16>,
    max_bits: usize,
}

impl HuffmanDecoder {
    fn from_lengths(lengths: &[u8]) -> Result<Self, String> {
        let mut counts = [0u16; MAX_HUFF_BITS + 1];
        let mut max_bits = 0usize;
        for &len in lengths {
            let l = usize::from(len);
            if l > MAX_HUFF_BITS {
                return Err(format!("invalid huffman bit length {l}"));
            }
            if l > 0 {
                if let Some(c) = counts.get_mut(l) {
                    *c = c.saturating_add(1);
                }
                if l > max_bits {
                    max_bits = l;
                }
            }
        }

        if max_bits == 0 {
            return Ok(Self {
                counts,
                symbols: Vec::new(),
                max_bits: 0,
            });
        }

        // Validate Kraft inequality (allow under-subscribed single-symbol trees)
        let mut left: i32 = 1;
        for bits in 1..=max_bits {
            left <<= 1;
            left -= i32::from(counts.get(bits).copied().unwrap_or(0));
            if left < 0 {
                return Err("over-subscribed huffman code table".to_owned());
            }
        }

        let mut offsets = [0u16; MAX_HUFF_BITS + 1];
        let mut total: u16 = 0;
        for bits in 1..=MAX_HUFF_BITS {
            if let Some(off) = offsets.get_mut(bits) {
                *off = total;
            }
            total = total.saturating_add(counts.get(bits).copied().unwrap_or(0));
        }

        let mut symbols = vec![0u16; usize::from(total)];
        for (sym, &len) in lengths.iter().enumerate() {
            let l = usize::from(len);
            if l > 0
                && let Some(off) = offsets.get_mut(l)
            {
                let idx = usize::from(*off);
                if let Some(slot) = symbols.get_mut(idx) {
                    *slot = sym as u16;
                }
                *off = off.saturating_add(1);
            }
        }

        Ok(Self {
            counts,
            symbols,
            max_bits,
        })
    }

    fn decode(&self, br: &mut BitReader<'_>) -> Result<u16, String> {
        if self.max_bits == 0 {
            return Err("attempted decode on empty huffman tree".to_owned());
        }
        let mut code: i32 = 0;
        let mut first: i32 = 0;
        let mut index: i32 = 0;
        for bits in 1..=self.max_bits {
            let bit = br.read_bits(1)? as i32;
            code = (code << 1) | bit;
            let count = i32::from(self.counts.get(bits).copied().unwrap_or(0));
            if code - count < first {
                let sym_idx = (index + (code - first)) as usize;
                return self
                    .symbols
                    .get(sym_idx)
                    .copied()
                    .ok_or_else(|| "huffman symbol index out of bounds".to_owned());
            }
            index += count;
            first = (first + count) << 1;
        }
        Err("invalid huffman code in deflate stream".to_owned())
    }
}

fn fixed_huffman_tables() -> Result<(HuffmanDecoder, HuffmanDecoder), String> {
    let mut lit_lens = [0u8; 288];
    for (i, slot) in lit_lens.iter_mut().enumerate() {
        *slot = if i <= 143 {
            8
        } else if i <= 255 {
            9
        } else if i <= 279 {
            7
        } else {
            8
        };
    }
    let dist_lens = [5u8; 32];
    Ok((
        HuffmanDecoder::from_lengths(&lit_lens)?,
        HuffmanDecoder::from_lengths(&dist_lens)?,
    ))
}

fn read_dynamic_tables(
    br: &mut BitReader<'_>,
) -> Result<(HuffmanDecoder, HuffmanDecoder), String> {
    let hlit = (br.read_bits(5)? as usize) + 257;
    let hdist = (br.read_bits(5)? as usize) + 1;
    let hclen = (br.read_bits(4)? as usize) + 4;

    if hlit > 286 || hdist > 32 || hclen > 19 {
        return Err("invalid dynamic huffman header lengths".to_owned());
    }

    let mut cl_lens = [0u8; 19];
    for &idx in CODE_LEN_ORDER.iter().take(hclen) {
        let len = br.read_bits(3)? as u8;
        if let Some(slot) = cl_lens.get_mut(idx) {
            *slot = len;
        }
    }
    let cl_dec = HuffmanDecoder::from_lengths(&cl_lens)?;

    let total = hlit + hdist;
    let mut lengths = Vec::with_capacity(total);
    while lengths.len() < total {
        let sym = cl_dec.decode(br)?;
        match sym {
            0..=15 => lengths.push(sym as u8),
            16 => {
                let prev = *lengths
                    .last()
                    .ok_or_else(|| "repeat code 16 with no previous length".to_owned())?;
                let repeat = (br.read_bits(2)? as usize) + 3;
                if lengths.len() + repeat > total {
                    return Err("dynamic huffman code length overflow (16)".to_owned());
                }
                lengths.resize(lengths.len() + repeat, prev);
            }
            17 => {
                let repeat = (br.read_bits(3)? as usize) + 3;
                if lengths.len() + repeat > total {
                    return Err("dynamic huffman code length overflow (17)".to_owned());
                }
                lengths.resize(lengths.len() + repeat, 0);
            }
            18 => {
                let repeat = (br.read_bits(7)? as usize) + 11;
                if lengths.len() + repeat > total {
                    return Err("dynamic huffman code length overflow (18)".to_owned());
                }
                lengths.resize(lengths.len() + repeat, 0);
            }
            _ => return Err(format!("invalid code-length symbol {sym}")),
        }
    }

    let lit_slice = lengths
        .get(0..hlit)
        .ok_or_else(|| "missing litlen code lengths".to_owned())?;
    let dist_slice = lengths
        .get(hlit..total)
        .ok_or_else(|| "missing distance code lengths".to_owned())?;

    Ok((
        HuffmanDecoder::from_lengths(lit_slice)?,
        HuffmanDecoder::from_lengths(dist_slice)?,
    ))
}

fn inflate_huffman_block(
    br: &mut BitReader<'_>,
    lit_dec: &HuffmanDecoder,
    dist_dec: &HuffmanDecoder,
    out: &mut Vec<u8>,
) -> Result<(), String> {
    loop {
        let sym = lit_dec.decode(br)?;
        if sym < 256 {
            if out.len() >= MAX_INFLATE_BYTES {
                return Err("inflated output exceeds maximum safety limit".to_owned());
            }
            out.push(sym as u8);
        } else if sym == 256 {
            return Ok(());
        } else if sym <= 285 {
            let len_idx = usize::from(sym - 257);
            let base_len = usize::from(
                LEN_BASE
                    .get(len_idx)
                    .copied()
                    .ok_or_else(|| "length base index out of range".to_owned())?,
            );
            let extra_len_bits = LEN_EXTRA
                .get(len_idx)
                .copied()
                .ok_or_else(|| "length extra index out of range".to_owned())?;
            let length = base_len + (br.read_bits(extra_len_bits)? as usize);

            let dist_sym = usize::from(dist_dec.decode(br)?);
            let base_dist = usize::from(
                DIST_BASE
                    .get(dist_sym)
                    .copied()
                    .ok_or_else(|| format!("invalid distance symbol {dist_sym}"))?,
            );
            let extra_dist_bits = DIST_EXTRA
                .get(dist_sym)
                .copied()
                .ok_or_else(|| format!("invalid distance extra symbol {dist_sym}"))?;
            let distance = base_dist + (br.read_bits(extra_dist_bits)? as usize);

            if distance == 0 || distance > out.len() {
                return Err(format!(
                    "deflate back-reference distance {distance} exceeds output len {}",
                    out.len()
                ));
            }
            if out.len().saturating_add(length) > MAX_INFLATE_BYTES {
                return Err("inflated output exceeds maximum safety limit".to_owned());
            }
            for _ in 0..length {
                let src_idx = out.len() - distance;
                let byte = out
                    .get(src_idx)
                    .copied()
                    .ok_or_else(|| "back-reference copy index out of range".to_owned())?;
                out.push(byte);
            }
        } else {
            return Err(format!("invalid litlen symbol {sym}"));
        }
    }
}

/// Decompresses a standard RFC 1951 raw DEFLATE byte stream.
pub fn inflate_raw(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut br = BitReader::new(input);
    let mut out = Vec::new();
    loop {
        let bfinal = br.read_bits(1)?;
        let btype = br.read_bits(2)?;
        match btype {
            0 => {
                br.align_byte();
                let len = br.read_aligned_u16()?;
                let nlen = br.read_aligned_u16()?;
                if len != !nlen {
                    return Err("stored block LEN/NLEN complement mismatch".to_owned());
                }
                let len_usize = usize::from(len);
                if out.len().saturating_add(len_usize) > MAX_INFLATE_BYTES {
                    return Err("inflated output exceeds maximum safety limit".to_owned());
                }
                br.read_aligned_bytes(len_usize, &mut out)?;
            }
            1 => {
                let (lit_dec, dist_dec) = fixed_huffman_tables()?;
                inflate_huffman_block(&mut br, &lit_dec, &dist_dec, &mut out)?;
            }
            2 => {
                let (lit_dec, dist_dec) = read_dynamic_tables(&mut br)?;
                inflate_huffman_block(&mut br, &lit_dec, &dist_dec, &mut out)?;
            }
            _ => return Err(format!("reserved deflate block type {btype}")),
        }
        if bfinal == 1 {
            break;
        }
    }
    Ok(out)
}

/// Decompresses RFC 1951 raw DEFLATE, or falls back to RFC 1950 zlib-wrapped DEFLATE if present.
pub fn inflate_auto(input: &[u8]) -> Result<Vec<u8>, String> {
    match inflate_raw(input) {
        Ok(raw) => Ok(raw),
        Err(raw_err) => {
            if input.len() >= 6
                && let (Some(&cmf), Some(&flg)) = (input.first(), input.get(1))
            {
                let is_deflate = (cmf & 0x0F) == 8 && (cmf >> 4) <= 7;
                let checksum_ok = ((u16::from(cmf) << 8) | u16::from(flg)) % 31 == 0;
                let no_dict = (flg & 0x20) == 0;
                if is_deflate
                    && checksum_ok
                    && no_dict
                    && let Some(inner) = input.get(2..input.len() - 4)
                    && let Ok(zlib_out) = inflate_raw(inner)
                {
                    return Ok(zlib_out);
                }
            }
            Err(raw_err)
        }
    }
}

const B64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Encodes bytes using unpadded URL-safe Base64 (RFC 4648 §5).
pub fn base64url_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut i = 0usize;
    while i < input.len() {
        let b0 = input.get(i).copied().unwrap_or(0);
        let b1 = input.get(i + 1).copied();
        let b2 = input.get(i + 2).copied();

        let n0 = usize::from(b0 >> 2);
        let n1 = usize::from(((b0 & 0x03) << 4) | (b1.unwrap_or(0) >> 4));
        if let Some(&c) = B64URL_ALPHABET.get(n0) {
            out.push(c as char);
        }
        if let Some(&c) = B64URL_ALPHABET.get(n1) {
            out.push(c as char);
        }
        if let Some(v1) = b1 {
            let n2 = usize::from(((v1 & 0x0F) << 2) | (b2.unwrap_or(0) >> 6));
            if let Some(&c) = B64URL_ALPHABET.get(n2) {
                out.push(c as char);
            }
            if let Some(v2) = b2 {
                let n3 = usize::from(v2 & 0x3F);
                if let Some(&c) = B64URL_ALPHABET.get(n3) {
                    out.push(c as char);
                }
            }
        }
        i += 3;
    }
    out
}

/// Decodes URL-safe (or standard) Base64, tolerating optional `=` padding and whitespace.
pub fn base64url_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut vals = Vec::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' => vals.push(b - b'A'),
            b'a'..=b'z' => vals.push(b - b'a' + 26),
            b'0'..=b'9' => vals.push(b - b'0' + 52),
            b'-' | b'+' => vals.push(62),
            b'_' | b'/' => vals.push(63),
            b'=' | b' ' | b'\t' | b'\r' | b'\n' => {}
            other => {
                return Err(format!("invalid base64url byte 0x{other:02x}"));
            }
        }
    }

    if vals.len() % 4 == 1 {
        return Err("invalid base64url length (mod 4 == 1)".to_owned());
    }

    let mut out = Vec::with_capacity((vals.len() / 4) * 3 + 2);
    let mut i = 0usize;
    while i < vals.len() {
        let v0 = vals.get(i).copied().unwrap_or(0);
        let v1 = vals.get(i + 1).copied().unwrap_or(0);
        out.push((v0 << 2) | (v1 >> 4));
        if let Some(&v2) = vals.get(i + 2) {
            out.push((v1 << 4) | (v2 >> 2));
            if let Some(&v3) = vals.get(i + 3) {
                out.push((v2 << 6) | v3);
            }
        }
        i += 4;
    }
    Ok(out)
}
