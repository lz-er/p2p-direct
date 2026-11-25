#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(not(test), deny(clippy::panic))]

use std::cell::RefCell;
use std::hint::black_box;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use p2p_direct::crypto::sha256;
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
const OP_GET_COUNTERS: u32 = 22;
const OP_SHA256: u32 = 23;

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
    in_scratch: Vec<u8>,
    out_scratch: Vec<u8>,
    f32_scratch: Vec<f32>,
    i16_scratch: Vec<i16>,
    adpcm_scratch: Vec<u8>,
}

impl RuntimeState {
    const fn new() -> Self {
        Self {
            node: None,
            in_staging: Vec::new(),
            out_staging: Vec::new(),
            in_scratch: Vec::new(),
            out_scratch: Vec::new(),
            f32_scratch: Vec::new(),
            i16_scratch: Vec::new(),
            adpcm_scratch: Vec::new(),
        }
    }
}

thread_local! {
    static RUNTIME: RefCell<RuntimeState> = const { RefCell::new(RuntimeState::new()) };
}

fn append_in_buf_into(out: &mut Vec<u8>, len: usize) {
    let clamped = len.min(BUF_CAP);
    let buf = black_box(&IN_BUF);
    let start = out.len();
    out.resize(start + clamped, 0);
    let (chunks, rem) = out[start..].as_chunks_mut::<8>();
    let full_words = chunks.len();
    for (dst, slot) in chunks.iter_mut().zip(buf.iter()) {
        *dst = slot.load(Ordering::Relaxed).to_le_bytes();
    }
    if !rem.is_empty()
        && let Some(slot) = buf.get(full_words)
    {
        let word_bytes = slot.load(Ordering::Relaxed).to_le_bytes();
        rem.copy_from_slice(&word_bytes[..rem.len()]);
    }
}

fn read_in_buf_into(out: &mut Vec<u8>, len: usize) {
    out.clear();
    append_in_buf_into(out, len);
}

fn write_out_slice(slice: &[u8]) -> usize {
    let clamped = slice.len().min(BUF_CAP);
    let buf = black_box(&OUT_BUF);
    let src = &slice[..clamped];
    let (chunks, rem) = src.as_chunks::<8>();
    let full_words = chunks.len();
    for (chunk, slot) in chunks.iter().zip(buf.iter()) {
        slot.store(u64::from_le_bytes(*chunk), Ordering::Relaxed);
    }
    if !rem.is_empty()
        && let Some(slot) = buf.get(full_words)
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

fn execute_voice_encode_seal(hdr: &BridgeHeader, rt: &mut RuntimeState) {
    let Some(node) = rt.node.as_mut() else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    rt.i16_scratch.clear();
    rt.i16_scratch.reserve(rt.in_scratch.len() / 2);
    for &[b0, b1] in rt.in_scratch.as_chunks::<2>().0 {
        rt.i16_scratch.push(i16::from_le_bytes([b0, b1]));
    }
    node.seal_voice_pcm_wire(
        &rt.i16_scratch,
        &mut rt.adpcm_scratch,
        &mut rt.out_scratch,
        BUF_CAP,
    );
    publish_binary_out(hdr, &rt.out_scratch, true);
}

fn execute_voice_open_decode(hdr: &BridgeHeader, rt: &mut RuntimeState) {
    let Some(node) = rt.node.as_mut() else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let in_bytes = rt.in_scratch.as_slice();
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

    match node.open_voice_packet_wire(
        peer_id,
        pkt_slice,
        &mut rt.adpcm_scratch,
        &mut rt.i16_scratch,
        &mut rt.out_scratch,
        BUF_CAP,
    ) {
        Ok(()) => publish_binary_out(hdr, &rt.out_scratch, true),
        Err(_) => publish_binary_out(hdr, &[], false),
    }
}

fn execute_voice_seal_raw(hdr: &BridgeHeader, rt: &mut RuntimeState) {
    let Some(node) = rt.node.as_mut() else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    node.seal_voice_raw_wire(&rt.in_scratch, &mut rt.out_scratch, BUF_CAP);
    publish_binary_out(hdr, &rt.out_scratch, true);
}

fn execute_voice_open_raw(hdr: &BridgeHeader, rt: &mut RuntimeState) {
    let Some(node) = rt.node.as_mut() else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    let in_bytes = rt.in_scratch.as_slice();
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

    match node.open_voice_v2_packet_into(peer_id, pkt_slice, &mut rt.out_scratch) {
        Ok(()) => publish_binary_out(hdr, &rt.out_scratch, true),
        Err(_) => publish_binary_out(hdr, &[], false),
    }
}

fn execute_voice_process_capture_48k(hdr: &BridgeHeader, rt: &mut RuntimeState) {
    let Some(node) = rt.node.as_mut() else {
        publish_binary_out(hdr, &[], false);
        return;
    };
    if rt.in_scratch.len() < 4 {
        publish_binary_out(hdr, &[], false);
        return;
    }
    let gate_pct = rt.in_scratch[0];
    let in_flags = rt.in_scratch[1];
    let need_v1 = (in_flags & 1) != 0;
    let return_48k = (in_flags & 2) != 0;

    let sample_bytes = &rt.in_scratch[4..];
    rt.f32_scratch.clear();
    rt.f32_scratch.reserve(sample_bytes.len() / 4);
    for &[b0, b1, b2, b3] in sample_bytes.as_chunks::<4>().0 {
        rt.f32_scratch.push(f32::from_le_bytes([b0, b1, b2, b3]));
    }

    node.process_voice_capture_48k_wire(
        &rt.f32_scratch,
        gate_pct,
        need_v1,
        return_48k,
        &mut rt.adpcm_scratch,
        &mut rt.out_scratch,
        BUF_CAP,
    );
    publish_binary_out(hdr, &rt.out_scratch, true);
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
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    let mut req_bytes = std::mem::take(&mut rt.in_scratch);
                    read_in_buf_into(&mut req_bytes, arg_len);
                    execute_request_bytes(hdr, &mut rt, &req_bytes);
                    rt.in_scratch = req_bytes;
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
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    let mut in_bytes = std::mem::take(&mut rt.in_scratch);
                    read_in_buf_into(&mut in_bytes, arg_len);
                    execute_wire_message_bytes(hdr, &mut rt, &in_bytes);
                    rt.in_scratch = in_bytes;
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
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    read_in_buf_into(&mut rt.in_scratch, arg_len);
                    let out = worker_seal_bulk(&rt.in_scratch);
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
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    read_in_buf_into(&mut rt.in_scratch, arg_len);
                    let out = worker_open_bulk(&rt.in_scratch);
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
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    let mut in_bytes = std::mem::take(&mut rt.in_scratch);
                    read_in_buf_into(&mut in_bytes, arg_len);
                    let resp = dispatch_commit_bulk_publish(&mut rt.node, &in_bytes);
                    rt.in_scratch = in_bytes;
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
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    let mut in_bytes = std::mem::take(&mut rt.in_scratch);
                    read_in_buf_into(&mut in_bytes, arg_len);
                    let resp = dispatch_commit_bulk_rx(&mut rt.node, &in_bytes);
                    rt.in_scratch = in_bytes;
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
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.clear();
                    read_in_buf_into(&mut rt.in_scratch, arg_len);
                    let resp = worker_seal_forward(&rt.in_scratch);
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
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    read_in_buf_into(&mut rt.in_scratch, arg_len);
                    execute_voice_encode_seal(hdr, &mut rt);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_VOICE_OPEN_DECODE => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    read_in_buf_into(&mut rt.in_scratch, arg_len);
                    execute_voice_open_decode(hdr, &mut rt);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_VOICE_SEAL_RAW => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    read_in_buf_into(&mut rt.in_scratch, arg_len);
                    execute_voice_seal_raw(hdr, &mut rt);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_VOICE_OPEN_RAW => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    read_in_buf_into(&mut rt.in_scratch, arg_len);
                    execute_voice_open_raw(hdr, &mut rt);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_VOICE_PROCESS_CAPTURE_48K => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    read_in_buf_into(&mut rt.in_scratch, arg_len);
                    execute_voice_process_capture_48k(hdr, &mut rt);
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_GET_COUNTERS => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    let rt = &mut *rt;
                    if let Some(node) = rt.node.as_ref() {
                        node.write_counters_binary(&mut rt.out_scratch);
                        publish_binary_out(hdr, &rt.out_scratch, true);
                    } else {
                        publish_binary_out(hdr, &[], false);
                    }
                } else {
                    hdr.status.store(STATUS_ERR, Ordering::SeqCst);
                }
            });
        }
        OP_SHA256 => {
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    read_in_buf_into(&mut rt.in_scratch, arg_len);
                    let digest = sha256(&rt.in_scratch);
                    publish_binary_out(hdr, &digest, true);
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
