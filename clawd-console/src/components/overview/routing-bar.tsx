'use client';

import { useEffect, useState } from 'react';
import { fetchPi } from '@/lib/api';
import type { TraceAnalysis } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface RoutingState {
  loading: boolean;
  routing: TraceAnalysis['routing'] | null;
}

// Map routing keys to display labels and colors
const ROUTING_SLOTS: Array<{ key: string; label: string; color: string }> = [
  { key: '4b_classifier', label: '4B classifier', color: 'bg-blue-500' },
  { key: 'classifier',    label: '4B classifier', color: 'bg-blue-500' },
  { key: 'keywords',      label: 'keywords',       color: 'bg-violet-500' },
  { key: 'keyword',       label: 'keywords',       color: 'bg-violet-500' },
  { key: 'fallback',      label: 'fallback',       color: 'bg-amber-500' },
];

interface Segment {
  label: string;
  pct: number;
  count: number;
  color: string;
}

function buildSegments(routing: TraceAnalysis['routing']): Segment[] {
  const seen = new Set<string>();
  const segments: Segment[] = [];

  // First pass: known slots in order
  for (const slot of ROUTING_SLOTS) {
    if (seen.has(slot.label)) continue;
    const count = routing.counts[slot.key] ?? 0;
    const pct = routing.percentages[slot.key] ?? 0;
    if (count > 0 || pct > 0) {
      seen.add(slot.label);
      segments.push({ label: slot.label, pct, count, color: slot.color });
    }
  }

  // Second pass: any remaining keys not already covered
  const knownKeys = new Set(ROUTING_SLOTS.map((s) => s.key));
  for (const [key, count] of Object.entries(routing.counts)) {
    if (knownKeys.has(key)) continue;
    const pct = routing.percentages[key] ?? 0;
    if (count > 0) {
      segments.push({ label: key, pct, count, color: 'bg-slate-500' });
    }
  }

  // Normalise so segments sum to 100
  const total = segments.reduce((s, seg) => s + seg.pct, 0);
  if (total > 0 && Math.abs(total - 100) > 1) {
    return segments.map((seg) => ({ ...seg, pct: (seg.pct / total) * 100 }));
  }

  return segments;
}

export function RoutingBar() {
  const [state, setState] = useState<RoutingState>({ loading: true, routing: null });

  useEffect(() => {
    async function load() {
      try {
        const result = await fetchPi<{ analysis: TraceAnalysis | null }>('traces/live');
        setState({ loading: false, routing: result.analysis?.routing ?? null });
      } catch {
        setState({ loading: false, routing: null });
      }
    }

    load();
  }, []);

  if (state.loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-20" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-full rounded-full" />
          <div className="flex gap-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-16" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!state.routing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Routing</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">No routing data</p>
        </CardContent>
      </Card>
    );
  }

  const segments = buildSegments(state.routing);

  if (segments.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Routing</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">No routing data</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Routing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Stacked bar */}
        <div className="flex h-3 w-full overflow-hidden rounded-full">
          {segments.map((seg, i) => (
            <div
              key={i}
              className={cn(seg.color, 'h-full transition-all')}
              style={{ width: `${seg.pct}%` }}
              title={`${seg.label}: ${seg.pct.toFixed(1)}% (${seg.count})`}
            />
          ))}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {segments.map((seg, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className={cn('h-2 w-2 rounded-full flex-shrink-0', seg.color)} />
              <span className="text-xs text-muted-foreground">
                <span className="text-foreground/70 font-medium">{seg.label}</span>{' '}
                {seg.pct.toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
