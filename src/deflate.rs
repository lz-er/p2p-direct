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

#[inline(always)]
fn reverse_bits(code: u16, bits: u8) -> u16 {
    if bits == 0 || bits > 16 {
        return 0;
    }
    code.reverse_bits() >> (16 - bits)
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
        if tail_ok
            && let (Some(a), Some(b)) = (
                data.get(cand..cand + max_len),
                data.get(pos..pos + max_len),
            )
        {
            let mlen = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
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

const B64_DEC_WS_OR_PAD: u8 = 0xFE;
const B64_DEC_INVALID: u8 = 0xFF;

const fn build_b64_dec_table() -> [u8; 256] {
    let mut table = [B64_DEC_INVALID; 256];
    let mut i = 0usize;
    while i < 26 {
        table[(b'A' as usize) + i] = i as u8;
        table[(b'a' as usize) + i] = (i + 26) as u8;
        i += 1;
    }
    let mut d = 0usize;
    while d < 10 {
        table[(b'0' as usize) + d] = (d + 52) as u8;
        d += 1;
    }
    table[b'-' as usize] = 62;
    table[b'+' as usize] = 62;
    table[b'_' as usize] = 63;
    table[b'/' as usize] = 63;
    table[b'=' as usize] = B64_DEC_WS_OR_PAD;
    table[b' ' as usize] = B64_DEC_WS_OR_PAD;
    table[b'\t' as usize] = B64_DEC_WS_OR_PAD;
    table[b'\r' as usize] = B64_DEC_WS_OR_PAD;
    table[b'\n' as usize] = B64_DEC_WS_OR_PAD;
    table
}

const B64_DEC_TABLE: [u8; 256] = build_b64_dec_table();

/// Appends unpadded URL-safe Base64 (RFC 4648 §5) directly into `out` via a 256-byte L1-hot
/// stack buffer (zero intermediate heap allocation even for multi-MB media ciphertexts).
pub fn base64url_encode_into(input: &[u8], out: &mut String) {
    let rem_len = input.len() % 3;
    let encoded_len = (input.len() / 3) * 4 + if rem_len == 0 { 0 } else { rem_len + 1 };
    out.reserve(encoded_len);

    // Process 192 input bytes (64 triplets) -> 256 ASCII bytes per stack block
    let mut stack = [0u8; 256];
    let (triplets, rem) = input.as_chunks::<3>();
    for batch in triplets.chunks(64) {
        let mut pos = 0usize;
        for &[b0, b1, b2] in batch {
            stack[pos] = B64URL_ALPHABET[usize::from(b0 >> 2)];
            stack[pos + 1] = B64URL_ALPHABET[usize::from(((b0 & 0x03) << 4) | (b1 >> 4))];
            stack[pos + 2] = B64URL_ALPHABET[usize::from(((b1 & 0x0F) << 2) | (b2 >> 6))];
            stack[pos + 3] = B64URL_ALPHABET[usize::from(b2 & 0x3F)];
            pos += 4;
        }
        if let Ok(s) = std::str::from_utf8(&stack[..pos]) {
            out.push_str(s);
        }
    }
    match rem {
        [b0] => {
            stack[0] = B64URL_ALPHABET[usize::from(b0 >> 2)];
            stack[1] = B64URL_ALPHABET[usize::from((b0 & 0x03) << 4)];
            if let Ok(s) = std::str::from_utf8(&stack[..2]) {
                out.push_str(s);
            }
        }
        [b0, b1] => {
            stack[0] = B64URL_ALPHABET[usize::from(b0 >> 2)];
            stack[1] = B64URL_ALPHABET[usize::from(((b0 & 0x03) << 4) | (b1 >> 4))];
            stack[2] = B64URL_ALPHABET[usize::from((b1 & 0x0F) << 2)];
            if let Ok(s) = std::str::from_utf8(&stack[..3]) {
                out.push_str(s);
            }
        }
        _ => {}
    }
}

/// Encodes bytes using unpadded URL-safe Base64 (RFC 4648 §5).
pub fn base64url_encode(input: &[u8]) -> String {
    let rem_len = input.len() % 3;
    let encoded_len = (input.len() / 3) * 4 + if rem_len == 0 { 0 } else { rem_len + 1 };
    let mut buf = vec![0u8; encoded_len];
    let (triplets, rem) = input.as_chunks::<3>();
    let (out_quads, out_tail) = buf.as_chunks_mut::<4>();
    for (&[b0, b1, b2], dst) in triplets.iter().zip(out_quads.iter_mut()) {
        dst[0] = B64URL_ALPHABET[usize::from(b0 >> 2)];
        dst[1] = B64URL_ALPHABET[usize::from(((b0 & 0x03) << 4) | (b1 >> 4))];
        dst[2] = B64URL_ALPHABET[usize::from(((b1 & 0x0F) << 2) | (b2 >> 6))];
        dst[3] = B64URL_ALPHABET[usize::from(b2 & 0x3F)];
    }
    match (rem, out_tail) {
        ([b0], [d0, d1]) => {
            *d0 = B64URL_ALPHABET[usize::from(b0 >> 2)];
            *d1 = B64URL_ALPHABET[usize::from((b0 & 0x03) << 4)];
        }
        ([b0, b1], [d0, d1, d2]) => {
            *d0 = B64URL_ALPHABET[usize::from(b0 >> 2)];
            *d1 = B64URL_ALPHABET[usize::from(((b0 & 0x03) << 4) | (b1 >> 4))];
            *d2 = B64URL_ALPHABET[usize::from((b1 & 0x0F) << 2)];
        }
        _ => {}
    }
    String::from_utf8(buf).unwrap_or_default()
}

/// Decodes URL-safe (or standard) Base64, tolerating optional `=` padding and whitespace.
pub fn base64url_decode(input: &str) -> Result<Vec<u8>, String> {
    let bytes = input.as_bytes();
    let (chunks, rem) = bytes.as_chunks::<4>();
    let rem_out = match rem.len() {
        0 => 0,
        2 => 1,
        3 => 2,
        _ => 0,
    };
    let fast_len = chunks.len().saturating_mul(3).saturating_add(rem_out);
    let mut out = vec![0u8; fast_len];
    let mut fast_ok = rem.len() != 1;

    if fast_ok {
        let (out_triplets, out_rem) = out.as_chunks_mut::<3>();
        for (&[c0, c1, c2, c3], dst) in chunks.iter().zip(out_triplets.iter_mut()) {
            let v0 = B64_DEC_TABLE[usize::from(c0)];
            let v1 = B64_DEC_TABLE[usize::from(c1)];
            let v2 = B64_DEC_TABLE[usize::from(c2)];
            let v3 = B64_DEC_TABLE[usize::from(c3)];
            if (v0 | v1 | v2 | v3) & 0xC0 != 0 {
                fast_ok = false;
                break;
            }
            dst[0] = (v0 << 2) | (v1 >> 4);
            dst[1] = (v1 << 4) | (v2 >> 2);
            dst[2] = (v2 << 6) | v3;
        }
        if fast_ok {
            match (rem, out_rem) {
                ([], []) => return Ok(out),
                ([b0, b1], [d0]) => {
                    let v0 = B64_DEC_TABLE[usize::from(*b0)];
                    let v1 = B64_DEC_TABLE[usize::from(*b1)];
                    if (v0 | v1) & 0xC0 == 0 {
                        *d0 = (v0 << 2) | (v1 >> 4);
                        return Ok(out);
                    }
                }
                ([b0, b1, b2], [d0, d1]) => {
                    let v0 = B64_DEC_TABLE[usize::from(*b0)];
                    let v1 = B64_DEC_TABLE[usize::from(*b1)];
                    let v2 = B64_DEC_TABLE[usize::from(*b2)];
                    if (v0 | v1 | v2) & 0xC0 == 0 {
                        *d0 = (v0 << 2) | (v1 >> 4);
                        *d1 = (v1 << 4) | (v2 >> 2);
                        return Ok(out);
                    }
                }
                _ => {}
            }
        }
    }

    // Slow path for inputs containing padding `=`, whitespace, or invalid bytes
    let mut vals = Vec::with_capacity(bytes.len());
    for &b in bytes {
        let v = B64_DEC_TABLE[usize::from(b)];
        if v < 64 {
            vals.push(v);
        } else if v == B64_DEC_WS_OR_PAD {
            continue;
        } else {
            return Err(format!("invalid base64url byte 0x{b:02x}"));
        }
    }

    if vals.len() % 4 == 1 {
        return Err("invalid base64url length (mod 4 == 1)".to_owned());
    }

    out.clear();
    let (vchunks, vrem) = vals.as_chunks::<4>();
    for &[v0, v1, v2, v3] in vchunks {
        out.push((v0 << 2) | (v1 >> 4));
        out.push((v1 << 4) | (v2 >> 2));
        out.push((v2 << 6) | v3);
    }
    match vrem {
        [v0, v1] => {
            out.push((v0 << 2) | (v1 >> 4));
        }
        [v0, v1, v2] => {
            out.push((v0 << 2) | (v1 >> 4));
            out.push((v1 << 4) | (v2 >> 2));
        }
        _ => {}
    }
    Ok(out)
}
