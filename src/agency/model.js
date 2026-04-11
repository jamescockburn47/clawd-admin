import config from '../config.js';
import logger from '../logger.js';
import { TIMEOUTS } from '../constants.js';
import { evoFetch } from '../evo-client.js';

const AGENCY_CLASSIFIER_PROMPT = `You are the proactive intervention policy model for Clint, a WhatsApp agent.

Your job is to decide whether Clint should speak UNPROMPTED in a professional group conversation.

Rules:
- Default is NO.
- Clint may only speak if the contribution is likely to be genuinely useful.
- He must NOT volunteer private owner/admin information.
- He must NOT take actions or call tools from this decision.
- High-value interventions include: factual correction, synthesis, issue spotting, action-item capture, research nudge.
- Low-value interventions include: agreement, banter, repetition, generic encouragement, speculative opinion.

Return JSON only:
{"intervene":true,"interventionType":"factual_correction","confidence":0.84,"urgency":"normal","rationale":"brief reason","allowedSources":["group_local","shared_memory"]}`;

const VALID_TYPES = new Set([
  'factual_correction',
  'synthesis',
  'issue_spotting',
  'action_item_capture',
  'research_nudge',
]);

export async function classifyAmbientOpportunity(opts) {
  try {
    const res = await evoFetch(`${config.evoPlannerUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { role: 'system', content: AGENCY_CLASSIFIER_PROMPT },
          {
            role: 'user',
            content:
              `Group: ${opts.groupLabel || 'unknown'}\n` +
              `Recent transcript:\n${opts.transcript.slice(0, 4000)}\n\n` +
              `Latest message:\n${opts.text}\n/no_think`,
          },
        ],
        temperature: 0,
        max_tokens: 120,
        cache_prompt: true,
      }),
      timeout: TIMEOUTS.EVO_CLASSIFIER,
    });

    const data = await res.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('ambient agency classifier returned non-JSON');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      intervene: !!parsed.intervene,
      interventionType: VALID_TYPES.has(parsed.interventionType) ? parsed.interventionType : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      urgency: parsed.urgency === 'high' ? 'high' : parsed.urgency === 'low' ? 'low' : 'normal',
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : 'No rationale provided.',
      allowedSources: Array.isArray(parsed.allowedSources)
        ? parsed.allowedSources.filter((item) => typeof item === 'string')
        : [],
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'ambient agency classifier failed');
    return {
      intervene: false,
      interventionType: null,
      confidence: 0,
      urgency: 'low',
      rationale: 'classifier_failed',
      allowedSources: [],
    };
  }
}
