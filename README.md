# p2p-direct

Zero-build, zero-dependency, serverless browser-to-browser WebRTC P2P mesh website powered by **100% safe Rust compiled to WebAssembly** (`#![forbid(unsafe_code)]`, zero `.unwrap()`, zero `.expect()`, zero external crates).

## Features

- **100% Safe Rust & WebAssembly**:
  - Enforced at compile time with `#![forbid(unsafe_code)]`, `#![deny(clippy::unwrap_used, clippy::expect_used)]`, and `#![cfg_attr(not(test), deny(clippy::panic))]`.
  - Zero third-party Cargo crates (`[dependencies]` is empty), zero npm packages, zero CDN requests, and zero build tools required to serve.
  - Pre-compiled standalone `p2p_mesh.wasm` is served directly alongside `index.html`, `styles.css`, `wasm_client.js`, `storage.js`, and `app.js` on GitHub Pages (`main` / `/`).
- **Persistent Replicated Log**:
  - Machine-readable JSON messages with exact fields `(id, type, lamport, ts, author, authorName, payload)`.
  - Strict deterministic total order by `(lamport, ts, id)` across all peers regardless of delivery order or partitions.
  - Persists locally in browser `IndexedDB` (with `localStorage` fallback and Web Locks multi-tab profile isolation) and stays alive in the network as long as at least one peer remains.
- **Anti-Entropy Backfill & Loop-Free Multi-Hop Gossip**:
  - `hello` + chunked `sync-inv` / `sync-req` / chunked `sync-batch` backfill delivers all missing historical and new messages to joining or reconnecting peers within WebRTC SCTP message size budgets.
  - Loop-free multi-hop `msg` gossip and transitive backfill propagation using seen-ID deduplication, path tracking, and TTL bounds.
- **Multi-Peer WebRTC DataChannels & Out-of-Band `P2P1:` Signaling**:
  - Pure safe Rust RFC 1951 DEFLATE/INFLATE + Base64URL encodes compact `P2P1:` invite/reply codes and shareable `#offer=P2P1:...` / `#answer=P2P1:...` URL fragments.
  - **Relayed Auto-Mesh Introduction**: When a new peer joins an existing peer, the introducer exchanges `mesh-intro` notices and forwards loop-free `relay-signal` WebRTC SDP offer/answer/ICE frames (with deterministic glare-free initiator selection) so peers automatically establish direct DataChannels to each other.

## Architecture

| File | Role |
| --- | --- |
| `src/json.rs` | Pure safe Rust RFC 8259 JSON parser & canonical serializer |
| `src/deflate.rs` | Pure safe Rust RFC 1951 DEFLATE/INFLATE + Base64URL codec |
| `src/codec.rs` | `P2P1:` invite/reply code and `#offer=` / `#answer=` URL fragment codec |
| `src/log.rs` | Deterministic `(lamport, ts, id)` persistent `ReplicatedLog` |
| `src/protocol.rs` | Wire frames (`hello`, `msg`, `sync-inv`, `sync-req`, `sync-batch`, `mesh-intro`, `relay-signal`) and chunkers |
| `src/mesh.rs` | Pure deterministic `MeshNode` state machine |
| `src/rpc.rs` | JSON RPC command dispatcher |
| `src/main.rs` | Safe Rust WASM shared-memory bridge (`#![forbid(unsafe_code)]`, zero `unsafe`) |
| `p2p_mesh.wasm` | Compiled release WebAssembly binary for zero-build static hosting |
| `index.html`, `styles.css`, `wasm_client.js`, `storage.js`, `app.js` | Zero-dependency static browser WebRTC transport, IndexedDB persistence, topology SVG, and UI |

## Running Locally

Any static HTTP server works (zero build step):

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080` in two or more tabs (each simultaneously open tab automatically acquires an isolated local profile slot via Web Locks; reloading a tab restores its persisted log).

## Running Tests & Rebuilding WebAssembly

```bash
# Run unit tests and multi-node sync simulation tests
cargo test

# Strict lint verification (forbid unsafe_code, deny unwrap/expect)
cargo clippy --all-targets -- -D warnings

# Rebuild p2p_mesh.wasm
rustup target add wasm32-unknown-unknown
cargo build --bin p2p_mesh --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/p2p_mesh.wasm ./p2p_mesh.wasm
```
