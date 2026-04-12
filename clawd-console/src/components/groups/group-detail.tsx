'use client';

import { useState, useCallback } from 'react';
import type { ParticipationDecision, ParticipationGroupSummary, ParticipationPosture } from '@/lib/types';
import { formatDecisionHighlights, formatDurationMs, formatGroupMode, formatPosture } from '@/lib/participation/view-models';
import { patchParticipationGroup, patchAgencyPolicy } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

function SaveFlash({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return <span className="ml-2 text-xs text-green-500 animate-pulse">Saved</span>;
}

export function GroupDetail({
  group,
  decisions,
  highlightLimit,
  onGroupUpdated,
}: {
  group: ParticipationGroupSummary | null;
  decisions: ParticipationDecision[];
  highlightLimit: number;
  onGroupUpdated?: () => void;
}) {
  const [saved, setSaved] = useState<string | null>(null);

  const flash = useCallback((field: string) => {
    setSaved(field);
    setTimeout(() => setSaved(null), 1500);
  }, []);

  const handlePostureChange = useCallback(async (posture: ParticipationPosture) => {
    if (!group) return;
    await patchParticipationGroup(group.chatJid, { posture });
    flash('posture');
    onGroupUpdated?.();
  }, [group, flash, onGroupUpdated]);

  const handleAmbientToggle = useCallback(async (enabled: boolean) => {
    if (!group) return;
    await patchAgencyPolicy(group.groupLabel.toLowerCase(), { enabled });
    flash('ambient');
    onGroupUpdated?.();
  }, [group, flash, onGroupUpdated]);

  const handleMaxUnsolicited = useCallback(async (delta: number) => {
    if (!group) return;
    const next = Math.max(1, Math.min(20, group.maxUnsolicitedPerHour + delta));
    if (next === group.maxUnsolicitedPerHour) return;
    await patchParticipationGroup(group.chatJid, { maxUnsolicitedPerHour: next });
    flash('maxUnsolicited');
    onGroupUpdated?.();
  }, [group, flash, onGroupUpdated]);

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
          <Badge variant="outline">follow-up {formatDurationMs(group.followUpWindowMs)}</Badge>
          <Badge variant="outline">cooldown {formatDurationMs(group.cooldownMs)}</Badge>
        </div>

        {/* Quick toggles */}
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <label className="text-muted-foreground block mb-1">Posture <SaveFlash visible={saved === 'posture'} /></label>
            <select
              className="w-full rounded border bg-background px-2 py-1 text-sm"
              value={group.posture}
              onChange={(e) => handlePostureChange(e.target.value as ParticipationPosture)}
            >
              <option value="direct_only">Direct only</option>
              <option value="rare_high_confidence">Rare (high confidence)</option>
              <option value="active_participant">Active participant</option>
            </select>
          </div>
          <div>
            <label className="text-muted-foreground block mb-1">Max unsolicited/hr <SaveFlash visible={saved === 'maxUnsolicited'} /></label>
            <div className="flex items-center gap-2">
              <button className="rounded border px-2 py-1 hover:bg-accent" onClick={() => handleMaxUnsolicited(-1)}>-</button>
              <span className="tabular-nums font-medium w-6 text-center">{group.maxUnsolicitedPerHour}</span>
              <button className="rounded border px-2 py-1 hover:bg-accent" onClick={() => handleMaxUnsolicited(1)}>+</button>
            </div>
          </div>
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
