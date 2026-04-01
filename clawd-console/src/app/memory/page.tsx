"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { PlusIcon, SearchIcon } from "lucide-react"
import { fetchEvo, postEvo } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent } from "@/components/ui/card"
import { MemoryCard, type Memory } from "@/components/memory/memory-card"
import { MemoryEditor } from "@/components/memory/memory-editor"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

// API response shapes
interface ListResponse {
  memories: Memory[]
}

interface SearchResult {
  memory: Memory
  score: number
}

interface SearchResponse {
  results: SearchResult[]
}

// ---- helpers ----

function buildCategoryCounts(memories: Memory[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const m of memories) {
    counts[m.category] = (counts[m.category] ?? 0) + 1
  }
  return counts
}

// ---- sub-components ----

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full rounded-xl" />
      ))}
    </div>
  )
}

// ---- page ----

export default function MemoryPage() {
  const [allMemories, setAllMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  const [query, setQuery] = useState("")
  const [activeCategory, setActiveCategory] = useState<string>("all")

  const [editorOpen, setEditorOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Memory | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  // Load all memories on mount
  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchEvo<ListResponse>("memory/list?include_embeddings=false")
      .then((data) => setAllMemories(data.memories ?? []))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load memories")
      )
      .finally(() => setLoading(false))
  }, [])

  // Search handler
  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      // Reset to full list
      setSearching(true)
      setError(null)
      fetchEvo<ListResponse>("memory/list?include_embeddings=false")
        .then((data) => setAllMemories(data.memories ?? []))
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : "Failed to load memories")
        )
        .finally(() => setSearching(false))
      return
    }

    setSearching(true)
    setError(null)
    try {
      const data = await postEvo<SearchResponse>("memory/search", {
        query: query.trim(),
        limit: 100,
      })
      setAllMemories(data.results.map((r) => r.memory))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed")
    } finally {
      setSearching(false)
    }
  }, [query])

  // Search on Enter
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSearch()
  }

  // Category counts from current results
  const categoryCounts = useMemo(
    () => buildCategoryCounts(allMemories),
    [allMemories]
  )

  const sortedCategories = useMemo(
    () =>
      Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([cat]) => cat),
    [categoryCounts]
  )

  // Filtered view
  const filtered = useMemo(
    () =>
      activeCategory === "all"
        ? allMemories
        : allMemories.filter((m) => m.category === activeCategory),
    [allMemories, activeCategory]
  )

  // Edit handler
  function openEdit(memory: Memory) {
    setEditTarget(memory)
    setEditorOpen(true)
  }

  function openNew() {
    setEditTarget(null)
    setEditorOpen(true)
  }

  // Save (create or update)
  async function handleSave(data: {
    id?: string
    fact: string
    category: string
    tags: string[]
    confidence: number
    source?: string
  }) {
    if (data.id) {
      // Update
      type PutResponse = { memory?: Memory; [k: string]: unknown }
      const res = await fetchEvo<PutResponse>(`memory/${data.id}`, {
        method: "PUT",
        body: JSON.stringify({
          fact: data.fact,
          category: data.category,
          tags: data.tags,
          confidence: data.confidence,
        }),
        headers: { "Content-Type": "application/json" },
      })
      const updated: Memory = (res.memory as Memory | undefined) ?? {
        ...allMemories.find((m) => m.id === data.id)!,
        fact: data.fact,
        category: data.category,
        tags: data.tags,
        confidence: data.confidence,
      }
      setAllMemories((prev) =>
        prev.map((m) => (m.id === data.id ? updated : m))
      )
    } else {
      // Store new
      type StoreResponse = { memory?: Memory; id?: string; [k: string]: unknown }
      const res = await postEvo<StoreResponse>("memory/store", {
        fact: data.fact,
        category: data.category,
        tags: data.tags,
        confidence: data.confidence,
        source: data.source ?? "console",
      })
      const stored: Memory = (res.memory as Memory | undefined) ?? {
        id: (res.id as string | undefined) ?? String(Date.now()),
        fact: data.fact,
        category: data.category,
        tags: data.tags,
        confidence: data.confidence,
        source: data.source ?? "console",
        accessCount: 0,
        created: new Date().toISOString(),
      }
      setAllMemories((prev) => [stored, ...prev])
    }
  }

  // Delete flow
  function openDelete(memory: Memory) {
    setDeleteTarget(memory)
    setDeleteDialogOpen(true)
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    await fetchEvo(`memory/${deleteTarget.id}`, { method: "DELETE" })
    setAllMemories((prev) => prev.filter((m) => m.id !== deleteTarget.id))
    setDeleteDialogOpen(false)
    setDeleteTarget(null)
  }

  const isLoading = loading || searching

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Memory Browser</h1>
        <Button size="sm" className="gap-1.5" onClick={openNew}>
          <PlusIcon className="size-3.5" />
          New Memory
        </Button>
      </div>

      {/* Search bar */}
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search memories..."
          className="max-w-md"
        />
        <Button
          variant="outline"
          size="default"
          onClick={handleSearch}
          disabled={isLoading}
          className="gap-1.5"
        >
          <SearchIcon className="size-3.5" />
          Search
        </Button>
      </div>

      <div className="flex gap-6">
        {/* Category sidebar */}
        <aside className="w-44 shrink-0">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Category
          </p>
          <ul className="flex flex-col gap-0.5">
            <li>
              <button
                onClick={() => setActiveCategory("all")}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${
                  activeCategory === "all"
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground"
                }`}
              >
                <span>All</span>
                <span className="tabular-nums text-xs">{allMemories.length}</span>
              </button>
            </li>
            {sortedCategories.map((cat) => (
              <li key={cat}>
                <button
                  onClick={() => setActiveCategory(cat)}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${
                    activeCategory === cat
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground"
                  }`}
                >
                  <span className="truncate">{cat}</span>
                  <span className="tabular-nums text-xs">{categoryCounts[cat]}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* Results area */}
        <div className="flex flex-1 flex-col gap-3">
          {/* Count */}
          {!loading && (
            <p className="text-xs text-muted-foreground">
              Showing {filtered.length} of {allMemories.length} memories
            </p>
          )}

          {/* Error */}
          {error && (
            <Card>
              <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
            </Card>
          )}

          {/* Loading */}
          {isLoading && <SkeletonGrid />}

          {/* Empty */}
          {!isLoading && !error && filtered.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No memories found.
              </CardContent>
            </Card>
          )}

          {/* Grid */}
          {!isLoading && filtered.length > 0 && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {filtered.map((m) => (
                <MemoryCard
                  key={m.id}
                  memory={m}
                  onEdit={openEdit}
                  onDelete={openDelete}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Editor sheet */}
      <MemoryEditor
        memory={editTarget}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        onSave={handleSave}
      />

      {/* Delete confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete memory?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `"${deleteTarget.fact.slice(0, 80)}${deleteTarget.fact.length > 80 ? "..." : ""}"`
                : "This memory will be permanently removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
