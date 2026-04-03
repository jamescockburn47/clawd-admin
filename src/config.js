const required = ['ANTHROPIC_API_KEY'];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`\n  FATAL: ${key} is not set.\n  Copy .env.example to .env and fill in your API key.\n`);
    process.exit(1);
  }
}

const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',

  // MiniMax M2.7 — default cloud model (Anthropic-compatible API)
  minimaxApiKey: process.env.MINIMAX_API_KEY || '',
  minimaxBaseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic',
  minimaxModel: process.env.MINIMAX_MODEL || 'MiniMax-M2.7',
  minimaxEnabled: process.env.MINIMAX_ENABLED !== 'false',
  whatsappGroupJid: process.env.WHATSAPP_GROUP_JID || '',
  triggerPrefix: process.env.TRIGGER_PREFIX || '/clawd',
  randomReplyChance: parseFloat(process.env.RANDOM_REPLY_CHANCE) || 0.05,
  keywordBoostChance: parseFloat(process.env.KEYWORD_BOOST_CHANCE) || 0.25,
  randomCooldownSeconds: parseInt(process.env.RANDOM_COOLDOWN_SECONDS) || 300,
  contextMessageCount: parseInt(process.env.CONTEXT_MESSAGE_COUNT) || 10,
  maxResponseTokens: parseInt(process.env.MAX_RESPONSE_TOKENS) || 1000,
  dailyCallLimit: parseInt(process.env.DAILY_CALL_LIMIT) || 100,
  authStatePath: process.env.AUTH_STATE_PATH || './auth_state',
  pairingPhoneNumber: process.env.PAIRING_PHONE_NUMBER || '',

  // Owner (James) — for proactive outbound messages
  ownerJid: process.env.OWNER_JID || '',
  ownerLid: process.env.OWNER_LID || '',

  // Travel APIs
  darwinToken: process.env.DARWIN_TOKEN || '',
  amadeusClientId: process.env.AMADEUS_CLIENT_ID || '',
  amadeusClientSecret: process.env.AMADEUS_CLIENT_SECRET || '',

  // Google OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',

  // Web search
  braveApiKey: process.env.BRAVE_API_KEY || '',

  // Dashboard
  httpPort: parseInt(process.env.HTTP_PORT) || 3000,
  dashboardToken: process.env.DASHBOARD_TOKEN || '',

  // Human-readable labels for system_status tool (override if models change)
  evoMainModelLabel: process.env.EVO_MAIN_MODEL_LABEL || 'llama-server :8080 (EVO X2, main LLM)',
  evoClassifierLabel: process.env.EVO_CLASSIFIER_LABEL || 'llama-server :8081 (EVO X2, classifier)',
  evoPlannerLabel: process.env.EVO_PLANNER_LABEL || 'llama-server :8085 (EVO X2, 4B planner/classifier)',

  // Local models via llama.cpp (OpenAI-compatible API) — bot runs on EVO now
  evoLlmUrl: process.env.EVO_LLM_URL || 'http://localhost:8080',           // Main tool-calling server
  evoClassifierUrl: process.env.EVO_CLASSIFIER_URL || 'http://localhost:8081', // Fast classifier server (0.6B engagement)
  evoPlannerUrl: process.env.EVO_PLANNER_URL || 'http://localhost:8085',      // 4B category + needsPlan classifier
  evoToolEnabled: process.env.EVO_TOOL_ENABLED !== 'false',
  evoEmbedUrl: process.env.EVO_EMBED_URL || 'http://localhost:8083',         // Embedding server
  evoDoclingUrl: process.env.EVO_DOCLING_URL || 'http://localhost:8084',     // Granite-Docling document parsing
  evoSearxngUrl: process.env.EVO_SEARXNG_URL || 'http://localhost:8888',    // SearXNG web search (Docker)

  // Weather (Open-Meteo — free, no API key)
  weatherEnabled: process.env.WEATHER_ENABLED !== 'false',
  weatherLocations: (process.env.WEATHER_LOCATIONS || 'London,York').split(',').map(s => s.trim()),

  // Morning briefing
  briefingEnabled: process.env.BRIEFING_ENABLED !== 'false',
  briefingTime: process.env.BRIEFING_TIME || '07:00',

  // Group engagement
  groupMuteDurationMs: parseInt(process.env.GROUP_MUTE_DURATION_MS) || 600000, // 10 min
  engagementClassifierEnabled: process.env.ENGAGEMENT_CLASSIFIER_ENABLED !== 'false',
  dreamModeEnabled: process.env.DREAM_MODE_ENABLED !== 'false',

  // Memory Service (localhost — bot runs on EVO)
  evoMemoryUrl: process.env.EVO_MEMORY_URL || 'http://localhost:5100',
  evoMemoryEnabled: process.env.EVO_MEMORY_ENABLED !== 'false',

  // EVO SSH access (for evolution executor, overnight report, etc.)
  evoSshHost: process.env.EVO_SSH_HOST || '10.0.0.2',
  evoSshUser: process.env.EVO_SSH_USER || 'james',
  evoRepoPath: process.env.EVO_REPO_PATH || '/home/james/clawdbot-claude-code',

  // Group type classification — gates personal content from professional groups
  // Format: comma-separated JID:type pairs. Types: personal, professional
  // Groups not listed default to 'personal' (full access)
  // Professional groups get NO personal info (travel, henry, todos, diary, family)
  professionalGroups: (process.env.PROFESSIONAL_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean),
};

Object.freeze(config);
export default config;
