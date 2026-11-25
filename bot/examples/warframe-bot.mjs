#!/usr/bin/env node
/**
 * Self-Hostable Warframe Worldstate Bot for p2p-direct (`voice.dequ.org`).
 *
 * Commands in room chat:
 *   !wf / !worldstate   — Open the interactive Warframe Worldstate dashboard
 *   !cetus              — Plains of Eidolon (Cetus) Day/Night cycle
 *   !vallis             — Orb Vallis Warm/Cold cycle
 *   !cambion            — Cambion Drift Fass/Vome cycle
 *   !fissures           — Active Void Fissures
 *   !sortie             — Today's Sortie missions
 *   !baro               — Baro Ki'Teer Void Trader status
 *
 * Clicking any button on the bot card updates the card live in place!
 *
 * Usage:
 *   node bot/examples/warframe-bot.mjs --room "https://voice.dequ.org/#room=P2P1:..."
 */

import { P2PBot } from "../sdk.mjs";
import { parseCliArgs } from "../bridge.mjs";

const API_BASE = "https://api.warframestat.us/pc";

async function fetchWorldstateEndpoint(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const resp = await fetch(`${API_BASE}/${endpoint}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

function navButtons(activeView) {
  const styleFor = (id) => (activeView === id ? "primary" : "secondary");
  return [
    [
      { id: "wf:cycles", label: "Open Worlds", style: styleFor("cycles") },
      { id: "wf:fissures", label: "Fissures", style: styleFor("fissures") },
      { id: "wf:sortie", label: "Sortie", style: styleFor("sortie") },
      { id: "wf:baro", label: "Baro", style: styleFor("baro") },
    ],
    [
      { id: `wf:refresh:${activeView}`, label: "Refresh", style: "success" },
      { id: "wf:lfg", label: "Squad Up!", style: "warning", mode: "reply", replyText: "Who wants to run this Warframe mission together?" },
      { id: "wf:dismiss", label: "Delete", style: "danger" },
    ],
  ];
}

async function buildWorldstateCard(view = "cycles") {
  const updatedFooter = `Warframe PC Worldstate · Updated ${new Date().toISOString().slice(11, 19)} UTC`;

  try {
    if (view === "cycles") {
      const [cetus, vallis, cambion] = await Promise.all([
        fetchWorldstateEndpoint("cetusCycle"),
        fetchWorldstateEndpoint("vallisCycle"),
        fetchWorldstateEndpoint("cambionCycle"),
      ]);
      const isNight = !cetus.isDay;
      return {
        subtitle: "WARFRAME WORLDSTATE",
        title: "Open World Cycles",
        badge: isNight ? "EIDOLON NIGHT" : "CETUS DAY",
        color: isNight ? "cobalt" : "ochre",
        text: "Live timers across Cetus, Orb Vallis, and Cambion Drift. Click a tab below to switch views.",
        fields: [
          {
            label: "Cetus (Plains)",
            value: `**${cetus.isDay ? "Day" : "Night"}** · ${cetus.timeLeft || "—"} left`,
            inline: true,
          },
          {
            label: "Orb Vallis",
            value: `**${vallis.isWarm ? "Warm" : "Cold"}** · ${vallis.timeLeft || "—"} left`,
            inline: true,
          },
          {
            label: "Cambion Drift",
            value: `**${String(cambion.state || cambion.active || "—").toUpperCase()}** · ${cambion.timeLeft || "—"} left`,
            inline: true,
          },
        ],
        buttons: navButtons("cycles"),
        footer: updatedFooter,
      };
    }

    if (view === "fissures") {
      const fissures = await fetchWorldstateEndpoint("fissures");
      const active = (Array.isArray(fissures) ? fissures : [])
        .filter((f) => !f.expired && !f.isStorm)
        .slice(0, 6);
      const fields = active.map((f) => ({
        label: `${f.tier || "Relic"}${f.isHard ? " · Steel Path" : ""}`,
        value: `**${f.missionType || "Mission"}** — ${f.node || "Unknown"} (${f.eta || "—"})`,
        inline: true,
      }));
      return {
        subtitle: "WARFRAME WORLDSTATE",
        title: "Active Void Fissures",
        badge: `${active.length} ACTIVE`,
        color: "mint",
        text: active.length > 0 ? "Top live Relic fissures right now:" : "No active fissures reported.",
        fields,
        buttons: navButtons("fissures"),
        footer: updatedFooter,
      };
    }

    if (view === "sortie") {
      const sortie = await fetchWorldstateEndpoint("sortie");
      const variants = Array.isArray(sortie.variants) ? sortie.variants : [];
      return {
        subtitle: "WARFRAME WORLDSTATE",
        title: `Daily Sortie — ${sortie.boss || "Boss"}`,
        badge: sortie.eta || "ACTIVE",
        color: "coral",
        text: `Faction: **${sortie.faction || "Unknown"}**`,
        fields: variants.map((v, idx) => ({
          label: `Stage ${idx + 1} · ${v.missionType || "Mission"}`,
          value: `${v.node || ""} — \`${v.modifier || ""}\``,
          inline: false,
        })),
        buttons: navButtons("sortie"),
        footer: updatedFooter,
      };
    }

    if (view === "baro") {
      const trader = await fetchWorldstateEndpoint("voidTrader");
      const active = Boolean(trader.active);
      return {
        subtitle: "WARFRAME WORLDSTATE",
        title: "Baro Ki'Teer (Void Trader)",
        badge: active ? "HERE NOW" : "AWAY",
        color: active ? "mint" : "cyan",
        text: active
          ? `Baro is at **${trader.location || "Relay"}** and leaves in **${trader.endString || "—"}**.`
          : `Next arrival at **${trader.location || "Relay"}** in **${trader.startString || "—"}**.`,
        fields: active && Array.isArray(trader.inventory)
          ? trader.inventory.slice(0, 6).map((item) => ({
              label: item.item || "Item",
              value: `${item.ducats ?? 0} Ducats · ${item.credits ?? 0} Cr`,
              inline: true,
            }))
          : [],
        buttons: navButtons("baro"),
        footer: updatedFooter,
      };
    }
  } catch (err) {
    return {
      subtitle: "WARFRAME WORLDSTATE",
      title: "Worldstate Unavailable",
      badge: "RETRY",
      color: "coral",
      text: `Could not fetch \`api.warframestat.us\`: ${err.message}`,
      buttons: navButtons(view),
      footer: updatedFooter,
    };
  }

  return buildWorldstateCard("cycles");
}

const args = parseCliArgs(process.argv.slice(2));
if (!args.room || args.help) {
  console.log('Usage: node bot/examples/warframe-bot.mjs --room "<room-invite-url>" [--passphrase "..."]');
  process.exit(args.help ? 0 : 1);
}

const bot = new P2PBot({
  roomLink: args.room,
  passphrase: args.passphrase,
  name: args.name === "P2PBot" ? "Ordis Worldstate" : args.name,
  relay: args.relay || undefined,
});

bot.on("ready", (info) => {
  console.log(`[warframe-bot] Online as "${info.authorName}" (${info.peerId}) in room "${info.room}"`);
  console.log("[warframe-bot] Type !wf, !cetus, !fissures, !sortie, or !baro in chat.");
});

bot.on("peerJoin", (p) => {
  console.log(`[warframe-bot] Connected to peer: ${p.authorName} (${p.peerId})`);
});

bot.on("message", async (msg) => {
  if (msg.type !== "chat" || !msg.payload || typeof msg.payload.text !== "string") return;
  const cmd = msg.payload.text.trim().toLowerCase();
  if (cmd === "!wf" || cmd === "!worldstate" || cmd === "!cetus" || cmd === "!vallis" || cmd === "!cambion") {
    bot.sendBotMessage(await buildWorldstateCard("cycles"));
  } else if (cmd === "!fissures") {
    bot.sendBotMessage(await buildWorldstateCard("fissures"));
  } else if (cmd === "!sortie") {
    bot.sendBotMessage(await buildWorldstateCard("sortie"));
  } else if (cmd === "!baro") {
    bot.sendBotMessage(await buildWorldstateCard("baro"));
  }
});

bot.on("interaction", async (ev) => {
  if (ev.mode !== "action") return;
  if (ev.actionId === "wf:dismiss") {
    bot.deleteMessage(ev.messageId);
    return;
  }
  if (ev.actionId === "wf:cycles" || ev.actionId === "wf:refresh:cycles") {
    bot.updateBotMessage(ev.messageId, await buildWorldstateCard("cycles"));
  } else if (ev.actionId === "wf:fissures" || ev.actionId === "wf:refresh:fissures") {
    bot.updateBotMessage(ev.messageId, await buildWorldstateCard("fissures"));
  } else if (ev.actionId === "wf:sortie" || ev.actionId === "wf:refresh:sortie") {
    bot.updateBotMessage(ev.messageId, await buildWorldstateCard("sortie"));
  } else if (ev.actionId === "wf:baro" || ev.actionId === "wf:refresh:baro") {
    bot.updateBotMessage(ev.messageId, await buildWorldstateCard("baro"));
  }
});

bot.connect().catch((err) => {
  console.error("[warframe-bot] Failed:", err.message);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await bot.disconnect();
  process.exit(0);
});
