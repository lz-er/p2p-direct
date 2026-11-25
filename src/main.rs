#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(not(test), deny(clippy::panic))]

use std::cell::RefCell;
use std::hint::black_box;
use std::sync::atomic::{AtomicU32, AtomicU8, Ordering};

use p2p_direct::mesh::MeshNode;
use p2p_direct::rpc::dispatch_rpc;

const BUF_CAP: usize = 262_144;

const OP_HANDSHAKE: u32 = 0;
const OP_CALL: u32 = 1;
const OP_STREAM_APPEND: u32 = 2;
const OP_STREAM_EXEC: u32 = 3;
const OP_READ_OUT_CHUNK: u32 = 4;
const OP_VOICE_ENCODE_SEAL: u32 = 5;
const OP_VOICE_OPEN_DECODE: u32 = 6;

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

static IN_BUF: [AtomicU8; BUF_CAP] = [const { AtomicU8::new(0) }; BUF_CAP];
static OUT_BUF: [AtomicU8; BUF_CAP] = [const { AtomicU8::new(0) }; BUF_CAP];

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

fn read_in_buf(len: usize) -> Vec<u8> {
    let clamped = len.min(BUF_CAP);
    let buf = black_box(&IN_BUF);
    let mut out = Vec::with_capacity(clamped);
    for slot in buf.iter().take(clamped) {
        out.push(slot.load(Ordering::SeqCst));
    }
    out
}

fn write_out_slice(slice: &[u8]) -> usize {
    let clamped = slice.len().min(BUF_CAP);
    let buf = black_box(&OUT_BUF);
    for (slot, &b) in buf.iter().zip(slice.iter()).take(clamped) {
        slot.store(b, Ordering::SeqCst);
    }
    black_box(buf);
    clamped
}

fn publish_response(hdr: &BridgeHeader, rt: &mut RuntimeState, resp: String, ok: bool) {
    rt.out_staging = resp.into_bytes();
    let total = rt.out_staging.len();
    let copied = write_out_slice(&rt.out_staging);
    hdr.out_len.store(total as u32, Ordering::SeqCst);
    hdr.chunk_len.store(copied as u32, Ordering::SeqCst);
    hdr.status
        .store(if ok { STATUS_OK } else { STATUS_ERR }, Ordering::SeqCst);
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
            let in_ptr = (black_box(&IN_BUF) as *const [AtomicU8; BUF_CAP] as usize) as u32;
            let out_ptr = (black_box(&OUT_BUF) as *const [AtomicU8; BUF_CAP] as usize) as u32;
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
            let chunk = read_in_buf(arg_len);
            RUNTIME.with(|cell| {
                if let Ok(mut rt) = cell.try_borrow_mut() {
                    rt.in_staging.extend_from_slice(&chunk);
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
        _ => {
            hdr.out_len.store(0, Ordering::SeqCst);
            hdr.chunk_len.store(0, Ordering::SeqCst);
            hdr.status.store(STATUS_ERR, Ordering::SeqCst);
        }
    }
    black_box(hdr);
}
