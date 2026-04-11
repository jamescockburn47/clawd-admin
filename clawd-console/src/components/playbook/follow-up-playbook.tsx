'use client';

import { buildFollowUpPlaybookLines } from '@/lib/participation/view-models';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function FollowUpPlaybook({ followUpWindowMs }: { followUpWindowMs: number }) {
  const lines = buildFollowUpPlaybookLines(followUpWindowMs);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Follow-up playbook</CardTitle>
        <p className="text-sm text-muted-foreground">
          Bounded thread behaviour after direct engagement (rolling window).
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
