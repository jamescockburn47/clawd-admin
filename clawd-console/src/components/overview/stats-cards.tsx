'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MessageSquare, ListChecks, Shield, AlertTriangle } from 'lucide-react';
import { fetchPi } from '@/lib/api';
import type { TraceAnalysis } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

interface StatsState {
  loading: boolean;
  analysis: TraceAnalysis | null;
}

function TopCategories({ categories }: { categories: Record<string, number> }) {
  const sorted = Object.entries(categories)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  if (sorted.length === 0) return null;

  return (
    <div className="mt-2 space-y-0.5">
      {sorted.map(([cat, count]) => (
        <p key={cat} className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">{cat}</span>{' '}
          {count}
        </p>
      ))}
    </div>
  );
}

function PlanBreakdown({ plans }: { plans: TraceAnalysis['plans'] }) {
  const succeeded = plans.statuses['completed'] ?? plans.statuses['success'] ?? 0;
  const failed = plans.statuses['failed'] ?? 0;

  return (
    <div className="mt-2 space-y-0.5">
      {succeeded > 0 && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">ok</span> {succeeded}
        </p>
      )}
      {failed > 0 && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-destructive">failed</span> {failed}
        </p>
      )}
      {plans.avgSteps > 0 && (
        <p className="text-xs text-muted-foreground">
          avg {plans.avgSteps.toFixed(1)} steps
        </p>
      )}
    </div>
  );
}

function QualityBreakdown({ byCategory }: { byCategory: Record<string, number> }) {
  const sorted = Object.entries(byCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);

  if (sorted.length === 0) return null;

  return (
    <div className="mt-2 space-y-0.5">
      {sorted.map(([cat, count]) => (
        <p key={cat} className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">{cat}</span>{' '}
          {count}
        </p>
      ))}
    </div>
  );
}

function AnomalyList({ anomalies }: { anomalies: TraceAnalysis['anomalies'] }) {
  if (anomalies.length === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">none</p>
    );
  }

  return (
    <div className="mt-2 space-y-1.5">
      {anomalies.map((a, i) => (
        <Alert
          key={i}
          variant={a.severity === 'warning' ? 'destructive' : 'default'}
          className="py-1.5 px-2"
        >
          <AlertDescription className={cn('text-xs', a.severity === 'warning' ? 'text-destructive/90' : '')}>
            <span className="font-medium">{a.detail}</span>
            {a.suggestion && (
              <span className="block text-muted-foreground mt-0.5">{a.suggestion}</span>
            )}
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
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
      <div className="space-y-3">
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-28" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-7 w-16" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (!state.analysis) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="flex items-center justify-center py-8">
                <span className="text-xs text-muted-foreground">No trace data</span>
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="text-right">
          <Link href="/overnight" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            View overnight report →
          </Link>
        </div>
      </div>
    );
  }

  const { analysis } = state;

  return (
    <div className="space-y-3">
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
            <TopCategories categories={analysis.categories} />
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
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {analysis.plans.totalPlans.toLocaleString()}
            </p>
            <PlanBreakdown plans={analysis.plans} />
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
          <CardContent>
            <div className="flex items-baseline gap-2">
              <p className="text-2xl font-semibold tabular-nums">
                {analysis.qualityGate.totalGated.toLocaleString()}
              </p>
              <Badge variant="secondary" className="text-xs">
                {analysis.qualityGate.percentage.toFixed(1)}%
              </Badge>
            </div>
            <QualityBreakdown byCategory={analysis.qualityGate.byCategory} />
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
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {analysis.anomalies.length}
            </p>
            <AnomalyList anomalies={analysis.anomalies} />
          </CardContent>
        </Card>
      </div>

      <div className="text-right">
        <Link href="/overnight" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
          View overnight report →
        </Link>
      </div>
    </div>
  );
}
