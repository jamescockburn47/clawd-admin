import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { summariseAgencyDecisions } from '../eval/agency-shadow-eval.js';
import { summariseAgencyOutcomes } from '../src/agency/analysis.js';

describe('agency shadow eval summary', () => {
  it('aggregates approval and rejection reasons from decision logs', () => {
    const summary = summariseAgencyDecisions([
      {
        finalDecision: { shouldIntervene: true, reason: 'approved', interventionType: 'synthesis', confidence: 0.84 },
        groupLabel: 'LQCore',
      },
      {
        finalDecision: { shouldIntervene: false, reason: 'heuristic_below_threshold', interventionType: null, confidence: 0.21 },
        groupLabel: 'LQCore',
      },
      {
        finalDecision: { shouldIntervene: false, reason: 'cooldown', interventionType: null, confidence: 0.9 },
        groupLabel: 'LQCore',
      },
    ]);

    assert.equal(summary.totalDecisions, 3);
    assert.equal(summary.sent, 1);
    assert.equal(summary.silent, 2);
    assert.equal(summary.reasons.approved, 1);
    assert.equal(summary.reasons.heuristic_below_threshold, 1);
    assert.equal(summary.reasons.cooldown, 1);
    assert.equal(summary.interventionTypes.synthesis, 1);
    assert.equal(summary.byGroup.LQCore, 3);
  });
});

describe('agency outcome summary', () => {
  it('joins ambient interactions with linked feedback', () => {
    const summary = summariseAgencyOutcomes({
      decisions: [
        {
          groupLabel: 'LQCore',
          finalDecision: {
            shouldIntervene: true,
            reason: 'approved',
            interventionType: 'issue_spotting',
            confidence: 0.9,
          },
        },
      ],
      interactions: [
        { id: 'ambient-1', input: { ambient: true }, routing: { mode: 'ambient' } },
      ],
      feedback: [
        { interactionId: 'ambient-1', signal: 'positive', type: 'reaction' },
      ],
    });

    assert.equal(summary.ambientInteractions, 1);
    assert.equal(summary.linkedFeedback, 1);
    assert.equal(summary.feedback.positive, 1);
    assert.equal(summary.approvalRate, 100);
  });
});
