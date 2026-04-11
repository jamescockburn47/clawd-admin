import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_AMBIENT_AGENCY_POLICY,
  getAmbientAgencyConfig,
  isAmbientAgencyEligible,
  scoreAmbientOpportunity,
  finalizeAgencyDecision,
} from '../src/agency/policy.js';
import {
  AGENCY_INTERVENTION_LABELS,
  runAgencyInterventionEval,
} from '../eval/agency-intervention-eval.js';

describe('ambient agency policy', () => {
  it('enables ambient agency for LQCore by label', () => {
    const config = getAmbientAgencyConfig({ groupLabel: 'LQCore' });
    assert.equal(config.enabled, true);
    assert.equal(config.policyName, 'lqcore-default');
  });

  it('enables ambient agency for SOVREN by label', () => {
    const config = getAmbientAgencyConfig({ groupLabel: 'SOVREN' });
    assert.equal(config.enabled, true);
    assert.equal(config.policyName, 'sovren-default');
  });

  it('keeps ambient agency disabled for unrelated groups by default', () => {
    const config = getAmbientAgencyConfig({ groupLabel: 'Random Group' });
    assert.equal(config.enabled, false);
    assert.equal(config.policyName, 'disabled');
  });

  it('rejects non-group or already-addressed messages', () => {
    const nonGroup = isAmbientAgencyEligible({
      isGroup: false,
      triggerRespond: false,
      text: 'Can anyone confirm the authority on relief from sanctions?',
      groupLabel: 'LQCore',
      groupMode: 'open',
      policy: DEFAULT_AMBIENT_AGENCY_POLICY,
    });
    assert.equal(nonGroup.eligible, false);
    assert.equal(nonGroup.reason, 'not_group');

    const addressed = isAmbientAgencyEligible({
      isGroup: true,
      triggerRespond: true,
      text: 'clint can you answer this?',
      groupLabel: 'LQCore',
      groupMode: 'open',
      policy: DEFAULT_AMBIENT_AGENCY_POLICY,
    });
    assert.equal(addressed.eligible, false);
    assert.equal(addressed.reason, 'already_addressed');
  });

  it('accepts ambient LQCore messages that clear the hard gates', () => {
    const verdict = isAmbientAgencyEligible({
      isGroup: true,
      triggerRespond: false,
      text: 'Is there any authority on whether the court can revisit this procedural step?',
      groupLabel: 'LQCore',
      groupMode: 'open',
      policy: DEFAULT_AMBIENT_AGENCY_POLICY,
    });
    assert.equal(verdict.eligible, true);
    assert.equal(verdict.reason, 'eligible');
  });

  it('accepts ambient SOVREN messages in project mode', () => {
    const config = getAmbientAgencyConfig({ groupLabel: 'SOVREN' });
    const verdict = isAmbientAgencyEligible({
      isGroup: true,
      triggerRespond: false,
      text: 'Tell me what you know about SOVREN and how the engine works.',
      groupLabel: 'SOVREN',
      groupMode: 'project',
      policy: config,
    });
    assert.equal(verdict.eligible, true);
    assert.equal(verdict.reason, 'eligible');
  });
});

describe('ambient agency scoring', () => {
  it('scores legal uncertainty and action items highly', () => {
    const score = scoreAmbientOpportunity({
      text: 'I am not sure the authority supports that. We should capture the follow-up points for tomorrow.',
      recentTranscript:
        '[09:41] A: I think the authority says X\n[09:42] B: maybe, but I am not sure\n[09:43] C: we need an answer before the meeting',
    });

    assert.ok(score.total >= 6, `expected strong score, got ${score.total}`);
    assert.ok(score.signals.includes('uncertainty'));
    assert.ok(score.signals.includes('action_items'));
    assert.ok(score.signals.includes('legal_topic'));
  });

  it('scores Sovren project and architecture questions highly', () => {
    const score = scoreAmbientOpportunity({
      text: 'Explain what you know about SOVREN and how your architecture works.',
      recentTranscript: '[09:41] James: Peter, meet Clint. He knows all about SOVREN',
    });

    assert.ok(score.total >= 4, `expected project/architecture score, got ${score.total}`);
    assert.ok(score.signals.includes('project_topic'));
    assert.ok(score.signals.includes('architecture_request'));
  });

  it('keeps casual chatter below intervention threshold', () => {
    const score = scoreAmbientOpportunity({
      text: 'haha yes fair enough',
      recentTranscript: '[09:41] A: good point\n[09:42] B: haha yes fair enough',
    });

    assert.ok(score.total < DEFAULT_AMBIENT_AGENCY_POLICY.minHeuristicScore);
  });
});

describe('ambient agency finalization', () => {
  it('approves only when heuristics and model confidence both clear thresholds', () => {
    const decision = finalizeAgencyDecision({
      eligibleVerdict: { eligible: true, reason: 'eligible' },
      heuristicScore: 7,
      modelVerdict: {
        intervene: true,
        interventionType: 'factual_correction',
        confidence: 0.86,
        urgency: 'normal',
        rationale: 'Likely to prevent a mistaken premise.',
        allowedSources: ['group_local', 'shared_memory'],
      },
      policy: DEFAULT_AMBIENT_AGENCY_POLICY,
      cooldownActive: false,
    });

    assert.equal(decision.shouldIntervene, true);
    assert.equal(decision.reason, 'approved');
    assert.equal(decision.interventionType, 'factual_correction');
  });

  it('rejects when in cooldown even if the model is eager', () => {
    const decision = finalizeAgencyDecision({
      eligibleVerdict: { eligible: true, reason: 'eligible' },
      heuristicScore: 8,
      modelVerdict: {
        intervene: true,
        interventionType: 'synthesis',
        confidence: 0.92,
        urgency: 'normal',
        rationale: 'High-value synthesis.',
        allowedSources: ['group_local'],
      },
      policy: DEFAULT_AMBIENT_AGENCY_POLICY,
      cooldownActive: true,
    });

    assert.equal(decision.shouldIntervene, false);
    assert.equal(decision.reason, 'cooldown');
  });
});

describe('agency eval harness', () => {
  it('computes metrics over the labeled intervention dataset', () => {
    const result = runAgencyInterventionEval((item) => ({
      shouldIntervene: item.expected,
      interventionType: item.expectedType,
    }));

    assert.equal(result.total, AGENCY_INTERVENTION_LABELS.length);
    assert.equal(result.correct, AGENCY_INTERVENTION_LABELS.length);
    assert.equal(result.failures.length, 0);
    assert.equal(result.precision, 1);
    assert.equal(result.recall, 1);
    assert.equal(result.f1, 1);
  });
});
