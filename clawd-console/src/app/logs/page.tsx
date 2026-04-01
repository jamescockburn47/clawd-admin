'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { fetchPi } from '@/lib/api';
import type { TraceAnalysis } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { RefreshCw, Pause, Play } from 'lucide-react';
import { MessageFeed } from '@/components/logs/message-feed';
import { StatsSidebar } from '@/components/logs/stats-sidebar';

interface TraceResponse {
  analysis: TraceAnalysis | null;
}

const POLL_INTERVAL_MS = 10_000;

function extractCategories(traces: TraceAnalysis | null): string[] {
  if (!traces) return [];
  return Object.keys(traces.categories).sort();
}

export default function LiveMonitorPage() {
  const [messages, setMessages]             = useState<unknown[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messagesError, setMessagesError]   = useState<string | null>(null);

  const [traces, setTraces]         = useState<TraceAnalysis | null>(null);
  const [tracesLoading, setTracesLoading] = useState(true);
  const [tracesError, setTracesError] = useState<string | null>(null);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [refreshing, setRefreshing]   = useState(false);

  const [searchQuery, setSearchQuery]   = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMessages = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const data = await fetchPi<unknown>('messages');
      // Normalise: may be array directly or wrapped
      if (Array.isArray(data)) {
        setMessages(data);
      } else if (data && typeof data === 'object') {
        const d = data as Record<string, unknown>;
        const arr = d['messages'] ?? d['data'] ?? d['items'] ?? d['results'];
        setMessages(Array.isArray(arr) ? arr : []);
      } else {
        setMessages([]);
      }
      setLastRefreshed(new Date());
      setMessagesError(null);
    } catch (err) {
      setMessagesError(String(err));
    } finally {
      setMessagesLoading(false);
      if (showSpinner) setRefreshing(false);
    }
  }, []);

  const fetchTraces = useCallback(async () => {
    try {
      const res = await fetchPi<TraceResponse>('traces/live');
      setTraces(res.analysis);
      setTracesError(null);
    } catch (err) {
      setTracesError(String(err));
    } finally {
      setTracesLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchMessages(false);
    fetchTraces();
  }, [fetchMessages, fetchTraces]);

  // Auto-refresh messages
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        fetchMessages(false);
      }, POLL_INTERVAL_MS);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, fetchMessages]);

  const handleManualRefresh = () => {
    fetchMessages(true);
    fetchTraces();
  };

  const categories = extractCategories(traces);

  return (
    <div className="flex h-full flex-col space-y-4">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Live Monitor</h2>
          <p className="text-sm text-muted-foreground">
            Recent messages and processing details
            {lastRefreshed && (
              <span className="ml-2 text-[11px]">
                — updated {lastRefreshed.toLocaleTimeString('en-GB', { hour12: false })}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Auto-refresh toggle */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAutoRefresh((v) => !v)}
            className="gap-1.5"
          >
            {autoRefresh ? (
              <>
                <Pause className="h-3.5 w-3.5" />
                <span className="text-xs">Pause</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" />
                <span className="text-xs">Resume</span>
              </>
            )}
          </Button>

          {/* Manual refresh */}
          <Button
            size="sm"
            variant="outline"
            onClick={handleManualRefresh}
            disabled={refreshing}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span className="text-xs">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Auto-refresh status indicator */}
      {autoRefresh && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Auto-refreshing every 10s
        </div>
      )}

      <Separator />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="h-8 w-64 text-sm"
          placeholder="Search sender or message…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
        {(searchQuery || categoryFilter) && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-xs text-muted-foreground"
            onClick={() => { setSearchQuery(''); setCategoryFilter(''); }}
          >
            Clear
          </Button>
        )}
      </div>

      {/* Main content: feed + sidebar */}
      <div className="flex min-h-0 flex-1 gap-5">
        {/* Message feed */}
        <div className="min-w-0 flex-1">
          {messagesLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : messagesError ? (
            <div className="rounded-md bg-red-950 px-4 py-3 text-sm text-red-300">
              Failed to load messages: {messagesError}
            </div>
          ) : (
            <ScrollArea className="h-[calc(100vh-20rem)]">
              <MessageFeed
                messages={[...messages].reverse()}
                searchQuery={searchQuery}
                categoryFilter={categoryFilter}
              />
            </ScrollArea>
          )}
        </div>

        {/* Stats sidebar */}
        <div className="shrink-0">
          {tracesError ? (
            <div className="w-52 rounded-md bg-red-950 px-3 py-2 text-xs text-red-300">
              Traces unavailable
            </div>
          ) : (
            <StatsSidebar analysis={traces} loading={tracesLoading} />
          )}
        </div>
      </div>
    </div>
  );
}
