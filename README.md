# p2p-direct

Zero-build, zero-dependency, serverless, **completely end-to-end encrypted** browser-to-browser WebRTC P2P mesh website powered by **100% safe Rust compiled to WebAssembly** (`#![forbid(unsafe_code)]`, zero `.unwrap()`, zero `.expect()`, zero external crates).

## Features

- **100% Safe Rust & WebAssembly**:
  - Enforced at compile time with `#![forbid(unsafe_code)]`, `#![deny(clippy::unwrap_used, clippy::expect_used)]`, and `#![cfg_attr(not(test), deny(clippy::panic))]`.
  - Zero third-party Cargo crates (`[dependencies]` is empty), zero npm packages, zero CDN requests, and zero build tools required to serve.
  - Pre-compiled standalone `p2p_mesh.wasm` is served directly alongside `index.html`, `styles.css`, `wasm_client.js`, `storage.js`, and `app.js` on GitHub Pages (`main` / `/`).
- **Complete End-to-End Encryption (Pure Safe Rust WASM)**:
  - **Primitives** (`src/crypto.rs`, verified against official FIPS 180-4, RFC 5869, RFC 8439, and RFC 7748 test vectors + OpenSSL cross-interop):
    - **X25519** Elliptic-Curve Diffie-Hellman (RFC 7748, constant-time Montgomery ladder, low-order point rejection)
    - **ChaCha20-Poly1305** AEAD (RFC 8439, constant-time tag check)
    - **SHA-256**, **HMAC-SHA256**, **HKDF-SHA256**, **PBKDF2-HMAC-SHA256** (10,000 iterations)
  - **Per-Link E2EE Wire Envelope**: Every WebRTC DataChannel frame (`hello`, `msg`, `sync-inv`, `sync-req`, `sync-batch`, `mesh-intro`, `relay-signal`) is wrapped in an authenticated `{"kind":"e2ee",...}` ChaCha20-Poly1305 envelope using directional `X25519(sk, peer_pk) || meshKey` session keys, AAD binding `(sender, receiver, seq)`, and a 64-slot anti-replay window. Plaintext or tampered frames are rejected.
  - **End-to-End Encrypted Replicated Log**: Each message is sealed with ChaCha20-Poly1305 under `HKDF(meshKey, "replicated-log-aead")` with AAD binding `(id, lamport, ts)`. Both wire replication and `IndexedDB` persistence store only encrypted ciphertext records (zero plaintext on disk or on the wire).
  - **Opaque Relayed Auto-Mesh Signaling**: Relayed SDP offers, answers, and ICE candidates between peers `A` and `C` are AEAD-encrypted end-to-end with `X25519(A_sk, C_pk) || meshKey` so intermediate relay peer `B` forwards only opaque ciphertext.
  - **Optional Passphrase-Protected `P2P1:` Invites**: Enter a shared passphrase to derive the 256-bit mesh key via PBKDF2-HMAC-SHA256 and AEAD-encrypt the `P2P1:` invite/reply codes themselves (omitting the mesh key from `#offer=` URLs). Or use automatic 256-bit keys handed off inside the client-only `#offer=` URL fragment with verifiable key fingerprints and per-peer X25519 safety codes.
- **Persistent Replicated Log**:
  - Machine-readable JSON messages with exact fields `(id, type, lamport, ts, author, authorName, payload)`, deterministically ordered by `(lamport, ts, id)`.
  - Persists locally in browser `IndexedDB` (with `localStorage` fallback and Web Locks multi-tab profile isolation) and stays alive in the network as long as at least one peer remains.
- **Anti-Entropy Backfill & Loop-Free Multi-Hop Gossip**:
  - Multi-part `sync-inv`, `sync-req`, and count/byte-bounded chunked `sync-batch` backfill deliver all missing historical and new records to joining or reconnecting peers.
  - Loop-free multi-hop gossip and transitive backfill propagation guarded by seen-ID deduplication, path tracking, and TTL bounds.
- **Step-by-Step Connect Wizard, Tab-Reopen Rejoining & Background Keepalive**:
  - Clear 3-step guided Connect flow: choose **Invite a Peer** (Step 1 Copy Invite Link → Step 2 Paste Peer's Reply → Step 3 Connected) or **Join with Invite** (Step 1 Paste Invite → Step 2 Copy Reply Link → Step 3 Connected), with automatic step progression on `#offer=` / `#answer=` URL fragments and cross-tab `#answer=` delivery via `BroadcastChannel`.
  - Reopening a closed or reloaded tab restores the saved `peerId`, X25519 identity, mesh key, encrypted log, and `knownPeers` — auto-rejoining open tabs on the same browser with zero clicks, or offering a 1-click **Create Rejoin Invite** for peers on other devices (cleanly superseding stale sockets).
  - An inline Blob Web Worker sends encrypted `Ping`/`Pong` keepalive frames every 4s (unthrottled in hidden tabs) paired with liveness-aware disconnect timers and foreground resume sync so background tabs stay connected.
- **Real-Time Multi-Peer E2EE Voice Chat**:
  - Everyone in the mesh who joins **Voice Chat** can talk and hear each other simultaneously in full duplex, with per-peer mute/volume controls, deafen, listen-only mode, and real-time speaking level meters.
  - Captured via an inline Blob `AudioWorkletProcessor` (with `ScriptProcessorNode` fallback) into 16 kHz mono 20 ms (`320`-sample) PCM frames, encoded inside safe Rust WASM with a stateless **IMA ADPCM** wideband codec (`src/audio.rs`), and sealed per peer into binary `V1` ChaCha20-Poly1305 AEAD packets under domain-separated directional `X25519 + meshKey` voice keys with a 64-slot anti-replay window.
  - Sent over a dedicated unordered, zero-retransmit WebRTC DataChannel (`p2p-voice`, `{ ordered: false, maxRetransmits: 0 }`) with zero SDP renegotiation and mixed simultaneously across all active remote speakers via independent Web Audio `GainNode` playout jitter buffers.

## Architecture

| File | Role |
| --- | --- |
| `src/crypto.rs` | Pure safe Rust SHA-256, HMAC, HKDF, PBKDF2, RFC 8439 ChaCha20-Poly1305 AEAD, RFC 7748 X25519, directional wire & voice key derivation, CSPRNG |
| `src/audio.rs` | Pure safe Rust 16 kHz mono stateless IMA ADPCM wideband voice codec & RMS amplitude meter |
| `src/json.rs` | Pure safe Rust RFC 8259 JSON parser & canonical serializer |
| `src/deflate.rs` | Pure safe Rust RFC 1951 DEFLATE/INFLATE + Base64URL codec |
| `src/codec.rs` | `P2P1:` deflate + optional AEAD-encrypted invite/reply code and `#offer=` / `#answer=` URL fragment codec |
| `src/log.rs` | Deterministic `(lamport, ts, id)` `ReplicatedLog` & ChaCha20-Poly1305 `SealedLogRecord` encrypted snapshots |
| `src/protocol.rs` | Outer `EncryptedWireEnvelope`, E2EE wire frames (`VoiceState`, `Hello`, etc.), binary `V1` E2EE voice packet framing, opaque `RelaySignal`, and chunkers |
| `src/mesh.rs` | Pure deterministic E2EE `MeshNode` state machine with wire & voice anti-replay windows |
| `src/rpc.rs` | JSON RPC command dispatcher |
| `src/main.rs` | Safe Rust WASM shared-memory bridge + zero-JSON binary fast-path voice opcodes (`#![forbid(unsafe_code)]`, zero `unsafe`) |
| `p2p_mesh.wasm` | Compiled release WebAssembly binary for zero-build static hosting |
| `index.html`, `styles.css`, `wasm_client.js`, `storage.js`, `app.js` | Zero-dependency static browser WebRTC transport (`p2p-mesh` + `p2p-voice`), Web Audio multi-speaker voice mixer, encrypted IndexedDB persistence, step-by-step Connect Wizard, topology SVG, and UI |

## Running Locally

Any static HTTP server works (zero build step):

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080` in two or more tabs (each simultaneously open tab automatically acquires an isolated local profile slot via Web Locks; reloading a tab restores its encrypted log).

## Running Tests & Rebuilding WebAssembly

```bash
# Run unit tests (including RFC 8439, RFC 7748, FIPS 180-4, RFC 5869 vectors) & E2EE multi-node simulations
cargo test

# Strict lint verification (forbid unsafe_code, deny unwrap/expect)
cargo clippy --all-targets -- -D warnings

# Rebuild p2p_mesh.wasm
rustup target add wasm32-unknown-unknown
cargo build --bin p2p_mesh --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/p2p_mesh.wasm ./p2p_mesh.wasm
```
