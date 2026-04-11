'use client';

import { useMemo, useState } from 'react';
import type { ParticipationGroupMode, ParticipationPosture } from '@/lib/types';
import { buildInstructionStackRows } from '@/lib/participation/view-models';
import { InstructionStack } from '@/components/playbook/instruction-stack';
import { RolePlaybook } from '@/components/playbook/role-playbook';
import { FollowUpPlaybook } from '@/components/playbook/follow-up-playbook';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const DEFAULT_MODE: ParticipationGroupMode = 'open';
const DEFAULT_POSTURE: ParticipationPosture = 'rare_high_confidence';
const DEFAULT_FOLLOW_MS = 180_000;

export default function PlaybookPage() {
  const [mode, setMode] = useState<ParticipationGroupMode>(DEFAULT_MODE);
  const [posture, setPosture] = useState<ParticipationPosture>(DEFAULT_POSTURE);
  const [followUpWindowMs, setFollowUpWindowMs] = useState<number>(DEFAULT_FOLLOW_MS);

  const rows = useMemo(
    () => buildInstructionStackRows({ mode, posture, followUpWindowMs }),
    [mode, posture, followUpWindowMs]
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Playbook</h2>
        <p className="text-sm text-muted-foreground">
          Instruction stack (security, participation policy, timing) plus role and follow-up behaviour in plain English.
          Adjust the sample tuning below to preview how layers read together.
        </p>
      </div>

      <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="mode">Group mode (sample)</Label>
          <select
            id="mode"
            aria-label="Group mode sample"
            value={mode}
            onChange={(e) => setMode(e.target.value as ParticipationGroupMode)}
            className={cn(
              'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'
            )}
          >
            <option value="open">open</option>
            <option value="project">project</option>
            <option value="colleague">colleague</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="posture">Posture (sample)</Label>
          <select
            id="posture"
            aria-label="Posture sample"
            value={posture}
            onChange={(e) => setPosture(e.target.value as ParticipationPosture)}
            className={cn(
              'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'
            )}
          >
            <option value="direct_only">direct_only</option>
            <option value="rare_high_confidence">rare_high_confidence</option>
            <option value="active_participant">active_participant</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="follow">Follow-up window (ms)</Label>
          <select
            id="follow"
            aria-label="Follow-up window milliseconds"
            value={String(followUpWindowMs)}
            onChange={(e) => setFollowUpWindowMs(Number(e.target.value))}
            className={cn(
              'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'
            )}
          >
            <option value="60000">60s (60000)</option>
            <option value="120000">120s (120000)</option>
            <option value="180000">180s (180000)</option>
            <option value="300000">300s (300000)</option>
          </select>
        </div>
      </div>

      <InstructionStack rows={rows} />
      <div className="grid gap-4 lg:grid-cols-2">
        <RolePlaybook posture={posture} />
        <FollowUpPlaybook followUpWindowMs={followUpWindowMs} />
      </div>
    </div>
  );
}
