/**
 * Core type definitions for Clawdbot.
 * These interfaces define the contracts between services.
 * Import from '#src/types' in TypeScript files.
 */

// --- Routing ---

export const RouteCategory = {
  CALENDAR: 'CALENDAR',
  EMAIL: 'EMAIL',
  TRAVEL: 'TRAVEL',
  TODO: 'TODO',
  SOUL: 'SOUL',
  GENERAL_KNOWLEDGE: 'GENERAL_KNOWLEDGE',
  PLANNING: 'PLANNING',
  LEGAL: 'LEGAL',
  GREETING: 'GREETING',
  MEMORY: 'MEMORY',
  SYSTEM: 'SYSTEM',
  VOICE: 'VOICE',
  PROJECT: 'PROJECT',
  EVOLUTION: 'EVOLUTION',
} as const;

export type RouteCategory = (typeof RouteCategory)[keyof typeof RouteCategory];

export interface ClassificationResult {
  category: RouteCategory;
  needsPlan: boolean;
  confidence: number;
  layer: 'classifier_4b' | 'keywords' | 'classifier_06b' | 'default';
}

// --- Messages ---

export interface IncomingMessage {
  text: string;
  sender: string;
  chatJid: string;
  isGroup: boolean;
  isOwner: boolean;
  quotedMessage?: { text: string; sender: string };
  timestamp: number;
}

// --- Memory ---

export interface MemoryEntry {
  id: string;
  fact: string;
  category: string;
  tags: string[];
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
  supersedes?: string;
}

export interface MemorySearchResult {
  entries: MemoryEntry[];
  query: string;
  searchTime: number;
}

// --- LLM ---

export interface LLMResponse {
  text: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  result: string;
  error?: string;
}

// --- Cortex ---

export interface CortexBundle {
  classification: ClassificationResult;
  relevantMemories: MemoryEntry[];
  identityMemories: MemoryEntry[];
  dreamMemories: MemoryEntry[];
  insightMemories: MemoryEntry[];
  lquorumContext: string;
  webPrefetchResult?: unknown;
}

// --- Config ---

export interface AppConfig {
  // Pi
  httpPort: number;
  dashboardToken: string;
  ownerJid: string;
  ownerLid: string;

  // EVO
  evoLlmUrl: string;
  evoClassifierUrl: string;
  evoMemoryUrl: string;
  evoEmbeddingUrl: string;

  // Cloud
  anthropicApiKey: string;
  minimaxBaseUrl: string;
  minimaxApiKey: string;
  minimaxModel: string;

  // Feature flags
  evoMemoryEnabled: boolean;
  evoClassifierEnabled: boolean;
}

// --- Service Interfaces (for DI) ---

export interface IMemoryService {
  search(query: string, limit?: number): Promise<MemorySearchResult>;
  store(fact: string, category: string, tags: string[], confidence?: number, source?: string): Promise<void>;
  isOnline(): boolean;
}

export interface IRouter {
  classify(message: IncomingMessage): Promise<ClassificationResult>;
}

export interface ILLMService {
  getResponse(params: {
    messages: Array<{ role: string; content: string }>;
    tools?: unknown[];
    model?: string;
    maxTokens?: number;
  }): Promise<LLMResponse>;
}
