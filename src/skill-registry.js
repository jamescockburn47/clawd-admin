// Skill registry — auto-discovers and manages forge-authored skills.
// Skills are JS modules in src/skills/ that export a default object
// conforming to the skill contract (name, canHandle, execute, etc.).

import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, 'skills');

let skills = [];

/**
 * Auto-discover and load all skill modules from src/skills/.
 * Skips files starting with _ and non-.js files.
 * Validates each skill has at minimum: name + canHandle function.
 */
export async function loadSkills() {
  skills = [];
  let files;
  try {
    files = await readdir(SKILLS_DIR);
  } catch (err) {
    logger.error({ err }, 'Failed to read skills directory');
    return skills;
  }

  const jsFiles = files.filter(
    (f) => f.endsWith('.js') && !f.startsWith('_')
  );

  for (const file of jsFiles) {
    try {
      const fullPath = join(SKILLS_DIR, file);
      const mod = await import(pathToFileURL(fullPath).href);
      const skill = mod.default || mod;

      if (!skill.name || typeof skill.canHandle !== 'function') {
        logger.warn({ file }, 'Skill missing required contract fields (name, canHandle) — skipped');
        continue;
      }

      // Ensure metrics object exists
      if (!skill.metrics) {
        skill.metrics = { timesTriggered: 0, lastTriggered: null };
      }

      skills.push(skill);
      logger.info({ skill: skill.name, version: skill.version }, 'Loaded skill');
    } catch (err) {
      logger.error({ err, file }, 'Failed to load skill');
    }
  }

  return skills;
}

/**
 * Returns all skills where _disabled is not true.
 */
export function getActiveSkills() {
  return skills.filter((s) => !s._disabled);
}

/**
 * Returns skills whose canHandle returns true for the given message/context.
 * Errors in canHandle are caught — a broken skill never blocks routing.
 */
export function getSkillsForMessage(msg, context) {
  const active = getActiveSkills();
  const matching = [];
  for (const skill of active) {
    try {
      if (skill.canHandle(msg, context)) {
        matching.push(skill);
      }
    } catch (err) {
      logger.error({ err, skill: skill.name }, 'Error in skill canHandle');
    }
  }
  return matching;
}

/**
 * Post-process a response through matching skills.
 * Each matching skill's execute() is called in order.
 * If execute returns a non-empty string, it replaces the response.
 * Skill failures are caught silently — original response preserved.
 */
export async function runSkillPostProcessors(response, msg, context) {
  const matching = getSkillsForMessage(msg, context);
  let current = response;

  for (const skill of matching) {
    try {
      const result = await skill.execute(msg, { ...context, response: current });
      if (result && typeof result === 'string') {
        current = result;
      }
      // Track metrics
      skill.metrics.timesTriggered++;
      skill.metrics.lastTriggered = new Date().toISOString();
    } catch (err) {
      logger.error({ err, skill: skill.name }, 'Error in skill execute — original response preserved');
    }
  }

  return current;
}

/**
 * Natural-language description of installed forge-authored skills.
 */
export function describeCapabilities() {
  const active = getActiveSkills();
  if (active.length === 0) return 'No forge-authored skills installed.';

  const lines = active.map((s) => {
    const triggers = s.triggers?.length
      ? s.triggers.join('; ')
      : 'no trigger description';
    return `- ${s.name} (v${s.version || '?'}): ${s.description} [triggers: ${triggers}]`;
  });

  return `Forge-authored skills:\n${lines.join('\n')}`;
}

/**
 * Returns history array for forge skills — useful for overnight analysis.
 */
export function getForgeHistory() {
  return skills
    .filter((s) => s.author === 'forge')
    .map((s) => ({
      name: s.name,
      description: s.description,
      created: s.created,
      version: s.version,
      metrics: { ...s.metrics },
    }));
}

/**
 * Disable a skill by name. Returns true if found.
 */
export function disableSkill(name) {
  const skill = skills.find((s) => s.name === name);
  if (skill) {
    skill._disabled = true;
    logger.info({ skill: name }, 'Skill disabled');
    return true;
  }
  return false;
}

/**
 * Enable a skill by name. Returns true if found.
 */
export function enableSkill(name) {
  const skill = skills.find((s) => s.name === name);
  if (skill) {
    skill._disabled = false;
    logger.info({ skill: name }, 'Skill enabled');
    return true;
  }
  return false;
}
