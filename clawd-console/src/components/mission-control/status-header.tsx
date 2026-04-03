'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';

type ServiceStatus = 'online' | 'offline';

interface StatusHeaderProps {
  whatsapp: ServiceStatus;
  evo: ServiceStatus;
  memory: ServiceStatus;
  forgeStatus: string;
}

const DOT_COLOURS: Record<ServiceStatus, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-red-500',
};

const DOT_LABELS = ['WhatsApp', 'EVO', 'Memory', 'Pi'] as const;

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function StatusHeader({ whatsapp, evo, memory, forgeStatus }: StatusHeaderProps) {
  const now = useClock();

  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  const statuses: ServiceStatus[] = [whatsapp, evo, memory, 'online'];

  return (
    <header className="flex h-12 shrink-0 items-center justify-between bg-zinc-950 px-4">
      <div className="flex items-center gap-4">
        <span className="font-mono text-base font-bold tracking-wider text-foreground">CLAWD</span>
        <div className="flex items-center gap-2">
          {statuses.map((s, i) => (
            <span key={DOT_LABELS[i]} className="flex items-center gap-1" title={DOT_LABELS[i]}>
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT_COLOURS[s]}`} />
            </span>
          ))}
        </div>
        <Badge variant="outline" className="font-mono text-[11px] px-2 py-0.5 text-muted-foreground">
          Forge: {forgeStatus}
        </Badge>
      </div>
      <div className="flex items-center gap-3 font-mono text-sm tabular-nums text-muted-foreground">
        <span>{time}</span>
        <span>{date}</span>
      </div>
    </header>
  );
}
