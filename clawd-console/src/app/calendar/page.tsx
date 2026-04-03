'use client';

import { useEffect, useState, useCallback } from 'react';
import { fetchPi } from '@/lib/api';
import { CalendarHeader } from '@/components/calendar/header';
import { CalendarTimeline } from '@/components/calendar/timeline';
import { CalendarFooter } from '@/components/calendar/footer';

interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}

interface HenryWeekend {
  date: string;
  name: string;
  travelBooked: boolean;
  accomBooked: boolean;
}

interface SideGigEvent {
  summary: string;
  start: string;
  end: string;
  location?: string;
}

interface WeatherData {
  location: string;
  temp: number;
  description: string;
}

interface WidgetData {
  calendar: CalendarEvent[];
  henryWeekends: HenryWeekend[];
  sideGig: SideGigEvent[];
  weather: WeatherData[];
}

const REFRESH_MS = 5 * 60 * 1000;

export default function CalendarPage() {
  const [data, setData] = useState<WidgetData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchPi<WidgetData>('widgets');
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const weather = data?.weather?.[0] ?? null;
  const henryDates = (data?.henryWeekends ?? []).map((h) => h.date);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <CalendarHeader date={new Date()} weather={weather} />

      {error && (
        <div className="px-8 py-2 text-sm text-red-400 bg-zinc-900">
          Data fetch failed: {error}
        </div>
      )}

      <CalendarTimeline
        events={data?.calendar ?? []}
        sideGig={data?.sideGig ?? []}
        henryRelated={henryDates}
      />

      <CalendarFooter
        henryWeekends={data?.henryWeekends ?? []}
        sideGig={data?.sideGig ?? []}
      />
    </div>
  );
}
