import config from '../config.js';
import logger from '../logger.js';
import { TIMEOUTS } from '../constants.js';
import { evoFetch } from '../evo-client.js';

// 2026-04-24 redesign: the 4B model now does ONE job — a cheap,
// permissive "is this worth Clint looking at?" binary pre-filter.
// The nuanced "should Clint speak" judgment moves to the 27B itself
// (via claude.js getResponse with options.ambient=true), which has
// the full cortex context and writes the response in the same call.
//
// Previous architecture had the 4B doing BOTH category classification
// AND ambient-opportunity classification, both as gates before the 27B
// could run. Evidence from data/agency-decisions.jsonl showed the 4B
// ambient classifier was returning intervene:false, confidence:0.00 on
// every message — a small model over-filtering a nuanced decision.
// Collapsing the gate so the 27B decides (with an easy SILENT opt-out)
// is the right shape.

const PREFILTER_PROMPT = `You decide whether Clint (an AI admin assistant in a WhatsApp group) should BOTHER looking at the latest message.

This is a cheap pre-filter, not a final decision. Bias toward YES when in doubt. A downstream model will make the real call about whether to speak.

Say YES when the message is:
- A question, decision, or task being discussed
- A technical / legal / operational topic someone might want input on
- Something addressed to Clint (directly or indirectly)
- A conversation turn where a substantive contribution could add value
- Ambiguous — in doubt, YES (downstream model will reject if pointless)

Say NO when the message is:
- A pure reaction or short agreement ("yeah", "true", "exactly", "lol", "haha", "ok")
- An emoji or sticker reaction
- Clearly human-to-human chitchat with no place for Clint
- One or two words of small-talk with no topic signal

Output exactly one word: YES or NO.`;

/**
 * Fast binary pre-filter — cheap 4B call on :8085. Returns true when the
 * downstream 27B should evaluate this message, false to discard outright.
 *
 * Design: bias toward YES. The 27B has the full context; it is better
 * positioned to decide silence or speech. The 4B's job is only to avoid
 * wasting the 27B on obvious nothing-to-say messages.
 */
export async function prefilterAmbientOpportunity(opts) {
  try {
    const res = await evoFetch(`${config.evoPlannerUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { role: 'system', content: PREFILTER_PROMPT },
          {
            role: 'user',
            content:
              `Group: ${opts.groupLabel || 'unknown'}\n` +
              (opts.transcript ? `Recent context:\n${opts.transcript.slice(-1500)}\n\n` : '') +
              `Latest message:\n${opts.text}\n/no_think`,
          },
        ],
        temperature: 0,
        max_tokens: 10,
        cache_prompt: true,
      }),
      timeout: TIMEOUTS.EVO_CLASSIFIER,
    });
    const data = await res.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();
    const worth = raw.startsWith('YES');
    return { worth, raw };
  } catch (err) {
    // On failure, bias toward YES — let the 27B reject if needed. Better
    // than dropping a potentially useful contribution because :8085 is
    // momentarily unreachable.
    logger.warn({ err: err.message }, 'ambient prefilter failed — defaulting to worth=true');
    return { worth: true, raw: 'ERROR' };
  }
}
