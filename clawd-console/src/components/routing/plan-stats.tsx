'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { TraceAnalysis } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const TOOLTIP_STYLE = {
  contentStyle: { backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '6px' },
  labelStyle: { color: '#e4e4e7' },
  itemStyle: { color: '#a1a1aa' },
};

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

interface PlanStatsProps {
  plans: TraceAnalysis['plans'];
}

export function PlanStats({ plans }: PlanStatsProps) {
  const toolData = Object.entries(plans.toolUsage)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const successCount = plans.statuses['success'] ?? plans.statuses['completed'] ?? 0;
  const failedCount = plans.statuses['failed'] ?? plans.statuses['error'] ?? 0;
  const otherStatuses = Object.entries(plans.statuses).filter(
    ([k]) => !['success', 'completed', 'failed', 'error'].includes(k)
  );

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg bg-muted/40 px-3 py-3 text-center">
          <p className="text-[11px] text-muted-foreground">Total plans</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {plans.totalPlans}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-3 text-center">
          <p className="text-[11px] text-muted-foreground">Avg steps</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {plans.avgSteps.toFixed(1)}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-3 text-center">
          <p className="text-[11px] text-muted-foreground">Avg time</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {formatMs(plans.avgTimeMs)}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-3 text-center">
          <p className="text-[11px] text-muted-foreground">Adaptation rate</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {Math.round(plans.adaptationRate * 100)}%
          </p>
        </div>
      </div>

      {/* Status breakdown */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Status Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {successCount > 0 && (
              <Badge className="bg-emerald-900 text-emerald-200">
                success: {successCount}
              </Badge>
            )}
            {failedCount > 0 && (
              <Badge className="bg-red-900 text-red-200">
                failed: {failedCount}
              </Badge>
            )}
            {otherStatuses.map(([status, count]) => (
              <Badge key={status} className="bg-zinc-800 text-zinc-300">
                {status}: {count}
              </Badge>
            ))}
            {plans.totalPlans === 0 && (
              <span className="text-xs text-muted-foreground">No plans recorded</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Tool usage chart */}
      {toolData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tool Usage (top 5)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={toolData} layout="vertical" margin={{ left: 8, right: 24 }}>
                <XAxis type="number" tick={{ fill: '#71717a', fontSize: 11 }} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={120}
                  tick={{ fill: '#a1a1aa', fontSize: 11 }}
                />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  formatter={(value) => [value, 'calls']}
                />
                <Bar dataKey="count" fill="#8b5cf6" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Failure reasons */}
      {plans.failureReasons.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Failure Reasons</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {plans.failureReasons.map((failure, i) => (
                <div
                  key={i}
                  className="rounded-md bg-red-950/30 px-3 py-2 text-xs space-y-0.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-red-400">{failure.tool}</span>
                    <span className="text-muted-foreground truncate max-w-xs" title={failure.planGoal}>
                      goal: {failure.planGoal}
                    </span>
                  </div>
                  <p className="text-muted-foreground">{failure.error}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
