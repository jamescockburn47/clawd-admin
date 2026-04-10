"use client"

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { fetchPi } from '@/lib/api'
import type {
  OvernightEvent,
  ShadowCandidate,
  OvernightEventsResponse,
} from '@/lib/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Moon, ArrowRight } from 'lucide-react'

function yesterdayStr(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

interface OvernightSummary {
  eventCount: number
  shadowCount: number
  errorCount: number
  stageCounts: Record<string, number>
  firstError: OvernightEvent | null
  date: string
}

function summarise(
  events: OvernightEvent[],
  shadow: ShadowCandidate[],
  date: string,
): OvernightSummary {
  const stageCounts: Record<string, number> = {}
  let errorCount = 0
  let firstError: OvernightEvent | null = null

  for (const e of events) {
    stageCounts[e.stage] = (stageCounts[e.stage] ?? 0) + 1
    if (e.verdict === 'failed') {
      errorCount += 1
      if (!firstError) firstError = e
    }
  }

  return {
    eventCount: events.length,
    shadowCount: shadow.length,
    errorCount,
    stageCounts,
    firstError,
    date,
  }
}

/**
 * Overview landing card summarising last night's overnight activity.
 * Reads from the new event log (GET /api/overnight-events/:date) and shows
 * a compact count + errors-first summary. Clicking the card jumps to the
 * full Overnight Intelligence page.
 */
export function OvernightCard() {
  const [summary, setSummary] = useState<OvernightSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const date = todayStr()

    // Fetch today's events (Phase 1 shadow writes at 02:30 using today's date key).
    // If today's file is empty (bot hasn't run yet this morning), fall back to yesterday.
    fetchPi<OvernightEventsResponse>(`overnight-events/${date}`)
      .then(async (data) => {
        if (cancelled) return
        if (data.events.length > 0 || data.shadowCandidates.length > 0) {
          setSummary(summarise(data.events, data.shadowCandidates, date))
          return
        }
        // Fall back to yesterday
        const yData = await fetchPi<OvernightEventsResponse>(
          `overnight-events/${yesterdayStr()}`,
        )
        if (!cancelled) {
          setSummary(
            summarise(yData.events, yData.shadowCandidates, yesterdayStr()),
          )
        }
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Moon className="h-4 w-4" />
          Overnight
          <Link
            href="/overnight"
            className="ml-auto inline-flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            View details <ArrowRight className="h-3 w-3" />
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-48" />
          </div>
        )}

        {!loading && error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {!loading && !error && summary && summary.eventCount === 0 && (
          <p className="text-sm text-muted-foreground">
            No overnight activity recorded for {summary.date}.
          </p>
        )}

        {!loading && !error && summary && summary.eventCount > 0 && (
          <div className="flex flex-col gap-2">
            {/* Errors first */}
            {summary.errorCount > 0 && summary.firstError && (
              <div className="flex items-start gap-2">
                <Badge className="bg-red-600 text-white hover:bg-red-600 shrink-0">
                  {summary.errorCount} error{summary.errorCount !== 1 ? 's' : ''}
                </Badge>
                <p className="text-sm text-muted-foreground leading-snug">
                  <span className="font-medium text-foreground">
                    {summary.firstError.phase}:
                  </span>{' '}
                  {summary.firstError.reason}
                </p>
              </div>
            )}

            {/* Counts */}
            <div className="flex flex-wrap gap-3 text-sm">
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-semibold tabular-nums">
                  {summary.eventCount}
                </span>
                <span className="text-muted-foreground">events</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-semibold tabular-nums">
                  {summary.shadowCount}
                </span>
                <span className="text-muted-foreground">shadow candidates</span>
              </div>
              {Object.entries(summary.stageCounts).map(([stage, count]) => (
                <div key={stage} className="flex items-baseline gap-1">
                  <span className="text-sm font-medium tabular-nums">
                    {count}
                  </span>
                  <span className="text-xs text-muted-foreground">{stage}</span>
                </div>
              ))}
            </div>

            <p className="text-xs text-muted-foreground">
              {summary.date}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
