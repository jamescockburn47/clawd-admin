'use client'

import type { Retrospective } from '@/lib/types'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

interface Props {
  retrospective: Retrospective
}

const HEALTH_STYLES: Record<string, { banner: string; label: string }> = {
  good: { banner: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400', label: 'Good' },
  fair: { banner: 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400', label: 'Fair' },
  poor: { banner: 'bg-destructive/10 border-destructive/30 text-destructive', label: 'Poor' },
}

const SEVERITY_STYLES: Record<string, string> = {
  high: 'bg-destructive/10 text-destructive border-transparent',
  medium: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-transparent',
  low: 'bg-secondary text-secondary-foreground border-transparent',
}

export function RetrospectiveView({ retrospective }: Props) {
  const health = HEALTH_STYLES[retrospective.overallHealth] ?? HEALTH_STYLES.fair

  return (
    <div className="flex flex-col gap-4">
      {/* Health banner */}
      <Card size="sm" className={cn('border', health.banner)}>
        <CardContent className="pt-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wide">
              System Health
            </span>
            <Badge
              className={cn('text-xs', SEVERITY_STYLES[retrospective.overallHealth] ?? SEVERITY_STYLES.low)}
            >
              {health.label}
            </Badge>
          </div>
          <p className="text-sm">{retrospective.healthReason}</p>
        </CardContent>
      </Card>

      {/* Priorities */}
      {retrospective.priorities.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground px-1">
            Improvement Priorities
          </p>
          {retrospective.priorities.map((p) => (
            <Card key={p.rank} size="sm">
              <CardContent className="pt-3 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="text-xs tabular-nums text-muted-foreground mt-0.5 w-4 shrink-0">
                    {p.rank}.
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{p.title}</span>
                      <Badge className={cn('text-xs shrink-0', SEVERITY_STYLES[p.severity])}>
                        {p.severity}
                      </Badge>
                    </div>
                  </div>
                </div>

                <Separator />

                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs pl-6">
                  <span className="text-muted-foreground font-medium">Issue</span>
                  <span>{p.issue}</span>
                  <span className="text-muted-foreground font-medium">Fix</span>
                  <span>{p.fix}</span>
                  {p.impact && (
                    <>
                      <span className="text-muted-foreground font-medium">Impact</span>
                      <span>{p.impact}</span>
                    </>
                  )}
                </div>

                {p.files.length > 0 && (
                  <div className="flex flex-wrap gap-1 pl-6">
                    {p.files.map((f) => (
                      <Badge key={f} variant="outline" className="text-xs font-mono">
                        {f}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Evolution tasks created */}
      {retrospective.evolutionTasksCreated && retrospective.evolutionTasksCreated.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground px-1">
            Evolution Tasks Created
          </p>
          {retrospective.evolutionTasksCreated.map((t) => (
            <div key={t.taskId} className="flex items-center gap-2 text-xs px-1">
              <Badge variant="outline" className="font-mono text-xs">{t.taskId.slice(0, 8)}</Badge>
              <span className="text-muted-foreground">{t.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function RetrospectiveEmpty() {
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-sm text-muted-foreground">No retrospective yet.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Runs automatically every Sunday at 4 AM. Uses 7 days of trace data.
        </p>
      </CardContent>
    </Card>
  )
}
