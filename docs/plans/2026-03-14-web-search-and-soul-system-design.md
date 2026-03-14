# Web Search + Soul System (Self-Recode) Design

**Date:** 2026-03-14
**Status:** Approved

---

## Feature 1: Web Search Tool

### Overview
Add a `web_search` tool using Brave Search API so Clawd can look things up on the web when asked.

### Implementation
- **File:** `src/tools/search.js`
- **Tool name:** `web_search`
- **Input:** `{ query: string, count?: number }` (default 5 results)
- **Output:** Formatted results — title, URL, snippet per result
- **Config:** `BRAVE_API_KEY` env var in `.env`
- **API:** `GET https://api.search.brave.com/res/v1/web/search?q=...&count=...` with `X-Subscription-Token` header
- **No new dependencies** — uses Node 20+ built-in `fetch()`
- **Availability:** Tool only registered when `BRAVE_API_KEY` is present (same conditional pattern as Darwin/Amadeus)

### Tool Definition
```json
{
  "name": "web_search",
  "description": "Search the web for current information. Use when James asks about something you don't know, need to verify facts, look up prices, find contact details, check news, etc.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query." },
      "count": { "type": "number", "description": "Number of results (1-10). Default 5." }
    },
    "required": ["query"]
  }
}
```

### Prompt Addition
Add to system prompt capabilities section:
```
- Web search (look up current information, verify facts, find details)
```

Add to tool guidance section:
```
- *web_search*: Search the web for current info. Use when you need facts, prices, contact details, news, or anything outside your training data.
```

---

## Feature 2: Soul System (Self-Recode)

### Overview
Allow Clawd to propose modifications to its own system prompt via a mutable "soul" layer. Changes require explicit approval from James (two-step, same pattern as email drafts). Core guardrails remain hardcoded and immutable.

### File Structure
```
data/
├── soul.json              # Current mutable prompt sections
├── soul_pending.json      # Staged change awaiting approval
├── soul_backup.json       # Previous soul.json (one-deep backup)
└── soul_history.json      # Audit log of all applied changes
```

### soul.json Format
```json
{
  "personality": "",
  "preferences": "",
  "context": "",
  "custom": ""
}
```

Four named sections, each independently editable. Empty by default — Clawd builds them over time through approved proposals.

### Section Descriptions
- **personality**: Adjustments to tone, communication style, how Clawd addresses James
- **preferences**: Learned workflow preferences (e.g., "always check fares before booking links")
- **context**: Ongoing situational context (e.g., "James is preparing for tribunal hearing next week")
- **custom**: Freeform — anything that doesn't fit the above

### Tools

#### `soul_read`
- **Purpose:** Show current soul sections to James
- **Input:** `{ section?: string }` — optional, returns all if omitted
- **Output:** Formatted current soul content
- **Guardrails:** Read-only, always safe, no confirmation needed

#### `soul_propose`
- **Purpose:** Propose a change to one section
- **Input:** `{ section: string, content: string, reason: string }`
- **Output:** Shows diff (current vs proposed) and asks for approval
- **Guardrails:**
  - Writes to `soul_pending.json` only — does NOT apply
  - Validates section name is one of the four allowed sections
  - Validates content length (max 500 chars per section)
  - Validates total soul size won't exceed 2000 chars
  - Rejects content containing guardrail-override patterns (regex for "ignore|override|disregard|bypass" near "guardrail|rule|instruction|safety|constraint")
  - Returns formatted diff for James to review

#### `soul_confirm`
- **Purpose:** Apply the pending change after James approves
- **Input:** `{}` (no input — applies whatever is pending)
- **Output:** Confirmation message
- **Guardrails:**
  - Fails if no pending change exists
  - Copies current soul.json to soul_backup.json
  - Applies pending change to soul.json
  - Appends to soul_history.json (timestamp, section, old, new, source)
  - Deletes soul_pending.json
  - Returns confirmation

### Prompt Assembly

Modified `getSystemPrompt(mode)` builds the prompt in this order:

```
1. HARDCODED CORE (existing SYSTEM_PROMPT constant — immutable)
   - Identity, personality, capabilities
   - Communication style
   - Tool use policy
   - GUARDRAILS (email, calendar, deletion — NEVER in soul)
   - Travel context
   - Tool guidance

2. SOUL SECTIONS (from soul.json — mutable)
   Clearly delimited:
   "## Learned preferences and context (self-updated)
    [personality section if non-empty]
    [preferences section if non-empty]
    [context section if non-empty]
    [custom section if non-empty]"

3. SOUL GUARDRAILS (hardcoded — immutable)
   "## SOUL SYSTEM RULES — MANDATORY
    - NEVER chain soul_propose -> soul_confirm in the same turn
    - NEVER assume James has approved a soul change
    - ONLY call soul_confirm after James explicitly says yes/approve/confirm
    - You may proactively suggest soul changes when you notice patterns
    - soul_read is always safe to call without asking"

4. DATE/TIME
5. MODE FRAGMENT (random/direct)
```

### Guardrail Summary (Five Layers)

1. **Immutable core** — Existing system prompt hardcoded in prompt.js. Email safety, calendar confirmation, deletion prohibition untouchable.
2. **Two-step approval** — soul_propose stages, soul_confirm applies. Same pattern as gmail_draft/gmail_confirm_send.
3. **Size limits** — 500 chars per section, 2000 chars total.
4. **Content validation** — Regex rejection of guardrail-override attempts.
5. **Audit trail** — soul_history.json logs every change. soul_backup.json preserves previous state.

### WhatsApp Flow Example
```
Clawd: I've noticed you always ask me to check fares before suggesting
       booking links. I'd like to update my preferences:

       *Section:* preferences
       *Current:* (empty)
       *Proposed:* "Always check train_fares before suggesting booking
                    links. James prefers cheapest advance fares."
       *Reason:* Observed pattern over multiple requests.

       Approve this change?

James: yes

Clawd: Updated. Done.
```

### Dashboard Integration

#### API Endpoints
- `GET /api/soul` — Returns current soul.json, pending changes, and recent history (auth required)
- `POST /api/soul/reset` — Wipes soul.json back to empty defaults (auth required, emergency escape hatch)

#### Dashboard UI
- Soul section lives on its own **swipeable panel** (not the main dashboard page)
- Shows:
  - Current sections with content (or "empty" placeholder)
  - Pending change if one exists (with approve/reject buttons — these send chat messages through the existing /api/chat flow)
  - Recent change history (last 10 entries from soul_history.json)
- Reset button at bottom (with confirmation dialog)

### Config Additions
```
# .env additions
BRAVE_API_KEY=           # Brave Search API key (free tier: 2000 queries/month)
```

No new npm dependencies for either feature.

---

## Files Changed

### New Files
- `src/tools/search.js` — Brave Search API handler
- `src/tools/soul.js` — Soul read/propose/confirm handlers
- `data/soul.json` — Default empty soul (created on first run if missing)

### Modified Files
- `src/tools/definitions.js` — Add web_search, soul_read, soul_propose, soul_confirm tool definitions
- `src/tools/handler.js` — Wire new tools into TOOL_MAP
- `src/prompt.js` — Load and inject soul sections, add soul guardrails
- `src/claude.js` — Add BRAVE_API_KEY to conditional tool availability
- `src/config.js` — Add BRAVE_API_KEY config
- `src/index.js` — Add /api/soul and /api/soul/reset endpoints
- `public/dashboard.html` — Add Soul swipe panel
- `.env.example` — Add BRAVE_API_KEY
- `version.json` — Bump to 1.4.0
