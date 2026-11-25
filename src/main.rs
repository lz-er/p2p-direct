#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(not(test), deny(clippy::panic))]

use std::cell::RefCell;
use std::hint::black_box;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use p2p_direct::mesh::MeshNode;
use p2p_direct::rpc::{
    dispatch_commit_bulk_publish, dispatch_commit_bulk_rx, dispatch_rpc, dispatch_wire_message,
    worker_open_bulk, worker_seal_bulk, worker_seal_forward,
};

const BUF_CAP: usize = 262_144;
const BUF_WORDS: usize = BUF_CAP / 8;

const OP_HANDSHAKE: u32 = 0;
const OP_CALL: u32 = 1;
const OP_STREAM_APPEND: u32 = 2;
const OP_STREAM_EXEC: u32 = 3;
const OP_READ_OUT_CHUNK: u32 = 4;
const OP_VOICE_ENCODE_SEAL: u32 = 5;
const OP_VOICE_OPEN_DECODE: u32 = 6;
const OP_VOICE_SEAL_RAW: u32 = 7;
const OP_VOICE_OPEN_RAW: u32 = 8;
const OP_VOICE_PROCESS_CAPTURE_48K: u32 = 9;
const OP_WIRE_MESSAGE: u32 = 10;
const OP_STREAM_EXEC_WIRE: u32 = 11;
const OP_WORKER_SEAL_BULK: u32 = 12;
const OP_STREAM_EXEC_WORKER_SEAL: u32 = 13;
const OP_WORKER_OPEN_BULK: u32 = 14;
const OP_STREAM_EXEC_WORKER_OPEN: u32 = 15;
const OP_COMMIT_BULK_PUBLISH: u32 = 16;
const OP_STREAM_EXEC_COMMIT_PUBLISH: u32 = 17;
const OP_COMMIT_BULK_RX: u32 = 18;
const OP_STREAM_EXEC_COMMIT_RX: u32 = 19;
const OP_WORKER_SEAL_FORWARD: u32 = 20;
const OP_STREAM_EXEC_WORKER_SEAL_FORWARD: u32 = 21;

const STATUS_OK: u32 = 1;
const STATUS_ERR: u32 = 2;

const MAGIC_0: u32 = 0x5032_5031; // "P2P1"
const MAGIC_1: u32 = 0x5741_534D; // "WASM"
const MAGIC_2: u32 = 0x4D45_5348; // "MESH"
const MAGIC_3: u32 = 0x5630_3031; // "V001"

#[repr(C)]
struct BridgeHeader {
    magic: [AtomicU32; 4],
    op: AtomicU32,
    in_len: AtomicU32,
    out_len: AtomicU32,
    chunk_len: AtomicU32,
    status: AtomicU32,
    in_ptr: AtomicU32,
    out_ptr: AtomicU32,
    buf_cap: AtomicU32,
}

static HEADER: BridgeHeader = BridgeHeader {
    magic: [
        AtomicU32::new(0),
        AtomicU32::new(0),
        AtomicU32::new(0),
        AtomicU32::new(0),
    ],
    op: AtomicU32::new(0),
    in_len: AtomicU32::new(0),
    out_len: AtomicU32::new(0),
    chunk_len: AtomicU32::new(0),
    status: AtomicU32::new(0),
    in_ptr: AtomicU32::new(0),
    out_ptr: AtomicU32::new(0),
    buf_cap: AtomicU32::new(0),
};

static IN_BUF: [AtomicU64; BUF_WORDS] = [const { AtomicU64::new(0) }; BUF_WORDS];
static OUT_BUF: [AtomicU64; BUF_WORDS] = [const { AtomicU64::new(0) }; BUF_WORDS];

struct RuntimeState {
    node: Option<MeshNode>,
    in_staging: Vec<u8>,
    out_staging: Vec<u8>,
}

impl RuntimeState {
    const fn new() -> Self {
        Self {
            node: None,
            in_staging: Vec::new(),
            out_staging: Vec::new(),
        }
    }
}

thread_local! {
    static RUNTIME: RefCell<RuntimeState> = const { RefCell::new(RuntimeState::new()) };
}

fn append_in_buf_into(out: &mut Vec<u8>, len: usize) {
    let clamped = len.min(BUF_CAP);
    let buf = black_box(&IN_BUF);
    let full_words = clamped / 8;
    let tail = clamped % 8;
    out.reserve(clamped);
    for slot in buf.iter().take(full_words) {
        let word = slot.load(Ordering::Relaxed);
        out.extend_from_slice(&word.to_le_bytes());
    }
    if tail > 0
        && let Some(slot) = buf.get(full_words)
    {
        let word_bytes = slot.load(Ordering::Relaxed).to_le_bytes();
        out.extend_from_slice(&word_bytes[..tail]);
    }
}

fn read_in_buf(len: usize) -> Vec<u8> {
    let clamped = len.min(BUF_CAP);
    let mut out = Vec::with_capacity(clamped);
    append_in_buf_into(&mut out, clamped);
    out
}

fn write_out_slice(slice: &[u8]) -> usize {
    let clamped = slice.len().min(BUF_CAP);
    let buf = black_box(&OUT_BUF);
    let src = &slice[..clamped];
    let (chunks, rem) = src.as_chunks::<8>();
    let mut word_idx = 0usize;
    for chunk in chunks {
        if let Some(slot) = buf.get(word_idx) {
            slot.store(u64::from_le_bytes(*chunk), Ordering::Relaxed);
        }
        word_idx += 1;
    }
    if !rem.is_empty()
        && let Some(slot) = buf.get(word_idx)
    {
        let mut bytes = [0u8; 8];
        bytes[..rem.len()].copy_from_slice(rem);
        slot.store(u64::from_le_bytes(bytes), Ordering::Relaxed);
    }
    black_box(buf);
    clamped
}

fn publish_bytes_response(hdr: &BridgeHeader, rt: &mut RuntimeState, bytes: Vec<u8>, ok: bool) {
    rt.out_staging = bytes;
    let total = rt.out_staging.len();
    let copied = write_out_slice(&rt.out_staging);
    hdr.out_len.store(total as u32, Ordering::SeqCst);
    hdr.chunk_len.store(copied as u32, Ordering::SeqCst);
    hdr.status
        .store(if ok { STATUS_OK } else { STATUS_ERR }, Ordering::SeqCst);
}

fn publish_response(hdr: &BridgeHeader, rt: &mut RuntimeState, resp: String, ok: bool) {
    publish_bytes_response(hdr, rt, resp.into_bytes(), ok);
}

fn publish_binary_out(hdr: &BridgeHeader, bytes: &[u8], ok: bool) {
    let copied = write_out_slice(bytes);
    hdr.out_len.store(copied as u32, Ordering::SeqCst);
    hdr.chunk_len.store(copied as u32, Ordering::SeqCst);
    hdr.status
        .store(if ok { STATUS_OK } else { STATUS_ERR }, Ordering::SeqCst);
}

fn execute_request_bytes(hdr: &BridgeHeader, rt: &mut RuntimeState, req_bytes: &[u8]) {
    match std::str::from_utf8(req_bytes) {
        Ok(req_str) => {
            let resp = dispatch_rpc(&mut rt.node, req_str);
            publish_response(hdr, rt, resp, true);
        }
        Err(_) => {
            publish_response(
                hdr,
                rt,
                "{\"ok\":false,\"error\":\"invalid UTF-8 RPC request\"}".to_owned(),
                false,
            );
        }
    }
}

/// Binary fast-path for `wire_message`: `[u16 peerIdLen LE][peerId UTF-8][u64 nowMs LE][raw frame UTF-8]`.
fn execute_wire_message_bytes(hdr: &BridgeHeader, rt: &mut RuntimeState, in_bytes: &[u8]) {
    let (Some(&b0), Some(&b1)) = (in_bytes.first(), in_bytes.get(1)) else {
        publish_response(
            hdr,
            rt,
            "{\"ok\":false,\"error\":\"truncated binary wire_message header\"}".to_owned(),
            false,
        );
        return;
    };
    let pid_len = usize::from(u16::from_le_bytes([b0, b1]));
    let pid_end = 2usize.saturating_add(pid_len);
    let ts_end = pid_end.saturating_add(8);
    let (Some(pid_slice), Some(ts_slice), Some(frame_slice)) = (
        in_bytes.get(2..pid_end),
        in_bytes.get(pid_end..ts_end),
        in_bytes.get(ts_end..),
    ) else {
        publish_response(
            hdr,
            rt,
            "{\"ok\":false,\"error\":\"truncated binary wire_message payload\"}".to_owned(),
            false,
        );
        return;
    };
    let Ok(from_peer) = std::str::from_utf8(pid_slice) else {
        publish_response(
            hdr,
            rt,
            "{\"ok\":false,\"error\":\"invalid UTF-8 peerId in wire_message\"}".to_owned(),
            false,
        );
        return;
    };
    let Ok(frame_str) = std::str::from_utf8(frame_slice) else {
        publish_response(
            hdr,
            rt,
            "{\"ok\":false,\"error\":\"invalid UTF-8 frame in wire_message\"}".to_owned(),
            false,
        );
        return;
    };
    let now_ms = u64::from_le_bytes([
        ts_slice[0],
        ts_slice[1],
        ts_slice[2],
        ts_slice[3],
        ts_slice[4],
        ts_slice[5],
        ts_slice[6],
        ts_slice[7],
    ]);
    let resp = dispatch_wire_message(&mut rt.node, from_peer, frame_str, now_ms);
    publish_response(hdr, rt, resp, true);
}

fn execute_voice_encode_seal(hdr: &BridgeHeader, rt: &mut RuntimeState, in_bytes: &[u8]) {
    let Some(node) = rt.node.as_mut() else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let mut pcm = Vec::with_capacity(in_bytes.len() / 2);
    for &[b0, b1] in in_bytes.as_chunks::<2>().0 {
        pcm.push(i16::from_le_bytes([b0, b1]));
    }
    let (rms, packets) = node.seal_voice_pcm(&pcm);

    let mut fit_count: u16 = 0;
    let mut body_bytes: Vec<u8> = Vec::with_capacity(packets.len().saturating_mul(220));
    for (peer_id, pkt) in packets {
        let pid_bytes = peer_id.as_bytes();
        if pid_bytes.len() > usize::from(u16::MAX) || pkt.len() > usize::from(u16::MAX) {
            continue;
        }
        let needed = 4 + body_bytes.len() + 2 + pid_bytes.len() + 2 + pkt.len();
        if needed > BUF_CAP {
            break;
        }
        body_bytes.extend_from_slice(&(pid_bytes.len() as u16).to_le_bytes());
        body_bytes.extend_from_slice(pid_bytes);
        body_bytes.extend_from_slice(&(pkt.len() as u16).to_le_bytes());
        body_bytes.extend_from_slice(&pkt);
        fit_count = fit_count.saturating_add(1);
    }

    let mut out = Vec::with_capacity(4 + body_bytes.len());
    out.extend_from_slice(&rms.to_le_bytes());
    out.extend_from_slice(&fit_count.to_le_bytes());
    out.extend_from_slice(&body_bytes);
    publish_binary_out(hdr, &out, true);
}

fn execute_voice_open_decode(hdr: &BridgeHeader, rt: &mut RuntimeState, in_bytes: &[u8]) {
    let Some(node) = rt.node.as_mut() else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let (Some(&b0), Some(&b1)) = (in_bytes.first(), in_bytes.get(1)) else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let pid_len = usize::from(u16::from_le_bytes([b0, b1]));
    let pid_end = 2usize.saturating_add(pid_len);
    let Some(pid_slice) = in_bytes.get(2..pid_end) else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let Ok(peer_id) = std::str::from_utf8(pid_slice) else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let Some(pkt_slice) = in_bytes.get(pid_end..) else {
        publish_binary_out(hdr, &[], false);
        return;
    };

    match node.open_voice_packet(peer_id, pkt_slice) {
        Ok((rms, pcm)) => {
            let max_samples = (BUF_CAP.saturating_sub(4)) / 2;
            let count = pcm.len().min(max_samples).min(usize::from(u16::MAX));
            let mut out = Vec::with_capacity(4 + count * 2);
            out.extend_from_slice(&rms.to_le_bytes());
            out.extend_from_slice(&(count as u16).to_le_bytes());
            for &sample in pcm.iter().take(count) {
                out.extend_from_slice(&sample.to_le_bytes());
            }
            publish_binary_out(hdr, &out, true);
        }
        Err(_) => {
            publish_binary_out(hdr, &[], false);
        }
    }
}

fn execute_voice_seal_raw(hdr: &BridgeHeader, rt: &mut RuntimeState, in_bytes: &[u8]) {
    let Some(node) = rt.node.as_mut() else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let packets = node.seal_voice_raw(in_bytes);

    let mut fit_count: u16 = 0;
    let mut body_bytes: Vec<u8> = Vec::with_capacity(packets.len().saturating_mul(260));
    for (peer_id, pkt) in packets {
        let pid_bytes = peer_id.as_bytes();
        if pid_bytes.len() > usize::from(u16::MAX) || pkt.len() > usize::from(u16::MAX) {
            continue;
        }
        let needed = 2 + body_bytes.len() + 2 + pid_bytes.len() + 2 + pkt.len();
        if needed > BUF_CAP {
            break;
        }
        body_bytes.extend_from_slice(&(pid_bytes.len() as u16).to_le_bytes());
        body_bytes.extend_from_slice(pid_bytes);
        body_bytes.extend_from_slice(&(pkt.len() as u16).to_le_bytes());
        body_bytes.extend_from_slice(&pkt);
        fit_count = fit_count.saturating_add(1);
    }

    let mut out = Vec::with_capacity(2 + body_bytes.len());
    out.extend_from_slice(&fit_count.to_le_bytes());
    out.extend_from_slice(&body_bytes);
    publish_binary_out(hdr, &out, true);
}

fn execute_voice_open_raw(hdr: &BridgeHeader, rt: &mut RuntimeState, in_bytes: &[u8]) {
    let Some(node) = rt.node.as_mut() else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let (Some(&b0), Some(&b1)) = (in_bytes.first(), in_bytes.get(1)) else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let pid_len = usize::from(u16::from_le_bytes([b0, b1]));
    let pid_end = 2usize.saturating_add(pid_len);
    let Some(pid_slice) = in_bytes.get(2..pid_end) else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let Ok(peer_id) = std::str::from_utf8(pid_slice) else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let Some(pkt_slice) = in_bytes.get(pid_end..) else {
        publish_binary_out(hdr, &[], false);
        return;
    };

    match node.open_voice_v2_packet(peer_id, pkt_slice) {
        Ok(raw_payload) => {
            publish_binary_out(hdr, &raw_payload, true);
        }
        Err(_) => {
            publish_binary_out(hdr, &[], false);
        }
    }
}

fn execute_voice_process_capture_48k(hdr: &BridgeHeader, rt: &mut RuntimeState, in_bytes: &[u8]) {
    let Some(node) = rt.node.as_mut() else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    if in_bytes.len() < 4 {
        publish_binary_out(hdr, &[], false);
        return;
    }
    let gate_pct = in_bytes.first().copied().unwrap_or(0);
    let in_flags = in_bytes.get(1).copied().unwrap_or(0);
    let need_v1 = (in_flags & 1) != 0;
    let return_48k = (in_flags & 2) != 0;

    let sample_bytes = in_bytes.get(4..).unwrap_or(&[]);
    let mut samples = Vec::with_capacity(sample_bytes.len() / 4);
    for &[b0, b1, b2, b3] in sample_bytes.as_chunks::<4>().0 {
        samples.push(f32::from_le_bytes([b0, b1, b2, b3]));
    }

    let (dsp, v1_packets) = node.process_voice_capture_48k(&samples, gate_pct, need_v1);
    let out_flags: u8 =
        u8::from(dsp.gated) | (u8::from(dsp.is_fade_out_tail) << 1);

    let emit_samples = if return_48k && !dsp.gated {
        dsp.processed_48k.len().min((BUF_CAP.saturating_sub(12)) / 4).min(usize::from(u16::MAX))
    } else {
        0
    };
    let samples_byte_len = emit_samples * 4;

    let mut fit_v1: u16 = 0;
    let mut v1_body: Vec<u8> = Vec::with_capacity(v1_packets.len().saturating_mul(220));
    for (peer_id, pkt) in v1_packets {
        let pid_bytes = peer_id.as_bytes();
        if pid_bytes.len() > usize::from(u16::MAX) || pkt.len() > usize::from(u16::MAX) {
            continue;
        }
        let needed = 12 + samples_byte_len + v1_body.len() + 2 + pid_bytes.len() + 2 + pkt.len();
        if needed > BUF_CAP {
            break;
        }
        v1_body.extend_from_slice(&(pid_bytes.len() as u16).to_le_bytes());
        v1_body.extend_from_slice(pid_bytes);
        v1_body.extend_from_slice(&(pkt.len() as u16).to_le_bytes());
        v1_body.extend_from_slice(&pkt);
        fit_v1 = fit_v1.saturating_add(1);
    }

    let mut out = Vec::with_capacity(12 + samples_byte_len + v1_body.len());
    out.extend_from_slice(&dsp.raw_rms.to_le_bytes());
    out.extend_from_slice(&dsp.active_rms.to_le_bytes());
    out.push(out_flags);
    out.push(0);
    out.extend_from_slice(&(emit_samples as u16).to_le_bytes());
    out.extend_from_slice(&fit_v1.to_le_bytes());
    out.extend_from_slice(&[0u8, 0u8]);
    for &s in dsp.processed_48k.iter().take(emit_samples) {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out.extend_from_slice(&v1_body);
    publish_binary_out(hdr, &out, true);
}

fn main() {
    let hdr = black_box(&HEADER);
    let op = hdr.op.load(Ordering::SeqCst);
    let arg_len = hdr.in_len.load(Ordering::SeqCst) as usize;

    match op {
        OP_HANDSHAKE => {
            hdr.magic[0].store(black_box(MAGIC_0), Ordering::SeqCst);
            hdr.magic[1].store(black_box(MAGIC_1), Ordering::SeqCst);
            hdr.magic[2].store(black_box(MAGIC_2), Ordering::SeqCst);
            hdr.magic[3].store(black_box(MAGIC_3), Ordering::SeqCst);
            let in_ptr = (black_box(&IN_BUF) as *const [AtomicU64; BUF_WORDS] as usize) as u32;
            let out_ptr = (black_box(&OUT_BUF) as *const [AtomicU64; BUF_WORDS] as usize) as u32;
            hdr.in_ptr.store(in_ptr, Ordering::SeqCst);
            hdr.out_ptr.store(out_ptr, Ordering::SeqCst);
            hdr.buf_cap.store(BUF_CAP as u32, Ordering::SeqCst);
            hdr.out_len.store(0, Ordering::SeqCst);
            hdr.chunk_len.store(0, Ordering::SeqCst);
            hdr.status.store(STATUS_OK, Ordering::SeqCst);
        }
        OP_CALL => {
            let req_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    execute_request_bytes(hdr, &mut rt, &req_bytes);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_STREAM_APPEND => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    append_in_buf_into(&mut rt.in_staging, arg_len);
                    hdr.out_len.store(rt.in_staging.len() as u32, Ordering::SeqCst);
                    hdr.chunk_len.store(0, Ordering::SeqCst);
                    hdr.status.store(STATUS_OK, Ordering::SeqCst);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_STREAM_EXEC => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    let req_bytes = std::mem::take(&mut rt.in_staging);
                    execute_request_bytes(hdr, &mut rt, &req_bytes);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_WIRE_MESSAGE => {
            let in_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    execute_wire_message_bytes(hdr, &mut rt, &in_bytes);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_STREAM_EXEC_WIRE => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    let in_bytes = std::mem::take(&mut rt.in_staging);
                    execute_wire_message_bytes(hdr, &mut rt, &in_bytes);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_WORKER_SEAL_BULK => {
            let in_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    let out = worker_seal_bulk(&in_bytes);
                    publish_bytes_response(hdr, &mut rt, out, true);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_STREAM_EXEC_WORKER_SEAL => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    let in_bytes = std::mem::take(&mut rt.in_staging);
                    let out = worker_seal_bulk(&in_bytes);
                    publish_bytes_response(hdr, &mut rt, out, true);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_WORKER_OPEN_BULK => {
            let in_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    let out = worker_open_bulk(&in_bytes);
                    publish_bytes_response(hdr, &mut rt, out, true);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_STREAM_EXEC_WORKER_OPEN => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    let in_bytes = std::mem::take(&mut rt.in_staging);
                    let out = worker_open_bulk(&in_bytes);
                    publish_bytes_response(hdr, &mut rt, out, true);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_COMMIT_BULK_PUBLISH => {
            let in_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    let resp = dispatch_commit_bulk_publish(&mut rt.node, &in_bytes);
                    publish_response(hdr, &mut rt, resp, true);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_STREAM_EXEC_COMMIT_PUBLISH => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    let in_bytes = std::mem::take(&mut rt.in_staging);
                    let resp = dispatch_commit_bulk_publish(&mut rt.node, &in_bytes);
                    publish_response(hdr, &mut rt, resp, true);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_COMMIT_BULK_RX => {
            let in_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    let resp = dispatch_commit_bulk_rx(&mut rt.node, &in_bytes);
                    publish_response(hdr, &mut rt, resp, true);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_STREAM_EXEC_COMMIT_RX => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    let in_bytes = std::mem::take(&mut rt.in_staging);
                    let resp = dispatch_commit_bulk_rx(&mut rt.node, &in_bytes);
                    publish_response(hdr, &mut rt, resp, true);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_WORKER_SEAL_FORWARD => {
            let in_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    let resp = worker_seal_forward(&in_bytes);
                    publish_response(hdr, &mut rt, resp, true);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_STREAM_EXEC_WORKER_SEAL_FORWARD => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    let in_bytes = std::mem::take(&mut rt.in_staging);
                    let resp = worker_seal_forward(&in_bytes);
                    publish_response(hdr, &mut rt, resp, true);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_READ_OUT_CHUNK => {
            let offset = arg_len;
            RUNTIME.with(|cell| {
                if let Ok(rt) = cell.try_borrow() {
                    let slice = rt.out_staging.get(offset..).unwrap_or(&[]);
                    let copied = write_out_slice(slice);
                    hdr.out_len
                        .store(rt.out_staging.len() as u32, Ordering::SeqCst);
                    hdr.chunk_len.store(copied as u32, Ordering::SeqCst);
                    hdr.status.store(STATUS_OK, Ordering::SeqCst);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_VOICE_ENCODE_SEAL => {
            let in_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    execute_voice_encode_seal(hdr, &mut rt, &in_bytes);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_VOICE_OPEN_DECODE => {
            let in_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    execute_voice_open_decode(hdr, &mut rt, &in_bytes);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_VOICE_SEAL_RAW => {
            let in_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    execute_voice_seal_raw(hdr, &mut rt, &in_bytes);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_VOICE_OPEN_RAW => {
            let in_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    execute_voice_open_raw(hdr, &mut rt, &in_bytes);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_VOICE_PROCESS_CAPTURE_48K => {
            let in_bytes = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    execute_voice_process_capture_48k(hdr, &mut rt, &in_bytes);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        _ => {
            hdr.out_len.store(0, Ordering::SeqCst);
            hdr.chunk_len.store(0, Ordering::SeqCst);
            hdr.status.store(STATUS_ERR, Ordering::SeqCst);
        }
    }
    black_box(hdr);
}
