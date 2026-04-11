'use client';

import type { ParticipationPosture } from '@/lib/types';
import { buildRolePlaybookLines } from '@/lib/participation/view-models';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function RolePlaybook({ posture }: { posture: ParticipationPosture }) {
  const lines = buildRolePlaybookLines(posture);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Role playbook</CardTitle>
        <p className="text-sm text-muted-foreground">
          How Clint should choose a contribution role for posture{' '}
          <span className="font-mono text-foreground">{posture}</span>.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="list-inside list-disc space-y-2 text-sm text-muted-foreground">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
