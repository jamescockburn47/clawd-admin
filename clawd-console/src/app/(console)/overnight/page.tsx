"use client"

import { useEffect, useState } from "react"
import { fetchPi } from "@/lib/api"
import type {
  MorningObservation,
  MorningReport,
  MorningReportResponse,
  OvernightEvent,
  OvernightEventsResponse,
  ShadowCandidate,
  TraceAnalysis,
} from "@/lib/types"
import { DateSelector } from "@/components/overnight/date-selector"
import { TraceSummary } from "@/components/overnight/trace-summary"
import { SoulView } from "@/components/overnight/soul-view"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { filterParticipationLearningEvents } from "@/lib/participation/view-models"

function yesterdayStr(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function SummaryBar({ report }: { report: MorningReport }) {
  const items: { label: string; value: number | string }[] = [
    { label: "mode", value: report.mode },
    { label: "errors", value: report.errors.length },
    { label: "memory candidates", value: report.summary.memoryStored },
    { label: "patterns", value: report.summary.patternsObserved },
    { label: "candidates", value: report.summary.candidatesProposed },
    { label: "drift alerts", value: report.summary.driftAlertsThisWeek },
  ]

  const p = report.participationSummary

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4 text-sm">
        {items.map(({ label, value }) => (
          <div key={label} className="flex items-baseline gap-1">
            <span className="text-lg font-semibold tabular-nums">{value}</span>
            <span className="text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
      {p && (
        <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
            Participation learning (UTC day, decision log)
          </p>
          <p className="text-muted-foreground leading-relaxed">
            Reviewed {p.reviewed}; accepted {p.accepted}. Overstayed (explicit): {p.overstayed}.
            Missed openings (proxy, model/heuristic gate): {p.missedOpenings}.
          </p>
        </div>
      )}
    </div>
  )
}

function renderObservationTitle(item: MorningObservation): string {
  switch (item.kind) {
    case "pattern":
      return item.observation
    case "candidate":
      return item.title
    case "drift":
      return item.diff_summary
    case "quality_failure":
      return item.rejection_reason
  }
}

function renderObservationMeta(item: MorningObservation): string[] {
  switch (item.kind) {
    case "pattern":
      return [`weight ${item.weight.toFixed(2)}`]
    case "candidate":
      return [item.category, item.scope, item.rough_cost, item.predicted_benefit]
    case "drift":
      return [item.judged, item.reason]
    case "quality_failure":
      return [
        item.category,
        item.cortex_summary ?? "no cortex summary",
        item.tools_fired?.length ? `tools: ${item.tools_fired.join(", ")}` : "no tools fired",
      ]
  }
}

function ObservationList({
  title,
  items,
  emptyLabel,
}: {
  title: string
  items: MorningObservation[]
  emptyLabel: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground px-1">
        {title}
      </p>
      {items.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            {emptyLabel}
          </CardContent>
        </Card>
      ) : (
        items.map((item, i) => (
          <Card key={`${item.kind}-${item.date}-${i}`} size="sm">
            <CardContent className="flex flex-col gap-1.5">
              <div className="flex items-start gap-2 flex-wrap">
                <Badge variant="outline" className="shrink-0">
                  {item.kind}
                </Badge>
                <span className="text-sm font-medium">{renderObservationTitle(item)}</span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {item.date}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {renderObservationMeta(item).map((meta, idx) => (
                  <Badge key={idx} variant="secondary" className="text-xs">
                    {meta}
                  </Badge>
                ))}
              </div>
              {item.evidence_refs.length > 0 && (
                <div className="flex flex-col gap-0.5 pl-1 border-l-2 border-border mt-0.5">
                  {item.evidence_refs.map((ref, idx) => (
                    <p key={idx} className="text-xs text-muted-foreground italic">
                      {ref}
                    </p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}

function ParticipationLearningCard({
  eventLog,
  loading,
  error,
}: {
  eventLog: OvernightEvent[] | null
  loading: boolean
  error: string | null
}) {
  const rows = eventLog ? filterParticipationLearningEvents(eventLog) : []

  return (
    <Card>
      <CardContent className="pt-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Participation learning
        </p>
        <p className="mb-3 text-xs text-muted-foreground leading-relaxed">
          Overnight events whose inputs or phases mention group participation, ambient speech, or
          follow-up tuning. Full log remains under Events.
        </p>
        {loading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {!loading && error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        {!loading && !error && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No participation-tagged overnight signals for this date.
          </p>
        )}
        {!loading &&
          !error &&
          rows.map((e) => (
            <Card key={e.id} size="sm" className="mt-2 border-border/80">
              <CardContent className="flex flex-col gap-1.5 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{e.stage}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(e.timestamp).toLocaleTimeString("en-GB", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <p className="text-sm font-medium leading-snug">{e.phase}</p>
                <p className="text-xs text-muted-foreground leading-snug">{e.reason}</p>
              </CardContent>
            </Card>
          ))}
      </CardContent>
    </Card>
  )
}

function MorningReportSummary({ data }: { data: MorningReportResponse }) {
  const { report, text } = data

  return (
    <div className="flex flex-col gap-4">
      <SummaryBar report={report} />

      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{report.date}</Badge>
            <Badge variant="outline">{report.budget.opus_sessions_used} opus sessions</Badge>
            <Badge variant="outline">{report.budget.tokens_used} tokens</Badge>
            <Badge variant={report.summary.backupOk ? "secondary" : "outline"}>
              backup {report.summary.backupOk ? "ok" : "missing"}
            </Badge>
            <Badge variant={report.summary.traceAnalysisOk ? "secondary" : "outline"}>
              trace analysis {report.summary.traceAnalysisOk ? "ok" : "missing"}
            </Badge>
          </div>
          <pre className="mt-4 whitespace-pre-wrap text-sm leading-6 font-sans">
            {text}
          </pre>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <ObservationList
          title="New This Week"
          items={report.newThisWeek}
          emptyLabel="No fresh observations for this section."
        />
        <ObservationList
          title="Continuing"
          items={report.continuingWithFreshEvidence}
          emptyLabel="No continuing observations with fresh evidence."
        />
        <ObservationList
          title="Drift Alerts"
          items={report.driftAlerts}
          emptyLabel="No drift alerts this week."
        />
        <ObservationList
          title="Deferred Candidates"
          items={report.deferredCandidates}
          emptyLabel="No deferred candidates."
        />
      </div>

      <ObservationList
        title="Archive"
        items={report.archive}
        emptyLabel="Archive section is empty."
      />
    </div>
  )
}

export default function OvernightPage() {
  const [date, setDate] = useState<string>(yesterdayStr)
  const [reportData, setReportData] = useState<MorningReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [traces, setTraces] = useState<TraceAnalysis | null>(null)
  const [soul, setSoul] = useState<Record<string, unknown> | null>(null)

  const [eventLog, setEventLog] = useState<OvernightEvent[] | null>(null)
  const [shadowCandidates, setShadowCandidates] = useState<ShadowCandidate[] | null>(null)
  const [eventsLoading, setEventsLoading] = useState(true)
  const [eventsError, setEventsError] = useState<string | null>(null)

  function handleDateChange(nextDate: string) {
    if (nextDate === date) return
    setDate(nextDate)
    setLoading(true)
    setError(null)
    setReportData(null)
    setEventsLoading(true)
    setEventsError(null)
    setEventLog(null)
    setShadowCandidates(null)
  }

  useEffect(() => {
    let cancelled = false

    fetchPi<MorningReportResponse>(`morning-report/${date}`)
      .then((data) => {
        if (!cancelled) setReportData(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load morning report"
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [date])

  useEffect(() => {
    let cancelled = false

    fetchPi<OvernightEventsResponse>(`overnight-events/${date}`)
      .then((data) => {
        if (!cancelled) {
          setEventLog(data.events ?? [])
          setShadowCandidates(data.shadowCandidates ?? [])
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEventsError(
            err instanceof Error ? err.message : "Failed to load overnight events"
          )
        }
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [date])

  useEffect(() => {
    Promise.allSettled([
      fetchPi<{ analysis: TraceAnalysis | null }>("traces"),
      fetchPi<Record<string, unknown>>("soul"),
    ]).then(([tracesResult, soulResult]) => {
      if (tracesResult.status === "fulfilled") {
        setTraces(tracesResult.value.analysis)
      }
      if (soulResult.status === "fulfilled") {
        setSoul(soulResult.value)
      }
    })
  }, [])

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Overnight Intelligence</h1>
        <DateSelector date={date} onDateChange={handleDateChange} />
      </div>

      {loading && !reportData && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {!loading && error && !reportData && (
        <Card>
          <CardContent className="py-4 text-xs text-muted-foreground">
            Morning report unavailable for {date}: {error}. Event log and shadow
            candidates below are fetched independently and may still load.
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="summary">
        <TabsList>
          <TabsTrigger value="summary">Morning Report</TabsTrigger>
          <TabsTrigger value="events">
            Events{eventLog ? ` (${eventLog.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="shadow">
            Shadow{shadowCandidates ? ` (${shadowCandidates.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="traces">Trace Analysis</TabsTrigger>
          <TabsTrigger value="soul">Soul</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="mt-4 flex flex-col gap-4">
          <ParticipationLearningCard
            eventLog={eventLog}
            loading={eventsLoading}
            error={eventsError}
          />
          {reportData ? (
            <MorningReportSummary data={reportData} />
          ) : (
            !loading && (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  No structured morning report available for {date}.
                </CardContent>
              </Card>
            )
          )}
        </TabsContent>

        <TabsContent value="events" className="flex flex-col gap-2 mt-4">
          {eventsLoading && (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {!eventsLoading && eventsError && (
            <Card>
              <CardContent className="py-4 text-sm text-destructive">
                {eventsError}
              </CardContent>
            </Card>
          )}

          {!eventsLoading && !eventsError && eventLog && eventLog.length === 0 && (
            <Card>
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                No events recorded for {date}.
              </CardContent>
            </Card>
          )}

          {!eventsLoading &&
            !eventsError &&
            eventLog &&
            eventLog.map((e) => (
              <Card key={e.id} size="sm">
                <CardContent className="flex flex-col gap-1.5">
                  <div className="flex items-start gap-2 flex-wrap">
                    <Badge
                      className={
                        e.verdict === "failed"
                          ? "bg-red-600 text-white hover:bg-red-600 shrink-0"
                          : e.verdict === "ok"
                            ? "bg-emerald-600 text-white hover:bg-emerald-600 shrink-0"
                            : "shrink-0"
                      }
                    >
                      {e.verdict}
                    </Badge>
                    <Badge variant="outline" className="shrink-0">
                      {e.stage}
                    </Badge>
                    <span className="text-sm font-medium">{e.phase}</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {new Date(e.timestamp).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-snug">
                    {e.reason}
                  </p>
                  {(e.inputs.length > 0 || e.outputs.length > 0) && (
                    <div className="flex flex-col gap-0.5 pl-1 border-l-2 border-border mt-0.5">
                      {e.inputs.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium">in:</span>{" "}
                          {e.inputs.join(", ")}
                        </p>
                      )}
                      {e.outputs.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium">out:</span>{" "}
                          {e.outputs.join(", ")}
                        </p>
                      )}
                    </div>
                  )}
                  {e.evidence_refs.length > 0 && (
                    <div className="flex flex-col gap-0.5 pl-1 border-l-2 border-destructive mt-0.5">
                      {e.evidence_refs.map((ref, i) => (
                        <p key={i} className="text-xs text-destructive italic">
                          {ref}
                        </p>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
        </TabsContent>

        <TabsContent value="shadow" className="flex flex-col gap-2 mt-4">
          {eventsLoading && (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {!eventsLoading &&
            (!shadowCandidates || shadowCandidates.length === 0) && (
              <Card>
                <CardContent className="py-6 text-center text-sm text-muted-foreground">
                  No shadow candidates for {date}.
                </CardContent>
              </Card>
            )}

          {!eventsLoading &&
            shadowCandidates?.map((sc, i) => (
              <Card key={i} size="sm">
                <CardContent className="flex flex-col gap-1.5">
                  <div className="flex items-start gap-2 flex-wrap">
                    <Badge variant="outline" className="shrink-0">
                      {sc.candidate.category}
                    </Badge>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {Math.round(sc.candidate.confidence * 100)}% confidence
                    </span>
                  </div>
                  <p className="text-sm leading-snug">{sc.candidate.text}</p>
                  {sc.candidate.sources.length > 0 && (
                    <div className="flex flex-col gap-0.5 pl-1 border-l-2 border-border mt-0.5">
                      {sc.candidate.sources.map((src, j) => (
                        <p
                          key={j}
                          className="text-xs text-muted-foreground italic"
                        >
                          {src.hash.slice(0, 20)}…: {src.excerpt.slice(0, 80)}
                          {src.excerpt.length > 80 && "…"}
                        </p>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
        </TabsContent>

        <TabsContent value="traces" className="mt-4">
          {traces ? (
            <TraceSummary analysis={traces} />
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No trace analysis available. Runs as an overnight operations task.
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="soul" className="mt-4">
          <SoulView soul={soul ?? {}} observations={[]} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
