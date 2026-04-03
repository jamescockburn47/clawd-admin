'use client';

import { format } from 'date-fns';

interface WeatherData {
  location: string;
  temp: number;
  description: string;
}

interface CalendarHeaderProps {
  date: Date;
  weather: WeatherData | null;
}

export function CalendarHeader({ date, weather }: CalendarHeaderProps) {
  return (
    <div className="flex items-center justify-between px-8 py-5 border-b border-zinc-800">
      <h1 className="text-[32px] font-bold text-zinc-100">
        {format(date, 'EEEE d MMMM yyyy')}
      </h1>
      {weather && (
        <span className="text-lg text-zinc-400">
          {weather.location}: {Math.round(weather.temp)}&deg;C, {weather.description}
        </span>
      )}
    </div>
  );
}
