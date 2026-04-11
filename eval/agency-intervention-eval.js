// eval/agency-intervention-eval.js — labeled dataset and metrics for ambient agency decisions

export const AGENCY_INTERVENTION_LABELS = [
  {
    msg: 'I do not think that authority says what we are assuming here.',
    transcript: 'Recent thread about the meaning of an authority in LQCore.',
    expected: true,
    expectedType: 'factual_correction',
    reason: 'high-value correction in legal discussion',
  },
  {
    msg: 'Can somebody summarise where we landed on the disclosure issue?',
    transcript: 'Recent thread has multiple positions and unresolved synthesis need.',
    expected: true,
    expectedType: 'synthesis',
    reason: 'clear synthesis opportunity',
  },
  {
    msg: 'We should make sure someone follows up with the authority bundle before tomorrow.',
    transcript: 'Thread mentions deadlines and missing owner.',
    expected: true,
    expectedType: 'action_item_capture',
    reason: 'explicit action-item opportunity',
  },
  {
    msg: 'haha yes fair enough',
    transcript: 'General banter with no unresolved issue.',
    expected: false,
    expectedType: null,
    reason: 'casual chatter',
  },
  {
    msg: 'Morning all',
    transcript: 'Start of day greeting.',
    expected: false,
    expectedType: null,
    reason: 'greeting only',
  },
  {
    msg: 'That sounds right to me.',
    transcript: 'Agreement without new information.',
    expected: false,
    expectedType: null,
    reason: 'agreement only',
  },
  {
    msg: 'I am not sure we have identified the actual issue yet.',
    transcript: 'Several messages show people talking past each other.',
    expected: true,
    expectedType: 'issue_spotting',
    reason: 'useful framing intervention',
  },
  {
    msg: 'Does anyone know the latest position on this after the recent changes?',
    transcript: 'Open legal/procedural question with likely current-information gap.',
    expected: true,
    expectedType: 'research_nudge',
    reason: 'useful research-oriented intervention',
  },
];

function calcMetrics(tp, fp, tn, fn) {
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 1;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 1;
  const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = (tp + fp + tn + fn) > 0 ? (tp + tn) / (tp + fp + tn + fn) : 1;
  return { precision, recall, f1, accuracy };
}

export function runAgencyInterventionEval(decideFn) {
  const results = { total: 0, correct: 0, tp: 0, fp: 0, tn: 0, fn: 0, failures: [] };

  for (const item of AGENCY_INTERVENTION_LABELS) {
    results.total++;
    const got = decideFn(item);
    const gotIntervene = !!got?.shouldIntervene;
    const gotType = got?.interventionType ?? null;

    const correct = gotIntervene === item.expected && gotType === item.expectedType;
    if (correct) {
      results.correct++;
    } else {
      results.failures.push({
        msg: item.msg,
        expected: item.expected,
        expectedType: item.expectedType,
        got: gotIntervene,
        gotType,
        reason: item.reason,
      });
    }

    if (item.expected && gotIntervene) results.tp++;
    else if (!item.expected && gotIntervene) results.fp++;
    else if (!item.expected && !gotIntervene) results.tn++;
    else results.fn++;
  }

  return {
    ...results,
    ...calcMetrics(results.tp, results.fp, results.tn, results.fn),
    timestamp: new Date().toISOString(),
  };
}
