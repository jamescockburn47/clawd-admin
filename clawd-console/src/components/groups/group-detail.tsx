'use client';

import type { ParticipationDecision, ParticipationGroupSummary } from '@/lib/types';
import { formatDecisionHighlights, formatDurationMs, formatGroupMode, formatPosture } from '@/lib/participation/view-models';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

export function GroupDetail({
  group,
  decisions,
  highlightLimit,
}: {
  group: ParticipationGroupSummary | null;
  decisions: ParticipationDecision[];
  highlightLimit: number;
}) {
  if (!group) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Group detail</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Select a group to see tuning and recent decisions.</p>
        </CardContent>
      </Card>
    );
  }

  const highlights = formatDecisionHighlights(decisions, group.chatJid, highlightLimit);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{group.groupLabel}</CardTitle>
        <p className="font-mono text-xs text-muted-foreground">{group.chatJid}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">mode: {formatGroupMode(group.groupMode)}</Badge>
          <Badge variant="secondary">{formatPosture(group.posture)}</Badge>
          <Badge variant="outline">follow-up {formatDurationMs(group.followUpWindowMs)}</Badge>
          <Badge variant="outline">cooldown {formatDurationMs(group.cooldownMs)}</Badge>
        </div>
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground">Research</p>
            <p className="font-medium">{group.researchEnabled ? 'enabled' : 'disabled'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Memory recall</p>
            <p className="font-medium">{group.memoryRecallEnabled ? 'enabled' : 'disabled'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Max unsolicited / hour</p>
            <p className="font-medium tabular-nums">{group.maxUnsolicitedPerHour}</p>
          </div>
        </div>
        <Separator />
        <div>
          <p className="mb-2 text-sm font-medium">Recent participation decisions</p>
          {highlights.length === 0 ? (
            <p className="text-sm text-muted-foreground">No decisions in the loaded sample for this group.</p>
          ) : (
            <ul className="space-y-3">
              {highlights.map((d) => (
                <li key={`${d.timestamp}-${d.reason}`} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {new Date(d.timestamp).toLocaleString()}
                    </span>
                    <Badge variant={d.shouldIntervene ? 'default' : 'secondary'}>
                      {d.shouldIntervene ? 'intervene' : 'skip'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">{d.reason}</p>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    {d.interventionType ? <span>type: {d.interventionType}</span> : null}
                    <span>confidence {d.confidence.toFixed(2)}</span>
                    {d.followUpWindowOpen ? <span>follow-up window open</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
