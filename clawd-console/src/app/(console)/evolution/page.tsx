"use client"

import { useEffect, useState, useCallback } from "react"
import { fetchPi } from "@/lib/api"
import type { EvolutionTask, EvolutionListResponse } from "@/lib/types"
import { TaskCard } from "@/components/evolution/task-card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

type Status = EvolutionTask["status"]

const COLUMNS: { status: Status; label: string; accent: string }[] = [
  { status: "pending", label: "Pending", accent: "text-muted-foreground" },
  { status: "running", label: "Running", accent: "text-blue-400" },
  { status: "awaiting_approval", label: "Awaiting Approval", accent: "text-yellow-400" },
  { status: "deployed", label: "Deployed", accent: "text-emerald-400" },
  { status: "failed", label: "Failed", accent: "text-red-400" },
  { status: "rejected", label: "Rejected", accent: "text-muted-foreground" },
]

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function statusBadgeClass(status: Status): string {
  switch (status) {
    case "pending": return "bg-zinc-700 text-zinc-200"
    case "running": return "bg-blue-900 text-blue-200"
    case "awaiting_approval": return "bg-yellow-900 text-yellow-200"
    case "approved": return "bg-emerald-900 text-emerald-200"
    case "deployed": return "bg-emerald-800 text-emerald-100"
    case "failed": return "bg-red-900 text-red-200"
    case "rejected": return "bg-zinc-800 text-zinc-400"
    default: return ""
  }
}

export default function EvolutionPage() {
  const [data, setData] = useState<EvolutionListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetchPi<EvolutionListResponse>("evolution/list")
      setData(res)
      setError(null)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function handleApprove(taskId: string) {
    setData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        tasks: prev.tasks.map((t) =>
          t.id === taskId ? { ...t, status: "approved" as Status } : t
        ),
      }
    })
  }

  function handleReject(taskId: string) {
    setData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        tasks: prev.tasks.map((t) =>
          t.id === taskId ? { ...t, status: "rejected" as Status } : t
        ),
      }
    })
  }

  const tasks = data?.tasks ?? []
  const report = data?.report

  const byStatus = (status: Status) => tasks.filter((t) => t.status === status)

  const sortedAll = [...tasks].sort(
    (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime()
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">Evolution Pipeline</h2>
          <p className="text-sm text-muted-foreground">
            Clawd&apos;s self-coding tasks — review and approve changes
          </p>
        </div>
        {report && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Today</span>
            <Badge
              className={
                report.rateLimit.allowed
                  ? "bg-emerald-900 text-emerald-200"
                  : "bg-red-900 text-red-200"
              }
            >
              {report.rateLimit.todayCount ?? report.rateLimit.used ?? 0}/{report.rateLimit.dailyMax ?? report.rateLimit.max ?? 3}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {report.rateLimit.allowed ? "allowed" : "blocked"}
            </span>
          </div>
        )}
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {COLUMNS.map((col) => (
            <div key={col.status} className="w-64 flex-shrink-0 space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-md bg-red-950 px-4 py-3 text-sm text-red-300">
          Failed to load evolution data: {error}
        </div>
      )}

      {/* Kanban */}
      {!loading && !error && (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {COLUMNS.map((col) => {
            const colTasks = byStatus(col.status)
            return (
              <div key={col.status} className="w-72 flex-shrink-0">
                <div className="mb-2 flex items-center gap-2">
                  <span className={`text-sm font-medium ${col.accent}`}>{col.label}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    {colTasks.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {colTasks.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-1">None</p>
                  ) : (
                    colTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onApprove={handleApprove}
                        onReject={handleReject}
                      />
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* History table */}
      {!loading && !error && sortedAll.length > 0 && (
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">History</h3>
            <p className="text-xs text-muted-foreground">All tasks, most recent first</p>
          </div>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">
                    Created
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">
                    Instruction
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">
                    Source
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">
                    Branch
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">
                    Lines
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedAll.map((task, i) => (
                  <tr
                    key={task.id}
                    className={i % 2 === 0 ? "bg-background" : "bg-muted/20"}
                  >
                    <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(task.created)}
                    </td>
                    <td className="px-4 py-2 max-w-xs">
                      <span
                        className="block truncate text-xs"
                        title={task.instruction}
                      >
                        {task.instruction}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className="text-xs text-muted-foreground">{task.source}</span>
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusBadgeClass(task.status)}`}
                      >
                        {task.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {task.branch || "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {task.total_lines ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
