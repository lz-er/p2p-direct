#!/usr/bin/env node
/**
 * Home Assistant Voice Assistant Bot for p2p-direct (`voice.dequ.org`).
 *
 * Bridges any end-to-end encrypted p2p-direct voice room to Home Assistant:
 *   - Wyoming Voice Satellite server (port 10700): native wake-word detection, button-triggered
 *     STT listening, LLM / Assist Q&A, smart-home entity control, TTS playback, announcements,
 *     and first-class Home Assistant voice timers.
 *   - Home Assistant Helper Watcher: paste any `voice.dequ.org/#room=...` link into an HA
 *     `input_text` helper (default `input_text.p2p_voice_room_link`) and the bot joins
 *     automatically; clear it to disconnect.
 *   - Tiny Flat Metro Control Panel Web UI (port 8787, Ingress-compatible): paste room links,
 *     trigger Listen Now, toggle Wake Word / Mute, view live timers & transcripts.
 *
 * Works both standalone (Proxmox / Docker / Node 22+) and inside a Home Assistant App (Add-on)
 * using `SUPERVISOR_TOKEN` automatically.
 */

import http from "node:http";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { P2PBot, VOICE_SAMPLE_RATE } from "./sdk.mjs";
import { WyomingSatelliteServer } from "./wyoming.mjs";

export const TIMER_LIST_FEATURES = Object.freeze({
  CREATE_TIMER: 1,
  PAUSE_TIMER: 2,
  CANCEL_TIMER: 4,
  ADD_TIME: 8,
  REMOVE_TIMER: 16,
  FINISH_TIMER: 32,
});

export function formatTimerListSourceLabel(entityId, friendlyName = "") {
  const base = String(friendlyName || "").trim() || String(entityId || "").replace(/^timer_list\./i, "");
  const stripped = base
    .replace(/(?:[\s_-]+)timers?$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  return stripped
    .split(" ")
    .map((word) => {
      if (!word) return "";
      return word.toLowerCase() === word ? word[0].toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}

export function formatTimerDurationLabel(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total <= 0) return "Timer";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 && h === 0) parts.push(`${s}s`);
  return parts.length > 0 ? `${parts.join(" ")} Timer` : "Timer";
}

function normalizeServiceDuration(duration) {
  if (typeof duration === "number") {
    const secs = Math.round(duration);
    if (!Number.isFinite(secs) || secs <= 0) throw new Error("Duration must be a positive number of seconds");
    return secs;
  }
  const raw = String(duration ?? "").trim();
  if (!raw) throw new Error("Duration is required");
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const secs = Math.round(Number(raw));
    if (secs <= 0) throw new Error("Duration must be greater than 0");
    return secs;
  }
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) {
    return raw.split(":").length === 2 ? `00:${raw}` : raw;
  }
  const unitMatches = Array.from(raw.matchAll(/(\d+)\s*([hms])/gi));
  if (unitMatches.length > 0 && raw.replace(/(\d+)\s*[hms]\s*/gi, "").trim() === "") {
    let total = 0;
    for (const [, numStr, unit] of unitMatches) {
      const n = Number(numStr);
      const u = unit.toLowerCase();
      if (u === "h") total += n * 3600;
      else if (u === "m") total += n * 60;
      else total += n;
    }
    if (total > 0) return total;
  }
  throw new Error(`Invalid timer duration "${raw}"`);
}

function normalizeTimerListItem(rawTimer, meta = {}, nowMs = Date.now()) {
  if (!rawTimer || typeof rawTimer !== "object") return null;
  const id = String(rawTimer.timer_id || rawTimer.id || "").trim();
  if (!id) return null;
  const status = String(rawTimer.status || "").trim().toLowerCase();
  const paused = status === "paused";
  const totalSeconds = Math.max(
    1,
    Math.round(
      Number(rawTimer.total_duration) ||
        Number(rawTimer.created_duration) ||
        Number(rawTimer.remaining) ||
        1
    )
  );

  let endsAtMs = 0;
  let remainingSec = 0;
  if (paused) {
    endsAtMs = 0;
    remainingSec = Math.max(0, Math.round(Number(rawTimer.paused_remaining ?? rawTimer.remaining) || 0));
  } else {
    const parsedFinishes = rawTimer.finishes_at ? Date.parse(rawTimer.finishes_at) : NaN;
    if (Number.isFinite(parsedFinishes) && parsedFinishes > 0) {
      endsAtMs = parsedFinishes;
    } else {
      const rem = Math.max(0, Number(rawTimer.remaining) || 0);
      endsAtMs = nowMs + rem * 1000;
    }
    remainingSec = Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));
  }

  const name =
    String(rawTimer.name || "").trim() ||
    formatTimerDurationLabel(rawTimer.created_duration ?? rawTimer.total_duration ?? remainingSec);

  return {
    id,
    name,
    status: status || (paused ? "paused" : "active"),
    paused,
    totalSeconds,
    endsAtMs,
    remainingSec,
    source: "timer_list",
    entityId: meta.entityId || "",
    sourceLabel: meta.sourceLabel || "",
    supportedFeatures: Number(meta.supportedFeatures) || 0,
  };
}

function splitChatChunks(text, maxLen = 12000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    let splitAt = slice.lastIndexOf("\n");
    if (splitAt < Math.floor(maxLen * 0.5)) {
      splitAt = maxLen;
    }
    const part = remaining.slice(0, splitAt).trimEnd();
    if (part) chunks.push(part);
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

export function formatWakeWordLabel(wakeWordId) {
  const raw = String(wakeWordId || "").trim();
  if (!raw) return "";
  const cleaned = raw
    .replace(/\.(tflite|onnx|json)$/i, "")
    .replace(/[_-]?v\d+(?:\.\d+)*$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : ""))
    .join(" ");
}

function buildAssistantSelectPattern(wyomingName) {
  const slug = String(wyomingName || "p2p-direct-voice")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const escaped = (slug || "p2p_direct_voice").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^select\\..*${escaped}_assistant$`, "i");
}

export function parseHaCliArgs(argv) {
  const env = process.env;
  const isSupervisor = Boolean(env.SUPERVISOR_TOKEN && !env.HA_URL);
  const args = {
    room: env.P2P_ROOM || "",
    passphrase: env.P2P_PASSPHRASE || "",
    name: env.P2P_BOT_NAME || "Home Assistant",
    relay: env.P2P_RELAY || "",
    wyomingHost: env.WYOMING_HOST || "0.0.0.0",
    wyomingPort: Number(env.WYOMING_PORT || 10700),
    wyomingName: env.WYOMING_NAME || "p2p-direct-voice",
    wyomingArea: env.WYOMING_AREA || "Voice Room",
    uiHost: env.UI_HOST || "0.0.0.0",
    uiPort: Number(env.UI_PORT || 8787),
    haUrl: env.HA_URL || (isSupervisor ? "http://supervisor/core" : ""),
    haToken: env.HA_TOKEN || env.SUPERVISOR_TOKEN || "",
    roomHelper: env.HA_ROOM_HELPER || "input_text.p2p_voice_room_link",
    passphraseHelper: env.HA_PASSPHRASE_HELPER || "input_text.p2p_voice_room_passphrase",
    wakeWordEnabled: env.WAKE_WORD_ENABLED !== "0",
    wakeWordLabel: env.WAKE_WORD_LABEL || "",
    timerListEntities: env.HA_TIMER_LIST_ENTITIES
      ? env.HA_TIMER_LIST_ENTITIES.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    allowedSpeakers: env.ALLOWED_SPEAKERS
      ? env.ALLOWED_SPEAKERS.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const next = argv[i + 1];
    if ((f === "--room" || f === "-r") && next) { args.room = next; i++; }
    else if ((f === "--passphrase" || f === "-p") && next) { args.passphrase = next; i++; }
    else if ((f === "--name" || f === "-n") && next) { args.name = next; i++; }
    else if (f === "--relay" && next) { args.relay = next; i++; }
    else if (f === "--wyoming-host" && next) { args.wyomingHost = next; i++; }
    else if (f === "--wyoming-port" && next) { args.wyomingPort = Number(next); i++; }
    else if (f === "--wyoming-name" && next) { args.wyomingName = next; i++; }
    else if (f === "--area" && next) { args.wyomingArea = next; i++; }
    else if (f === "--ui-host" && next) { args.uiHost = next; i++; }
    else if (f === "--ui-port" && next) { args.uiPort = Number(next); i++; }
    else if (f === "--ha-url" && next) { args.haUrl = next; i++; }
    else if (f === "--ha-token" && next) { args.haToken = next; i++; }
    else if (f === "--room-helper" && next) { args.roomHelper = next; i++; }
    else if (f === "--passphrase-helper" && next) { args.passphraseHelper = next; i++; }
    else if (f === "--no-wake-word") { args.wakeWordEnabled = false; }
    else if (f === "--wake-word-label" && next) { args.wakeWordLabel = next; i++; }
    else if (f === "--timer-list-entities" && next) {
      args.timerListEntities = next.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (f === "--allowed-speakers" && next) {
      args.allowedSpeakers = next.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (f === "--help" || f === "-h") {
      args.help = true;
    }
  }
  return args;
}

/**
 * Lightweight Home Assistant WebSocket API client for watching room-link helpers,
 * subscribing to `timer_list.*` entities, and running text conversation queries (`conversation/process`).
 */
export class HomeAssistantWsClient extends EventEmitter {
  constructor({
    haUrl = "",
    haToken = "",
    roomHelper = "",
    passphraseHelper = "",
    wyomingName = "p2p-direct-voice",
    timerListEntities = [],
  } = {}) {
    super();
    this.haUrl = String(haUrl || "").replace(/\/+$/, "");
    this.haToken = String(haToken || "").trim();
    this.roomHelper = String(roomHelper || "").trim();
    this.passphraseHelper = String(passphraseHelper || "").trim();
    this.wyomingName = String(wyomingName || "p2p-direct-voice").trim() || "p2p-direct-voice";
    this._assistantSelectPattern = buildAssistantSelectPattern(this.wyomingName);
    const cleanedTimerEntities = Array.isArray(timerListEntities)
      ? timerListEntities.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean)
      : [];
    this.timerListAllowlist = cleanedTimerEntities.length > 0 ? new Set(cleanedTimerEntities) : null;

    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.nextId = 1;
    this.pending = new Map();
    this.reconnectTimer = null;
    this.stopped = false;
    this.helperRoomLink = "";
    this.helperPassphrase = "";
    this.assistantSelectEntity = "";
    this.assistantSelectState = "";
    this.pipelineName = "";
    this.wakeWordId = "";
    this.wakeWordLabel = "";
    this.wakeWordEntity = "";
    this.timerLists = new Map(); // entityId -> { entityId, friendlyName, sourceLabel, available, supportedFeatures, state }
    this.timerListItems = new Map(); // entityId -> Map<timerId, normalizedTimer>
    this._timerListSubToEntity = new Map(); // subId -> entityId
    this._timerListEntityToSub = new Map(); // entityId -> subId
    this._timerListSubscribing = new Set();
    this.lastError = "";
  }

  isConfigured() {
    return Boolean(this.haUrl && this.haToken);
  }

  _buildWsUrl() {
    if (/^wss?:\/\//i.test(this.haUrl)) {
      return this.haUrl.endsWith("/api/websocket") || this.haUrl.endsWith("/websocket")
        ? this.haUrl
        : `${this.haUrl}/api/websocket`;
    }
    const base = this.haUrl.replace(/^http/i, "ws");
    if (base.endsWith("/core")) {
      // HA Supervisor internal core proxy uses ws://supervisor/core/websocket
      return `${base}/websocket`;
    }
    return `${base}/api/websocket`;
  }

  start() {
    if (!this.isConfigured()) return false;
    this.stopped = false;
    this._connect();
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    this._clearTimerListState(false);
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      reject(new Error("Home Assistant client stopped"));
    }
    this.pending.clear();
  }

  _clearTimerListState(emitUpdate = false) {
    let hadTimers = false;
    if (emitUpdate) {
      for (const map of this.timerListItems.values()) {
        if (map.size > 0) {
          hadTimers = true;
          break;
        }
      }
    }
    this._timerListSubToEntity.clear();
    this._timerListEntityToSub.clear();
    this._timerListSubscribing.clear();
    this.timerListItems.clear();
    this.timerLists.clear();
    if (emitUpdate && hadTimers) {
      this.emit("timerListUpdated", { entityId: "", type: "reset", timers: [] });
    }
  }

  _connect() {
    if (this.stopped || !this.isConfigured()) return;
    const wsUrl = this._buildWsUrl();
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      this.lastError = "";
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      this._handleMessage(msg);
    });

    ws.on("error", (err) => {
      this.lastError = err?.message || String(err);
      this.emit("status", this.getStatus());
    });

    ws.on("close", () => {
      this.connected = false;
      this.authenticated = false;
      this.ws = null;
      this._clearTimerListState(!this.stopped);
      this.emit("status", this.getStatus());
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this._connect();
        }, 5000);
      }
    });
  }

  _handleMessage(msg) {
    if (msg.type === "auth_required") {
      this.ws?.send(JSON.stringify({ type: "auth", access_token: this.haToken }));
      return;
    }
    if (msg.type === "auth_invalid") {
      this.lastError = msg.message || "Home Assistant auth_invalid";
      this.authenticated = false;
      this.emit("status", this.getStatus());
      return;
    }
    if (msg.type === "auth_ok") {
      this.authenticated = true;
      this.lastError = "";
      this.emit("status", this.getStatus());
      this._bootstrapHelpers().catch((err) => {
        this.lastError = err?.message || String(err);
        this.emit("status", this.getStatus());
      });
      return;
    }
    if (msg.type === "result" && msg.id != null) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (msg.success) waiter.resolve(msg.result);
        else waiter.reject(new Error(msg.error?.message || "HA WS call failed"));
      }
      return;
    }
    if (msg.type === "event" && msg.id != null && this._timerListSubToEntity.has(msg.id)) {
      const entityId = this._timerListSubToEntity.get(msg.id);
      this._handleTimerListEvent(entityId, msg.event);
      return;
    }
    if (msg.type === "event" && msg.event?.event_type === "p2p_voice_send_chat") {
      const d = msg.event.data || {};
      const message = String(d.message ?? d.text ?? "").trim();
      const title = String(d.title ?? "").trim();
      if (message) {
        this.emit("chatMessageRequested", { message, title });
      }
      return;
    }
    if (msg.type === "event" && msg.event?.event_type === "state_changed") {
      const d = msg.event.data || {};
      const entityId = d.entity_id;
      const newVal = String(d.new_state?.state ?? "").trim();
      const cleaned = /^(unknown|unavailable|none|off)$/i.test(newVal) ? "" : newVal;
      if (entityId === this.roomHelper) {
        if (cleaned !== this.helperRoomLink) {
          this.helperRoomLink = cleaned;
          this.emit("roomHelperChanged", {
            roomLink: this.helperRoomLink,
            passphrase: this.helperPassphrase,
          });
        }
      } else if (this.passphraseHelper && entityId === this.passphraseHelper) {
        if (cleaned !== this.helperPassphrase) {
          this.helperPassphrase = cleaned;
          if (this.helperRoomLink) {
            this.emit("roomHelperChanged", {
              roomLink: this.helperRoomLink,
              passphrase: this.helperPassphrase,
            });
          }
        }
      } else if (
        (this.assistantSelectEntity && entityId === this.assistantSelectEntity) ||
        this._assistantSelectPattern.test(String(entityId || ""))
      ) {
        this.assistantSelectEntity = entityId;
        this.assistantSelectState = cleaned;
        this.refreshWakeWordInfo({ skipGetStates: true }).catch(() => {});
      } else if (this._isTimerListAllowed(entityId)) {
        const oldRaw = String(d.old_state?.state ?? "").trim();
        const wasAvailable = Boolean(d.old_state) && !/^(unavailable|unknown)$/i.test(oldRaw);
        if (!d.new_state) {
          this._unsubscribeTimerList(entityId, { clearItems: true });
          this.timerLists.delete(entityId);
        } else {
          const meta = this._upsertTimerListMeta(entityId, d.new_state);
          if (!meta.available) {
            this._unsubscribeTimerList(entityId, { clearItems: true });
          } else if (!wasAvailable || !this._timerListEntityToSub.has(entityId)) {
            this._unsubscribeTimerList(entityId, { clearItems: false });
            this._subscribeTimerList(entityId).catch(() => {});
          } else {
            this.emit("timerListUpdated", { entityId, type: "meta", timers: this.getTimerListTimers() });
          }
        }
      }
    }
  }

  call(type, extra = {}, { timeoutMs = 0, onId = null } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.authenticated || this.ws.readyState !== 1) {
        reject(new Error("Home Assistant WebSocket not connected"));
        return;
      }
      const id = this.nextId++;
      if (typeof onId === "function") {
        onId(id);
      }
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`HA WS call "${type}" timed out`));
          }
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, type, ...extra }));
    });
  }

  _isTimerListAllowed(entityId) {
    const eid = String(entityId || "").trim();
    if (!eid.startsWith("timer_list.")) return false;
    if (!this.timerListAllowlist) return true;
    return this.timerListAllowlist.has(eid.toLowerCase());
  }

  _upsertTimerListMeta(entityId, stateObj) {
    const rawState = String(stateObj?.state ?? "").trim();
    const available = Boolean(stateObj) && !/^(unavailable|unknown)$/i.test(rawState);
    const attrs = stateObj?.attributes || {};
    const friendlyName = String(attrs.friendly_name || "").trim();
    const sourceLabel = formatTimerListSourceLabel(entityId, friendlyName);
    const supportedFeatures = Number(attrs.supported_features) || 0;
    const meta = {
      entityId,
      friendlyName,
      sourceLabel,
      available,
      supportedFeatures,
      state: rawState,
    };
    this.timerLists.set(entityId, meta);
    const existing = this.timerListItems.get(entityId);
    if (existing) {
      for (const item of existing.values()) {
        item.sourceLabel = sourceLabel;
        item.supportedFeatures = supportedFeatures;
      }
    }
    return meta;
  }

  async _subscribeTimerList(entityId) {
    if (!this.authenticated || !this._isTimerListAllowed(entityId)) return false;
    if (this._timerListEntityToSub.has(entityId) || this._timerListSubscribing.has(entityId)) {
      return true;
    }
    this._timerListSubscribing.add(entityId);
    let subId = null;
    try {
      await this.call(
        "timer_list/item/subscribe",
        { entity_id: entityId },
        {
          timeoutMs: 4000,
          onId: (id) => {
            subId = id;
            this._timerListSubToEntity.set(id, entityId);
            this._timerListEntityToSub.set(entityId, id);
          },
        }
      );
      return true;
    } catch {
      if (subId != null) {
        this._timerListSubToEntity.delete(subId);
        if (this._timerListEntityToSub.get(entityId) === subId) {
          this._timerListEntityToSub.delete(entityId);
        }
      }
      return false;
    } finally {
      this._timerListSubscribing.delete(entityId);
    }
  }

  _unsubscribeTimerList(entityId, { clearItems = true } = {}) {
    const subId = this._timerListEntityToSub.get(entityId);
    if (subId != null) {
      this._timerListEntityToSub.delete(entityId);
      this._timerListSubToEntity.delete(subId);
      if (this.authenticated && this.ws && this.ws.readyState === 1) {
        this.call("unsubscribe_events", { subscription: subId }, { timeoutMs: 2000 }).catch(() => {});
      }
    }
    if (clearItems) {
      const hadItems = (this.timerListItems.get(entityId)?.size || 0) > 0;
      this.timerListItems.delete(entityId);
      if (hadItems) {
        this.emit("timerListUpdated", { entityId, type: "cleared", timers: this.getTimerListTimers() });
      }
    }
  }

  _handleTimerListEvent(entityId, ev) {
    if (!ev || typeof ev !== "object") return;
    const meta = this.timerLists.get(entityId) || {
      entityId,
      friendlyName: "",
      sourceLabel: formatTimerListSourceLabel(entityId),
      available: true,
      supportedFeatures: 0,
    };

    if (ev.type === "timers" && Array.isArray(ev.timers)) {
      const map = new Map();
      for (const raw of ev.timers) {
        const status = String(raw?.status || "").trim().toLowerCase();
        if (status !== "active" && status !== "paused") continue;
        const norm = normalizeTimerListItem(raw, meta);
        if (norm) map.set(norm.id, norm);
      }
      this.timerListItems.set(entityId, map);
      this.emit("timerListUpdated", { entityId, type: "timers", timers: this.getTimerListTimers() });
      return;
    }

    if (ev.type === "change" && ev.timer) {
      let map = this.timerListItems.get(entityId);
      if (!map) {
        map = new Map();
        this.timerListItems.set(entityId, map);
      }
      const eventType = String(ev.event_type || "").trim().toLowerCase();
      const raw = ev.timer;
      const tid = String(raw?.timer_id || raw?.id || "").trim();
      const status = String(raw?.status || "").trim().toLowerCase();
      const isInactive =
        eventType === "finished" ||
        eventType === "cancelled" ||
        eventType === "removed" ||
        (Boolean(status) && status !== "active" && status !== "paused");

      if (isInactive) {
        const prev = tid ? map.get(tid) : null;
        if (tid) map.delete(tid);
        const item = prev ||
          normalizeTimerListItem({ ...raw, status: "active" }, meta) || {
            id: tid,
            name: String(raw?.name || "").trim() || formatTimerDurationLabel(raw?.created_duration),
            source: "timer_list",
            entityId,
            sourceLabel: meta.sourceLabel,
            supportedFeatures: meta.supportedFeatures,
          };
        this.emit("timerListUpdated", {
          entityId,
          type: "change",
          eventType,
          timer: item,
          timers: this.getTimerListTimers(),
        });
        if (eventType === "finished") {
          this.emit("timerListFinished", { entityId, timer: item });
        }
        return;
      }

      const norm = normalizeTimerListItem(raw, meta);
      if (norm) {
        map.set(norm.id, norm);
      }
      this.emit("timerListUpdated", {
        entityId,
        type: "change",
        eventType,
        timer: norm,
        delta: ev.delta,
        timers: this.getTimerListTimers(),
      });
    }
  }

  async _bootstrapHelpers() {
    await this.call("subscribe_events", { event_type: "state_changed" });
    await this.call("subscribe_events", { event_type: "p2p_voice_send_chat" }, { timeoutMs: 4000 }).catch(() => {});
    const states = await this.call("get_states");
    const availableTimerLists = [];
    if (Array.isArray(states)) {
      for (const st of states) {
        const val = String(st.state ?? "").trim();
        const cleaned = /^(unknown|unavailable|none|off)$/i.test(val) ? "" : val;
        if (this.roomHelper && st.entity_id === this.roomHelper) {
          this.helperRoomLink = cleaned;
        } else if (this.passphraseHelper && st.entity_id === this.passphraseHelper) {
          this.helperPassphrase = cleaned;
        } else if (this._assistantSelectPattern.test(String(st.entity_id || ""))) {
          this.assistantSelectEntity = st.entity_id;
          this.assistantSelectState = cleaned;
        } else if (this._isTimerListAllowed(st.entity_id)) {
          const meta = this._upsertTimerListMeta(st.entity_id, st);
          if (meta.available) {
            availableTimerLists.push(st.entity_id);
          }
        }
      }
      if (this.helperRoomLink) {
        this.emit("roomHelperChanged", {
          roomLink: this.helperRoomLink,
          passphrase: this.helperPassphrase,
        });
      }
    }
    await this.refreshWakeWordInfo({ skipGetStates: true });
    if (availableTimerLists.length > 0) {
      await Promise.allSettled(availableTimerLists.map((eid) => this._subscribeTimerList(eid)));
    }
  }

  async refreshWakeWordInfo({ skipGetStates = false } = {}) {
    if (!this.authenticated) return null;
    try {
      if (!skipGetStates) {
        const states = await this.call("get_states", {}, { timeoutMs: 4000 });
        if (Array.isArray(states)) {
          for (const st of states) {
            if (this._assistantSelectPattern.test(String(st?.entity_id || ""))) {
              const val = String(st.state ?? "").trim();
              this.assistantSelectEntity = st.entity_id;
              this.assistantSelectState = /^(unknown|unavailable|none|off)$/i.test(val) ? "" : val;
              break;
            }
          }
        }
      }

      const res = await this.call("assist_pipeline/pipeline/list", {}, { timeoutMs: 4000 });
      const pipelines = Array.isArray(res?.pipelines) ? res.pipelines : [];
      const preferredId = String(res?.preferred_pipeline || "").trim();
      if (pipelines.length === 0) return null;

      const selector = String(this.assistantSelectState || "").trim();
      let active = null;
      if (selector && selector.toLowerCase() !== "preferred") {
        const lowerSel = selector.toLowerCase();
        active =
          pipelines.find((p) => String(p?.name || "").trim().toLowerCase() === lowerSel) ||
          pipelines.find((p) => String(p?.id || "").trim().toLowerCase() === lowerSel) ||
          null;
      }
      if (!active && preferredId) {
        active = pipelines.find((p) => p?.id === preferredId) || null;
      }
      if (!active) {
        active = pipelines[0] || null;
      }
      if (!active) return null;

      const pipelineName = String(active.name || "").trim();
      const wakeWordId = String(active.wake_word_id || "").trim();
      const wakeWordEntity = String(active.wake_word_entity || "").trim();
      const wakeWordLabel = formatWakeWordLabel(wakeWordId);

      const changed =
        pipelineName !== this.pipelineName ||
        wakeWordId !== this.wakeWordId ||
        wakeWordLabel !== this.wakeWordLabel ||
        wakeWordEntity !== this.wakeWordEntity;

      this.pipelineName = pipelineName;
      this.wakeWordId = wakeWordId;
      this.wakeWordEntity = wakeWordEntity;
      this.wakeWordLabel = wakeWordLabel;

      const info = {
        pipelineName: this.pipelineName,
        wakeWordId: this.wakeWordId,
        wakeWordLabel: this.wakeWordLabel,
        wakeWordEntity: this.wakeWordEntity,
        assistantSelectEntity: this.assistantSelectEntity,
      };
      if (changed) {
        this.emit("wakeWordInfoChanged", info);
      }
      return info;
    } catch {
      // Best-effort: older/mock HA instances without assist_pipeline/pipeline/list stay unaffected
      return null;
    }
  }

  async askConversation(text, { conversationId = null } = {}) {
    const payload = { text: String(text || "").trim() };
    if (conversationId) payload.conversation_id = conversationId;
    const res = await this.call("conversation/process", payload);
    const speech =
      res?.response?.speech?.plain?.speech ||
      res?.response?.speech?.ssml?.speech ||
      "";
    return {
      text: String(speech || "").trim(),
      conversationId: res?.conversation_id || conversationId || null,
      responseType: res?.response?.response_type || "",
    };
  }

  async setRoomHelperValue(roomLink) {
    if (!this.authenticated || !this.roomHelper) return false;
    await this.call("call_service", {
      domain: "input_text",
      service: "set_value",
      service_data: {
        entity_id: this.roomHelper,
        value: String(roomLink || "").slice(0, 255),
      },
    });
    return true;
  }

  async _callTimerListService(service, entityId, serviceData = {}) {
    const eid = String(entityId || "").trim();
    if (!eid) throw new Error("timer_list entityId is required");
    await this.call("call_service", {
      domain: "timer_list",
      service,
      target: { entity_id: eid },
      service_data: serviceData,
    });
    return true;
  }

  async createTimerListTimer(entityId, { name = "", duration } = {}) {
    const normalizedDuration = normalizeServiceDuration(duration);
    const serviceData = { duration: normalizedDuration };
    const cleanName = String(name || "").trim();
    if (cleanName) serviceData.name = cleanName;
    return this._callTimerListService("create_timer", entityId, serviceData);
  }

  async pauseTimerListTimer(entityId, timerId) {
    const tid = String(timerId || "").trim();
    if (!tid) throw new Error("timerId is required");
    return this._callTimerListService("pause_timer", entityId, { timer_id: tid });
  }

  async unpauseTimerListTimer(entityId, timerId) {
    const tid = String(timerId || "").trim();
    if (!tid) throw new Error("timerId is required");
    return this._callTimerListService("unpause_timer", entityId, { timer_id: tid });
  }

  async addTimerListTime(entityId, timerId, duration = 60) {
    const tid = String(timerId || "").trim();
    if (!tid) throw new Error("timerId is required");
    const normalizedDuration = normalizeServiceDuration(duration);
    return this._callTimerListService("add_time", entityId, {
      timer_id: tid,
      duration: normalizedDuration,
    });
  }

  async subtractTimerListTime(entityId, timerId, duration = 60) {
    const tid = String(timerId || "").trim();
    if (!tid) throw new Error("timerId is required");
    const normalizedDuration = normalizeServiceDuration(duration);
    return this._callTimerListService("subtract_time", entityId, {
      timer_id: tid,
      duration: normalizedDuration,
    });
  }

  async cancelTimerListTimer(entityId, timerId) {
    const tid = String(timerId || "").trim();
    if (!tid) throw new Error("timerId is required");
    return this._callTimerListService("cancel_timer", entityId, { timer_id: tid });
  }

  getTimerLists() {
    return Array.from(this.timerLists.values())
      .map((m) => ({
        entityId: m.entityId,
        friendlyName: m.friendlyName,
        sourceLabel: m.sourceLabel,
        available: m.available,
        supportedFeatures: m.supportedFeatures,
      }))
      .sort((a, b) => (a.sourceLabel || a.entityId).localeCompare(b.sourceLabel || b.entityId));
  }

  getTimerListTimers(nowMs = Date.now()) {
    const out = [];
    for (const map of this.timerListItems.values()) {
      for (const t of map.values()) {
        out.push({
          ...t,
          remainingSec: t.paused
            ? t.remainingSec
            : Math.max(0, Math.ceil((t.endsAtMs - nowMs) / 1000)),
        });
      }
    }
    return out;
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      connected: this.connected,
      authenticated: this.authenticated,
      roomHelper: this.roomHelper,
      passphraseHelper: this.passphraseHelper,
      helperRoomLink: this.helperRoomLink,
      error: this.lastError,
    };
  }
}

/**
 * Orchestrates P2PBot + VoiceRoomMixer + WyomingSatelliteServer + HomeAssistantWsClient
 * + Tiny Flat Metro Control Panel UI.
 */
export class HomeAssistantVoiceAssistant extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      name: options.name || "Home Assistant",
      relay: options.relay || "",
      wyomingHost: options.wyomingHost || "0.0.0.0",
      wyomingPort: Number(options.wyomingPort ?? 10700),
      wyomingName: options.wyomingName || "p2p-direct-voice",
      wyomingArea: options.wyomingArea || "Voice Room",
      uiHost: options.uiHost || "0.0.0.0",
      uiPort: Number(options.uiPort ?? 8787),
      haUrl: options.haUrl || "",
      haToken: options.haToken || "",
      roomHelper: options.roomHelper || "input_text.p2p_voice_room_link",
      passphraseHelper: options.passphraseHelper || "input_text.p2p_voice_room_passphrase",
      wakeWordEnabled: options.wakeWordEnabled !== false,
      wakeWordLabel: options.wakeWordLabel || "",
      timerListEntities: Array.isArray(options.timerListEntities) ? options.timerListEntities : [],
      allowedSpeakers: Array.isArray(options.allowedSpeakers) ? options.allowedSpeakers : [],
      wasmPath: options.wasmPath,
    };

    this.bot = null;
    this.mixer = null;
    this.currentRoomLink = "";
    this.currentPassphrase = "";
    this.roomState = "disconnected"; // disconnected | connecting | connected | error
    this.roomError = "";
    this.controlMsgId = null;

    this.wakeWordEnabled = this.options.wakeWordEnabled;
    this.pipelineName = "";
    this.wakeWordId = "";
    this.wakeWordLabel = String(this.options.wakeWordLabel || "").trim();
    this.muted = false;
    this.activeTimers = new Map(); // id -> { id, name, totalSeconds, endsAtMs, paused, remainingSec, commandText }
    this.recentLog = []; // [{ ts, kind, speaker, text }]
    this.lastTranscript = "";
    this.lastReply = "";
    this.lastSpeaker = "";
    this.conversationId = null;
    this._awaitingAudioDoneForWyoming = false;
    this.audioStats = {
      lastRms: 0,
      peakRms: 0,
      activeFrames: 0,
      silenceFrames: 0,
      underrunCount: 0,
      bufferedFrames: 0,
    };

    this.wyoming = new WyomingSatelliteServer({
      host: this.options.wyomingHost,
      port: this.options.wyomingPort,
      name: this.options.wyomingName,
      area: this.options.wyomingArea,
      wakeWordEnabled: this.wakeWordEnabled,
    });
    this._wireWyomingEvents();

    this.haClient = new HomeAssistantWsClient({
      haUrl: this.options.haUrl,
      haToken: this.options.haToken,
      roomHelper: this.options.roomHelper,
      passphraseHelper: this.options.passphraseHelper,
      wyomingName: this.options.wyomingName,
      timerListEntities: this.options.timerListEntities,
    });
    this.haClient.on("roomHelperChanged", ({ roomLink, passphrase }) => {
      if (roomLink) {
        if (roomLink !== this.currentRoomLink || passphrase !== this.currentPassphrase) {
          this.connectRoom(roomLink, passphrase).catch((err) => {
            this._pushLog("error", "HA Helper", err.message);
          });
        }
      } else if (this.currentRoomLink) {
        this.disconnectRoom().catch(() => {});
      }
    });
    this.haClient.on("wakeWordInfoChanged", ({ pipelineName, wakeWordId, wakeWordLabel }) => {
      const prevWakeWordId = this.wakeWordId;
      this.pipelineName = pipelineName || "";
      this.wakeWordId = wakeWordId || "";
      this.wakeWordLabel = wakeWordLabel || String(this.options.wakeWordLabel || "").trim();
      this.syncChatCard(false);
      if (
        this.wakeWordEnabled &&
        this.wyoming.isReady() &&
        this.wyoming.pipelineMode === "wake" &&
        prevWakeWordId &&
        this.wakeWordId !== prevWakeWordId
      ) {
        this.wyoming.startWakeListening();
      }
    });
    this.haClient.on("timerListUpdated", () => {
      const hasActiveTimers = this.getAllActiveTimers().length > 0;
      this.syncChatCard(hasActiveTimers);
    });
    this.haClient.on("timerListFinished", ({ timer }) => {
      const label = timer?.name || "Timer";
      const src = timer?.sourceLabel ? ` (${timer.sourceLabel})` : "";
      this._pushLog("timer", "Timer", `Finished "${label}"${src}`);
      if (this.bot && this.bot.inVoice && !this.muted) {
        this.bot.playChime("timer", { amplitude: 0.3 });
      }
      this.lastReply = `Timer finished: ${label}${src}`;
      this.syncChatCard(true);
    });
    this.haClient.on("chatMessageRequested", ({ message, title }) => {
      this.sendRoomChat(message, { title, speaker: "Assist" });
    });

    this.uiServer = null;
  }

  async start({ initialRoom = "", initialPassphrase = "" } = {}) {
    const wyInfo = await this.wyoming.start();
    const uiInfo = await this._startUiServer();
    if (this.haClient.isConfigured()) {
      this.haClient.start();
    }
    if (initialRoom) {
      await this.connectRoom(initialRoom, initialPassphrase);
    }
    return { wyoming: wyInfo, ui: uiInfo };
  }

  async stop() {
    this.haClient.stop();
    await this.disconnectRoom();
    await this.wyoming.stop();
    if (this.uiServer) {
      const srv = this.uiServer;
      this.uiServer = null;
      await new Promise((resolve) => srv.close(() => resolve()));
    }
  }

  async connectRoom(roomLink, passphrase = "") {
    const cleanLink = String(roomLink || "").trim();
    if (!cleanLink) throw new Error("Room link is required");
    await this.disconnectRoom();

    this.roomState = "connecting";
    this.roomError = "";
    this.currentRoomLink = cleanLink;
    this.currentPassphrase = String(passphrase || "");

    const bot = new P2PBot({
      roomLink: cleanLink,
      passphrase: this.currentPassphrase,
      name: this.options.name,
      relay: this.options.relay || undefined,
      wasmPath: this.options.wasmPath,
    });
    this.bot = bot;

    bot.on("message", (msg) => this._onRoomMessage(msg));
    bot.on("interaction", (ev) => this._onRoomInteraction(ev));
    bot.on("peerJoin", () => this.syncChatCard(false));
    bot.on("peerLeave", () => this.syncChatCard(false));
    bot.on("voiceState", () => this.syncChatCard(false));
    bot.on("audioEnd", () => {
      if (this._awaitingAudioDoneForWyoming) {
        this._awaitingAudioDoneForWyoming = false;
        this.wyoming.notifyAudioPlayed();
      }
      this.syncChatCard(false);
    });

    try {
      const ready = await bot.connect();
      this.roomState = "connected";
      bot.joinVoice({ muted: this.muted });

      this._resetAudioStats();
      this.mixer = bot.createVoiceMixer({
        echoSuppression: true,
        echoTailMs: 350,
        jitterBufferFrames: 3,
        maxBufferedFramesPerPeer: 16,
        allowedSpeakers: this.options.allowedSpeakers,
      });
      this.mixer.on("frame", (frame) => {
        this._recordAudioFrame(frame);
        if (!this.muted && this.wyoming.streamingToHa) {
          this.wyoming.sendAudioChunk(frame.buffer);
        }
      });
      this.mixer.start();

      this._pushLog("system", "Room", `Connected to "${ready.room}"`);
      this.syncChatCard(true);
      return ready;
    } catch (err) {
      this.roomState = "error";
      this.roomError = err?.message || String(err);
      try {
        await bot.disconnect();
      } catch {
        // ignore
      }
      if (this.bot === bot) this.bot = null;
      this._pushLog("error", "Room", this.roomError);
      throw err;
    }
  }

  async disconnectRoom() {
    this._awaitingAudioDoneForWyoming = false;
    this.controlMsgId = null;
    if (this.mixer) {
      this.mixer.destroy();
      this.mixer = null;
    }
    if (this.bot) {
      const prev = this.bot;
      this.bot = null;
      try {
        await prev.disconnect();
      } catch {
        // ignore
      }
    }
    this.currentRoomLink = "";
    this.currentPassphrase = "";
    this.roomState = "disconnected";
    this.roomError = "";
    this._resetAudioStats();
  }

  _resetAudioStats() {
    this.audioStats = {
      lastRms: 0,
      peakRms: 0,
      activeFrames: 0,
      silenceFrames: 0,
      underrunCount: 0,
      bufferedFrames: 0,
    };
  }

  _recordAudioFrame(frame) {
    const rms = Number(frame?.rms) || 0;
    this.audioStats.lastRms = rms;
    if (rms > this.audioStats.peakRms) {
      this.audioStats.peakRms = rms;
    }
    if (frame?.isSilence) {
      this.audioStats.silenceFrames += 1;
    } else {
      this.audioStats.activeFrames += 1;
    }
    if (typeof frame?.underrunCount === "number") {
      this.audioStats.underrunCount = frame.underrunCount;
    } else if (this.mixer) {
      this.audioStats.underrunCount = this.mixer.underrunCount || 0;
    }
    if (typeof frame?.bufferedFrames === "number") {
      this.audioStats.bufferedFrames = frame.bufferedFrames;
    } else if (this.mixer) {
      this.audioStats.bufferedFrames = this.mixer.getBufferedFrames();
    }
  }

  triggerListenNow({ speakerPeerId = null, speakerName = "" } = {}) {
    if (!this.wyoming.isReady()) {
      return { ok: false, error: "Home Assistant Wyoming Satellite is not connected yet" };
    }
    if (this.muted) {
      this.setMuted(false);
    }
    if (this.mixer) {
      if (speakerPeerId) this.mixer.lockSpeaker(speakerPeerId);
      else this.mixer.unlockSpeaker();
    }
    if (speakerName) this.lastSpeaker = speakerName;
    if (this.bot) {
      this.bot.playChime("awake");
    }
    const started = this.wyoming.triggerListenNow({ wakeWordName: "button" });
    this._pushLog("action", speakerName || "Button", "Listening now...");
    this.syncChatCard(true);
    return { ok: started };
  }

  setWakeWordEnabled(enabled) {
    this.wakeWordEnabled = Boolean(enabled);
    this.wyoming.setWakeWordEnabled(this.wakeWordEnabled);
    this.syncChatCard(false);
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.bot && this.bot.inVoice) {
      this.bot.setVoiceMuted(this.muted);
    }
    this.syncChatCard(false);
  }

  stopAudio() {
    if (this.bot) {
      this.bot.stopAudio();
    }
    if (this._awaitingAudioDoneForWyoming) {
      this._awaitingAudioDoneForWyoming = false;
      this.wyoming.notifyAudioPlayed();
    }
    this.syncChatCard(false);
  }

  sendRoomChat(text, { title = "", speaker = "Home Assistant" } = {}) {
    const body = String(text ?? "").trim();
    if (!body) {
      return { ok: false, error: "Message is empty" };
    }
    if (!this.bot || this.roomState !== "connected") {
      this._pushLog("error", speaker, "Cannot post chat message — not connected to a room");
      return { ok: false, error: "Not connected to a room" };
    }
    const heading = String(title || "").trim();
    const fullText = heading ? `${heading}\n${body}` : body;
    const chunks = splitChatChunks(fullText, 12000);
    const ids = [];
    for (const chunk of chunks) {
      const sent = this.bot.sendText(chunk);
      if (sent?.id) ids.push(sent.id);
    }
    const summary = heading || body.split("\n")[0].slice(0, 90);
    this._pushLog("chat", speaker, summary);
    return { ok: true, chunks: ids.length, ids };
  }

  async askText(question, { speakerName = "User" } = {}) {
    const clean = String(question || "").trim();
    if (!clean) throw new Error("Question is empty");
    this.lastSpeaker = speakerName;
    this.lastTranscript = clean;
    this._pushLog("user", speakerName, clean);
    this.syncChatCard(true);

    if (!this.haClient.authenticated) {
      this.lastReply = "Home Assistant WebSocket API is not configured — use voice or set HA_URL/HA_TOKEN.";
      this.syncChatCard(true);
      return { text: this.lastReply };
    }
    const res = await this.haClient.askConversation(clean, {
      conversationId: this.conversationId,
    });
    this.conversationId = res.conversationId;
    this.lastReply = res.text || "Done.";
    this._pushLog("assistant", "Home Assistant", this.lastReply);
    this.syncChatCard(true);
    return res;
  }

  _wireWyomingEvents() {
    this.wyoming.on("error", (err) => {
      const code = err?.code || "";
      if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED") {
        this._pushLog("system", "Wyoming", `Connection reset (${code})`);
        return;
      }
      this._pushLog("error", "Wyoming", err?.message || String(err));
    });
    this.wyoming.on("haConnected", () => {
      this._pushLog("system", "Wyoming", "Home Assistant connected");
      if (this.haClient.authenticated) {
        this.haClient.refreshWakeWordInfo().catch(() => {});
      }
      this.syncChatCard(false);
    });
    this.wyoming.on("haDisconnected", () => {
      this._pushLog("system", "Wyoming", "Home Assistant disconnected");
      this.syncChatCard(false);
    });
    this.wyoming.on("stateChange", () => {
      this.syncChatCard(false);
    });
    this.wyoming.on("wakeDetected", ({ name }) => {
      if (this.mixer) {
        this.mixer.lockToLastActiveSpeaker(2500);
        this.lastSpeaker = this.mixer.lastActivePeerName || this.lastSpeaker;
      }
      if (this.bot && !this.muted) {
        this.bot.playChime("awake");
      }
      this._pushLog("wake", this.lastSpeaker || "Voice", `Wake word detected (${name})`);
      this.syncChatCard(true);
    });
    this.wyoming.on("continueConversation", () => {
      if (this.bot && !this.muted) {
        this.bot.playChime("awake");
      }
      this.syncChatCard(false);
    });
    this.wyoming.on("transcript", ({ text }) => {
      if (this.mixer) this.mixer.unlockSpeaker();
      this.lastTranscript = text;
      if (text) {
        this._pushLog("user", this.lastSpeaker || "Voice", text);
      }
      this.syncChatCard(true);
    });
    this.wyoming.on("handled", ({ text }) => {
      if (text) {
        this.lastReply = text;
        this._pushLog("assistant", "Home Assistant", text);
      }
      this.syncChatCard(true);
    });
    this.wyoming.on("ttsStart", () => {
      if (this.mixer) this.mixer.unlockSpeaker();
      if (this.bot) {
        this.bot.stopAudio();
      }
      this._awaitingAudioDoneForWyoming = true;
    });
    this.wyoming.on("ttsAudio", ({ buffer, rate, channels }) => {
      if (this.bot && !this.muted && buffer && buffer.length > 0) {
        this.bot.pushPcmBytes(buffer, { sampleRate: rate || VOICE_SAMPLE_RATE, channels: channels || 1 });
      }
    });
    this.wyoming.on("ttsStop", () => {
      if (this.bot && this.bot.isPlayingAudio()) {
        this.bot.markAudioStreamEnd();
      } else if (this._awaitingAudioDoneForWyoming) {
        this._awaitingAudioDoneForWyoming = false;
        this.wyoming.notifyAudioPlayed();
      }
    });
    this.wyoming.on("timerStarted", (t) => {
      const endsAtMs = Date.now() + t.totalSeconds * 1000;
      this.activeTimers.set(t.id, {
        id: t.id,
        name: t.name || t.commandText || "Timer",
        totalSeconds: t.totalSeconds,
        endsAtMs,
        paused: false,
        remainingSec: t.totalSeconds,
        commandText: t.commandText || "",
      });
      this._pushLog("timer", "Timer", `Started "${t.name || "Timer"}" (${t.totalSeconds}s)`);
      this.syncChatCard(true);
    });
    this.wyoming.on("timerUpdated", (t) => {
      const prev = this.activeTimers.get(t.id);
      if (!prev) return;
      prev.paused = !t.isActive;
      prev.remainingSec = t.totalSeconds;
      if (t.isActive) {
        prev.endsAtMs = Date.now() + t.totalSeconds * 1000;
      }
      this.syncChatCard(true);
    });
    this.wyoming.on("timerCancelled", ({ id }) => {
      const prev = this.activeTimers.get(id);
      this.activeTimers.delete(id);
      if (prev) {
        this._pushLog("timer", "Timer", `Cancelled "${prev.name}"`);
      }
      this.syncChatCard(false);
    });
    this.wyoming.on("timerFinished", ({ id }) => {
      const prev = this.activeTimers.get(id);
      this.activeTimers.delete(id);
      const label = prev?.name || "Timer";
      this._pushLog("timer", "Timer", `Finished "${label}"`);
      if (this.bot && !this.muted) {
        this.bot.playChime("timer", { amplitude: 0.3 });
      }
      this.lastReply = `Timer finished: ${label}`;
      this.syncChatCard(true);
    });
    this.wyoming.on("pipelineError", ({ code, text }) => {
      if (this.mixer) this.mixer.unlockSpeaker();
      if (code !== "stt-no-text-recognized") {
        this._pushLog("error", "Assist", `${code}: ${text || "Pipeline error"}`);
        if (this.bot && !this.muted) {
          this.bot.playChime("error");
        }
      }
      this.syncChatCard(false);
    });
  }

  _onRoomMessage(msg) {
    if (msg.type !== "chat" || typeof msg.payload?.text !== "string") return;
    const raw = msg.payload.text.trim();
    const lower = raw.toLowerCase();
    if (lower === "!ha" || lower === "!assist") {
      this.controlMsgId = null;
      this.syncChatCard(true);
    } else if (lower === "!listen" || lower === "!ask") {
      this.triggerListenNow({ speakerPeerId: msg.author, speakerName: msg.authorName });
    } else if (lower.startsWith("!ha ") || lower.startsWith("!assist ")) {
      const q = raw.replace(/^!(ha|assist)\s+/i, "").trim();
      if (q) {
        this.askText(q, { speakerName: msg.authorName }).catch((err) => {
          this._pushLog("error", "Assist", err.message);
        });
      }
    }
  }

  _onRoomInteraction(ev) {
    if (ev.mode !== "action") return;
    const id = String(ev.actionId || "");
    if (id === "ha:listen") {
      this.triggerListenNow({ speakerPeerId: ev.from, speakerName: ev.fromName });
    } else if (id === "ha:toggle_wake") {
      this.setWakeWordEnabled(!this.wakeWordEnabled);
    } else if (id === "ha:toggle_mute") {
      this.setMuted(!this.muted);
    } else if (id === "ha:stop_audio") {
      this.stopAudio();
    } else if (id === "ha:ask_input") {
      const q = String(ev.value || "").trim();
      if (q) {
        this.askText(q, { speakerName: ev.fromName }).catch((err) => {
          this._pushLog("error", "Assist", err.message);
        });
      }
    } else if (id.startsWith("ha:tl:")) {
      const rest = id.slice("ha:tl:".length);
      const firstColon = rest.indexOf(":");
      if (firstColon > 0) {
        const action = rest.slice(0, firstColon);
        const afterAction = rest.slice(firstColon + 1);
        const secondColon = afterAction.indexOf(":");
        if (secondColon > 0) {
          const entityId = afterAction.slice(0, secondColon);
          const timerId = afterAction.slice(secondColon + 1);
          if (entityId && timerId) {
            let op = null;
            if (action === "pause") op = this.haClient.pauseTimerListTimer(entityId, timerId);
            else if (action === "unpause") op = this.haClient.unpauseTimerListTimer(entityId, timerId);
            else if (action === "add60") op = this.haClient.addTimerListTime(entityId, timerId, 60);
            else if (action === "cancel") op = this.haClient.cancelTimerListTimer(entityId, timerId);
            if (op) {
              op.catch((err) => {
                this._pushLog("error", "Timer", err?.message || String(err));
                this.syncChatCard(false);
              });
            }
          }
        }
      }
    } else if (id.startsWith("ha:timer:dismiss:")) {
      const tid = id.slice("ha:timer:dismiss:".length);
      this.activeTimers.delete(tid);
      this.syncChatCard(false);
    } else if (id === "ha:refresh") {
      this.syncChatCard(true);
    } else if (id === "ha:disconnect") {
      this.disconnectRoom().catch(() => {});
    }
  }

  getAllActiveTimers(nowMs = Date.now()) {
    const tlTimers = this.haClient.getTimerListTimers(nowMs);
    const seenIds = new Set(tlTimers.map((t) => t.id));
    const merged = tlTimers.slice();
    for (const t of this.activeTimers.values()) {
      if (seenIds.has(t.id)) continue;
      merged.push({
        id: t.id,
        name: t.name,
        totalSeconds: t.totalSeconds,
        endsAtMs: t.paused ? 0 : t.endsAtMs,
        paused: Boolean(t.paused),
        remainingSec: t.paused ? t.remainingSec : Math.max(0, Math.ceil((t.endsAtMs - nowMs) / 1000)),
        commandText: t.commandText || "",
        source: "wyoming",
        entityId: "",
        sourceLabel: "",
        supportedFeatures: 0,
      });
    }
    merged.sort((a, b) => {
      if (a.paused !== b.paused) return a.paused ? 1 : -1;
      if (!a.paused) {
        const endDiff = (a.endsAtMs || 0) - (b.endsAtMs || 0);
        if (endDiff !== 0) return endDiff;
      }
      const remDiff = (a.remainingSec || 0) - (b.remainingSec || 0);
      if (remDiff !== 0) return remDiff;
      return String(a.id).localeCompare(String(b.id));
    });
    return merged;
  }

  buildChatCard() {
    const wyConnected = this.wyoming.isReady();
    const mode = this.wyoming.pipelineMode;
    let badge = "WAITING HA";
    let color = "ochre";
    if (!wyConnected) {
      badge = "WAITING HA";
      color = "ochre";
    } else if (this.muted) {
      badge = "MUTED";
      color = "coral";
    } else if (mode === "asr") {
      badge = "LISTENING";
      color = "mint";
    } else if (mode === "processing") {
      badge = "THINKING";
      color = "cyan";
    } else if (mode === "speaking") {
      badge = "SPEAKING";
      color = "cobalt";
    } else if (mode === "wake") {
      badge = "WAKE READY";
      color = "cobalt";
    } else {
      badge = "BUTTON READY";
      color = "ink";
    }

    const voicePeers = this.bot
      ? this.bot.getPeers().filter((p) => p.inVoice).length
      : 0;

    const allTimers = this.getAllActiveTimers();

    const blocks = [
      {
        type: "stats",
        items: [
          { label: "Satellite", value: wyConnected ? "Online" : "Offline", accent: wyConnected ? "mint" : "coral" },
          {
            label: "Wake Word",
            value: this.wakeWordEnabled ? (this.wakeWordLabel || "Active") : "Off",
            accent: this.wakeWordEnabled ? "cobalt" : "ink",
          },
          { label: "Timers", value: String(allTimers.length), accent: allTimers.length > 0 ? "ochre" : "ink" },
          { label: "In Voice", value: String(voicePeers), accent: "cyan" },
        ],
      },
    ];

    const cardTimers = [];
    for (const timer of allTimers) {
      const actions = [];
      let blockActionId = "";
      if (timer.source === "timer_list") {
        const feats = Number(timer.supportedFeatures) || 0;
        if (feats & TIMER_LIST_FEATURES.PAUSE_TIMER) {
          actions.push({
            id: `ha:tl:${timer.paused ? "unpause" : "pause"}:${timer.entityId}:${timer.id}`,
            label: timer.paused ? "Resume" : "Pause",
            icon: timer.paused ? "play" : "pause",
            style: timer.paused ? "success" : "secondary",
          });
        }
        if (feats & TIMER_LIST_FEATURES.ADD_TIME) {
          actions.push({
            id: `ha:tl:add60:${timer.entityId}:${timer.id}`,
            label: "+1m",
            icon: "plus",
            style: "secondary",
          });
        }
        if (feats & TIMER_LIST_FEATURES.CANCEL_TIMER) {
          blockActionId = `ha:tl:cancel:${timer.entityId}:${timer.id}`;
          actions.push({
            id: blockActionId,
            label: "Cancel",
            icon: "close",
            style: "danger",
          });
        }
      } else {
        blockActionId = `ha:timer:dismiss:${timer.id}`;
        actions.push({
          id: blockActionId,
          label: "Dismiss",
          icon: "close",
          style: "secondary",
        });
      }

      blocks.push({
        type: "timer",
        label: timer.sourceLabel ? `${timer.name} · ${timer.sourceLabel}` : timer.name,
        icon: "timer",
        totalSec: timer.totalSeconds,
        endsAtMs: timer.paused ? 0 : timer.endsAtMs,
        paused: Boolean(timer.paused),
        remainingSec: timer.remainingSec,
        color: timer.paused ? "ochre" : "cobalt",
        actionId: blockActionId || undefined,
      });

      cardTimers.push({
        id: timer.source === "timer_list" ? `${timer.entityId}:${timer.id}` : timer.id,
        label: timer.name,
        source: timer.sourceLabel || "",
        icon: "timer",
        totalSec: timer.totalSeconds,
        remainingSec: timer.remainingSec,
        endsAtMs: timer.paused ? 0 : timer.endsAtMs,
        paused: Boolean(timer.paused),
        color: timer.paused ? "ochre" : "cobalt",
        actions: actions.slice(0, 3),
      });
    }

    if (this.lastTranscript || this.lastReply) {
      const lines = [];
      if (this.lastTranscript) {
        lines.push(`**${this.lastSpeaker || "Voice"}:** ${this.lastTranscript}`);
      }
      if (this.lastReply) {
        lines.push(`**Assist:** ${this.lastReply}`);
      }
      blocks.push({
        type: "callout",
        tone: "info",
        icon: "mic",
        title: "Last Exchange",
        text: lines.join("\n"),
      });
    }

    if (this.haClient.authenticated) {
      blocks.push({
        type: "input",
        id: "ha:ask_input",
        actionId: "ha:ask_input",
        placeholder: "Ask Home Assistant (entities, timers, questions)...",
        submitLabel: "Ask",
      });
    }

    let voiceStatus = "Button Only";
    let voiceStatusIcon = "mic";
    if (!wyConnected) {
      voiceStatus = "Waiting HA";
      voiceStatusIcon = this.muted ? "mic-off" : "mic";
    } else if (this.muted) {
      voiceStatus = "Muted";
      voiceStatusIcon = "mic-off";
    } else if (mode === "asr") {
      voiceStatus = "Listening...";
      voiceStatusIcon = "mic";
    } else if (mode === "processing") {
      voiceStatus = "Thinking...";
      voiceStatusIcon = "mic";
    } else if (mode === "speaking") {
      voiceStatus = "Speaking";
      voiceStatusIcon = "volume";
    } else if (this.wakeWordEnabled && this.wakeWordLabel) {
      voiceStatus = this.wakeWordLabel;
      voiceStatusIcon = "bolt";
    } else if (this.wakeWordEnabled) {
      voiceStatus = "Wake Ready";
      voiceStatusIcon = "mic";
    } else {
      voiceStatus = "Button Only";
      voiceStatusIcon = "mic";
    }

    const footerHint =
      this.wakeWordEnabled && this.wakeWordLabel
        ? `Say "${this.wakeWordLabel}" or click Listen Now`
        : "Say wake word or click Listen Now";

    return {
      subtitle: "HOME ASSISTANT VOICE",
      title: this.options.name,
      icon: "home",
      badge,
      color,
      blocks,
      timers: cardTimers,
      voiceControls: {
        status: voiceStatus,
        statusIcon: voiceStatusIcon,
        statusTone: color,
        buttons: [
          { id: "ha:listen", label: "Listen Now", icon: "mic", style: "primary", disabled: !wyConnected },
          {
            id: "ha:toggle_wake",
            label: this.wakeWordEnabled ? "Wake: On" : "Wake: Off",
            icon: "bolt",
            style: this.wakeWordEnabled ? "success" : "secondary",
          },
          { id: "ha:stop_audio", label: "Stop", icon: "close", style: "secondary" },
        ],
      },
      buttons: [
        {
          kind: "grid",
          buttons: [
            { id: "ha:listen", label: "Listen Now", icon: "mic", style: "primary", disabled: !wyConnected },
            {
              id: "ha:toggle_wake",
              label: this.wakeWordEnabled ? "Wake: On" : "Wake: Off",
              icon: "bolt",
              style: this.wakeWordEnabled ? "success" : "secondary",
            },
            {
              id: "ha:toggle_mute",
              label: this.muted ? "Unmute" : "Mute",
              icon: this.muted ? "mic-off" : "volume",
              style: this.muted ? "warning" : "secondary",
            },
            { id: "ha:stop_audio", label: "Stop Audio", icon: "close", style: "secondary" },
          ],
        },
        {
          kind: "footer",
          buttons: [
            { id: "ha:refresh", label: "Refresh", icon: "refresh", style: "secondary" },
            { id: "ha:disconnect", label: "Disconnect", icon: "trash", style: "danger" },
          ],
        },
      ],
      footer: `Wyoming :${this.wyoming.port} · ${footerHint}`,
    };
  }

  syncChatCard(createIfMissing = false) {
    if (!this.bot || this.roomState !== "connected") return;
    const card = this.buildChatCard();
    try {
      if (this.controlMsgId) {
        this.bot.updateBotMessage(this.controlMsgId, card);
      } else if (createIfMissing) {
        const sent = this.bot.sendBotMessage(card);
        this.controlMsgId = sent.id;
      }
    } catch {
      // ignore transient edit errors during disconnect
    }
  }

  getApiState() {
    const timers = this.getAllActiveTimers();
    return {
      roomState: this.roomState,
      roomError: this.roomError,
      roomName: this.bot?.activeRoom?.name || "",
      inVoice: Boolean(this.bot?.inVoice),
      muted: this.muted,
      wakeWordEnabled: this.wakeWordEnabled,
      wakeWord: {
        id: this.wakeWordId,
        label: this.wakeWordLabel,
        pipelineName: this.pipelineName,
      },
      peers: this.bot ? this.bot.getPeers() : [],
      wyoming: {
        host: this.wyoming.host,
        port: this.wyoming.port,
        name: this.wyoming.name,
        area: this.wyoming.area,
        connected: this.wyoming.isConnected(),
        ready: this.wyoming.isReady(),
        mode: this.wyoming.pipelineMode,
      },
      homeAssistant: this.haClient.getStatus(),
      timerLists: this.haClient.getTimerLists(),
      audio: {
        lastRms: this.audioStats.lastRms,
        peakRms: this.audioStats.peakRms,
        activeFrames: this.audioStats.activeFrames,
        silenceFrames: this.audioStats.silenceFrames,
        underrunCount: this.mixer ? this.mixer.underrunCount : this.audioStats.underrunCount,
        bufferedFrames: this.mixer ? this.mixer.getBufferedFrames() : this.audioStats.bufferedFrames,
      },
      timers,
      lastTranscript: this.lastTranscript,
      lastReply: this.lastReply,
      recentLog: this.recentLog.slice(-16),
    };
  }

  _pushLog(kind, speaker, text) {
    this.recentLog.push({
      ts: new Date().toISOString(),
      kind,
      speaker,
      text: String(text || ""),
    });
    if (this.recentLog.length > 40) {
      this.recentLog.shift();
    }
  }

  _startUiServer() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handleHttpRequest(req, res).catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
        });
      });
      this.uiServer = server;
      server.once("error", reject);
      server.listen(this.options.uiPort, this.options.uiHost, () => {
        const addr = server.address();
        const port = addr && typeof addr === "object" ? addr.port : this.options.uiPort;
        resolve({ host: this.options.uiHost, port });
      });
    });
  }

  async _readJsonBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  }

  async _handleHttpRequest(req, res) {
    const urlPath = (req.url || "/").split("?")[0];
    const sendJson = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj));
    };

    if (req.method === "GET" && (urlPath === "/" || urlPath === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderControlPanelHtml());
      return;
    }
    if (req.method === "GET" && urlPath.endsWith("/api/status")) {
      sendJson(200, { ok: true, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/connect")) {
      const body = await this._readJsonBody(req);
      const ready = await this.connectRoom(body.roomLink, body.passphrase || "");
      if (body.syncHelper && this.haClient.authenticated) {
        await this.haClient.setRoomHelperValue(body.roomLink).catch(() => {});
      }
      sendJson(200, { ok: true, ready, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/disconnect")) {
      await this.disconnectRoom();
      sendJson(200, { ok: true, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/listen")) {
      const out = this.triggerListenNow({ speakerName: "Control Panel" });
      sendJson(out.ok ? 200 : 409, { ...out, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/wake")) {
      const body = await this._readJsonBody(req);
      this.setWakeWordEnabled(Boolean(body.enabled));
      sendJson(200, { ok: true, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/mute")) {
      const body = await this._readJsonBody(req);
      this.setMuted(Boolean(body.muted));
      sendJson(200, { ok: true, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/stop-audio")) {
      this.stopAudio();
      sendJson(200, { ok: true, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/ask")) {
      const body = await this._readJsonBody(req);
      const reply = await this.askText(body.text, { speakerName: "Control Panel" });
      sendJson(200, { ok: true, reply, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/chat")) {
      const body = await this._readJsonBody(req);
      const out = this.sendRoomChat(body.message ?? body.text, {
        title: body.title || "",
        speaker: "Control Panel",
      });
      const statusCode = out.ok ? 200 : out.error === "Message is empty" ? 400 : 409;
      sendJson(statusCode, { ...out, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/timer/create")) {
      const body = await this._readJsonBody(req);
      let entityId = String(body.entityId || "").trim();
      if (!entityId) {
        const creatable = this.haClient
          .getTimerLists()
          .find((tl) => tl.available && (tl.supportedFeatures & TIMER_LIST_FEATURES.CREATE_TIMER));
        entityId = creatable?.entityId || "";
      }
      if (!entityId) {
        sendJson(400, { ok: false, error: "No available timer_list entity supports create_timer" });
        return;
      }
      try {
        await this.haClient.createTimerListTimer(entityId, {
          name: body.name || "",
          duration: body.duration,
        });
        sendJson(200, { ok: true, state: this.getApiState() });
      } catch (err) {
        sendJson(400, { ok: false, error: err?.message || String(err) });
      }
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/timer/pause")) {
      const body = await this._readJsonBody(req);
      try {
        await this.haClient.pauseTimerListTimer(body.entityId, body.timerId);
        sendJson(200, { ok: true, state: this.getApiState() });
      } catch (err) {
        sendJson(400, { ok: false, error: err?.message || String(err) });
      }
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/timer/unpause")) {
      const body = await this._readJsonBody(req);
      try {
        await this.haClient.unpauseTimerListTimer(body.entityId, body.timerId);
        sendJson(200, { ok: true, state: this.getApiState() });
      } catch (err) {
        sendJson(400, { ok: false, error: err?.message || String(err) });
      }
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/timer/add-time")) {
      const body = await this._readJsonBody(req);
      try {
        await this.haClient.addTimerListTime(body.entityId, body.timerId, body.duration ?? 60);
        sendJson(200, { ok: true, state: this.getApiState() });
      } catch (err) {
        sendJson(400, { ok: false, error: err?.message || String(err) });
      }
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/timer/cancel")) {
      const body = await this._readJsonBody(req);
      try {
        const entityId = String(body.entityId || "").trim();
        const timerId = String(body.timerId || "").trim();
        if (entityId) {
          await this.haClient.cancelTimerListTimer(entityId, timerId);
        } else if (timerId && this.activeTimers.has(timerId)) {
          this.activeTimers.delete(timerId);
          this.syncChatCard(false);
        } else {
          throw new Error("entityId and timerId are required");
        }
        sendJson(200, { ok: true, state: this.getApiState() });
      } catch (err) {
        sendJson(400, { ok: false, error: err?.message || String(err) });
      }
      return;
    }

    sendJson(404, { ok: false, error: "Not found" });
  }
}

function renderControlPanelHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>p2p-direct · Home Assistant Voice Control Panel</title>
<style>
  :root {
    --bg: #f6f5f0; --panel: #ffffff; --ink: #111111; --muted: #575757;
    --rule: #111111; --cobalt: #0057ff; --mint: #00a86b; --ochre: #e5a100; --coral: #e53935;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111214; --panel: #191b1f; --ink: #f4f4f0; --muted: #a0a4ad; --rule: #f4f4f0;
    }
  }
  * { box-sizing: border-box; border-radius: 0 !important; box-shadow: none !important; }
  body { margin: 0; padding: 18px; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; display: grid; gap: 14px; }
  .card { background: var(--panel); border: 2px solid var(--rule); border-left: 6px solid var(--cobalt); padding: 14px; display: grid; gap: 12px; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 17px; letter-spacing: 0.04em; text-transform: uppercase; }
  .sub { font: 700 11px/1 monospace; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
  .badge { font: 700 11px/1 monospace; padding: 5px 8px; border: 2px solid var(--rule); text-transform: uppercase; }
  .badge.ok { background: var(--mint); color: #fff; }
  .badge.warn { background: var(--ochre); color: #111; }
  .badge.err { background: var(--coral); color: #fff; }
  .grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .stat { border: 1.5px solid var(--rule); padding: 8px; }
  .stat b { display: block; font: 700 10px/1 monospace; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
  .stat span { font: 700 13px/1.2 monospace; }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
  .btns { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  input, select { width: 100%; padding: 9px 10px; border: 2px solid var(--rule); background: var(--bg); color: var(--ink); font: 13px monospace; }
  button { padding: 9px 12px; border: 2px solid var(--rule); background: var(--panel); color: var(--ink); font: 700 12px/1 monospace; text-transform: uppercase; cursor: pointer; }
  button.primary { background: var(--cobalt); color: #fff; }
  button.success { background: var(--mint); color: #fff; }
  button.danger { background: var(--coral); color: #fff; }
  button.sm { padding: 5px 8px; font-size: 11px; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .log { border: 1.5px solid var(--rule); padding: 8px; max-height: 200px; overflow: auto; font: 12px/1.5 monospace; background: var(--bg); }
  .timers-wrap { display: grid; gap: 8px; }
  .timer { border: 1.5px solid var(--rule); border-left: 5px solid var(--cobalt); padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; font: 700 12px monospace; }
  .timer.paused { border-left-color: var(--ochre); }
  .timer-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .timer-src { font: 700 10px/1 monospace; padding: 3px 6px; border: 1px solid var(--rule); color: var(--muted); text-transform: uppercase; }
  .timer-right { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .timer-clock { font: 700 14px/1 monospace; font-variant-numeric: tabular-nums; margin-right: 4px; }
  .timer-create { display: grid; grid-template-columns: 1fr 110px auto; gap: 8px; }
  .timer-create.has-select { grid-template-columns: minmax(120px, 160px) 1fr 100px auto; }
  .hidden { display: none !important; }
  @media (max-width: 600px) { .grid4, .btns { grid-template-columns: repeat(2, minmax(0, 1fr)); } .timer-create, .timer-create.has-select { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="head">
      <div>
        <div class="sub">p2p-direct · Home Assistant Voice Satellite</div>
        <h1>Room Voice Bridge</h1>
      </div>
      <div id="status-badge" class="badge warn">STANDBY</div>
    </div>
    <div class="grid4">
      <div class="stat"><b>Room</b><span id="st-room">—</span></div>
      <div class="stat"><b>Wyoming</b><span id="st-wy">—</span></div>
      <div class="stat"><b>Pipeline</b><span id="st-mode">idle</span></div>
      <div class="stat"><b>HA Helper</b><span id="st-ha">—</span></div>
    </div>
    <input id="room-link" placeholder="Paste https://voice.dequ.org/#room=P2P1:... link" />
    <div class="row">
      <input id="room-pass" type="password" placeholder="Optional room passphrase" />
      <div style="display:flex;gap:8px;">
        <button id="btn-connect" class="primary">Connect</button>
        <button id="btn-disconnect" class="danger">Leave</button>
      </div>
    </div>
    <div class="btns">
      <button id="btn-listen" class="success">Listen Now</button>
      <button id="btn-wake">Wake: On</button>
      <button id="btn-mute">Mute</button>
      <button id="btn-stop">Stop Audio</button>
    </div>
    <div class="row">
      <input id="ask-input" placeholder="Ask Home Assistant (text fallback)..." />
      <button id="btn-ask" class="primary">Ask</button>
    </div>
    <div id="timer-create-bar" class="timer-create hidden">
      <select id="timer-entity" class="hidden" aria-label="Timer list"></select>
      <input id="timer-name" placeholder="Timer label (optional)..." />
      <input id="timer-duration" value="5m" placeholder="5m / 90s" />
      <button id="btn-timer-create" class="primary">Start Timer</button>
    </div>
    <div id="timers" class="timers-wrap"></div>
    <div id="log" class="log">Waiting for status...</div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let curState = null;
let lastTimersSig = "";

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
}

async function api(path, body) {
  const res = await fetch("./api/" + path, body !== undefined
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { method: "GET" });
  return res.json();
}

function renderTimers(s) {
  const lists = (s.timerLists || []).filter((tl) => tl.available && (tl.supportedFeatures & 1));
  const bar = $("timer-create-bar");
  const sel = $("timer-entity");
  if (lists.length > 0) {
    bar.classList.remove("hidden");
    const prevSel = sel.value;
    const optsHtml = lists.map((tl) => '<option value="' + esc(tl.entityId) + '">' + esc(tl.sourceLabel || tl.friendlyName || tl.entityId) + '</option>').join("");
    if (sel.innerHTML !== optsHtml) sel.innerHTML = optsHtml;
    if (prevSel && lists.some((tl) => tl.entityId === prevSel)) sel.value = prevSel;
    if (lists.length > 1) {
      sel.classList.remove("hidden");
      bar.classList.add("has-select");
    } else {
      sel.classList.add("hidden");
      bar.classList.remove("has-select");
    }
  } else {
    bar.classList.add("hidden");
  }

  const timers = s.timers || [];
  const sig = JSON.stringify(timers.map((t) => [t.entityId, t.id, t.name, t.sourceLabel, t.paused, t.endsAtMs, t.paused ? t.remainingSec : 0, t.supportedFeatures]));
  if (sig === lastTimersSig) {
    tickTimerClocks();
    return;
  }
  lastTimersSig = sig;
  const now = Date.now();
  $("timers").innerHTML = timers.map((t) => {
    const rem = t.paused ? t.remainingSec : Math.max(0, Math.ceil(((t.endsAtMs || 0) - now) / 1000));
    const f = Number(t.supportedFeatures) || 0;
    const isTl = t.source === "timer_list" && t.entityId;
    const btns = [];
    if (isTl && (f & 2)) {
      btns.push('<button type="button" class="sm ' + (t.paused ? 'success' : '') + '" data-t-act="' + (t.paused ? 'unpause' : 'pause') + '" data-t-ent="' + esc(t.entityId) + '" data-t-id="' + esc(t.id) + '">' + (t.paused ? 'Resume' : 'Pause') + '</button>');
    }
    if (isTl && (f & 8)) {
      btns.push('<button type="button" class="sm" data-t-act="add-time" data-t-ent="' + esc(t.entityId) + '" data-t-id="' + esc(t.id) + '">+1m</button>');
    }
    if ((isTl && (f & 4)) || !isTl) {
      btns.push('<button type="button" class="sm danger" data-t-act="cancel" data-t-ent="' + esc(t.entityId || '') + '" data-t-id="' + esc(t.id) + '">' + (isTl ? 'Cancel' : 'Dismiss') + '</button>');
    }
    return '<div class="timer' + (t.paused ? ' paused' : '') + '">' +
      '<div class="timer-meta"><span>' + esc(t.name) + '</span>' +
      (t.sourceLabel ? '<span class="timer-src">' + esc(t.sourceLabel) + '</span>' : '') +
      (t.paused ? '<span class="timer-src">PAUSED</span>' : '') +
      '</div><div class="timer-right"><span class="timer-clock" data-ends-at="' + (t.paused ? 0 : (t.endsAtMs || 0)) + '">' + fmtClock(rem) + '</span>' + btns.join('') + '</div></div>';
  }).join("");
}

function tickTimerClocks() {
  const now = Date.now();
  for (const el of $("timers").querySelectorAll(".timer-clock[data-ends-at]")) {
    const endsAt = Number(el.getAttribute("data-ends-at") || 0);
    if (endsAt > 0) {
      el.textContent = fmtClock(Math.max(0, Math.ceil((endsAt - now) / 1000)));
    }
  }
}

function render(s) {
  curState = s;
  const badge = $("status-badge");
  badge.textContent = (s.roomState || "standby").toUpperCase();
  badge.className = "badge " + (s.roomState === "connected" ? "ok" : s.roomState === "error" ? "err" : "warn");
  $("st-room").textContent = s.roomName || "Standby";
  $("st-wy").textContent = s.wyoming.ready ? "Online :" + s.wyoming.port : "Waiting :" + s.wyoming.port;
  $("st-mode").textContent = (s.wyoming.mode || "idle") + (s.wakeWord && s.wakeWord.label ? " · " + s.wakeWord.label : "");
  $("st-ha").textContent = s.homeAssistant.authenticated ? "Synced" : s.homeAssistant.configured ? "Connecting" : "Manual";
  $("btn-listen").disabled = !s.wyoming.ready;
  $("btn-wake").textContent = s.wakeWordEnabled ? (s.wakeWord && s.wakeWord.label ? "Wake: " + s.wakeWord.label : "Wake: On") : "Wake: Off";
  $("btn-mute").textContent = s.muted ? "Unmute" : "Mute";
  renderTimers(s);
  $("log").innerHTML = (s.recentLog || []).slice().reverse().map((e) =>
    '<div>[' + esc(e.ts.slice(11, 19)) + '] <b>' + esc(e.speaker) + '</b>: ' + esc(e.text) + '</div>'
  ).join("") || "No events yet.";
}

async function poll() {
  try {
    const out = await api("status");
    if (out.ok) render(out.state);
  } catch {}
}

$("timers").onclick = async (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest("button[data-t-act]") : null;
  if (!btn) return;
  const act = btn.getAttribute("data-t-act");
  const entityId = btn.getAttribute("data-t-ent") || "";
  const timerId = btn.getAttribute("data-t-id") || "";
  const payload = { entityId, timerId };
  if (act === "add-time") payload.duration = 60;
  const out = await api("timer/" + act, payload);
  if (out.state) render(out.state);
};

$("btn-timer-create").onclick = async () => {
  const duration = $("timer-duration").value.trim();
  if (!duration) return;
  const name = $("timer-name").value.trim();
  const entityId = $("timer-entity").value || "";
  const out = await api("timer/create", { entityId, name, duration });
  if (out.ok) $("timer-name").value = "";
  if (out.state) render(out.state);
};

$("btn-connect").onclick = async () => {
  const roomLink = $("room-link").value.trim();
  if (!roomLink) return;
  const out = await api("connect", { roomLink, passphrase: $("room-pass").value, syncHelper: true });
  if (out.state) render(out.state);
};
$("btn-disconnect").onclick = async () => {
  const out = await api("disconnect", {});
  if (out.state) render(out.state);
};
$("btn-listen").onclick = async () => {
  const out = await api("listen", {});
  if (out.state) render(out.state);
};
$("btn-wake").onclick = async () => {
  const out = await api("wake", { enabled: !(curState && curState.wakeWordEnabled) });
  if (out.state) render(out.state);
};
$("btn-mute").onclick = async () => {
  const out = await api("mute", { muted: !(curState && curState.muted) });
  if (out.state) render(out.state);
};
$("btn-stop").onclick = async () => {
  const out = await api("stop-audio", {});
  if (out.state) render(out.state);
};
$("btn-ask").onclick = async () => {
  const text = $("ask-input").value.trim();
  if (!text) return;
  $("ask-input").value = "";
  const out = await api("ask", { text });
  if (out.state) render(out.state);
};
poll();
setInterval(poll, 1500);
setInterval(tickTimerClocks, 1000);
</script>
</body>
</html>`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = parseHaCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "p2p-direct Home Assistant Voice Assistant Bot (Wyoming Satellite + Helper Watcher + Control Panel)",
        "",
        "Usage:",
        '  node bot/ha-assistant.mjs [--room "<room-url>"] [--ha-url "http://homeassistant.local:8123"] [--ha-token "..."]',
        "",
        "Options / Env:",
        "  --room, -r           Optional initial room link (P2P_ROOM); omit to control via HA helper or Control Panel",
        "  --passphrase, -p     Optional room passphrase (P2P_PASSPHRASE)",
        "  --name, -n           Display name in room (P2P_BOT_NAME, default: Home Assistant)",
        "  --wyoming-port       Wyoming Satellite TCP port (WYOMING_PORT, default: 10700)",
        "  --area               HA Area name reported by satellite (WYOMING_AREA, default: Voice Room)",
        "  --ui-port            Tiny Control Panel HTTP port (UI_PORT, default: 8787)",
        "  --ha-url             Home Assistant base URL (HA_URL, auto-detected inside HA Apps)",
        "  --ha-token           Long-Lived Access Token (HA_TOKEN or auto SUPERVISOR_TOKEN)",
        "  --room-helper        HA input_text entity to watch (HA_ROOM_HELPER, default: input_text.p2p_voice_room_link)",
        "  --passphrase-helper  Optional HA input_text for room passphrase (HA_PASSPHRASE_HELPER)",
        "  --no-wake-word          Disable always-on wake-word streaming (button activation only)",
        "  --timer-list-entities   Comma-separated allowlist of HA timer_list.* entities (HA_TIMER_LIST_ENTITIES)",
        "  --allowed-speakers      Comma-separated allowlist of speaker names/peerIds (ALLOWED_SPEAKERS)",
      ].join("\n")
    );
    process.exit(0);
  }

  const assistant = new HomeAssistantVoiceAssistant(args);
  assistant
    .start({ initialRoom: args.room, initialPassphrase: args.passphrase })
    .then(({ wyoming, ui }) => {
      console.log(`[ha-assistant] Wyoming Satellite listening on ${wyoming.host}:${wyoming.port}`);
      console.log(`[ha-assistant] Tiny Control Panel UI at http://${ui.host}:${ui.port}/`);
      if (args.haUrl) {
        console.log(`[ha-assistant] Watching HA helper "${args.roomHelper}" on ${args.haUrl}`);
      }
      if (args.room) {
        console.log(`[ha-assistant] Joined initial room`);
      } else {
        console.log(`[ha-assistant] Standby — paste a room link in the HA helper or Control Panel to connect`);
      }
    })
    .catch((err) => {
      console.error("[ha-assistant] Startup failed:", err.message);
      process.exit(1);
    });

  const shutdown = async () => {
    console.log("\n[ha-assistant] Shutting down...");
    await assistant.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
