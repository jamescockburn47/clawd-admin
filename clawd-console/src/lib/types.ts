// API response type definitions for Clint Console

// PiStatus — from GET /api/status
export interface PiStatus {
  connected: boolean;
  name: string | null;
  jid: string | null;
  lastActivity: string | null;
  uptime: number; // seconds
  memoryMB: number;
}

// SystemHealth — from GET /api/system-health
export interface SystemHealth {
  whatsapp?: { status: string };
  evo?: { status: string };
  briefing?: { lastRun: string | null };
  diary?: { lastRun: string | null };
  memory?: { total: number; categories: Record<string, number> };
  uptime: number;
  memoryMB: number;
  nodeHeapMB?: number;
  evoSystem?: {
    vramGB: number;
    totalRamMB: number;
    usedRamMB: number;
    cores: number;
  };
  [key: string]: unknown;
}

// EvoStatus — from GET /api/evo
export interface EvoStatus {
  online?: boolean;
  available?: boolean;
  url: string;
  model?: string;
  queueDepth?: number;
}

// TraceAnalysis — from GET /api/traces
export interface TraceAnalysis {
  analysedAt: string;
  periodDays: number;
  totalTraces: number;
  routing: {
    counts: Record<string, number>;
    percentages: Record<string, number>;
  };
  categories: Record<string, number>;
  models: {
    distribution: Record<string, number>;
    reasons: Record<string, number>;
  };
  plans: {
    totalPlans: number;
    statuses: Record<string, number>;
    avgSteps: number;
    avgTimeMs: number;
    failureReasons: Array<{ tool: string; error: string; planGoal: string }>;
    toolUsage: Record<string, number>;
    adaptationRate: number;
  };
  needsPlan: {
    predictedTrue: number;
    predictedFalse: number;
    actualMultiTool: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
    f1: number;
  };
  qualityGate: {
    totalGated: number;
    percentage: number;
    byCategory: Record<string, number>;
  };
  timing: {
    routingAvgMs: number | null;
    routingP95Ms: number | null;
    totalAvgMs: number | null;
    totalP95Ms: number | null;
  };
  anomalies: Array<{
    type: string;
    severity: 'warning' | 'info';
    detail: string;
    suggestion: string;
  }>;
}

// DreamQuality — quality metrics per group
export interface DreamQuality {
  message_count: number;
  skipped: boolean;
  skip_reason?: string;
  facts_new: number;
  facts_skipped_dedup: number;
  facts_superseded: number;
  insights_new: number;
  insights_skipped: number;
  diary_words?: number;
}

export interface DreamFact {
  fact: string;
  tags: string[];
  confidence: number;
}

export interface DreamInsight {
  insight: string;
  topics: string[];
  evidence?: string[];
}

export interface DreamObservation {
  text: string;
  section: string;
  severity: 'routine' | 'corrective' | 'critical';
}

export interface DreamVerbatim {
  quote: string;
  speaker: string;
  context: string;
}

// DreamGroup — per-group overnight data
export interface DreamGroup {
  group_id: string;
  message_count: number;
  diary: string;
  facts: DreamFact[];
  insights: DreamInsight[];
  observations: DreamObservation[];
  verbatim: DreamVerbatim[];
  warnings: string[];
  quality?: DreamQuality;
}

// OvernightReport — full overnight report
export interface OvernightReport {
  date: string;
  groups_processed: number;
  groups: DreamGroup[];
  documents_processed?: number;
  totals: {
    facts: number;
    insights: number;
    observations: number;
  };
  source?: string;
}

// EvolutionTask — from GET /api/pi/evolution/list
export interface EvolutionTask {
  id: string;
  source: string;
  instruction: string;
  priority: string;
  status: 'pending' | 'running' | 'awaiting_approval' | 'approved' | 'deployed' | 'failed' | 'rejected';
  created: string; // ISO timestamp
  branch: string;
  diff_summary: string | null;
  diff_detail: string | null;
  manifest: {
    files_to_modify?: string[];
    estimated_lines_changed?: number;
    approach?: string;
    risks?: string;
  } | null;
  total_lines: number | null;
  files_changed: string[];
  result: string | null;
}

export interface EvolutionListResponse {
  report: {
    deployed: unknown[];
    failed: unknown[];
    rejected: unknown[];
    awaiting: unknown[];
    pending: unknown[];
    rateLimit: {
      allowed: boolean;
      reason: string | null;
      todayCount: number;
      dailyMax: number;
      // Legacy aliases (console compat)
      used?: number;
      max?: number;
    };
  };
  tasks: EvolutionTask[];
}

export interface RetrospectivePriority {
  rank: number;
  title: string;
  issue: string;
  impact: string;
  fix: string;
  files: string[];
  severity: 'high' | 'medium' | 'low';
  evolution_instruction?: string;
}

export interface Retrospective {
  overallHealth: 'good' | 'fair' | 'poor';
  healthReason: string;
  priorities: RetrospectivePriority[];
  evolutionTasksCreated?: Array<{ title: string; taskId: string }>;
}

// --- Overnight event log (from GET /api/overnight-events/:date) ---
// Mirrors src/overnight/events.ts on the bot side. Spec:
// docs/superpowers/specs/2026-04-10-overnight-digest-and-console-design.md §4.6
export type OvernightStage =
  | 'consolidate'
  | 'probe'
  | 'report'
  | 'improve'
  | 'operations';

export type OvernightVerdict =
  | 'ok'
  | 'rejected'
  | 'failed'
  | 'skipped'
  | 'null';

export interface OvernightEvent {
  id: string;
  timestamp: string; // ISO 8601
  stage: OvernightStage;
  phase: string;
  inputs: string[];
  outputs: string[];
  verdict: OvernightVerdict;
  reason: string;
  evidence_refs: string[];
  rollback_ref: string | null;
  budget: {
    opus_sessions: number;
    tokens: number;
  };
}

export interface ShadowCandidate {
  timestamp: string;
  candidate: {
    text: string;
    category: string;
    confidence: number;
    sources: Array<{ hash: string; excerpt: string }>;
    [key: string]: unknown;
  };
}

export interface OvernightEventsResponse {
  date: string;
  events: OvernightEvent[];
  shadowCandidates: ShadowCandidate[];
}

export type MorningObservationKind =
  | 'pattern'
  | 'candidate'
  | 'drift'
  | 'quality_failure';

export interface MorningObservationBase {
  kind: MorningObservationKind;
  date: string;
  evidence_refs: string[];
  weight: number;
}

export interface MorningPatternObservation extends MorningObservationBase {
  kind: 'pattern';
  observation: string;
}

export interface MorningCandidateObservation extends MorningObservationBase {
  kind: 'candidate';
  title: string;
  category: string;
  predicted_benefit: string;
  scope: string;
  rough_cost: string;
}

export interface MorningDriftObservation extends MorningObservationBase {
  kind: 'drift';
  original_timestamp: string;
  input_hash: string;
  diff_summary: string;
  judged: 'better' | 'worse' | 'neutral';
  reason: string;
}

export interface MorningQualityFailureObservation extends MorningObservationBase {
  kind: 'quality_failure';
  category: string;
  cortex_summary?: string;
  memory_count?: number;
  tools_fired?: string[];
  rejection_reason: string;
}

export type MorningObservation =
  | MorningPatternObservation
  | MorningCandidateObservation
  | MorningDriftObservation
  | MorningQualityFailureObservation;

export interface MorningReportSummary {
  consolidateEvents: number;
  probeEvents: number;
  operationsEvents: number;
  reportEvents: number;
  improveEvents: number;
  memoryStored: number;
  memoryRejected: number;
  patternsObserved: number;
  candidatesProposed: number;
  driftAlertsThisWeek: number;
  qualityFailuresThisWeek: number;
  backupOk: boolean;
  traceAnalysisOk: boolean;
}

export interface MorningReportBudget {
  opus_sessions_used: number;
  tokens_used: number;
}

/** Aggregated from participation decision JSONL for the report date (UTC). */
export interface ParticipationLearningSummary {
  reviewed: number;
  accepted: number;
  overstayed: number;
  missedOpenings: number;
  crossChecks?: {
    taggedInteractions: number;
    taggedTraces: number;
  };
}

export interface MorningReport {
  date: string;
  mode: 'cheap' | 'deep' | 'emergency';
  events: OvernightEvent[];
  errors: OvernightEvent[];
  summary: MorningReportSummary;
  newThisWeek: MorningObservation[];
  continuingWithFreshEvidence: MorningObservation[];
  driftAlerts: MorningDriftObservation[];
  deferredCandidates: MorningCandidateObservation[];
  archive: MorningObservation[];
  budget: MorningReportBudget;
  /** Present on rebuilt reports; older cached payloads may omit. */
  participationSummary?: ParticipationLearningSummary | null;
}

export interface MorningReportResponse {
  date: string;
  report: MorningReport;
  text: string;
}

// Group participation — GET /api/participation/groups, /api/participation/decisions (bot dashboard)
export type ParticipationPosture = 'direct_only' | 'rare_high_confidence' | 'active_participant';

export type ParticipationGroupMode = 'open' | 'project' | 'colleague';

export interface ParticipationGroupSummary {
  chatJid: string;
  groupLabel: string;
  groupMode: ParticipationGroupMode;
  posture: ParticipationPosture;
  researchEnabled: boolean;
  memoryRecallEnabled: boolean;
  maxUnsolicitedPerHour: number;
  followUpWindowMs: number;
  cooldownMs: number;
}

export interface ParticipationDecisionReplyTarget {
  kind: 'quoted';
  messageId: string;
  senderName: string;
}

export interface ParticipationDecision {
  timestamp: string;
  chatJid: string;
  shouldIntervene: boolean;
  interventionType: string | null;
  reason: string;
  confidence: number;
  replyTarget: ParticipationDecisionReplyTarget | null;
  followUpWindowOpen: boolean;
  followUpTurnIndex: number | null;
  profilePosture: string | null;
  plannedRole: string | null;
}

export interface ParticipationGroupsResponse {
  groups: ParticipationGroupSummary[];
}

export interface ParticipationDecisionsResponse {
  decisions: ParticipationDecision[];
}

// --- Participation config (combined read + write) ---

export interface ParticipationGroupConfig {
  chatJid: string;
  label: string;
  mode: ParticipationGroupMode;
  participation: {
    posture: ParticipationPosture;
    researchEnabled: boolean;
    memoryRecallEnabled: boolean;
    maxUnsolicitedPerHour: number;
    followUpWindowMs: number;
    cooldownMs: number;
  };
}

export interface ParticipationConfigResponse {
  groups: ParticipationGroupConfig[];
  defaults: {
    participation: {
      posture: ParticipationPosture;
      researchEnabled: boolean;
      memoryRecallEnabled: boolean;
      maxUnsolicitedPerHour: number;
      followUpWindowMs: number;
      cooldownMs: number;
    };
  };
}

export interface ParticipationOverridePatch {
  posture?: ParticipationPosture;
  researchEnabled?: boolean;
  memoryRecallEnabled?: boolean;
  maxUnsolicitedPerHour?: number;
  followUpWindowMs?: number;
  cooldownMs?: number;
}
