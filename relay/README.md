# Self-Hosted Relay (Bring Your Own Relay)

Run your own ~10 MB RAM in-memory E2EE WebSocket relay so zero 3rd-party relays are ever used — even when a phone VPN or strict NAT blocks direct WebRTC.

## 1. Start on Proxmox / Docker

```bash
cd relay
docker compose up -d
```

## 2. Expose over TLS (`wss://`)

- **With Caddy / reverse proxy (zero Cloudflare too)**: proxy `relay.yourdomain.com` -> `127.0.0.1:9001` (WebSockets enabled).
- **With Cloudflared**: add a Public Hostname `relay.yourdomain.com` -> `http://localhost:9001`.

## 3. Add to `voice.dequ.org`

Open **Settings → Network → Your Relays** and add:

```text
wss://relay.yourdomain.com/mqtt
```

New room links you create will automatically embed your relay so your phone and friends use it too.
