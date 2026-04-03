'use client';

import { useEffect, useRef, useCallback, useState } from 'react';

interface UseSSEOptions {
  url: string;
  onEvent?: (event: string, data: unknown) => void;
  enabled?: boolean;
}

interface UseSSEResult {
  connected: boolean;
  lastEventAt: number | null;
}

export function useSSE({ url, onEvent, enabled = true }: UseSSEOptions): UseSSEResult {
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const backoffRef = useRef(1000);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (!enabled) return;
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      backoffRef.current = 1000; // reset backoff on success
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
      const delay = Math.min(backoffRef.current, 30000);
      backoffRef.current = delay * 2;
      timerRef.current = setTimeout(connect, delay);
    };

    // Listen for named events
    es.addEventListener('connected', () => {
      setConnected(true);
      setLastEventAt(Date.now());
      backoffRef.current = 1000;
    });

    es.addEventListener('message', (e) => {
      setLastEventAt(Date.now());
      try {
        const data = JSON.parse(e.data);
        onEventRef.current?.('message', data);
      } catch {
        // ignore malformed JSON
      }
    });

    es.addEventListener('widgets', (e) => {
      setLastEventAt(Date.now());
      try {
        const data = JSON.parse(e.data);
        onEventRef.current?.('widgets', data);
      } catch {
        // ignore malformed JSON
      }
    });

    es.addEventListener('todos', (e) => {
      setLastEventAt(Date.now());
      try {
        const data = JSON.parse(e.data);
        onEventRef.current?.('todos', data);
      } catch {
        // ignore malformed JSON
      }
    });

    // Watchdog: force reconnect if no event in 45 seconds
    if (watchdogRef.current) clearInterval(watchdogRef.current);
    watchdogRef.current = setInterval(() => {
      if (lastEventAt && Date.now() - lastEventAt > 45000) {
        es.close();
        esRef.current = null;
        setConnected(false);
        connect();
      }
    }, 15000);
  }, [url, enabled, lastEventAt]);

  useEffect(() => {
    connect();

    // Reconnect on tab visibility change
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !esRef.current) {
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (esRef.current) esRef.current.close();
      if (timerRef.current) clearTimeout(timerRef.current);
      if (watchdogRef.current) clearInterval(watchdogRef.current);
    };
  }, [connect]);

  return { connected, lastEventAt };
}
