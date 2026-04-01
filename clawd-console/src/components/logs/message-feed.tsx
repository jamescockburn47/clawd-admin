'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';

// Defensive unknown-shape message type
type AnyMessage = Record<string, unknown>;

// Category badge colour map
const CATEGORY_COLOURS: Record<string, string> = {
  calendar:      'bg-blue-900 text-blue-200',
  task:          'bg-green-900 text-green-200',
  todo:          'bg-green-900 text-green-200',
  email:         'bg-amber-900 text-amber-200',
  recall:        'bg-violet-900 text-violet-200',
  memory:        'bg-violet-900 text-violet-200',
  conversational:'bg-zinc-800 text-zinc-300',
  planning:      'bg-indigo-900 text-indigo-200',
  legal:         'bg-red-900 text-red-200',
  web:           'bg-sky-900 text-sky-200',
  search:        'bg-sky-900 text-sky-200',
  travel:        'bg-teal-900 text-teal-200',
  document:      'bg-orange-900 text-orange-200',
};

function categoryColour(cat: string): string {
  const key = cat.toLowerCase();
  return CATEGORY_COLOURS[key] ?? 'bg-zinc-800 text-zinc-300';
}

// Model badge colour map
function modelColour(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('claude') || m.includes('opus') || m.includes('sonnet')) {
    return 'bg-purple-900 text-purple-200';
  }
  if (m.includes('minimax') || m.includes('mini')) {
    return 'bg-blue-900 text-blue-200';
  }
  if (m.includes('evo') || m.includes('local') || m.includes('qwen')) {
    return 'bg-emerald-900 text-emerald-200';
  }
  return 'bg-zinc-800 text-zinc-300';
}

function getString(msg: AnyMessage, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = msg[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function getNumber(msg: AnyMessage, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = msg[k];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

function formatTime(raw: string | number | undefined): string {
  if (raw == null) return '';
  const d = typeof raw === 'number' ? new Date(raw) : new Date(raw);
  if (isNaN(d.getTime())) return String(raw).slice(0, 8);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

interface MessageCardProps {
  msg: AnyMessage;
}

function MessageCard({ msg }: MessageCardProps) {
  const [expanded, setExpanded] = useState(false);

  const ts        = getString(msg, 'timestamp', 'ts', 'time', 'createdAt');
  const sender    = getString(msg, 'senderName', 'sender', 'from', 'pushName');
  const text      = getString(msg, 'text', 'message', 'body', 'content', 'caption');
  const category  = getString(msg, 'category', 'route', 'intent');
  const model     = getString(msg, 'model', 'modelUsed', 'llm');
  const latencyMs = getNumber(msg, 'timeMs', 'totalTimeMs', 'durationMs', 'latencyMs', 'elapsed');

  const preview = text ? text.slice(0, 100) + (text.length > 100 ? '…' : '') : null;

  return (
    <div
      className="cursor-pointer rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/30"
      onClick={() => setExpanded((v) => !v)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded((v) => !v); }}
      aria-expanded={expanded}
    >
      {/* Top row */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {ts && (
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {formatTime(ts)}
          </span>
        )}
        {sender && (
          <span className="text-xs font-medium text-foreground">{sender}</span>
        )}
        {category && (
          <Badge className={`text-[10px] px-1.5 py-0 ${categoryColour(category)}`}>
            {category}
          </Badge>
        )}
        {model && (
          <Badge className={`text-[10px] px-1.5 py-0 ${modelColour(model)}`}>
            {model}
          </Badge>
        )}
        {latencyMs != null && (
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {latencyMs}ms
          </span>
        )}
      </div>

      {/* Message body */}
      <div className="mt-1.5 text-xs text-muted-foreground">
        {!expanded && preview && <span>{preview}</span>}
        {!expanded && !preview && (
          <span className="italic opacity-50">(no text)</span>
        )}
        {expanded && text && (
          <p className="whitespace-pre-wrap break-words">{text}</p>
        )}
        {expanded && !text && (
          <pre className="overflow-x-auto text-[10px]">
            {JSON.stringify(msg, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

interface MessageFeedProps {
  messages: unknown[];
  searchQuery?: string;
  categoryFilter?: string;
}

export function MessageFeed({ messages, searchQuery = '', categoryFilter = '' }: MessageFeedProps) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-muted px-4 py-12 text-center text-sm text-muted-foreground">
        No messages to display.
      </div>
    );
  }

  // Filter defensively
  const filtered = messages
    .filter((m): m is AnyMessage => m != null && typeof m === 'object')
    .filter((m) => {
      if (categoryFilter) {
        const cat = String(m['category'] ?? m['route'] ?? m['intent'] ?? '').toLowerCase();
        if (!cat.includes(categoryFilter.toLowerCase())) return false;
      }
      if (searchQuery) {
        const text = String(
          m['text'] ?? m['message'] ?? m['body'] ?? m['content'] ?? ''
        ).toLowerCase();
        const sender = String(
          m['senderName'] ?? m['sender'] ?? m['from'] ?? ''
        ).toLowerCase();
        const q = searchQuery.toLowerCase();
        if (!text.includes(q) && !sender.includes(q)) return false;
      }
      return true;
    });

  if (filtered.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-muted px-4 py-12 text-center text-sm text-muted-foreground">
        No messages match the current filters.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {filtered.map((msg, i) => (
        <MessageCard key={i} msg={msg} />
      ))}
    </div>
  );
}
