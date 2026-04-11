'use client';

import type { GroupCardModel } from '@/lib/participation/view-models';
import { formatDurationMs, formatGroupMode } from '@/lib/participation/view-models';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function GroupCard({
  model,
  selected,
  onSelect,
}: {
  model: GroupCardModel;
  selected: boolean;
  onSelect: (chatJid: string) => void;
}) {
  const { summary } = model;
  return (
    <button
      type="button"
      onClick={() => onSelect(summary.chatJid)}
      className={cn('w-full text-left transition-colors', selected && 'ring-2 ring-primary')}
    >
      <Card className={cn('hover:bg-accent/40', selected && 'bg-accent/30')}>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium leading-tight">{summary.groupLabel}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{summary.chatJid}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-1">
              <Badge variant="outline">{formatGroupMode(summary.groupMode)}</Badge>
              <Badge variant="secondary">{summary.posture}</Badge>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>research {summary.researchEnabled ? 'on' : 'off'}</span>
            <span>·</span>
            <span>memory recall {summary.memoryRecallEnabled ? 'on' : 'off'}</span>
            <span>·</span>
            <span>max unsolicited/h {summary.maxUnsolicitedPerHour}</span>
            <span>·</span>
            <span>follow-up {formatDurationMs(summary.followUpWindowMs)}</span>
            <span>·</span>
            <span>cooldown {formatDurationMs(summary.cooldownMs)}</span>
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>
              recent decisions logged: <span className="tabular-nums text-foreground">{model.recentDecisionCount}</span>
            </span>
            {model.lastInterventionAt ? (
              <span>
                last intervention:{' '}
                <span className="text-foreground">{new Date(model.lastInterventionAt).toLocaleString()}</span>
              </span>
            ) : (
              <span>no intervention in sample</span>
            )}
          </div>
        </CardContent>
      </Card>
    </button>
  );
}
