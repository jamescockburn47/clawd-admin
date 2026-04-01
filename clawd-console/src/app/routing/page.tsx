'use client';

import { useEffect, useState, useCallback } from 'react';
import { fetchPi } from '@/lib/api';
import type { TraceAnalysis } from '@/lib/types';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  RoutingPieChart,
  CategoryBarChart,
  TimingStats,
  NeedsPlanStats,
  AnomalyAlerts,
} from '@/components/routing/routing-charts';
import { PlanStats } from '@/components/routing/plan-stats';

interface TraceResponse {
  analysis: TraceAnalysis | null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

function SummaryBar({ analysis }: { analysis: TraceAnalysis }) {
  const topRoute = Object.entries(analysis.routing.percentages)
    .sort(([, a], [, b]) => b - a)[0];

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted-foreground">
      <span>
        <span className="text-foreground font-medium">{analysis.totalTraces}</span> traces
      </span>
      <span>
        period: <span className="text-foreground font-medium">{analysis.periodDays}d</span>
      </span>
      {topRoute && (
        <span>
          top route:{' '}
          <span className="text-foreground font-medium">
            {topRoute[0].replace('_', ' ')} ({topRoute[1].toFixed(0)}%)
          </span>
        </span>
      )}
      <span>
        plans:{' '}
        <span className="text-foreground font-medium">{analysis.plans.totalPlans}</span>
      </span>
      {analysis.anomalies.length > 0 && (
        <Badge className="bg-yellow-900 text-yellow-200 text-[10px]">
          {analysis.anomalies.length} anomal{analysis.anomalies.length === 1 ? 'y' : 'ies'}
        </Badge>
      )}
    </div>
  );
}

function AnalysisContent({ analysis }: { analysis: TraceAnalysis }) {
  return (
    <div className="space-y-4">
      <SummaryBar analysis={analysis} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RoutingPieChart routing={analysis.routing} />
        <CategoryBarChart categories={analysis.categories} />
      </div>

      <TimingStats timing={analysis.timing} />
      <NeedsPlanStats needsPlan={analysis.needsPlan} />

      <div>
        <h3 className="mb-2 text-sm font-semibold">Plan Execution</h3>
        <PlanStats plans={analysis.plans} />
      </div>

      <Separator />

      <div>
        <h3 className="mb-2 text-sm font-semibold">
          Anomalies
          {analysis.anomalies.length > 0 && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              ({analysis.anomalies.length})
            </span>
          )}
        </h3>
        <AnomalyAlerts anomalies={analysis.anomalies} />
      </div>
    </div>
  );
}

export default function RoutingPage() {
  // Nightly analysis tab
  const [nightlyAnalysis, setNightlyAnalysis] = useState<TraceAnalysis | null>(null);
  const [nightlyLoading, setNightlyLoading] = useState(true);
  const [nightlyError, setNightlyError] = useState<string | null>(null);

  // Live traces tab
  const [liveAnalysis, setLiveAnalysis] = useState<TraceAnalysis | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveFetched, setLiveFetched] = useState(false);

  // Load nightly on mount
  useEffect(() => {
    async function load() {
      try {
        const res = await fetchPi<TraceResponse>('traces');
        setNightlyAnalysis(res.analysis);
      } catch (err) {
        setNightlyError(String(err));
      } finally {
        setNightlyLoading(false);
      }
    }
    load();
  }, []);

  const fetchLive = useCallback(async () => {
    setLiveLoading(true);
    setLiveError(null);
    try {
      const res = await fetchPi<TraceResponse>('traces/live');
      setLiveAnalysis(res.analysis);
      setLiveFetched(true);
    } catch (err) {
      setLiveError(String(err));
    } finally {
      setLiveLoading(false);
    }
  }, []);

  // Fetch live data when the Live Traces tab is first activated
  function handleTabChange(value: string) {
    if (value === 'live' && !liveFetched && !liveLoading) {
      fetchLive();
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold">Routing &amp; Traces</h2>
        <p className="text-sm text-muted-foreground">
          Message routing breakdown, classifier accuracy, and plan execution metrics
        </p>
      </div>

      <Tabs defaultValue="analysis" onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="analysis">Analysis</TabsTrigger>
          <TabsTrigger value="live">Live Traces</TabsTrigger>
        </TabsList>

        {/* ── Nightly Analysis tab ── */}
        <TabsContent value="analysis" className="mt-4">
          {nightlyLoading && <LoadingSkeleton />}

          {nightlyError && (
            <div className="rounded-md bg-red-950 px-4 py-3 text-sm text-red-300">
              Failed to load trace analysis: {nightlyError}
            </div>
          )}

          {!nightlyLoading && !nightlyError && !nightlyAnalysis && (
            <div className="rounded-md border border-dashed border-muted px-4 py-8 text-center text-sm text-muted-foreground">
              No nightly analysis available yet. Analysis runs at 3 AM.
            </div>
          )}

          {!nightlyLoading && nightlyAnalysis && (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                Last analysed: {formatDate(nightlyAnalysis.analysedAt)}
              </p>
              <AnalysisContent analysis={nightlyAnalysis} />
            </div>
          )}
        </TabsContent>

        {/* ── Live Traces tab ── */}
        <TabsContent value="live" className="mt-4">
          <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                On-demand analysis of the last 24 hours of traces
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={fetchLive}
                disabled={liveLoading}
              >
                {liveLoading ? 'Fetching…' : 'Refresh'}
              </Button>
            </div>

            {liveLoading && <LoadingSkeleton />}

            {liveError && (
              <div className="rounded-md bg-red-950 px-4 py-3 text-sm text-red-300">
                Failed to load live traces: {liveError}
              </div>
            )}

            {!liveLoading && !liveError && liveFetched && !liveAnalysis && (
              <div className="rounded-md border border-dashed border-muted px-4 py-8 text-center text-sm text-muted-foreground">
                No trace data in the last 24 hours.
              </div>
            )}

            {!liveLoading && !liveError && !liveFetched && (
              <div className="rounded-md border border-dashed border-muted px-4 py-8 text-center text-sm text-muted-foreground">
                Click Refresh to fetch live trace data.
              </div>
            )}

            {!liveLoading && liveAnalysis && (
              <div className="space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  Analysed: {formatDate(liveAnalysis.analysedAt)} — last 24h
                </p>
                <AnalysisContent analysis={liveAnalysis} />
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
