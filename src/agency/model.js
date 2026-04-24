import config from '../config.js';
import logger from '../logger.js';
import { TIMEOUTS } from '../constants.js';
import { evoFetch } from '../evo-client.js';

// 2026-04-24 recalibration. Evidence: every model_below_threshold entry in
// data/agency-decisions.jsonl returned `intervene:false, confidence:0.00`
// — including messages scoring 6 and 8 on the heuristic. The 4B model was
// anchoring on "Default is NO. The bar is HIGH." and categorically
// rejecting, rather than weighing each message on its merits. Per the
// CLAUDE.md invariant, LQCore SHOULD receive unsolicited participation
// when Clint can contribute genuinely useful information. Reframed prompt
// below describes positive triggers alongside the filters, and asks the
// classifier to express real confidence rather than default to 0.00.
const AGENCY_CLASSIFIER_PROMPT = `You decide whether Clint, a WhatsApp admin assistant, should contribute UNPROMPTED to an active group conversation.

Context: Clint is a trusted participant in small, high-trust professional groups (primarily LQCore — a legal + AI community). Members already know Clint is there and welcome substantive contributions when they materially advance the discussion.

Intervene (return intervene:true) when ANY of these apply AND Clint can add something concrete that nobody else has said yet:
- factual_correction — a clear error, misattribution, or misinformation in the recent transcript
- synthesis — a long-running thread would benefit from a compressed summary or framing
- issue_spotting — a premise, constraint, or risk the group has not named
- action_item_capture — the group is deciding something and hasn't assigned an owner or deadline
- research_nudge — Clint has specific information (from memory, tools, or his own knowledge) that would materially change the conversation's direction, and nobody else has contributed it

Stay silent (intervene:false) when:
- Short reactions / banter / agreement ("yeah", "true", "lol", "exactly", "fair enough")
- A human has already answered the question adequately
- Clint has already spoken on this topic in the recent transcript
- Pure speculation or opinion without new information
- Meta-discussion about Clint himself
- Private owner/admin topics (those belong in DMs)
- The conversation is flowing naturally without needing input

Principles:
- You are not the only gate. The heuristic score has already confirmed meaningful signal is present — your job is calibration, not blanket rejection.
- Express real confidence. 0.00 means "certainly no"; 0.50 means "I could see it either way"; 0.85 means "clearly yes". A defaulting 0.00 on every message is wrong.
- You may not take actions or call tools from this decision; the answer is purely "speak or stay silent".
- You may not leak private owner information. The allowedSources field restricts what context Clint may draw on IF he does speak.

Return JSON only, no thinking, no commentary:
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
        max_tokens: 200,
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
