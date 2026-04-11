# Clint Group Participation + Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thin, low-latency participation layer that lets Clint join group threads intelligently, continue bounded follow-up conversations, stop before becoming irritating, and expose his behavioural contract in the Clint Console.

**Architecture:** Keep `group-registry`, `agency/policy`, `cortex`, and the current console pages as the authoritative base. Add a new `src/participation/` domain that owns group participation policy, rolling conversation state, follow-up windows, contribution planning, and structured decision logs. Integrate that layer into the existing ambient-agency path first, then expose its state and controls through new bot HTTP routes and focused console pages/components.

**Tech Stack:** Node.js 20 + `tsx`, ESM, TypeScript for all new code, `node:test` via `tsx --test` for backend and pure-TS console helpers, Next.js 16.2.2 App Router, React 19, shadcn/ui.

---

## Scope check

This spec touches multiple surfaces, but they are not independent subsystems:

- bot participation logic
- runtime persistence and feedback
- bot HTTP read/write routes
- console operator surfaces
- overnight analysis inputs

All four depend on the same participation data model. Splitting into separate plans would create interface drift. Keep one plan, but implement in phases that each leave the system working and reviewable.

## File map

### New backend files

- `src/participation/types.ts`
  Shared TypeScript types for participation posture, contribution roles, follow-up windows, reply targets, and decision log entries.
- `src/participation/constants.ts`
  Central constants for cooldowns, follow-up-window TTLs, soft stop thresholds, and default posture settings.
- `src/participation/policy-service.ts`
  Loads/saves per-group participation profiles from runtime JSON and merges them with `group-registry` data.
- `src/participation/conversation-state.ts`
  Maintains rolling per-group conversation state and reply/engagement windows.
- `src/participation/reply-target.ts`
  Extracts quoted/replied-to message anchors from incoming WhatsApp messages and ambient follow-up state.
- `src/participation/contribution-planner.ts`
  Chooses `silence` vs a specific contribution role with low-latency heuristics and optional local classifier support.
- `src/participation/context-pack.ts`
  Builds a role-specific context request, reusing transcript slices and `cortex` output instead of duplicating retrieval.
- `src/participation/engagement-service.ts`
  Opens/closes follow-up windows and enforces stop rules.
- `src/participation/log-store.ts`
  Appends structured participation decisions/feedback to JSONL files and reads them back for APIs.
- `src/participation/http.ts`
  Small helpers for request/response payload shaping so `http-server.js` stays readable.

### New backend tests

- `src/participation/__tests__/policy-service.test.ts`
- `src/participation/__tests__/conversation-state.test.ts`
- `src/participation/__tests__/contribution-planner.test.ts`
- `src/participation/__tests__/engagement-service.test.ts`
- `src/participation/__tests__/log-store.test.ts`

### Modified backend files

- `src/agency/service.js`
  Replace ad hoc ambient decision flow with the new participation layer while preserving current security constraints.
- `src/message-handler.js`
  Feed reply-target metadata and follow-up opportunities into the participation layer.
- `src/reasoning-trace.js`
  Extend trace schema with participation fields.
- `src/interaction-log.js`
  Capture participation-specific metadata and richer feedback linkage.
- `src/http-server.js`
  Add read/write routes for participation policy, recent decisions, and feedback summaries.
- `src/group-registry.js`
  Read-only dependency; only touch if a tiny helper is needed to avoid duplicate mode logic.
- `src/claude.js`
  Only touch if a small helper is needed to support participation metadata; do not add a second response path.

### New console files

- `clawd-console/src/app/(console)/groups/page.tsx`
  Per-group participation control surface.
- `clawd-console/src/app/(console)/playbook/page.tsx`
  Plain-English operator manual and effective instruction view.
- `clawd-console/src/components/groups/group-card.tsx`
- `clawd-console/src/components/groups/group-detail.tsx`
- `clawd-console/src/components/playbook/instruction-stack.tsx`
- `clawd-console/src/components/playbook/role-playbook.tsx`
- `clawd-console/src/components/playbook/follow-up-playbook.tsx`
- `clawd-console/src/lib/participation/view-models.ts`
  Pure mapping helpers for participation API payloads -> UI display.
- `clawd-console/src/lib/participation/__tests__/view-models.test.ts`
  Pure helper tests using `tsx --test`.

### Modified console files

- `clawd-console/src/components/layout/sidebar.tsx`
  Add `Groups` and `Playbook` navigation.
- `clawd-console/src/lib/types.ts`
  Add participation policy, decision-log, follow-up-window, and feedback summary types.
- `clawd-console/src/lib/api.ts`
  Add typed helper calls if needed for participation endpoints.
- `clawd-console/src/app/mission-control/page.tsx`
  Show global posture summary and participation status indicators without duplicating the new pages.
- `clawd-console/src/app/(console)/memory/page.tsx`
  Add behavioural lens filters/tabs over the existing browser.
- `clawd-console/src/app/(console)/overnight/page.tsx`
  Add participation-learning sections once backend routes exist.

---

### Task 1: Participation contracts and runtime persistence

**Files:**
- Create: `src/participation/types.ts`
- Create: `src/participation/constants.ts`
- Create: `src/participation/policy-service.ts`
- Test: `src/participation/__tests__/policy-service.test.ts`

- [ ] **Step 1: Write the failing policy-service test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getParticipationProfile,
  mergeParticipationProfile,
  resetParticipationProfilesForTest,
} from '../policy-service.ts';

test('getParticipationProfile returns direct_only by default for unknown groups', () => {
  resetParticipationProfilesForTest();
  const profile = getParticipationProfile({
    chatJid: '123@g.us',
    groupLabel: 'Unknown Group',
    groupMode: 'colleague',
  });

  assert.equal(profile.posture, 'direct_only');
  assert.equal(profile.researchEnabled, true);
  assert.equal(profile.memoryRecallEnabled, true);
});

test('mergeParticipationProfile preserves security mode and only updates participation settings', () => {
  resetParticipationProfilesForTest();

  mergeParticipationProfile('lqcore@g.us', {
    posture: 'rare_high_confidence',
    maxUnsolicitedPerHour: 4,
    followUpWindowMs: 180000,
  });

  const profile = getParticipationProfile({
    chatJid: 'lqcore@g.us',
    groupLabel: 'LQCore',
    groupMode: 'open',
  });

  assert.equal(profile.posture, 'rare_high_confidence');
  assert.equal(profile.maxUnsolicitedPerHour, 4);
  assert.equal(profile.groupMode, 'open');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/participation/__tests__/policy-service.test.ts`

Expected: FAIL with module-not-found errors for `policy-service.ts` and `types.ts`.

- [ ] **Step 3: Write minimal domain types and policy persistence**

```ts
// src/participation/types.ts
export type ParticipationPosture = 'direct_only' | 'rare_high_confidence' | 'active_participant';

export interface ParticipationProfile {
  chatJid: string;
  groupLabel: string | null;
  groupMode: 'open' | 'project' | 'colleague';
  posture: ParticipationPosture;
  researchEnabled: boolean;
  memoryRecallEnabled: boolean;
  maxUnsolicitedPerHour: number;
  followUpWindowMs: number;
  cooldownMs: number;
}
```

```ts
// src/participation/constants.ts
export const PARTICIPATION_DEFAULTS = Object.freeze({
  directOnlyPosture: 'direct_only',
  rareHighConfidencePosture: 'rare_high_confidence',
  followUpWindowMs: 180000,
  cooldownMs: 180000,
  maxUnsolicitedPerHour: 3,
});
```

```ts
// src/participation/policy-service.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARTICIPATION_DEFAULTS } from './constants.ts';
import type { ParticipationProfile, ParticipationPosture } from './types.ts';

const FILE = join('data', 'runtime', 'group-participation.json');
let cache: Record<string, Partial<ParticipationProfile>> | null = null;

function ensureLoaded(): Record<string, Partial<ParticipationProfile>> {
  if (cache) return cache;
  if (!existsSync(FILE)) {
    mkdirSync(join('data', 'runtime'), { recursive: true });
    cache = {};
    return cache;
  }
  cache = JSON.parse(readFileSync(FILE, 'utf8'));
  return cache;
}

function save(next: Record<string, Partial<ParticipationProfile>>): void {
  mkdirSync(join('data', 'runtime'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2));
  cache = next;
}

export function getParticipationProfile(input: {
  chatJid: string;
  groupLabel: string | null;
  groupMode: 'open' | 'project' | 'colleague';
}): ParticipationProfile {
  const stored = ensureLoaded()[input.chatJid] ?? {};
  const defaultPosture: ParticipationPosture =
    input.groupMode === 'open' ? 'direct_only' : 'direct_only';

  return {
    chatJid: input.chatJid,
    groupLabel: input.groupLabel,
    groupMode: input.groupMode,
    posture: (stored.posture as ParticipationPosture | undefined) ?? defaultPosture,
    researchEnabled: stored.researchEnabled ?? true,
    memoryRecallEnabled: stored.memoryRecallEnabled ?? true,
    maxUnsolicitedPerHour: stored.maxUnsolicitedPerHour ?? PARTICIPATION_DEFAULTS.maxUnsolicitedPerHour,
    followUpWindowMs: stored.followUpWindowMs ?? PARTICIPATION_DEFAULTS.followUpWindowMs,
    cooldownMs: stored.cooldownMs ?? PARTICIPATION_DEFAULTS.cooldownMs,
  };
}

export function mergeParticipationProfile(chatJid: string, patch: Partial<ParticipationProfile>): void {
  const current = ensureLoaded();
  save({
    ...current,
    [chatJid]: {
      ...(current[chatJid] ?? {}),
      ...patch,
    },
  });
}

export function resetParticipationProfilesForTest(): void {
  cache = {};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/participation/__tests__/policy-service.test.ts`

Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/participation/types.ts src/participation/constants.ts src/participation/policy-service.ts src/participation/__tests__/policy-service.test.ts
git commit -m "feat: add participation policy domain"
```

### Task 2: Rolling conversation state and follow-up windows

**Files:**
- Create: `src/participation/conversation-state.ts`
- Create: `src/participation/reply-target.ts`
- Create: `src/participation/engagement-service.ts`
- Test: `src/participation/__tests__/conversation-state.test.ts`
- Test: `src/participation/__tests__/engagement-service.test.ts`

- [ ] **Step 1: Write the failing conversation-state test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordParticipantTurn,
  openFollowUpWindow,
  getConversationState,
  clearConversationStateForTest,
} from '../conversation-state.ts';

test('opening a follow-up window marks the group as in active follow-up', () => {
  clearConversationStateForTest();

  recordParticipantTurn({
    chatJid: 'lqcore@g.us',
    senderName: 'Clint',
    text: 'The missing question is whether the authority still stands after SAR changes.',
    messageId: 'bot-1',
    timestamp: 1,
    isBot: true,
  });

  openFollowUpWindow({
    chatJid: 'lqcore@g.us',
    sourceMessageId: 'bot-1',
    replyTarget: { kind: 'quoted', messageId: 'human-1', senderName: 'James' },
    expiresAt: 181000,
  });

  const state = getConversationState('lqcore@g.us');
  assert.equal(state.followUpWindow?.open, true);
  assert.equal(state.followUpWindow?.sourceMessageId, 'bot-1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/participation/__tests__/conversation-state.test.ts src/participation/__tests__/engagement-service.test.ts`

Expected: FAIL because `conversation-state.ts` and `engagement-service.ts` do not exist.

- [ ] **Step 3: Implement rolling state and follow-up window management**

```ts
// src/participation/conversation-state.ts
import type { ReplyTarget } from './types.ts';

interface TurnRecord {
  senderName: string;
  text: string;
  messageId: string | null;
  timestamp: number;
  isBot: boolean;
}

interface FollowUpWindow {
  open: boolean;
  sourceMessageId: string;
  replyTarget: ReplyTarget | null;
  expiresAt: number;
  turnIndex: number;
}

interface ConversationState {
  turns: TurnRecord[];
  followUpWindow: FollowUpWindow | null;
}

const state = new Map<string, ConversationState>();

export function recordParticipantTurn(input: {
  chatJid: string;
  senderName: string;
  text: string;
  messageId: string | null;
  timestamp: number;
  isBot: boolean;
}): void {
  const current = state.get(input.chatJid) ?? { turns: [], followUpWindow: null };
  current.turns.push(input);
  current.turns = current.turns.slice(-40);
  state.set(input.chatJid, current);
}

export function openFollowUpWindow(input: {
  chatJid: string;
  sourceMessageId: string;
  replyTarget: ReplyTarget | null;
  expiresAt: number;
}): void {
  const current = state.get(input.chatJid) ?? { turns: [], followUpWindow: null };
  current.followUpWindow = {
    open: true,
    sourceMessageId: input.sourceMessageId,
    replyTarget: input.replyTarget,
    expiresAt: input.expiresAt,
    turnIndex: 0,
  };
  state.set(input.chatJid, current);
}
```

```ts
// src/participation/engagement-service.ts
import { PARTICIPATION_DEFAULTS } from './constants.ts';
import { getConversationState, closeFollowUpWindow, incrementFollowUpTurn } from './conversation-state.ts';

export function shouldContinueFollowUp(input: {
  chatJid: string;
  now: number;
  directlyRepliesToClint: boolean;
  mentionsClint: boolean;
}): boolean {
  const current = getConversationState(input.chatJid);
  const window = current.followUpWindow;
  if (!window?.open) return false;
  if (input.now > window.expiresAt) {
    closeFollowUpWindow(input.chatJid);
    return false;
  }
  return input.directlyRepliesToClint || input.mentionsClint;
}

export function registerFollowUpTurn(chatJid: string): void {
  incrementFollowUpTurn(chatJid);
}

export function getDefaultFollowUpWindowMs(): number {
  return PARTICIPATION_DEFAULTS.followUpWindowMs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/participation/__tests__/conversation-state.test.ts src/participation/__tests__/engagement-service.test.ts`

Expected: PASS with follow-up window open/expire/continue tests all green.

- [ ] **Step 5: Commit**

```bash
git add src/participation/conversation-state.ts src/participation/reply-target.ts src/participation/engagement-service.ts src/participation/__tests__/conversation-state.test.ts src/participation/__tests__/engagement-service.test.ts
git commit -m "feat: add conversation state and follow-up windows"
```

### Task 3: Contribution planning and context-pack shaping

**Files:**
- Create: `src/participation/contribution-planner.ts`
- Create: `src/participation/context-pack.ts`
- Test: `src/participation/__tests__/contribution-planner.test.ts`

- [ ] **Step 1: Write the failing contribution-planner test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { planContribution } from '../contribution-planner.ts';

test('planner prefers direct continuation inside an active follow-up exchange', () => {
  const plan = planContribution({
    posture: 'rare_high_confidence',
    inFollowUpExchange: true,
    directlyRepliesToClint: true,
    hasQuestion: true,
    hasResearchGap: false,
    hasDecisionSignal: false,
    hasMemorySignal: false,
  });

  assert.equal(plan.role, 'answer');
  assert.equal(plan.shouldSpeak, true);
  assert.equal(plan.reason, 'follow_up_continuation');
});

test('planner stays silent on low-signal casual chatter', () => {
  const plan = planContribution({
    posture: 'rare_high_confidence',
    inFollowUpExchange: false,
    directlyRepliesToClint: false,
    hasQuestion: false,
    hasResearchGap: false,
    hasDecisionSignal: false,
    hasMemorySignal: false,
    casualChatter: true,
  });

  assert.equal(plan.role, 'silence');
  assert.equal(plan.shouldSpeak, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/participation/__tests__/contribution-planner.test.ts`

Expected: FAIL because `contribution-planner.ts` does not exist.

- [ ] **Step 3: Implement the minimal planner and context pack builder**

```ts
// src/participation/contribution-planner.ts
import type { ParticipationPosture } from './types.ts';

export interface ContributionPlan {
  shouldSpeak: boolean;
  role: 'silence' | 'answer' | 'memory_recall' | 'research_injection' | 'synthesis' | 'correction' | 'challenge' | 'decision_capture' | 'action_framing';
  reason: string;
}

export function planContribution(input: {
  posture: ParticipationPosture;
  inFollowUpExchange: boolean;
  directlyRepliesToClint: boolean;
  hasQuestion: boolean;
  hasResearchGap: boolean;
  hasDecisionSignal: boolean;
  hasMemorySignal: boolean;
  casualChatter?: boolean;
}): ContributionPlan {
  if (input.casualChatter) {
    return { shouldSpeak: false, role: 'silence', reason: 'casual_chatter' };
  }

  if (input.inFollowUpExchange && input.directlyRepliesToClint && input.hasQuestion) {
    return { shouldSpeak: true, role: 'answer', reason: 'follow_up_continuation' };
  }

  if (input.hasResearchGap) {
    return { shouldSpeak: true, role: 'research_injection', reason: 'research_gap' };
  }

  if (input.hasDecisionSignal) {
    return { shouldSpeak: true, role: 'decision_capture', reason: 'decision_signal' };
  }

  if (input.hasMemorySignal) {
    return { shouldSpeak: true, role: 'memory_recall', reason: 'memory_signal' };
  }

  return { shouldSpeak: false, role: 'silence', reason: 'no_high_value_move' };
}
```

```ts
// src/participation/context-pack.ts
export function buildContextPack(input: {
  role: string;
  transcript: string;
  relevantMemoryText: string | null;
  prefetchedWebText: string | null;
}): string {
  const parts = [`## Recent conversation\n${input.transcript}`];
  if (input.role === 'memory_recall' && input.relevantMemoryText) {
    parts.push(`## Relevant memory\n${input.relevantMemoryText}`);
  }
  if (input.role === 'research_injection' && input.prefetchedWebText) {
    parts.push(`## Current research\n${input.prefetchedWebText}`);
  }
  return parts.join('\n\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/participation/__tests__/contribution-planner.test.ts`

Expected: PASS with both planner tests green.

- [ ] **Step 5: Commit**

```bash
git add src/participation/contribution-planner.ts src/participation/context-pack.ts src/participation/__tests__/contribution-planner.test.ts
git commit -m "feat: add participation planning primitives"
```

### Task 4: Integrate the participation layer into the bot hot path

**Files:**
- Modify: `src/message-handler.js`
- Modify: `src/agency/service.js`
- Modify: `src/reasoning-trace.js`
- Modify: `src/interaction-log.js`
- Test: `src/participation/__tests__/log-store.test.ts`
- Test: `src/participation/__tests__/engagement-service.test.ts`

- [ ] **Step 1: Write the failing log-store test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendParticipationDecision, getRecentParticipationDecisions, resetParticipationLogsForTest } from '../log-store.ts';

test('appendParticipationDecision records replyTarget and follow-up metadata', () => {
  resetParticipationLogsForTest();

  appendParticipationDecision({
    chatJid: 'lqcore@g.us',
    shouldIntervene: true,
    interventionType: 'research_injection',
    reason: 'follow_up_continuation',
    confidence: 0.84,
    replyTarget: { kind: 'quoted', messageId: 'm-1', senderName: 'James' },
    followUpWindowOpen: true,
    followUpTurnIndex: 1,
  });

  const items = getRecentParticipationDecisions(10);
  assert.equal(items[0]?.replyTarget?.messageId, 'm-1');
  assert.equal(items[0]?.followUpTurnIndex, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/participation/__tests__/log-store.test.ts`

Expected: FAIL because `log-store.ts` does not exist.

- [ ] **Step 3: Add structured participation logging and wire it into message handling**

```ts
// src/participation/log-store.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = join('data', 'participation-decisions.jsonl');

export function appendParticipationDecision(entry: Record<string, unknown>): void {
  mkdirSync('data', { recursive: true });
  appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

export function getRecentParticipationDecisions(limit = 50): Array<Record<string, unknown>> {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map((line) => JSON.parse(line));
}
```

```js
// src/message-handler.js (integration sketch)
const replyTarget = extractReplyTarget(message, botJid);
recordParticipantTurn({
  chatJid,
  senderName,
  text,
  messageId: msgId ?? null,
  timestamp: Date.now(),
  isBot: false,
});
```

```js
// src/agency/service.js (integration sketch)
const profile = getParticipationProfile({
  chatJid: opts.chatJid,
  groupLabel,
  groupMode: getGroupMode(opts.chatJid),
});

const inFollowUpExchange = shouldContinueFollowUp({
  chatJid: opts.chatJid,
  now,
  directlyRepliesToClint: opts.replyTarget?.kind === 'quoted_to_clint',
  mentionsClint: false,
});

const plan = planContribution({
  posture: profile.posture,
  inFollowUpExchange,
  directlyRepliesToClint: opts.replyTarget?.kind === 'quoted_to_clint',
  hasQuestion: /\?/i.test(opts.text),
  hasResearchGap: heuristic.signals.includes('research_gap'),
  hasDecisionSignal: heuristic.signals.includes('action_items'),
  hasMemorySignal: heuristic.signals.includes('synthesis_needed'),
  casualChatter: heuristic.signals.includes('casual_chatter'),
});
```

- [ ] **Step 4: Extend trace/log schemas without breaking existing readers**

```js
// src/reasoning-trace.js
// Add optional:
// participation: {
//   shouldIntervene,
//   reason,
//   interventionType,
//   replyTarget,
//   followUpWindowOpen,
//   followUpTurnIndex,
// }
```

```js
// src/interaction-log.js
// Extend routing/input payloads to allow:
// input.replyTarget
// routing.participation
// response.followUpWindowOpen
```

- [ ] **Step 5: Run integration-focused tests**

Run: `npx tsx --test src/participation/__tests__/engagement-service.test.ts src/participation/__tests__/log-store.test.ts`

Expected: PASS, with no regressions in follow-up-window or log-write behaviour.

- [ ] **Step 6: Run targeted backend smoke tests**

Run: `npx tsx --test src/participation/__tests__/policy-service.test.ts src/participation/__tests__/conversation-state.test.ts src/participation/__tests__/contribution-planner.test.ts src/participation/__tests__/engagement-service.test.ts src/participation/__tests__/log-store.test.ts`

Expected: PASS, all participation tests green.

- [ ] **Step 7: Commit**

```bash
git add src/message-handler.js src/agency/service.js src/reasoning-trace.js src/interaction-log.js src/participation/log-store.ts src/participation/__tests__/log-store.test.ts
git commit -m "feat: wire participation layer into group handling"
```

### Task 5: Add bot HTTP participation APIs and console type contracts

**Files:**
- Create: `src/participation/http.ts`
- Modify: `src/http-server.js`
- Modify: `clawd-console/src/lib/types.ts`
- Modify: `clawd-console/src/lib/api.ts`
- Test: `src/participation/__tests__/log-store.test.ts`

- [ ] **Step 1: Write the failing API-shaping test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParticipationSummary } from '../http.ts';

test('buildParticipationSummary returns console-safe fields only', () => {
  const summary = buildParticipationSummary({
    chatJid: 'lqcore@g.us',
    groupLabel: 'LQCore',
    posture: 'rare_high_confidence',
    maxUnsolicitedPerHour: 3,
    followUpWindowMs: 180000,
  });

  assert.equal(summary.chatJid, 'lqcore@g.us');
  assert.equal(summary.posture, 'rare_high_confidence');
  assert.ok(!('blockedTopicsRaw' in summary));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/participation/__tests__/http.test.ts`

Expected: FAIL because `http.ts` and its test do not exist.

- [ ] **Step 3: Implement the new backend routes**

```js
// src/http-server.js (route sketch)
if (path === '/api/participation/groups') {
  if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
  const groups = getRegisteredGroups().map((group) => buildParticipationSummary({
    ...group,
    ...getParticipationProfile({
      chatJid: group.jid,
      groupLabel: group.label,
      groupMode: group.mode,
    }),
  }));
  return json(res, 200, { groups });
}

if (path.startsWith('/api/participation/decisions')) {
  if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
  return json(res, 200, { items: getRecentParticipationDecisions(100) });
}
```

```ts
// clawd-console/src/lib/types.ts
export interface ParticipationGroupSummary {
  chatJid: string;
  label: string | null;
  mode: 'open' | 'project' | 'colleague';
  posture: 'direct_only' | 'rare_high_confidence' | 'active_participant';
  maxUnsolicitedPerHour: number;
  followUpWindowMs: number;
}

export interface ParticipationDecision {
  ts: string;
  chatJid: string;
  shouldIntervene: boolean;
  interventionType: string | null;
  reason: string;
  confidence: number;
  replyTarget?: { kind: string; messageId?: string | null; senderName?: string | null } | null;
  followUpWindowOpen: boolean;
  followUpTurnIndex: number;
}
```

- [ ] **Step 4: Run the backend API helper test**

Run: `npx tsx --test src/participation/__tests__/http.test.ts`

Expected: PASS.

- [ ] **Step 5: Typecheck the console after adding new payload types**

Run: `npm run typecheck`

Expected: PASS from the repo root with no TypeScript errors caused by new participation types.

- [ ] **Step 6: Commit**

```bash
git add src/participation/http.ts src/http-server.js clawd-console/src/lib/types.ts clawd-console/src/lib/api.ts src/participation/__tests__/http.test.ts
git commit -m "feat: expose participation APIs for console"
```

### Task 6: Add the `Groups` and `Playbook` console surfaces

**Files:**
- Create: `clawd-console/src/app/(console)/groups/page.tsx`
- Create: `clawd-console/src/app/(console)/playbook/page.tsx`
- Create: `clawd-console/src/components/groups/group-card.tsx`
- Create: `clawd-console/src/components/groups/group-detail.tsx`
- Create: `clawd-console/src/components/playbook/instruction-stack.tsx`
- Create: `clawd-console/src/components/playbook/role-playbook.tsx`
- Create: `clawd-console/src/components/playbook/follow-up-playbook.tsx`
- Create: `clawd-console/src/lib/participation/view-models.ts`
- Create: `clawd-console/src/lib/participation/__tests__/view-models.test.ts`
- Modify: `clawd-console/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Write the failing pure helper test for console view models**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInstructionStackRows } from '../view-models.ts';

test('buildInstructionStackRows orders inherited and overridden rules clearly', () => {
  const rows = buildInstructionStackRows({
    mode: 'open',
    posture: 'rare_high_confidence',
    followUpWindowMs: 180000,
  });

  assert.equal(rows[0]?.layer, 'Security/privacy restrictions');
  assert.equal(rows.some((row) => row.layer === 'Participation policy'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test clawd-console/src/lib/participation/__tests__/view-models.test.ts`

Expected: FAIL because `view-models.ts` does not exist.

- [ ] **Step 3: Implement the pure view-model mapper first**

```ts
// clawd-console/src/lib/participation/view-models.ts
export interface InstructionStackRow {
  layer: string;
  source: string;
  summary: string;
}

export function buildInstructionStackRows(input: {
  mode: 'open' | 'project' | 'colleague';
  posture: 'direct_only' | 'rare_high_confidence' | 'active_participant';
  followUpWindowMs: number;
}): InstructionStackRow[] {
  return [
    {
      layer: 'Security/privacy restrictions',
      source: `group-registry:${input.mode}`,
      summary: `Mode ${input.mode} remains authoritative for privacy boundaries.`,
    },
    {
      layer: 'Participation policy',
      source: 'participation-profile',
      summary: `Posture ${input.posture}, follow-up window ${Math.round(input.followUpWindowMs / 1000)}s.`,
    },
  ];
}
```

- [ ] **Step 4: Build the pages and wire sidebar navigation**

```tsx
// clawd-console/src/components/layout/sidebar.tsx
{ href: '/groups', label: 'Groups', icon: Users }
{ href: '/playbook', label: 'Playbook', icon: BookOpen }
```

```tsx
// clawd-console/src/app/(console)/playbook/page.tsx
export default async function PlaybookPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Playbook</h1>
      <InstructionStack />
      <RolePlaybook />
      <FollowUpPlaybook />
    </div>
  );
}
```

- [ ] **Step 5: Run the pure helper test**

Run: `npx tsx --test clawd-console/src/lib/participation/__tests__/view-models.test.ts`

Expected: PASS.

- [ ] **Step 6: Verify the console compiles**

Run: `npm run build`

Working directory: `C:\Users\James\Downloads\clawdbot-claude-code\clawd-console`

Expected: PASS with a production Next.js build.

- [ ] **Step 7: Commit**

```bash
git add clawd-console/src/app/\(console\)/groups/page.tsx clawd-console/src/app/\(console\)/playbook/page.tsx clawd-console/src/components/groups/group-card.tsx clawd-console/src/components/groups/group-detail.tsx clawd-console/src/components/playbook/instruction-stack.tsx clawd-console/src/components/playbook/role-playbook.tsx clawd-console/src/components/playbook/follow-up-playbook.tsx clawd-console/src/lib/participation/view-models.ts clawd-console/src/lib/participation/__tests__/view-models.test.ts clawd-console/src/components/layout/sidebar.tsx
git commit -m "feat: add participation control surfaces to console"
```

### Task 7: Extend `Mission`, `Memory`, and `Overnight` with behavioural views

**Files:**
- Modify: `clawd-console/src/app/mission-control/page.tsx`
- Modify: `clawd-console/src/app/(console)/memory/page.tsx`
- Modify: `clawd-console/src/app/(console)/overnight/page.tsx`
- Modify: `clawd-console/src/lib/participation/view-models.ts`
- Test: `clawd-console/src/lib/participation/__tests__/view-models.test.ts`

- [ ] **Step 1: Add a failing view-model test for mission summary and memory lens tabs**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParticipationMissionSummary, getMemoryLensTabs } from '../view-models.ts';

test('buildParticipationMissionSummary surfaces posture, cooldown, and acceptance signals', () => {
  const summary = buildParticipationMissionSummary({
    defaultPosture: 'rare_high_confidence',
    cooldownActive: false,
    acceptanceRate: 0.72,
  });

  assert.match(summary, /rare_high_confidence/i);
  assert.match(summary, /72%/);
});

test('getMemoryLensTabs includes interaction history and style notes', () => {
  assert.deepEqual(getMemoryLensTabs().slice(-2), ['interaction history', 'style notes']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test clawd-console/src/lib/participation/__tests__/view-models.test.ts`

Expected: FAIL because the new exports do not exist yet.

- [ ] **Step 3: Implement the view-model helpers and UI slices**

```ts
// clawd-console/src/lib/participation/view-models.ts
export function buildParticipationMissionSummary(input: {
  defaultPosture: string;
  cooldownActive: boolean;
  acceptanceRate: number;
}): string {
  const pct = Math.round(input.acceptanceRate * 100);
  return `Default posture ${input.defaultPosture}. Cooldown ${input.cooldownActive ? 'active' : 'clear'}. Acceptance ${pct}%.`;
}

export function getMemoryLensTabs(): string[] {
  return ['facts', 'decisions', 'active threads', 'people', 'interaction history', 'style notes'];
}
```

```tsx
// mission-control/page.tsx sketch
<StatusFooter
  messageCount={messages.length}
  modelDistribution={modelDistribution}
  forgeSchedule={forgeSchedule}
/>
<div className="border-t border-zinc-800 px-4 py-2 text-xs text-zinc-400">
  {participationSummary}
</div>
```

```tsx
// memory/page.tsx sketch
<Tabs defaultValue="facts">
  <TabsList>
    {getMemoryLensTabs().map((tab) => (
      <TabsTrigger key={tab} value={tab}>{tab}</TabsTrigger>
    ))}
  </TabsList>
</Tabs>
```

- [ ] **Step 4: Re-run the helper test**

Run: `npx tsx --test clawd-console/src/lib/participation/__tests__/view-models.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the console build**

Run: `npm run build`

Working directory: `C:\Users\James\Downloads\clawdbot-claude-code\clawd-console`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add clawd-console/src/app/mission-control/page.tsx clawd-console/src/app/\(console\)/memory/page.tsx clawd-console/src/app/\(console\)/overnight/page.tsx clawd-console/src/lib/participation/view-models.ts clawd-console/src/lib/participation/__tests__/view-models.test.ts
git commit -m "feat: add behavioural participation views to existing console pages"
```

### Task 8: Feed participation outcomes into overnight learning

**Files:**
- Modify: `src/interaction-log.js`
- Modify: `src/reasoning-trace.js`
- Modify: `src/overnight/report-task.ts`
- Modify: `src/overnight/morning-report.ts`
- Modify: `clawd-console/src/app/(console)/overnight/page.tsx`
- Test: `src/overnight/__tests__/report.test.ts`

- [ ] **Step 1: Write the failing overnight report test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMorningReport } from '../morning-report.ts';

test('buildMorningReport includes participation learning summary when decision logs exist', () => {
  const report = buildMorningReport({
    date: '2026-04-11',
    events: [],
    observations: [],
    participationSummary: {
      reviewed: 6,
      accepted: 4,
      overstayed: 1,
      missedOpenings: 2,
    },
  });

  assert.match(report.text, /participation/i);
  assert.match(report.text, /overstayed/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/overnight/__tests__/report.test.ts`

Expected: FAIL because `participationSummary` is not yet part of report generation.

- [ ] **Step 3: Add participation summary ingestion to overnight report generation**

```ts
// src/overnight/morning-report.ts sketch
if (input.participationSummary) {
  sections.push(
    `Participation: reviewed ${input.participationSummary.reviewed} interventions, ` +
    `${input.participationSummary.accepted} landed well, ` +
    `${input.participationSummary.overstayed} looked overstayed, ` +
    `${input.participationSummary.missedOpenings} looked like missed openings.`
  );
}
```

```ts
// src/overnight/report-task.ts sketch
const participationSummary = summariseParticipationLogs({ date: todayStr });
```

- [ ] **Step 4: Re-run the overnight report test**

Run: `npx tsx --test src/overnight/__tests__/report.test.ts`

Expected: PASS, existing report behaviour still intact with the new participation section.

- [ ] **Step 5: Run a final backend regression slice**

Run: `npx tsx --test src/participation/__tests__/policy-service.test.ts src/participation/__tests__/conversation-state.test.ts src/participation/__tests__/contribution-planner.test.ts src/participation/__tests__/engagement-service.test.ts src/participation/__tests__/log-store.test.ts src/overnight/__tests__/report.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/interaction-log.js src/reasoning-trace.js src/overnight/report-task.ts src/overnight/morning-report.ts clawd-console/src/app/\(console\)/overnight/page.tsx src/overnight/__tests__/report.test.ts
git commit -m "feat: add participation learning to overnight reporting"
```

---

## Self-review

### Spec coverage

- Participation posture and thin orchestration layer: covered by Tasks 1-4.
- Follow-up conversations and not-one-shot behaviour: covered by Tasks 2-4.
- Reply targeting and clear thread anchoring: covered by Tasks 2 and 4.
- Stop rules and anti-irritation controls: covered by Tasks 2, 4, and 6.
- No duplicated retrieval / no extra cloud planning: enforced in Tasks 3 and 4.
- Console instruction stack and playbook: covered by Tasks 5-7.
- Overnight learning/feedback loop: covered by Task 8.

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Each task names concrete files, commands, and code skeletons.
- Console testing is kept to pure helper tests plus `next build`, avoiding fake promises of a missing UI-test harness.

### Type consistency

- Posture values are consistent: `direct_only`, `rare_high_confidence`, `active_participant`.
- Contribution roles are consistent across plan and spec.
- Follow-up window fields are named consistently: `followUpWindowOpen`, `followUpTurnIndex`, `replyTarget`.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-11-group-participation-and-console.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
