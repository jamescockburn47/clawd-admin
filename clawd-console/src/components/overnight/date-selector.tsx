"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"

interface DateSelectorProps {
  date: string
  onDateChange: (date: string) => void
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z")
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

export function DateSelector({ date, onDateChange }: DateSelectorProps) {
  const isToday = date >= todayStr()

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous day"
        onClick={() => onDateChange(addDays(date, -1))}
      >
        <ChevronLeft />
      </Button>

      <span className="min-w-36 text-center text-sm font-medium">
        {formatDate(date)}
      </span>

      <Button
        variant="ghost"
        size="icon"
        aria-label="Next day"
        disabled={isToday}
        onClick={() => onDateChange(addDays(date, 1))}
      >
        <ChevronRight />
      </Button>
    </div>
  )
}
