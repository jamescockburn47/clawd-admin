'use client';

interface StatusFooterProps {
  messageCount: number;
  modelDistribution: string;
  forgeSchedule: string;
}

export function StatusFooter({ messageCount, modelDistribution, forgeSchedule }: StatusFooterProps) {
  return (
    <footer className="flex h-8 shrink-0 items-center justify-between bg-zinc-950 px-4 text-xs text-muted-foreground font-mono">
      <div className="flex items-center gap-4">
        <span>{messageCount} msgs today</span>
        <span>{modelDistribution}</span>
      </div>
      <span>{forgeSchedule}</span>
    </footer>
  );
}
