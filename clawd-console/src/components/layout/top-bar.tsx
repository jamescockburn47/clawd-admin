'use client';

import { useEffect, useState } from 'react';
import { fetchPi } from '@/lib/api';
import type { PiStatus, EvoStatus, SystemHealth } from '@/lib/types';
import { StatusDot } from '@/components/shared/status-dot';
import type { Status } from '@/components/shared/status-dot';

interface TopBarState {
  whatsapp: { status: Status; label: string };
  evo: { status: Status; label: string };
  memoryCount: number | null;
  uptime: number | null;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const POLL_INTERVAL_MS = 30_000;

export function TopBar() {
  const [state, setState] = useState<TopBarState>({
    whatsapp: { status: 'unknown', label: 'WhatsApp' },
    evo: { status: 'unknown', label: 'EVO' },
    memoryCount: null,
    uptime: null,
  });

  useEffect(() => {
    async function poll() {
      const [piResult, evoResult, healthResult] = await Promise.allSettled([
        fetchPi<PiStatus>('status'),
        fetchPi<EvoStatus>('evo'),
        fetchPi<SystemHealth>('system-health'),
      ]);

      setState((prev) => {
        const next = { ...prev };

        if (piResult.status === 'fulfilled') {
          const pi = piResult.value;
          next.whatsapp = {
            status: pi.connected ? 'online' : 'offline',
            label: pi.connected && pi.name ? pi.name : 'WhatsApp',
          };
          next.uptime = pi.uptime ?? null;
        } else {
          next.whatsapp = { status: 'offline', label: 'WhatsApp' };
        }

        if (evoResult.status === 'fulfilled') {
          const evo = evoResult.value;
          next.evo = {
            status: evo.online ? 'online' : 'offline',
            label: evo.online && evo.model ? evo.model : 'EVO',
          };
        } else {
          next.evo = { status: 'offline', label: 'EVO' };
        }

        if (healthResult.status === 'fulfilled') {
          const health = healthResult.value;
          next.memoryCount = health.memory?.total ?? null;
          if (next.uptime === null) {
            next.uptime = health.uptime ?? null;
          }
        }

        return next;
      });
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-6">
      <div className="flex items-center gap-6">
        <StatusDot status={state.whatsapp.status} label={state.whatsapp.label} />
        <StatusDot status={state.evo.status} label={state.evo.label} />
        {state.memoryCount !== null && (
          <span className="text-xs text-muted-foreground">
            {state.memoryCount.toLocaleString()} memories
          </span>
        )}
      </div>

      <div className="text-xs text-muted-foreground">
        {state.uptime !== null ? (
          <span>up {formatUptime(state.uptime)}</span>
        ) : (
          <span className="opacity-50">—</span>
        )}
      </div>
    </header>
  );
}
