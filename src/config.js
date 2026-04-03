import { z } from 'zod';

// --- Schema ---
// Validates all config on startup. Fast-fail on bad/missing env vars.
// Note: bot runs on EVO (localhost URLs), Pi is screen + backup.

const boolFromEnv = z.string().optional().transform(v => v !== 'false').pipe(z.boolean());
const intFromEnv = (fallback) => z.string().optional().transform(v => parseInt(v) || fallback).pipe(z.number());
const floatFromEnv = (fallback) => z.string().optional().transform(v => parseFloat(v) || fallback).pipe(z.number());

const ConfigSchema = z.object({
  // Required
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  // Cloud models
  CLAUDE_MODEL: z.string().optional().default('claude-sonnet-4-6'),
  MINIMAX_API_KEY: z.string().optional().default(''),
  MINIMAX_BASE_URL: z.string().optional().default('https://api.minimax.io/anthropic'),
  MINIMAX_MODEL: z.string().optional().default('MiniMax-M2.7'),
  MINIMAX_ENABLED: boolFromEnv.default('true'),

  // WhatsApp
  WHATSAPP_GROUP_JID: z.string().optional().default(''),
  TRIGGER_PREFIX: z.string().optional().default('/clawd'),
  RANDOM_REPLY_CHANCE: floatFromEnv(0.05).default('0.05'),
  KEYWORD_BOOST_CHANCE: floatFromEnv(0.25).default('0.25'),
  RANDOM_COOLDOWN_SECONDS: intFromEnv(300).default('300'),
  CONTEXT_MESSAGE_COUNT: intFromEnv(10).default('10'),
  MAX_RESPONSE_TOKENS: intFromEnv(1000).default('1000'),
  DAILY_CALL_LIMIT: intFromEnv(100).default('100'),
  AUTH_STATE_PATH: z.string().optional().default('./auth_state'),
  PAIRING_PHONE_NUMBER: z.string().optional().default(''),

  // Owner (James)
  OWNER_JID: z.string().optional().default(''),
  OWNER_LID: z.string().optional().default(''),

  // Travel APIs
  DARWIN_TOKEN: z.string().optional().default(''),
  AMADEUS_CLIENT_ID: z.string().optional().default(''),
  AMADEUS_CLIENT_SECRET: z.string().optional().default(''),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REFRESH_TOKEN: z.string().optional().default(''),

  // Web search
  BRAVE_API_KEY: z.string().optional().default(''),

  // Dashboard — Pi connects to EVO's HTTP server
  HTTP_PORT: intFromEnv(3000).default('3000'),
  DASHBOARD_TOKEN: z.string().optional().default(''),

  // Model labels for system_status tool
  EVO_MAIN_MODEL_LABEL: z.string().optional().default('llama-server :8080 (EVO X2, main LLM)'),
  EVO_CLASSIFIER_LABEL: z.string().optional().default('llama-server :8081 (EVO X2, classifier)'),
  EVO_PLANNER_LABEL: z.string().optional().default('llama-server :8085 (EVO X2, 4B planner/classifier)'),

  // Local models via llama.cpp — bot runs on EVO, all localhost
  EVO_LLM_URL: z.string().url().optional().default('http://localhost:8080'),
  EVO_CLASSIFIER_URL: z.string().url().optional().default('http://localhost:8081'),
  EVO_PLANNER_URL: z.string().url().optional().default('http://localhost:8085'),
  EVO_TOOL_ENABLED: boolFromEnv.default('true'),
  EVO_EMBED_URL: z.string().url().optional().default('http://localhost:8083'),
  EVO_DOCLING_URL: z.string().url().optional().default('http://localhost:8084'),
  EVO_SEARXNG_URL: z.string().url().optional().default('http://localhost:8888'),

  // Weather
  WEATHER_ENABLED: boolFromEnv.default('true'),
  WEATHER_LOCATIONS: z.string().optional().default('London,York'),

  // Briefing
  BRIEFING_ENABLED: boolFromEnv.default('true'),
  BRIEFING_TIME: z.string().optional().default('07:00'),

  // Group engagement
  GROUP_MUTE_DURATION_MS: intFromEnv(600000).default('600000'),
  ENGAGEMENT_CLASSIFIER_ENABLED: boolFromEnv.default('true'),
  DREAM_MODE_ENABLED: boolFromEnv.default('true'),

  // Memory service (localhost — bot runs on EVO)
  EVO_MEMORY_URL: z.string().url().optional().default('http://localhost:5100'),
  EVO_MEMORY_ENABLED: boolFromEnv.default('true'),

  // EVO SSH access (for evolution executor — Pi reaches EVO via direct ethernet)
  EVO_SSH_HOST: z.string().optional().default('10.0.0.2'),
  EVO_SSH_USER: z.string().optional().default('james'),
  EVO_REPO_PATH: z.string().optional().default('/home/james/clawdbot-claude-code'),

  // Professional groups (comma-separated JIDs)
  PROFESSIONAL_GROUPS: z.string().optional().default(''),
});

// --- Parse & validate ---
const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\n  FATAL: Invalid configuration:\n${errors}\n`);
  process.exit(1);
}

const env = parsed.data;

// --- Exported config object (same shape as before — zero breaking changes) ---
const config = {
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  claudeModel: env.CLAUDE_MODEL,

  minimaxApiKey: env.MINIMAX_API_KEY,
  minimaxBaseUrl: env.MINIMAX_BASE_URL,
  minimaxModel: env.MINIMAX_MODEL,
  minimaxEnabled: env.MINIMAX_ENABLED,

  whatsappGroupJid: env.WHATSAPP_GROUP_JID,
  triggerPrefix: env.TRIGGER_PREFIX,
  randomReplyChance: env.RANDOM_REPLY_CHANCE,
  keywordBoostChance: env.KEYWORD_BOOST_CHANCE,
  randomCooldownSeconds: env.RANDOM_COOLDOWN_SECONDS,
  contextMessageCount: env.CONTEXT_MESSAGE_COUNT,
  maxResponseTokens: env.MAX_RESPONSE_TOKENS,
  dailyCallLimit: env.DAILY_CALL_LIMIT,
  authStatePath: env.AUTH_STATE_PATH,
  pairingPhoneNumber: env.PAIRING_PHONE_NUMBER,

  ownerJid: env.OWNER_JID,
  ownerLid: env.OWNER_LID,

  darwinToken: env.DARWIN_TOKEN,
  amadeusClientId: env.AMADEUS_CLIENT_ID,
  amadeusClientSecret: env.AMADEUS_CLIENT_SECRET,

  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
  googleRefreshToken: env.GOOGLE_REFRESH_TOKEN,

  braveApiKey: env.BRAVE_API_KEY,

  httpPort: env.HTTP_PORT,
  dashboardToken: env.DASHBOARD_TOKEN,

  evoMainModelLabel: env.EVO_MAIN_MODEL_LABEL,
  evoClassifierLabel: env.EVO_CLASSIFIER_LABEL,
  evoPlannerLabel: env.EVO_PLANNER_LABEL,

  evoLlmUrl: env.EVO_LLM_URL,
  evoClassifierUrl: env.EVO_CLASSIFIER_URL,
  evoPlannerUrl: env.EVO_PLANNER_URL,
  evoToolEnabled: env.EVO_TOOL_ENABLED,
  evoEmbedUrl: env.EVO_EMBED_URL,
  evoDoclingUrl: env.EVO_DOCLING_URL,
  evoSearxngUrl: env.EVO_SEARXNG_URL,

  weatherEnabled: env.WEATHER_ENABLED,
  weatherLocations: env.WEATHER_LOCATIONS.split(',').map(s => s.trim()),

  briefingEnabled: env.BRIEFING_ENABLED,
  briefingTime: env.BRIEFING_TIME,

  groupMuteDurationMs: env.GROUP_MUTE_DURATION_MS,
  engagementClassifierEnabled: env.ENGAGEMENT_CLASSIFIER_ENABLED,
  dreamModeEnabled: env.DREAM_MODE_ENABLED,

  evoMemoryUrl: env.EVO_MEMORY_URL,
  evoMemoryEnabled: env.EVO_MEMORY_ENABLED,

  evoSshHost: env.EVO_SSH_HOST,
  evoSshUser: env.EVO_SSH_USER,
  evoRepoPath: env.EVO_REPO_PATH,

  professionalGroups: env.PROFESSIONAL_GROUPS.split(',').map(s => s.trim()).filter(Boolean),
};

Object.freeze(config);
export default config;
