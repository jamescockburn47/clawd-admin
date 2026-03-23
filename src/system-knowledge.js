// System knowledge — seeds architecture and operational knowledge into EVO memory service
// Enables local-first answering of "how does X work?" and "what changed?" queries
// Auto-refreshes nightly at 2 AM to keep self-knowledge current
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { storeMemory, searchMemory, isEvoOnline, deleteMemory, listMemories, syncCache } from './memory.js';
import config from './config.js';
import logger from './logger.js';

const KNOWLEDGE_SOURCE = 'system_knowledge';
const KNOWLEDGE_CATEGORY = 'system';
const KNOWLEDGE_FILE = join('data', 'system-knowledge.json');

// Load the structured knowledge document
function loadKnowledgeDoc() {
  try {
    if (!existsSync(KNOWLEDGE_FILE)) return null;
    return JSON.parse(readFileSync(KNOWLEDGE_FILE, 'utf-8'));
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to load system-knowledge.json');
    return null;
  }
}

// Generate memory entries from the structured knowledge document
function generateKnowledgeEntries() {
  const doc = loadKnowledgeDoc();
  if (!doc) return generateFallbackEntries();

  const entries = [];

  // Identity
  entries.push({
    fact: `I am ${doc.identity.name} (${doc.identity.fullName}), ${doc.identity.role} for ${doc.identity.owner} (${doc.identity.ownerRole}). ${doc.identity.personality}`,
    tags: ['identity', 'personality', 'overview'],
  });

  // Architecture overview
  entries.push({
    fact: doc.architecture.summary,
    tags: ['architecture', 'overview', 'hybrid'],
  });

  // Each device
  for (const device of doc.architecture.devices) {
    const hw = device.hardware ? ` Hardware: ${device.hardware}.` : '';
    entries.push({
      fact: `${device.name} (${device.ip || device.location}) — ${device.role}. Runs: ${device.runs}.${hw}`,
      tags: ['architecture', 'device', device.name.toLowerCase().replace(/\s+/g, '_')],
    });
  }

  // Message flow
  entries.push({
    fact: doc.messageFlow.summary,
    tags: ['routing', 'pipeline', 'messages'],
  });

  // Router layers
  const router = doc.messageFlow.router;
  entries.push({
    fact: `Smart router: ${router.layer0}. ${router.layer1}. ${router.layer2}. ${router.layer3}. ${router.writeDetection}. ${router.learnedRules}`,
    tags: ['router', 'classifier', 'keywords', 'llm'],
  });

  // Model selection
  const models = doc.messageFlow.modelSelection;
  entries.push({
    fact: `Model routing: Local conversational — ${models.local_conversational}. Complex/write — ${models.claude_complex}. Classifier — ${models.classifier}.`,
    tags: ['models', 'routing', 'llama-server', 'claude'],
  });

  // Tools (grouped)
  const toolLines = Object.entries(doc.tools)
    .map(([cat, tools]) => `${cat}: ${tools.join(', ')}`)
    .join('. ');
  entries.push({
    fact: `Tool inventory: ${toolLines}`,
    tags: ['tools', 'capabilities'],
  });

  // Scheduler
  entries.push({
    fact: `Scheduler (${doc.scheduler.interval} interval): ${doc.scheduler.tasks.join('. ')}.`,
    tags: ['scheduler', 'automation', 'reminders', 'briefing'],
  });

  // Voice pipeline
  entries.push({
    fact: doc.voicePipeline.summary,
    tags: ['voice', 'pipeline', 'whisper', 'tts'],
  });

  entries.push({
    fact: `Voice features: ${doc.voicePipeline.features.join('. ')}. Config: ${doc.voicePipeline.config}.`,
    tags: ['voice', 'features', 'wake', 'contacts'],
  });

  // Soul system
  entries.push({
    fact: doc.soulSystem.summary,
    tags: ['soul', 'personality', 'guardrails'],
  });

  // Memory system
  entries.push({
    fact: doc.memorySystem.summary,
    tags: ['memory', 'evo', 'vector', 'search'],
  });

  // Henry weekends
  entries.push({
    fact: doc.henryWeekends.summary,
    tags: ['henry', 'weekends', 'york', 'travel'],
  });

  // Guardrails
  entries.push({
    fact: `Critical guardrails: ${doc.guardrails.join(' ')}`,
    tags: ['guardrails', 'safety', 'restrictions'],
  });

  // Users
  for (const [name, desc] of Object.entries(doc.users)) {
    entries.push({
      fact: `User ${name}: ${desc}`,
      tags: ['users', 'access', name],
    });
  }

  // Self-improvement
  entries.push({
    fact: doc.selfImprovement.summary,
    tags: ['self-improvement', 'eval', 'learning'],
  });

  // Tech stack
  const stackLines = Object.entries(doc.techStack)
    .map(([k, v]) => `${k}: ${v}`)
    .join('. ');
  entries.push({
    fact: `Tech stack: ${stackLines}`,
    tags: ['tech', 'stack', 'dependencies'],
  });

  // Circuit breakers
  const cbLines = Object.entries(doc.circuitBreakers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('. ');
  entries.push({
    fact: `Circuit breakers: ${cbLines}`,
    tags: ['circuit-breaker', 'resilience', 'failover'],
  });

  // Version + changelog
  try {
    const versionPath = join(process.cwd(), 'version.json');
    if (existsSync(versionPath)) {
      const { version, notes } = JSON.parse(readFileSync(versionPath, 'utf-8'));
      if (notes && notes.length > 0) {
        entries.push({
          fact: `Current version: v${version}. Recent changes: ${notes.join('. ')}.`,
          tags: ['version', 'changelog', 'updates'],
        });
      }
    }
  } catch {}

  // Data persistence
  entries.push({
    fact: doc.dataPersistence.summary,
    tags: ['data', 'persistence', 'json', 'storage'],
  });

  // Subsystem entries — any field with a .summary that isn't already handled above
  const handledKeys = new Set([
    'identity', 'architecture', 'messageFlow', 'tools', 'scheduler',
    'voicePipeline', 'soulSystem', 'memorySystem', 'henryWeekends',
    'guardrails', 'users', 'selfImprovement', 'techStack',
    'circuitBreakers', 'dataPersistence', 'lquorum', 'version', 'lastUpdated',
  ]);
  for (const [key, val] of Object.entries(doc)) {
    if (handledKeys.has(key)) continue;
    if (val && typeof val === 'object' && val.summary) {
      entries.push({
        fact: val.summary,
        tags: [key.replace(/([A-Z])/g, '_$1').toLowerCase(), 'subsystem'],
      });
      // Also add any additional string fields beyond summary
      for (const [subKey, subVal] of Object.entries(val)) {
        if (subKey === 'summary' || typeof subVal !== 'string') continue;
        entries.push({
          fact: subVal,
          tags: [key.replace(/([A-Z])/g, '_$1').toLowerCase(), subKey, 'subsystem'],
        });
      }
    }
  }

  // LQuorum knowledge — single overview entry
  // Full depth is handled by conversational working memory (src/lquorum-rag.js)
  if (doc.lquorum) {
    entries.push({
      fact: `LQuorum community knowledge covers 18 legal AI topics from 40+ lawyers across 12 jurisdictions. Topics include RAG/hallucinations, document processing, DOCX problems, data security, platform reviews, local models, vibe coding, contract review AI, and more. Full knowledge is available through conversational working memory when these topics are discussed.`,
      tags: ['lquorum', 'legal-ai', 'community', 'knowledge'],
    });
    logger.info('LQuorum overview entry generated (full depth via working memory)');
  }

  return entries;
}

// Fallback entries if system-knowledge.json is missing
function generateFallbackEntries() {
  return [
    {
      fact: 'Clawd is a distributed WhatsApp admin assistant: Raspberry Pi 5 runs Node.js (Baileys, HTTP API, scheduler). EVO X2 runs llama-server (OpenAI-compatible, tools + classifier), memory service (port 5100), Whisper + voice listener, and optional Ollama for embeddings. The Pi touchscreen runs a Rust (egui) dashboard against localhost:3000.',
      tags: ['architecture', 'overview'],
    },
  ];
}

// Seed system knowledge into EVO memory service
// Uses wipe-and-reseed to prevent stale duplicates accumulating
export async function seedSystemKnowledge() {
  if (!config.evoMemoryEnabled || !isEvoOnline()) {
    logger.info('EVO offline — skipping system knowledge seed');
    return { seeded: 0, skipped: true };
  }

  // Wipe ALL old system knowledge entries (any source, any category that matches)
  let deleted = 0;
  try {
    const allMemories = await listMemories();
    const staleEntries = allMemories.filter(m =>
      m.source === KNOWLEDGE_SOURCE
      || m.source === 'system_knowledge_seed'
      || (m.category === KNOWLEDGE_CATEGORY && m.source !== 'dream_mode' && m.source !== 'conversation')
    );
    for (const entry of staleEntries) {
      try {
        await deleteMemory(entry.id);
        deleted++;
      } catch {}
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to clean old system knowledge');
  }

  // Re-seed fresh from current system-knowledge.json
  const entries = generateKnowledgeEntries();
  let seeded = 0;

  for (const entry of entries) {
    try {
      await storeMemory(entry.fact, KNOWLEDGE_CATEGORY, entry.tags, 1.0, KNOWLEDGE_SOURCE);
      seeded++;
    } catch (err) {
      logger.warn({ err: err.message, tags: entry.tags }, 'failed to seed system knowledge entry');
    }
  }

  // Force cache sync so Pi immediately has fresh data
  try { await syncCache(); } catch {}

  logger.info({ deleted, seeded, total: entries.length }, 'system knowledge seeded');
  return { deleted, seeded };
}

// Nightly full refresh — wipes old system knowledge entries and re-seeds from current state
// Called at 2 AM by the scheduler to keep the bot's self-awareness current
export async function refreshSystemKnowledge() {
  if (!config.evoMemoryEnabled || !isEvoOnline()) {
    logger.info('EVO offline — skipping system knowledge refresh');
    return { refreshed: false, reason: 'evo_offline' };
  }

  const startTime = Date.now();

  try {
    // 1. Find and delete all existing system knowledge entries (broad filter — catches all sources)
    const allMemories = await listMemories();
    const systemEntries = allMemories.filter(m =>
      m.source === KNOWLEDGE_SOURCE
      || m.source === 'system_knowledge_seed'
      || (m.category === KNOWLEDGE_CATEGORY && m.source !== 'dream_mode' && m.source !== 'conversation')
    );

    let deleted = 0;
    for (const entry of systemEntries) {
      try {
        await deleteMemory(entry.id);
        deleted++;
      } catch (err) {
        logger.warn({ id: entry.id, err: err.message }, 'failed to delete old system knowledge');
      }
    }

    // 2. Update the knowledge doc timestamp
    try {
      const doc = loadKnowledgeDoc();
      if (doc) {
        doc.lastUpdated = new Date().toISOString();
        // Update version from version.json
        try {
          const vPath = join(process.cwd(), 'version.json');
          if (existsSync(vPath)) {
            const { version } = JSON.parse(readFileSync(vPath, 'utf-8'));
            doc.version = version;
          }
        } catch {}
        writeFileSync(KNOWLEDGE_FILE, JSON.stringify(doc, null, 2));
      }
    } catch {}

    // 3. Re-seed all entries fresh
    const entries = generateKnowledgeEntries();
    let seeded = 0;

    for (const entry of entries) {
      try {
        await storeMemory(entry.fact, KNOWLEDGE_CATEGORY, entry.tags, 1.0, KNOWLEDGE_SOURCE);
        seeded++;
      } catch (err) {
        logger.warn({ err: err.message, tags: entry.tags }, 'failed to seed refreshed knowledge');
      }
    }

    // Force cache sync so Pi immediately has fresh data
    try { await syncCache(); } catch {}

    const elapsed = Date.now() - startTime;
    logger.info({ deleted, seeded, elapsed }, 'system knowledge refreshed');
    return { refreshed: true, deleted, seeded, elapsed };
  } catch (err) {
    logger.error({ err: err.message }, 'system knowledge refresh failed');
    return { refreshed: false, error: err.message };
  }
}

// Get a live system snapshot for context injection (complements stored knowledge)
export async function getLiveSystemSnapshot() {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  const waConnected = globalThis._clawdWhatsAppConnected || false;

  let evoStatus = 'unknown';
  try {
    const { checkEvoHealth } = await import('./evo-llm.js');
    evoStatus = await checkEvoHealth() ? 'online' : 'offline';
  } catch { evoStatus = 'check failed'; }

  const { getRoutingStats } = await import('./router-telemetry.js');
  const routerStats = getRoutingStats();

  return `\n\n## Live System Status (${new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })})
- Pi: running ${hours}h ${mins}m, ${(mem.rss / 1048576).toFixed(0)}MB RSS
- WhatsApp: ${waConnected ? 'connected' : 'disconnected'}
- EVO X2 llama-server: ${evoStatus}
- Routing today: ${routerStats.total > 0 ? `${routerStats.local} local, ${routerStats.claude} Claude, ${routerStats.fallback} fallbacks` : 'no messages yet'}`;
}
