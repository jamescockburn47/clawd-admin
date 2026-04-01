import { cn } from "@/lib/utils"

interface ConfidenceBarProps {
  value: number
  className?: string
}

export function ConfidenceBar({ value, className }: ConfidenceBarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  const colorClass =
    value > 0.8
      ? "bg-emerald-500"
      : value >= 0.5
        ? "bg-yellow-500"
        : "bg-red-500"

  return (
    <div
      className={cn("flex items-center gap-1.5", className)}
      title={`Confidence: ${pct}%`}
    >
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", colorClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  )
}
