import { cn } from '@/lib/utils';

export type Status = 'online' | 'offline' | 'warning' | 'unknown';

interface StatusDotProps {
  status: Status;
  label?: string;
}

const colorMap: Record<Status, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-red-500',
  warning: 'bg-yellow-500',
  unknown: 'bg-zinc-500',
};

export function StatusDot({ status, label }: StatusDotProps) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('inline-block h-2 w-2 rounded-full flex-shrink-0', colorMap[status])} />
      {label && (
        <span className="text-xs text-muted-foreground">{label}</span>
      )}
    </span>
  );
}
