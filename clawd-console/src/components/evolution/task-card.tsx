"use client"

import { useState } from "react"
import type { EvolutionTask } from "@/lib/types"
import { postPi } from "@/lib/api"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { DiffViewer } from "@/components/evolution/diff-viewer"
import { ChevronDown, ChevronRight } from "lucide-react"

interface TaskCardProps {
  task: EvolutionTask
  onApprove: (taskId: string) => void
  onReject: (taskId: string) => void
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function elapsedTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  const secs = Math.floor((diff % 60000) / 1000)
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

function sourceBadgeVariant(source: string): "default" | "secondary" | "outline" {
  if (source === "dream") return "secondary"
  if (source === "retrospective") return "default"
  return "outline"
}

export function TaskCard({ task, onApprove, onReject }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState<"approve" | "reject" | null>(null)

  async function handleApprove() {
    setLoading("approve")
    try {
      await postPi("evolution/approve", { taskId: task.id })
      onApprove(task.id)
    } catch (err) {
      console.error("[task-card] approve failed", err)
    } finally {
      setLoading(null)
    }
  }

  async function handleReject() {
    setLoading("reject")
    try {
      await postPi("evolution/reject", { taskId: task.id })
      onReject(task.id)
    } catch (err) {
      console.error("[task-card] reject failed", err)
    } finally {
      setLoading(null)
    }
  }

  if (task.status === "awaiting_approval") {
    return (
      <Card className="border-yellow-500/40 bg-yellow-500/5">
        <CardHeader className="pb-2 pt-3 px-4">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-start gap-2 text-left"
          >
            <span className="mt-0.5 text-muted-foreground">
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-snug">{task.instruction}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge variant={sourceBadgeVariant(task.source)} className="text-[10px]">
                  {task.source}
                </Badge>
                <span className="text-xs text-muted-foreground">{relativeTime(task.created)}</span>
                {task.branch && (
                  <span className="font-mono text-[10px] text-muted-foreground">{task.branch}</span>
                )}
              </div>
            </div>
          </button>
        </CardHeader>

        {expanded && (
          <CardContent className="px-4 pb-4 pt-0 space-y-3">
            <Separator />

            {task.manifest && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Manifest
                </p>
                {task.manifest.approach && (
                  <p className="text-sm">{task.manifest.approach}</p>
                )}
                {task.manifest.files_to_modify && task.manifest.files_to_modify.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Files</p>
                    <ul className="space-y-0.5">
                      {task.manifest.files_to_modify.map((f) => (
                        <li key={f} className="font-mono text-[11px] text-foreground/80">
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {task.manifest.estimated_lines_changed != null && (
                  <p className="text-xs text-muted-foreground">
                    ~{task.manifest.estimated_lines_changed} lines changed
                  </p>
                )}
                {task.manifest.risks && (
                  <div className="rounded bg-yellow-500/10 px-3 py-2">
                    <p className="text-xs font-medium text-yellow-400">Risks</p>
                    <p className="text-xs text-foreground/80 mt-0.5">{task.manifest.risks}</p>
                  </div>
                )}
              </div>
            )}

            {task.diff_detail && (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Diff
                </p>
                <DiffViewer diff={task.diff_detail} />
              </div>
            )}

            {!task.diff_detail && task.diff_summary && (
              <p className="text-xs text-muted-foreground">{task.diff_summary}</p>
            )}

            <div className="flex gap-2 pt-1">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    disabled={loading !== null}
                  >
                    {loading === "approve" ? "Approving…" : "Approve"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Approve this evolution task?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will deploy the changes in branch{" "}
                      <span className="font-mono">{task.branch}</span> to the live bot.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-emerald-600 hover:bg-emerald-700"
                      onClick={handleApprove}
                    >
                      Approve &amp; Deploy
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={loading !== null}
                  >
                    {loading === "reject" ? "Rejecting…" : "Reject"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Reject this evolution task?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The branch <span className="font-mono">{task.branch}</span> will be discarded.
                      This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive hover:bg-destructive/90"
                      onClick={handleReject}
                    >
                      Reject
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        )}
      </Card>
    )
  }

  // Compact card for all other statuses
  const borderClass: Record<EvolutionTask["status"], string> = {
    pending: "border-border",
    running: "border-l-4 border-l-blue-500",
    awaiting_approval: "border-l-4 border-l-yellow-500",
    approved: "border-l-4 border-l-emerald-500",
    deployed: "border-l-4 border-l-emerald-600",
    failed: "border-l-4 border-l-red-500",
    rejected: "border-border opacity-50",
  }

  return (
    <Card className={borderClass[task.status]}>
      <CardContent className="px-4 py-3 space-y-1">
        <p
          className={`text-sm leading-snug ${
            task.status === "rejected" ? "line-through text-muted-foreground" : ""
          }`}
        >
          {task.instruction}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={sourceBadgeVariant(task.source)} className="text-[10px]">
            {task.source}
          </Badge>
          <span className="text-xs text-muted-foreground">{relativeTime(task.created)}</span>
          {task.status === "running" && (
            <span className="text-xs text-blue-400">running {elapsedTime(task.created)}</span>
          )}
          {task.status === "deployed" && task.files_changed.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {task.files_changed.length} file{task.files_changed.length !== 1 ? "s" : ""}
              {task.total_lines != null ? `, ${task.total_lines} lines` : ""}
            </span>
          )}
          {task.status === "failed" && task.result && (
            <span className="text-xs text-red-400 truncate max-w-[200px]" title={task.result}>
              {task.result}
            </span>
          )}
        </div>
        {task.branch && (
          <p className="font-mono text-[10px] text-muted-foreground">{task.branch}</p>
        )}
      </CardContent>
    </Card>
  )
}
