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
  dashboardToken: process.env.DASHBOARD_TOKEN || '',
};

export default config;
