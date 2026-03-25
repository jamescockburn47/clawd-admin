"""
Voice command routing for Clawd — used by POST /route-command on EVO X2.

Tier 1: fast regex/keyword rules (no network).
Tier 2: optional llama classifier on localhost :8081 for ambiguous text.
Default: action \"claude\" (full Pi + Claude pipeline).
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

import httpx

logger = logging.getLogger("command-router")

CLASSIFIER_URL = os.environ.get("EVO_CLASSIFIER_URL", "http://127.0.0.1:8081")

CLASSIFY_PROMPT = """Classify this WhatsApp message into exactly one category.
Categories: calendar, task, travel, email, recall, planning, conversational, general_knowledge, system

Rules:
- "calendar" = checking schedule, creating/updating events, what's on, free time
- "task" = todos, reminders, task lists
- "travel" = trains, hotels, flights, fares, accommodation, booking trips
- "email" = reading/sending/drafting emails, inbox, gmail
- "recall" = asking about something previously discussed, stored facts, "do you remember"
- "planning" = complex multi-step reasoning, organising something that needs tools AND context
- "conversational" = chat, banter, greetings, opinions, no tools needed
- "general_knowledge" = factual questions, current info, web lookups
- "system" = questions about the bot itself, architecture, status, services, voice pipeline, what's running

Reply with ONLY the category name. Nothing else."""

VALID_CATEGORIES = frozenset({
    "calendar", "task", "travel", "email", "recall", "planning",
    "conversational", "general_knowledge", "system",
})


def _strip_leading_filler(text: str) -> str:
    return re.sub(
        r"^(please|can you|could you|will you|hey|hi|okay|ok)[,.\s]+",
        "",
        text.strip(),
        flags=re.IGNORECASE,
    ).strip()


def _calendar_read_intent(lower: str) -> bool:
    if re.search(
        r"\b(add|create|book|schedule|move|cancel|update|change|reschedule|delete)\b",
        lower,
    ) and re.search(r"\b(event|meeting|appointment|calendar)\b", lower):
        return False
    return bool(
        re.search(
            r"\b(what'?s on|whats on|my calendar|upcoming|any meetings|meetings today|"
            r"events today|schedule for|my schedule|my diary|what am i doing|what have i got)\b",
            lower,
        )
    )


def route_by_keywords(text: str) -> dict[str, Any] | None:
    """Return a route dict or None to fall through to classifier / claude."""
    raw = _strip_leading_filler(text)
    if not raw:
        return None
    lower = raw.lower()

    # --- Status / help (tier 1) ---
    if re.search(
        r"\b(how are you running|system status|are you ok|status report|what errors|"
        r"how is the system|what(?:'s| is) running|what services)\b",
        lower,
    ):
        return {"action": "status", "tier": 1, "source": "keywords"}
    if re.search(
        r"\b(what can you do|show (?:me )?(?:the )?commands|voice commands|what commands)\b",
        lower,
    ):
        return {"action": "navigate", "params": {"panel": "help"}, "tier": 1, "source": "keywords"}

    # --- Navigate ---
    nav_map = [
        (r"\b(henry|weekends?|custody)\b", "henry"),
        (r"\b(calendar|diary)(?!\s+(add|create|book))\b", "calendar"),
        (r"\b(todos?|tasks?|reminders?|shopping list|to-?do)\b", "todos"),
        (r"\b(side gig|sidegig|work meetings?|client meetings?)\b", "sidegig"),
        (r"\b(email|inbox|gmail)\b", "email"),
        (r"\b(soul|personality)\b", "soul"),
        (r"\b(admin|settings)\b", "admin"),
    ]
    for pattern, panel in nav_map:
        if re.search(pattern, lower):
            return {"action": "navigate", "params": {"panel": panel}, "tier": 1, "source": "keywords"}

    # --- Refresh ---
    if re.search(r"\b(refresh|reload|update)\s+(the\s+)?(dashboard|screen|display)\b", lower) or lower in (
        "refresh",
        "reload dashboard",
    ):
        return {"action": "refresh", "tier": 1, "source": "keywords"}

    # --- Remember / note ---
    m = re.match(
        r"^(?:remember|note|don't forget|do not forget)\s+(?:that\s+)?(.{3,200})$",
        raw,
        re.IGNORECASE,
    )
    if m:
        note = m.group(1).strip().rstrip(".!?")
        if note:
            return {
                "action": "remember",
                "params": {"text": note},
                "tier": 1,
                "source": "keywords",
            }

    # --- Todo add ---
    m = re.match(
        r"^(?:add (?:a )?todo|todo:|new task:|add task:?)\s*(.{2,200})$",
        raw,
        re.IGNORECASE,
    )
    if m:
        return {"action": "todo_add", "params": {"text": m.group(1).strip()}, "tier": 1, "source": "keywords"}
    m = re.match(r"^remind me to\s+(.{2,200})$", raw, re.IGNORECASE)
    if m:
        return {"action": "todo_add", "params": {"text": m.group(1).strip()}, "tier": 1, "source": "keywords"}

    # --- Todo complete ---
    m = re.match(
        r"^(?:mark|complete|tick off|done with|finished with|scratch)\s+(?:the\s+)?(?:todo\s+)?(.{2,120})$",
        raw,
        re.IGNORECASE,
    )
    if m:
        return {
            "action": "todo_complete",
            "params": {"text": m.group(1).strip()},
            "tier": 1,
            "source": "keywords",
        }

    # --- Calendar list ---
    if _calendar_read_intent(lower):
        return {"action": "calendar_list", "tier": 1, "source": "keywords"}

    return None


async def classify_category(text: str) -> str | None:
    """Call local llama classifier; return normalized category or None."""
    snippet = (text or "").strip()[:500]
    if not snippet:
        return None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.post(
                f"{CLASSIFIER_URL}/v1/chat/completions",
                json={
                    "messages": [
                        {"role": "system", "content": CLASSIFY_PROMPT},
                        {"role": "user", "content": snippet},
                    ],
                    "temperature": 0,
                    "max_tokens": 10,
                    "cache_prompt": True,
                },
            )
        if res.status_code != 200:
            logger.warning("classifier HTTP %s", res.status_code)
            return None
        data = res.json()
        raw = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        cat = raw.strip().lower()
        cat = re.sub(r"[^a-z_]", "", cat)
        if cat in VALID_CATEGORIES:
            return cat
        logger.warning("classifier invalid category: %r", raw)
        return None
    except Exception as e:
        logger.warning("classifier error: %s", e)
        return None


def route_from_category(category: str, text: str) -> dict[str, Any]:
    lower = text.lower()
    if category == "system":
        return {"action": "status", "tier": 2, "source": "classifier"}
    if category == "calendar" and _calendar_read_intent(lower):
        return {"action": "calendar_list", "tier": 2, "source": "classifier"}
    return {"action": "claude", "tier": 3, "source": "classifier"}


async def route_voice_command_async(text: str) -> dict[str, Any]:
    """Full async route: keywords → classifier hint → claude."""
    kw = route_by_keywords(text)
    if kw:
        return kw

    cat = await classify_category(text)
    if cat:
        return route_from_category(cat, text)

    return {"action": "claude", "tier": 3, "source": "default"}
