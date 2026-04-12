'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchParticipationConfig, fetchParticipationDecisions, patchParticipationGroup, patchAgencyPolicy } from '@/lib/api';
import type {
  ParticipationGroupConfig,
  ParticipationConfigResponse,
  ParticipationDecision,
  ParticipationPosture,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';

const DECISION_LIMIT = 50;

const MS_OPTIONS = [
  { label: '30s', value: 30000 },
  { label: '1m', value: 60000 },
  { label: '2m', value: 120000 },
  { label: '3m', value: 180000 },
  { label: '5m', value: 300000 },
  { label: '10m', value: 600000 },
];

function SaveFlash({ field, saved }: { field: string; saved: string | null }) {
  if (saved !== field) return null;
  return <span className="ml-1 text-xs text-green-500 animate-pulse">Saved</span>;
}

function NumberStepper({ value, min, max, step = 1, onChange }: {
  value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button className="rounded border px-2 py-0.5 hover:bg-accent text-sm" onClick={() => onChange(Math.max(min, value - step))}>-</button>
      <span className="tabular-nums font-medium w-8 text-center text-sm">{value}</span>
      <button className="rounded border px-2 py-0.5 hover:bg-accent text-sm" onClick={() => onChange(Math.min(max, value + step))}>+</button>
    </div>
  );
}

function ConfidenceSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={50} max={100} step={5}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="w-24"
      />
      <span className="tabular-nums text-sm font-medium w-12">{(value * 100).toFixed(0)}%</span>
    </div>
  );
}

function MsDropdown({ value, onChange, options }: {
  value: number; onChange: (v: number) => void;
  options?: { label: string; value: number }[];
}) {
  const opts = options ?? MS_OPTIONS;
  return (
    <select
      className="rounded border bg-background px-2 py-1 text-sm"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {opts.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function GroupSettingsCard({
  group,
  saved,
  onPatchParticipation,
  onPatchAgency,
}: {
  group: ParticipationGroupConfig;
  saved: string | null;
  onPatchParticipation: (jid: string, field: string, patch: Record<string, unknown>) => void;
  onPatchAgency: (label: string, field: string, patch: Record<string, unknown>) => void;
}) {
  const p = group.participation;
  const a = group.agency;
  const label = group.label.toLowerCase();

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{group.label}</CardTitle>
          <Badge variant={a.enabled ? 'default' : 'secondary'}>
            {a.enabled ? 'ambient on' : 'ambient off'}
          </Badge>
        </div>
        <p className="font-mono text-xs text-muted-foreground">{group.mode} mode</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Participation */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">Participation</p>
          <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <label className="text-muted-foreground block mb-1">Posture <SaveFlash field={`${group.chatJid}-posture`} saved={saved} /></label>
              <select
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={p.posture}
                onChange={(e) => onPatchParticipation(group.chatJid, `${group.chatJid}-posture`, { posture: e.target.value as ParticipationPosture })}
              >
                <option value="direct_only">Direct only</option>
                <option value="rare_high_confidence">Rare (high confidence)</option>
                <option value="active_participant">Active participant</option>
              </select>
            </div>
            <div>
              <label className="text-muted-foreground block mb-1">Follow-up window <SaveFlash field={`${group.chatJid}-followUp`} saved={saved} /></label>
              <MsDropdown
                value={p.followUpWindowMs}
                onChange={(v) => onPatchParticipation(group.chatJid, `${group.chatJid}-followUp`, { followUpWindowMs: v })}
                options={MS_OPTIONS.filter((o) => o.value >= 60000)}
              />
            </div>
            <div>
              <label className="text-muted-foreground block mb-1">Cooldown <SaveFlash field={`${group.chatJid}-cooldown`} saved={saved} /></label>
              <MsDropdown
                value={p.cooldownMs}
                onChange={(v) => onPatchParticipation(group.chatJid, `${group.chatJid}-cooldown`, { cooldownMs: v })}
              />
            </div>
            <div>
              <label className="text-muted-foreground block mb-1">Max unsolicited/hr <SaveFlash field={`${group.chatJid}-maxUnsolicited`} saved={saved} /></label>
              <NumberStepper value={p.maxUnsolicitedPerHour} min={1} max={20} onChange={(v) => onPatchParticipation(group.chatJid, `${group.chatJid}-maxUnsolicited`, { maxUnsolicitedPerHour: v })} />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-muted-foreground">Research</label>
              <input type="checkbox" checked={p.researchEnabled} onChange={(e) => onPatchParticipation(group.chatJid, `${group.chatJid}-research`, { researchEnabled: e.target.checked })} />
              <SaveFlash field={`${group.chatJid}-research`} saved={saved} />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-muted-foreground">Memory recall</label>
              <input type="checkbox" checked={p.memoryRecallEnabled} onChange={(e) => onPatchParticipation(group.chatJid, `${group.chatJid}-memory`, { memoryRecallEnabled: e.target.checked })} />
              <SaveFlash field={`${group.chatJid}-memory`} saved={saved} />
            </div>
          </div>
        </div>

        <Separator />

        {/* Agency */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">Agency policy</p>
          <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <div className="flex items-center gap-3">
              <label className="text-muted-foreground">Ambient enabled</label>
              <input type="checkbox" checked={a.enabled} onChange={(e) => onPatchAgency(label, `${label}-enabled`, { enabled: e.target.checked })} />
              <SaveFlash field={`${label}-enabled`} saved={saved} />
            </div>
            <div>
              <label className="text-muted-foreground block mb-1">Min heuristic score (1-10) <SaveFlash field={`${label}-heuristic`} saved={saved} /></label>
              <NumberStepper value={a.minHeuristicScore} min={1} max={10} onChange={(v) => onPatchAgency(label, `${label}-heuristic`, { minHeuristicScore: v })} />
            </div>
            <div>
              <label className="text-muted-foreground block mb-1">Min confidence <SaveFlash field={`${label}-confidence`} saved={saved} /></label>
              <ConfidenceSlider value={a.minModelConfidence} onChange={(v) => onPatchAgency(label, `${label}-confidence`, { minModelConfidence: v })} />
            </div>
            <div>
              <label className="text-muted-foreground block mb-1">Agency cooldown <SaveFlash field={`${label}-agencyCooldown`} saved={saved} /></label>
              <MsDropdown
                value={a.cooldownMs}
                onChange={(v) => onPatchAgency(label, `${label}-agencyCooldown`, { cooldownMs: v })}
              />
            </div>
            <div>
              <label className="text-muted-foreground block mb-1">Max interventions/hr <SaveFlash field={`${label}-maxInterventions`} saved={saved} /></label>
              <NumberStepper value={a.maxInterventionsPerHour} min={1} max={20} onChange={(v) => onPatchAgency(label, `${label}-maxInterventions`, { maxInterventionsPerHour: v })} />
            </div>
            <div>
              <label className="text-muted-foreground block mb-1">Max follow-up turns <SaveFlash field={`${label}-maxFollowUp`} saved={saved} /></label>
              <NumberStepper value={a.maxFollowUpTurns} min={1} max={5} onChange={(v) => onPatchAgency(label, `${label}-maxFollowUp`, { maxFollowUpTurns: v })} />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const [config, setConfig] = useState<ParticipationConfigResponse | null>(null);
  const [decisions, setDecisions] = useState<ParticipationDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchParticipationConfig(), fetchParticipationDecisions(DECISION_LIMIT)])
      .then(([c, d]) => { setConfig(c); setDecisions(d.decisions ?? []); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const flash = useCallback((field: string) => {
    setSaved(field);
    setTimeout(() => setSaved(null), 1500);
  }, []);

  const handlePatchParticipation = useCallback(async (jid: string, field: string, patch: Record<string, unknown>) => {
    try {
      await patchParticipationGroup(jid, patch);
      flash(field);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }, [flash, loadData]);

  const handlePatchAgency = useCallback(async (label: string, field: string, patch: Record<string, unknown>) => {
    try {
      await patchAgencyPolicy(label, patch);
      flash(field);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }, [flash, loadData]);

  const rejectDecisions = decisions.filter((d) => !d.shouldIntervene);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Participation Settings</h2>
        <p className="text-sm text-muted-foreground">
          Tune Clint's group behaviour in real time. Changes take effect on the next message.
        </p>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-64 w-full rounded-xl" />)}
        </div>
      ) : config ? (
        <div className="space-y-6">
          {config.groups.map((g) => (
            <GroupSettingsCard
              key={g.chatJid}
              group={g}
              saved={saved}
              onPatchParticipation={handlePatchParticipation}
              onPatchAgency={handlePatchAgency}
            />
          ))}

          {/* Defaults reference */}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Hardcoded defaults (read-only)</summary>
            <pre className="mt-2 rounded border bg-muted p-3 text-xs overflow-x-auto">
              {JSON.stringify(config.defaults, null, 2)}
            </pre>
          </details>

          {/* Recent rejections */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent rejections</CardTitle>
            </CardHeader>
            <CardContent>
              {rejectDecisions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No rejections in the loaded sample.</p>
              ) : (
                <ul className="space-y-2 max-h-96 overflow-y-auto">
                  {rejectDecisions.slice(0, 30).map((d, i) => (
                    <li key={`${d.timestamp}-${i}`} className="flex items-center justify-between rounded border p-2 text-sm">
                      <div>
                        <span className="text-xs text-muted-foreground">{new Date(d.timestamp).toLocaleString()}</span>
                        <span className="ml-2 font-mono text-xs">{d.reason}</span>
                      </div>
                      <span className="tabular-nums text-xs text-muted-foreground">{d.confidence.toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
