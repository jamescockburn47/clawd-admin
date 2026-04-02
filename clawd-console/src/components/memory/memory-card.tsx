"use client"

import { useState } from "react"
import { PencilIcon, TrashIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfidenceBar } from "@/components/memory/confidence-bar"
import { cn } from "@/lib/utils"

export interface Memory {
  id: string
  fact: string
  category: string
  tags: string[]
  confidence: number
  source: string
  accessCount: number
  created: string
}

interface MemoryCardProps {
  memory: Memory
  onEdit: (memory: Memory) => void
  onDelete: (memory: Memory) => void
}

const CATEGORY_COLORS: Record<string, string> = {
  identity: "bg-purple-600 text-white hover:bg-purple-600",
  person: "bg-blue-600 text-white hover:bg-blue-600",
  general: "bg-zinc-500 text-white hover:bg-zinc-500",
  insight: "bg-amber-500 text-white hover:bg-amber-500",
  diary: "bg-indigo-600 text-white hover:bg-indigo-600",
  dream: "bg-violet-600 text-white hover:bg-violet-600",
  system: "bg-slate-500 text-white hover:bg-slate-500",
  preference: "bg-green-600 text-white hover:bg-green-600",
  legal: "bg-red-600 text-white hover:bg-red-600",
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

export function MemoryCard({ memory, onEdit, onDelete }: MemoryCardProps) {
  const [expanded, setExpanded] = useState(false)

  const badgeClass = CATEGORY_COLORS[memory.category] ?? "bg-zinc-500 text-white hover:bg-zinc-500"

  return (
    <Card
      size="sm"
      className="cursor-pointer transition-shadow hover:shadow-md"
      onClick={() => setExpanded((v) => !v)}
    >
      <CardContent className="flex flex-col gap-2">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <Badge className={cn("shrink-0", badgeClass)}>
            {memory.category}
          </Badge>
          <button
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <span className="flex items-center gap-1"><ChevronUpIcon className="size-3.5" /> Less</span>
            ) : (
              <span className="flex items-center gap-1"><ChevronDownIcon className="size-3.5" /> More</span>
            )}
          </button>
        </div>

        {/* Fact text */}
        <p
          className={cn(
            "text-sm leading-snug",
            !expanded && "line-clamp-6"
          )}
        >
          {memory.fact}
        </p>

        {/* Confidence + meta */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ConfidenceBar value={memory.confidence} />
          {memory.tags.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {memory.tags.join(", ")}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>{memory.source}</span>
          <span>{timeAgo(memory.created)}</span>
          {memory.accessCount > 0 && (
            <span>{memory.accessCount} accesses</span>
          )}
        </div>

        {/* Actions — only shown when expanded */}
        {expanded && (
          <div
            className="flex gap-2 pt-1"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => onEdit(memory)}
            >
              <PencilIcon className="size-3.5" />
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs text-destructive hover:text-destructive"
              onClick={() => onDelete(memory)}
            >
              <TrashIcon className="size-3.5" />
              Delete
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
