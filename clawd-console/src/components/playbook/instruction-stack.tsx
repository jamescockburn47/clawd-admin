'use client';

import type { InstructionStackRow } from '@/lib/participation/view-models';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

function originLabel(origin: InstructionStackRow['origin']): string {
  switch (origin) {
    case 'inherited':
      return 'Inherited';
    case 'override':
      return 'Override';
    case 'computed':
      return 'Computed';
    default: {
      const _exhaustive: never = origin;
      return _exhaustive;
    }
  }
}

export function InstructionStack({ rows }: { rows: InstructionStackRow[] }) {
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <Card key={row.layer}>
          <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-base font-medium">{row.layer}</CardTitle>
            <Badge variant="secondary" className="shrink-0 text-[10px] uppercase">
              {originLabel(row.origin)}
            </Badge>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed text-muted-foreground">{row.summary}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
