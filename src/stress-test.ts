// src/stress-test.ts — Evidence-based adversarial analysis pipeline
// Three-pass: Sonar research → EVO 30B structures position → Claude Opus adversarial frameworks.
// Degrades gracefully: if Sonar down, uses SearXNG. If EVO down, skips structure pass.

import { sonarDeep, isSonarAvailable } from './sonar-client.js';
import { webSearch as searxngSearch } from './tools/search.js';
import config from './config.js';
import logger from './logger.js';
import { evoFetch, llamaBreaker } from './evo-client.js';
import { isEvoOnline } from './memory.js';

const STRUCTURE_TIMEOUT = 15_000;

interface StressTestResult {
  prompt: string;
  useOpus: boolean;
}

/**
 * Build a stress-test execution prompt with live research evidence.
 * Called from group-modes.js after topic selection, replaces the standard critique prompt.
 *
 * @returns System prompt for the adversarial LLM call (intended for Opus)
 */
export async function buildStressTestPrompt(
  transcript: string,
  topicLabels: string,
): Promise<StressTestResult> {
  const t0 = Date.now();

  // Pass 1: Live research (parallel across topics)
  const research = await fetchEvidence(topicLabels);

  // Pass 2: Structure position via EVO 30B (free, fast)
  const structure = await structurePosition(transcript, topicLabels, research);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  logger.info({ topicLabels, elapsed, hasResearch: !!research, hasStructure: !!structure }, 'stress-test prepared');

  const prompt = buildAdversarialPrompt(transcript, topicLabels, research, structure);
  return { prompt, useOpus: false };
}

// --- Pass 1: Evidence gathering ---

async function fetchEvidence(topicLabels: string): Promise<string> {
  // Try Sonar deep research first
  if (isSonarAvailable()) {
    const result = await sonarDeep(
      `Analyse the merits and risks of: ${topicLabels}. Include evidence for and against.`
    );
    if (result?.content) {
      const citations = result.citations.length > 0
        ? '\n\nSources: ' + result.citations.slice(0, 5).join(', ')
        : '';
      return result.content + citations;
    }
  }

  // Fallback: SearXNG
  const raw = await searxngSearch({ query: topicLabels, count: 8 });
  if (raw && !raw.startsWith('No results') && !raw.startsWith('Web search')) {
    return raw;
  }

  return '';
}

// --- Pass 2: Position structuring via EVO 30B ---

async function structurePosition(
  transcript: string,
  topicLabels: string,
  research: string,
): Promise<string> {
  if (!isEvoOnline()) return '';

  const researchSection = research
    ? `\n\n## External evidence:\n${research.slice(0, 2000)}`
    : '';

  try {
    const result = await llamaBreaker.call(async () => {
      const res = await evoFetch(`${config.evoLlmUrl}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: `Analyse this group discussion and identify:
1. The core position or proposal being discussed
2. Every assumption that must be true for it to work (numbered list)
3. Evidence from the research that supports or contradicts each assumption

Be precise. Output structured text, not JSON. /no_think`,
            },
            {
              role: 'user',
              content: `## Topics: ${topicLabels}\n\n## Conversation:\n${transcript.slice(0, 3000)}${researchSection}`,
            },
          ],
          temperature: 0.2,
          max_tokens: 1000,
          cache_prompt: true,
        }),
        timeout: STRUCTURE_TIMEOUT,
      });
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || '';
    }, '');

    return result || '';
  } catch (err: any) {
    logger.warn({ err: err.message }, 'stress-test: structure pass failed');
    return '';
  }
}

// --- Pass 3: Adversarial prompt for Opus ---

function buildAdversarialPrompt(
  transcript: string,
  topicLabels: string,
  research: string,
  structure: string,
): string {
  const researchBlock = research
    ? `## EXTERNAL EVIDENCE (from live research)\n${research.slice(0, 3000)}\n\n`
    : '';

  const structureBlock = structure
    ? `## POSITION ANALYSIS (from initial assessment)\n${structure}\n\n`
    : '';

  return `You are in Stress-Test mode. Your job is to subject this group's position to rigorous adversarial analysis using three established analytical frameworks, grounded in real evidence.

## Topics: ${topicLabels}

${researchBlock}${structureBlock}## FRAMEWORK 1: CIA RED TEAM (Assumptions Analysis)
For each assumption identified:
- Is it testable? Has it been tested?
- What evidence supports it? What contradicts it?
- Which assumptions are the group taking on faith?
- Rate each: SUPPORTED / CONTESTED / UNTESTED / CONTRADICTED

## FRAMEWORK 2: KLEIN PRE-MORTEM
"It's 12 months from now and this failed completely."
- Generate 3 specific, evidence-grounded failure scenarios
- For each: what went wrong, what warning signs existed, what the group overlooked
- Rank by likelihood using the research evidence

## FRAMEWORK 3: STEELMAN OPPOSITION
- Identify who would oppose this and why (with evidence)
- Build the strongest possible counter-argument using external evidence
- Present it as a coherent case, not a list of objections

## VERDICT
- Overall risk assessment: LOW / MODERATE / HIGH / CRITICAL
- Top 3 vulnerabilities (ranked by severity)
- 3 specific questions the group MUST answer before proceeding
- If the position is fundamentally sound, say so — but identify the conditions under which it fails

## RULES
- Ground every claim in evidence (from research, conversation, or your knowledge)
- Cite specific things people said in the conversation
- Be direct, compressed, sharp. No filler, no emojis
- This is not theatre — genuine analytical rigour only
- If the topic lacks substance for this level of analysis, say so in one sentence

## CONVERSATION TRANSCRIPT
${transcript}`;
}
