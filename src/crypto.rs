//! Pure safe Rust cryptographic primitives (zero-dependency, panic-free):
//! - SHA-256 (FIPS 180-4)
//! - HMAC-SHA256 (RFC 2104)
//! - HKDF-SHA256 (RFC 5869)
//! - PBKDF2-HMAC-SHA256 (RFC 2898)
//! - ChaCha20-Poly1305 AEAD (RFC 8439)
//! - X25519 Elliptic-Curve Diffie-Hellman (RFC 7748)

use std::fmt::Write as _;

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;
pub const TAG_LEN: usize = 16;
pub const PBKDF2_ITERATIONS: u32 = 10_000;

/// Constant-time equality comparison for equal-length byte slices.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/* =========================== SHA-256 (FIPS 180-4) =========================== */

const SHA256_K: [u32; 64] = [
    0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4,
    0xab1c_5ed5, 0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe,
    0x9bdc_06a7, 0xc19b_f174, 0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f,
    0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da, 0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7,
    0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967, 0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc,
    0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85, 0xa2bf_e8a1, 0xa81a_664b,
    0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070, 0x19a4_c116,
    0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
    0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7,
    0xc671_78f2,
];

const SHA256_H0: [u32; 8] = [
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab,
    0x5be0_cd19,
];

#[derive(Clone)]
struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total_bytes: u64,
}

impl Sha256 {
    fn new() -> Self {
        Self {
            state: SHA256_H0,
            buf: [0u8; 64],
            buf_len: 0,
            total_bytes: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(data.len() as u64);
        if self.buf_len > 0 {
            let take = (64 - self.buf_len).min(data.len());
            if let (Some(dst), Some(src)) = (
                self.buf.get_mut(self.buf_len..self.buf_len + take),
                data.get(..take),
            ) {
                dst.copy_from_slice(src);
            }
            self.buf_len += take;
            data = data.get(take..).unwrap_or(&[]);
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
        let (blocks, rem) = data.as_chunks::<64>();
        for block in blocks {
            self.compress(block);
        }
        if !rem.is_empty() {
            if let Some(dst) = self.buf.get_mut(..rem.len()) {
                dst.copy_from_slice(rem);
            }
            self.buf_len = rem.len();
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.total_bytes.wrapping_mul(8);
        self.update(&[0x80]);
        if self.buf_len > 56 {
            let pad = 64 - self.buf_len;
            self.update(&[0u8; 64][..pad]);
        }
        let pad_zero = 56 - self.buf_len;
        if let Some(zeros) = [0u8; 64].get(..pad_zero) {
            self.update(zeros);
        }
        self.update(&bit_len.to_be_bytes());

        let mut out = [0u8; 32];
        for (dst, &word) in out.as_chunks_mut::<4>().0.iter_mut().zip(self.state.iter()) {
            *dst = word.to_be_bytes();
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for (dst, &chunk) in w[..16].iter_mut().zip(block.as_chunks::<4>().0.iter()) {
            *dst = u32::from_be_bytes(chunk);
        }
        for i in 16..64 {
            let w15 = w[i - 15];
            let w2 = w[i - 2];
            let s0 = w15.rotate_right(7) ^ w15.rotate_right(18) ^ (w15 >> 3);
            let s1 = w2.rotate_right(17) ^ w2.rotate_right(19) ^ (w2 >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = self.state[0];
        let mut b = self.state[1];
        let mut c = self.state[2];
        let mut d = self.state[3];
        let mut e = self.state[4];
        let mut f = self.state[5];
        let mut g = self.state[6];
        let mut h = self.state[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize()
}

fn hmac_sha256_states(key: &[u8]) -> (Sha256, Sha256) {
    let mut key_block = [0u8; 64];
    if key.len() > 64 {
        let hashed = sha256(key);
        key_block[..32].copy_from_slice(&hashed);
    } else if let Some(dst) = key_block.get_mut(..key.len()) {
        dst.copy_from_slice(key);
    }

    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(&ipad);
    let mut outer = Sha256::new();
    outer.update(&opad);
    (inner, outer)
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let (mut inner, mut outer) = hmac_sha256_states(key);
    inner.update(data);
    let inner_hash = inner.finalize();
    outer.update(&inner_hash);
    outer.finalize()
}

pub fn hkdf_extract(salt: &[u8], ikm: &[u8]) -> [u8; 32] {
    if salt.is_empty() {
        hmac_sha256(&[0u8; 32], ikm)
    } else {
        hmac_sha256(salt, ikm)
    }
}

pub fn hkdf_expand_32(prk: &[u8; 32], info: &[u8]) -> [u8; 32] {
    if info.len() < 128 {
        let mut stack = [0u8; 128];
        stack[..info.len()].copy_from_slice(info);
        stack[info.len()] = 1u8;
        return hmac_sha256(prk, &stack[..info.len() + 1]);
    }
    let mut input = Vec::with_capacity(info.len() + 1);
    input.extend_from_slice(info);
    input.push(1u8);
    hmac_sha256(prk, &input)
}

pub fn hkdf_sha256_32(salt: &[u8], ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let prk = hkdf_extract(salt, ikm);
    hkdf_expand_32(&prk, info)
}

pub fn pbkdf2_hmac_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let iters = iterations.max(1);
    let (inner_base, outer_base) = hmac_sha256_states(password);

    let mut inner = inner_base.clone();
    inner.update(salt);
    inner.update(&1u32.to_be_bytes());
    let inner_hash = inner.finalize();
    let mut outer = outer_base.clone();
    outer.update(&inner_hash);
    let mut u = outer.finalize();

    let mut out = u;
    for _ in 1..iters {
        let mut inner_it = inner_base.clone();
        inner_it.update(&u);
        let ih = inner_it.finalize();
        let mut outer_it = outer_base.clone();
        outer_it.update(&ih);
        u = outer_it.finalize();
        for (dst, &src) in out.iter_mut().zip(u.iter()) {
            *dst ^= src;
        }
    }
    out
}

/* ==================== Zero-Allocation Stack AAD Builder ==================== */

/// Stack-backed AAD buffer that avoids heap allocations on hot AEAD paths (voice, wire, log),
/// transparently spilling to `Vec<u8>` only if an unusually long identifier exceeds 192 bytes.
pub struct AadBuf {
    stack: [u8; 192],
    len: usize,
    heap: Option<Vec<u8>>,
}

impl Default for AadBuf {
    fn default() -> Self {
        Self::new()
    }
}

impl AadBuf {
    pub fn new() -> Self {
        Self {
            stack: [0u8; 192],
            len: 0,
            heap: None,
        }
    }

    pub fn push_bytes(&mut self, data: &[u8]) {
        if let Some(ref mut v) = self.heap {
            v.extend_from_slice(data);
            return;
        }
        let next = self.len.saturating_add(data.len());
        if next <= self.stack.len() {
            self.stack[self.len..next].copy_from_slice(data);
            self.len = next;
        } else {
            let mut v = Vec::with_capacity(next);
            v.extend_from_slice(&self.stack[..self.len]);
            v.extend_from_slice(data);
            self.heap = Some(v);
        }
    }

    pub fn push_u64_dec(&mut self, mut val: u64) {
        let mut tmp = [0u8; 20];
        let mut idx = 20usize;
        loop {
            idx -= 1;
            tmp[idx] = b'0' + (val % 10) as u8;
            val /= 10;
            if val == 0 {
                break;
            }
        }
        self.push_bytes(&tmp[idx..]);
    }

    pub fn as_slice(&self) -> &[u8] {
        if let Some(ref v) = self.heap {
            v.as_slice()
        } else {
            &self.stack[..self.len]
        }
    }
}

/* ==================== ChaCha20-Poly1305 AEAD (RFC 8439) ==================== */

#[inline(always)]
fn read_le_u32(slice: &[u8], offset: usize) -> u32 {
    let b0 = slice.get(offset).copied().unwrap_or(0);
    let b1 = slice.get(offset + 1).copied().unwrap_or(0);
    let b2 = slice.get(offset + 2).copied().unwrap_or(0);
    let b3 = slice.get(offset + 3).copied().unwrap_or(0);
    u32::from_le_bytes([b0, b1, b2, b3])
}

macro_rules! chacha_qr {
    ($a:ident, $b:ident, $c:ident, $d:ident) => {
        $a = $a.wrapping_add($b);
        $d = ($d ^ $a).rotate_left(16);
        $c = $c.wrapping_add($d);
        $b = ($b ^ $c).rotate_left(12);
        $a = $a.wrapping_add($b);
        $d = ($d ^ $a).rotate_left(8);
        $c = $c.wrapping_add($d);
        $b = ($b ^ $c).rotate_left(7);
    };
}

#[inline(always)]
fn chacha20_initial_state(
    key: &[u8; KEY_LEN],
    counter: u32,
    nonce: &[u8; NONCE_LEN],
) -> [u32; 16] {
    [
        0x6170_7865,
        0x3320_646e,
        0x7962_2d32,
        0x6b20_6574,
        u32::from_le_bytes([key[0], key[1], key[2], key[3]]),
        u32::from_le_bytes([key[4], key[5], key[6], key[7]]),
        u32::from_le_bytes([key[8], key[9], key[10], key[11]]),
        u32::from_le_bytes([key[12], key[13], key[14], key[15]]),
        u32::from_le_bytes([key[16], key[17], key[18], key[19]]),
        u32::from_le_bytes([key[20], key[21], key[22], key[23]]),
        u32::from_le_bytes([key[24], key[25], key[26], key[27]]),
        u32::from_le_bytes([key[28], key[29], key[30], key[31]]),
        counter,
        u32::from_le_bytes([nonce[0], nonce[1], nonce[2], nonce[3]]),
        u32::from_le_bytes([nonce[4], nonce[5], nonce[6], nonce[7]]),
        u32::from_le_bytes([nonce[8], nonce[9], nonce[10], nonce[11]]),
    ]
}

#[inline(always)]
fn chacha20_block_words_from_state(initial: &[u32; 16]) -> [u32; 16] {
    let [
        mut x0,
        mut x1,
        mut x2,
        mut x3,
        mut x4,
        mut x5,
        mut x6,
        mut x7,
        mut x8,
        mut x9,
        mut x10,
        mut x11,
        mut x12,
        mut x13,
        mut x14,
        mut x15,
    ] = *initial;

    for _ in 0..10 {
        chacha_qr!(x0, x4, x8, x12);
        chacha_qr!(x1, x5, x9, x13);
        chacha_qr!(x2, x6, x10, x14);
        chacha_qr!(x3, x7, x11, x15);
        chacha_qr!(x0, x5, x10, x15);
        chacha_qr!(x1, x6, x11, x12);
        chacha_qr!(x2, x7, x8, x13);
        chacha_qr!(x3, x4, x9, x14);
    }

    [
        x0.wrapping_add(initial[0]),
        x1.wrapping_add(initial[1]),
        x2.wrapping_add(initial[2]),
        x3.wrapping_add(initial[3]),
        x4.wrapping_add(initial[4]),
        x5.wrapping_add(initial[5]),
        x6.wrapping_add(initial[6]),
        x7.wrapping_add(initial[7]),
        x8.wrapping_add(initial[8]),
        x9.wrapping_add(initial[9]),
        x10.wrapping_add(initial[10]),
        x11.wrapping_add(initial[11]),
        x12.wrapping_add(initial[12]),
        x13.wrapping_add(initial[13]),
        x14.wrapping_add(initial[14]),
        x15.wrapping_add(initial[15]),
    ]
}

#[inline(always)]
fn words_to_block64(words: &[u32; 16]) -> [u8; 64] {
    let mut out = [0u8; 64];
    for (dst, &w) in out.as_chunks_mut::<4>().0.iter_mut().zip(words.iter()) {
        *dst = w.to_le_bytes();
    }
    out
}

pub fn chacha20_block(key: &[u8; KEY_LEN], counter: u32, nonce: &[u8; NONCE_LEN]) -> [u8; 64] {
    let initial = chacha20_initial_state(key, counter, nonce);
    let words = chacha20_block_words_from_state(&initial);
    words_to_block64(&words)
}

/// Applies ChaCha20 keystream in-place over `buf` using a pre-initialized `state`
/// (advancing `state[12]` by the number of 64-byte blocks consumed).
fn chacha20_xor_in_place_from_state(state: &mut [u32; 16], buf: &mut [u8]) {
    let (chunks, rem) = buf.as_chunks_mut::<64>();
    for chunk in chunks {
        let ks = chacha20_block_words_from_state(state);
        state[12] = state[12].wrapping_add(1);
        for (word_bytes, &kword) in chunk.as_chunks_mut::<4>().0.iter_mut().zip(ks.iter()) {
            let v = u32::from_le_bytes(*word_bytes) ^ kword;
            *word_bytes = v.to_le_bytes();
        }
    }
    if !rem.is_empty() {
        let ks = words_to_block64(&chacha20_block_words_from_state(state));
        state[12] = state[12].wrapping_add(1);
        for (dst, &k) in rem.iter_mut().zip(ks.iter()) {
            *dst ^= k;
        }
    }
}

/// Applies the ChaCha20 keystream in-place over `buf` with zero heap allocation and a single
/// key/nonce word load for the entire message.
pub fn chacha20_xor_in_place(
    key: &[u8; KEY_LEN],
    initial_counter: u32,
    nonce: &[u8; NONCE_LEN],
    buf: &mut [u8],
) {
    let mut state = chacha20_initial_state(key, initial_counter, nonce);
    chacha20_xor_in_place_from_state(&mut state, buf);
}

pub fn chacha20_xor(
    key: &[u8; KEY_LEN],
    initial_counter: u32,
    nonce: &[u8; NONCE_LEN],
    data: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(data);
    chacha20_xor_in_place(key, initial_counter, nonce, &mut out);
    out
}

/// Streaming Poly1305 state (RFC 8439 §2.5) using constant-time 26-bit limbs in native `u64`.
/// Allows authenticating AEAD `aad || pad || ciphertext || pad || lens` with zero heap allocation
/// and register-hoisted inner loops.
struct Poly1305State {
    r0: u64,
    r1: u64,
    r2: u64,
    r3: u64,
    r4: u64,
    s1: u64,
    s2: u64,
    s3: u64,
    s4: u64,
    h0: u64,
    h1: u64,
    h2: u64,
    h3: u64,
    h4: u64,
}

macro_rules! poly1305_step {
    (
        $h0:ident, $h1:ident, $h2:ident, $h3:ident, $h4:ident,
        $r0:ident, $r1:ident, $r2:ident, $r3:ident, $r4:ident,
        $s1:ident, $s2:ident, $s3:ident, $s4:ident,
        $b0:expr, $b1:expr, $b2:expr, $b3:expr, $hibit:expr
    ) => {{
        let w0: u32 = $b0;
        let w1: u32 = $b1;
        let w2: u32 = $b2;
        let w3: u32 = $b3;
        $h0 += u64::from(w0 & 0x03ff_ffff);
        $h1 += u64::from(((w0 >> 26) | (w1 << 6)) & 0x03ff_ffff);
        $h2 += u64::from(((w1 >> 20) | (w2 << 12)) & 0x03ff_ffff);
        $h3 += u64::from(((w2 >> 14) | (w3 << 18)) & 0x03ff_ffff);
        $h4 += u64::from(w3 >> 8) | $hibit;

        let d0 = $h0 * $r0 + $h1 * $s4 + $h2 * $s3 + $h3 * $s2 + $h4 * $s1;
        let mut d1 = $h0 * $r1 + $h1 * $r0 + $h2 * $s4 + $h3 * $s3 + $h4 * $s2;
        let mut d2 = $h0 * $r2 + $h1 * $r1 + $h2 * $r0 + $h3 * $s4 + $h4 * $s3;
        let mut d3 = $h0 * $r3 + $h1 * $r2 + $h2 * $r1 + $h3 * $r0 + $h4 * $s4;
        let mut d4 = $h0 * $r4 + $h1 * $r3 + $h2 * $r2 + $h3 * $r1 + $h4 * $r0;

        let mut c = d0 >> 26;
        $h0 = d0 & 0x03ff_ffff;
        d1 += c;
        c = d1 >> 26;
        $h1 = d1 & 0x03ff_ffff;
        d2 += c;
        c = d2 >> 26;
        $h2 = d2 & 0x03ff_ffff;
        d3 += c;
        c = d3 >> 26;
        $h3 = d3 & 0x03ff_ffff;
        d4 += c;
        c = d4 >> 26;
        $h4 = d4 & 0x03ff_ffff;
        $h0 += c * 5;
        c = $h0 >> 26;
        $h0 &= 0x03ff_ffff;
        $h1 += c;
    }};
}

impl Poly1305State {
    #[inline(always)]
    fn new_from_words(t0: u32, t1: u32, t2: u32, t3: u32) -> Self {
        let r0 = u64::from(t0 & 0x03ff_ffff);
        let r1 = u64::from(((t0 >> 26) | (t1 << 6)) & 0x03ff_ff03);
        let r2 = u64::from(((t1 >> 20) | (t2 << 12)) & 0x03ff_c0ff);
        let r3 = u64::from(((t2 >> 14) | (t3 << 18)) & 0x03f0_3fff);
        let r4 = u64::from((t3 >> 8) & 0x000f_ffff);

        Self {
            r0,
            r1,
            r2,
            r3,
            r4,
            s1: r1 * 5,
            s2: r2 * 5,
            s3: r3 * 5,
            s4: r4 * 5,
            h0: 0,
            h1: 0,
            h2: 0,
            h3: 0,
            h4: 0,
        }
    }

    fn new(otk: &[u8; 32]) -> Self {
        Self::new_from_words(
            read_le_u32(otk, 0),
            read_le_u32(otk, 4),
            read_le_u32(otk, 8),
            read_le_u32(otk, 12),
        )
    }

    #[inline(always)]
    fn feed_block(&mut self, b0: u32, b1: u32, b2: u32, b3: u32, hibit: u64) {
        let (r0, r1, r2, r3, r4) = (self.r0, self.r1, self.r2, self.r3, self.r4);
        let (s1, s2, s3, s4) = (self.s1, self.s2, self.s3, self.s4);
        let (mut h0, mut h1, mut h2, mut h3, mut h4) =
            (self.h0, self.h1, self.h2, self.h3, self.h4);
        poly1305_step!(
            h0, h1, h2, h3, h4, r0, r1, r2, r3, r4, s1, s2, s3, s4, b0, b1, b2, b3, hibit
        );
        self.h0 = h0;
        self.h1 = h1;
        self.h2 = h2;
        self.h3 = h3;
        self.h4 = h4;
    }

    fn update_padded_16(&mut self, data: &[u8]) {
        let (r0, r1, r2, r3, r4) = (self.r0, self.r1, self.r2, self.r3, self.r4);
        let (s1, s2, s3, s4) = (self.s1, self.s2, self.s3, self.s4);
        let (mut h0, mut h1, mut h2, mut h3, mut h4) =
            (self.h0, self.h1, self.h2, self.h3, self.h4);

        let (chunks, rem) = data.as_chunks::<16>();
        for chunk in chunks {
            poly1305_step!(
                h0,
                h1,
                h2,
                h3,
                h4,
                r0,
                r1,
                r2,
                r3,
                r4,
                s1,
                s2,
                s3,
                s4,
                u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]),
                u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]),
                u32::from_le_bytes([chunk[8], chunk[9], chunk[10], chunk[11]]),
                u32::from_le_bytes([chunk[12], chunk[13], chunk[14], chunk[15]]),
                1u64 << 24
            );
        }
        if !rem.is_empty() {
            let mut block = [0u8; 16];
            block[..rem.len()].copy_from_slice(rem);
            poly1305_step!(
                h0,
                h1,
                h2,
                h3,
                h4,
                r0,
                r1,
                r2,
                r3,
                r4,
                s1,
                s2,
                s3,
                s4,
                u32::from_le_bytes([block[0], block[1], block[2], block[3]]),
                u32::from_le_bytes([block[4], block[5], block[6], block[7]]),
                u32::from_le_bytes([block[8], block[9], block[10], block[11]]),
                u32::from_le_bytes([block[12], block[13], block[14], block[15]]),
                1u64 << 24
            );
        }

        self.h0 = h0;
        self.h1 = h1;
        self.h2 = h2;
        self.h3 = h3;
        self.h4 = h4;
    }

    fn finish_with_s_words(self, s0: u32, s1: u32, s2: u32, s3: u32) -> [u8; TAG_LEN] {
        let mut h0 = self.h0;
        let mut h1 = self.h1;
        let mut h2 = self.h2;
        let mut h3 = self.h3;
        let mut h4 = self.h4;

        // Full carry chain
        let mut c = h1 >> 26;
        h1 &= 0x03ff_ffff;
        h2 += c;
        c = h2 >> 26;
        h2 &= 0x03ff_ffff;
        h3 += c;
        c = h3 >> 26;
        h3 &= 0x03ff_ffff;
        h4 += c;
        c = h4 >> 26;
        h4 &= 0x03ff_ffff;
        h0 += c * 5;
        c = h0 >> 26;
        h0 &= 0x03ff_ffff;
        h1 += c;

        // Constant-time conditional subtraction of p = 2^130 - 5
        let mut g0 = h0.wrapping_add(5);
        c = g0 >> 26;
        g0 &= 0x03ff_ffff;
        let mut g1 = h1.wrapping_add(c);
        c = g1 >> 26;
        g1 &= 0x03ff_ffff;
        let mut g2 = h2.wrapping_add(c);
        c = g2 >> 26;
        g2 &= 0x03ff_ffff;
        let mut g3 = h3.wrapping_add(c);
        c = g3 >> 26;
        g3 &= 0x03ff_ffff;
        let g4 = h4.wrapping_add(c).wrapping_sub(1 << 26);

        let mask = (g4 >> 63).wrapping_sub(1);
        g0 &= mask;
        g1 &= mask;
        g2 &= mask;
        g3 &= mask;
        let g4_masked = g4 & mask;
        let nmask = !mask;
        h0 = (h0 & nmask) | g0;
        h1 = (h1 & nmask) | g1;
        h2 = (h2 & nmask) | g2;
        h3 = (h3 & nmask) | g3;
        h4 = (h4 & nmask) | g4_masked;

        // Assemble 128-bit h and add s
        let mut f0 = ((h0) | (h1 << 26)) & 0xffff_ffff;
        let mut f1 = ((h1 >> 6) | (h2 << 20)) & 0xffff_ffff;
        let mut f2 = ((h2 >> 12) | (h3 << 14)) & 0xffff_ffff;
        let mut f3 = ((h3 >> 18) | (h4 << 8)) & 0xffff_ffff;

        f0 += u64::from(s0);
        f1 += u64::from(s1) + (f0 >> 32);
        f2 += u64::from(s2) + (f1 >> 32);
        f3 += u64::from(s3) + (f2 >> 32);

        let mut tag = [0u8; TAG_LEN];
        tag[0..4].copy_from_slice(&(f0 as u32).to_le_bytes());
        tag[4..8].copy_from_slice(&(f1 as u32).to_le_bytes());
        tag[8..12].copy_from_slice(&(f2 as u32).to_le_bytes());
        tag[12..16].copy_from_slice(&(f3 as u32).to_le_bytes());
        tag
    }

    fn finish(self, otk: &[u8; 32]) -> [u8; TAG_LEN] {
        self.finish_with_s_words(
            read_le_u32(otk, 16),
            read_le_u32(otk, 20),
            read_le_u32(otk, 24),
            read_le_u32(otk, 28),
        )
    }
}

/// Poly1305 one-time MAC (RFC 8439 §2.5), constant-time 26-bit limb arithmetic in native `u64`.
pub fn poly1305_mac(otk: &[u8; 32], msg: &[u8]) -> [u8; TAG_LEN] {
    let mut state = Poly1305State::new(otk);
    let (r0, r1, r2, r3, r4) = (state.r0, state.r1, state.r2, state.r3, state.r4);
    let (s1, s2, s3, s4) = (state.s1, state.s2, state.s3, state.s4);
    let (mut h0, mut h1, mut h2, mut h3, mut h4) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let (chunks, rem) = msg.as_chunks::<16>();
    for chunk in chunks {
        poly1305_step!(
            h0,
            h1,
            h2,
            h3,
            h4,
            r0,
            r1,
            r2,
            r3,
            r4,
            s1,
            s2,
            s3,
            s4,
            u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]),
            u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]),
            u32::from_le_bytes([chunk[8], chunk[9], chunk[10], chunk[11]]),
            u32::from_le_bytes([chunk[12], chunk[13], chunk[14], chunk[15]]),
            1u64 << 24
        );
    }
    state.h0 = h0;
    state.h1 = h1;
    state.h2 = h2;
    state.h3 = h3;
    state.h4 = h4;
    if !rem.is_empty() {
        let mut block = [0u8; 17];
        block[..rem.len()].copy_from_slice(rem);
        block[rem.len()] = 1u8;
        state.feed_block(
            u32::from_le_bytes([block[0], block[1], block[2], block[3]]),
            u32::from_le_bytes([block[4], block[5], block[6], block[7]]),
            u32::from_le_bytes([block[8], block[9], block[10], block[11]]),
            u32::from_le_bytes([block[12], block[13], block[14], block[15]]),
            u64::from(block[16]) << 24,
        );
    }
    state.finish(otk)
}

/// Seals `plaintext` using L1-cache-tiled RFC 8439 ChaCha20-Poly1305 AEAD directly into `out`.
/// Processes 4 KB tiles (a multiple of both 64-byte ChaCha20 and 16-byte Poly1305 blocks) so each
/// ciphertext tile stays hot in L1 cache between encryption and MAC while keeping ChaCha20 and
/// Poly1305 loops separate for zero register spill.
pub fn aead_seal_into(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
    out: &mut Vec<u8>,
) {
    let mut cc_state = chacha20_initial_state(key, 0, nonce);
    let otk_words = chacha20_block_words_from_state(&cc_state);
    cc_state[12] = 1;

    let mut poly = Poly1305State::new_from_words(
        otk_words[0],
        otk_words[1],
        otk_words[2],
        otk_words[3],
    );
    poly.update_padded_16(aad);

    out.reserve(plaintext.len().saturating_add(TAG_LEN));
    let start = out.len();
    out.extend_from_slice(plaintext);

    // 4096 bytes = 64 ChaCha20 blocks = 256 Poly1305 blocks (exact block-aligned L1 tile)
    for tile in out[start..].chunks_mut(4096) {
        chacha20_xor_in_place_from_state(&mut cc_state, tile);
        poly.update_padded_16(tile);
    }

    let aad_len = aad.len() as u64;
    let ct_len = plaintext.len() as u64;
    poly.feed_block(
        aad_len as u32,
        (aad_len >> 32) as u32,
        ct_len as u32,
        (ct_len >> 32) as u32,
        1u64 << 24,
    );

    let tag = poly.finish_with_s_words(otk_words[4], otk_words[5], otk_words[6], otk_words[7]);
    out.extend_from_slice(&tag);
}

/// Seals `plaintext` using RFC 8439 ChaCha20-Poly1305 AEAD. Returns `ciphertext || tag`.
pub fn aead_seal(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(plaintext.len().saturating_add(TAG_LEN));
    aead_seal_into(key, nonce, aad, plaintext, &mut out);
    out
}

/// Authenticates and decrypts `ciphertext || tag` using RFC 8439 ChaCha20-Poly1305 AEAD,
/// appending plaintext directly into `out` (left unmodified on auth failure).
pub fn aead_open_into(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    ciphertext_and_tag: &[u8],
    out: &mut Vec<u8>,
) -> Result<(), String> {
    if ciphertext_and_tag.len() < TAG_LEN {
        return Err("AEAD ciphertext shorter than 16-byte authentication tag".to_owned());
    }
    let split = ciphertext_and_tag.len() - TAG_LEN;
    let ciphertext = ciphertext_and_tag
        .get(..split)
        .ok_or_else(|| "AEAD ciphertext slice out of bounds".to_owned())?;
    let provided_tag = ciphertext_and_tag
        .get(split..)
        .ok_or_else(|| "AEAD tag slice out of bounds".to_owned())?;

    let mut cc_state = chacha20_initial_state(key, 0, nonce);
    let otk_words = chacha20_block_words_from_state(&cc_state);
    cc_state[12] = 1;

    let mut poly = Poly1305State::new_from_words(
        otk_words[0],
        otk_words[1],
        otk_words[2],
        otk_words[3],
    );
    poly.update_padded_16(aad);
    poly.update_padded_16(ciphertext);
    let aad_len = aad.len() as u64;
    let ct_len = ciphertext.len() as u64;
    poly.feed_block(
        aad_len as u32,
        (aad_len >> 32) as u32,
        ct_len as u32,
        (ct_len >> 32) as u32,
        1u64 << 24,
    );
    let expected_tag =
        poly.finish_with_s_words(otk_words[4], otk_words[5], otk_words[6], otk_words[7]);
    if !ct_eq(&expected_tag, provided_tag) {
        return Err("AEAD authentication failed (wrong key or tampered ciphertext)".to_owned());
    }

    let start = out.len();
    out.reserve(ciphertext.len());
    out.extend_from_slice(ciphertext);
    chacha20_xor_in_place_from_state(&mut cc_state, &mut out[start..]);
    Ok(())
}

/// Authenticates and decrypts `ciphertext || tag` using RFC 8439 ChaCha20-Poly1305 AEAD.
pub fn aead_open(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    ciphertext_and_tag: &[u8],
) -> Result<Vec<u8>, String> {
    let cap = ciphertext_and_tag.len().saturating_sub(TAG_LEN);
    let mut out = Vec::with_capacity(cap);
    aead_open_into(key, nonce, aad, ciphertext_and_tag, &mut out)?;
    Ok(out)
}

/* ==================== X25519 Curve25519 ECDH (RFC 7748) ==================== */

const MASK51: u64 = (1u64 << 51) - 1;
const X25519_BASEPOINT: [u8; 32] = [
    9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0,
];

#[derive(Clone, Copy)]
struct Fe([u64; 5]);

impl Fe {
    const ZERO: Self = Self([0, 0, 0, 0, 0]);
    const ONE: Self = Self([1, 0, 0, 0, 0]);

    fn from_bytes(bytes: &[u8; 32]) -> Self {
        let load8 = |off: usize| -> u64 {
            u64::from_le_bytes([
                bytes.get(off).copied().unwrap_or(0),
                bytes.get(off + 1).copied().unwrap_or(0),
                bytes.get(off + 2).copied().unwrap_or(0),
                bytes.get(off + 3).copied().unwrap_or(0),
                bytes.get(off + 4).copied().unwrap_or(0),
                bytes.get(off + 5).copied().unwrap_or(0),
                bytes.get(off + 6).copied().unwrap_or(0),
                bytes.get(off + 7).copied().unwrap_or(0),
            ])
        };
        let l0 = load8(0) & MASK51;
        let l1 = (load8(6) >> 3) & MASK51;
        let l2 = (load8(12) >> 6) & MASK51;
        let l3 = (load8(19) >> 1) & MASK51;
        let l4 = (load8(24) >> 12) & MASK51;
        Self([l0, l1, l2, l3, l4])
    }

    fn reduce(mut l: [u64; 5]) -> Self {
        let c0 = l[0] >> 51;
        l[0] &= MASK51;
        l[1] += c0;
        let c1 = l[1] >> 51;
        l[1] &= MASK51;
        l[2] += c1;
        let c2 = l[2] >> 51;
        l[2] &= MASK51;
        l[3] += c2;
        let c3 = l[3] >> 51;
        l[3] &= MASK51;
        l[4] += c3;
        let c4 = l[4] >> 51;
        l[4] &= MASK51;
        l[0] += c4 * 19;
        let c0b = l[0] >> 51;
        l[0] &= MASK51;
        l[1] += c0b;
        Self(l)
    }

    fn to_bytes(self) -> [u8; 32] {
        let mut t = Self::reduce(self.0).0;

        // Constant-time canonical reduction modulo p = 2^255 - 19
        let mut q = (t[0] + 19) >> 51;
        q = (t[1] + q) >> 51;
        q = (t[2] + q) >> 51;
        q = (t[3] + q) >> 51;
        q = (t[4] + q) >> 51;

        t[0] += 19 * q;
        let mut c = t[0] >> 51;
        t[0] &= MASK51;
        t[1] += c;
        c = t[1] >> 51;
        t[1] &= MASK51;
        t[2] += c;
        c = t[2] >> 51;
        t[2] &= MASK51;
        t[3] += c;
        c = t[3] >> 51;
        t[3] &= MASK51;
        t[4] += c;
        t[4] &= MASK51;

        let mut out = [0u8; 32];
        let w0 = t[0] | (t[1] << 51);
        let w1 = (t[1] >> 13) | (t[2] << 38);
        let w2 = (t[2] >> 26) | (t[3] << 25);
        let w3 = (t[3] >> 39) | (t[4] << 12);
        out[0..8].copy_from_slice(&w0.to_le_bytes());
        out[8..16].copy_from_slice(&w1.to_le_bytes());
        out[16..24].copy_from_slice(&w2.to_le_bytes());
        out[24..32].copy_from_slice(&w3.to_le_bytes());
        out
    }

    fn add(self, rhs: Self) -> Self {
        Self([
            self.0[0] + rhs.0[0],
            self.0[1] + rhs.0[1],
            self.0[2] + rhs.0[2],
            self.0[3] + rhs.0[3],
            self.0[4] + rhs.0[4],
        ])
    }

    fn sub(self, rhs: Self) -> Self {
        // Add 4*p bias to prevent underflow even on unreduced limbs
        const P0_4: u64 = 4 * ((1u64 << 51) - 19);
        const P_4: u64 = 4 * ((1u64 << 51) - 1);
        Self::reduce([
            (self.0[0] + P0_4) - rhs.0[0],
            (self.0[1] + P_4) - rhs.0[1],
            (self.0[2] + P_4) - rhs.0[2],
            (self.0[3] + P_4) - rhs.0[3],
            (self.0[4] + P_4) - rhs.0[4],
        ])
    }

    fn mul(self, rhs: Self) -> Self {
        let a = self.0;
        let b = rhs.0;

        let b1_19 = u128::from(b[1]) * 19;
        let b2_19 = u128::from(b[2]) * 19;
        let b3_19 = u128::from(b[3]) * 19;
        let b4_19 = u128::from(b[4]) * 19;

        let t0 = u128::from(a[0]) * u128::from(b[0])
            + u128::from(a[1]) * b4_19
            + u128::from(a[2]) * b3_19
            + u128::from(a[3]) * b2_19
            + u128::from(a[4]) * b1_19;
        let mut t1 = u128::from(a[0]) * u128::from(b[1])
            + u128::from(a[1]) * u128::from(b[0])
            + u128::from(a[2]) * b4_19
            + u128::from(a[3]) * b3_19
            + u128::from(a[4]) * b2_19;
        let mut t2 = u128::from(a[0]) * u128::from(b[2])
            + u128::from(a[1]) * u128::from(b[1])
            + u128::from(a[2]) * u128::from(b[0])
            + u128::from(a[3]) * b4_19
            + u128::from(a[4]) * b3_19;
        let mut t3 = u128::from(a[0]) * u128::from(b[3])
            + u128::from(a[1]) * u128::from(b[2])
            + u128::from(a[2]) * u128::from(b[1])
            + u128::from(a[3]) * u128::from(b[0])
            + u128::from(a[4]) * b4_19;
        let mut t4 = u128::from(a[0]) * u128::from(b[4])
            + u128::from(a[1]) * u128::from(b[3])
            + u128::from(a[2]) * u128::from(b[2])
            + u128::from(a[3]) * u128::from(b[1])
            + u128::from(a[4]) * u128::from(b[0]);

        let mut r0 = (t0 as u64) & MASK51;
        t1 += t0 >> 51;
        let mut r1 = (t1 as u64) & MASK51;
        t2 += t1 >> 51;
        let r2 = (t2 as u64) & MASK51;
        t3 += t2 >> 51;
        let r3 = (t3 as u64) & MASK51;
        t4 += t3 >> 51;
        let r4 = (t4 as u64) & MASK51;

        let carry = (t4 >> 51) as u64;
        r0 += carry * 19;
        r1 += r0 >> 51;
        r0 &= MASK51;

        Self([r0, r1, r2, r3, r4])
    }

    fn sq(self) -> Self {
        let a = self.0;
        let a0 = u128::from(a[0]);
        let a1 = u128::from(a[1]);
        let a2 = u128::from(a[2]);
        let a3 = u128::from(a[3]);
        let a4 = u128::from(a[4]);

        let a0_2 = a0 * 2;
        let a1_2 = a1 * 2;
        let a3_19 = a3 * 19;
        let a4_19 = a4 * 19;

        let t0 = a0 * a0 + a1_2 * a4_19 + (a2 * 2) * a3_19;
        let mut t1 = a0_2 * a1 + (a2 * 2) * a4_19 + a3 * a3_19;
        let mut t2 = a0_2 * a2 + a1 * a1 + (a3 * 2) * a4_19;
        let mut t3 = a0_2 * a3 + a1_2 * a2 + a4 * a4_19;
        let mut t4 = a0_2 * a4 + a1_2 * a3 + a2 * a2;

        let mut r0 = (t0 as u64) & MASK51;
        t1 += t0 >> 51;
        let mut r1 = (t1 as u64) & MASK51;
        t2 += t1 >> 51;
        let r2 = (t2 as u64) & MASK51;
        t3 += t2 >> 51;
        let r3 = (t3 as u64) & MASK51;
        t4 += t3 >> 51;
        let r4 = (t4 as u64) & MASK51;

        let carry = (t4 >> 51) as u64;
        r0 += carry * 19;
        r1 += r0 >> 51;
        r0 &= MASK51;

        Self([r0, r1, r2, r3, r4])
    }

    fn pow2k(mut self, k: u32) -> Self {
        for _ in 0..k {
            self = self.sq();
        }
        self
    }

    fn mul_a24(self) -> Self {
        const A24: u128 = 121_665;
        let t0 = u128::from(self.0[0]) * A24;
        let mut t1 = u128::from(self.0[1]) * A24;
        let mut t2 = u128::from(self.0[2]) * A24;
        let mut t3 = u128::from(self.0[3]) * A24;
        let mut t4 = u128::from(self.0[4]) * A24;

        let mut r0 = (t0 as u64) & MASK51;
        t1 += t0 >> 51;
        let mut r1 = (t1 as u64) & MASK51;
        t2 += t1 >> 51;
        let r2 = (t2 as u64) & MASK51;
        t3 += t2 >> 51;
        let r3 = (t3 as u64) & MASK51;
        t4 += t3 >> 51;
        let r4 = (t4 as u64) & MASK51;

        let carry = (t4 >> 51) as u64;
        r0 += carry * 19;
        r1 += r0 >> 51;
        r0 &= MASK51;

        Self([r0, r1, r2, r3, r4])
    }

    /// Computes multiplicative inverse `self^(2^255 - 21) mod p` via standard addition chain.
    fn invert(self) -> Self {
        let z2 = self.sq();
        let z9 = z2.pow2k(2).mul(self);
        let z11 = z9.mul(z2);
        let z2_5_0 = z11.sq().mul(z9);
        let z2_10_0 = z2_5_0.pow2k(5).mul(z2_5_0);
        let z2_20_0 = z2_10_0.pow2k(10).mul(z2_10_0);
        let z2_40_0 = z2_20_0.pow2k(20).mul(z2_20_0);
        let z2_50_0 = z2_40_0.pow2k(10).mul(z2_10_0);
        let z2_100_0 = z2_50_0.pow2k(50).mul(z2_50_0);
        let z2_200_0 = z2_100_0.pow2k(100).mul(z2_100_0);
        let z2_250_0 = z2_200_0.pow2k(50).mul(z2_50_0);
        z2_250_0.pow2k(5).mul(z11)
    }
}

fn cswap(swap: u64, a: &mut Fe, b: &mut Fe) {
    let mask = 0u64.wrapping_sub(swap & 1);
    for i in 0..5 {
        let diff = mask & (a.0[i] ^ b.0[i]);
        a.0[i] ^= diff;
        b.0[i] ^= diff;
    }
}

/// Computes the X25519 scalar multiplication function per RFC 7748 §5.
pub fn x25519(scalar: &[u8; 32], u_coord: &[u8; 32]) -> [u8; 32] {
    let mut k = *scalar;
    k[0] &= 248;
    k[31] &= 127;
    k[31] |= 64;

    let mut u_bytes = *u_coord;
    u_bytes[31] &= 127;

    let x_1 = Fe::from_bytes(&u_bytes);
    let mut x_2 = Fe::ONE;
    let mut z_2 = Fe::ZERO;
    let mut x_3 = x_1;
    let mut z_3 = Fe::ONE;
    let mut swap: u64 = 0;

    for t in (0..255).rev() {
        let k_t = u64::from((k[t >> 3] >> (t & 7)) & 1);
        swap ^= k_t;
        cswap(swap, &mut x_2, &mut x_3);
        cswap(swap, &mut z_2, &mut z_3);
        swap = k_t;

        let a = x_2.add(z_2);
        let aa = a.sq();
        let b = x_2.sub(z_2);
        let bb = b.sq();
        let e = aa.sub(bb);
        let c = x_3.add(z_3);
        let d = x_3.sub(z_3);
        let da = d.mul(a);
        let cb = c.mul(b);
        x_3 = da.add(cb).sq();
        z_3 = x_1.mul(da.sub(cb).sq());
        x_2 = aa.mul(bb);
        z_2 = e.mul(aa.add(e.mul_a24()));
    }

    cswap(swap, &mut x_2, &mut x_3);
    cswap(swap, &mut z_2, &mut z_3);

    x_2.mul(z_2.invert()).to_bytes()
}

pub fn x25519_public_key(secret: &[u8; 32]) -> [u8; 32] {
    x25519(secret, &X25519_BASEPOINT)
}

/// Computes an X25519 shared secret and rejects all-zero low-order points per RFC 7748 §6.1.
pub fn x25519_shared_secret(secret: &[u8; 32], peer_public: &[u8; 32]) -> Result<[u8; 32], String> {
    let shared = x25519(secret, peer_public);
    if ct_eq(&shared, &[0u8; 32]) {
        return Err("rejected low-order X25519 public key (all-zero shared secret)".to_owned());
    }
    Ok(shared)
}

/* ==================== Deterministic / Entropy-Seeded CSPRNG ==================== */

/// SHA-256 CTR-DRBG seeded from browser `crypto.getRandomValues` entropy (or deterministic test seed).
#[derive(Debug, Clone)]
pub struct SafeCsprng {
    state: [u8; 32],
    counter: u64,
}

impl SafeCsprng {
    pub fn from_seed(seed: &[u8]) -> Self {
        let initial = hkdf_sha256_32(b"p2p-direct-csprng-v1", seed, b"seed");
        Self {
            state: initial,
            counter: 0,
        }
    }

    pub fn reseed(&mut self, extra_entropy: &[u8]) {
        if extra_entropy.is_empty() {
            return;
        }
        let mut combined = Vec::with_capacity(32 + extra_entropy.len());
        combined.extend_from_slice(&self.state);
        combined.extend_from_slice(extra_entropy);
        self.state = hkdf_sha256_32(b"p2p-direct-csprng-v1", &combined, b"reseed");
    }

    pub fn next_bytes_32(&mut self) -> [u8; 32] {
        self.counter = self.counter.wrapping_add(1);
        let mut msg = [0u8; 40];
        msg[..32].copy_from_slice(&self.state);
        msg[32..40].copy_from_slice(&self.counter.to_le_bytes());
        let out = sha256(&msg);
        // Forward-secure state ratchet
        self.state = hkdf_expand_32(&self.state, &self.counter.to_le_bytes());
        out
    }

    pub fn next_nonce(&mut self) -> [u8; NONCE_LEN] {
        let block = self.next_bytes_32();
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&block[..NONCE_LEN]);
        nonce
    }
}

/* ==================== Mesh Key Derivation & Fingerprints ==================== */

pub fn derive_mesh_key_from_passphrase(passphrase: &str) -> [u8; KEY_LEN] {
    pbkdf2_hmac_sha256(
        passphrase.as_bytes(),
        b"p2p-direct-e2ee-passphrase-v1",
        PBKDF2_ITERATIONS,
    )
}

pub fn derive_invite_wrap_key(mesh_key: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    hkdf_sha256_32(b"p2p-direct-v1", mesh_key, b"invite-wrap")
}

pub fn derive_log_key(mesh_key: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    hkdf_sha256_32(b"p2p-direct-v1", mesh_key, b"replicated-log-aead")
}

/// Derives an opaque 32-hex-char rendezvous topic unlinkable to the mesh key or room name.
pub fn derive_room_topic(mesh_key: &[u8; KEY_LEN]) -> String {
    let digest = hkdf_sha256_32(
        b"p2p-direct-room-v1",
        mesh_key,
        b"room-rendezvous-topic",
    );
    let mut out = String::with_capacity(32);
    for &b in &digest[..16] {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Derives a dedicated 256-bit ChaCha20-Poly1305 key for encrypting room rendezvous signaling.
pub fn derive_room_signal_key(mesh_key: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    hkdf_sha256_32(
        b"p2p-direct-room-v1",
        mesh_key,
        b"room-rendezvous-aead",
    )
}

/// Derives both wire `(tx, rx)` and voice `(voice_tx, voice_rx)` directional ChaCha20-Poly1305
/// session keys from a single X25519 ECDH scalar multiplication + mesh key.
#[allow(clippy::type_complexity)]
pub fn derive_all_link_keys(
    my_secret: &[u8; KEY_LEN],
    peer_public: &[u8; KEY_LEN],
    mesh_key: &[u8; KEY_LEN],
    my_peer_id: &str,
    other_peer_id: &str,
) -> Result<(([u8; KEY_LEN], [u8; KEY_LEN]), ([u8; KEY_LEN], [u8; KEY_LEN])), String> {
    let ecdh = x25519_shared_secret(my_secret, peer_public)?;
    let mut ikm = [0u8; 64];
    ikm[..32].copy_from_slice(&ecdh);
    ikm[32..64].copy_from_slice(mesh_key);

    let link_prk = hkdf_extract(b"p2p-direct-link-v1", &ikm);
    let mut info = AadBuf::new();
    info.push_bytes(b"link|");
    info.push_bytes(my_peer_id.as_bytes());
    info.push_bytes(b"->");
    info.push_bytes(other_peer_id.as_bytes());
    let tx_key = hkdf_expand_32(&link_prk, info.as_slice());

    let mut rx_info = AadBuf::new();
    rx_info.push_bytes(b"link|");
    rx_info.push_bytes(other_peer_id.as_bytes());
    rx_info.push_bytes(b"->");
    rx_info.push_bytes(my_peer_id.as_bytes());
    let rx_key = hkdf_expand_32(&link_prk, rx_info.as_slice());

    let voice_prk = hkdf_extract(b"p2p-direct-voice-v1", &ikm);
    let mut vtx_info = AadBuf::new();
    vtx_info.push_bytes(b"voice|");
    vtx_info.push_bytes(my_peer_id.as_bytes());
    vtx_info.push_bytes(b"->");
    vtx_info.push_bytes(other_peer_id.as_bytes());
    let voice_tx_key = hkdf_expand_32(&voice_prk, vtx_info.as_slice());

    let mut vrx_info = AadBuf::new();
    vrx_info.push_bytes(b"voice|");
    vrx_info.push_bytes(other_peer_id.as_bytes());
    vrx_info.push_bytes(b"->");
    vrx_info.push_bytes(my_peer_id.as_bytes());
    let voice_rx_key = hkdf_expand_32(&voice_prk, vrx_info.as_slice());

    Ok(((tx_key, rx_key), (voice_tx_key, voice_rx_key)))
}

/// Derives directional (tx, rx) ChaCha20-Poly1305 session keys from X25519 ECDH + mesh key.
pub fn derive_link_keys(
    my_secret: &[u8; KEY_LEN],
    peer_public: &[u8; KEY_LEN],
    mesh_key: &[u8; KEY_LEN],
    my_peer_id: &str,
    other_peer_id: &str,
) -> Result<([u8; KEY_LEN], [u8; KEY_LEN]), String> {
    let ecdh = x25519_shared_secret(my_secret, peer_public)?;
    let mut ikm = [0u8; 64];
    ikm[..32].copy_from_slice(&ecdh);
    ikm[32..64].copy_from_slice(mesh_key);

    let prk = hkdf_extract(b"p2p-direct-link-v1", &ikm);

    let mut tx_info = AadBuf::new();
    tx_info.push_bytes(b"link|");
    tx_info.push_bytes(my_peer_id.as_bytes());
    tx_info.push_bytes(b"->");
    tx_info.push_bytes(other_peer_id.as_bytes());
    let mut rx_info = AadBuf::new();
    rx_info.push_bytes(b"link|");
    rx_info.push_bytes(other_peer_id.as_bytes());
    rx_info.push_bytes(b"->");
    rx_info.push_bytes(my_peer_id.as_bytes());
    let tx_key = hkdf_expand_32(&prk, tx_info.as_slice());
    let rx_key = hkdf_expand_32(&prk, rx_info.as_slice());
    Ok((tx_key, rx_key))
}

/// Derives directional (tx, rx) ChaCha20-Poly1305 voice keys from X25519 ECDH + mesh key.
pub fn derive_voice_link_keys(
    my_secret: &[u8; KEY_LEN],
    peer_public: &[u8; KEY_LEN],
    mesh_key: &[u8; KEY_LEN],
    my_peer_id: &str,
    other_peer_id: &str,
) -> Result<([u8; KEY_LEN], [u8; KEY_LEN]), String> {
    let ecdh = x25519_shared_secret(my_secret, peer_public)?;
    let mut ikm = [0u8; 64];
    ikm[..32].copy_from_slice(&ecdh);
    ikm[32..64].copy_from_slice(mesh_key);

    let prk = hkdf_extract(b"p2p-direct-voice-v1", &ikm);

    let mut tx_info = AadBuf::new();
    tx_info.push_bytes(b"voice|");
    tx_info.push_bytes(my_peer_id.as_bytes());
    tx_info.push_bytes(b"->");
    tx_info.push_bytes(other_peer_id.as_bytes());
    let mut rx_info = AadBuf::new();
    rx_info.push_bytes(b"voice|");
    rx_info.push_bytes(other_peer_id.as_bytes());
    rx_info.push_bytes(b"->");
    rx_info.push_bytes(my_peer_id.as_bytes());
    let tx_key = hkdf_expand_32(&prk, tx_info.as_slice());
    let rx_key = hkdf_expand_32(&prk, rx_info.as_slice());
    Ok((tx_key, rx_key))
}

/// Derives an end-to-end key for relayed SDP/ICE signaling opaque to intermediate relay peers.
pub fn derive_relay_signal_key(
    my_secret: &[u8; KEY_LEN],
    target_public: &[u8; KEY_LEN],
    mesh_key: &[u8; KEY_LEN],
    sender_id: &str,
    receiver_id: &str,
) -> Result<[u8; KEY_LEN], String> {
    let ecdh = x25519_shared_secret(my_secret, target_public)?;
    let mut ikm = [0u8; 64];
    ikm[..32].copy_from_slice(&ecdh);
    ikm[32..64].copy_from_slice(mesh_key);
    let info = format!("relay|{sender_id}->{receiver_id}");
    Ok(hkdf_sha256_32(b"p2p-direct-relay-v1", &ikm, info.as_bytes()))
}

pub fn key_fingerprint(mesh_key: &[u8; KEY_LEN]) -> String {
    let digest = hkdf_sha256_32(b"p2p-direct-fp-v1", mesh_key, b"mesh-key-fingerprint");
    format_grouped_hex(&digest[..8])
}

/// Computes a symmetric safety number identical on both endpoints of an X25519 peer link.
pub fn pair_safety_code(
    pub_a: &[u8; KEY_LEN],
    pub_b: &[u8; KEY_LEN],
    mesh_key: &[u8; KEY_LEN],
) -> String {
    let (first, second) = if pub_a <= pub_b {
        (pub_a, pub_b)
    } else {
        (pub_b, pub_a)
    };
    let mut material = [0u8; 96];
    material[0..32].copy_from_slice(first);
    material[32..64].copy_from_slice(second);
    material[64..96].copy_from_slice(mesh_key);
    let digest = sha256(&material);
    format_grouped_hex(&digest[..6])
}

fn format_grouped_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2 + 4);
    for (i, &b) in bytes.iter().enumerate() {
        if i > 0 && i % 2 == 0 {
            out.push('-');
        }
        let _ = write!(out, "{b:02X}");
    }
    out
}

pub fn parse_fixed_32(bytes: &[u8], label: &str) -> Result<[u8; 32], String> {
    if bytes.len() != 32 {
        return Err(format!(
            "expected 32 bytes for {label}, got {}",
            bytes.len()
        ));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(bytes);
    Ok(arr)
}

pub fn parse_fixed_12(bytes: &[u8], label: &str) -> Result<[u8; 12], String> {
    if bytes.len() != 12 {
        return Err(format!(
            "expected 12 bytes for {label}, got {}",
            bytes.len()
        ));
    }
    let mut arr = [0u8; 12];
    arr.copy_from_slice(bytes);
    Ok(arr)
}
