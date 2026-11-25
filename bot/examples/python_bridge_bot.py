#!/usr/bin/env python3
"""
Minimal Python bot connecting to a p2p-direct room through `bot/bridge.mjs`.

1. Start the bridge:
     node bot/bridge.mjs --room "https://voice.dequ.org/#room=P2P1:..." --name "PyBot" --port 8765
2. Run this script (requires `pip install websockets`):
     python3 bot/examples/python_bridge_bot.py
"""

import asyncio
import json
import os
import websockets

BRIDGE_URL = os.environ.get("P2P_BRIDGE_URL", "ws://127.0.0.1:8765")


async def main():
    async with websockets.connect(BRIDGE_URL) as ws:
        print(f"Connected to local p2p-direct bridge at {BRIDGE_URL}")
        votes = {"yes": 0, "no": 0}

        def poll_card():
            return {
                "subtitle": "PYTHON BRIDGE BOT",
                "title": "Quick Room Poll",
                "badge": f"{votes['yes'] + votes['no']} VOTES",
                "color": "mint",
                "text": "Should we run Eidolons or play music next?",
                "fields": [
                    {"label": "Yes / Ready", "value": str(votes["yes"]), "inline": True},
                    {"label": "Not yet", "value": str(votes["no"]), "inline": True},
                ],
                "buttons": [
                    [
                        {"id": "vote:yes", "label": "Vote Yes", "style": "success"},
                        {"id": "vote:no", "label": "Vote No", "style": "danger"},
                        {"id": "voice:chime", "label": "Play Voice Chime", "style": "primary"},
                    ]
                ],
            }

        async for raw in ws:
            ev = json.loads(raw)
            kind = ev.get("event")

            if kind == "message":
                msg = ev["message"]
                text = (msg.get("payload") or {}).get("text", "").strip().lower()
                if text == "!poll":
                    await ws.send(json.dumps({"cmd": "send_bot_message", "card": poll_card()}))

            elif kind == "interaction":
                action_id = ev.get("actionId")
                if action_id == "vote:yes":
                    votes["yes"] += 1
                    await ws.send(json.dumps({
                        "cmd": "update_bot_message",
                        "targetId": ev["messageId"],
                        "card": poll_card(),
                    }))
                elif action_id == "vote:no":
                    votes["no"] += 1
                    await ws.send(json.dumps({
                        "cmd": "update_bot_message",
                        "targetId": ev["messageId"],
                        "card": poll_card(),
                    }))
                elif action_id == "voice:chime":
                    await ws.send(json.dumps({"cmd": "join_voice"}))
                    await ws.send(json.dumps({"cmd": "play_tone", "freqHz": 523.25, "durationMs": 700}))


if __name__ == "__main__":
    asyncio.run(main())
