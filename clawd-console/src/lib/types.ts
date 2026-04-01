// API response type definitions for Clawd Console

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
    deployed: number;
    failed: number;
    rejected: number;
    awaiting: number;
    pending: number;
    rateLimit: { used: number; max: number; allowed: boolean };
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
