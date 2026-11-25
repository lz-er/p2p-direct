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

/// 15-tap Blackman-windowed sinc low-pass FIR (`fc = 7.0 kHz @ 48 kHz`, unity DC gain)
/// for alias-free 3:1 decimation from 48 kHz fullband capture to 16 kHz V1 ADPCM.
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
        }
    }

    pub fn reset(&mut self) {
        self.dc_prev_x = 0.0;
        self.dc_prev_y = 0.0;
        self.gate_was_open = false;
        self.gate_fade_out_sent = false;
        self.hold_frames_left = 0;
        self.fir_tail = [0.0; 14];
    }

    /// Processes a single 48 kHz mono float32 frame (`960` samples = 20 ms).
    pub fn process_frame(
        &mut self,
        input: &[f32],
        gate_pct: u8,
        muted: bool,
        need_v1: bool,
    ) -> CaptureDspResult {
        let len = input.len().min(MAX_CAPTURE_48K_SAMPLES);
        if len == 0 {
            return CaptureDspResult {
                raw_rms: 0,
                active_rms: 0,
                gated: true,
                is_fade_out_tail: false,
                processed_48k: Vec::new(),
                downsampled_16k: Vec::new(),
            };
        }

        // 1. DC-offset high-pass blocker (~38 Hz @ 48 kHz) + exact RMS metering
        let mut buf = Vec::with_capacity(len);
        let mut sum_sq: f64 = 0.0;
        let mut prev_x = self.dc_prev_x;
        let mut prev_y = self.dc_prev_y;
        for &raw in input.iter().take(len) {
            let x = if raw.is_finite() { raw } else { 0.0 };
            let y = (x - prev_x) + 0.995 * prev_y;
            prev_x = x;
            prev_y = y;
            buf.push(y);
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
            return CaptureDspResult {
                raw_rms,
                active_rms: 0,
                gated: true,
                is_fade_out_tail: false,
                processed_48k: Vec::new(),
                downsampled_16k: Vec::new(),
            };
        }

        // 3. Apply cosine fade-in / fade-out envelope + transparent soft-knee safety limiter
        if apply_fade_in {
            let ramp = FADE_IN_SAMPLES_48K.min(len);
            let ramp_f = ramp as f32;
            for (i, s) in buf.iter_mut().take(ramp).enumerate() {
                let w = 0.5 * (1.0 - (std::f32::consts::PI * (i as f32) / ramp_f).cos());
                *s *= w;
            }
        } else if apply_fade_out {
            let len_f = len as f32;
            for (i, s) in buf.iter_mut().enumerate() {
                let w = 0.5 * (1.0 + (std::f32::consts::PI * (i as f32) / len_f).cos());
                *s *= w;
            }
        }

        for s in buf.iter_mut() {
            *s = soft_limit_f32(*s);
        }

        // 4. Optional alias-free 15-tap Blackman-windowed sinc 48kHz -> 16kHz FIR decimation
        let downsampled_16k = if need_v1 {
            self.downsample_48k_to_16k_i16(&buf)
        } else {
            if len >= 14
                && let Some(tail_src) = buf.get(len - 14..len)
            {
                self.fir_tail.copy_from_slice(tail_src);
            }
            Vec::new()
        };

        CaptureDspResult {
            raw_rms,
            active_rms: if apply_fade_out { 0 } else { raw_rms },
            gated: false,
            is_fade_out_tail: apply_fade_out,
            processed_48k: buf,
            downsampled_16k,
        }
    }

    fn downsample_48k_to_16k_i16(&mut self, buf: &[f32]) -> Vec<i16> {
        const TAIL_LEN: usize = 14;
        let out_len = buf.len() / 3;
        let mut out = Vec::with_capacity(out_len);

        for o in 0..out_len {
            let end_idx = (o * 3) as isize;
            let mut acc: f32 = 0.0;
            for (k, &tap) in FIR_48_TO_16_TAPS.iter().enumerate() {
                let src_idx = end_idx - (k as isize);
                let x = if src_idx >= 0 {
                    buf.get(src_idx as usize).copied().unwrap_or(0.0)
                } else {
                    let t_idx = (TAIL_LEN as isize + src_idx) as usize;
                    self.fir_tail.get(t_idx).copied().unwrap_or(0.0)
                };
                acc += x * tap;
            }
            let clamped = acc.clamp(-1.0, 1.0);
            let sample = if clamped < 0.0 {
                (clamped * 32_768.0).round() as i32
            } else {
                (clamped * 32_767.0).round() as i32
            };
            out.push(sample.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16);
        }

        if buf.len() >= TAIL_LEN
            && let Some(tail_src) = buf.get(buf.len() - TAIL_LEN..buf.len())
        {
            self.fir_tail.copy_from_slice(tail_src);
        }
        out
    }
}

/// Bit-transparent below `-1.4 dBFS` (`0.85`), smooth `tanh` soft-knee peak limiter above `0.85`.
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
