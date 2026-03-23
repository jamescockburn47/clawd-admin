# LQuorum Conversational Working Memory — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give Clawd genuine depth on 18 legal AI topics by passively tracking group discussion topics and pre-staging full knowledge into in-process working memory.

**Architecture:** Single new module `src/lquorum-rag.js` loaded at startup, scans every group message for topic keywords, maintains a decaying working memory Map, injects formatted knowledge into Claude/EVO prompts. No new services, no new data stores.

**Tech Stack:** Node.js ESM, in-process Map, JSON file read, regex keyword matching.

**Design doc:** `docs/plans/2026-03-23-lquorum-working-memory-design.md`

---

### Task 1: Create `src/lquorum-rag.js` — Core Module

**Files:**
- Create: `src/lquorum-rag.js`

**Step 1: Create the module with keyword map, working memory, and all exports**

```javascript
// LQuorum Conversational Working Memory
// Passively tracks group discussion topics and pre-stages knowledge for instant retrieval
import { readFileSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

// ── Knowledge store (loaded once at startup) ────────────────────────────────

let knowledgeRepo = null; // Full lquorum-knowledge.json parsed
let resources = null;     // shortcut to knowledgeRepo.resources

function loadKnowledge() {
  try {
    const path = join(process.cwd(), 'data', 'lquorum-knowledge.json');
    knowledgeRepo = JSON.parse(readFileSync(path, 'utf-8'));
    resources = knowledgeRepo.resources || {};
    logger.info({ topics: Object.keys(resources).length }, 'lquorum knowledge loaded');
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to load lquorum knowledge — working memory disabled');
    resources = {};
  }
}

// Load on import
loadKnowledge();

// ── Keyword → topic map ─────────────────────────────────────────────────────

const TOPIC_KEYWORDS = {
  'rag-hallucinations': ['rag', 'hallucination', 'hallucinate', 'provenance', 'citation check',
    'invented case', 'fabricated', 'retrieval augmented', 'vector search', 'embedding model'],
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
    'the group', 'this group'],
};

// ── Working memory ───────────────────────────────────────────────────────────

const workingMemory = new Map();
// topicId → { resource, lastMentioned, hitCount, warmSince }

const BASE_DECAY_MS = 15 * 60 * 1000;      // 15 minutes
const EXTENDED_DECAY_MS = 30 * 60 * 1000;   // 30 minutes for hitCount >= 3
const EXTENDED_THRESHOLD = 3;
const MAX_WARM_TOPICS = 2;
const MIN_MESSAGE_LENGTH = 50;

// Emoji regex — matches all Unicode emoji sequences
const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;

function isPunctHeavy(text) {
  const stripped = text.replace(/[\s\p{P}\p{S}]/gu, '');
  return stripped.length < text.length * 0.2;
}

function isDirectReply(text) {
  return /^@\w+\s*$/i.test(text.trim());
}

function pruneDecayed() {
  const now = Date.now();
  for (const [topicId, entry] of workingMemory) {
    const decay = entry.hitCount >= EXTENDED_THRESHOLD ? EXTENDED_DECAY_MS : BASE_DECAY_MS;
    if (now - entry.lastMentioned > decay) {
      workingMemory.delete(topicId);
      logger.debug({ topicId, hitCount: entry.hitCount }, 'lquorum topic decayed from working memory');
    }
  }
}

function matchTopics(text) {
  const lower = text.toLowerCase();
  const matched = [];
  for (const [topicId, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.push(topicId);
        break;
      }
    }
  }
  return matched;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan a message for lquorum topic keywords and update working memory.
 * Called on every group message — must be fast (<1ms).
 */
export function scanMessage(text) {
  if (!text || !resources) return;
  if (text.length < MIN_MESSAGE_LENGTH) return;
  if (isPunctHeavy(text)) return;
  if (isDirectReply(text)) return;

  pruneDecayed();

  const matched = matchTopics(text);
  const now = Date.now();

  for (const topicId of matched) {
    const existing = workingMemory.get(topicId);
    if (existing) {
      existing.lastMentioned = now;
      existing.hitCount++;
    } else if (resources[topicId]) {
      workingMemory.set(topicId, {
        resource: resources[topicId],
        lastMentioned: now,
        hitCount: 1,
        warmSince: now,
      });
      logger.info({ topicId, title: resources[topicId].title }, 'lquorum topic warmed');
    }
  }
}

/**
 * Get titles of currently warm topics (for classifier enrichment).
 */
export function getWarmTopicTitles() {
  pruneDecayed();
  const titles = [];
  for (const entry of workingMemory.values()) {
    titles.push(entry.resource.title);
  }
  return titles;
}

/**
 * Strip all emoji characters from a string.
 */
function stripEmoji(str) {
  return str.replace(EMOJI_RE, '').trim();
}

/**
 * Format working memory as prompt context for injection.
 * Returns null if nothing warm. Caps at MAX_WARM_TOPICS topics.
 */
export function getWorkingKnowledge() {
  pruneDecayed();
  if (workingMemory.size === 0) return null;

  // Sort by hitCount descending, take top N
  const entries = [...workingMemory.entries()]
    .sort((a, b) => b[1].hitCount - a[1].hitCount)
    .slice(0, MAX_WARM_TOPICS);

  const sections = [];

  for (const [topicId, { resource }] of entries) {
    const lines = [];
    lines.push(`### ${stripEmoji(resource.title)}`);
    lines.push(`*Community knowledge from ${resource.contributorCount} contributors across ${resource.jurisdictionCount} jurisdictions*`);

    // Key findings
    if (resource.keyFindings?.length > 0) {
      lines.push('');
      lines.push('**Key findings:**');
      for (const f of resource.keyFindings) {
        lines.push(`- [${f.confidence.toUpperCase()}] ${stripEmoji(f.insight)}`);
      }
    }

    // Practical consensus
    if (resource.practicalConsensus?.length > 0) {
      lines.push('');
      lines.push('**Practical consensus:**');
      for (const pc of resource.practicalConsensus) {
        lines.push(`- ${stripEmoji(pc)}`);
      }
    }

    // Active debates
    if (resource.activeDebates?.length > 0) {
      lines.push('');
      lines.push('**Active debates:**');
      for (const d of resource.activeDebates) {
        const positions = d.positions
          .map(p => `${p.by}: ${stripEmoji(p.position).slice(0, 120)}`)
          .join(' vs. ');
        lines.push(`- ${stripEmoji(d.question)} (${positions})`);
      }
    }

    sections.push(lines.join('\n'));
  }

  return `## LQuorum Knowledge (active discussion topics)\n\n${sections.join('\n\n')}`;
}

/**
 * Get working memory state for dashboard/debugging.
 */
export function getWorkingMemoryState() {
  pruneDecayed();
  const state = {};
  for (const [topicId, entry] of workingMemory) {
    state[topicId] = {
      title: entry.resource.title,
      hitCount: entry.hitCount,
      warmSince: entry.warmSince,
      lastMentioned: entry.lastMentioned,
      ageSeconds: Math.round((Date.now() - entry.warmSince) / 1000),
      decayType: entry.hitCount >= EXTENDED_THRESHOLD ? 'extended' : 'base',
    };
  }
  return state;
}
```

**Step 2: Verify the module loads without errors**

Run from project root:
```bash
node -e "import('./src/lquorum-rag.js').then(m => { console.log('exports:', Object.keys(m)); m.scanMessage('What embedding model works best for legal RAG pipelines?'); console.log('warm:', m.getWarmTopicTitles()); console.log('knowledge:', m.getWorkingKnowledge()?.slice(0, 200)); })"
```

Expected: prints exports list, warm topic title for `rag-hallucinations`, and first 200 chars of formatted knowledge.

**Step 3: Commit**

```bash
git add src/lquorum-rag.js
git commit -m "feat: add lquorum conversational working memory module"
```

---

### Task 2: Integrate into Message Handler (`src/index.js`)

**Files:**
- Modify: `src/index.js:1-10` (add import)
- Modify: `src/index.js:147-152` (add scan call after pushMessage)

**Step 1: Add import at top of file**

Add after existing imports:

```javascript
import { scanMessage } from './lquorum-rag.js';
```

**Step 2: Add scan call after message is pushed to buffer**

At line ~152, after the `pushMessage()` call and before the `isOwnerChat` check, add:

```javascript
    // Scan for lquorum topics — updates working memory for all group messages
    if (isGroup && text) scanMessage(text);
```

The exact insertion point is after line 152 (`});` closing `pushMessage`) and before line 154 (`if (isOwnerChat...)`).

**Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat: scan group messages for lquorum topic awareness"
```

---

### Task 3: Enrich Engagement Classifier (`src/engagement.js`)

**Files:**
- Modify: `src/engagement.js:2` (add import)
- Modify: `src/engagement.js:97-108` (enrich classifier prompt with warm topics)

**Step 1: Add import**

After line 3 (`import { classifyViaEvo } from './evo-llm.js';`), add:

```javascript
import { getWarmTopicTitles } from './lquorum-rag.js';
```

**Step 2: Enrich the classifier system prompt in `shouldEngage()`**

Replace lines 104-108 (the prompt construction and classifier call) with:

```javascript
    // Enrich classifier with lquorum working memory signal
    const warmTopics = getWarmTopicTitles();
    let systemPrompt = CLASSIFIER_SYSTEM_PROMPT;
    if (warmTopics.length > 0) {
      systemPrompt += `\nClawd has specific community research on: ${warmTopics.join(', ')}. `
        + `Consider responding YES if someone asks a question or expresses uncertainty about these topics.`;
    }

    const prompt = contextLines.length > 0
      ? `Recent conversation:\n${contextLines.join('\n')}\n\nLatest message from ${senderName}: ${messageText}`
      : `Latest message from ${senderName}: ${messageText}`;

    const result = await classifyViaEvo(prompt, systemPrompt);
```

Note: the variable was previously `CLASSIFIER_SYSTEM_PROMPT` passed directly to `classifyViaEvo`. Now it's `systemPrompt` (a potentially enriched copy).

**Step 3: Commit**

```bash
git add src/engagement.js
git commit -m "feat: enrich engagement classifier with lquorum working memory signal"
```

---

### Task 4: Inject Working Knowledge into Claude Prompts (`src/claude.js`)

**Files:**
- Modify: `src/claude.js:1-10` (add import)
- Modify: `src/claude.js:220-231` (inject after dream memories, before system snapshot)

**Step 1: Add import**

Add with existing imports at top of file:

```javascript
import { getWorkingKnowledge } from './lquorum-rag.js';
```

**Step 2: Inject working knowledge after dream memory injection**

After line 220 (the closing `}` of the dream memory block), add:

```javascript
  // Inject lquorum working memory (pre-staged topic knowledge)
  const lquorumContext = getWorkingKnowledge();
  if (lquorumContext) {
    memoryFragment += '\n\n' + lquorumContext;
    logger.info({ topics: lquorumContext.split('###').length - 1 }, 'lquorum working knowledge injected');
  }
```

**Step 3: Commit**

```bash
git add src/claude.js
git commit -m "feat: inject lquorum working knowledge into Claude prompts"
```

---

### Task 5: Inject Working Knowledge into EVO Prompts (`src/evo-llm.js`)

**Files:**
- Modify: `src/evo-llm.js:1-5` (add import)
- Modify: `src/evo-llm.js:97-100` (inject into EVO system prompt)

**Step 1: Add import**

After line 3 (`import logger from './logger.js';`), add:

```javascript
import { getWorkingKnowledge } from './lquorum-rag.js';
```

**Step 2: Inject working knowledge into EVO prompt**

At line 100, change:

```javascript
  const systemPrompt = buildEvoSystemPrompt(category) + memoryFragment;
```

To:

```javascript
  const lquorumContext = getWorkingKnowledge();
  const systemPrompt = buildEvoSystemPrompt(category) + memoryFragment + (lquorumContext ? '\n\n' + lquorumContext : '');
```

**Step 3: Commit**

```bash
git add src/evo-llm.js
git commit -m "feat: inject lquorum working knowledge into EVO prompts"
```

---

### Task 6: Clean Up System Knowledge Seeding (`src/system-knowledge.js`)

**Files:**
- Modify: `src/system-knowledge.js:175-239` (replace bulk lquorum seeding with single overview entry)

**Step 1: Replace the lquorum seeding block**

Replace lines 175-239 (the entire `if (doc.lquorum && doc.lquorum.knowledgeRepoFile)` block) with:

```javascript
  // LQuorum knowledge — single overview entry
  // Full depth is handled by conversational working memory (src/lquorum-rag.js)
  if (doc.lquorum) {
    entries.push({
      fact: `LQuorum community knowledge covers 18 legal AI topics from 40+ lawyers across 12 jurisdictions. Topics include RAG/hallucinations, document processing, DOCX problems, data security, platform reviews, local models, vibe coding, contract review AI, and more. Full knowledge is available through conversational working memory when these topics are discussed.`,
      tags: ['lquorum', 'legal-ai', 'community', 'knowledge'],
    });
    logger.info('LQuorum overview entry generated (full depth via working memory)');
  }
```

**Step 2: Commit**

```bash
git add src/system-knowledge.js
git commit -m "refactor: replace bulk lquorum memory seeding with single overview entry"
```

---

### Task 7: Add Dashboard Endpoint (`src/index.js`)

**Files:**
- Modify: `src/index.js` (add import for `getWorkingMemoryState`, add HTTP endpoint)

**Step 1: Update the import to include `getWorkingMemoryState`**

Change the existing import (from Task 2):

```javascript
import { scanMessage } from './lquorum-rag.js';
```

To:

```javascript
import { scanMessage, getWorkingMemoryState } from './lquorum-rag.js';
```

**Step 2: Add endpoint in the HTTP server**

Find the `createServer` block. After the `/api/status` endpoint (around line 533), add:

```javascript
  if (path === '/api/working-memory') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    return jsonResponse(res, 200, getWorkingMemoryState());
  }
```

**Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat: add working memory dashboard endpoint"
```

---

### Task 8: Deploy and Verify

**Step 1: Deploy all changed files to Pi**

```bash
scp -i C:/Users/James/.ssh/id_ed25519 src/lquorum-rag.js pi@192.168.1.211:~/clawdbot/src/lquorum-rag.js
scp -i C:/Users/James/.ssh/id_ed25519 src/index.js pi@192.168.1.211:~/clawdbot/src/index.js
scp -i C:/Users/James/.ssh/id_ed25519 src/engagement.js pi@192.168.1.211:~/clawdbot/src/engagement.js
scp -i C:/Users/James/.ssh/id_ed25519 src/claude.js pi@192.168.1.211:~/clawdbot/src/claude.js
scp -i C:/Users/James/.ssh/id_ed25519 src/evo-llm.js pi@192.168.1.211:~/clawdbot/src/evo-llm.js
scp -i C:/Users/James/.ssh/id_ed25519 src/system-knowledge.js pi@192.168.1.211:~/clawdbot/src/system-knowledge.js
scp -i C:/Users/James/.ssh/id_ed25519 src/prompt.js pi@192.168.1.211:~/clawdbot/src/prompt.js
scp -i C:/Users/James/.ssh/id_ed25519 data/lquorum-knowledge.json pi@192.168.1.211:~/clawdbot/data/lquorum-knowledge.json
```

**Step 2: Restart service**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "sudo systemctl restart clawdbot"
```

**Step 3: Check logs for successful startup**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "journalctl -u clawdbot --no-pager -n 20"
```

Expected: log line containing `lquorum knowledge loaded` with `topics: 18`.

**Step 4: Verify working memory endpoint**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "curl -s http://localhost:3000/api/working-memory?token=VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM"
```

Expected: `{}` (empty object — no topics warm yet, which is correct at startup).

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: lquorum conversational working memory — Phase 1 complete"
```
