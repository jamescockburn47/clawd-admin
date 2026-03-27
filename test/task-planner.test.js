// test/task-planner.test.js — Pure-logic tests for the agentic task planner
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let getRecentPlans, getPlanById;

async function loadModules() {
  const mod = await import('../src/task-planner.js');
  ({ getRecentPlans, getPlanById } = mod);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid step object */
function step(id, tool, deps = []) {
  return {
    step_id: id,
    description: `step ${id}`,
    reasoning: `needed for step ${id}`,
    tool,
    tool_input: {},
    depends_on: deps,
    on_failure: 'skip',
  };
}

// ── Inline reimplementations of non-exported functions ──────────────────────
// These mirror the source in src/task-planner.js exactly, enabling isolated
// testing of pure logic without needing to import (and trigger side effects of)
// the full module graph.

const VALID_TOOL_NAMES = new Set([
  'calendar_list_events', 'calendar_create_event', 'calendar_update_event',
  'calendar_find_free_time', 'gmail_search', 'gmail_read', 'gmail_draft',
  'gmail_confirm_send', 'train_departures', 'train_fares', 'hotel_search',
  'search_trains', 'search_accommodation', 'web_search', 'web_fetch',
  'todo_add', 'todo_list', 'todo_complete', 'todo_remove', 'todo_update',
  'soul_read', 'soul_learn', 'soul_forget', 'soul_propose', 'soul_confirm',
  'memory_search', 'memory_update', 'memory_delete', 'system_status',
  'project_list', 'project_read', 'project_pitch', 'project_update',
  'overnight_report', 'evolution_task', 'send_file',
]);

const MAX_STEPS = 8;

function topologicalSort(steps) {
  const inDegree = new Map();
  const adj = new Map();
  for (const s of steps) {
    inDegree.set(s.step_id, (s.depends_on || []).length);
    adj.set(s.step_id, []);
  }
  for (const s of steps) {
    for (const dep of (s.depends_on || [])) {
      adj.get(dep)?.push(s.step_id);
    }
  }
  const sorted = [];
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  while (queue.length > 0) {
    const id = queue.shift();
    sorted.push(id);
    for (const next of (adj.get(id) || [])) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  if (sorted.length !== steps.length) throw new Error('cycle detected');
  return sorted;
}

function validatePlan(steps) {
  const errors = [];
  if (steps.length > MAX_STEPS) {
    errors.push(`too many steps: ${steps.length} > ${MAX_STEPS}`);
  }
  if (steps.length === 0) {
    errors.push('empty plan');
  }
  const stepIds = new Set(steps.map(s => s.step_id));
  for (const s of steps) {
    if (!VALID_TOOL_NAMES.has(s.tool)) {
      errors.push(`step ${s.step_id}: unknown tool "${s.tool}"`);
    }
    if (s.depends_on) {
      for (const dep of s.depends_on) {
        if (!stepIds.has(dep)) {
          errors.push(`step ${s.step_id}: depends on non-existent step ${dep}`);
        }
      }
    }
  }
  if (errors.length === 0) {
    try { topologicalSort(steps); }
    catch { errors.push('circular dependency detected'); }
  }
  return { valid: errors.length === 0, errors };
}

function walkPath(obj, path) {
  const parts = path.match(/[^.\[\]]+|\[\d+\]/g);
  if (!parts) return null;
  let current = obj;
  for (const part of parts) {
    if (current == null) return null;
    const idx = part.match(/^\[(\d+)\]$/);
    current = idx ? current[parseInt(idx[1])] : current[part];
  }
  return current;
}

function resolveTemplates(toolInput, completedSteps) {
  const str = JSON.stringify(toolInput);
  const resolved = str.replace(/\{\{step(\d+)\.result\.([^}]+)\}\}/g, (match, stepId, path) => {
    const s = completedSteps.get(parseInt(stepId));
    if (!s?.result) return match;
    const val = walkPath(s.result, path);
    if (val === null || val === undefined) return match;
    return typeof val === 'string' ? val : JSON.stringify(val);
  });
  try { return JSON.parse(resolved); }
  catch { return toolInput; }
}

function groupByLevel(steps) {
  const levels = [];
  const completed = new Set();
  const remaining = [...steps];
  while (remaining.length > 0) {
    const level = remaining.filter(s =>
      (s.depends_on || []).every(dep => completed.has(dep))
    );
    if (level.length === 0) break;
    levels.push(level);
    for (const s of level) {
      completed.add(s.step_id);
      remaining.splice(remaining.indexOf(s), 1);
    }
  }
  return levels;
}

function applyAdaptations(steps, adaptations) {
  if (!adaptations || adaptations.length === 0) return steps;
  const adapted = [...steps];
  for (const adapt of adaptations) {
    const idx = adapted.findIndex(s => s.step_id === adapt.step_id);
    if (idx === -1) continue;
    if (adapt.action === 'skip') {
      adapted[idx].status = 'skipped';
      adapted[idx].skipReason = adapt.reason;
    } else if (adapt.action === 'update' && adapt.new_tool_input) {
      adapted[idx].tool_input = adapt.new_tool_input;
      adapted[idx].adapted = true;
    }
  }
  return adapted;
}

// ── Plan Validation ─────────────────────────────────────────────────────────

describe('validatePlan', () => {
  it('accepts a valid 3-step plan with valid tools and deps', () => {
    const steps = [
      step(1, 'calendar_list_events'),
      step(2, 'todo_list'),
      step(3, 'memory_search', [1, 2]),
    ];
    const result = validatePlan(steps);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('rejects an empty steps array', () => {
    const result = validatePlan([]);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('empty plan')));
  });

  it('rejects too many steps (>8)', () => {
    const steps = Array.from({ length: 9 }, (_, i) =>
      step(i + 1, 'web_search')
    );
    const result = validatePlan(steps);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('too many steps')));
  });

  it('rejects an unknown tool name', () => {
    const steps = [step(1, 'nonexistent_tool')];
    const result = validatePlan(steps);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('unknown tool')));
  });

  it('rejects dependency on a non-existent step', () => {
    const steps = [
      step(1, 'todo_list'),
      step(2, 'gmail_search', [99]),
    ];
    const result = validatePlan(steps);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('non-existent step 99')));
  });

  it('rejects circular dependencies', () => {
    const steps = [
      step(1, 'todo_list', [2]),
      step(2, 'web_search', [1]),
    ];
    const result = validatePlan(steps);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('circular dependency')));
  });

  it('accepts steps with no dependencies (all parallel)', () => {
    const steps = [
      step(1, 'calendar_list_events'),
      step(2, 'todo_list'),
      step(3, 'memory_search'),
    ];
    const result = validatePlan(steps);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('accepts exactly 8 steps (the maximum)', () => {
    const tools = [
      'calendar_list_events', 'todo_list', 'memory_search', 'gmail_search',
      'gmail_read', 'web_search', 'train_departures', 'todo_add',
    ];
    const steps = tools.map((t, i) => step(i + 1, t));
    const result = validatePlan(steps);
    assert.equal(result.valid, true);
  });

  it('collects multiple errors at once', () => {
    const steps = [
      step(1, 'fake_tool_a'),
      step(2, 'fake_tool_b', [99]),
    ];
    const result = validatePlan(steps);
    assert.equal(result.valid, false);
    // Should have errors for both unknown tools AND the missing dep
    assert.ok(result.errors.length >= 3);
  });
});

// ── Plan Store ──────────────────────────────────────────────────────────────

describe('plan store', () => {
  beforeEach(async () => {
    if (!getRecentPlans) await loadModules();
  });

  it('getRecentPlans returns an array (may be empty or contain prior test plans)', () => {
    const plans = getRecentPlans();
    assert.ok(Array.isArray(plans));
  });

  it('getRecentPlans respects limit parameter', () => {
    const plans = getRecentPlans(1);
    assert.ok(plans.length <= 1);
  });

  it('getPlanById returns null for an unknown ID', () => {
    const plan = getPlanById('plan_does_not_exist');
    assert.equal(plan, null);
  });

  it('getPlanById returns null for undefined', () => {
    const plan = getPlanById(undefined);
    assert.equal(plan, null);
  });
});

// ── Topological Sort / Dependency Grouping ──────────────────────────────────

describe('topological ordering via validatePlan', () => {
  it('validates a linear chain A->B->C', () => {
    const steps = [
      step(1, 'calendar_list_events'),
      step(2, 'gmail_search', [1]),
      step(3, 'gmail_read', [2]),
    ];
    const result = validatePlan(steps);
    assert.equal(result.valid, true);
  });

  it('validates a diamond dependency: 1->3, 2->3, 3->4', () => {
    const steps = [
      step(1, 'calendar_list_events'),
      step(2, 'todo_list'),
      step(3, 'memory_search', [1, 2]),
      step(4, 'web_search', [3]),
    ];
    const result = validatePlan(steps);
    assert.equal(result.valid, true);
  });

  it('validates all-parallel with zero dependencies', () => {
    const steps = [
      step(1, 'calendar_list_events'),
      step(2, 'todo_list'),
      step(3, 'web_search'),
    ];
    const result = validatePlan(steps);
    assert.equal(result.valid, true);
  });

  it('detects a self-referencing step as circular', () => {
    const steps = [step(1, 'todo_list', [1])];
    const result = validatePlan(steps);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('circular dependency')));
  });

  it('detects a 3-node cycle: 1->2->3->1', () => {
    const steps = [
      step(1, 'todo_list', [3]),
      step(2, 'web_search', [1]),
      step(3, 'memory_search', [2]),
    ];
    const result = validatePlan(steps);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('circular dependency')));
  });
});

// ── Template Resolution ─────────────────────────────────────────────────────

describe('template resolution', () => {
  it('resolves {{step1.result.messages[0].id}} correctly', () => {
    const completedSteps = new Map();
    completedSteps.set(1, {
      step_id: 1,
      result: { messages: [{ id: 'msg_abc123' }] },
    });

    const input = { message_id: '{{step1.result.messages[0].id}}' };
    const resolved = resolveTemplates(input, completedSteps);
    assert.equal(resolved.message_id, 'msg_abc123');
  });

  it('resolves {{step2.result.field}} correctly', () => {
    const completedSteps = new Map();
    completedSteps.set(2, {
      step_id: 2,
      result: { field: 'some_value' },
    });

    const input = { query: '{{step2.result.field}}' };
    const resolved = resolveTemplates(input, completedSteps);
    assert.equal(resolved.query, 'some_value');
  });

  it('leaves unresolvable templates as-is', () => {
    const completedSteps = new Map();
    // Step 5 does not exist in completedSteps
    const input = { query: '{{step5.result.data}}' };
    const resolved = resolveTemplates(input, completedSteps);
    assert.equal(resolved.query, '{{step5.result.data}}');
  });

  it('leaves template when path does not exist in result', () => {
    const completedSteps = new Map();
    completedSteps.set(1, {
      step_id: 1,
      result: { other: 'value' },
    });

    const input = { query: '{{step1.result.nonexistent.deep.path}}' };
    const resolved = resolveTemplates(input, completedSteps);
    assert.equal(resolved.query, '{{step1.result.nonexistent.deep.path}}');
  });

  it('resolves nested path with multiple levels', () => {
    const completedSteps = new Map();
    completedSteps.set(1, {
      step_id: 1,
      result: { data: { items: [{ name: 'first' }, { name: 'second' }] } },
    });

    const input = { target: '{{step1.result.data.items[1].name}}' };
    const resolved = resolveTemplates(input, completedSteps);
    assert.equal(resolved.target, 'second');
  });

  it('resolves numeric values — number embedded in string becomes string in JSON', () => {
    const completedSteps = new Map();
    completedSteps.set(1, {
      step_id: 1,
      result: { count: 42 },
    });

    // Template is inside a JSON string value: "{{...}}" → the replacement is "42"
    // which after JSON.parse yields the number 42 only if the entire value is the template.
    // In practice: {"total":"{{step1.result.count}}"} → {"total":"42"} after replace,
    // BUT the replacement inserts JSON.stringify(42) = "42" into the string position,
    // so the JSON becomes {"total":"42"} which parses to { total: "42" }.
    const input = { total: '{{step1.result.count}}' };
    const resolved = resolveTemplates(input, completedSteps);
    assert.equal(resolved.total, '42');
  });

  it('resolves multiple templates in the same input', () => {
    const completedSteps = new Map();
    completedSteps.set(1, {
      step_id: 1,
      result: { from: 'London' },
    });
    completedSteps.set(2, {
      step_id: 2,
      result: { to: 'York' },
    });

    const input = {
      origin: '{{step1.result.from}}',
      destination: '{{step2.result.to}}',
    };
    const resolved = resolveTemplates(input, completedSteps);
    assert.equal(resolved.origin, 'London');
    assert.equal(resolved.destination, 'York');
  });

  it('handles input with no templates unchanged', () => {
    const completedSteps = new Map();
    const input = { query: 'plain string', days: 7 };
    const resolved = resolveTemplates(input, completedSteps);
    assert.deepEqual(resolved, { query: 'plain string', days: 7 });
  });
});

// ── walkPath ────────────────────────────────────────────────────────────────

describe('walkPath', () => {
  it('walks a simple property', () => {
    assert.equal(walkPath({ a: 1 }, 'a'), 1);
  });

  it('walks a nested property', () => {
    assert.equal(walkPath({ a: { b: { c: 'deep' } } }, 'a.b.c'), 'deep');
  });

  it('walks an array index', () => {
    assert.equal(walkPath({ items: ['x', 'y', 'z'] }, 'items[1]'), 'y');
  });

  it('walks mixed object and array paths', () => {
    const obj = { data: [{ name: 'first' }, { name: 'second' }] };
    assert.equal(walkPath(obj, 'data[0].name'), 'first');
  });

  it('returns undefined for missing property', () => {
    assert.equal(walkPath({ a: 1 }, 'b'), undefined);
  });

  it('returns null for null intermediate', () => {
    assert.equal(walkPath({ a: null }, 'a.b'), null);
  });

  it('returns null for empty path', () => {
    assert.equal(walkPath({ a: 1 }, ''), null);
  });
});

// ── Adaptation Application ──────────────────────────────────────────────────

describe('applyAdaptations', () => {
  function makeStep(id, tool) {
    return {
      step_id: id,
      tool,
      tool_input: { query: 'original' },
      status: 'pending',
      adapted: false,
      skipReason: null,
    };
  }

  it('skip action marks the step as skipped with reason', () => {
    const steps = [makeStep(1, 'todo_list'), makeStep(2, 'web_search')];
    const adaptations = [
      { step_id: 2, action: 'skip', reason: 'already answered by step 1' },
    ];

    const result = applyAdaptations(steps, adaptations);
    assert.equal(result[1].status, 'skipped');
    assert.equal(result[1].skipReason, 'already answered by step 1');
    // Step 1 should be untouched
    assert.equal(result[0].status, 'pending');
  });

  it('update action replaces tool_input and sets adapted flag', () => {
    const steps = [makeStep(1, 'gmail_search')];
    const adaptations = [
      {
        step_id: 1,
        action: 'update',
        new_tool_input: { query: 'refined search' },
        reason: 'narrowing based on step 1',
      },
    ];

    const result = applyAdaptations(steps, adaptations);
    assert.deepEqual(result[0].tool_input, { query: 'refined search' });
    assert.equal(result[0].adapted, true);
  });

  it('unknown step_id in adaptation is silently ignored', () => {
    const steps = [makeStep(1, 'todo_list')];
    const adaptations = [
      { step_id: 99, action: 'skip', reason: 'does not exist' },
    ];

    const result = applyAdaptations(steps, adaptations);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'pending');
  });

  it('returns steps unchanged with empty adaptations', () => {
    const steps = [makeStep(1, 'web_search')];
    const result = applyAdaptations(steps, []);
    assert.equal(result[0].status, 'pending');
    assert.deepEqual(result[0].tool_input, { query: 'original' });
  });

  it('returns steps unchanged with null adaptations', () => {
    const steps = [makeStep(1, 'web_search')];
    const result = applyAdaptations(steps, null);
    assert.equal(result[0].status, 'pending');
  });

  it('applies multiple adaptations in sequence', () => {
    const steps = [
      makeStep(1, 'calendar_list_events'),
      makeStep(2, 'gmail_search'),
      makeStep(3, 'memory_search'),
    ];
    const adaptations = [
      { step_id: 1, action: 'skip', reason: 'calendar offline' },
      { step_id: 2, action: 'update', new_tool_input: { query: 'Anderson costs' }, reason: 'refined' },
    ];

    const result = applyAdaptations(steps, adaptations);
    assert.equal(result[0].status, 'skipped');
    assert.deepEqual(result[1].tool_input, { query: 'Anderson costs' });
    assert.equal(result[1].adapted, true);
    assert.equal(result[2].status, 'pending');
  });

  it('update without new_tool_input does not modify step', () => {
    const steps = [makeStep(1, 'web_search')];
    const adaptations = [
      { step_id: 1, action: 'update', reason: 'missing input' },
    ];

    const result = applyAdaptations(steps, adaptations);
    assert.deepEqual(result[0].tool_input, { query: 'original' });
    assert.equal(result[0].adapted, false);
  });
});

// ── groupByLevel ────────────────────────────────────────────────────────────

describe('groupByLevel', () => {
  it('groups all-parallel steps into a single level', () => {
    const steps = [
      step(1, 'calendar_list_events'),
      step(2, 'todo_list'),
      step(3, 'web_search'),
    ];
    const levels = groupByLevel(steps);
    assert.equal(levels.length, 1);
    assert.equal(levels[0].length, 3);
  });

  it('groups a linear chain into sequential levels', () => {
    const steps = [
      step(1, 'gmail_search'),
      step(2, 'gmail_read', [1]),
      step(3, 'web_search', [2]),
    ];
    const levels = groupByLevel(steps);
    assert.equal(levels.length, 3);
    assert.equal(levels[0].length, 1);
    assert.equal(levels[0][0].step_id, 1);
    assert.equal(levels[1][0].step_id, 2);
    assert.equal(levels[2][0].step_id, 3);
  });

  it('groups diamond dependency correctly: parallel first, then merge', () => {
    const steps = [
      step(1, 'calendar_list_events'),
      step(2, 'todo_list'),
      step(3, 'memory_search', [1, 2]),
    ];
    const levels = groupByLevel(steps);
    assert.equal(levels.length, 2);
    assert.equal(levels[0].length, 2); // steps 1 and 2 parallel
    assert.equal(levels[1].length, 1); // step 3 after both
    assert.equal(levels[1][0].step_id, 3);
  });

  it('handles mixed parallel and sequential correctly', () => {
    // 1,2 parallel; 3 depends on 1; 4 depends on 2; 5 depends on 3,4
    const steps = [
      step(1, 'calendar_list_events'),
      step(2, 'todo_list'),
      step(3, 'gmail_search', [1]),
      step(4, 'web_search', [2]),
      step(5, 'memory_search', [3, 4]),
    ];
    const levels = groupByLevel(steps);
    assert.equal(levels.length, 3);
    assert.deepEqual(levels[0].map(s => s.step_id).sort(), [1, 2]);
    assert.deepEqual(levels[1].map(s => s.step_id).sort(), [3, 4]);
    assert.deepEqual(levels[2].map(s => s.step_id), [5]);
  });
});
