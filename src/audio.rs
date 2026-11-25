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
    let mean = (sum_sq as f64) / (samples.len() as f64);
    (mean.sqrt() as u64).min(u64::from(i16::MAX as u16)) as u16
}

#[inline(always)]
fn step_at(idx: i32) -> i32 {
    STEP_TABLE[idx.clamp(0, 88) as usize]
}

#[inline(always)]
fn index_delta(code: u8) -> i32 {
    INDEX_TABLE[usize::from(code & 0x0F)]
}

#[inline(always)]
fn encode_adpcm_nibble(sample: i16, predictor: &mut i32, step_index: &mut i32) -> u8 {
    let step = step_at(*step_index);
    let mut diff = i32::from(sample) - *predictor;
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
        *predictor -= vpdiff;
    } else {
        *predictor += vpdiff;
    }
    *predictor = (*predictor).clamp(i32::from(i16::MIN), i32::from(i16::MAX));
    *step_index = (*step_index + index_delta(code)).clamp(0, 88);
    code
}

/// Encodes signed 16-bit PCM samples into a self-contained IMA ADPCM frame, reusing `out`
/// to achieve zero heap allocation on the 50 Hz voice capture hot path.
/// Wire layout:
/// - bytes 0..2: initial predictor (`i16` LE = first sample)
/// - byte 2: initial `step_index` (`0..=88`)
/// - byte 3..5: total sample count (`u16` LE)
/// - bytes 5..: packed 4-bit nibbles (low nibble first, high nibble second) for samples `1..len`
pub fn encode_ima_adpcm_into(samples: &[i16], out: &mut Vec<u8>) {
    out.clear();
    let count = samples.len().min(MAX_ADPCM_SAMPLES);
    if count == 0 {
        out.extend_from_slice(&[0, 0, 0, 0, 0]);
        return;
    }

    let first = samples[0];
    // Pick a sensible initial step index from first delta via binary search to reduce attack distortion
    let init_delta = if let Some(&second) = samples.get(1) {
        (i32::from(second) - i32::from(first)).abs()
    } else {
        0
    };
    let mut step_index = STEP_TABLE.partition_point(|&st| st < init_delta).min(88) as i32;

    let rem_samples = count - 1;
    let nibble_bytes = rem_samples.div_ceil(2);
    out.resize(5 + nibble_bytes, 0);
    out[0..2].copy_from_slice(&first.to_le_bytes());
    out[2] = step_index as u8;
    out[3..5].copy_from_slice(&(count as u16).to_le_bytes());

    let mut predictor = i32::from(first);
    let (pairs, tail) = samples[1..count].as_chunks::<2>();
    let dst_nibbles = &mut out[5..];
    for (dst, &[s0, s1]) in dst_nibbles.iter_mut().zip(pairs.iter()) {
        let lo = encode_adpcm_nibble(s0, &mut predictor, &mut step_index);
        let hi = encode_adpcm_nibble(s1, &mut predictor, &mut step_index);
        *dst = lo | (hi << 4);
    }
    if let Some(&last_sample) = tail.first()
        && let Some(last_dst) = dst_nibbles.last_mut()
    {
        *last_dst = encode_adpcm_nibble(last_sample, &mut predictor, &mut step_index);
    }
}

/// Encodes signed 16-bit PCM samples into a self-contained IMA ADPCM frame.
pub fn encode_ima_adpcm(samples: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + samples.len().div_ceil(2));
    encode_ima_adpcm_into(samples, &mut out);
    out
}

#[inline(always)]
fn decode_adpcm_nibble(code: u8, predictor: &mut i32, step_index: &mut i32) -> i16 {
    let step = step_at(*step_index);
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
        *predictor -= vpdiff;
    } else {
        *predictor += vpdiff;
    }
    *predictor = (*predictor).clamp(i32::from(i16::MIN), i32::from(i16::MAX));
    *step_index = (*step_index + index_delta(code)).clamp(0, 88);
    *predictor as i16
}

/// Decodes a self-contained IMA ADPCM frame directly into `out` (zero steady-state allocation).
pub fn decode_ima_adpcm_into(data: &[u8], out: &mut Vec<i16>) -> Result<(), String> {
    out.clear();
    if data.len() < 5 {
        return Err("ADPCM frame shorter than 5-byte header".to_owned());
    }
    let mut predictor = i32::from(i16::from_le_bytes([data[0], data[1]]));
    let mut step_index = i32::from(data[2]);
    if step_index > 88 {
        return Err(format!("invalid ADPCM step index {step_index}"));
    }
    let total_samples = usize::from(u16::from_le_bytes([data[3], data[4]]));
    if total_samples > MAX_ADPCM_SAMPLES {
        return Err(format!("ADPCM sample count {total_samples} exceeds limit"));
    }
    if total_samples == 0 {
        return Ok(());
    }

    let rem_samples = total_samples - 1;
    let full_pairs = rem_samples / 2;
    let has_odd_tail = (rem_samples & 1) != 0;
    let needed_bytes = 5 + full_pairs + usize::from(has_odd_tail);
    if data.len() < needed_bytes {
        return Err("truncated ADPCM nibble payload".to_owned());
    }

    out.resize(total_samples, 0);
    out[0] = predictor as i16;

    let (dst_pairs, dst_tail) = out[1..].as_chunks_mut::<2>();
    for (pair, &packed) in dst_pairs.iter_mut().zip(&data[5..5 + full_pairs]) {
        pair[0] = decode_adpcm_nibble(packed & 0x0F, &mut predictor, &mut step_index);
        pair[1] = decode_adpcm_nibble((packed >> 4) & 0x0F, &mut predictor, &mut step_index);
    }
    if has_odd_tail && let Some(last_dst) = dst_tail.first_mut() {
        let packed = data[5 + full_pairs];
        *last_dst = decode_adpcm_nibble(packed & 0x0F, &mut predictor, &mut step_index);
    }

    Ok(())
}

/// Decodes a self-contained IMA ADPCM frame back into signed 16-bit PCM samples.
pub fn decode_ima_adpcm(data: &[u8]) -> Result<Vec<i16>, String> {
    let mut out = Vec::new();
    decode_ima_adpcm_into(data, &mut out)?;
    Ok(out)
}

/// 15-tap Blackman-windowed sinc low-pass FIR (`fc = 7.0 kHz @ 48 kHz`, unity DC gain)
/// for alias-free 3:1 decimation from 48 kHz fullband capture to 16 kHz V1 ADPCM.
/// Taps 0 and 14 are identically zero and the remaining 13 taps are symmetric around tap 7.
const FIR_48_TO_16_TAPS: [f32; 15] = [
    0.000_000_0,
    -0.001_588_4,
    -0.008_719_6,
    -0.011_484_1,
    0.014_576_6,
    0.090_997_1,
    0.194_494,
    0.243_448_8,
    0.194_494,
    0.090_997_1,
    0.014_576_6,
    -0.011_484_1,
    -0.008_719_6,
    -0.001_588_4,
    0.000_000_0,
];

const CAPTURE_HOLD_FRAMES: u32 = 14; // 14 * 20ms = 280ms smooth hold time
const FADE_IN_SAMPLES_48K: usize = 240; // 5ms @ 48 kHz
const MAX_CAPTURE_48K_SAMPLES: usize = 4096;

/// Lightweight metadata returned by zero-allocation `VoiceCaptureDsp48k::process_frame_in_place`.
#[derive(Debug, Clone, Copy)]
pub struct CaptureDspMeta {
    pub raw_rms: u16,
    pub active_rms: u16,
    pub gated: bool,
    pub is_fade_out_tail: bool,
}

/// Output of one 48 kHz capture frame processed in safe Rust DSP.
#[derive(Debug, Clone)]
pub struct CaptureDspResult {
    /// Pre-gate RMS on the `0..=32767` scale (for live audio-settings meter).
    pub raw_rms: u16,
    /// Active transmitted RMS (`0` when gated, muted, or fade-out tail).
    pub active_rms: u16,
    /// True when the noise gate is closed (caller should pause TX).
    pub gated: bool,
    /// True for the single 20 ms cosine fade-out tail frame transmitted right before pausing.
    pub is_fade_out_tail: bool,
    /// Processed 48 kHz float32 samples (DC-blocked, envelope-gated, soft-limited).
    pub processed_48k: Vec<f32>,
    /// Optional alias-free 16 kHz i16 downsampled frame (populated only when `need_v1` is true).
    pub downsampled_16k: Vec<i16>,
}

/// Stateful pure-Rust 48 kHz microphone capture DSP processor:
/// DC blocker -> RMS metering -> hysteresis envelope noise gate (5 ms cosine fade-in,
/// 280 ms hold, 20 ms cosine fade-out tail) -> soft-knee peak safety limiter ->
/// optional 15-tap Blackman-windowed sinc anti-aliasing 3:1 FIR downsampler.
#[derive(Debug, Clone)]
pub struct VoiceCaptureDsp48k {
    dc_prev_x: f32,
    dc_prev_y: f32,
    gate_was_open: bool,
    gate_fade_out_sent: bool,
    hold_frames_left: u32,
    fir_tail: [f32; 14],
    processed_buf: Vec<f32>,
    processed_len: usize,
    downsampled_buf: Vec<i16>,
    downsampled_len: usize,
}

impl Default for VoiceCaptureDsp48k {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceCaptureDsp48k {
    pub fn new() -> Self {
        Self {
            dc_prev_x: 0.0,
            dc_prev_y: 0.0,
            gate_was_open: false,
            gate_fade_out_sent: false,
            hold_frames_left: 0,
            fir_tail: [0.0; 14],
            processed_buf: Vec::new(),
            processed_len: 0,
            downsampled_buf: Vec::new(),
            downsampled_len: 0,
        }
    }

    pub fn reset(&mut self) {
        self.dc_prev_x = 0.0;
        self.dc_prev_y = 0.0;
        self.gate_was_open = false;
        self.gate_fade_out_sent = false;
        self.hold_frames_left = 0;
        self.fir_tail = [0.0; 14];
        self.processed_len = 0;
        self.downsampled_len = 0;
    }

    pub fn processed_48k(&self) -> &[f32] {
        &self.processed_buf[..self.processed_len]
    }

    pub fn downsampled_16k(&self) -> &[i16] {
        &self.downsampled_buf[..self.downsampled_len]
    }

    /// Zero-allocation in-place 48 kHz DSP pass: fills internal `processed_48k()` and
    /// `downsampled_16k()` scratch buffers without heap allocations, zero-fills, or per-sample
    /// capacity checks in steady state.
    pub fn process_frame_in_place(
        &mut self,
        input: &[f32],
        gate_pct: u8,
        muted: bool,
        need_v1: bool,
    ) -> CaptureDspMeta {
        self.processed_len = 0;
        self.downsampled_len = 0;

        let len = input.len().min(MAX_CAPTURE_48K_SAMPLES);
        if len == 0 {
            return CaptureDspMeta {
                raw_rms: 0,
                active_rms: 0,
                gated: true,
                is_fade_out_tail: false,
            };
        }

        // Ensure persistent scratch capacity once (no per-frame clear/zero-fill or push branches)
        if self.processed_buf.len() < len {
            self.processed_buf.resize(len, 0.0);
        }

        // 1. DC-offset high-pass blocker (~38 Hz @ 48 kHz) + exact RMS metering + peak tracking
        let mut sum_sq: f64 = 0.0;
        let mut peak_abs: f32 = 0.0;
        let mut prev_x = self.dc_prev_x;
        let mut prev_y = self.dc_prev_y;
        for (dst, &raw) in self.processed_buf[..len].iter_mut().zip(&input[..len]) {
            let x = if raw.is_finite() { raw } else { 0.0 };
            let y = (x - prev_x) + 0.995 * prev_y;
            prev_x = x;
            prev_y = y;
            *dst = y;
            peak_abs = peak_abs.max(y.abs());
            let yd = f64::from(y);
            sum_sq += yd * yd;
        }
        self.dc_prev_x = prev_x;
        self.dc_prev_y = prev_y;

        let raw_rms = if muted {
            0
        } else {
            let rms_f = (sum_sq / (len as f64)).sqrt() * 32_768.0;
            rms_f.round().clamp(0.0, 32_767.0) as u16
        };

        // 2. Smooth hysteresis envelope noise gate (5ms fade-in, 280ms hold, 20ms cosine fade-out)
        let mut gated = false;
        let mut apply_fade_in = false;
        let mut apply_fade_out = false;

        if muted {
            gated = true;
            self.gate_was_open = false;
            self.gate_fade_out_sent = false;
            self.hold_frames_left = 0;
        } else if gate_pct > 0 {
            let open_threshold = (f32::from(gate_pct) / 100.0) * 14_000.0;
            let hold_threshold = open_threshold * 0.65;
            let trigger = if self.gate_was_open {
                hold_threshold
            } else {
                open_threshold
            };
            if f32::from(raw_rms) >= trigger {
                self.hold_frames_left = CAPTURE_HOLD_FRAMES;
                if !self.gate_was_open {
                    apply_fade_in = true;
                    self.gate_was_open = true;
                }
                self.gate_fade_out_sent = false;
            } else if self.hold_frames_left > 0 {
                self.hold_frames_left -= 1;
            } else if self.gate_was_open && !self.gate_fade_out_sent {
                apply_fade_out = true;
                self.gate_was_open = false;
                self.gate_fade_out_sent = true;
            } else {
                gated = true;
                self.gate_was_open = false;
            }
        } else {
            self.gate_was_open = true;
            self.gate_fade_out_sent = false;
            self.hold_frames_left = CAPTURE_HOLD_FRAMES;
        }

        if gated {
            self.fir_tail = [0.0; 14];
            return CaptureDspMeta {
                raw_rms,
                active_rms: 0,
                gated: true,
                is_fade_out_tail: false,
            };
        }

        self.processed_len = len;
        let frame = &mut self.processed_buf[..len];

        // 3. Apply cosine fade-in / fade-out envelope via Chebyshev 2nd-order recurrence
        // (zero transcendental cos() calls in the inner sample loop) + transparent soft-knee limiter
        if apply_fade_in {
            let ramp = FADE_IN_SAMPLES_48K.min(len);
            apply_cosine_ramp(&mut frame[..ramp], false);
        } else if apply_fade_out {
            apply_cosine_ramp(frame, true);
        }

        // Fast path: skip the entire 960-sample limiter scan when peak is below the -1.4 dBFS knee
        // (fade-in/out multipliers are strictly in [0.0, 1.0], so they never increase peak_abs).
        if peak_abs > 0.85 {
            for s in frame.iter_mut() {
                *s = soft_limit_f32(*s);
            }
        }

        // 4. Optional alias-free 15-tap Blackman-windowed sinc 48kHz -> 16kHz FIR decimation
        if need_v1 {
            self.downsampled_len = Self::downsample_48k_to_16k_i16_into(
                &self.processed_buf[..len],
                &mut self.fir_tail,
                &mut self.downsampled_buf,
            );
        } else if len >= 14 {
            self.fir_tail
                .copy_from_slice(&self.processed_buf[len - 14..len]);
        }

        CaptureDspMeta {
            raw_rms,
            active_rms: if apply_fade_out { 0 } else { raw_rms },
            gated: false,
            is_fade_out_tail: apply_fade_out,
        }
    }

    /// Processes a single 48 kHz mono float32 frame (`960` samples = 20 ms).
    pub fn process_frame(
        &mut self,
        input: &[f32],
        gate_pct: u8,
        muted: bool,
        need_v1: bool,
    ) -> CaptureDspResult {
        let meta = self.process_frame_in_place(input, gate_pct, muted, need_v1);
        CaptureDspResult {
            raw_rms: meta.raw_rms,
            active_rms: meta.active_rms,
            gated: meta.gated,
            is_fade_out_tail: meta.is_fade_out_tail,
            processed_48k: self.processed_48k().to_vec(),
            downsampled_16k: self.downsampled_16k().to_vec(),
        }
    }

    /// Symmetric-folded 15-tap Blackman-windowed sinc FIR decimation (3:1, 48 kHz -> 16 kHz).
    /// Skips the two identically-zero end taps and folds the 6 symmetric pairs (7 multiplies/sample).
    fn downsample_48k_to_16k_i16_into(
        buf: &[f32],
        fir_tail: &mut [f32; 14],
        out: &mut Vec<i16>,
    ) -> usize {
        const TAIL_LEN: usize = 14;
        const T1: f32 = FIR_48_TO_16_TAPS[1];
        const T2: f32 = FIR_48_TO_16_TAPS[2];
        const T3: f32 = FIR_48_TO_16_TAPS[3];
        const T4: f32 = FIR_48_TO_16_TAPS[4];
        const T5: f32 = FIR_48_TO_16_TAPS[5];
        const T6: f32 = FIR_48_TO_16_TAPS[6];
        const T7: f32 = FIR_48_TO_16_TAPS[7];

        let out_len = buf.len() / 3;
        if out.len() < out_len {
            out.resize(out_len, 0);
        }
        let dst = &mut out[..out_len];

        // First 5 output samples (o = 0..5, end_idx = 0,3,6,9,12) reach into `fir_tail`
        let boundary = out_len.min(5);
        for (o, slot) in dst[..boundary].iter_mut().enumerate() {
            let end_idx = (o * 3) as isize;
            let sample_at = |k: usize| -> f32 {
                let src_idx = end_idx - (k as isize);
                if src_idx >= 0 {
                    buf.get(src_idx as usize).copied().unwrap_or(0.0)
                } else {
                    let t_idx = (TAIL_LEN as isize + src_idx) as usize;
                    fir_tail.get(t_idx).copied().unwrap_or(0.0)
                }
            };
            let acc = (sample_at(1) + sample_at(13)) * T1
                + (sample_at(2) + sample_at(12)) * T2
                + (sample_at(3) + sample_at(11)) * T3
                + (sample_at(4) + sample_at(10)) * T4
                + (sample_at(5) + sample_at(9)) * T5
                + (sample_at(6) + sample_at(8)) * T6
                + sample_at(7) * T7;
            *slot = f32_to_i16_clamped(acc);
        }

        // Branch-free, bounds-eliminated symmetric-folded interior loop (end_idx >= 15 => base >= 2)
        for (idx, slot) in dst[boundary..out_len].iter_mut().enumerate() {
            let base = (boundary + idx) * 3 - 13;
            let w = &buf[base..base + 13];
            // w[13 - k] corresponds to buf[end_idx - k] for k in 1..=13
            let acc = (w[12] + w[0]) * T1
                + (w[11] + w[1]) * T2
                + (w[10] + w[2]) * T3
                + (w[9] + w[3]) * T4
                + (w[8] + w[4]) * T5
                + (w[7] + w[5]) * T6
                + w[6] * T7;
            *slot = f32_to_i16_clamped(acc);
        }

        if buf.len() >= TAIL_LEN {
            fir_tail.copy_from_slice(&buf[buf.len() - TAIL_LEN..buf.len()]);
        }
        out_len
    }
}

#[inline(always)]
fn f32_to_i16_clamped(acc: f32) -> i16 {
    let clamped = acc.clamp(-1.0, 1.0);
    let sample = if clamped < 0.0 {
        (clamped * 32_768.0).round() as i32
    } else {
        (clamped * 32_767.0).round() as i32
    };
    sample.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16
}

/// Applies `0.5 * (1 ± cos(pi * i / n))` across `slice` using a 2nd-order Chebyshev cosine
/// recurrence (`1 mul + 1 sub` per sample, zero `cos()` calls inside the loop).
fn apply_cosine_ramp(slice: &mut [f32], fade_out: bool) {
    let n = slice.len();
    if n == 0 {
        return;
    }
    let step = std::f32::consts::PI / (n as f32);
    let cos_step = step.cos();
    let k = 2.0 * cos_step;
    let mut c_prev = cos_step; // cos(-step) == cos(step)
    let mut c_curr = 1.0f32; // cos(0)
    if fade_out {
        for s in slice.iter_mut() {
            *s *= 0.5 * (1.0 + c_curr);
            let c_next = k * c_curr - c_prev;
            c_prev = c_curr;
            c_curr = c_next;
        }
    } else {
        for s in slice.iter_mut() {
            *s *= 0.5 * (1.0 - c_curr);
            let c_next = k * c_curr - c_prev;
            c_prev = c_curr;
            c_curr = c_next;
        }
    }
}

/// Bit-transparent below `-1.4 dBFS` (`0.85`), smooth `tanh` soft-knee peak limiter above `0.85`.
#[inline(always)]
fn soft_limit_f32(x: f32) -> f32 {
    const KNEE: f32 = 0.85;
    const HEADROOM: f32 = 0.14;
    let abs_x = x.abs();
    if abs_x <= KNEE {
        return x;
    }
    let excess = (abs_x - KNEE) / HEADROOM;
    let limited = KNEE + HEADROOM * excess.tanh();
    if x < 0.0 { -limited } else { limited }
}
