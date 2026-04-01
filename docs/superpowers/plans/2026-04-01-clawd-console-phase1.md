# Clawd Console Phase 1 — MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold a Next.js dashboard with API proxy to Pi/EVO, a system health overview page, and the overnight intelligence page (diaries + facts tabs).

**Architecture:** Next.js 16.2 App Router running locally on Windows. Route Handlers proxy all API calls to Pi (Tailscale) and EVO (Tailscale), injecting auth tokens server-side. Dark mode, shadcn/ui components, Recharts for charts. No database — all state on Pi and EVO.

**Tech Stack:** Next.js 16.2, TypeScript, shadcn/ui CLI v4, Tailwind CSS, Recharts 3.8, @tanstack/react-table 8.21, Lucide React, Geist fonts.

**Spec:** `docs/superpowers/specs/2026-04-01-clawd-console-design.md`

---

### Task 1: Scaffold Next.js Project

**Files:**
- Create: `clawd-console/` (entire project scaffold)
- Create: `clawd-console/.env.local`

- [ ] **Step 1: Create Next.js app**

```bash
cd C:/Users/James/Downloads/clawdbot-claude-code
npx create-next-app@latest clawd-console --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
```

Select defaults for all prompts.

- [ ] **Step 2: Initialize shadcn/ui**

```bash
cd clawd-console
npx shadcn@latest init -d --base radix
```

After init, fix the Geist font issue in `src/app/globals.css`. In the `@theme inline` block, replace any `--font-sans: var(--font-sans)` or `--font-sans: var(--font-geist-sans)` with literal font names:

```css
--font-sans: "Geist", "Geist Fallback", ui-sans-serif, system-ui, sans-serif;
--font-mono: "Geist Mono", "Geist Mono Fallback", ui-monospace, monospace;
```

In `src/app/layout.tsx`, move font variable classNames from `<body>` to `<html>` and set dark mode:

```tsx
<html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable}`}>
  <body className="antialiased">
```

- [ ] **Step 3: Install additional dependencies**

```bash
cd clawd-console
npm install recharts @tanstack/react-table
```

- [ ] **Step 4: Add shadcn components needed for Phase 1**

```bash
cd clawd-console
npx shadcn@latest add card badge tabs separator skeleton alert scroll-area sheet table tooltip button calendar popover
```

- [ ] **Step 5: Create environment file**

Create `clawd-console/.env.local`:

```
PI_URL=http://100.104.92.87:3000
PI_URL_LAN=http://192.168.1.211:3000
EVO_URL=http://100.90.66.54:5100
EVO_URL_LAN=http://192.168.1.230:5100
DASHBOARD_TOKEN=<copy from Pi .env>
```

- [ ] **Step 6: Add to .gitignore**

Append to `clawd-console/.gitignore`:

```
.env.local
.env*.local
```

- [ ] **Step 7: Verify it runs**

```bash
cd clawd-console
npm run dev
```

Open `http://localhost:3000` — should show the Next.js default page in dark mode.

- [ ] **Step 8: Commit**

```bash
git add clawd-console/
git commit -m "feat(console): scaffold Next.js 16 + shadcn/ui project"
```

---

### Task 2: API Proxy — Pi

**Files:**
- Create: `clawd-console/src/app/api/pi/[...path]/route.ts`
- Create: `clawd-console/src/lib/api.ts`

- [ ] **Step 1: Create the Pi proxy route handler**

Create `clawd-console/src/app/api/pi/[...path]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';

const PI_URL = process.env.PI_URL || 'http://100.104.92.87:3000';
const PI_URL_LAN = process.env.PI_URL_LAN || 'http://192.168.1.211:3000';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

async function proxyToPi(req: NextRequest, path: string): Promise<Response> {
  const url = `${PI_URL}/api/${path}`;
  const urlLan = `${PI_URL_LAN}/api/${path}`;

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (DASHBOARD_TOKEN) {
    headers['Authorization'] = `Bearer ${DASHBOARD_TOKEN}`;
  }

  const fetchOpts: RequestInit = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(15000),
  };

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    try {
      fetchOpts.body = await req.text();
    } catch {
      // No body
    }
  }

  // Try Tailscale first, LAN fallback
  try {
    const res = await fetch(url, fetchOpts);
    const data = await res.text();
    return new NextResponse(data, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
    });
  } catch {
    // Tailscale failed, try LAN
    try {
      const res = await fetch(urlLan, fetchOpts);
      const data = await res.text();
      return new NextResponse(data, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
      });
    } catch (err) {
      return NextResponse.json(
        { error: 'Pi unreachable', detail: String(err) },
        { status: 502 }
      );
    }
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToPi(req, path.join('/'));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToPi(req, path.join('/'));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToPi(req, path.join('/'));
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToPi(req, path.join('/'));
}
```

- [ ] **Step 2: Create the fetch helper library**

Create `clawd-console/src/lib/api.ts`:

```typescript
const PI_BASE = '/api/pi';
const EVO_BASE = '/api/evo';

export async function fetchPi<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${PI_BASE}/${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
  });
  if (!res.ok) {
    throw new Error(`Pi API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchEvo<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${EVO_BASE}/${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
  });
  if (!res.ok) {
    throw new Error(`EVO API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function postPi<T = unknown>(path: string, body: unknown): Promise<T> {
  return fetchPi(path, { method: 'POST', body: JSON.stringify(body) });
}

export async function postEvo<T = unknown>(path: string, body: unknown): Promise<T> {
  return fetchEvo(path, { method: 'POST', body: JSON.stringify(body) });
}
```

- [ ] **Step 3: Verify proxy works**

Start the dev server and test in browser:

```
http://localhost:3000/api/pi/status
```

Should return JSON with `connected`, `name`, `jid`, `uptime`, `memoryMB`.

- [ ] **Step 4: Commit**

```bash
git add clawd-console/src/app/api/pi/ clawd-console/src/lib/api.ts
git commit -m "feat(console): add Pi API proxy with Tailscale/LAN fallback"
```

---

### Task 3: API Proxy — EVO

**Files:**
- Create: `clawd-console/src/app/api/evo/[...path]/route.ts`

- [ ] **Step 1: Create the EVO proxy route handler**

Create `clawd-console/src/app/api/evo/[...path]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';

const EVO_URL = process.env.EVO_URL || 'http://100.90.66.54:5100';
const EVO_URL_LAN = process.env.EVO_URL_LAN || 'http://192.168.1.230:5100';

async function proxyToEvo(req: NextRequest, path: string): Promise<Response> {
  const url = `${EVO_URL}/${path}`;
  const urlLan = `${EVO_URL_LAN}/${path}`;

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  const fetchOpts: RequestInit = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(15000),
  };

  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      fetchOpts.body = await req.text();
    } catch {
      // No body
    }
  }

  try {
    const res = await fetch(url, fetchOpts);
    const data = await res.text();
    return new NextResponse(data, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
    });
  } catch {
    try {
      const res = await fetch(urlLan, fetchOpts);
      const data = await res.text();
      return new NextResponse(data, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
      });
    } catch (err) {
      return NextResponse.json(
        { error: 'EVO unreachable', detail: String(err) },
        { status: 502 }
      );
    }
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToEvo(req, path.join('/'));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToEvo(req, path.join('/'));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToEvo(req, path.join('/'));
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToEvo(req, path.join('/'));
}
```

- [ ] **Step 2: Verify EVO proxy works**

```
http://localhost:3000/api/evo/health
```

Should return `200` with health data from the EVO memory service.

- [ ] **Step 3: Commit**

```bash
git add clawd-console/src/app/api/evo/
git commit -m "feat(console): add EVO memory service API proxy"
```

---

### Task 4: Type Definitions

**Files:**
- Create: `clawd-console/src/lib/types.ts`

- [ ] **Step 1: Define all API response types needed for Phase 1**

Create `clawd-console/src/lib/types.ts`:

```typescript
// --- Pi /api/status ---
export interface PiStatus {
  connected: boolean;
  name: string | null;
  jid: string | null;
  lastActivity: string | null;
  uptime: number;
  memoryMB: number;
}

// --- Pi /api/system-health ---
export interface SystemHealth {
  whatsapp?: { status: string };
  evo?: { status: string };
  briefing?: { lastRun: string | null };
  diary?: { lastRun: string | null };
  memory?: { total: number; categories: Record<string, number> };
  uptime: number;
  memoryMB: number;
  [key: string]: unknown;
}

// --- Pi /api/evo ---
export interface EvoStatus {
  online: boolean;
  url: string;
  model?: string;
  queueDepth?: number;
}

// --- Trace Analysis ---
export interface TraceAnalysis {
  analysedAt: string;
  periodDays: number;
  totalTraces: number;
  routing: {
    counts: Record<string, number>;
    percentages: Record<string, number>;
  };
  categories: Record<string, number>;
  models: {
    distribution: Record<string, number>;
    reasons: Record<string, number>;
  };
  plans: {
    totalPlans: number;
    statuses: Record<string, number>;
    avgSteps: number;
    avgTimeMs: number;
    failureReasons: Array<{ tool: string; error: string; planGoal: string }>;
    toolUsage: Record<string, number>;
    adaptationRate: number;
  };
  needsPlan: {
    predictedTrue: number;
    predictedFalse: number;
    actualMultiTool: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
    f1: number;
  };
  qualityGate: {
    totalGated: number;
    percentage: number;
    byCategory: Record<string, number>;
  };
  timing: {
    routingAvgMs: number | null;
    routingP95Ms: number | null;
    totalAvgMs: number | null;
    totalP95Ms: number | null;
  };
  anomalies: Array<{
    type: string;
    severity: 'warning' | 'info';
    detail: string;
    suggestion: string;
  }>;
}

// --- Overnight Report (from dream_mode.py) ---
export interface DreamQuality {
  message_count: number;
  skipped: boolean;
  skip_reason?: string;
  facts_new: number;
  facts_skipped_dedup: number;
  facts_superseded: number;
  insights_new: number;
  insights_skipped: number;
  diary_words?: number;
}

export interface DreamFact {
  fact: string;
  tags: string[];
  confidence: number;
}

export interface DreamInsight {
  insight: string;
  topics: string[];
  evidence?: string[];
}

export interface DreamObservation {
  text: string;
  section: string;
  severity: 'routine' | 'corrective' | 'critical';
}

export interface DreamVerbatim {
  quote: string;
  speaker: string;
  context: string;
}

export interface DreamGroup {
  group_id: string;
  message_count: number;
  diary: string;
  facts: DreamFact[];
  insights: DreamInsight[];
  observations: DreamObservation[];
  verbatim: DreamVerbatim[];
  warnings: string[];
  quality?: DreamQuality;
}

export interface OvernightReport {
  date: string;
  groups_processed: number;
  groups: DreamGroup[];
  documents_processed?: number;
  totals: {
    facts: number;
    insights: number;
    observations: number;
  };
  source?: string;
}

// --- Retrospective ---
export interface RetrospectivePriority {
  rank: number;
  title: string;
  issue: string;
  impact: string;
  fix: string;
  files: string[];
  severity: 'high' | 'medium' | 'low';
  evolution_instruction?: string;
}

export interface Retrospective {
  overallHealth: 'good' | 'fair' | 'poor';
  healthReason: string;
  priorities: RetrospectivePriority[];
  evolutionTasksCreated?: Array<{ title: string; taskId: string }>;
}
```

- [ ] **Step 2: Commit**

```bash
git add clawd-console/src/lib/types.ts
git commit -m "feat(console): add TypeScript types for all Pi/EVO API responses"
```

---

### Task 5: Shared Layout — Sidebar + Top Bar

**Files:**
- Create: `clawd-console/src/components/layout/sidebar.tsx`
- Create: `clawd-console/src/components/layout/top-bar.tsx`
- Create: `clawd-console/src/components/shared/status-dot.tsx`
- Modify: `clawd-console/src/app/layout.tsx`

- [ ] **Step 1: Create the status dot component**

Create `clawd-console/src/components/shared/status-dot.tsx`:

```tsx
import { cn } from '@/lib/utils';

interface StatusDotProps {
  status: 'online' | 'offline' | 'warning' | 'unknown';
  label?: string;
  className?: string;
}

const colors = {
  online: 'bg-emerald-500',
  offline: 'bg-red-500',
  warning: 'bg-yellow-500',
  unknown: 'bg-zinc-500',
};

export function StatusDot({ status, label, className }: StatusDotProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <span className={cn('h-2 w-2 rounded-full', colors[status])} />
      {label && <span>{label}</span>}
    </span>
  );
}
```

- [ ] **Step 2: Create the sidebar**

Create `clawd-console/src/components/layout/sidebar.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Moon,
  GitBranch,
  Brain,
  Route,
  Radio,
} from 'lucide-react';

const navItems = [
  { href: '/', label: 'Overview', icon: LayoutDashboard, group: 'Intelligence' },
  { href: '/overnight', label: 'Overnight', icon: Moon, group: 'Intelligence' },
  { href: '/routing', label: 'Routing', icon: Route, group: 'Intelligence' },
  { href: '/evolution', label: 'Evolution', icon: GitBranch, group: 'Control' },
  { href: '/memory', label: 'Memory', icon: Brain, group: 'Control' },
  { href: '/logs', label: 'Live Monitor', icon: Radio, group: 'Monitor' },
];

export function Sidebar() {
  const pathname = usePathname();
  let lastGroup = '';

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-border bg-background px-3 py-4">
      <div className="mb-6 px-2">
        <h1 className="font-mono text-sm font-bold tracking-tight text-foreground">
          CLAWD CONSOLE
        </h1>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5">
        {navItems.map((item) => {
          const showGroup = item.group !== lastGroup;
          lastGroup = item.group;
          const isActive = pathname === item.href;

          return (
            <div key={item.href}>
              {showGroup && (
                <span className="mb-1 mt-4 block px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {item.group}
                </span>
              )}
              <Link
                href={item.href}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 3: Create the top bar**

Create `clawd-console/src/components/layout/top-bar.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { StatusDot } from '@/components/shared/status-dot';
import { fetchPi } from '@/lib/api';
import type { PiStatus, EvoStatus } from '@/lib/types';

export function TopBar() {
  const [piStatus, setPiStatus] = useState<PiStatus | null>(null);
  const [evoStatus, setEvoStatus] = useState<EvoStatus | null>(null);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);

  useEffect(() => {
    async function poll() {
      try {
        const status = await fetchPi<PiStatus>('status');
        setPiStatus(status);
      } catch {
        setPiStatus(null);
      }

      try {
        const evo = await fetchPi<EvoStatus>('evo');
        setEvoStatus(evo);
      } catch {
        setEvoStatus(null);
      }

      try {
        const health = await fetchPi<{ memory?: { total: number } }>('system-health');
        setMemoryCount(health.memory?.total ?? null);
      } catch {
        setMemoryCount(null);
      }
    }

    poll();
    const interval = setInterval(poll, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="flex h-10 items-center justify-between border-b border-border bg-background px-4">
      <div className="flex items-center gap-4">
        <StatusDot
          status={piStatus?.connected ? 'online' : piStatus === null ? 'unknown' : 'offline'}
          label={`WhatsApp${piStatus?.name ? `: ${piStatus.name}` : ''}`}
        />
        <StatusDot
          status={evoStatus?.online ? 'online' : evoStatus === null ? 'unknown' : 'offline'}
          label={`EVO${evoStatus?.model ? ` (${evoStatus.model})` : ''}`}
        />
        {memoryCount !== null && (
          <span className="text-xs text-muted-foreground">
            {memoryCount} memories
          </span>
        )}
      </div>
      <span className="font-mono text-[10px] text-muted-foreground">
        {piStatus ? `${Math.round(piStatus.uptime / 60)}m uptime` : ''}
      </span>
    </header>
  );
}
```

- [ ] **Step 4: Update root layout**

Replace `clawd-console/src/app/layout.tsx`:

```tsx
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Clawd Console',
  description: 'Infometrics dashboard for Clawd',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">
        <TooltipProvider>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            <div className="flex flex-1 flex-col overflow-hidden">
              <TopBar />
              <main className="flex-1 overflow-y-auto p-6">
                {children}
              </main>
            </div>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 5: Verify layout renders**

Run `npm run dev`, open `http://localhost:3000`. Should see dark sidebar with navigation groups, top bar with status dots, main content area.

- [ ] **Step 6: Commit**

```bash
git add clawd-console/src/components/layout/ clawd-console/src/components/shared/ clawd-console/src/app/layout.tsx
git commit -m "feat(console): add sidebar navigation and top bar with system status"
```

---

### Task 6: Overview Page

**Files:**
- Modify: `clawd-console/src/app/page.tsx`
- Create: `clawd-console/src/components/overview/health-cards.tsx`
- Create: `clawd-console/src/components/overview/stats-cards.tsx`

- [ ] **Step 1: Create health cards component**

Create `clawd-console/src/components/overview/health-cards.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusDot } from '@/components/shared/status-dot';
import { fetchPi } from '@/lib/api';
import type { PiStatus, SystemHealth, EvoStatus } from '@/lib/types';
import { Wifi, Cpu, Brain, Server } from 'lucide-react';

interface HealthData {
  pi: PiStatus | null;
  health: SystemHealth | null;
  evo: EvoStatus | null;
}

export function HealthCards() {
  const [data, setData] = useState<HealthData>({ pi: null, health: null, evo: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [pi, health, evo] = await Promise.allSettled([
          fetchPi<PiStatus>('status'),
          fetchPi<SystemHealth>('system-health'),
          fetchPi<EvoStatus>('evo'),
        ]);
        setData({
          pi: pi.status === 'fulfilled' ? pi.value : null,
          health: health.status === 'fulfilled' ? health.value : null,
          evo: evo.status === 'fulfilled' ? evo.value : null,
        });
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i}><CardContent className="p-4"><Skeleton className="h-16" /></CardContent></Card>
        ))}
      </div>
    );
  }

  const cards = [
    {
      title: 'WhatsApp',
      icon: Wifi,
      status: data.pi?.connected ? 'online' as const : 'offline' as const,
      value: data.pi?.name || 'Disconnected',
      detail: data.pi ? `${Math.round(data.pi.uptime / 3600)}h uptime` : '',
    },
    {
      title: 'EVO X2',
      icon: Cpu,
      status: data.evo?.online ? 'online' as const : 'offline' as const,
      value: data.evo?.model || 'Offline',
      detail: data.evo?.queueDepth ? `Queue: ${data.evo.queueDepth}` : '',
    },
    {
      title: 'Memory Service',
      icon: Brain,
      status: data.health?.memory?.total ? 'online' as const : 'warning' as const,
      value: data.health?.memory?.total ? `${data.health.memory.total} memories` : 'Unknown',
      detail: data.health?.memory?.categories
        ? `${Object.keys(data.health.memory.categories).length} categories`
        : '',
    },
    {
      title: 'Pi System',
      icon: Server,
      status: data.pi ? 'online' as const : 'offline' as const,
      value: data.health ? `${data.health.memoryMB}MB RAM` : 'Unknown',
      detail: data.health ? `${Math.round(data.health.uptime / 3600)}h uptime` : '',
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{card.title}</CardTitle>
            <card.icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="pb-4">
            <div className="flex items-center gap-2">
              <StatusDot status={card.status} />
              <span className="text-lg font-semibold">{card.value}</span>
            </div>
            {card.detail && (
              <p className="mt-1 text-xs text-muted-foreground">{card.detail}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create stats cards component**

Create `clawd-console/src/components/overview/stats-cards.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchPi } from '@/lib/api';
import type { TraceAnalysis } from '@/lib/types';
import { MessageSquare, ListChecks, Shield, GitBranch } from 'lucide-react';

export function StatsCards() {
  const [traces, setTraces] = useState<TraceAnalysis | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetchPi<{ analysis: TraceAnalysis | null }>('traces/live');
        setTraces(res.analysis);
      } catch {
        setTraces(null);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i}><CardContent className="p-4"><Skeleton className="h-12" /></CardContent></Card>
        ))}
      </div>
    );
  }

  if (!traces) {
    return (
      <div className="grid grid-cols-4 gap-4">
        <Card className="col-span-4">
          <CardContent className="p-4 text-sm text-muted-foreground">
            No trace data available yet.
          </CardContent>
        </Card>
      </div>
    );
  }

  const cards = [
    {
      title: 'Messages (24h)',
      icon: MessageSquare,
      value: traces.totalTraces,
    },
    {
      title: 'Plans Executed',
      icon: ListChecks,
      value: traces.plans.totalPlans,
      badge: traces.plans.statuses.failed
        ? { label: `${traces.plans.statuses.failed} failed`, variant: 'destructive' as const }
        : undefined,
    },
    {
      title: 'Quality Gate',
      icon: Shield,
      value: traces.qualityGate.totalGated,
      badge: { label: `${traces.qualityGate.percentage}%`, variant: 'secondary' as const },
    },
    {
      title: 'Anomalies',
      icon: GitBranch,
      value: traces.anomalies.length,
      badge: traces.anomalies.some(a => a.severity === 'warning')
        ? { label: 'warnings', variant: 'destructive' as const }
        : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{card.title}</CardTitle>
            <card.icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="pb-4">
            <span className="text-2xl font-bold">{card.value}</span>
            {card.badge && (
              <Badge variant={card.badge.variant} className="ml-2 text-xs">
                {card.badge.label}
              </Badge>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Build the overview page**

Replace `clawd-console/src/app/page.tsx`:

```tsx
import { HealthCards } from '@/components/overview/health-cards';
import { StatsCards } from '@/components/overview/stats-cards';

export default function OverviewPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">System Health</h2>
        <p className="text-sm text-muted-foreground">Live status of all subsystems</p>
      </div>
      <HealthCards />

      <div className="pt-2">
        <h2 className="text-lg font-semibold">Today</h2>
        <p className="text-sm text-muted-foreground">Last 24 hours of activity</p>
      </div>
      <StatsCards />
    </div>
  );
}
```

- [ ] **Step 4: Verify overview page**

Open `http://localhost:3000`. Should show 4 health cards (WhatsApp, EVO, Memory, Pi) and 4 stats cards (Messages, Plans, Quality Gate, Anomalies). If Pi is reachable, data populates. If not, skeletons then error states.

- [ ] **Step 5: Commit**

```bash
git add clawd-console/src/app/page.tsx clawd-console/src/components/overview/
git commit -m "feat(console): add overview page with health and stats cards"
```

---

### Task 7: New Pi Endpoint — Overnight Report JSON

**Files:**
- Modify: `src/http-server.js` (on Pi — the main clawdbot project, not clawd-console)

- [ ] **Step 1: Add the endpoint to http-server.js**

Find the section with `/api/traces` in `src/http-server.js` and add after it:

```javascript
if (path.startsWith('/api/overnight-report/')) {
  if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  const dateStr = path.split('/api/overnight-report/')[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return json(res, 400, { error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  const localPath = join('/tmp', `overnight-report-${dateStr}.json`);
  try {
    if (existsSync(localPath)) {
      const data = JSON.parse(readFileSync(localPath, 'utf-8'));
      return json(res, 200, data);
    }
    return json(res, 404, { error: `No overnight report for ${dateStr}` });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}
```

Ensure `existsSync` and `readFileSync` are imported at the top of the file (they likely already are from `'fs'`).

- [ ] **Step 2: Deploy to Pi**

```bash
scp -i ~/.ssh/id_ed25519 -o ConnectTimeout=10 src/http-server.js pi@100.104.92.87:~/clawdbot/src/
ssh -i ~/.ssh/id_ed25519 pi@100.104.92.87 "sudo systemctl restart clawdbot && sleep 2 && sudo systemctl is-active clawdbot"
```

- [ ] **Step 3: Verify endpoint**

```bash
curl http://100.104.92.87:3000/api/overnight-report/2026-03-31?token=<TOKEN>
```

Should return the overnight report JSON or 404 if no report exists for that date.

- [ ] **Step 4: Commit**

```bash
git add src/http-server.js
git commit -m "feat(api): add /api/overnight-report/:date endpoint"
```

---

### Task 8: Overnight Intelligence Page — Diaries Tab

**Files:**
- Create: `clawd-console/src/app/overnight/page.tsx`
- Create: `clawd-console/src/components/overnight/diary-card.tsx`
- Create: `clawd-console/src/components/overnight/quality-badge.tsx`
- Create: `clawd-console/src/components/overnight/date-selector.tsx`

- [ ] **Step 1: Create the quality badge**

Create `clawd-console/src/components/overnight/quality-badge.tsx`:

```tsx
import { Badge } from '@/components/ui/badge';
import type { DreamQuality } from '@/lib/types';

interface QualityBadgeProps {
  quality?: DreamQuality;
}

export function QualityBadge({ quality }: QualityBadgeProps) {
  if (!quality) return null;

  if (quality.skipped) {
    return <Badge variant="outline" className="text-xs">Skipped</Badge>;
  }

  const total = quality.facts_new + quality.facts_skipped_dedup + quality.facts_superseded;
  const newRatio = total > 0 ? quality.facts_new / total : 0;

  let variant: 'default' | 'secondary' | 'destructive' = 'default';
  if (newRatio < 0.3) variant = 'destructive';
  else if (newRatio < 0.7) variant = 'secondary';

  return (
    <Badge variant={variant} className="text-xs">
      {quality.facts_new} new / {total} total
    </Badge>
  );
}
```

- [ ] **Step 2: Create the diary card**

Create `clawd-console/src/components/overnight/diary-card.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { QualityBadge } from './quality-badge';
import type { DreamGroup } from '@/lib/types';
import { ChevronDown, ChevronRight, Quote } from 'lucide-react';

interface DiaryCardProps {
  group: DreamGroup;
}

export function DiaryCard({ group }: DiaryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isSkipped = group.quality?.skipped;
  const groupLabel = group.group_id.includes('_lid')
    ? 'DM'
    : `Group ${group.group_id.slice(0, 12)}...`;

  if (isSkipped) {
    return (
      <Card className="opacity-60">
        <CardHeader className="cursor-pointer py-3" onClick={() => setExpanded(!expanded)}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm">{groupLabel}</CardTitle>
              <span className="text-xs text-muted-foreground">{group.message_count} msgs</span>
              <QualityBadge quality={group.quality} />
            </div>
          </div>
        </CardHeader>
        {expanded && (
          <CardContent className="pt-0 text-sm text-muted-foreground">
            {group.diary}
          </CardContent>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="cursor-pointer py-3" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <CardTitle className="text-sm">{groupLabel}</CardTitle>
            <span className="text-xs text-muted-foreground">{group.message_count} msgs</span>
            <QualityBadge quality={group.quality} />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {group.facts.length > 0 && <span>{group.facts.length} facts</span>}
            {group.insights.length > 0 && <span>{group.insights.length} insights</span>}
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-4 pt-0">
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{group.diary}</div>

          {group.warnings.length > 0 && (
            <p className="text-xs italic text-yellow-500">
              Validation: {group.warnings.join(', ')}
            </p>
          )}

          {group.verbatim.length > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <h4 className="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                  <Quote className="h-3 w-3" /> Verbatim
                </h4>
                {group.verbatim.map((v, i) => (
                  <blockquote key={i} className="border-l-2 border-border pl-3 text-sm">
                    <span className="font-medium">{v.speaker}:</span> &ldquo;{v.quote}&rdquo;
                    {v.context && <span className="ml-1 text-xs text-muted-foreground">— {v.context}</span>}
                  </blockquote>
                ))}
              </div>
            </>
          )}

          {group.observations.length > 0 && (
            <>
              <Separator />
              <div className="space-y-1">
                <h4 className="text-xs font-semibold text-muted-foreground">Soul Observations</h4>
                {group.observations.map((obs, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <Badge
                      variant={obs.severity === 'critical' ? 'destructive' : obs.severity === 'corrective' ? 'secondary' : 'outline'}
                      className="text-[10px]"
                    >
                      {obs.severity}
                    </Badge>
                    <span>{obs.text}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
```

- [ ] **Step 3: Create the date selector**

Create `clawd-console/src/components/overnight/date-selector.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface DateSelectorProps {
  date: string;
  onDateChange: (date: string) => void;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function DateSelector({ date, onDateChange }: DateSelectorProps) {
  const today = new Date().toISOString().split('T')[0];
  const isToday = date === today;

  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onDateChange(addDays(date, -1))}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="min-w-[160px] text-center text-sm font-medium">
        {formatDate(date)}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        disabled={isToday}
        onClick={() => onDateChange(addDays(date, 1))}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Build the overnight page**

Create `clawd-console/src/app/overnight/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DiaryCard } from '@/components/overnight/diary-card';
import { DateSelector } from '@/components/overnight/date-selector';
import { fetchPi } from '@/lib/api';
import type { OvernightReport } from '@/lib/types';

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

export default function OvernightPage() {
  const [date, setDate] = useState(yesterday);
  const [report, setReport] = useState<OvernightReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchPi<OvernightReport>(`overnight-report/${date}`);
        setReport(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load report');
        setReport(null);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [date]);

  const activeGroups = report?.groups.filter(g => !g.quality?.skipped) || [];
  const skippedGroups = report?.groups.filter(g => g.quality?.skipped) || [];

  // Quality summary
  const qualities = (report?.groups || []).map(g => g.quality).filter(Boolean);
  const totalNew = qualities.reduce((s, q) => s + (q?.facts_new || 0), 0);
  const totalDedup = qualities.reduce((s, q) => s + (q?.facts_skipped_dedup || 0), 0);
  const totalSuperseded = qualities.reduce((s, q) => s + (q?.facts_superseded || 0), 0);
  const totalInsNew = qualities.reduce((s, q) => s + (q?.insights_new || 0), 0);
  const totalInsSkip = qualities.reduce((s, q) => s + (q?.insights_skipped || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Overnight Intelligence</h2>
          <p className="text-sm text-muted-foreground">Dream diaries, facts, insights, and analysis</p>
        </div>
        <DateSelector date={date} onDateChange={setDate} />
      </div>

      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">{error}</CardContent>
        </Card>
      )}

      {report && !loading && (
        <>
          {/* Quality summary bar */}
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>{report.groups_processed} groups</span>
            <span>{totalNew} new facts{totalDedup > 0 ? ` (${totalDedup} deduped)` : ''}{totalSuperseded > 0 ? ` (${totalSuperseded} superseded)` : ''}</span>
            <span>{totalInsNew} new insights{totalInsSkip > 0 ? ` (${totalInsSkip} skipped)` : ''}</span>
            {skippedGroups.length > 0 && <span>{skippedGroups.length} quiet groups</span>}
          </div>

          <Tabs defaultValue="diaries">
            <TabsList>
              <TabsTrigger value="diaries">Diaries</TabsTrigger>
              <TabsTrigger value="facts">Facts & Insights</TabsTrigger>
            </TabsList>

            <TabsContent value="diaries" className="space-y-3">
              {activeGroups.map((group) => (
                <DiaryCard key={group.group_id} group={group} />
              ))}

              {skippedGroups.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-muted-foreground">Quiet Groups</h3>
                  {skippedGroups.map((group) => (
                    <DiaryCard key={group.group_id} group={group} />
                  ))}
                </div>
              )}

              {activeGroups.length === 0 && skippedGroups.length === 0 && (
                <Card>
                  <CardContent className="p-4 text-sm text-muted-foreground">
                    No diary entries for this date.
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="facts" className="space-y-3">
              <FactsTable groups={report.groups} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

// Inline facts table for Phase 1 — simple card list, TanStack Table in Phase 3
function FactsTable({ groups }: { groups: OvernightReport['groups'] }) {
  const allFacts = groups.flatMap(g =>
    g.facts.map(f => ({ ...f, group: g.group_id.slice(0, 12), type: 'fact' as const }))
  );
  const allInsights = groups.flatMap(g =>
    g.insights.map(i => ({
      fact: i.insight,
      tags: i.topics,
      confidence: 0.75,
      group: g.group_id.slice(0, 12),
      type: 'insight' as const,
      evidence: i.evidence,
    }))
  );
  const all = [...allFacts, ...allInsights];

  if (all.length === 0) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          No facts or insights extracted.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {all.map((item, i) => (
        <Card key={i}>
          <CardContent className="flex items-start gap-3 p-3">
            <span className={`mt-0.5 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
              item.type === 'fact' ? 'bg-emerald-950 text-emerald-400' : 'bg-blue-950 text-blue-400'
            }`}>
              {item.type}
            </span>
            <div className="flex-1 space-y-1">
              <p className="text-sm">{item.fact}</p>
              <div className="flex items-center gap-2">
                {item.tags.slice(0, 4).map((tag) => (
                  <span key={tag} className="text-[10px] text-muted-foreground">#{tag}</span>
                ))}
                <span className="text-[10px] text-muted-foreground">
                  conf: {Math.round(item.confidence * 100)}%
                </span>
                <span className="text-[10px] text-muted-foreground">{item.group}...</span>
              </div>
              {item.type === 'insight' && item.evidence && item.evidence.length > 0 && (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  Evidence: {item.evidence.join(' | ')}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Verify overnight page**

Navigate to `http://localhost:3000/overnight`. Should show:
- Date selector defaulting to yesterday
- Quality summary bar
- Diary cards (expandable) if data exists, or error/empty state
- Facts & Insights tab

- [ ] **Step 6: Commit**

```bash
git add clawd-console/src/app/overnight/ clawd-console/src/components/overnight/
git commit -m "feat(console): add overnight intelligence page with diaries and facts tabs"
```

---

### Task 9: Verify Full MVP

- [ ] **Step 1: Start dev server and test all routes**

```bash
cd clawd-console && npm run dev
```

Test:
1. `http://localhost:3000` — Overview with health cards and stats
2. `http://localhost:3000/overnight` — Overnight page with date picker, diaries, facts
3. `http://localhost:3000/api/pi/status` — Raw Pi proxy response
4. `http://localhost:3000/api/evo/health` — Raw EVO proxy response
5. Sidebar navigation works between pages
6. Top bar shows live status dots

- [ ] **Step 2: Final commit**

```bash
git add -A clawd-console/
git commit -m "feat(console): Phase 1 MVP complete — overview + overnight intelligence"
```

---

## Phase 1 Complete

After this phase, you have:
- Working Next.js app with dark mode, sidebar nav, system status
- API proxy to Pi and EVO with Tailscale/LAN fallback
- Overview page with health cards and 24h stats
- Overnight intelligence page with expandable diary cards, quality badges, facts/insights viewer
- New `/api/overnight-report/:date` endpoint on Pi

**Next:** Phase 2 — Evolution Pipeline (kanban board + approve/reject + new Pi endpoints)
