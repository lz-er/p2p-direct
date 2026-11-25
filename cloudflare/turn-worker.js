/**
 * Cloudflare Worker: Ephemeral TURN Credential Endpoint for voice.dequ.org
 *
 * Uses Cloudflare Realtime TURN (1,000 GB/month free tier) to issue short-lived
 * WebRTC `iceServers` credentials while keeping your TURN API token strictly server-side.
 *
 * Required Worker Secrets (Settings -> Variables and Secrets):
 *   - TURN_KEY_ID      (from Cloudflare Dashboard -> Realtime -> TURN)
 *   - TURN_API_TOKEN   (from Cloudflare Dashboard -> Realtime -> TURN)
 *
 * Optional Environment Variable:
 *   - ALLOWED_ORIGINS  (comma-separated origins, defaults to "https://voice.dequ.org")
 *   - CREDENTIAL_TTL   (seconds, default 43200 = 12 hours)
 */

const DEFAULT_ALLOWED_ORIGINS = [
  "https://voice.dequ.org",
  "http://localhost",
  "http://127.0.0.1",
];

function resolveAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return "https://voice.dequ.org";

  const rawList =
    env.ALLOWED_ORIGINS && String(env.ALLOWED_ORIGINS).trim()
      ? String(env.ALLOWED_ORIGINS)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_ALLOWED_ORIGINS;

  for (const allowed of rawList) {
    if (allowed === "*") return "*";
    if (origin === allowed) return origin;
    // Allow any localhost/127.0.0.1 dev port
    if (
      (allowed === "http://localhost" || allowed === "http://127.0.0.1") &&
      origin.startsWith(`${allowed}:`)
    ) {
      return origin;
    }
  }
  return null;
}

function corsHeaders(allowedOrigin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
  }
  return headers;
}

export default {
  async fetch(request, env) {
    const allowedOrigin = resolveAllowedOrigin(request, env);
    const headers = corsHeaders(allowedOrigin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: allowedOrigin ? 204 : 403, headers });
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers,
      });
    }

    if (!allowedOrigin) {
      return new Response(JSON.stringify({ error: "Origin not allowed" }), {
        status: 403,
        headers,
      });
    }

    if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
      return new Response(
        JSON.stringify({
          error: "Worker missing TURN_KEY_ID or TURN_API_TOKEN secret",
        }),
        { status: 503, headers }
      );
    }

    const ttlRaw = Number.parseInt(env.CREDENTIAL_TTL || "43200", 10);
    const ttl = Number.isFinite(ttlRaw) ? Math.min(86400, Math.max(300, ttlRaw)) : 43200;

    const cfUrl = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
      env.TURN_KEY_ID
    )}/credentials/generate-ice-servers`;

    try {
      const upstream = await fetch(cfUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl }),
      });

      if (!upstream.ok) {
        return new Response(
          JSON.stringify({ error: `Cloudflare TURN API returned HTTP ${upstream.status}` }),
          { status: 502, headers }
        );
      }

      const data = await upstream.json();
      const rawIce = data?.iceServers;
      const iceServers = Array.isArray(rawIce) ? rawIce : rawIce ? [rawIce] : [];

      return new Response(JSON.stringify({ iceServers, ttl }), {
        status: 200,
        headers,
      });
    } catch {
      return new Response(JSON.stringify({ error: "Failed to contact Cloudflare TURN API" }), {
        status: 502,
        headers,
      });
    }
  },
};
