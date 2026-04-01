'use client'

import type { DreamObservation } from '@/lib/types'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

interface Props {
  soul: Record<string, unknown>
  observations?: DreamObservation[]
}

const OBS_SEVERITY_STYLES: Record<string, string> = {
  routine: 'bg-secondary text-secondary-foreground border-transparent',
  corrective: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-transparent',
  critical: 'bg-destructive/10 text-destructive border-transparent',
}

function renderValue(val: unknown): React.ReactNode {
  if (val === null || val === undefined) return <span className="text-muted-foreground italic">null</span>
  if (typeof val === 'boolean') return <span className={val ? 'text-emerald-600' : 'text-muted-foreground'}>{String(val)}</span>
  if (typeof val === 'number') return <span className="tabular-nums">{String(val)}</span>
  if (typeof val === 'string') return <span>{val}</span>
  if (Array.isArray(val)) {
    if (val.length === 0) return <span className="text-muted-foreground italic">[]</span>
    return (
      <div className="flex flex-wrap gap-1 mt-0.5">
        {val.map((item, i) => (
          <Badge key={i} variant="outline" className="text-xs">
            {String(item)}
          </Badge>
        ))}
      </div>
    )
  }
  if (typeof val === 'object') {
    return (
      <div className="pl-2 border-l-2 border-border mt-0.5 flex flex-col gap-1">
        {Object.entries(val as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 text-xs">
            <span className="text-muted-foreground truncate">{k}</span>
            <span className="break-words">{renderValue(v)}</span>
          </div>
        ))}
      </div>
    )
  }
  return <span>{String(val)}</span>
}

export function SoulView({ soul, observations }: Props) {
  const entries = Object.entries(soul)
  const soulObservations = observations?.filter(
    (o) => o.section === 'soul' || o.section === 'personality'
  ) ?? []

  return (
    <div className="flex flex-col gap-4">
      {/* Personality config */}
      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No soul configuration loaded.
          </CardContent>
        </Card>
      ) : (
        <Card size="sm">
          <CardContent className="pt-3 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
              Personality Config
            </p>
            {entries.map(([key, val], i) => (
              <div key={key}>
                {i > 0 && <Separator className="my-2" />}
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-0.5">
                  <span className="text-xs font-medium text-foreground/70 pt-0.5">{key}</span>
                  <span className="text-xs break-words">{renderValue(val)}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Soul observations from overnight report */}
      {soulObservations.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground px-1">
            Overnight Observations
          </p>
          {soulObservations.map((obs, i) => (
            <Card key={i} size="sm">
              <CardContent className="pt-3 flex flex-col gap-1.5">
                <div className="flex items-start gap-2">
                  <Badge
                    className={cn(
                      'text-xs shrink-0 mt-0.5',
                      OBS_SEVERITY_STYLES[obs.severity] ?? OBS_SEVERITY_STYLES.routine
                    )}
                  >
                    {obs.severity}
                  </Badge>
                  <p className="text-sm leading-snug">{obs.text}</p>
                </div>
                {obs.section && (
                  <span className="text-xs text-muted-foreground ml-auto">{obs.section}</span>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {soulObservations.length === 0 && entries.length > 0 && (
        <p className="text-xs text-muted-foreground px-1">
          No soul observations in last overnight report.
        </p>
      )}
    </div>
  )
}
