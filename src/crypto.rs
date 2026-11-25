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
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            if let Some(src) = data.get(..64) {
                block.copy_from_slice(src);
            }
            self.compress(&block);
            data = data.get(64..).unwrap_or(&[]);
        }
        if !data.is_empty() {
            if let Some(dst) = self.buf.get_mut(..data.len()) {
                dst.copy_from_slice(data);
            }
            self.buf_len = data.len();
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
        for (i, &word) in self.state.iter().enumerate() {
            let be = word.to_be_bytes();
            if let Some(dst) = out.get_mut(i * 4..i * 4 + 4) {
                dst.copy_from_slice(&be);
            }
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            let b0 = block.get(i * 4).copied().unwrap_or(0);
            let b1 = block.get(i * 4 + 1).copied().unwrap_or(0);
            let b2 = block.get(i * 4 + 2).copied().unwrap_or(0);
            let b3 = block.get(i * 4 + 3).copied().unwrap_or(0);
            if let Some(slot) = w.get_mut(i) {
                *slot = u32::from_be_bytes([b0, b1, b2, b3]);
            }
        }
        for i in 16..64 {
            let w15 = w.get(i - 15).copied().unwrap_or(0);
            let w2 = w.get(i - 2).copied().unwrap_or(0);
            let w16 = w.get(i - 16).copied().unwrap_or(0);
            let w7 = w.get(i - 7).copied().unwrap_or(0);
            let s0 = w15.rotate_right(7) ^ w15.rotate_right(18) ^ (w15 >> 3);
            let s1 = w2.rotate_right(17) ^ w2.rotate_right(19) ^ (w2 >> 10);
            if let Some(slot) = w.get_mut(i) {
                *slot = w16.wrapping_add(s0).wrapping_add(w7).wrapping_add(s1);
            }
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
            let ki = SHA256_K.get(i).copied().unwrap_or(0);
            let wi = w.get(i).copied().unwrap_or(0);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(ki)
                .wrapping_add(wi);
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

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
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
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(&opad);
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
    let mut salt_block = Vec::with_capacity(salt.len() + 4);
    salt_block.extend_from_slice(salt);
    salt_block.extend_from_slice(&1u32.to_be_bytes());

    let mut u = hmac_sha256(password, &salt_block);
    let mut out = u;
    for _ in 1..iters {
        u = hmac_sha256(password, &u);
        for (dst, &src) in out.iter_mut().zip(u.iter()) {
            *dst ^= src;
        }
    }
    out
}

/* ==================== ChaCha20-Poly1305 AEAD (RFC 8439) ==================== */

fn read_le_u32(slice: &[u8], offset: usize) -> u32 {
    let b0 = slice.get(offset).copied().unwrap_or(0);
    let b1 = slice.get(offset + 1).copied().unwrap_or(0);
    let b2 = slice.get(offset + 2).copied().unwrap_or(0);
    let b3 = slice.get(offset + 3).copied().unwrap_or(0);
    u32::from_le_bytes([b0, b1, b2, b3])
}

fn quarter_round(state: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize) {
    state[a] = state[a].wrapping_add(state[b]);
    state[d] ^= state[a];
    state[d] = state[d].rotate_left(16);

    state[c] = state[c].wrapping_add(state[d]);
    state[b] ^= state[c];
    state[b] = state[b].rotate_left(12);

    state[a] = state[a].wrapping_add(state[b]);
    state[d] ^= state[a];
    state[d] = state[d].rotate_left(8);

    state[c] = state[c].wrapping_add(state[d]);
    state[b] ^= state[c];
    state[b] = state[b].rotate_left(7);
}

pub fn chacha20_block(key: &[u8; KEY_LEN], counter: u32, nonce: &[u8; NONCE_LEN]) -> [u8; 64] {
    let initial = [
        0x6170_7865,
        0x3320_646e,
        0x7962_2d32,
        0x6b20_6574,
        read_le_u32(key, 0),
        read_le_u32(key, 4),
        read_le_u32(key, 8),
        read_le_u32(key, 12),
        read_le_u32(key, 16),
        read_le_u32(key, 20),
        read_le_u32(key, 24),
        read_le_u32(key, 28),
        counter,
        read_le_u32(nonce, 0),
        read_le_u32(nonce, 4),
        read_le_u32(nonce, 8),
    ];

    let mut working = initial;
    for _ in 0..10 {
        quarter_round(&mut working, 0, 4, 8, 12);
        quarter_round(&mut working, 1, 5, 9, 13);
        quarter_round(&mut working, 2, 6, 10, 14);
        quarter_round(&mut working, 3, 7, 11, 15);
        quarter_round(&mut working, 0, 5, 10, 15);
        quarter_round(&mut working, 1, 6, 11, 12);
        quarter_round(&mut working, 2, 7, 8, 13);
        quarter_round(&mut working, 3, 4, 9, 14);
    }

    let mut out = [0u8; 64];
    for i in 0..16 {
        let word = working[i].wrapping_add(initial[i]).to_le_bytes();
        if let Some(dst) = out.get_mut(i * 4..i * 4 + 4) {
            dst.copy_from_slice(&word);
        }
    }
    out
}

pub fn chacha20_xor(
    key: &[u8; KEY_LEN],
    initial_counter: u32,
    nonce: &[u8; NONCE_LEN],
    data: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut counter = initial_counter;
    let mut offset = 0usize;
    while offset < data.len() {
        let keystream = chacha20_block(key, counter, nonce);
        counter = counter.wrapping_add(1);
        let chunk_len = (data.len() - offset).min(64);
        for i in 0..chunk_len {
            let b = data.get(offset + i).copied().unwrap_or(0);
            let k = keystream.get(i).copied().unwrap_or(0);
            out.push(b ^ k);
        }
        offset += chunk_len;
    }
    out
}

/// Poly1305 one-time MAC (RFC 8439 §2.5), constant-time 26-bit limb arithmetic.
pub fn poly1305_mac(otk: &[u8; 32], msg: &[u8]) -> [u8; TAG_LEN] {
    let t0 = read_le_u32(otk, 0);
    let t1 = read_le_u32(otk, 4);
    let t2 = read_le_u32(otk, 8);
    let t3 = read_le_u32(otk, 12);

    let r0 = u64::from(t0 & 0x03ff_ffff);
    let r1 = u64::from(((t0 >> 26) | (t1 << 6)) & 0x03ff_ff03);
    let r2 = u64::from(((t1 >> 20) | (t2 << 12)) & 0x03ff_c0ff);
    let r3 = u64::from(((t2 >> 14) | (t3 << 18)) & 0x03f0_3fff);
    let r4 = u64::from((t3 >> 8) & 0x000f_ffff);

    let s1 = r1 * 5;
    let s2 = r2 * 5;
    let s3 = r3 * 5;
    let s4 = r4 * 5;

    let mut h0: u64 = 0;
    let mut h1: u64 = 0;
    let mut h2: u64 = 0;
    let mut h3: u64 = 0;
    let mut h4: u64 = 0;

    let mut offset = 0usize;
    while offset < msg.len() {
        let remaining = msg.len() - offset;
        let mut block = [0u8; 17];
        let take = remaining.min(16);
        if let (Some(dst), Some(src)) = (block.get_mut(..take), msg.get(offset..offset + take)) {
            dst.copy_from_slice(src);
        }
        if let Some(slot) = block.get_mut(take) {
            *slot = 1u8;
        }
        offset += take;

        let b0 = read_le_u32(&block, 0);
        let b1 = read_le_u32(&block, 4);
        let b2 = read_le_u32(&block, 8);
        let b3 = read_le_u32(&block, 12);
        let hibit = u64::from(block[16]) << 24;

        h0 += u64::from(b0 & 0x03ff_ffff);
        h1 += u64::from(((b0 >> 26) | (b1 << 6)) & 0x03ff_ffff);
        h2 += u64::from(((b1 >> 20) | (b2 << 12)) & 0x03ff_ffff);
        h3 += u64::from(((b2 >> 14) | (b3 << 18)) & 0x03ff_ffff);
        h4 += u64::from(b3 >> 8) | hibit;

        let d0 = u128::from(h0) * u128::from(r0)
            + u128::from(h1) * u128::from(s4)
            + u128::from(h2) * u128::from(s3)
            + u128::from(h3) * u128::from(s2)
            + u128::from(h4) * u128::from(s1);
        let mut d1 = u128::from(h0) * u128::from(r1)
            + u128::from(h1) * u128::from(r0)
            + u128::from(h2) * u128::from(s4)
            + u128::from(h3) * u128::from(s3)
            + u128::from(h4) * u128::from(s2);
        let mut d2 = u128::from(h0) * u128::from(r2)
            + u128::from(h1) * u128::from(r1)
            + u128::from(h2) * u128::from(r0)
            + u128::from(h3) * u128::from(s4)
            + u128::from(h4) * u128::from(s3);
        let mut d3 = u128::from(h0) * u128::from(r3)
            + u128::from(h1) * u128::from(r2)
            + u128::from(h2) * u128::from(r1)
            + u128::from(h3) * u128::from(r0)
            + u128::from(h4) * u128::from(s4);
        let mut d4 = u128::from(h0) * u128::from(r4)
            + u128::from(h1) * u128::from(r3)
            + u128::from(h2) * u128::from(r2)
            + u128::from(h3) * u128::from(r1)
            + u128::from(h4) * u128::from(r0);

        let mut c = (d0 >> 26) as u64;
        h0 = (d0 as u64) & 0x03ff_ffff;
        d1 += u128::from(c);
        c = (d1 >> 26) as u64;
        h1 = (d1 as u64) & 0x03ff_ffff;
        d2 += u128::from(c);
        c = (d2 >> 26) as u64;
        h2 = (d2 as u64) & 0x03ff_ffff;
        d3 += u128::from(c);
        c = (d3 >> 26) as u64;
        h3 = (d3 as u64) & 0x03ff_ffff;
        d4 += u128::from(c);
        c = (d4 >> 26) as u64;
        h4 = (d4 as u64) & 0x03ff_ffff;
        h0 += c * 5;
        c = h0 >> 26;
        h0 &= 0x03ff_ffff;
        h1 += c;
    }

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

    f0 += u64::from(read_le_u32(otk, 16));
    f1 += u64::from(read_le_u32(otk, 20)) + (f0 >> 32);
    f2 += u64::from(read_le_u32(otk, 24)) + (f1 >> 32);
    f3 += u64::from(read_le_u32(otk, 28)) + (f2 >> 32);

    let mut tag = [0u8; TAG_LEN];
    tag[0..4].copy_from_slice(&(f0 as u32).to_le_bytes());
    tag[4..8].copy_from_slice(&(f1 as u32).to_le_bytes());
    tag[8..12].copy_from_slice(&(f2 as u32).to_le_bytes());
    tag[12..16].copy_from_slice(&(f3 as u32).to_le_bytes());
    tag
}

fn poly1305_aead_tag(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    ciphertext: &[u8],
) -> [u8; TAG_LEN] {
    let block0 = chacha20_block(key, 0, nonce);
    let mut otk = [0u8; 32];
    otk.copy_from_slice(&block0[..32]);

    let aad_pad = (16 - (aad.len() % 16)) % 16;
    let ct_pad = (16 - (ciphertext.len() % 16)) % 16;
    let mut mac_data =
        Vec::with_capacity(aad.len() + aad_pad + ciphertext.len() + ct_pad + 16);
    mac_data.extend_from_slice(aad);
    mac_data.resize(mac_data.len() + aad_pad, 0);
    mac_data.extend_from_slice(ciphertext);
    mac_data.resize(mac_data.len() + ct_pad, 0);
    mac_data.extend_from_slice(&(aad.len() as u64).to_le_bytes());
    mac_data.extend_from_slice(&(ciphertext.len() as u64).to_le_bytes());

    poly1305_mac(&otk, &mac_data)
}

/// Seals `plaintext` using RFC 8439 ChaCha20-Poly1305 AEAD. Returns `ciphertext || tag`.
pub fn aead_seal(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> Vec<u8> {
    let mut ciphertext = chacha20_xor(key, 1, nonce, plaintext);
    let tag = poly1305_aead_tag(key, nonce, aad, &ciphertext);
    ciphertext.extend_from_slice(&tag);
    ciphertext
}

/// Authenticates and decrypts `ciphertext || tag` using RFC 8439 ChaCha20-Poly1305 AEAD.
pub fn aead_open(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    ciphertext_and_tag: &[u8],
) -> Result<Vec<u8>, String> {
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

    let expected_tag = poly1305_aead_tag(key, nonce, aad, ciphertext);
    if !ct_eq(&expected_tag, provided_tag) {
        return Err("AEAD authentication failed (wrong key or tampered ciphertext)".to_owned());
    }

    Ok(chacha20_xor(key, 1, nonce, ciphertext))
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
        self.mul(self)
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

    let tx_info = format!("link|{my_peer_id}->{other_peer_id}");
    let rx_info = format!("link|{other_peer_id}->{my_peer_id}");
    let tx_key = hkdf_expand_32(&prk, tx_info.as_bytes());
    let rx_key = hkdf_expand_32(&prk, rx_info.as_bytes());
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

    let tx_info = format!("voice|{my_peer_id}->{other_peer_id}");
    let rx_info = format!("voice|{other_peer_id}->{my_peer_id}");
    let tx_key = hkdf_expand_32(&prk, tx_info.as_bytes());
    let rx_key = hkdf_expand_32(&prk, rx_info.as_bytes());
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
