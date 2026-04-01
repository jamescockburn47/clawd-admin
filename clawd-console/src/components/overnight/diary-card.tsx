"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, Quote } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { QualityBadge } from "@/components/overnight/quality-badge"
import type { DreamGroup, DreamObservation } from "@/lib/types"
import { cn } from "@/lib/utils"

interface DiaryCardProps {
  group: DreamGroup
}

function groupLabel(groupId: string): string {
  if (groupId === "owner" || !groupId.includes("@")) return "DM"
  return `Group ${groupId.slice(0, 8)}...`
}

function severityVariant(
  severity: DreamObservation["severity"]
): "destructive" | "secondary" | "outline" {
  if (severity === "critical") return "destructive"
  if (severity === "corrective") return "secondary"
  return "outline"
}

export function DiaryCard({ group }: DiaryCardProps) {
  const [expanded, setExpanded] = useState(false)
  const isSkipped = group.quality?.skipped ?? false

  const hasVerbatim = group.verbatim.length > 0
  const hasSoulObs = group.observations.length > 0
  const hasWarnings = group.warnings.length > 0

  return (
    <Card className={cn(isSkipped && "opacity-60")}>
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}

        <span className="flex-1 flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm">{groupLabel(group.group_id)}</span>
          <span className="text-xs text-muted-foreground">
            {group.message_count} msg{group.message_count !== 1 ? "s" : ""}
          </span>
          <QualityBadge quality={group.quality} />
        </span>

        <span className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
          {group.facts.length > 0 && (
            <span>{group.facts.length} fact{group.facts.length !== 1 ? "s" : ""}</span>
          )}
          {group.insights.length > 0 && (
            <span>{group.insights.length} insight{group.insights.length !== 1 ? "s" : ""}</span>
          )}
        </span>
      </button>

      {/* Skipped: show one-liner only, no expansion */}
      {isSkipped && !expanded && (
        <CardContent className="pt-0 pb-3">
          <p className="text-sm text-muted-foreground italic">{group.diary}</p>
        </CardContent>
      )}

      {/* Expanded content */}
      {expanded && (
        <CardContent className="pt-0 flex flex-col gap-3">
          <Separator />

          {/* Diary narrative */}
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{group.diary}</p>

          {/* Validation warnings */}
          {hasWarnings && (
            <>
              <Separator />
              <div className="flex flex-col gap-1">
                {group.warnings.map((w, i) => (
                  <p key={i} className="text-xs italic text-yellow-500 dark:text-yellow-400">
                    {w}
                  </p>
                ))}
              </div>
            </>
          )}

          {/* Verbatim excerpts */}
          {hasVerbatim && (
            <>
              <Separator />
              <div className="flex flex-col gap-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Verbatim
                </p>
                {group.verbatim.map((v, i) => (
                  <blockquote
                    key={i}
                    className="border-l-2 border-border pl-3 flex flex-col gap-0.5"
                  >
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Quote className="size-3" />
                      <span>{v.speaker}</span>
                    </div>
                    <p className="text-sm italic">{v.quote}</p>
                    {v.context && (
                      <p className="text-xs text-muted-foreground">{v.context}</p>
                    )}
                  </blockquote>
                ))}
              </div>
            </>
          )}

          {/* Soul observations */}
          {hasSoulObs && (
            <>
              <Separator />
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Soul Observations
                </p>
                {group.observations.map((obs, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <Badge variant={severityVariant(obs.severity)} className="mt-0.5 shrink-0">
                      {obs.severity}
                    </Badge>
                    <p className="text-sm">{obs.text}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
