//! Pure safe Rust IMA ADPCM wideband voice codec (16 kHz mono, 4 bits/sample).
//! Each frame is self-contained with its own initial predictor and step index so
//! unordered UDP-style WebRTC DataChannel packet loss never corrupts subsequent frames.

const MAX_ADPCM_SAMPLES: usize = 4096;

const INDEX_TABLE: [i32; 16] = [
    -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
];

const STEP_TABLE: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408,
    449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
    9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];

/// Computes the RMS amplitude (`0..=32767`) of a signed 16-bit PCM frame for speaking indicators.
pub fn compute_rms_i16(samples: &[i16]) -> u16 {
    if samples.is_empty() {
        return 0;
    }
    let mut sum_sq: u64 = 0;
    for &s in samples {
        let v = i64::from(s);
        sum_sq = sum_sq.saturating_add((v * v) as u64);
    }
    let mean = sum_sq / (samples.len() as u64);
    integer_sqrt(mean).min(u64::from(i16::MAX as u16)) as u16
}

fn integer_sqrt(n: u64) -> u64 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

fn step_at(idx: i32) -> i32 {
    let clamped = idx.clamp(0, 88) as usize;
    STEP_TABLE.get(clamped).copied().unwrap_or(7)
}

fn index_delta(code: u8) -> i32 {
    let i = usize::from(code & 0x0F);
    INDEX_TABLE.get(i).copied().unwrap_or(0)
}

/// Encodes signed 16-bit PCM samples into a self-contained IMA ADPCM frame.
/// Wire layout:
/// - bytes 0..2: initial predictor (`i16` LE = first sample)
/// - byte 2: initial `step_index` (`0..=88`)
/// - byte 3..5: total sample count (`u16` LE)
/// - bytes 5..: packed 4-bit nibbles (low nibble first, high nibble second) for samples `1..len`
pub fn encode_ima_adpcm(samples: &[i16]) -> Vec<u8> {
    let count = samples.len().min(MAX_ADPCM_SAMPLES);
    if count == 0 {
        return vec![0, 0, 0, 0, 0];
    }

    let first = samples.first().copied().unwrap_or(0);
    // Pick a sensible initial step index from first delta to reduce attack distortion
    let init_delta = if let Some(&second) = samples.get(1) {
        (i32::from(second) - i32::from(first)).abs()
    } else {
        0
    };
    let mut step_index: i32 = 0;
    for (idx, &st) in STEP_TABLE.iter().enumerate() {
        if st >= init_delta {
            step_index = idx as i32;
            break;
        }
        step_index = idx as i32;
    }

    let rem_samples = count - 1;
    let nibble_bytes = rem_samples.div_ceil(2);
    let mut out = Vec::with_capacity(5 + nibble_bytes);
    out.extend_from_slice(&first.to_le_bytes());
    out.push(step_index.clamp(0, 88) as u8);
    out.extend_from_slice(&(count as u16).to_le_bytes());

    let mut predictor = i32::from(first);
    let mut packed_byte: u8 = 0;
    let mut high_nibble = false;

    for &sample in samples.iter().skip(1).take(rem_samples) {
        let step = step_at(step_index);
        let mut diff = i32::from(sample) - predictor;
        let mut code: u8 = 0;
        if diff < 0 {
            code = 8;
            diff = -diff;
        }

        let mut vpdiff = step >> 3;
        if diff >= step {
            code |= 4;
            diff -= step;
            vpdiff += step;
        }
        if diff >= (step >> 1) {
            code |= 2;
            diff -= step >> 1;
            vpdiff += step >> 1;
        }
        if diff >= (step >> 2) {
            code |= 1;
            vpdiff += step >> 2;
        }

        if (code & 8) != 0 {
            predictor -= vpdiff;
        } else {
            predictor += vpdiff;
        }
        predictor = predictor.clamp(i32::from(i16::MIN), i32::from(i16::MAX));
        step_index = (step_index + index_delta(code)).clamp(0, 88);

        if high_nibble {
            packed_byte |= (code & 0x0F) << 4;
            out.push(packed_byte);
            packed_byte = 0;
            high_nibble = false;
        } else {
            packed_byte = code & 0x0F;
            high_nibble = true;
        }
    }

    if high_nibble {
        out.push(packed_byte);
    }
    out
}

/// Decodes a self-contained IMA ADPCM frame back into signed 16-bit PCM samples.
pub fn decode_ima_adpcm(data: &[u8]) -> Result<Vec<i16>, String> {
    if data.len() < 5 {
        return Err("ADPCM frame shorter than 5-byte header".to_owned());
    }
    let p0 = data.first().copied().unwrap_or(0);
    let p1 = data.get(1).copied().unwrap_or(0);
    let mut predictor = i32::from(i16::from_le_bytes([p0, p1]));
    let mut step_index = i32::from(data.get(2).copied().unwrap_or(0));
    if step_index > 88 {
        return Err(format!("invalid ADPCM step index {step_index}"));
    }
    let c0 = data.get(3).copied().unwrap_or(0);
    let c1 = data.get(4).copied().unwrap_or(0);
    let total_samples = usize::from(u16::from_le_bytes([c0, c1]));
    if total_samples > MAX_ADPCM_SAMPLES {
        return Err(format!("ADPCM sample count {total_samples} exceeds limit"));
    }
    if total_samples == 0 {
        return Ok(Vec::new());
    }

    let rem_samples = total_samples - 1;
    let needed_bytes = 5 + rem_samples.div_ceil(2);
    if data.len() < needed_bytes {
        return Err("truncated ADPCM nibble payload".to_owned());
    }

    let mut out = Vec::with_capacity(total_samples);
    out.push(predictor as i16);

    for i in 0..rem_samples {
        let byte_idx = 5 + (i / 2);
        let packed = data.get(byte_idx).copied().unwrap_or(0);
        let code = if i % 2 == 0 {
            packed & 0x0F
        } else {
            (packed >> 4) & 0x0F
        };

        let step = step_at(step_index);
        let mut vpdiff = step >> 3;
        if (code & 4) != 0 {
            vpdiff += step;
        }
        if (code & 2) != 0 {
            vpdiff += step >> 1;
        }
        if (code & 1) != 0 {
            vpdiff += step >> 2;
        }
        if (code & 8) != 0 {
            predictor -= vpdiff;
        } else {
            predictor += vpdiff;
        }
        predictor = predictor.clamp(i32::from(i16::MIN), i32::from(i16::MAX));
        step_index = (step_index + index_delta(code)).clamp(0, 88);
        out.push(predictor as i16);
    }

    Ok(out)
}
