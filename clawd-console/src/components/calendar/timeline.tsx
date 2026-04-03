'use client';

import { useEffect, useState } from 'react';
import { format, parseISO, differenceInMinutes, startOfDay, addHours, isValid } from 'date-fns';

const START_HOUR = 7;
const END_HOUR = 22;
const TOTAL_HOURS = END_HOUR - START_HOUR;
const HOUR_HEIGHT_PX = 80;
const TIMELINE_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT_PX;

interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}

type EventKind = 'normal' | 'sidegig' | 'henry';

interface TimelineEvent extends CalendarEvent {
  kind: EventKind;
}

interface CalendarTimelineProps {
  events: CalendarEvent[];
  sideGig: CalendarEvent[];
  henryRelated: string[]; // henry weekend date strings for matching
}

function minutesSinceStart(date: Date): number {
  const dayStart = addHours(startOfDay(date), START_HOUR);
  return differenceInMinutes(date, dayStart);
}

function pxFromMinutes(minutes: number): number {
  return (minutes / 60) * HOUR_HEIGHT_PX;
}

function isAllDay(start: string, end: string): boolean {
  // All-day events: no time component or time is 00:00
  const s = parseISO(start);
  const e = parseISO(end);
  if (!isValid(s) || !isValid(e)) return false;
  return (
    s.getHours() === 0 && s.getMinutes() === 0 &&
    e.getHours() === 0 && e.getMinutes() === 0 &&
    differenceInMinutes(e, s) >= 1440
  );
}

const KIND_BORDER: Record<EventKind, string> = {
  normal: 'border-l-blue-500',
  sidegig: 'border-l-amber-500',
  henry: 'border-l-purple-500',
};

function EventBlock({ event, top, height }: { event: TimelineEvent; top: number; height: number }) {
  const startTime = format(parseISO(event.start), 'HH:mm');
  const endTime = format(parseISO(event.end), 'HH:mm');

  return (
    <div
      className={`absolute left-20 right-4 rounded-md bg-zinc-900 border-l-4 ${KIND_BORDER[event.kind]} px-4 py-2 overflow-hidden`}
      style={{ top: `${top}px`, height: `${Math.max(height, 36)}px` }}
    >
      <div className="text-2xl font-semibold text-zinc-100 truncate leading-tight">
        {event.summary}
      </div>
      {height > 44 && (
        <div className="text-base text-zinc-400 mt-0.5">
          {startTime} -- {endTime}
          {event.location ? `, ${event.location}` : ''}
        </div>
      )}
    </div>
  );
}

function NowLine({ now }: { now: Date }) {
  const mins = minutesSinceStart(now);
  if (mins < 0 || mins > TOTAL_HOURS * 60) return null;
  const top = pxFromMinutes(mins);

  return (
    <div className="absolute left-0 right-0" style={{ top: `${top}px` }}>
      <div className="flex items-center">
        <div className="relative flex items-center justify-center w-16">
          <span className="text-xs font-bold text-red-500 uppercase tracking-wider">NOW</span>
        </div>
        <div className="flex-1 h-0.5 bg-red-500 relative">
          <div className="absolute -left-1.5 -top-1 w-3 h-3 rounded-full bg-red-500 animate-pulse" />
        </div>
      </div>
    </div>
  );
}

export function CalendarTimeline({ events, sideGig, henryRelated }: CalendarTimelineProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Merge and classify events
  const allEvents: TimelineEvent[] = [
    ...events.map((e) => ({ ...e, kind: 'normal' as EventKind })),
    ...sideGig.map((e) => ({ ...e, kind: 'sidegig' as EventKind })),
  ];

  // Mark henry-related events
  const henrySet = new Set(henryRelated);
  for (const ev of allEvents) {
    const evDate = format(parseISO(ev.start), 'yyyy-MM-dd');
    if (henrySet.has(evDate) && ev.summary.toLowerCase().includes('henry')) {
      ev.kind = 'henry';
    }
  }

  // Separate all-day and timed events
  const timedEvents = allEvents.filter((e) => !isAllDay(e.start, e.end));
  const allDayEvents = allEvents.filter((e) => isAllDay(e.start, e.end));

  // Hour markers
  const hours = Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => START_HOUR + i);

  return (
    <div className="flex-1 overflow-y-auto px-4">
      {/* All-day events banner */}
      {allDayEvents.length > 0 && (
        <div className="flex gap-3 px-4 py-3 mb-2">
          {allDayEvents.map((ev, i) => (
            <div
              key={i}
              className={`rounded-md bg-zinc-900 border-l-4 ${KIND_BORDER[ev.kind]} px-4 py-2`}
            >
              <span className="text-xl font-semibold text-zinc-100">{ev.summary}</span>
              {ev.location && (
                <span className="text-base text-zinc-400 ml-3">{ev.location}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Timeline */}
      <div className="relative" style={{ height: `${TIMELINE_HEIGHT}px` }}>
        {/* Hour gridlines */}
        {hours.map((hour) => {
          const top = (hour - START_HOUR) * HOUR_HEIGHT_PX;
          return (
            <div key={hour} className="absolute left-0 right-0" style={{ top: `${top}px` }}>
              <div className="flex items-start">
                <span className="w-16 text-right pr-3 text-base text-zinc-500 -mt-2.5 select-none">
                  {String(hour).padStart(2, '0')}:00
                </span>
                <div className="flex-1 border-t border-zinc-800" />
              </div>
            </div>
          );
        })}

        {/* Event blocks */}
        {timedEvents.map((event, i) => {
          const start = parseISO(event.start);
          const end = parseISO(event.end);
          const mins = minutesSinceStart(start);
          const duration = differenceInMinutes(end, start);
          const top = pxFromMinutes(Math.max(mins, 0));
          const height = pxFromMinutes(Math.min(duration, TOTAL_HOURS * 60 - Math.max(mins, 0)));
          if (top > TIMELINE_HEIGHT || height <= 0) return null;
          return <EventBlock key={i} event={event} top={top} height={height} />;
        })}

        {/* Now line */}
        <NowLine now={now} />

        {/* Empty state */}
        {allEvents.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-2xl text-zinc-600">No events today</span>
          </div>
        )}
      </div>
    </div>
  );
}
