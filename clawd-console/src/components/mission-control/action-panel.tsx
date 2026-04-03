'use client';

import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { EvolutionTask } from '@/lib/types';
import { postPi } from '@/lib/api';

/* ---------- Evolution section ---------- */

interface EvoCardProps {
  task: EvolutionTask;
  onAction: () => void;
}

function EvoCard({ task, onAction }: EvoCardProps) {
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);

  async function approve() {
    setLoading('approve');
    try {
      await postPi('evolution/approve', { taskId: task.id });
      onAction();
    } catch (err) {
      console.error('[action-panel] approve failed', err);
    } finally {
      setLoading(null);
    }
  }

  async function reject() {
    setLoading('reject');
    try {
      await postPi('evolution/reject', { taskId: task.id });
      onAction();
    } catch (err) {
      console.error('[action-panel] reject failed', err);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="rounded-md border border-yellow-500/30 bg-zinc-900 p-3">
      <p className="text-sm leading-snug line-clamp-3">{task.instruction}</p>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          className="h-11 min-w-[80px] bg-emerald-600 hover:bg-emerald-700 text-white text-sm"
          disabled={loading !== null}
          onClick={approve}
        >
          {loading === 'approve' ? 'Wait...' : 'Approve'}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="h-11 min-w-[80px] text-sm"
          disabled={loading !== null}
          onClick={reject}
        >
          {loading === 'reject' ? 'Wait...' : 'Reject'}
        </Button>
      </div>
    </div>
  );
}

/* ---------- Todo section ---------- */

interface Todo {
  id: string;
  text: string;
  priority?: 'high' | 'normal' | 'low';
  due?: string;
  completed?: boolean;
}

interface TodoRowProps {
  todo: Todo;
  onComplete: () => void;
}

function TodoRow({ todo, onComplete }: TodoRowProps) {
  const [completing, setCompleting] = useState(false);

  async function handleComplete() {
    setCompleting(true);
    try {
      await postPi('todos/complete', { id: todo.id });
      onComplete();
    } catch (err) {
      console.error('[action-panel] complete todo failed', err);
    } finally {
      setCompleting(false);
    }
  }

  const isOverdue = todo.due ? new Date(todo.due) < new Date() : false;
  const borderClass = todo.priority === 'high' ? 'border-l-2 border-l-red-500 pl-2' : 'pl-3';

  return (
    <div className={`flex items-start gap-2 py-1.5 ${borderClass}`}>
      <button
        className="mt-0.5 h-5 w-5 shrink-0 rounded border border-zinc-600 hover:border-zinc-400 flex items-center justify-center"
        style={{ minWidth: 20, minHeight: 20 }}
        onClick={handleComplete}
        disabled={completing}
        aria-label={`Complete: ${todo.text}`}
      >
        {completing && <span className="text-[10px] text-muted-foreground">...</span>}
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">{todo.text}</p>
        {todo.due && (
          <span className={`text-[11px] ${isOverdue ? 'text-red-400' : 'text-muted-foreground'}`}>
            {new Date(todo.due).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------- Main panel ---------- */

interface ActionPanelProps {
  evoTasks: EvolutionTask[];
  todos: Todo[];
  onRefresh: () => void;
}

export type { Todo };

export function ActionPanel({ evoTasks, todos, onRefresh }: ActionPanelProps) {
  const awaitingTasks = evoTasks.filter((t) => t.status === 'awaiting_approval');
  const activeTodos = (todos ?? []).filter((t) => !t.completed);

  // Sort todos: high > normal > low, then by due date
  const priorityOrder: Record<string, number> = { high: 0, normal: 1, low: 2 };
  const sortedTodos = [...activeTodos].sort((a, b) => {
    const pa = priorityOrder[a.priority ?? 'normal'] ?? 1;
    const pb = priorityOrder[b.priority ?? 'normal'] ?? 1;
    if (pa !== pb) return pa - pb;
    if (a.due && b.due) return new Date(a.due).getTime() - new Date(b.due).getTime();
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        {/* Evolution section */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Evolution
            </span>
            {awaitingTasks.length > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {awaitingTasks.length} pending
              </Badge>
            )}
          </div>
          {awaitingTasks.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">No tasks awaiting approval.</p>
          ) : (
            <div className="space-y-2">
              {awaitingTasks.map((t) => (
                <EvoCard key={t.id} task={t} onAction={onRefresh} />
              ))}
            </div>
          )}
        </div>

        {/* Todos section */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Todos
            </span>
            {sortedTodos.length > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {sortedTodos.length} active
              </Badge>
            )}
          </div>
          {sortedTodos.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">All clear.</p>
          ) : (
            <div className="space-y-0.5">
              {sortedTodos.map((t) => (
                <TodoRow key={t.id} todo={t} onComplete={onRefresh} />
              ))}
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
