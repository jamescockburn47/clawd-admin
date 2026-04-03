'use client';

import { useEffect, useState, useCallback } from 'react';
import { fetchPi } from '@/lib/api';
import type { EvolutionTask, EvolutionListResponse, SystemHealth } from '@/lib/types';
import { StatusHeader } from '@/components/mission-control/status-header';
import { LiveFeed } from '@/components/mission-control/live-feed';
import { ActionPanel } from '@/components/mission-control/action-panel';
import type { Todo } from '@/components/mission-control/action-panel';
import { StatusFooter } from '@/components/mission-control/status-footer';

type ServiceStatus = 'online' | 'offline';

function deriveForgeStatus(tasks: EvolutionTask[]): string {
  const running = tasks.find((t) => t.status === 'running');
  if (running) return 'running';
  const deployed = tasks.filter((t) => t.status === 'deployed');
  if (deployed.length > 0) {
    const latest = deployed[deployed.length - 1];
    const label = latest.instruction.slice(0, 24);
    return `deployed: ${label}`;
  }
  return 'idle';
}

function deriveModelDistribution(messages: Record<string, unknown>[]): string {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const msg of messages) {
    const model = typeof msg['model'] === 'string' ? msg['model'] : null;
    if (model) {
      counts[model] = (counts[model] ?? 0) + 1;
      total++;
    }
  }
  if (total === 0) return 'No model data';
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
  return entries
    .slice(0, 3)
    .map(([name, count]) => {
      const pct = Math.round((count / total) * 100);
      return `${name} ${pct}%`;
    })
    .join(' / ');
}

function deriveForgeSchedule(tasks: EvolutionTask[]): string {
  const running = tasks.find((t) => t.status === 'running');
  if (running) return 'Forge running...';
  return 'Forge runs at 22:30';
}

export default function MissionControlPage() {
  const [messages, setMessages] = useState<Record<string, unknown>[]>([]);
  const [evoTasks, setEvoTasks] = useState<EvolutionTask[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [health, setHealth] = useState<SystemHealth | null>(null);

  // Fetch messages
  const fetchMessages = useCallback(async () => {
    try {
      const data = await fetchPi<{ messages?: unknown[] }>('messages');
      const msgs = Array.isArray(data) ? data : (data.messages ?? []);
      setMessages(
        (msgs as Record<string, unknown>[]).filter(
          (m) => m != null && typeof m === 'object'
        )
      );
    } catch (err) {
      console.error('[mission-control] messages fetch failed', err);
    }
  }, []);

  // Fetch evolution tasks
  const fetchEvo = useCallback(async () => {
    try {
      const data = await fetchPi<EvolutionListResponse>('evolution/list');
      setEvoTasks(data.tasks ?? []);
    } catch (err) {
      console.error('[mission-control] evo fetch failed', err);
    }
  }, []);

  // Fetch todos
  const fetchTodos = useCallback(async () => {
    try {
      const data = await fetchPi<{ todos?: Todo[] }>('todos');
      const list = Array.isArray(data) ? data : (data.todos ?? []);
      setTodos(list as Todo[]);
    } catch (err) {
      console.error('[mission-control] todos fetch failed', err);
    }
  }, []);

  // Fetch system health
  const fetchHealth = useCallback(async () => {
    try {
      const data = await fetchPi<SystemHealth>('system-health');
      setHealth(data);
    } catch (err) {
      console.error('[mission-control] health fetch failed', err);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchMessages();
    fetchEvo();
    fetchTodos();
    fetchHealth();
  }, [fetchMessages, fetchEvo, fetchTodos, fetchHealth]);

  // Poll messages every 10s
  useEffect(() => {
    const id = setInterval(fetchMessages, 10_000);
    return () => clearInterval(id);
  }, [fetchMessages]);

  // Poll evo + todos + health every 60s
  useEffect(() => {
    const id = setInterval(() => {
      fetchEvo();
      fetchTodos();
      fetchHealth();
    }, 60_000);
    return () => clearInterval(id);
  }, [fetchEvo, fetchTodos, fetchHealth]);

  // Derive statuses from health
  const whatsappStatus: ServiceStatus =
    health?.whatsapp?.status === 'connected' ? 'online' : health ? 'offline' : 'offline';
  const evoStatus: ServiceStatus =
    health?.evo?.status === 'connected' || health?.evo?.status === 'online' ? 'online' : health ? 'offline' : 'offline';
  const memoryStatus: ServiceStatus =
    health?.memory && health.memory.total > 0 ? 'online' : health ? 'offline' : 'offline';

  const forgeStatus = deriveForgeStatus(evoTasks);
  const modelDistribution = deriveModelDistribution(messages);
  const forgeSchedule = deriveForgeSchedule(evoTasks);

  const handleRefresh = useCallback(() => {
    fetchEvo();
    fetchTodos();
  }, [fetchEvo, fetchTodos]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950">
      <StatusHeader
        whatsapp={whatsappStatus}
        evo={evoStatus}
        memory={memoryStatus}
        forgeStatus={forgeStatus}
      />

      <div className="flex min-h-0 flex-1">
        {/* Left: Live Feed — takes ~60% */}
        <div className="flex-1 min-w-0 border-r border-zinc-800">
          <LiveFeed messages={messages} />
        </div>

        {/* Right: Action Panel — fixed width */}
        <div className="w-[320px] shrink-0">
          <ActionPanel
            evoTasks={evoTasks}
            todos={todos}
            onRefresh={handleRefresh}
          />
        </div>
      </div>

      <StatusFooter
        messageCount={messages.length}
        modelDistribution={modelDistribution}
        forgeSchedule={forgeSchedule}
      />
    </div>
  );
}
