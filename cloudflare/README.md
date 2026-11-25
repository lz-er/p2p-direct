# Cloudflare Realtime TURN Setup (1,000 GB/month Free)

WebRTC requires a TURN relay whenever two devices cannot punch a direct UDP hole — for example:
- **Phone on 4G/5G (Carrier-Grade / Symmetric NAT) ↔ PC**
- **Phone ↔ PC on the same WiFi** when the browser masks LAN IPs via `.local` mDNS and the router does not support NAT hairpinning (or has AP client isolation enabled)
- **Strict corporate / university firewalls** that only allow port 443

All chat messages, images, and voice packets remain **double end-to-end encrypted** (WebRTC DTLS + Rust ChaCha20-Poly1305 AEAD), so Cloudflare's TURN edge only ever forwards opaque ciphertext when direct P2P cannot connect.

## 3-Minute Setup on Your Cloudflare Account (`dequ.org`)

### 1. Create a Free Cloudflare Realtime TURN App
1. Open the [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Realtime** → **TURN** (free tier includes **1,000 GB/month**).
2. Click **Create** (or **Add TURN App**), name it `voice-dequ-turn`, and copy:
   - **TURN Token ID** (`TURN_KEY_ID`)
   - **API Token** (`TURN_API_TOKEN`)

### 2. Deploy the Worker (`turn-worker.js`)
1. In Cloudflare Dashboard → **Workers & Pages** → **Create** → **Create Worker** → name it `voice-dequ-turn` → **Deploy**.
2. Click **Edit Code**, replace the template with [`turn-worker.js`](./turn-worker.js), and click **Deploy**.
3. Go to **Settings** → **Variables and Secrets** and add two **Secrets**:
   - `TURN_KEY_ID` = your TURN Token ID
   - `TURN_API_TOKEN` = your TURN API Token

### 3. Attach `turn.dequ.org` (Auto-Detected!)
1. Inside the Worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain**.
2. Enter `turn.dequ.org` and click **Add Domain** (Cloudflare provisions DNS + TLS automatically).

That's it! Because `https://voice.dequ.org/` automatically checks `https://turn.dequ.org/` on startup, every phone, PC, and bot in your rooms will immediately get global Anycast TURN (`UDP 3478/443`, `TCP 80/3478`, `TLS 443/5349`) with zero configuration.

### Verify It Works
1. Open `https://voice.dequ.org/` → toggle **Advanced** → check **Event Log**:
   - You should see `In-memory encrypted session ready (STUN + TURN fallback ICE)` and `Bundled ICE [host(mdns),srflx,relay]`.
2. Or visit `https://turn.dequ.org/` directly — it returns JSON `{ "iceServers": [...] }`.

### Custom Domain / Alternative Providers
You can also point any client to a different TURN credential URL via:
- URL query parameter: `https://voice.dequ.org/?turn=https://your-worker.workers.dev#room=...`
- **Advanced → Diagnostics → Custom TURN Endpoint** (saved in `sessionStorage` only)
- Bot SDK: `P2P_TURN_ENDPOINT=https://turn.dequ.org node examples/warframe-bot.mjs --room "..."`
