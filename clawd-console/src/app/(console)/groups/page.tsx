'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchParticipationDecisions, fetchParticipationGroups } from '@/lib/api';
import type { ParticipationDecision, ParticipationGroupSummary } from '@/lib/types';
import { buildGroupCardModel } from '@/lib/participation/view-models';
import { GroupCard } from '@/components/groups/group-card';
import { GroupDetail } from '@/components/groups/group-detail';
import { Skeleton } from '@/components/ui/skeleton';

const DECISION_SAMPLE = 80;
const HIGHLIGHT_LIMIT = 12;

export default function GroupsPage() {
  const [groups, setGroups] = useState<ParticipationGroupSummary[]>([]);
  const [decisions, setDecisions] = useState<ParticipationDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedJid, setSelectedJid] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchParticipationGroups(), fetchParticipationDecisions(DECISION_SAMPLE)])
      .then(([g, d]) => {
        setGroups(g.groups ?? []);
        setDecisions(d.decisions ?? []);
        const first = g.groups?.[0]?.chatJid ?? null;
        setSelectedJid((prev) => prev ?? first);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Failed to load participation data')
      )
      .finally(() => setLoading(false));
  }, []);

  const cardModels = useMemo(
    () => groups.map((g) => buildGroupCardModel(g, decisions)),
    [groups, decisions]
  );

  const selectedGroup = useMemo(
    () => groups.find((g) => g.chatJid === selectedJid) ?? null,
    [groups, selectedJid]
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Groups</h2>
        <p className="text-sm text-muted-foreground">
          Registered WhatsApp groups with merged participation posture and recent decision highlights.
        </p>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      {loading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            {cardModels.length === 0 ? (
              <p className="text-sm text-muted-foreground">No groups returned from the bot.</p>
            ) : (
              cardModels.map((m) => (
                <GroupCard
                  key={m.summary.chatJid}
                  model={m}
                  selected={m.summary.chatJid === selectedJid}
                  onSelect={setSelectedJid}
                />
              ))
            )}
          </div>
          <GroupDetail group={selectedGroup} decisions={decisions} highlightLimit={HIGHLIGHT_LIMIT} />
        </div>
      )}
    </div>
  );
}
