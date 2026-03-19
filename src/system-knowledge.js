// System knowledge — seeds architecture and operational knowledge into EVO memory service
// Enables local-first answering of "how does X work?" and "what changed?" queries
// Auto-refreshes nightly at 2 AM to keep self-knowledge current
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { storeMemory, searchMemory, isEvoOnline, deleteMemory, listMemories } from './memory.js';
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

  return entries;
}

// Fallback entries if system-knowledge.json is missing
function generateFallbackEntries() {
  return [
    {
      fact: 'Clawd is a distributed WhatsApp admin assistant running on 3 devices: Raspberry Pi 5 (brain, Node.js), EVO X2 NucBox (voice + local AI, Ollama), and a Rust native dashboard on the Pi touchscreen.',
      tags: ['architecture', 'overview'],
    },
  ];
}

// Seed system knowledge into EVO memory service
export async function seedSystemKnowledge() {
  if (!config.evoMemoryEnabled || !isEvoOnline()) {
    logger.info('EVO offline — skipping system knowledge seed');
    return { seeded: 0, skipped: true };
  }

  const entries = generateKnowledgeEntries();
  let seeded = 0;
  let skipped = 0;

  for (const entry of entries) {
    try {
      // Check if a similar memory already exists (avoid duplicates)
      const existing = await searchMemory(entry.fact.slice(0, 50), KNOWLEDGE_CATEGORY, 1);
      if (existing.length > 0 && existing[0].score > 0.85) {
        skipped++;
        continue;
      }

      await storeMemory(entry.fact, KNOWLEDGE_CATEGORY, entry.tags, 1.0, KNOWLEDGE_SOURCE);
      seeded++;
    } catch (err) {
      logger.warn({ err: err.message, tags: entry.tags }, 'failed to seed system knowledge entry');
    }
  }

  logger.info({ seeded, skipped, total: entries.length }, 'system knowledge seeded');
  return { seeded, skipped };
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
    // 1. Find and delete all existing system_knowledge entries
    const allMemories = await listMemories();
    const systemEntries = allMemories.filter(m =>
      m.source === KNOWLEDGE_SOURCE || (m.category === KNOWLEDGE_CATEGORY && (m.tags || []).some(t =>
        ['architecture', 'overview', 'pipeline', 'router', 'tools', 'scheduler', 'voice', 'soul', 'memory', 'guardrails', 'version', 'tech', 'identity'].includes(t)
      ))
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
