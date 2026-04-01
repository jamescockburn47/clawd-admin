"use client"

import { useEffect, useState } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { Memory } from "@/components/memory/memory-card"

const CATEGORIES = [
  "identity",
  "person",
  "general",
  "insight",
  "diary",
  "dream",
  "system",
  "preference",
  "legal",
  "schedule",
  "travel",
  "document",
  "document_chunk",
  "document_index",
]

interface MemoryEditorProps {
  memory: Memory | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (data: {
    id?: string
    fact: string
    category: string
    tags: string[]
    confidence: number
    source?: string
  }) => Promise<void>
}

export function MemoryEditor({ memory, open, onOpenChange, onSave }: MemoryEditorProps) {
  const [fact, setFact] = useState("")
  const [category, setCategory] = useState("general")
  const [tagsRaw, setTagsRaw] = useState("")
  const [confidence, setConfidence] = useState(0.9)
  const [source, setSource] = useState("console")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setFact(memory?.fact ?? "")
      setCategory(memory?.category ?? "general")
      setTagsRaw(memory?.tags?.join(", ") ?? "")
      setConfidence(memory?.confidence ?? 0.9)
      setSource(memory?.source ?? "console")
      setError(null)
    }
  }, [open, memory])

  async function handleSave() {
    if (!fact.trim()) {
      setError("Fact text is required.")
      return
    }
    const tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)

    setSaving(true)
    setError(null)
    try {
      await onSave({
        id: memory?.id,
        fact: fact.trim(),
        category,
        tags,
        confidence,
        source,
      })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.")
    } finally {
      setSaving(false)
    }
  }

  const isNew = memory === null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{isNew ? "New Memory" : "Edit Memory"}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 py-2 flex-1">
          {/* Fact */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fact">Fact</Label>
            <Textarea
              id="fact"
              value={fact}
              onChange={(e) => setFact(e.target.value)}
              placeholder="Enter the memory fact..."
              rows={5}
              className="resize-none"
            />
          </div>

          {/* Category */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category">Category</Label>
            <select
              id="category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c} className="bg-popover text-popover-foreground">
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Tags */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tags">Tags</Label>
            <Input
              id="tags"
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder="comma, separated, tags"
            />
          </div>

          {/* Confidence */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confidence">
              Confidence{" "}
              <span className="font-mono text-muted-foreground">
                {confidence.toFixed(2)}
              </span>
            </Label>
            <input
              id="confidence"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={confidence}
              onChange={(e) => setConfidence(parseFloat(e.target.value))}
              className="w-full accent-primary"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0.00</span>
              <span>0.50</span>
              <span>1.00</span>
            </div>
          </div>

          {/* Source (only for new) */}
          {isNew && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="source">Source</Label>
              <Input
                id="source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="e.g. console, dream, conversation"
              />
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <SheetFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : isNew ? "Store" : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
