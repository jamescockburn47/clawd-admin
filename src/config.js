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
  httpPort: parseInt(process.env.HTTP_PORT) || 8080,
  dashboardToken: process.env.DASHBOARD_TOKEN || '',

  // EVO X2 local models via llama.cpp (OpenAI-compatible API)
  evoLlmUrl: process.env.EVO_LLM_URL || 'http://10.0.0.2:8080',           // Main tool-calling server (direct ethernet)
  evoClassifierUrl: process.env.EVO_CLASSIFIER_URL || 'http://10.0.0.2:8081', // Fast classifier server
  evoToolEnabled: process.env.EVO_TOOL_ENABLED !== 'false',

  // Weather (Open-Meteo — free, no API key)
  weatherEnabled: process.env.WEATHER_ENABLED !== 'false',
  weatherLocations: (process.env.WEATHER_LOCATIONS || 'London,York').split(',').map(s => s.trim()),

  // Morning briefing
  briefingEnabled: process.env.BRIEFING_ENABLED !== 'false',
  briefingTime: process.env.BRIEFING_TIME || '07:00',

  // EVO X2 Memory Service
  evoMemoryUrl: process.env.EVO_MEMORY_URL || 'http://192.168.1.230:5100',
  evoMemoryEnabled: process.env.EVO_MEMORY_ENABLED !== 'false',
};

export default config;
