# Group Chat Discernment & Dream Mode

**Date:** 2026-03-22
**Status:** Approved
**Author:** James Cockburn + Claude

## Problem

Clawd responds to every message in group chats — echoing, agreeing, offering unsolicited opinions, and generally being annoying. When told to shut up, it either ignores the request or responds with dots to every message. It has no memory of past conversations and no ability to learn from negative reactions. It is stateless across sessions.

## Goals

1. **Smart group discernment** — only respond when Clawd genuinely adds value
2. **Mute system** — respect "shut up" / "go quiet" commands with a timed cooldown
3. **Full conversation memory** — log all group messages, not just Clawd's exchanges
4. **Dream mode** — overnight local summarisation of the day's conversations
5. **Stateful across sessions** — Clawd remembers yesterday, last week, and evolves
6. **Reactive soul updates** — detect negative reactions, propose behavioural changes to James via DM
7. **Queryable self-awareness** — Clawd can explain its own architecture including all these systems
8. **No hallucinations** — dream summaries are extractive and validated against source logs

## Architecture Overview

### Memory Layers

```
Layer 1: Hot Buffer (RAM, free)
  └─ Last 10 messages per chat, dies on restart
  └─ Feeds engagement classifier + immediate Claude context

Layer 2: Day Log (disk, free)
  └─ conversation-logs/ JSONL — ALL group messages, not just Clawd's
  └─ Raw transcript, never sent to Claude directly
  └─ Input for dream mode

Layer 3: Dream Summaries (EVO local model, free, overnight)
  └─ First-person summaries of each day's conversations
  └─ Stored in EVO memory service, category: "dream"
  └─ Progressive compression: yesterday=full, last week=paragraph, last month=one-liner

Layer 4: EVO Memory Search (local, free)
  └─ Semantic search across dream summaries + factual memories
  └─ Returns ~500-800 tokens of relevant context per query
```

### Claude Context Window (per API call)

```
System prompt           ~1500 tok  (prompt-cached)
Soul fragment            ~200 tok  (prompt-cached)
Dream memories        ~500-800 tok (from EVO search)
Recent buffer (5-10 msg) ~300 tok  (hot context)
User message               varies
────────────────────────────────────
Total input:         ~2500-3000 tok
```

No raw transcripts in context. Dream summaries do the heavy lifting.

## Component Designs

### 1. Engagement Classifier

**Location:** New file `src/engagement.js`
**Engine:** EVO 0.6B classifier (same as existing message router)
**When:** Every group message, after buffer push, before Claude call

**Prompt:**
```
You are Clawd, an AI assistant in a WhatsApp group chat.
You can see the recent conversation.

Recent conversation:
{last 5-8 messages with sender names}

New message from {sender}: {message}

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
- Nobody asked for your input on this topic
```

**No bias toward silence.** The classifier makes a neutral, intelligent decision.

**Bypass conditions (always respond regardless of classifier):**
- Direct @mention
- "Clawd" / "clawd" prefix
- Reply to a Clawd message
- DMs (engagement gate doesn't apply to DMs)

### 2. Mute System

**Location:** In `src/engagement.js`
**Storage:** In-memory `Map<groupJid, muteExpiresAt>` — no persistence needed

**Triggers (regex on message text):**
- "shut up clawd", "be quiet clawd", "go quiet", "stay out clawd", "stop talking", "silence clawd", "mute clawd", "clawd shut up", "clawd be quiet"
- Context-sensitive: only triggers when "clawd" or similar bot name is in the message

**Duration:** 10 minutes default, configurable via `GROUP_MUTE_DURATION_MS` env var

**Behaviour when muted:**
- Send brief ack: "Going quiet." (one-time, on mute trigger)
- All subsequent messages → silent (not sent to Claude)
- Direct @mention or "clawd" prefix → breaks mute, responds normally
- Timer expiry → normal engagement classifier resumes

**Scope:** Per-group. Muting in one group doesn't affect others.

### 3. Conversation Logging (Expanded)

**Change to `src/index.js`:** Log ALL group messages to `conversation-logs/`, not just exchanges where Clawd responded.

**Current behaviour:** `logConversation()` only called after Clawd responds (line 242 of index.js).
**New behaviour:** `logConversation()` called for every group message after buffer push, regardless of whether Clawd responds.

**Format:** Existing JSONL format, one file per day per group:
```jsonl
{"timestamp":"2026-03-22T09:05:00Z","sender":"Jamie Tso","text":"are you guys committing...","isBot":false}
{"timestamp":"2026-03-22T09:05:30Z","sender":"Clawd","text":"Good question Jamie...","isBot":true}
```

### 4. Dream Mode

**Schedule:** Runs after 22:00 llama shutdown, before 05:00 restart.
**Engine:** EVO local model (Qwen3-30B-A3B) — CPU-only is fine for this volume.
**Location:** New script, likely Python on EVO or triggered from Pi.

**Process:**
1. Read all `conversation-logs/` JSONL files for today
2. For each group's log, generate a first-person dream summary
3. Validate summary against source log (see accuracy guardrails below)
4. Store validated summary in EVO memory service (category: `dream`, tags: `[date, groupJid]`)
5. Compress older dream summaries:
   - Days 2-7: condense to paragraph
   - Days 8-30: condense to one-liner
   - 30+: archive or drop

**Dream summary prompt (to EVO local model):**
```
You are Clawd, reviewing today's conversations. Write a first-person summary of what happened.

RULES — ACCURACY IS MANDATORY:
- Only describe what actually happened. Quote sender names and paraphrase actual messages.
- Do NOT infer what people "probably meant" or "likely felt."
- Do NOT extrapolate from single incidents to general patterns.
- Do NOT predict future behaviour.
- Include timestamps for key events.
- If you were told to be quiet, say so factually: "Jamie told me to shut up at 09:05."
- If you responded poorly, describe what you said and how it landed.

STRUCTURE:
1. What happened (key topics, decisions, exchanges)
2. How I performed (what I said, how people reacted)
3. Social dynamics (who talked to whom, group mood)
4. Open threads (unanswered questions, pending topics)
5. Lessons (specific, factual — not generalisations)

Today's conversation log:
{JSONL content}
```

**Accuracy guardrails:**
1. **Extractive, not generative** — summarise what happened, don't invent
2. **Source anchoring** — each claim tied to timestamps and sender names from raw log
3. **Validation pass** — after generation, check each named claim against raw JSONL. Strip any statement that can't be matched to a log entry (name + approximate content)
4. **No extrapolation** — single incidents stay as single events, not generalisations

### 5. Reactive Soul Updates

**Trigger detection:** In `src/engagement.js` or `src/index.js`, detect negative signals:
- Explicit: "shut up", "be quiet", "nobody asked you", "stop"
- Mocking: laughing at Clawd's response, "lol clawd", sarcastic responses
- Correction: someone correcting Clawd's information
- Silence after response: Clawd responds, nobody acknowledges, conversation continues on a different topic

**Flow:**
1. Detect negative signal in group conversation
2. Store factual observation in EVO memory (category: `conversation`, what happened + timestamp)
3. Formulate a soul proposal reflecting the behavioural lesson
4. DM James privately with the proposal: "Based on reactions in LQcore, I'd like to update my soul: [proposed change]. Approve?"
5. Only James's explicit "yes" / "approve" triggers `soul_confirm`

**Hard gates:**
- Only James can approve soul changes (existing `OWNER_ONLY_TOOLS` gate)
- Other group members cannot instruct Clawd's personality, even indirectly
- Proposals come from Clawd's own observation, not from following others' instructions

### 6. System Self-Awareness

**`data/system-knowledge.json` additions:**
- Engagement classifier: what it is, how it decides, prompt used
- Mute system: triggers, duration, break-through conditions
- Dream mode: schedule, what it produces, where summaries live
- Memory layers: hot buffer → day log → dream summary → EVO search
- Reactive soul proposals: trigger conditions, approval gate, DM flow
- Conversation logging pipeline

**System prompt update (`src/prompt.js`):**
Add to the architecture section:
```
**Memory & Learning:**
- I log all group conversations to disk (JSONL)
- Overnight "dream mode": my local model summarises the day's conversations from my perspective
- Dream summaries are stored in my memory service and feed into future responses
- I can recall what happened yesterday, last week — search my memories
- I detect negative reactions and propose soul/personality updates to James via DM
- Only James can approve changes to my personality

**Group Behaviour:**
- I use a classifier to decide whether to respond in groups
- I only speak when I genuinely add value
- If told to be quiet, I mute myself for 10 minutes
- Direct mentions always get through
```

**Queryable:** When James asks "what did you dream about last night?" → Clawd searches EVO memory for `category:dream` + yesterday's date and reports the summary. When asked "how does your memory work?" → Clawd explains the layers from system knowledge.

**First person always:** "I process my conversations overnight" not "the system has a dream mode."

### 7. Trigger Flow Changes

**`src/trigger.js`:** Modified to return `mode: 'passive'` for all group messages (currently returns `respond: false` for unmentioned messages).

**`src/index.js`:** New engagement gate between trigger and Claude:

```
Message arrives in group
  │
  ├─ pushMessage() to buffer (always)
  ├─ logConversation() to JSONL (always — NEW)
  │
  ├─ Is muted? ──yes──► Is direct mention? ──yes──► respond
  │                      └──no──► silent (return)
  │
  ├─ Is direct mention/tag/prefix? ──yes──► respond (bypass classifier)
  │
  ├─ Is mute trigger? ──yes──► activate mute, ack "Going quiet.", return
  │
  ├─ Is negative reaction? ──yes──► queue soul proposal to DM James
  │
  └─ EVO engagement classifier
       ├─ "respond" → proceed to Claude (with dream memories injected)
       └─ "silent"  → return
```

## Files Changed

| File | Change |
|------|--------|
| `src/trigger.js` | Return `mode: 'passive'` for all group messages |
| `src/index.js` | Add engagement gate, log all group messages, negative reaction detection |
| `src/engagement.js` | **New** — engagement classifier, mute system, negative signal detection |
| `src/evo-llm.js` | Reuse classifier function for engagement (may need minor adaptation) |
| `src/config.js` | Add `groupMuteDurationMs` |
| `src/prompt.js` | Update architecture section with memory/dream/engagement awareness |
| `src/memory.js` | Add dream memory retrieval helper |
| `src/claude.js` | Inject dream memories into Claude context |
| `data/system-knowledge.json` | Add entries for all new subsystems |
| `evo-voice/dream_mode.py` | **New** — overnight dream summarisation script |
| `evo-voice/dream_mode.service` | **New** — systemd timer for dream mode |

## Config Additions

| Variable | Default | Purpose |
|----------|---------|---------|
| `GROUP_MUTE_DURATION_MS` | `600000` (10 min) | How long "shut up" mutes last |
| `DREAM_MODE_ENABLED` | `true` | Enable/disable overnight dream processing |
| `DREAM_MODE_HOUR` | `22` | Hour (24h) to run dream mode |
| `ENGAGEMENT_CLASSIFIER_ENABLED` | `true` | Enable/disable group engagement classifier |

## Design Decisions (to add to CLAUDE.md)

18. **Engagement classifier gates all group responses.** Every group message passes through the EVO 0.6B classifier which decides respond/silent. Direct mentions bypass the classifier. DMs are unaffected.
19. **Mute system: 10 min per-group cooldown.** "Shut up" / "go quiet" triggers mute. Only direct @mention breaks through. In-memory only, resets on restart.
20. **All group messages logged.** Every message in every group goes to `conversation-logs/` JSONL, not just Clawd's exchanges. This feeds dream mode.
21. **Dream mode runs overnight on EVO.** After 22:00 shutdown, the local model summarises the day's conversations from Clawd's first-person perspective. Extractive only — no inference, no extrapolation. Validated against source logs.
22. **Dream summaries are Clawd's long-term memory.** Stored in EVO memory service, searched and injected into Claude context (~500-800 tokens). Progressive compression: full → paragraph → one-liner over 30 days.
23. **Reactive soul proposals via DM.** When Clawd detects negative reactions in groups, it proposes soul updates to James via private DM. Only James can approve. No one else can instruct Clawd's personality.
24. **System self-awareness is queryable.** Clawd knows about all its subsystems (dream mode, engagement classifier, memory layers, mute system) via system-knowledge.json and can explain them in first person.
