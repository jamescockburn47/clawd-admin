'use client';

import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';

type AnyMessage = Record<string, unknown>;

function getString(msg: AnyMessage, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = msg[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function formatTime(raw: string | number | undefined): string {
  if (raw == null) return '';
  const d = typeof raw === 'number' ? new Date(raw) : new Date(raw);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

interface MessageRowProps {
  msg: AnyMessage;
}

function MessageRow({ msg }: MessageRowProps) {
  const [expanded, setExpanded] = useState(false);

  const ts = getString(msg, 'timestamp', 'ts', 'time', 'createdAt');
  const sender = getString(msg, 'senderName', 'sender', 'from', 'pushName');
  const text = getString(msg, 'text', 'message', 'body', 'content', 'caption');
  const chatJid = getString(msg, 'chatJid');
  const isBot = msg['isBot'] === true;
  const isGroup = chatJid ? chatJid.endsWith('@g.us') : (msg['isGroup'] === true);

  return (
    <div
      className="cursor-pointer px-3 py-2 transition-colors hover:bg-zinc-800/50"
      onClick={() => setExpanded((v) => !v)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded((v) => !v); }}
    >
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {formatTime(ts)}
        </span>
        <span className={`shrink-0 text-sm font-medium ${isBot ? 'text-green-500' : 'text-foreground'}`}>
          {isBot ? 'Clawd' : (sender ?? 'Unknown')}
          {isBot && sender && !isBot ? '' : ''}
        </span>
        {isGroup && (
          <span className="shrink-0 text-[10px] text-muted-foreground/60">(group)</span>
        )}
      </div>
      {text && !expanded && (
        <p className="mt-0.5 pl-[52px] text-sm text-muted-foreground line-clamp-2">
          {text}
        </p>
      )}
      {text && expanded && (
        <p className="mt-0.5 pl-[52px] text-sm text-muted-foreground whitespace-pre-wrap break-words">
          {text}
        </p>
      )}
      {!text && (
        <p className="mt-0.5 pl-[52px] text-sm italic text-muted-foreground/40">
          (no text)
        </p>
      )}
    </div>
  );
}

interface LiveFeedProps {
  messages: unknown[];
}

export function LiveFeed({ messages }: LiveFeedProps) {
  const filtered = (messages ?? []).filter(
    (m): m is AnyMessage => m != null && typeof m === 'object'
  );

  if (filtered.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No messages yet.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="divide-y divide-zinc-800/50">
        {filtered.map((msg, i) => (
          <MessageRow key={i} msg={msg} />
        ))}
      </div>
    </ScrollArea>
  );
}
