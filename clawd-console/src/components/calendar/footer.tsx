'use client';

import { format, parseISO } from 'date-fns';

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

interface CalendarFooterProps {
  henryWeekends: HenryWeekend[];
  sideGig: SideGigEvent[];
}

export function CalendarFooter({ henryWeekends, sideGig }: CalendarFooterProps) {
  const nextHenry = henryWeekends.length > 0 ? henryWeekends[0] : null;
  const nextGig = sideGig.length > 0 ? sideGig[0] : null;

  if (!nextHenry && !nextGig) return null;

  return (
    <div className="flex items-center gap-12 px-8 py-4 border-t border-zinc-800 text-base text-zinc-400">
      {nextHenry && (
        <span>
          <span className="text-purple-400 font-medium">{nextHenry.name}:</span>{' '}
          {format(parseISO(nextHenry.date), 'd MMM')}
          {' (travel '}
          <span className={nextHenry.travelBooked ? 'text-green-400' : 'text-red-400'}>
            {nextHenry.travelBooked ? 'booked' : 'unbooked'}
          </span>
          {' / accom '}
          <span className={nextHenry.accomBooked ? 'text-green-400' : 'text-red-400'}>
            {nextHenry.accomBooked ? 'booked' : 'unbooked'}
          </span>
          {')'}
        </span>
      )}
      {nextGig && (
        <span>
          <span className="text-amber-400 font-medium">Side Gig:</span>{' '}
          {nextGig.summary} {format(parseISO(nextGig.start), 'd MMM HH:mm')}
        </span>
      )}
    </div>
  );
}
