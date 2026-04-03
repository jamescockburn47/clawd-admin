import { HealthCards } from '@/components/overview/health-cards';
import { StatsCards } from '@/components/overview/stats-cards';
import { RoutingBar } from '@/components/overview/routing-bar';

export default function OverviewPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">System Health</h2>
        <p className="text-sm text-muted-foreground">Live status of all subsystems</p>
      </div>
      <HealthCards />
      <RoutingBar />
      <div className="pt-2">
        <h2 className="text-lg font-semibold">Today</h2>
        <p className="text-sm text-muted-foreground">Last 24 hours of activity</p>
      </div>
      <StatsCards />
    </div>
  );
}
