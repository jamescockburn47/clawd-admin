'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Moon,
  Route,
  GitBranch,
  Brain,
  Radio,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Intelligence',
    items: [
      { href: '/', label: 'Overview', icon: LayoutDashboard },
      { href: '/overnight', label: 'Overnight Intelligence', icon: Moon },
      { href: '/routing', label: 'Routing & Traces', icon: Route },
    ],
  },
  {
    label: 'Control',
    items: [
      { href: '/evolution', label: 'Evolution Pipeline', icon: GitBranch },
      { href: '/memory', label: 'Memory Browser', icon: Brain },
    ],
  },
  {
    label: 'Monitor',
    items: [
      { href: '/logs', label: 'Live Monitor', icon: Radio },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-56 flex-col border-r bg-background">
      <div className="flex h-14 items-center border-b px-4">
        <span className="font-mono text-sm font-semibold tracking-wider text-foreground">
          CLAWD CONSOLE
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto py-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-4">
            <p className="mb-1 px-4 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              {group.label}
            </p>
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
                    isActive
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground'
                  )}
                >
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
