import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const DEFAULT_PATHS = Object.freeze({
  decisions: join('data', 'agency-decisions.jsonl'),
  interactions: join('data', 'interactions.jsonl'),
  feedback: join('data', 'feedback.jsonl'),
});

function loadJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function loadAgencyArtifacts(paths = DEFAULT_PATHS) {
  return {
    decisions: loadJsonl(paths.decisions),
    interactions: loadJsonl(paths.interactions),
    feedback: loadJsonl(paths.feedback),
  };
}

export function summariseAgencyOutcomes({ decisions, interactions, feedback }) {
  const ambientInteractions = interactions.filter(
    (entry) => entry?.input?.ambient || entry?.routing?.mode === 'ambient',
  );
  const ambientIds = new Set(ambientInteractions.map((entry) => entry.id).filter(Boolean));
  const linkedFeedback = feedback.filter((entry) => entry?.interactionId && ambientIds.has(entry.interactionId));

  const reasons = {};
  const interventionTypes = {};
  let sent = 0;
  let silent = 0;
  let confidenceTotal = 0;

  for (const entry of decisions) {
    const finalDecision = entry.finalDecision || {};
    const reason = finalDecision.reason || 'unknown';
    const type = finalDecision.interventionType || null;
    const confidence = typeof finalDecision.confidence === 'number' ? finalDecision.confidence : 0;
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (finalDecision.shouldIntervene) sent++;
    else silent++;
    if (type) {
      interventionTypes[type] = (interventionTypes[type] || 0) + 1;
    }
    confidenceTotal += confidence;
  }

  const positive = linkedFeedback.filter((entry) => entry.signal === 'positive').length;
  const negative = linkedFeedback.filter((entry) => entry.signal === 'negative').length;
  const neutral = linkedFeedback.filter((entry) => entry.signal === 'neutral').length;
  const corrections = linkedFeedback.filter((entry) => entry.type === 'correction').length;
  const rated = positive + negative;

  return {
    totalDecisions: decisions.length,
    sent,
    silent,
    sentRate: decisions.length > 0 ? Math.round((sent / decisions.length) * 100) : 0,
    reasons,
    interventionTypes,
    byGroup: decisions.reduce((acc, entry) => {
      const label = entry.groupLabel || 'unknown';
      acc[label] = (acc[label] || 0) + 1;
      return acc;
    }, {}),
    ambientInteractions: ambientInteractions.length,
    linkedFeedback: linkedFeedback.length,
    feedback: { positive, negative, neutral, corrections },
    approvalRate: rated > 0 ? Math.round((positive / rated) * 100) : null,
    avgDecisionConfidence: decisions.length > 0 ? confidenceTotal / decisions.length : 0,
  };
}
