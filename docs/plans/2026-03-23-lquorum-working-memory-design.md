# LQuorum Conversational Working Memory — Design

**Date:** 2026-03-23
**Status:** Approved
**Author:** Claude (with Clawd's review)

## Problem

Clawd has 54K tokens of structured legal AI knowledge from the LQuorum community (18 topics, 40+ lawyers, 12+ jurisdictions). Currently this is fragmented into hundreds of 500-char entries seeded into the EVO memory service. Vector search at response time hopes to surface the right fragments — it mostly doesn't.

Result: Clawd is vaguely aware of legal AI topics but never genuinely knowledgeable. A human in the same position would be listening to the conversation, connecting what's being discussed to what they know, and having the relevant knowledge ready before they speak.

## Solution

**Conversational working memory** — Clawd passively tracks what's being discussed in every group chat, pre-stages full-depth lquorum knowledge into an in-process cache, and has it ready with zero retrieval latency when responding. The engagement classifier gets a `has_relevant_knowledge` signal that nudges toward responding when Clawd genuinely has something to add.

## Architecture

### One new module: `src/lquorum-rag.js`

In-process, no new infrastructure, no new services.

### Startup (once, ~50ms)

- Load `data/lquorum-knowledge.json` into memory (cached in-process)
- Build static keyword→topicId map for all 18 topics

### Per-message scan (<1ms, every group message)

```
scanMessage(text) → void (updates working memory)
```

**Filtering (skip scan if):**
- Message < 50 chars
- Message is > 80% punctuation/emoji
- Message is a direct reply to a named person with no substantive content

**Matching:**
- Keyword match against static map → 0-2 topic IDs
- Vector fallback: **deferred to Phase 2** (ship keywords first, see what misses)

**Working memory update:**
- Matched topics get loaded into `workingMemory` Map
- Full resource object from JSON (key findings, consensus, debates, sections)
- Tracks: `lastMentioned`, `hitCount`, `warmSince`

### Working Memory State

```javascript
workingMemory = Map {
  'rag-hallucinations' => {
    resource: { /* full resource from JSON */ },
    lastMentioned: 1711180800000,
    hitCount: 3,
    warmSince: 1711180500000
  }
}
```

### Decay

- Base decay: **15 minutes** since last mention
- Extended decay: if `hitCount >= 3`, extend to **30 minutes** (earned warmth)
- Decay check runs lazily on each `scanMessage()` or `getWorkingKnowledge()` call
- On decay: entry removed from Map (memory freed)

### On response generation (0ms retrieval)

```
getWorkingKnowledge() → string | null
```

- Pull all non-decayed topics from working memory
- Format as structured prompt context:
  - Topic title + synthesis statement
  - Key findings (with confidence: consensus/emerging)
  - Practical consensus (bullet points)
  - Active debates (positions from contributors)
- Cap: **2 topics max, ~2000 tokens max**
- If nothing warm: returns null (no injection, no cost)

### Keyword Map

```javascript
const TOPIC_KEYWORDS = {
  'rag-hallucinations': ['rag', 'hallucination', 'hallucinate', 'provenance', 'citation check',
    'invented case', 'fabricated', 'retrieval augmented', 'vector search', 'embedding'],
  'doc-processing': ['document processing', 'ocr', 'pdf extraction', 'document parsing',
    'marker', 'docling', 'unstructured'],
  'docx-problem': ['docx', 'word document', 'word format', 'track changes', '.docx',
    'word processing', 'office format'],
  'data-security': ['privilege', 'data security', 'confidential', 'gdpr', 'data protection',
    'air gap', 'legal privilege', 'waiver'],
  'platform-reviews': ['harvey', 'legora', 'cocounsel', 'luminance', 'legal ai platform',
    'which platform', 'clio', 'kira'],
  'copilot-legal': ['copilot', 'microsoft copilot', 'copilot for law', 'm365 copilot'],
  'claude-code': ['claude code', 'cursor', 'coding assistant', 'mcp server',
    'agentic coding', 'windsurf'],
  'local-models': ['local model', 'on-premise', 'self-hosted', 'llama', 'run locally',
    'gpu', 'hardware for ai', 'local llm', 'ollama'],
  'vibe-coding': ['vibe coding', 'vibe code', 'no-code', 'low-code', 'lawyer coding',
    'cursor for lawyers', 'build my own'],
  'tool-showcase': ['tool showcase', 'show and tell', 'demo day', 'what i built',
    'side project'],
  'tool-reviews': ['tool review', 'which tool', 'tool comparison', 'best ai tool',
    'recommend a tool'],
  'ai-native-firms': ['ai native', 'ai-first firm', 'new law firm', 'ai law firm',
    'starting a firm'],
  'contract-review-ai': ['contract review', 'contract analysis', 'clause extraction',
    'due diligence ai', 'contract ai'],
  'it-gatekeepers': ['it department', 'it gatekeeper', 'shadow it', 'it approval',
    'enterprise ai', 'it blocking'],
  'ai-disruption': ['disruption', 'future of law', 'ai replacing', 'lawyer jobs',
    'billable hours', 'ai impact'],
  'agent-security': ['agent security', 'ai agent risk', 'autonomous agent', 'guardrails',
    'agent safety', 'tool use security'],
  'model-comparison': ['which model', 'model comparison', 'gpt vs claude', 'best model',
    'model selection', 'reasoning model', 'o1 vs', 'o3 vs'],
  'about-legal-quants': ['legal quant', 'lquorum', 'legal quants', 'community',
    'the group', 'this group']
};
```

Keywords are case-insensitive, matched as word boundaries where practical.

## Integration Points

### 1. Message handler (`src/index.js`)

One line after message text extraction, before any gating:

```javascript
import { scanMessage } from './lquorum-rag.js';
// ... in message handler, after extracting messageText:
scanMessage(messageText);
```

Runs on EVERY group message — silent, non-blocking, <1ms. This is how Clawd "listens."

### 2. Engagement classifier (`src/engagement.js`)

Enrich classifier context when Clawd has warm knowledge:

```javascript
import { getWarmTopicTitles } from './lquorum-rag.js';

// Before calling EVO 0.6B classifier:
const warmTopics = getWarmTopicTitles();
let enrichedPrompt = classifierSystemPrompt;
if (warmTopics.length > 0) {
  enrichedPrompt += `\nClawd has specific community research on: ${warmTopics.join(', ')}. ` +
    `Consider responding YES if someone asks a question or expresses uncertainty about these topics.`;
}
```

This nudges the classifier toward genuine gap-filling — not just "Clawd knows about this topic" but "someone has a question or uncertainty that Clawd's knowledge can resolve." The classifier still says NO to social chat, banter, and statements of intent even if Clawd has warm knowledge. Unsolicited correction is not gap-filling.

### 3. Claude prompt injection (`src/claude.js`)

Alongside existing memory fragment:

```javascript
import { getWorkingKnowledge } from './lquorum-rag.js';

// In buildMemoryFragment() or equivalent:
const lquorumContext = getWorkingKnowledge();
if (lquorumContext) {
  memoryFragment += '\n\n' + lquorumContext;
}
```

### 4. EVO prompt injection (`src/evo-llm.js`)

Same injection for EVO 30B responses (when forceClaude is false):

```javascript
const lquorumContext = getWorkingKnowledge();
if (lquorumContext) {
  systemPrompt += '\n\n' + lquorumContext;
}
```

### 5. System knowledge cleanup (`src/system-knowledge.js`)

Remove the bulk lquorum seeding loop. Replace with one thin entry:

```javascript
{
  fact: "LQuorum community knowledge covers 18 legal AI topics from 40+ lawyers across 12 jurisdictions. Topics include RAG/hallucinations, document processing, DOCX problems, data security, platform reviews, local models, vibe coding, contract review AI, and more. Full knowledge is available through conversational working memory when these topics are discussed.",
  tags: ['lquorum', 'legal-ai', 'community'],
  category: 'system',
  confidence: 1.0
}
```

### 6. Dashboard logging (nice-to-have)

Expose warm topics via existing SSE/dashboard endpoint:

```javascript
// New endpoint or extension of existing /dashboard/status
app.get('/dashboard/working-memory', (req, res) => {
  res.json(getWorkingMemoryState());
});
```

Dashboard can display: which topics are warm, hit counts, time since last mention. Useful for tuning the keyword map and spotting false positives.

## Prompt Format (injected into system prompt)

```
## LQuorum Knowledge (active discussion topics)

### RAG for Legal: Architecture, Hallucinations & Provenance
*Community knowledge from 18 contributors across 6 jurisdictions*

**Key findings:**
- [CONSENSUS] Hallucinations in legal AI are better understood as inventions — fabricated cases and statutes that sound plausible. Uniquely dangerous to lawyers.
- [CONSENSUS] Web search integration can drown context, paradoxically increasing hallucination rates.
- [EMERGING] Local RAG with small models may hallucinate less than cloud frontier models for retrieval tasks.
- [CONSENSUS] Section references in legislation are particularly prone to hallucination.

**Practical consensus:**
- Use local RAG for confidential retrieval; cloud for general research
- Never ask an LLM to "find a case" — ask for case law overview, verify every citation
- Deploy multi-model verification: generate with one, critique with another
- Treat all AI statutory citations as suspect until verified

**Active debates:**
- Can local RAG match frontier models for retrieval? (Yes for narrow tasks vs. only for straightforward law vs. pipeline matters more than deployment)
- Fine-tune legal embeddings or use general-purpose? (General suffices for retrieval vs. legal corpus needed for specialist needs)
```

## Phasing

### Phase 1 (build now)
- `src/lquorum-rag.js` with keyword matching + working memory
- Integration into message handler, classifier, Claude/EVO prompt injection
- System knowledge cleanup
- Dashboard endpoint for warm topics

### Phase 2 (after observing Phase 1)
- Vector fallback for conceptual matches that keywords miss
- Pre-compute 18 topic embeddings at startup via EVO port 8083
- Fire only when keywords return nothing AND message >50 chars
- Tune keyword map based on dashboard false-positive/negative data

## Speed Cost

| Operation | Latency | When |
|-----------|---------|------|
| Keyword scan per message | <1ms | Every group message |
| Working memory lookup | <1ms | Every Clawd response |
| Prompt formatting | ~2ms | Only when topics are warm |
| **Vector fallback (Phase 2)** | ~15ms | Only when keywords miss, async |
| Startup JSON load | ~50ms | Once at boot |

**Net effect on response time: 0ms** — knowledge is pre-staged before Clawd is asked.

## What This Replaces

| Before | After |
|--------|-------|
| Hundreds of 500-char lquorum entries in EVO memory | One overview entry |
| Vector search at response time, hoping for hits | Pre-staged full-depth in working memory |
| ~10ms retrieval, often wrong results | 0ms retrieval, right every time |
| No awareness of ongoing discussion | Continuous topic tracking |
| No proactive knowledge signal | `has_relevant_knowledge` nudges classifier |
| Clawd vaguely aware | Clawd genuinely knowledgeable |

## Formatting Rules

- **No emojis in output.** The lquorum JSON contains flag emojis in jurisdiction comparisons. The formatter must strip all emoji characters before injection. Clawd's system prompt now explicitly prohibits emoji use.
- Jurisdiction comparisons use text labels only: "UK", "Hong Kong", "US" — not flags.

## Engagement Scenarios — Design Rationale

The classifier enrichment targets **questions and uncertainty**, not topic awareness. This prevents Clawd from becoming the "well actually" bot while ensuring genuine gaps get filled.

**Correct engagement (respond):**
- Direct factual question on a warm topic, nobody answering → respond with community findings
- Discussion shows genuine uncertainty about something the community has consensus on → fill the gap
- Stalled question from a new member → respond after reasonable pause

**Correct silence (don't respond):**
- Flowing social conversation that touches a warm topic → stay out
- Someone states a plan that the community data might question → not Clawd's place to correct unsolicited
- Topic mentioned in passing, no depth needed → knowledge stays warm, Clawd stays quiet
- Casual banter, reactions, agreement → always silent

**The key distinction:** warm working memory means Clawd is *ready* to contribute, not that Clawd *should* contribute. The classifier still decides. The enrichment prompt says "someone asks a question or expresses uncertainty" — not "the topic is being discussed."

## What This Doesn't Change

- Mute system, negative signal detection, DM routing — untouched
- Existing memory injection (dreams, identity, general) — still runs alongside
- Classifier still gates all group responses — this gives it better signal, not override
- No new API calls, no new services, no new data stores
- Working memory is in-process, dies on restart, rebuilds from JSON
