"use client"

import { useEffect, useState } from "react"
import { fetchPi } from "@/lib/api"
import type { OvernightReport, DreamFact, DreamInsight, TraceAnalysis, Retrospective } from "@/lib/types"
import { DiaryCard } from "@/components/overnight/diary-card"
import { DateSelector } from "@/components/overnight/date-selector"
import { TraceSummary } from "@/components/overnight/trace-summary"
import { RetrospectiveView, RetrospectiveEmpty } from "@/components/overnight/retrospective-view"
import { SoulView } from "@/components/overnight/soul-view"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

function yesterdayStr(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function SummaryBar({ report }: { report: OvernightReport }) {
  const skippedCount = report.groups.filter((g) => g.quality?.skipped).length
  const activeCount = report.groups.length - skippedCount
  const newFacts = report.groups.reduce(
    (acc, g) => acc + (g.quality?.facts_new ?? 0),
    0
  )
  const newInsights = report.groups.reduce(
    (acc, g) => acc + (g.quality?.insights_new ?? 0),
    0
  )

  const items: { label: string; value: number }[] = [
    { label: "active groups", value: activeCount },
    { label: "new facts", value: newFacts },
    { label: "new insights", value: newInsights },
    { label: "quiet groups", value: skippedCount },
  ]

  return (
    <div className="flex flex-wrap gap-4 text-sm">
      {items.map(({ label, value }) => (
        <div key={label} className="flex items-baseline gap-1">
          <span className="text-lg font-semibold tabular-nums">{value}</span>
          <span className="text-muted-foreground">{label}</span>
        </div>
      ))}
    </div>
  )
}

interface FactsInsightsListProps {
  groups: OvernightReport["groups"]
}

function FactsInsightsList({ groups }: FactsInsightsListProps) {
  type FactItem = DreamFact & { groupId: string; type: "fact" }
  type InsightItem = DreamInsight & { groupId: string; type: "insight" }
  type Item = FactItem | InsightItem

  const items: Item[] = []

  for (const g of groups) {
    for (const f of g.facts) {
      items.push({ ...f, groupId: g.group_id, type: "fact" })
    }
    for (const ins of g.insights) {
      items.push({ ...ins, groupId: g.group_id, type: "insight" })
    }
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No facts or insights for this date.
        </CardContent>
      </Card>
    )
  }

  function groupLabel(groupId: string): string {
    if (groupId === "owner" || !groupId.includes("@")) return "DM"
    return `Group ${groupId.slice(0, 8)}...`
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) => (
        <Card key={i} size="sm">
          <CardContent className="flex flex-col gap-1.5">
            <div className="flex items-start gap-2">
              {item.type === "fact" ? (
                <Badge className="bg-emerald-600 text-white hover:bg-emerald-600 shrink-0 mt-0.5">
                  fact
                </Badge>
              ) : (
                <Badge className="bg-blue-600 text-white hover:bg-blue-600 shrink-0 mt-0.5">
                  insight
                </Badge>
              )}
              <p className="text-sm leading-snug">
                {item.type === "fact" ? item.fact : item.insight}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {item.type === "fact" &&
                item.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              {item.type === "insight" &&
                item.topics.map((t) => (
                  <Badge key={t} variant="outline" className="text-xs">
                    {t}
                  </Badge>
                ))}
              {item.type === "fact" && (
                <span className="text-xs text-muted-foreground ml-auto">
                  {Math.round(item.confidence * 100)}% confidence
                </span>
              )}
              <span
                className={`text-xs text-muted-foreground ${item.type === "fact" ? "" : "ml-auto"}`}
              >
                {groupLabel(item.groupId)}
              </span>
            </div>

            {item.type === "insight" && item.evidence && item.evidence.length > 0 && (
              <div className="flex flex-col gap-0.5 pl-1 border-l-2 border-border mt-0.5">
                {item.evidence.map((e, j) => (
                  <p key={j} className="text-xs text-muted-foreground italic">
                    {e}
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export default function OvernightPage() {
  const [date, setDate] = useState<string>(yesterdayStr)
  const [report, setReport] = useState<OvernightReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Supplementary data — fetched once, not date-dependent
  const [traces, setTraces] = useState<TraceAnalysis | null>(null)
  const [retrospective, setRetrospective] = useState<Retrospective | null>(null)
  const [soul, setSoul] = useState<Record<string, unknown> | null>(null)

  // Fetch date-dependent overnight report
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setReport(null)

    fetchPi<OvernightReport>(`overnight-report/${date}`)
      .then((data) => {
        if (!cancelled) setReport(data)
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load report")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [date])

  // Fetch supplementary data once on mount
  useEffect(() => {
    Promise.allSettled([
      fetchPi<{ analysis: TraceAnalysis | null }>('traces'),
      fetchPi<{ retrospective: Retrospective | null }>('retrospective'),
      fetchPi<Record<string, unknown>>('soul'),
    ]).then(([tracesResult, retroResult, soulResult]) => {
      if (tracesResult.status === 'fulfilled') {
        setTraces(tracesResult.value.analysis)
      }
      if (retroResult.status === 'fulfilled') {
        setRetrospective(retroResult.value.retrospective)
      }
      if (soulResult.status === 'fulfilled') {
        setSoul(soulResult.value)
      }
    })
  }, [])

  const activeGroups = report?.groups.filter((g) => !g.quality?.skipped) ?? []
  const skippedGroups = report?.groups.filter((g) => g.quality?.skipped) ?? []

  // Collect soul observations from all groups
  const soulObservations = report?.groups.flatMap((g) => g.observations) ?? []

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Overnight Intelligence</h1>
        <DateSelector date={date} onDateChange={setDate} />
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      )}

      {/* Report */}
      {!loading && report && (
        <>
          <SummaryBar report={report} />

          <Tabs defaultValue="diaries">
            <TabsList>
              <TabsTrigger value="diaries">Diaries</TabsTrigger>
              <TabsTrigger value="facts">Facts &amp; Insights</TabsTrigger>
              <TabsTrigger value="traces">Trace Analysis</TabsTrigger>
              <TabsTrigger value="retrospective">Retrospective</TabsTrigger>
              <TabsTrigger value="soul">Soul</TabsTrigger>
            </TabsList>

            <TabsContent value="diaries" className="flex flex-col gap-3 mt-4">
              {activeGroups.length === 0 && skippedGroups.length === 0 && (
                <Card>
                  <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    No diary entries for this date.
                  </CardContent>
                </Card>
              )}

              {activeGroups.map((g) => (
                <DiaryCard key={g.group_id} group={g} />
              ))}

              {skippedGroups.length > 0 && (
                <div className="flex flex-col gap-2 mt-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">
                    Quiet Groups
                  </p>
                  {skippedGroups.map((g) => (
                    <DiaryCard key={g.group_id} group={g} />
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="facts" className="mt-4">
              <FactsInsightsList groups={report.groups} />
            </TabsContent>

            <TabsContent value="traces" className="mt-4">
              {traces ? (
                <TraceSummary analysis={traces} />
              ) : (
                <Card>
                  <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    No trace analysis available. Runs nightly at 3 AM.
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="retrospective" className="mt-4">
              {retrospective ? (
                <RetrospectiveView retrospective={retrospective} />
              ) : (
                <RetrospectiveEmpty />
              )}
            </TabsContent>

            <TabsContent value="soul" className="mt-4">
              <SoulView
                soul={soul ?? {}}
                observations={soulObservations}
              />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}
