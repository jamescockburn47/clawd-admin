'use client';

import { useEffect, useState } from 'react';
import { Wifi, Cpu, Brain, Server } from 'lucide-react';
import { fetchPi } from '@/lib/api';
import type { PiStatus, SystemHealth, EvoStatus } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusDot } from '@/components/shared/status-dot';
import type { Status } from '@/components/shared/status-dot';

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

interface HealthState {
  loading: boolean;
  whatsapp: {
    status: Status;
    name: string | null;
    uptime: number | null;
  };
  evo: {
    status: Status;
    model: string | null;
    queueDepth: number | null;
  };
  memory: {
    status: Status;
    total: number | null;
    categoryCount: number | null;
  };
  pi: {
    status: Status;
    memoryMB: number | null;
    uptime: number | null;
  };
}

const initialState: HealthState = {
  loading: true,
  whatsapp: { status: 'unknown', name: null, uptime: null },
  evo: { status: 'unknown', model: null, queueDepth: null },
  memory: { status: 'unknown', total: null, categoryCount: null },
  pi: { status: 'unknown', memoryMB: null, uptime: null },
};

export function HealthCards() {
  const [state, setState] = useState<HealthState>(initialState);

  useEffect(() => {
    async function load() {
      const [piResult, healthResult, evoResult] = await Promise.allSettled([
        fetchPi<PiStatus>('status'),
        fetchPi<SystemHealth>('system-health'),
        fetchPi<EvoStatus>('evo'),
      ]);

      setState((prev) => {
        const next: HealthState = { ...prev, loading: false };

        if (piResult.status === 'fulfilled') {
          const pi = piResult.value;
          next.whatsapp = {
            status: pi.connected ? 'online' : 'offline',
            name: pi.connected ? pi.name : null,
            uptime: pi.uptime ?? null,
          };
          next.pi = {
            status: 'online',
            memoryMB: pi.memoryMB ?? null,
            uptime: pi.uptime ?? null,
          };
        } else {
          next.whatsapp = { status: 'offline', name: null, uptime: null };
          next.pi = { status: 'offline', memoryMB: null, uptime: null };
        }

        if (healthResult.status === 'fulfilled') {
          const health = healthResult.value;
          const memData = health.memory;
          const total = memData?.total ?? null;
          const categoryCount = memData?.categories
            ? Object.keys(memData.categories).length
            : null;
          next.memory = {
            status: total !== null ? 'online' : 'warning',
            total,
            categoryCount,
          };
          if (next.pi.uptime === null) {
            next.pi = { ...next.pi, uptime: health.uptime ?? null };
          }
        } else {
          next.memory = { status: 'offline', total: null, categoryCount: null };
        }

        if (evoResult.status === 'fulfilled') {
          const evo = evoResult.value;
          const isOnline = evo.online || evo.available || false;
          next.evo = {
            status: isOnline ? 'online' : 'offline',
            model: isOnline ? (evo.model ?? null) : null,
            queueDepth: evo.queueDepth ?? null,
          };
        } else {
          next.evo = { status: 'offline', model: null, queueDepth: null };
        }

        return next;
      });
    }

    load();
  }, []);

  if (state.loading) {
    return (
      <div className="grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-4 gap-4">
      {/* WhatsApp */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-muted-foreground" />
            WhatsApp
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="flex items-center gap-2">
            <StatusDot status={state.whatsapp.status} />
            <span className="text-sm font-medium truncate">
              {state.whatsapp.name ?? 'Disconnected'}
            </span>
          </div>
          {state.whatsapp.uptime !== null && (
            <p className="text-xs text-muted-foreground">
              up {formatUptime(state.whatsapp.uptime)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* EVO X2 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            EVO X2
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="flex items-center gap-2">
            <StatusDot status={state.evo.status} />
            <span className="text-sm font-medium truncate">
              {state.evo.model ?? 'Offline'}
            </span>
          </div>
          {state.evo.queueDepth !== null && (
            <p className="text-xs text-muted-foreground">
              queue: {state.evo.queueDepth}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Memory Service */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-muted-foreground" />
            Memory Service
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="flex items-center gap-2">
            <StatusDot status={state.memory.status} />
            <span className="text-sm font-medium">
              {state.memory.total !== null
                ? `${state.memory.total.toLocaleString()} memories`
                : 'Unavailable'}
            </span>
          </div>
          {state.memory.categoryCount !== null && (
            <p className="text-xs text-muted-foreground">
              {state.memory.categoryCount} categories
            </p>
          )}
        </CardContent>
      </Card>

      {/* Pi System */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            Pi System
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="flex items-center gap-2">
            <StatusDot status={state.pi.status} />
            <span className="text-sm font-medium">
              {state.pi.memoryMB !== null
                ? formatMB(state.pi.memoryMB) + ' RAM'
                : 'Offline'}
            </span>
          </div>
          {state.pi.uptime !== null && (
            <p className="text-xs text-muted-foreground">
              up {formatUptime(state.pi.uptime)}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
