import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

function readJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf-8'));
}

function readText(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf-8');
}

describe('self-awareness source of truth', () => {
  it('architecture knowledge says EVO is the primary host', () => {
    const architecture = readJson('data/system-knowledge/architecture.json');
    const summary = architecture.architecture.summary;
    assert.match(summary, /EVO X2 as the primary host/i);
    assert.doesNotMatch(summary, /Pi 5 runs Node\.js|Pi is the brain/i);
  });

  it('group knowledge includes LQCore ambient agency and speak-only limits', () => {
    const groups = readJson('data/system-knowledge/groups.json');
    const summary = groups.engagementClassifier.summary;
    assert.match(summary, /LQCore/i);
    assert.match(summary, /speak-only/i);
    assert.doesNotMatch(summary, /strictly @mention\/prefix-only\. For now, silence unless asked/i);
  });

  it('scheduler knowledge reflects the phase 5 overnight pipeline', () => {
    const scheduler = readJson('data/system-knowledge/scheduler.json');
    const tasks = scheduler.scheduler.tasks.join(' ');
    assert.match(tasks, /CONSOLIDATE at 02:30/i);
    assert.match(tasks, /PROBE at 03:15/i);
    assert.match(tasks, /REPORT at 06:50/i);
    assert.match(tasks, /IMPROVE at Saturday 22:00/i);
    assert.doesNotMatch(tasks, /Daily retrospective at 04:00|The Forge at 04:30|Self-improvement cycle at 01:00/i);
  });

  it('self-improvement knowledge includes ambient agency learning', () => {
    const selfImprovement = readJson('data/system-knowledge/self-improvement.json');
    const summary = selfImprovement.selfImprovement.summary;
    assert.match(summary, /ambient agency usefulness/i);
    assert.match(summary, /weekly IMPROVE/i);
    assert.doesNotMatch(summary, /Daily retrospective at 4 AM|old nightly self-improvement cycle/i);
  });

  it('prompt self-awareness mentions the LQCore ambient exception', () => {
    const prompt = readText('src/prompt.js');
    assert.match(prompt, /LQCore.*occasionally chip in unprompted/i);
    assert.match(prompt, /ambient interventions.*overnight trace analysis/i);
  });
});
