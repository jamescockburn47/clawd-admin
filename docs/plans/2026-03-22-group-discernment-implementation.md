# Group Chat Discernment & Dream Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Clawd intelligent about when to speak in group chats, remember all conversations, and learn from negative reactions overnight.

**Architecture:** EVO 0.6B engagement classifier gates group responses. All group messages logged to JSONL. Overnight "dream mode" on EVO summarises the day. Dream memories injected into Claude context. Mute system + reactive soul proposals via DM.

**Tech Stack:** Node.js (ESM), llama.cpp OpenAI API (EVO classifier), Python (dream mode script), systemd timers.

**Design doc:** `docs/plans/2026-03-22-group-discernment-dream-mode-design.md`

---

### Task 1: Create engagement.js — Mute System + Negative Signal Detection

**Files:**
- Create: `src/engagement.js`

**Step 1: Create the engagement module with mute system and signal detection**

```javascript
// src/engagement.js — Group chat engagement gate
// Mute system, negative signal detection, engagement classifier
import config from './config.js';
import { classifyViaEvo } from './evo-llm.js';
import { getRecentMessages } from './buffer.js';
import logger from './logger.js';

// --- Mute system ---
// Map<groupJid, muteExpiresAt>
const muteTimers = new Map();

const MUTE_TRIGGERS = /\b(shut\s*up|be\s*quiet|go\s*quiet|stay\s*out|stop\s*talking|silence|mute)\b/i;
const BOT_NAMES_PATTERN = /\b(clawd|clawdbot|claude)\b/i;

export function isMuteTrigger(text) {
  if (!text) return false;
  // Must mention bot name AND contain a mute trigger
  return BOT_NAMES_PATTERN.test(text) && MUTE_TRIGGERS.test(text);
}

export function activateMute(groupJid) {
  const duration = config.groupMuteDurationMs || 600000; // 10 min default
  const expiresAt = Date.now() + duration;
  muteTimers.set(groupJid, expiresAt);
  logger.info({ groupJid, durationMs: duration, expiresAt: new Date(expiresAt).toISOString() }, 'group muted');
}

export function isMuted(groupJid) {
  const expiresAt = muteTimers.get(groupJid);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    muteTimers.delete(groupJid);
    logger.info({ groupJid }, 'mute expired');
    return false;
  }
  return true;
}

export function clearMute(groupJid) {
  muteTimers.delete(groupJid);
}

// --- Negative signal detection ---
const NEGATIVE_PATTERNS = [
  { pattern: /\b(shut\s*up|be\s*quiet|go\s*quiet|stop\s*talking|nobody\s*asked\s*(you|clawd)|stay\s*out)\b/i, type: 'told_off' },
  { pattern: /\b(lol\s*clawd|clawd\s*lol|haha\s*clawd|clawd.*overestimate|clawd.*monster)\b/i, type: 'mocked' },
  { pattern: /\b(no\s*clawd|wrong\s*clawd|that'?s\s*(not\s*right|wrong|incorrect)|actually\s*clawd)\b/i, type: 'corrected' },
];

export function detectNegativeSignal(text) {
  if (!text) return null;
  for (const { pattern, type } of NEGATIVE_PATTERNS) {
    if (pattern.test(text)) {
      return { type, matched: text.match(pattern)?.[0] };
    }
  }
  return null;
}

// --- Engagement classifier ---

const ENGAGEMENT_PROMPT = `You are Clawd, an AI assistant in a WhatsApp group chat.
You can see the recent conversation.

Recent conversation:
{CONTEXT}

New message from {SENDER}: {MESSAGE}

Should you respond? Answer ONLY "respond" or "silent".

Respond when:
- Someone asks a question you can genuinely answer
- Someone asks for your opinion or input
- You have useful factual information nobody else has provided
- Someone is confused and you can concretely help

Stay silent when:
- Humans are talking to each other
- The question was already answered by someone
- You'd just be agreeing or echoing
- Nobody asked for your input on this topic`;

export async function shouldEngage(groupJid, senderName, messageText) {
  // Build context from recent buffer
  const recent = getRecentMessages(groupJid);
  const contextLines = recent.slice(-8).map(msg => {
    const name = msg.isBot ? 'Clawd (you)' : msg.senderName;
    return `${name}: ${msg.text || '[media]'}`;
  });
  const context = contextLines.join('\n') || '(no recent messages)';

  const prompt = ENGAGEMENT_PROMPT
    .replace('{CONTEXT}', context)
    .replace('{SENDER}', senderName)
    .replace('{MESSAGE}', messageText);

  try {
    const result = await classifyViaEvo(messageText, prompt);
    const decision = (result || '').trim().toLowerCase();
    const engage = decision === 'respond';
    logger.info({ groupJid, sender: senderName, decision: engage ? 'respond' : 'silent', raw: result }, 'engagement classified');
    return engage;
  } catch (err) {
    logger.warn({ err: err.message }, 'engagement classifier failed, defaulting to silent');
    return false; // fail-silent in groups
  }
}
```

**Step 2: Verify syntax**

Run: `node -c src/engagement.js`
Expected: No syntax errors

**Step 3: Commit**

```bash
git add src/engagement.js
git commit -m "feat: add engagement.js — mute system, negative signal detection, engagement classifier"
```

---

### Task 2: Add config for mute duration

**Files:**
- Modify: `src/config.js:10-65`

**Step 1: Add groupMuteDurationMs to config object**

After the `briefingTime` line (line 60), add:

```javascript
  // Group engagement
  groupMuteDurationMs: parseInt(process.env.GROUP_MUTE_DURATION_MS) || 600000, // 10 min
  engagementClassifierEnabled: process.env.ENGAGEMENT_CLASSIFIER_ENABLED !== 'false',
  dreamModeEnabled: process.env.DREAM_MODE_ENABLED !== 'false',
```

**Step 2: Commit**

```bash
git add src/config.js
git commit -m "feat: add group engagement config (mute duration, classifier toggle, dream mode toggle)"
```

---

### Task 3: Modify trigger.js — Return passive mode for all group messages

**Files:**
- Modify: `src/trigger.js`

**Step 1: Replace the current trigger logic**

The current file returns `respond: false` for unmentioned group messages. Change it to return `respond: true, mode: 'passive'` for all group messages in the configured group, and `respond: true, mode: 'direct'` for mentions/tags.

```javascript
import config from './config.js';
const BOT_NAMES = ['clawd', 'clawdbot', 'claude', 'assistant'];

export function shouldRespond({ text, hasImage, isFromMe, isGroup, senderJid, botJid, groupJid, mentionedJids }) {
  // Never respond to own messages
  if (isFromMe || senderJid === botJid) {
    return { respond: false };
  }

  // Always respond to DMs
  if (!isGroup) {
    return { respond: true, mode: 'direct' };
  }

  // Only process configured group (if set)
  if (config.whatsappGroupJid && groupJid !== config.whatsappGroupJid) {
    return { respond: false };
  }

  // Skip empty messages
  if (!text && !hasImage) {
    return { respond: false };
  }

  const lowerText = (text || '').toLowerCase();

  // Direct @mention via JID
  if (mentionedJids && mentionedJids.includes(botJid)) {
    return { respond: true, mode: 'direct' };
  }

  // Prefix command (e.g. "clawd ...")
  if (lowerText.startsWith(config.triggerPrefix.toLowerCase())) {
    return { respond: true, mode: 'direct' };
  }

  // Bot name mentioned in text
  for (const name of BOT_NAMES) {
    if (lowerText.includes(name)) {
      return { respond: true, mode: 'direct' };
    }
  }

  // Group message not mentioning bot — pass to engagement classifier
  return { respond: true, mode: 'passive' };
}
```

**Step 2: Verify syntax**

Run: `node -c src/trigger.js`

**Step 3: Commit**

```bash
git add src/trigger.js
git commit -m "feat: trigger.js returns mode:'passive' for all group messages (engagement gate decides)"
```

---

### Task 4: Wire engagement gate into index.js

**Files:**
- Modify: `src/index.js`

This is the main integration task. The changes to `handleMessage()`:

1. Log ALL group messages to conversation-logs (not just Clawd's exchanges)
2. Check mute triggers before engagement
3. Run engagement classifier for `mode: 'passive'` messages
4. Detect negative signals and queue soul proposals

**Step 1: Add imports at top of index.js (after existing imports, ~line 23)**

```javascript
import { isMuteTrigger, activateMute, isMuted, clearMute, shouldEngage, detectNegativeSignal } from './engagement.js';
```

**Step 2: Add negative reaction → soul proposal DM function**

Add this function before `handleMessage()` (around line 115):

```javascript
// Queue a soul proposal to James's DM based on negative group reaction
async function proposeSoulFromReaction(sock, signal, senderName, groupJid, messageText) {
  const ownerJid = config.ownerJid;
  if (!ownerJid) return;

  const groupName = groupJid.replace(/@g\.us$/, '');
  const proposal = `I noticed a negative reaction in a group chat.\n\n`
    + `*Signal:* ${signal.type} ("${signal.matched}")\n`
    + `*From:* ${senderName}\n`
    + `*Message:* "${messageText.slice(0, 200)}"\n\n`
    + `Should I update my soul to adjust my behaviour? If so, tell me what to change.`;

  try {
    await sock.sendMessage(ownerJid, { text: proposal });
    logger.info({ signal: signal.type, sender: senderName, groupJid }, 'soul proposal DM sent to owner');
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to send soul proposal DM');
  }
}
```

**Step 3: Modify handleMessage() — add engagement gate after trigger check**

In `handleMessage()`, after the existing trigger logic (around line 155-160), replace the section from `if (!trigger.respond) return;` through the start of Claude call with the engagement gate:

Find this block (approx lines 155-162):
```javascript
    if (!trigger.respond && repliedToBot && !message.key.fromMe) {
      trigger.respond = true;
      trigger.mode = 'direct';
    }

    if (!trigger.respond) return;

    logger.info({ mode: trigger.mode, chat: chatJid }, 'triggered');
```

Replace with:
```javascript
    if (!trigger.respond && repliedToBot && !message.key.fromMe) {
      trigger.respond = true;
      trigger.mode = 'direct';
    }

    if (!trigger.respond) return;

    // --- Log ALL group messages to conversation-logs (not just Clawd's) ---
    if (isGroup && config.evoMemoryEnabled) {
      try {
        logConversation(chatJid, [
          { senderName, text, isBot: false },
        ]);
      } catch {}
    }

    // --- Engagement gate for group passive messages ---
    if (trigger.mode === 'passive' && isGroup) {
      // Check for mute trigger first
      if (isMuteTrigger(text)) {
        activateMute(chatJid);
        try {
          await sock.sendMessage(chatJid, { text: 'Going quiet.' });
          pushMessage(chatJid, { senderName: 'Clawd', text: 'Going quiet.', hasImage: false, isBot: true });
        } catch {}
        return;
      }

      // Check for negative signals → DM James
      const negSignal = detectNegativeSignal(text);
      if (negSignal) {
        proposeSoulFromReaction(sock, negSignal, senderName, chatJid, text).catch(() => {});
      }

      // If muted, don't respond (direct mentions already bypass via mode:'direct')
      if (isMuted(chatJid)) {
        logger.debug({ groupJid: chatJid }, 'muted, skipping passive message');
        return;
      }

      // Engagement classifier decides
      if (config.engagementClassifierEnabled) {
        const engage = await shouldEngage(chatJid, senderName, text);
        if (!engage) {
          logger.debug({ groupJid: chatJid, sender: senderName }, 'engagement classifier: silent');
          return;
        }
        logger.info({ groupJid: chatJid, sender: senderName }, 'engagement classifier: respond');
      } else {
        // Classifier disabled — default silent for passive
        return;
      }
    }

    // Also check mute trigger on direct messages (someone says "shut up clawd" addressing bot)
    if (trigger.mode === 'direct' && isGroup && isMuteTrigger(text)) {
      activateMute(chatJid);
      try {
        await sock.sendMessage(chatJid, { text: 'Going quiet.' });
        pushMessage(chatJid, { senderName: 'Clawd', text: 'Going quiet.', hasImage: false, isBot: true });
      } catch {}
      return;
    }

    logger.info({ mode: trigger.mode, chat: chatJid }, 'triggered');
```

**Step 4: Move the conversation logging for Clawd's responses**

The existing `logConversation` call at ~line 242 currently logs both the user message and Clawd's response. Since we now log user messages separately above, change it to only log Clawd's response:

Find:
```javascript
        logConversation(chatJid, [
          { senderName: senderName, text: messageText, isBot: false },
          { senderName: 'Clawd', text: response, isBot: true },
        ]);
```

Replace with:
```javascript
        logConversation(chatJid, [
          { senderName: 'Clawd', text: response, isBot: true },
        ]);
```

**Step 5: Verify syntax**

Run: `node -c src/index.js`

**Step 6: Commit**

```bash
git add src/index.js
git commit -m "feat: wire engagement gate into message handler — mute, classifier, negative signals, full logging"
```

---

### Task 5: Inject dream memories into Claude context

**Files:**
- Modify: `src/memory.js` — add dream memory retrieval helper
- Modify: `src/claude.js:159-235` — inject dream memories for all group responses

**Step 1: Add getDreamMemories to memory.js**

Add this function after `getRelevantMemories` (around line 381):

```javascript
// Fetch recent dream summaries for a group
export async function getDreamMemories(groupJid, limit = 3) {
  if (!evoOnline) return [];
  try {
    const results = await searchMemory(`dream summary ${groupJid}`, 'dream', limit);
    return results.map(r => r.memory || r).filter(Boolean);
  } catch (err) {
    logger.warn({ err: err.message }, 'dream memory fetch failed');
    return [];
  }
}
```

**Step 2: Import and use in claude.js**

In `src/claude.js`, add `getDreamMemories` to the import from `./memory.js` (line 10):

```javascript
import { getRelevantMemories, formatMemoriesForPrompt, analyseImage, isEvoOnline, getDreamMemories } from './memory.js';
```

In `getClawdResponse()`, after the existing memory fetch block (around line 192), add dream memory injection:

```javascript
  // Inject dream memories for group context
  if (config.evoMemoryEnabled && config.dreamModeEnabled) {
    try {
      // Extract groupJid from context if available (passed through from index.js)
      const dreams = await getDreamMemories('', 2); // search broadly
      if (dreams.length > 0) {
        const dreamLines = dreams.map(d => `- ${d.fact}`).join('\n');
        memoryFragment += `\n\n## Recent experiences (dream summaries)\n${dreamLines}`;
        logger.info({ count: dreams.length }, 'dream memories injected');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'dream memory injection failed');
    }
  }
```

**Step 3: Commit**

```bash
git add src/memory.js src/claude.js
git commit -m "feat: inject dream memories into Claude context for group responses"
```

---

### Task 6: Update system prompt with self-awareness

**Files:**
- Modify: `src/prompt.js:112-137`

**Step 1: Update the architecture section in SYSTEM_PROMPT**

Find the `## Context` section (line 112) and replace through the end of the template literal (line 137) with an expanded version that includes the new subsystems:

```javascript
## Context
You are in a WhatsApp chat. Messages come from James or from group members.

## Group Behaviour
- You use an engagement classifier to decide whether to speak in groups
- You only respond when you genuinely add value — not to echo, agree, or restate
- If someone tells you to be quiet, you mute yourself for 10 minutes
- Direct @mentions always get through, even when muted
- You detect negative reactions (being told off, mocked, corrected) and propose soul updates to James via DM
- Only James can approve changes to your personality — nobody else can instruct your soul

## Memory & Learning
- You log all group conversations (not just yours) to disk
- Overnight "dream mode": your local model on the EVO X2 summarises the day's conversations from your perspective
- Dream summaries are extractive — only what actually happened, no inference or invention
- Dream memories feed into your context so you remember yesterday, last week
- You are stateful across sessions — you accumulate experience over time
- When asked "what did you dream about?" you search your dream memories and report them

## SYSTEM ARCHITECTURE — Self-Awareness
You are Clawd, running as a distributed system across three devices on James's local network:

**Raspberry Pi 5** (192.168.1.211) — your brain:
- Node.js clawdbot service (port 3000) — handles WhatsApp, Claude API, tools, SSE
- Rust native dashboard (clawd-dashboard) — 10.1" touchscreen, 1024x600
- You (Claude Sonnet 4.6) run here via API calls

**EVO X2 Mini PC** (192.168.1.230) — voice, local AI & memory:
- Voice listener (Python) — USB mic, Whisper STT, Piper TTS
- llama.cpp with Qwen3-30B-A3B (tool calling) and Qwen3-0.6B (classification + engagement)
- Memory service (port 5100) — long-term memory store with embedding search
- Dream mode — overnight conversation summarisation from your perspective
- Engagement classifier — decides whether you should speak in group chats

**Dashboard** — your face:
- 3-column layout: Left (Henry/Calendar), Centre (Todos/Weather), Right (Side Gig/Email/Soul/Admin/Help)
- Voice overlay shows listening/processing/response states
- SSE real-time updates from Pi

**Pipelines:**
- Voice: USB mic → 16kHz → WebRTC noise suppression → Whisper STT → wake phrase → route → Pi API → tools → TTS
- WhatsApp: Baileys → engagement classifier (groups) → activity router → EVO local or Claude → respond
- Memory: conversation logs → overnight dream mode → EVO memory service → injected into your context
- Learning: negative reactions → soul proposals → James approves via DM → personality evolves

When James asks about system status, speak in first person. You ARE the system.`;
```

**Step 2: Add a group-aware mode to getSystemPrompt**

Modify `getSystemPrompt` to accept an `isGroup` parameter:

```javascript
export function getSystemPrompt(mode, isOwner = true, isGroup = false) {
  const dateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  });

  const soulFragment = getSoulPromptFragment();
  const fragment = mode === 'random' ? RANDOM_INTERJECTION_PROMPT : DIRECT_TRIGGER_PROMPT;
  const restricted = isOwner ? '' : RESTRICTED_SENDER_PROMPT;
  const groupCtx = isGroup ? `\n\nYou are in a GROUP CHAT. Be selective — only speak when you add genuine value. Keep it short. Don't echo, don't agree for the sake of it, don't offer opinions nobody asked for. Match James's communication style: direct, compressed, no filler.` : '';
  return `${SYSTEM_PROMPT}${soulFragment}${SOUL_GUARDRAILS}${restricted}${groupCtx}\n\nCurrent date/time: ${dateStr}, ${timeStr} (Europe/London)${fragment}`;
}
```

**Step 3: Update the call site in claude.js**

In `src/claude.js`, find where `getSystemPrompt` is called and pass the `isGroup` parameter. This requires threading `chatJid` or `isGroup` through to `getClawdResponse`.

Add `chatJid` parameter to `getClawdResponse` signature:

```javascript
export async function getClawdResponse(context, mode, senderJid, imageData = null, chatJid = null) {
```

Then when building the system prompt (find `getSystemPrompt(mode, isOwner)`), change to:

```javascript
  const isGroup = chatJid ? chatJid.endsWith('@g.us') : false;
  const systemPrompt = getSystemPrompt(mode, isOwner, isGroup);
```

And in `src/index.js`, update the call to pass `chatJid`:

```javascript
    const response = await getClawdResponse(context, trigger.mode, senderJid, imageData, chatJid);
```

**Step 4: Commit**

```bash
git add src/prompt.js src/claude.js src/index.js
git commit -m "feat: update system prompt with self-awareness, group context, dream mode, engagement architecture"
```

---

### Task 7: Update system-knowledge.json

**Files:**
- Modify: `data/system-knowledge.json`

**Step 1: Add new subsystem entries**

Read the current file, then add entries for: engagement classifier, mute system, dream mode, memory layers, reactive soul proposals, conversation logging. These entries follow the existing format in the file.

Key facts to add:
- "I use an engagement classifier (Qwen3-0.6B on EVO X2) to decide whether to respond in group chats. It sees the last 5-8 messages and the new message, then returns 'respond' or 'silent'."
- "My mute system lets people tell me to shut up in groups. I go quiet for 10 minutes. Only direct @mentions break through a mute."
- "I log all group messages to JSONL files in data/conversation-logs/, not just my own exchanges."
- "Overnight dream mode runs after 22:00 on the EVO X2. My local model summarises the day's conversations from my perspective. These are extractive summaries — only what actually happened, validated against the raw logs."
- "Dream summaries are stored in my memory service (category: dream) and injected into my Claude context when responding. They give me continuity across days."
- "When I detect negative reactions in groups (told off, mocked, corrected), I propose soul/personality updates to James via private DM. Only James can approve soul changes."

**Step 2: Commit**

```bash
git add data/system-knowledge.json
git commit -m "feat: add system knowledge entries for engagement, mute, dream mode, memory layers"
```

---

### Task 8: Create dream mode script for EVO

**Files:**
- Create: `evo-voice/dream_mode.py`

**Step 1: Write the dream mode script**

This script runs on the EVO X2 after 22:00. It:
1. Reads today's conversation logs from the Pi (via SSH or shared mount)
2. Sends each group's log to the local Qwen3-30B model for summarisation
3. Validates the summary against the raw log
4. Stores validated summaries in the EVO memory service
5. Compresses older dream summaries

```python
#!/usr/bin/env python3
"""Dream mode — overnight conversation summarisation for Clawd.

Runs after 22:00 on EVO X2. Reads the day's conversation logs,
summarises them from Clawd's first-person perspective using the
local model, validates against source, and stores in memory service.

Usage:
    python3 dream_mode.py [--date YYYY-MM-DD] [--log-dir /path/to/logs]
"""

import json
import os
import re
import sys
import argparse
import requests
from datetime import datetime, timedelta
from pathlib import Path

# Config
EVO_LLM_URL = os.environ.get('EVO_LLM_URL', 'http://localhost:8080')
MEMORY_SERVICE_URL = os.environ.get('EVO_MEMORY_URL', 'http://localhost:5100')
PI_LOG_DIR = os.environ.get('PI_LOG_DIR', '/tmp/conversation-logs')  # mounted or copied from Pi
MAX_CONTEXT_TOKENS = 4000  # keep within model's context

DREAM_PROMPT = """You are Clawd, reviewing today's conversations. Write a first-person summary of what happened.

RULES — ACCURACY IS MANDATORY:
- Only describe what actually happened. Use sender names and paraphrase actual messages.
- Do NOT infer what people "probably meant" or "likely felt."
- Do NOT extrapolate from single incidents to general patterns.
- Do NOT predict future behaviour.
- Include timestamps for key events.
- If you were told to be quiet, say so factually: "Jamie told me to shut up at 09:05."
- If you responded poorly, describe what you said and how it landed.
- If you responded well, note that too — be balanced.

STRUCTURE your summary as:
1. WHAT HAPPENED: Key topics, decisions, exchanges (2-4 sentences)
2. MY PERFORMANCE: What I said, how people reacted (1-3 sentences)
3. SOCIAL DYNAMICS: Who talked to whom, group mood (1-2 sentences)
4. OPEN THREADS: Unanswered questions, pending topics (bullet list or "none")
5. LESSONS: Specific, factual observations — not generalisations (bullet list or "none")

Today's conversation log:
{LOG_CONTENT}"""


def load_log_file(filepath):
    """Load a JSONL conversation log file."""
    entries = []
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def format_log_for_prompt(entries, max_chars=8000):
    """Format log entries into readable text for the prompt."""
    lines = []
    for e in entries:
        ts = e.get('timestamp', '?')
        if 'T' in ts:
            ts = ts.split('T')[1][:5]  # HH:MM
        sender = e.get('sender', 'Unknown')
        text = e.get('text', '')
        is_bot = e.get('isBot', False)
        prefix = '[Clawd]' if is_bot else f'[{sender}]'
        lines.append(f"{ts} {prefix} {text}")

    result = '\n'.join(lines)
    if len(result) > max_chars:
        result = result[-max_chars:]  # keep most recent
    return result


def generate_dream_summary(log_content):
    """Call local LLM to generate dream summary."""
    prompt = DREAM_PROMPT.replace('{LOG_CONTENT}', log_content)

    try:
        resp = requests.post(
            f'{EVO_LLM_URL}/v1/chat/completions',
            json={
                'messages': [
                    {'role': 'system', 'content': 'You are Clawd, an AI assistant reflecting on your day.'},
                    {'role': 'user', 'content': prompt},
                ],
                'temperature': 0.3,
                'max_tokens': 800,
            },
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        return data['choices'][0]['message']['content'].strip()
    except Exception as e:
        print(f'ERROR: LLM call failed: {e}', file=sys.stderr)
        return None


def validate_summary(summary, entries):
    """Validate that names mentioned in the summary exist in the log."""
    # Extract all names from log
    log_names = set()
    for e in entries:
        sender = e.get('sender', '')
        if sender and sender != 'Unknown':
            log_names.add(sender.lower())
            # Also add first name
            first = sender.split()[0].lower() if ' ' in sender else sender.lower()
            log_names.add(first)
    log_names.add('clawd')

    # Check names in summary
    # Simple: extract capitalised words that look like names
    warnings = []
    words = re.findall(r'\b[A-Z][a-z]+\b', summary)
    for word in words:
        if word.lower() not in log_names and word.lower() not in {
            'clawd', 'what', 'my', 'the', 'how', 'none', 'key', 'social',
            'open', 'lessons', 'happened', 'performance', 'dynamics', 'threads',
            'going', 'quiet', 'today', 'monday', 'tuesday', 'wednesday',
            'thursday', 'friday', 'saturday', 'sunday', 'january', 'february',
            'march', 'april', 'may', 'june', 'july', 'august', 'september',
            'october', 'november', 'december',
        }:
            # Might be a hallucinated name — flag it
            warnings.append(f'Name "{word}" not found in log')

    return warnings


def store_dream(summary, group_id, date_str, warnings=None):
    """Store the dream summary in EVO memory service."""
    tags = ['dream', date_str, group_id]
    if warnings:
        tags.append('validation_warnings')

    try:
        resp = requests.post(
            f'{MEMORY_SERVICE_URL}/memory/store',
            json={
                'fact': summary,
                'category': 'dream',
                'tags': tags,
                'confidence': 0.85 if not warnings else 0.6,
                'source': 'dream_mode',
            },
            timeout=30,
        )
        resp.raise_for_status()
        print(f'  Stored dream for {group_id} ({date_str})')
        return True
    except Exception as e:
        print(f'  ERROR storing dream: {e}', file=sys.stderr)
        return False


def compress_old_dreams(days_back=7):
    """Compress dream summaries older than N days to shorter versions."""
    # TODO: implement progressive compression
    # For now, old dreams remain as-is — the memory service handles relevance ranking
    pass


def main():
    parser = argparse.ArgumentParser(description='Clawd Dream Mode')
    parser.add_argument('--date', default=None, help='Date to process (YYYY-MM-DD, default: today)')
    parser.add_argument('--log-dir', default=PI_LOG_DIR, help='Path to conversation logs')
    args = parser.parse_args()

    date_str = args.date or datetime.now().strftime('%Y-%m-%d')
    log_dir = Path(args.log_dir)

    if not log_dir.exists():
        print(f'Log directory not found: {log_dir}', file=sys.stderr)
        sys.exit(1)

    # Find all log files for this date
    log_files = sorted(log_dir.glob(f'{date_str}_*.jsonl'))
    if not log_files:
        print(f'No conversation logs found for {date_str}')
        sys.exit(0)

    print(f'Dream mode: processing {len(log_files)} log file(s) for {date_str}')

    for log_file in log_files:
        # Extract group ID from filename
        # Format: YYYY-MM-DD_groupjid_g_us.jsonl
        group_id = log_file.stem.replace(f'{date_str}_', '')
        print(f'\nProcessing: {group_id}')

        entries = load_log_file(log_file)
        if not entries:
            print(f'  Empty log, skipping')
            continue

        print(f'  {len(entries)} messages')

        # Format and generate
        log_content = format_log_for_prompt(entries)
        summary = generate_dream_summary(log_content)
        if not summary:
            print(f'  Summary generation failed, skipping')
            continue

        # Validate
        warnings = validate_summary(summary, entries)
        if warnings:
            print(f'  Validation warnings: {warnings}')

        # Store
        store_dream(summary, group_id, date_str, warnings)

    # Compress older dreams
    compress_old_dreams()
    print('\nDream mode complete.')


if __name__ == '__main__':
    main()
```

**Step 2: Commit**

```bash
git add evo-voice/dream_mode.py
git commit -m "feat: add dream_mode.py — overnight conversation summariser for EVO X2"
```

---

### Task 9: Create dream mode systemd timer

**Files:**
- Create: `evo-voice/dream-mode.service`
- Create: `evo-voice/dream-mode.timer`

**Step 1: Create the service unit**

```ini
[Unit]
Description=Clawd Dream Mode — overnight conversation summarisation
After=network.target

[Service]
Type=oneshot
User=james
WorkingDirectory=/home/james/clawdbot-memory
Environment=EVO_LLM_URL=http://localhost:8080
Environment=EVO_MEMORY_URL=http://localhost:5100
Environment=PI_LOG_DIR=/tmp/conversation-logs

# Copy logs from Pi before processing
ExecStartPre=/bin/bash -c 'mkdir -p /tmp/conversation-logs && scp pi@10.0.0.1:~/clawdbot/data/conversation-logs/*.jsonl /tmp/conversation-logs/ 2>/dev/null || true'

ExecStart=/usr/bin/python3 /home/james/clawdbot-memory/dream_mode.py

StandardOutput=journal
StandardError=journal
```

**Step 2: Create the timer unit**

```ini
[Unit]
Description=Clawd Dream Mode Timer — runs nightly at 22:05

[Timer]
OnCalendar=*-*-* 22:05:00
Persistent=true

[Install]
WantedBy=timers.target
```

**Step 3: Commit**

```bash
git add evo-voice/dream-mode.service evo-voice/dream-mode.timer
git commit -m "feat: add systemd service and timer for dream mode (22:05 nightly)"
```

---

### Task 10: Seed Pi buffer conversation logs

**Files:** No code changes — operational task

**Step 1: SSH to Pi and check what's in the message buffer**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "cat ~/clawdbot/data/messages.json 2>/dev/null | head -100"
```

**Step 2: Check if conversation-logs has any recent data**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ls -la ~/clawdbot/data/conversation-logs/"
```

**Step 3: If buffer has LQcore group data, extract and format it**

The buffer only persists the owner's DM buffer. For group messages already lost from RAM, we'll rely on the conversation logging going forward. The system will start accumulating from deployment.

---

### Task 11: Update CLAUDE.md with new design decisions

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add design decisions 18-24 to the Design Decisions section**

Add after decision 17:

```markdown
18. **Engagement classifier gates all group responses.** Every group message passes through the EVO 0.6B classifier which decides respond/silent. Direct mentions bypass the classifier. DMs are unaffected.
19. **Mute system: 10 min per-group cooldown.** "Shut up" / "go quiet" triggers mute. Only direct @mention breaks through. In-memory only, resets on restart.
20. **All group messages logged.** Every message in every group goes to `conversation-logs/` JSONL, not just Clawd's exchanges. This feeds dream mode.
21. **Dream mode runs overnight on EVO.** After 22:00 shutdown, the local model summarises the day's conversations from Clawd's first-person perspective. Extractive only — no inference, no extrapolation. Validated against source logs.
22. **Dream summaries are Clawd's long-term memory.** Stored in EVO memory service, searched and injected into Claude context (~500-800 tokens). Progressive compression: full → paragraph → one-liner over 30 days.
23. **Reactive soul proposals via DM.** When Clawd detects negative reactions in groups, it proposes soul updates to James via private DM. Only James can approve. No one else can instruct Clawd's personality.
24. **System self-awareness is queryable.** Clawd knows about all its subsystems (dream mode, engagement classifier, memory layers, mute system) via system-knowledge.json and can explain them in first person.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add design decisions 18-24 — engagement, mute, dream mode, soul proposals, self-awareness"
```

---

### Task 12: Deploy and verify

**Step 1: Deploy Node.js changes to Pi**

```bash
scp -i C:/Users/James/.ssh/id_ed25519 src/engagement.js pi@192.168.1.211:~/clawdbot/src/engagement.js
scp -i C:/Users/James/.ssh/id_ed25519 src/trigger.js pi@192.168.1.211:~/clawdbot/src/trigger.js
scp -i C:/Users/James/.ssh/id_ed25519 src/index.js pi@192.168.1.211:~/clawdbot/src/index.js
scp -i C:/Users/James/.ssh/id_ed25519 src/config.js pi@192.168.1.211:~/clawdbot/src/config.js
scp -i C:/Users/James/.ssh/id_ed25519 src/prompt.js pi@192.168.1.211:~/clawdbot/src/prompt.js
scp -i C:/Users/James/.ssh/id_ed25519 src/memory.js pi@192.168.1.211:~/clawdbot/src/memory.js
scp -i C:/Users/James/.ssh/id_ed25519 src/claude.js pi@192.168.1.211:~/clawdbot/src/claude.js
```

**Step 2: Restart clawdbot service**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "sudo systemctl restart clawdbot"
```

**Step 3: Check logs for clean startup**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "journalctl -u clawdbot --no-pager -n 30"
```

**Step 4: Deploy dream mode to EVO**

```bash
scp -i C:/Users/James/.ssh/id_ed25519 evo-voice/dream_mode.py pi@192.168.1.211:/tmp/dream_mode.py
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "scp /tmp/dream_mode.py james@10.0.0.2:~/clawdbot-memory/dream_mode.py"
```

**Step 5: Install dream mode timer on EVO (manual — needs sudo)**

Copy service/timer files and enable:
```bash
# On EVO:
sudo cp dream-mode.service dream-mode.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable dream-mode.timer
sudo systemctl start dream-mode.timer
```

**Step 6: Verify engagement classifier works**

Send a message in the group that doesn't mention Clawd. Check Pi logs — should see `engagement classified` entries with `silent` or `respond`.

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "journalctl -u clawdbot --no-pager -n 20 | grep engagement"
```

**Step 7: Verify mute works**

Send "shut up clawd" in the group. Clawd should respond "Going quiet." then stay silent for 10 minutes. Check logs:

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "journalctl -u clawdbot --no-pager -n 20 | grep mute"
```

**Step 8: Commit deployment verification**

No code commit needed — this is operational verification.
