'use client';

import { useEffect, useState } from 'react';
import { MessageSquare, ListChecks, Shield, AlertTriangle } from 'lucide-react';
import { fetchPi } from '@/lib/api';
import type { TraceAnalysis } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

interface StatsState {
  loading: boolean;
  analysis: TraceAnalysis | null;
}

export function StatsCards() {
  const [state, setState] = useState<StatsState>({ loading: true, analysis: null });

  useEffect(() => {
    async function load() {
      try {
        const result = await fetchPi<{ analysis: TraceAnalysis | null }>('traces/live');
        setState({ loading: false, analysis: result.analysis });
      } catch {
        setState({ loading: false, analysis: null });
      }
    }

    load();
  }, []);

  if (state.loading) {
    return (
      <div className="grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-7 w-16" />
              <Skeleton className="h-4 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!state.analysis) {
    return (
      <div className="grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="flex items-center justify-center py-8">
              <span className="text-xs text-muted-foreground">No trace data</span>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const { analysis } = state;
  const failedPlans = analysis.plans.statuses['failed'] ?? 0;
  const hasAnomalyWarning = analysis.anomalies.some((a) => a.severity === 'warning');

  return (
    <div className="grid grid-cols-4 gap-4">
      {/* Messages (24h) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            Messages (24h)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums">
            {analysis.totalTraces.toLocaleString()}
          </p>
        </CardContent>
      </Card>

      {/* Plans Executed */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-muted-foreground" />
            Plans Executed
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <p className="text-2xl font-semibold tabular-nums">
            {analysis.plans.totalPlans.toLocaleString()}
          </p>
          {failedPlans > 0 && (
            <Badge variant="destructive">{failedPlans} failed</Badge>
          )}
        </CardContent>
      </Card>

      {/* Quality Gate */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            Quality Gate
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <p className="text-2xl font-semibold tabular-nums">
            {analysis.qualityGate.totalGated.toLocaleString()}
          </p>
          <Badge variant="secondary">
            {analysis.qualityGate.percentage.toFixed(1)}%
          </Badge>
        </CardContent>
      </Card>

      {/* Anomalies */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            Anomalies
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <p className="text-2xl font-semibold tabular-nums">
            {analysis.anomalies.length}
          </p>
          {hasAnomalyWarning && (
            <Badge variant="destructive">warnings</Badge>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
