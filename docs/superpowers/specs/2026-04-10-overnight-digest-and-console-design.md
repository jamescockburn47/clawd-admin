# Overnight Digest + Clawd Console Drill-Down

**Spec date:** 2026-04-10
**Author:** James C (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md` §4.3 (REPORT stage)
**Related:** `docs/superpowers/specs/2026-04-10-compound-dream-phase1-shadow-mode-design.md`
**Status:** Design — awaiting implementation plan

---

## 1. Why this exists

The morning briefing's "Overnight insights" section is four bullets of raw text with no context, no staleness guard, no link to what actually happened overnight. James calls it inscrutable. He wants two things:

1. **A single, plainly written, simple WhatsApp DM every morning** summarising what every overnight process did and what the effect was. One paragraph per subsystem, plain English sentences, no jargon.
2. **A drill-down surface in the Clawd Console** (`clawd-console/`, the Next.js 16 app on his Legion 9 Pro laptop) that lets him click "Overnight Intelligence" and see the same underlying data in detail — every event, every shadow candidate, every error.

Both surfaces read the same data. The difference is rendering: plain text for WhatsApp, structured UI for the console. Neither exists today.

This spec does not build the Phase 3 REPORT stage from the parent spec. It builds the minimum needed to make overnight activity legible, using Phase 0's event log as the single source of truth.

---

## 2. Problem statement

Three concrete failures the current morning flow has today:

**2.1 The 4-bullet "Overnight insights" block.** `src/tasks/briefing.js` lines 134–149 call `getOvernightInsights(yesterday)`, grab up to 4 entries, and print them verbatim. No ranking, no evidence link, no staleness check. The bullets are raw dream-mode output that make no sense out of context. This is the ATLAS-style failure mode: stale recommendations that surface unchanged because nothing is gating them.

**2.2 No visibility into operational tasks.** `daily-backup`, `trace-analyser`, `system-refresh`, `ground-truth` all run nightly, produce work, and leave no breadcrumb in any surface James reads. If the backup silently fails, he does not find out until the day he needs to restore. If trace analysis flags 2 quality issues, he never sees them.

**2.3 No drill-down path.** The Clawd Console has an `(console)/overnight` page already, but it reads the old scattered data (`OvernightReport`, `DreamFact`, `TraceAnalysis`, `Retrospective`) via a variety of API routes. The Phase 1 consolidate stage writes to the new event log — which nothing reads yet.

---

## 3. Design overview

Three pieces of new functionality, one prerequisite schema extension, and one retrofit pass.

**Prerequisite: extend the event log schema.**
- Add `'operations'` to `OVERNIGHT_STAGES` in `src/overnight/events.ts`. This lets operational tasks write to the same event log as the new spec stages without breaking the four-stage taxonomy.

**Retrofit pass: four surviving overnight tasks write events.**
- `daily-backup.js`, `trace-analyser.js`, `system-refresh.js`, `ground-truth.js` each gain one `appendEvent()` call at end-of-run summarising what they did and producing a `'operations'`-stage event. Failures write a `verdict: 'failed'` event via the catch block.

**Piece A — WhatsApp morning digest.**
- New `src/overnight/overnight-digest.ts` pure module exporting `formatOvernightDigest(events: OvernightEvent[]): string`. Takes the events for a given date, returns a ~140-word plain-English block.
- `src/tasks/briefing.js` replaces its lines 134–149 "Overnight insights" block with a call to the digest.

**Piece B — Clawd Console drill-down.**
- New bot HTTP route `GET /api/overnight-events/:date` in `src/http-server.js` returning `{events, shadowCandidates}` as JSON. Protected by the existing `checkAuth(req)` / `DASHBOARD_TOKEN` guard. Models on the existing `/api/overnight-report/` route.
- Update `clawd-console/src/app/(console)/overnight/page.tsx` to fetch from the new endpoint and render events grouped by stage, with each shadow candidate expandable to show synthesized sources.
- New `OvernightEvent` and `ShadowCandidate` TypeScript types in `clawd-console/src/lib/types.ts` mirroring the bot-side schema.

Both surfaces read the same underlying data on EVO: `data/overnight/events-<date>.jsonl` + `data/overnight/shadow-candidates-<date>.jsonl`.

---

## 4. Component detail

### 4.1 Event log stage extension

`src/overnight/events.ts` line 17:
```ts
export const OVERNIGHT_STAGES = ['consolidate', 'probe', 'report', 'improve', 'operations'] as const;
```

New enum value. Existing validator at lines 108–110 reuses the same `includes` check, so no validator change needed. Existing Phase 0 events test file gains one new assertion case: `operations` is accepted.

### 4.2 Retrofit call-sites

Each of the four surviving overnight tasks already has the shape:
```js
export async function checkX(todayStr, hours) {
  if (alreadyRanToday) return;
  if (hours !== someHour) return;
  alreadyRanToday = todayStr;
  try {
    // existing logic
  } catch (err) {
    logger.error({ err: err.message }, 'x failed');
  }
}
```

The retrofit adds one `appendEvent()` call at the successful end of the try block and one in the catch block. Example for `daily-backup.js`:

```js
import { appendEvent } from '../overnight/events.js';

// ... existing code ...

try {
  const result = await runBackup();
  await appendEvent({
    stage: 'operations',
    phase: 'daily-backup',
    inputs: [],
    outputs: [`backup:${result.path}`],
    verdict: 'ok',
    reason: `${result.sizeBytes} bytes backed up to ${result.path}`,
    evidence_refs: [],
    rollback_ref: null,
    budget: { opus_sessions: 0, tokens: 0 },
  }, { date: todayStr });
} catch (err) {
  await appendEvent({
    stage: 'operations',
    phase: 'daily-backup',
    inputs: [],
    outputs: [],
    verdict: 'failed',
    reason: err.message,
    evidence_refs: [],
    rollback_ref: null,
    budget: { opus_sessions: 0, tokens: 0 },
  }, { date: todayStr });
  logger.error({ err: err.message }, 'daily-backup failed');
}
```

Each retrofit is 15–20 lines. No new abstractions. No helper factored out (premature — only four call sites, and each has a slightly different `reason` string).

### 4.3 Overnight digest formatter

New file `src/overnight/overnight-digest.ts`, ~100 lines. One public function:

```ts
export function formatOvernightDigest(events: OvernightEvent[]): string;
```

**Behaviour:**
1. Group events by stage (`consolidate`, `operations`, etc.)
2. Surface any `verdict: 'failed'` events at the top in an "Errors" section
3. For each stage, render a plain-English paragraph using a stage-specific formatter function:
   - `formatConsolidate(events)` → "Extracted N candidates from yesterday's conversations. They are in the shadow file for review, not yet in EVO's real memory. Once cutover is approved, they will be searchable during chats."
   - `formatOperations(events)` → one sentence per `phase`, mapping `phase` names to human-readable descriptions: `daily-backup` → "Full bot state saved (${size}). If EVO crashed tonight, nothing since ${time} would be lost."
4. If a known stage has zero events for the date, print "Stage X not run last night (reason: ...)" — never fabricate, never silently omit
5. Append `"No errors."` at the end if no failed verdicts, or `"Errors: N"` at the top with one line per failure

Phase-name → human-readable mapping lives in a single const map at the top of the file:
```ts
const PHASE_COPY: Record<string, (e: OvernightEvent) => string> = {
  'daily-backup': (e) => `Full bot state saved. ${e.reason}.`,
  'trace-analyser': (e) => `${e.reason}. These accumulate as evidence for the weekly improve cycle.`,
  'system-refresh': (e) => `Reseeded knowledge files into EVO memory. ${e.reason}.`,
  'ground-truth': (e) => `${e.reason}. (Only updates when you flag a response as gold.)`,
  'extract': (e) => `Extracted candidates from yesterday's conversations (${e.reason}).`,
  'store': (e) => `Results stored to shadow file for review, not yet in EVO's real memory (${e.reason}).`,
  'maintenance': (e) => `Memory cleanup complete (${e.reason}).`,
};
```

Unknown phases fall through to a generic `${phase}: ${reason}` line so new events are always visible even before their copy is written.

**Hard cap:** 400 words. If the formatted output exceeds that, truncate with "... (further events omitted, open Clawd Console for full detail)".

### 4.4 Briefing integration

`src/tasks/briefing.js` lines 134–149 — delete the existing "Overnight insights" block:
```js
// DELETE:
if (config.evoMemoryEnabled && isEvoOnline()) {
  try {
    const yesterday = new Date(todayStr + 'T12:00:00');
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0];
    const insights = await getOvernightInsights(yStr);
    if (insights.length > 0) {
      const lines = insights.slice(0, 4).map(m => `  - ${m.fact || m.text || m.content || '?'}`);
      sections.push(`*Overnight insights*\n${lines.join('\n')}`);
    }
  } catch (err) { logger.warn({ err: err.message }, 'briefing overnight insights failed'); }
}
```

Replace with:
```js
try {
  const { queryEvents } = await import('../overnight/events.js');
  const { formatOvernightDigest } = await import('../overnight/overnight-digest.js');
  const events = await queryEvents({ date: todayStr });
  const digest = formatOvernightDigest(events);
  sections.push(digest);
} catch (err) {
  logger.warn({ err: err.message }, 'briefing overnight digest failed');
  sections.push('*Overnight:* digest unavailable (see Clawd Console).');
}
```

Dynamic imports keep the briefing module loadable even if the overnight modules have a startup problem. If digest generation fails, briefing still sends a fallback line pointing to the console.

### 4.5 Bot HTTP endpoint

New route in `src/http-server.js` added after the existing `/api/overnight-report/` route (line 251):

```js
if (path.startsWith('/api/overnight-events/')) {
  if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
  const dateStr = path.split('/api/overnight-events/')[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return json(res, 400, { error: 'invalid date format, expected YYYY-MM-DD' });
  }
  try {
    const { queryEvents } = await import('./overnight/events.js');
    const events = await queryEvents({ date: dateStr });
    const shadowFile = join(__dirname, '..', 'data', 'overnight', `shadow-candidates-${dateStr}.jsonl`);
    let shadowCandidates = [];
    if (existsSync(shadowFile)) {
      const raw = readFileSync(shadowFile, 'utf8').trim().split('\n').filter(Boolean);
      shadowCandidates = raw.map(line => JSON.parse(line));
    }
    return json(res, 200, { date: dateStr, events, shadowCandidates });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}
```

Follows the existing route idiom exactly. Uses dynamic import of the ESM `events.ts` module (same pattern the briefing update uses). Reads the shadow file synchronously because the route handler is not an async bottleneck.

### 4.6 Clawd Console types

`clawd-console/src/lib/types.ts` — add two new interfaces mirroring the bot schema:

```ts
export interface OvernightEvent {
  id: string;
  timestamp: string;
  stage: 'consolidate' | 'probe' | 'report' | 'improve' | 'operations';
  phase: string;
  inputs: string[];
  outputs: string[];
  verdict: 'ok' | 'rejected' | 'failed' | 'skipped' | 'null';
  reason: string;
  evidence_refs: string[];
  rollback_ref: string | null;
  budget: { opus_sessions: number; tokens: number };
}

export interface ShadowCandidate {
  timestamp: string;
  candidate: {
    text: string;
    category: string;
    confidence: number;
    sources: Array<{ hash: string; excerpt: string }>;
    [key: string]: unknown;
  };
}

export interface OvernightEventsResponse {
  date: string;
  events: OvernightEvent[];
  shadowCandidates: ShadowCandidate[];
}
```

### 4.7 Clawd Console overnight page update

`clawd-console/src/app/(console)/overnight/page.tsx` — the existing page is a `"use client"` component with `useState` and `useEffect` reading `OvernightReport` via `fetchPi`. The update adds:

1. Two new state slots:
```ts
const [eventLog, setEventLog] = useState<OvernightEvent[] | null>(null);
const [shadowCandidates, setShadowCandidates] = useState<ShadowCandidate[] | null>(null);
```

2. A new fetch inside the existing `useEffect` that triggers on date change:
```ts
fetchPi(`/api/overnight-events/${date}`)
  .then((data: OvernightEventsResponse) => {
    setEventLog(data.events);
    setShadowCandidates(data.shadowCandidates);
  })
  .catch((err) => { logger.warn(...); setEventLog([]); setShadowCandidates([]); });
```

3. A new tab in the existing `Tabs` list: `Events` (alongside the existing `Facts`, `Insights`, `Traces`, etc.). Content: events grouped by stage, each row showing `phase`, `verdict`, `reason`, timestamp. Expandable rows surface `inputs`, `outputs`, `evidence_refs`.

4. A new tab `Shadow candidates` rendering the `shadowCandidates` array as a list — one card per candidate with `text`, `category`, `confidence`, and an expandable section showing the synthesized `sources[]`.

Neither new tab requires new shadcn components beyond what the page already imports (`Tabs`, `Card`, `Badge`, `Skeleton`).

**Next.js 16 compatibility note:** the existing page is already `"use client"` with `useState`/`useEffect`. None of Next.js 16's breaking changes affect this pattern:
- Async Request APIs don't apply (no dynamic route params in this page)
- Middleware rename doesn't apply (no middleware touched)
- Turbopack-as-default doesn't affect source code
- next/image defaults don't apply (no images added)
- Cache Components are opt-in and not used

Sources verified via [Upgrading: Version 16 | Next.js](https://nextjs.org/docs/app/guides/upgrading/version-16) and [Next.js 16 release notes](https://nextjs.org/blog/next-16).

---

## 5. Data flow

**Write path (nightly, on EVO):**
1. 02:00 — `checkOvernightExtraction` runs (unchanged — still the old 2 AM task)
2. 02:30 — `checkConsolidateShadow` writes 3 events (stage: consolidate) + shadow file
3. Various slots — `daily-backup`, `trace-analyser`, `system-refresh`, `ground-truth` each write 1 event (stage: operations)
4. All writes go to `data/overnight/events-<date>.jsonl` and `data/overnight/shadow-candidates-<date>.jsonl`

**Read path 1 — WhatsApp DM at 07:00:**
1. `checkMorningBriefing` in briefing.js fires
2. At the overnight block, calls `queryEvents({ date: todayStr })`
3. Passes events to `formatOvernightDigest(events)`
4. Inserts the resulting text into the DM alongside weather/calendar/todos

**Read path 2 — Clawd Console on laptop, any time of day:**
1. User opens console at `http://localhost:3100/overnight` (or clicks from Overview)
2. Page mounts, existing `useEffect` fires for yesterday's date
3. New fetch to `fetchPi('/api/overnight-events/2026-04-11')` via the console's api/pi proxy
4. Proxy forwards to `PI_URL=http://100.90.66.54:3000/api/overnight-events/2026-04-11` on EVO
5. Bot's `http-server.js` matches the route, authenticates via `DASHBOARD_TOKEN`, reads events file + shadow file, returns JSON
6. Console renders events in the new Events tab and candidates in the new Shadow candidates tab

---

## 6. Error handling

- **Missing events file for a date:** `queryEvents` returns `[]`. Digest prints "No overnight activity recorded for {date}." Bot endpoint returns `{events: [], shadowCandidates: []}` with 200.
- **Corrupt JSONL line:** existing Phase 0 `queryEvents` catches `JSON.parse` errors per line and skips. Digest continues with valid events.
- **Bot HTTP endpoint offline:** console page catch block shows "Unable to load overnight events" inside the new tab; other tabs render their existing data sources unchanged.
- **DASHBOARD_TOKEN mismatch:** bot returns 401. Console shows "unauthorized" banner in the new tab.
- **Retrofit task itself fails:** the task's catch block writes a `verdict: 'failed'` event with the error message. Digest surfaces the failure at the top in the Errors section.
- **Digest formatter exceeds 400 words:** truncate with "... (further events omitted)" pointer to the console.

No new error categories invented. Every failure path degrades to a visible-in-the-digest-or-UI message.

---

## 7. Testing

**Bot side:**
- `events.test.ts` — 1 new assertion: `operations` stage value is accepted
- `overnight-digest.test.ts` — 6 tests: happy path with multiple stages, empty events, failure surfacing in Errors section, stage ordering, word-count truncation at 400, unknown phase fall-through to generic renderer
- HTTP route — 1 integration test using a tmpdir event log, asserting 200 response + correct JSON shape. Follow the pattern used by the existing `/api/overnight-report/` route tests if any exist, or add the first test for this area.
- Retrofits — no unit tests. Each is one `appendEvent()` call added to existing untested JS. Correct by inspection per CLAUDE.md "the right amount of complexity is what the task actually requires."

**Console side:**
- Types — compile-time only (no runtime tests needed for pure types)
- Page update — 1 smoke test rendering the page with stub data via the existing test pattern (if any). If `clawd-console/` has no existing test infrastructure, manual verification in the running Next.js dev server is acceptable for this session — document as a follow-up.

---

## 8. CLAUDE.md updates

Already made (committed in the same session as the spec):
1. Added `Clawd Console` row to Quick Reference table with full details about Next.js 16.2.2, runs on Legion 9 Pro laptop, port 3100, PI_URL proxy, DASHBOARD_TOKEN, existing overnight page, Next.js 16 breaking changes warning
2. Added `Bot HTTP API` row to Quick Reference table documenting `src/http-server.js` pattern
3. Renamed existing `Dashboard` row to `Pi dashboard` to distinguish it from Clawd Console

No further CLAUDE.md changes needed for this work.

---

## 9. What stays untouched

- `src/tasks/improvement-cycle.js` — old 2 AM task runs unchanged (retired in Phase 5)
- `src/tasks/forge-orchestrator.js` — CLAUDE.md flags this as "orchestrator is human-only"; retiring in Phase 4 anyway
- `src/overnight-report.js` (1038 lines) — retiring in Phase 3; not read by the new digest
- `src/overnight/consolidate.ts` and the four sub-modules — Phase 1 stage composition reused as-is
- `evo-memory/dream_mode.py` — Python extractor unchanged
- `clawd-console/` existing tabs (`Facts`, `Insights`, `Traces`, `Retrospective`, `Soul`) — unchanged, still read their current data sources
- All non-overnight scheduler tasks (`checkTodoReminders`, `checkSideGigMeetings`, `checkMorningBriefing` itself, etc.)

---

## 10. Out of scope

- Building the full Phase 3 REPORT stage (staleness guard, ISO-week evidence window, "CONTINUING / NEW / DEFERRED / ARCHIVE" sections). That is a later, bigger piece of work.
- Retrofitting retiring overnight tasks (`forge-orchestrator`, `self-improvement`, `weekly-retrospective`, `overnight-to-evolution`, `overnight-report.js`, `evolution-dispatch`) to write events. They are slated for deletion; retrofitting them is wasted work.
- Updating the Pi Rust dashboard to read the event log. Separate subsystem, separate session.
- Making `formatOvernightDigest` accept a language parameter or support translation. English only.
- Real-time streaming of events to the console. The console fetches on page load and date change only.

---

## 11. Success criteria

1. **Tomorrow morning's WhatsApp briefing** (first morning after deploy) contains the new plain-English overnight digest in place of the old "Overnight insights" bullets. James reads it and it is intelligible without context.
2. **Opening the Clawd Console `/overnight` page** on the Legion 9 Pro laptop and selecting yesterday's date renders a new "Events" tab with at least 3 consolidate events and a "Shadow candidates" tab with the validated candidates from the shadow file.
3. **Each retrofitted task** (daily-backup, trace-analyser, system-refresh, ground-truth) produces exactly one operations event per night when it runs, visible in both surfaces.
4. **A forced failure** of any retrofitted task surfaces at the top of the WhatsApp digest in an Errors section and as a `verdict: 'failed'` row in the console Events tab.
5. **The console drill-down is reachable via existing navigation** (no new top-level route, no new menu item — the existing "Overnight Intelligence" sidebar entry and "View overnight →" link both reach the updated page).
6. **All Phase 1 tests still pass** (43/43 consolidate + 28 Phase 0 infrastructure) and `npm test` full suite stays at 508/2/1 baseline.

---

## 12. Deferred questions

- Exact tab label for the new events section: "Events", "Overnight activity", or "Event log"? Decide during planning.
- Whether to sort events by timestamp ascending or descending in the Events tab. Descending is more useful (most recent first) but the current page uses ascending for existing tabs. Match existing convention unless it is clearly wrong.
- Whether the digest should include the absolute date ("Overnight — Fri 11 April") or a relative label ("Last night"). Pick one during planning.
- Whether to expose a simple "export as JSON" button in the Shadow candidates tab for offline review. Likely no for this pass — deferred.

---

*End of spec.*
