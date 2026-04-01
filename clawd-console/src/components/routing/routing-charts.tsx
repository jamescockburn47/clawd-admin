'use client';

import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { TraceAnalysis } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

// Tailwind palette hex values — Recharts needs hex, not CSS vars
const ROUTING_COLORS: Record<string, string> = {
  keywords: '#10b981',      // emerald-500
  keyword: '#10b981',
  '4b_classifier': '#3b82f6', // blue-500
  classifier: '#3b82f6',
  fallback: '#ef4444',      // red-500
  image: '#8b5cf6',         // violet-500
  other: '#71717a',         // zinc-500
};

const DEFAULT_COLOR = '#71717a';

const TOOLTIP_STYLE = {
  contentStyle: { backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '6px' },
  labelStyle: { color: '#e4e4e7' },
  itemStyle: { color: '#a1a1aa' },
};

// ─── Routing PieChart ────────────────────────────────────────────────────────

interface RoutingPieProps {
  routing: TraceAnalysis['routing'];
}

export function RoutingPieChart({ routing }: RoutingPieProps) {
  const data = Object.entries(routing.percentages)
    .filter(([, pct]) => pct > 0)
    .map(([key, pct]) => ({
      name: key.replace('_', ' '),
      value: Math.round(pct * 10) / 10,
      count: routing.counts[key] ?? 0,
      key,
    }));

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-sm">Routing Distribution</CardTitle></CardHeader>
        <CardContent><p className="text-xs text-muted-foreground">No routing data</p></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Routing Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              outerRadius={100}
              label={({ name, value }) => `${name} ${value}%`}
              labelLine={true}
            >
              {data.map((entry) => (
                <Cell
                  key={entry.key}
                  fill={ROUTING_COLORS[entry.key] ?? DEFAULT_COLOR}
                />
              ))}
            </Pie>
            <Tooltip
              {...TOOLTIP_STYLE}
              formatter={(value, name, props) => {
                const count = (props.payload as { count?: number } | undefined)?.count ?? 0;
                return [`${value}% (${count} traces)`, String(name)];
              }}
            />
            <Legend
              formatter={(value) => (
                <span style={{ color: '#a1a1aa', fontSize: '12px' }}>{value}</span>
              )}
            />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ─── Category BarChart ───────────────────────────────────────────────────────

interface CategoryBarProps {
  categories: TraceAnalysis['categories'];
}

export function CategoryBarChart({ categories }: CategoryBarProps) {
  const data = Object.entries(categories)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-sm">Category Distribution</CardTitle></CardHeader>
        <CardContent><p className="text-xs text-muted-foreground">No category data</p></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Category Distribution (top 10)</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
            <XAxis type="number" tick={{ fill: '#71717a', fontSize: 11 }} />
            <YAxis
              type="category"
              dataKey="name"
              width={110}
              tick={{ fill: '#a1a1aa', fontSize: 11 }}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              formatter={(value) => [value, 'traces']}
            />
            <Bar dataKey="count" fill="#3b82f6" radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ─── Timing Stats ────────────────────────────────────────────────────────────

function timingColor(ms: number | null, thresholdLow: number, thresholdHigh: number): string {
  if (ms === null) return 'text-muted-foreground';
  if (ms < thresholdLow) return 'text-emerald-400';
  if (ms < thresholdHigh) return 'text-yellow-400';
  return 'text-red-400';
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

interface TimingStatsProps {
  timing: TraceAnalysis['timing'];
}

export function TimingStats({ timing }: TimingStatsProps) {
  const cards = [
    {
      label: 'Routing avg',
      value: timing.routingAvgMs,
      color: timingColor(timing.routingAvgMs, 100, 500),
    },
    {
      label: 'Routing p95',
      value: timing.routingP95Ms,
      color: timingColor(timing.routingP95Ms, 100, 500),
    },
    {
      label: 'Total avg',
      value: timing.totalAvgMs,
      color: timingColor(timing.totalAvgMs, 2000, 5000),
    },
    {
      label: 'Total p95',
      value: timing.totalP95Ms,
      color: timingColor(timing.totalP95Ms, 2000, 5000),
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Timing</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cards.map((card) => (
            <div key={card.label} className="rounded-lg bg-muted/40 px-3 py-3 text-center">
              <p className="text-[11px] text-muted-foreground">{card.label}</p>
              <p className={`mt-1 text-xl font-semibold tabular-nums ${card.color}`}>
                {formatMs(card.value)}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── needsPlan Stats ─────────────────────────────────────────────────────────

function accuracyColor(pct: number): string {
  if (pct >= 80) return 'text-emerald-400';
  if (pct >= 50) return 'text-yellow-400';
  return 'text-red-400';
}

interface NeedsPlanStatsProps {
  needsPlan: TraceAnalysis['needsPlan'];
}

export function NeedsPlanStats({ needsPlan }: NeedsPlanStatsProps) {
  const precision = Math.round(needsPlan.precision * 100);
  const recall = Math.round(needsPlan.recall * 100);
  const f1 = Math.round(needsPlan.f1 * 100);

  const cards = [
    { label: 'Precision', value: precision },
    { label: 'Recall', value: recall },
    { label: 'F1', value: f1 },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">needsPlan Accuracy</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          {cards.map((card) => (
            <div key={card.label} className="rounded-lg bg-muted/40 px-3 py-3 text-center">
              <p className="text-[11px] text-muted-foreground">{card.label}</p>
              <p className={`mt-1 text-2xl font-semibold tabular-nums ${accuracyColor(card.value)}`}>
                {card.value}%
              </p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>TP: <span className="text-foreground/70">{needsPlan.truePositives}</span></span>
          <span>FP: <span className="text-foreground/70">{needsPlan.falsePositives}</span></span>
          <span>FN: <span className="text-foreground/70">{needsPlan.falseNegatives}</span></span>
          <span>Predicted true: <span className="text-foreground/70">{needsPlan.predictedTrue}</span></span>
          <span>Actual multi-tool: <span className="text-foreground/70">{needsPlan.actualMultiTool}</span></span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Anomaly Alerts ──────────────────────────────────────────────────────────

function severityBadgeClass(severity: 'warning' | 'info'): string {
  return severity === 'warning'
    ? 'bg-yellow-900 text-yellow-200'
    : 'bg-blue-900 text-blue-200';
}

interface AnomalyAlertsProps {
  anomalies: TraceAnalysis['anomalies'];
}

export function AnomalyAlerts({ anomalies }: AnomalyAlertsProps) {
  if (anomalies.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-muted px-4 py-3 text-sm text-muted-foreground">
        No anomalies detected.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {anomalies.map((anomaly, i) => (
        <Alert key={i} className="border-muted/50">
          <AlertTitle className="flex items-center gap-2 text-sm">
            <Badge className={`text-[10px] ${severityBadgeClass(anomaly.severity)}`}>
              {anomaly.severity}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground">{anomaly.type}</span>
          </AlertTitle>
          <AlertDescription className="mt-1 space-y-0.5">
            <p className="text-xs text-foreground/80">{anomaly.detail}</p>
            <p className="text-xs text-muted-foreground">Suggestion: {anomaly.suggestion}</p>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
