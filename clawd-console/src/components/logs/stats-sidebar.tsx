'use client';

import type { TraceAnalysis } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

interface StatsSidebarProps {
  analysis: TraceAnalysis | null;
  loading?: boolean;
}

function pct(n: number): string {
  return `${n.toFixed(0)}%`;
}

function ms(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${Math.round(n)}ms`;
}

const MODEL_COLOURS: Record<string, string> = {
  claude:   'bg-purple-500',
  opus:     'bg-purple-500',
  sonnet:   'bg-purple-500',
  minimax:  'bg-blue-500',
  mini:     'bg-blue-500',
  evo:      'bg-emerald-500',
  local:    'bg-emerald-500',
  qwen:     'bg-emerald-500',
};

function modelDotColour(modelName: string): string {
  const m = modelName.toLowerCase();
  for (const [key, cls] of Object.entries(MODEL_COLOURS)) {
    if (m.includes(key)) return cls;
  }
  return 'bg-zinc-500';
}

export function StatsSidebar({ analysis, loading = false }: StatsSidebarProps) {
  if (loading) {
    return (
      <div className="w-52 shrink-0 space-y-3">
        {[1, 2, 3].map((i) => (
          <Card key={i} className="animate-pulse">
            <CardContent className="h-20 p-3" />
          </Card>
        ))}
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="w-52 shrink-0">
        <Card>
          <CardContent className="px-3 py-4 text-xs text-muted-foreground">
            No trace data available.
          </CardContent>
        </Card>
      </div>
    );
  }

  // Routing breakdown
  const routingEntries = Object.entries(analysis.routing.percentages)
    .sort(([, a], [, b]) => b - a);

  // Model distribution
  const modelEntries = Object.entries(analysis.models.distribution)
    .sort(([, a], [, b]) => b - a);
  const totalModels = modelEntries.reduce((s, [, v]) => s + v, 0) || 1;

  // Top 3 categories
  const topCategories = Object.entries(analysis.categories)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  return (
    <div className="w-52 shrink-0 space-y-3">
      {/* Total messages */}
      <Card>
        <CardHeader className="pb-1 pt-3 px-3">
          <CardTitle className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Messages (24h)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 pt-0">
          <p className="text-2xl font-semibold tabular-nums">{analysis.totalTraces}</p>
        </CardContent>
      </Card>

      {/* Avg response time */}
      <Card>
        <CardHeader className="pb-1 pt-3 px-3">
          <CardTitle className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Avg Response
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 pt-0 space-y-1">
          <p className="text-lg font-semibold tabular-nums">
            {ms(analysis.timing.totalAvgMs)}
          </p>
          <p className="text-[11px] text-muted-foreground">
            p95 {ms(analysis.timing.totalP95Ms)}
          </p>
        </CardContent>
      </Card>

      {/* Routing breakdown */}
      <Card>
        <CardHeader className="pb-1 pt-3 px-3">
          <CardTitle className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Routing
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 pt-0 space-y-1.5">
          {routingEntries.map(([route, pctVal]) => (
            <div key={route} className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] text-muted-foreground capitalize">
                {route.replace(/_/g, ' ')}
              </span>
              <span className="text-[11px] tabular-nums font-medium">{pct(pctVal)}</span>
            </div>
          ))}
          {routingEntries.length === 0 && (
            <p className="text-[11px] text-muted-foreground">No routing data</p>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* Model distribution */}
      <Card>
        <CardHeader className="pb-1 pt-3 px-3">
          <CardTitle className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Models
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 pt-0 space-y-1.5">
          {modelEntries.map(([model, count]) => {
            const share = (count / totalModels) * 100;
            return (
              <div key={model} className="space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${modelDotColour(model)}`} />
                    <span className="truncate text-[11px] text-muted-foreground">{model}</span>
                  </div>
                  <span className="text-[11px] tabular-nums font-medium">{pct(share)}</span>
                </div>
                {/* Mini bar */}
                <div className="h-0.5 w-full rounded-full bg-muted">
                  <div
                    className={`h-0.5 rounded-full ${modelDotColour(model)}`}
                    style={{ width: `${share}%` }}
                  />
                </div>
              </div>
            );
          })}
          {modelEntries.length === 0 && (
            <p className="text-[11px] text-muted-foreground">No model data</p>
          )}
        </CardContent>
      </Card>

      {/* Top categories */}
      <Card>
        <CardHeader className="pb-1 pt-3 px-3">
          <CardTitle className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Top Categories
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 pt-0 space-y-1.5">
          {topCategories.map(([cat, count], idx) => (
            <div key={cat} className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground tabular-nums w-3">
                {idx + 1}.
              </span>
              <span className="flex-1 truncate text-[11px] capitalize text-foreground">
                {cat}
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
            </div>
          ))}
          {topCategories.length === 0 && (
            <p className="text-[11px] text-muted-foreground">No category data</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
