'use client'

import type { TraceAnalysis } from '@/lib/types'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'

interface Props {
  analysis: TraceAnalysis
}

const ROUTING_COLORS: Record<string, string> = {
  '4b_classifier': 'bg-blue-500',
  classifier: 'bg-blue-500',
  keywords: 'bg-violet-500',
  keyword: 'bg-violet-500',
  fallback: 'bg-amber-500',
}

function fmt(ms: number | null): string {
  if (ms === null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`

export function TraceSummary({ analysis }: Props) {
  // Routing bar segments
  const segments = Object.entries(analysis.routing.percentages)
    .filter(([, v]) => v > 0)
    .map(([key, v]) => ({
      key,
      label: key.replace(/_/g, ' '),
      pct: v,
      color: ROUTING_COLORS[key] ?? 'bg-slate-500',
    }))

  // Top 5 categories
  const topCats = Object.entries(analysis.categories)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)

  const { timing, needsPlan, anomalies } = analysis

  return (
    <div className="flex flex-col gap-4">
      {/* Routing bar */}
      <Card size="sm">
        <CardContent className="pt-3 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Routing — {analysis.totalTraces} traces ({analysis.periodDays}d)</p>
          <div className="flex h-3 w-full overflow-hidden rounded-full">
            {segments.map((s) => (
              <div
                key={s.key}
                className={cn(s.color, 'h-full')}
                style={{ width: `${s.pct}%` }}
                title={`${s.label}: ${s.pct.toFixed(1)}%`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {segments.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <div className={cn('h-2 w-2 rounded-full shrink-0', s.color)} />
                <span className="text-xs text-muted-foreground">
                  <span className="text-foreground/70 font-medium">{s.label}</span>{' '}
                  {s.pct.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        {/* Top categories */}
        <Card size="sm">
          <CardContent className="pt-3 space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Top categories</p>
            {topCats.map(([cat, count]) => (
              <div key={cat} className="flex items-center justify-between text-xs">
                <span className="text-foreground/80">{cat}</span>
                <span className="tabular-nums text-muted-foreground">{count}</span>
              </div>
            ))}
            {topCats.length === 0 && (
              <p className="text-xs text-muted-foreground">No data</p>
            )}
          </CardContent>
        </Card>

        {/* Timing + needsPlan */}
        <div className="flex flex-col gap-4">
          <Card size="sm">
            <CardContent className="pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                Timing
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <span className="text-muted-foreground">routing avg</span>
                <span className="tabular-nums">{fmt(timing.routingAvgMs)}</span>
                <span className="text-muted-foreground">routing p95</span>
                <span className="tabular-nums">{fmt(timing.routingP95Ms)}</span>
                <span className="text-muted-foreground">total avg</span>
                <span className="tabular-nums">{fmt(timing.totalAvgMs)}</span>
                <span className="text-muted-foreground">total p95</span>
                <span className="tabular-nums">{fmt(timing.totalP95Ms)}</span>
              </div>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardContent className="pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                needsPlan
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <span className="text-muted-foreground">precision</span>
                <span className="tabular-nums">{pct(needsPlan.precision)}</span>
                <span className="text-muted-foreground">recall</span>
                <span className="tabular-nums">{pct(needsPlan.recall)}</span>
                <span className="text-muted-foreground">F1</span>
                <span className="tabular-nums">{pct(needsPlan.f1)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {anomalies.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground px-1">Anomalies</p>
          {anomalies.map((a, i) => (
            <Alert key={i} variant={a.severity === 'warning' ? 'destructive' : 'default'}>
              <AlertTitle className="text-xs font-medium">{a.type}</AlertTitle>
              <AlertDescription className="text-xs">
                {a.detail}
                {a.suggestion && <span className="block mt-0.5 italic">{a.suggestion}</span>}
              </AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      {anomalies.length === 0 && <p className="text-xs text-muted-foreground px-1">No anomalies detected.</p>}
    </div>
  )
}
