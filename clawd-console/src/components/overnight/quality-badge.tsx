import { Badge } from "@/components/ui/badge"
import type { DreamQuality } from "@/lib/types"

interface QualityBadgeProps {
  quality?: DreamQuality
}

export function QualityBadge({ quality }: QualityBadgeProps) {
  if (!quality || quality.skipped) {
    return <Badge variant="outline">Skipped</Badge>
  }

  const totalFacts = quality.facts_new + quality.facts_skipped_dedup + quality.facts_superseded
  const newRatio = totalFacts > 0 ? quality.facts_new / totalFacts : 0

  const variant =
    newRatio > 0.7 ? "default" : newRatio >= 0.3 ? "secondary" : "destructive"

  return (
    <Badge variant={variant}>
      {quality.facts_new} new / {totalFacts} total
    </Badge>
  )
}
