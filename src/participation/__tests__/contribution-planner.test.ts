/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { planContribution } from '../contribution-planner.js';

test('planner prefers direct continuation inside an active follow-up exchange without requiring a question', () => {
  const plan = planContribution({
    posture: 'rare_high_confidence',
    inFollowUpExchange: true,
    directlyRepliesToClint: true,
    hasQuestion: false,
    hasResearchGap: false,
    hasDecisionSignal: false,
    hasMemorySignal: false,
  });

  assert.equal(plan.role, 'answer');
  assert.equal(plan.shouldSpeak, true);
  assert.equal(plan.reason, 'follow_up_continuation');
});

test('planner follow-up continuation wins even when the message also looks like casual chatter', () => {
  const plan = planContribution({
    posture: 'rare_high_confidence',
    inFollowUpExchange: true,
    directlyRepliesToClint: true,
    hasQuestion: false,
    hasResearchGap: false,
    hasDecisionSignal: false,
    hasMemorySignal: false,
    casualChatter: true,
  });

  assert.equal(plan.role, 'answer');
  assert.equal(plan.shouldSpeak, true);
  assert.equal(plan.reason, 'follow_up_continuation');
});

test('planner stays silent on low-signal casual chatter outside an active follow-up', () => {
  const plan = planContribution({
    posture: 'rare_high_confidence',
    inFollowUpExchange: false,
    directlyRepliesToClint: false,
    hasQuestion: false,
    hasResearchGap: false,
    hasDecisionSignal: false,
    hasMemorySignal: false,
    casualChatter: true,
  });

  assert.equal(plan.role, 'silence');
  assert.equal(plan.shouldSpeak, false);
  assert.equal(plan.reason, 'casual_chatter');
});

test('planner chooses research_injection when a research gap is flagged', () => {
  const plan = planContribution({
    posture: 'active_participant',
    inFollowUpExchange: false,
    directlyRepliesToClint: false,
    hasQuestion: false,
    hasResearchGap: true,
    hasDecisionSignal: true,
    hasMemorySignal: true,
  });

  assert.equal(plan.role, 'research_injection');
  assert.equal(plan.shouldSpeak, true);
  assert.equal(plan.reason, 'research_gap');
});

test('planner chooses decision_capture when a decision signal is flagged', () => {
  const plan = planContribution({
    posture: 'rare_high_confidence',
    inFollowUpExchange: false,
    directlyRepliesToClint: false,
    hasQuestion: false,
    hasResearchGap: false,
    hasDecisionSignal: true,
    hasMemorySignal: false,
  });

  assert.equal(plan.role, 'decision_capture');
  assert.equal(plan.shouldSpeak, true);
  assert.equal(plan.reason, 'decision_signal');
});

test('planner chooses memory_recall when only a memory signal is flagged', () => {
  const plan = planContribution({
    posture: 'rare_high_confidence',
    inFollowUpExchange: false,
    directlyRepliesToClint: false,
    hasQuestion: false,
    hasResearchGap: false,
    hasDecisionSignal: false,
    hasMemorySignal: true,
  });

  assert.equal(plan.role, 'memory_recall');
  assert.equal(plan.shouldSpeak, true);
  assert.equal(plan.reason, 'memory_signal');
});

test('planner falls back to silence when no high-value move applies', () => {
  const plan = planContribution({
    posture: 'direct_only',
    inFollowUpExchange: false,
    directlyRepliesToClint: false,
    hasQuestion: false,
    hasResearchGap: false,
    hasDecisionSignal: false,
    hasMemorySignal: false,
  });

  assert.equal(plan.role, 'silence');
  assert.equal(plan.shouldSpeak, false);
  assert.equal(plan.reason, 'no_high_value_move');
});
