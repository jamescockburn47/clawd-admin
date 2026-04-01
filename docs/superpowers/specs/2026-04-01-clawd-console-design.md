# Clawd Console — Infometrics Dashboard

**Date:** 2026-04-01
**Status:** Design approved, pending implementation plan

## Overview

A full-featured web dashboard running locally on James's Windows desktop, replacing the WhatsApp text dump and Rust kiosk with an explorable, interactive control plane for Clawd's overnight intelligence, evolution pipeline, memory system, and live monitoring.

**What it is NOT:** A replacement for the Rust kiosk on the Pi (that stays for glanceable touchscreen use). This is the deep-dive tool.

## Architecture

### Stack

| Layer | Choice | Version | Reason |
|-------|--------|---------|--------|
| Framework | Next.js (App Router) | 16.2 | Latest stable, TypeScript, route handlers for API proxy |
| UI | shadcn/ui + Tailwind CSS | CLI v4 | Dark mode, data-dense components, owned source code |
| Charts | Recharts | 3.8 | Routing distributions, timing histograms, trend lines |
| Tables | @tanstack/react-table | 8.21 | Memory browser, trace explorer, evolution task list |
| Icons | Lucide React | latest | Consistent with shadcn/ui |
| Fonts | Geist Sans + Geist Mono | latest | Interface text + code/metrics |

### Project Location

`clawd-console/` at the repo root. Standalone Next.js app. Runs via `npm run dev` on `localhost:3000` (or 3001 if Pi port conflicts via Tailscale).

### API Proxy Layer

All Pi and EVO API calls go through Next.js Route Handlers. The browser never talks to Pi/EVO directly.

```
Browser → localhost:3000/api/pi/widgets → Route Handler → 100.104.92.87:3000/api/widgets
Browser → localhost:3000/api/evo/memory/search → Route Handler → 100.90.66.54:5100/memory/search
```

**Files:**
- `app/api/pi/[...path]/route.ts` — Catch-all proxy to Pi. Injects `Authorization: Bearer ${DASHBOARD_TOKEN}`.
- `app/api/evo/[...path]/route.ts` — Catch-all proxy to EVO memory service. No auth required (local network).

**Environment (`.env.local`):**
```
PI_URL=http://100.104.92.87:3000
EVO_URL=http://100.90.66.54:5100
DASHBOARD_TOKEN=<token from Pi>
```

Fallback: If Tailscale is down, try LAN IPs (192.168.1.211 / 192.168.1.230). The proxy route handler should try Tailscale first, LAN second, and return a clear error if both fail.

### Real-Time Updates

SSE connection from the browser to `/api/pi/events` (proxied). The Pi already exposes this endpoint for widget updates, todo changes, and voice events. The console listens for these and updates relevant UI sections without polling.

## Pages

### 1. Overview (`/`) — P0

**Purpose:** System health at a glance + today's stats + quick links.

**Layout:** Grid of status cards, compact.

**Components:**
- **System health cards** (4 across): EVO status (online/offline + model loaded), Memory service (total count + health), WhatsApp (connected user + uptime), Pi (uptime + RAM).
  - Data: `GET /api/pi/system-health`, `GET /api/pi/status`, `GET /api/pi/evo`
- **Today's numbers** (4 across): Messages handled, plans executed, quality gate triggers, evolution tasks run.
  - Data: `GET /api/pi/traces/live` (on-demand 24h analysis)
- **Activity sparkline:** Messages per hour over last 24h. Recharts AreaChart, subtle.
  - Data: Derived from traces/live response timestamps.
- **Quick links:** Cards linking to: latest overnight report, pending evolution tasks (count badge), recent anomalies (count badge), memory search.
- **Alerts:** If any anomalies detected in latest trace analysis, show as dismissable Alert cards at top.

**shadcn components:** Card, Badge, Alert, Skeleton (loading states), Separator.

### 2. Overnight Intelligence (`/overnight`) — P0

**Purpose:** The overnight report as an explorable UI. Primary page.

**Layout:** Left rail (date picker + group filter) + main area with tabs.

**Left rail:**
- Date picker (shadcn Calendar component or simple date input). Defaults to yesterday.
- Group filter: checkboxes for each group processed. "All" selected by default.
- Quality summary card: aggregate facts new/deduped/superseded, insights new/skipped, quiet groups count.

**Tabs:**

#### Tab: Diaries
- Per-group expandable cards. Card header shows group name, message count, quality badge.
- Quality badge: green (>70% new facts), yellow (30-70%), red (<30% or skipped).
- Expanded card: full diary narrative text.
- **Novelty comparison:** Collapsible "Yesterday" section showing yesterday's diary side-by-side. Diff-style highlighting of new content (CSS only, no diff library — just show both with "new today" markers).
- Quiet/skipped groups collapsed into a muted "Skipped" section at bottom.
- Verbatim excerpts shown as blockquotes with speaker attribution.
- Soul observations shown as tagged items with severity badges (routine=muted, corrective=yellow, critical=red).

#### Tab: Facts & Insights
- TanStack Table with columns: Text, Type (fact/insight), Confidence, Tags, Source Group, Status (new/deduped/superseded).
- Filterable by type, status, group. Sortable by confidence.
- Insights show an "Evidence" expandable row with cited timestamps.
- Row click → Sheet with full detail + edit/delete actions.

#### Tab: Trace Analysis
- **Routing breakdown:** Recharts PieChart — keywords vs 4B classifier vs fallback vs image.
- **Category distribution:** Recharts BarChart — top 10 categories by volume.
- **Timing percentiles:** Recharts LineChart — routing avg/p95 and total avg/p95 over last 7 daily analyses (from `trace-analysis-log.jsonl`).
- **needsPlan accuracy:** Precision/Recall/F1 gauges + trend over time.
- **Anomalies:** Alert cards with severity badges and suggestions.

Data: `GET /api/pi/traces` (latest analysis), plus need a new endpoint for historical trend data.

#### Tab: Retrospective
- Only populated on Sundays (or shows "last Sunday's" data).
- Health status banner (good=green, fair=yellow, poor=red).
- Priorities as ranked cards: rank number, severity badge, title, issue description, proposed fix, files affected.
- Evolution tasks auto-created listed with status.

Data: `GET /api/pi/retrospective`

#### Tab: Soul
- Current personality config (from `/api/pi/soul`).
- Recent observations timeline.
- Pending proposals with approve/reject actions.

**Data sources:**
- Overnight report JSON: New endpoint `GET /api/pi/overnight-report/:date` (needs adding to Pi).
- Traces: `GET /api/pi/traces`
- Retrospective: `GET /api/pi/retrospective`
- Soul: `GET /api/pi/soul`

### 3. Evolution Pipeline (`/evolution`) — P0

**Purpose:** Full visibility and control over self-coding tasks.

**Layout:** Kanban columns + history table.

**Kanban columns** (horizontal scroll on mobile):

| Column | Status | Visual |
|--------|--------|--------|
| Queued | `pending` | Muted cards, instruction text, source badge, created time |
| Running | `running` | Animated border, elapsed time counter |
| Awaiting Approval | `awaiting_approval` | Highlighted cards, expandable diff viewer |
| Deployed | `deployed` | Green check, files changed, line count |
| Failed | `failed` | Red X, error message |
| Rejected | `rejected` | Muted strikethrough |

**Awaiting Approval cards expand to show:**
- Manifest: planned files, estimated lines, approach, risks.
- Actual diff: syntax-highlighted code diff. Use a simple pre-formatted code block with +/- line coloring (no heavy diff library — the diffs are small, <150 lines).
- **Approve button** → `POST /api/pi/evolution/approve` (body: `{ taskId }`)
- **Reject button** → `POST /api/pi/evolution/reject` (body: `{ taskId }`)
- Both show confirmation dialog (AlertDialog) before executing.

**Rate limit indicator:** Badge showing "2/3 today | Next slot: 45min" or "Available".

**History table:** Below kanban. All tasks, sortable by date/status. TanStack Table.

**New Pi endpoints required:**
- `POST /api/evolution/approve` — calls `deployApprovedTask()` from `evolution-gate.js`
- `POST /api/evolution/reject` — calls `updateTask(id, { status: 'rejected' })`, deletes branch
- `GET /api/evolution/list` — returns full task array (not just summary counts)

### 4. Memory Browser (`/memory`) — P1

**Purpose:** Browse, search, edit, delete Clawd's memories. The brain inspector.

**Layout:** Search bar + category sidebar + results grid.

**Search bar:** Full-text search input. Searches via `POST /api/evo/memory/search`.

**Category sidebar:**
- Checkbox filters for all categories: identity, person, general, insight, diary, dream, system, preference, legal, schedule, travel, document, document_chunk, document_index.
- Count badge per category.
- Source filter: diary_extraction, diary_insight, diary_verbatim, dream_mode, conversation, manual.

**Results grid:** Cards or table (toggle view).
- Each memory: fact text (truncated), category badge, confidence bar (0-1, color-coded), source tag, tags list, age ("3 days ago"), access count.
- **Confidence bar color:** Green (>0.8), yellow (0.5-0.8), red (<0.5). Shows decay visually for volatile categories.
- Click to expand → Sheet with full text, all metadata, edit form, delete button.

**Actions:**
- **Edit:** Inline text editing + save (PUT `/api/evo/memory/{id}`)
- **Delete:** AlertDialog confirmation → DELETE `/api/evo/memory/{id}`
- **Store new:** Button opens Sheet with form (fact, category, tags, confidence) → POST `/api/evo/memory/store`
- **Maintenance:** Button triggers POST `/api/evo/maintain` with confirmation.

**Contradiction view:** If two memories in results have cosine similarity >0.75 (returned by search), highlight them with a warning badge. (This requires the EVO search endpoint to return similarity scores, which it already does.)

### 5. Routing & Traces (`/routing`) — P1

**Purpose:** Deep dive into message routing accuracy and patterns.

**Layout:** Tabs for Analysis and Live Traces.

#### Tab: Analysis
- Same charts as the Overnight Intelligence trace tab, but with interactive date range picker.
- Additional: category confusion matrix if we add ground-truth labels later.

#### Tab: Live Traces
- TanStack Table of recent reasoning traces (from `GET /api/pi/traces/live`).
- Columns: timestamp, sender, category, routing layer, needsPlan, model selected, tools called, total time.
- Row expansion: full trace JSON.
- Filterable by category, layer, model.

### 6. Live Monitor (`/logs`) — P2

**Purpose:** Real-time message feed with routing decisions.

**Layout:** Scrolling feed + filters.

- SSE-driven. Each incoming message appears as a card with: timestamp, sender, preview text, category badge, model badge, latency.
- Filter by: group, category, model.
- Pause/resume button.
- This page is P2 — requires adding SSE events for message processing to the Pi (currently only widget/todo/voice events are broadcast).

## Shared Layout

**Sidebar navigation:** Collapsible. Icons + labels. Active page highlighted. Pages grouped:
- Intelligence: Overview, Overnight, Routing
- Control: Evolution, Memory
- Monitor: Live Logs

**Top bar:**
- System status indicators: EVO (green/red dot), WhatsApp (green/red dot), Memory count.
- SSE connection status indicator.
- Settings gear (link to config — future).

**Mobile degradation:** Sidebar collapses to Sheet. Tables switch to card view. Charts maintain aspect ratio. Kanban switches to vertical stack.

## New Pi Endpoints Required

These need adding to `src/http-server.js` on the Pi:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/evolution/approve` | POST | Approve evolution task (body: `{ taskId }`) |
| `/api/evolution/reject` | POST | Reject evolution task (body: `{ taskId }`) |
| `/api/evolution/list` | GET | Full task list (not just summary) |
| `/api/overnight-report/:date` | GET | Serve overnight report JSON for a given date (from `/tmp/overnight-report-{date}.json`, fetched from EVO at 05:30) |
| `/api/traces/history` | GET | Historical trace analysis entries (from `trace-analysis-log.jsonl`) |

All require dashboard token auth.

## Design Tokens

```css
/* Dark mode only (default) */
--color-background: oklch(0.145 0 0);          /* Near black */
--color-card: oklch(0.205 0 0);                /* Slightly lighter */
--color-primary: oklch(0.488 0.243 264.376);   /* Blue accent */

/* Custom status colors */
--color-status-online: oklch(0.723 0.219 149.579);   /* Green */
--color-status-offline: oklch(0.637 0.237 15.163);    /* Red */
--color-status-warning: oklch(0.795 0.184 86.047);    /* Yellow */
--color-status-muted: oklch(0.708 0 0);               /* Gray */

/* Quality signal colors */
--color-quality-new: oklch(0.723 0.219 149.579);      /* Green — new facts */
--color-quality-dedup: oklch(0.795 0.184 86.047);      /* Yellow — deduplicated */
--color-quality-superseded: oklch(0.488 0.243 264.376); /* Blue — superseded */
```

## File Structure

```
clawd-console/
├── app/
│   ├── layout.tsx                    # Root layout: sidebar, top bar, providers
│   ├── page.tsx                      # Overview dashboard
│   ├── overnight/
│   │   └── page.tsx                  # Overnight intelligence
│   ├── evolution/
│   │   └── page.tsx                  # Evolution pipeline
│   ├── memory/
│   │   └── page.tsx                  # Memory browser
│   ├── routing/
│   │   └── page.tsx                  # Routing & traces
│   ├── logs/
│   │   └── page.tsx                  # Live monitor (P2)
│   └── api/
│       ├── pi/[...path]/route.ts     # Pi API proxy
│       └── evo/[...path]/route.ts    # EVO API proxy
├── components/
│   ├── ui/                           # shadcn/ui components (generated)
│   ├── layout/
│   │   ├── sidebar.tsx               # Navigation sidebar
│   │   ├── top-bar.tsx               # System status bar
│   │   └── sse-provider.tsx          # SSE connection context
│   ├── overnight/
│   │   ├── diary-card.tsx            # Expandable diary entry
│   │   ├── quality-badge.tsx         # Signal-to-noise indicator
│   │   ├── facts-table.tsx           # Facts & insights table
│   │   ├── trace-charts.tsx          # Routing/timing charts
│   │   └── retrospective-card.tsx    # Priority card
│   ├── evolution/
│   │   ├── kanban.tsx                # Kanban board
│   │   ├── task-card.tsx             # Evolution task card
│   │   ├── diff-viewer.tsx           # Code diff display
│   │   └── approve-dialog.tsx        # Approval confirmation
│   ├── memory/
│   │   ├── search-bar.tsx            # Memory search
│   │   ├── memory-card.tsx           # Memory display card
│   │   ├── memory-editor.tsx         # Edit sheet
│   │   └── confidence-bar.tsx        # Visual confidence indicator
│   └── shared/
│       ├── status-dot.tsx            # Online/offline indicator
│       ├── date-picker.tsx           # Date selection
│       └── loading-skeleton.tsx      # Page-level loading states
├── lib/
│   ├── utils.ts                      # cn() utility
│   ├── api.ts                        # Fetch helpers for Pi/EVO proxy
│   └── hooks/
│       ├── use-sse.ts                # SSE connection hook
│       ├── use-pi.ts                 # Pi API data fetching hook
│       └── use-evo.ts                # EVO API data fetching hook
├── .env.local                        # PI_URL, EVO_URL, DASHBOARD_TOKEN
├── components.json                   # shadcn/ui config
├── tailwind.config.ts
├── next.config.ts
├── package.json
└── tsconfig.json
```

## Implementation Priority

1. **Phase 1 (MVP):** Project scaffold + API proxy + Overview + Overnight Intelligence (diaries + facts tabs only)
2. **Phase 2:** Evolution Pipeline (kanban + approve/reject) + new Pi endpoints
3. **Phase 3:** Memory Browser + Overnight trace/retrospective/soul tabs
4. **Phase 4:** Routing & Traces deep dive
5. **Phase 5:** Live Monitor (requires Pi SSE expansion)

## Constraints

- No database. All state on Pi and EVO.
- No authentication beyond the dashboard token (local machine only).
- No deployment — runs as `npm run dev` locally.
- Pi endpoints must not break existing Rust dashboard or WhatsApp functionality.
- EVO memory service endpoints are unauthenticated (trusted local network).
- Maximum file size: 300 lines per component file (per CLAUDE.md rule 86).
