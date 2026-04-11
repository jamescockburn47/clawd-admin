import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enrichQualityFailures,
  type TraceAnalysisClient,
} from '../probe-quality.js';

describe('overnight/probe-quality.enrichQualityFailures', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-probe-quality-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeClient(analysis: Record<string, unknown> | null): TraceAnalysisClient {
    return {
      readAnalysis: async () => analysis,
    };
  }

  it('returns an empty array when no trace analysis is available', async () => {
    const result = await enrichQualityFailures({
      client: makeClient(null),
      date: '2026-04-11',
    });
    assert.deepEqual(result, []);
  });

  it('converts each anomaly into a quality_failure observation', async () => {
    const analysis = {
      anomalies: [
        {
          type: 'slow_cortex',
          severity: 'warning',
          detail: 'Cortex gather p95 is 87415ms (threshold: 8000ms)',
          suggestion: 'Check memory search latency',
        },
        {
          type: 'low_tool_usage',
          severity: 'info',
          detail: '3 of 12 planning queries used tools',
          suggestion: 'Review needsPlan classifier',
        },
      ],
      qualityGate: { totalGated: 2, byCategory: { planning: 1, recall: 1 } },
    };
    const result = await enrichQualityFailures({
      client: makeClient(analysis),
      date: '2026-04-11',
    });
    assert.equal(result.length, 2);
    for (const obs of result) {
      assert.equal(obs.kind, 'quality_failure');
      assert.equal(obs.date, '2026-04-11');
      assert.ok(obs.rejection_reason);
      assert.ok(obs.evidence_refs.length > 0);
    }
    assert.match(result[0]!.rejection_reason, /slow_cortex|Cortex gather/);
    assert.match(result[1]!.rejection_reason, /low_tool_usage|planning queries/);
  });

  it('uses qualityGate.byCategory to populate the category field when matching', async () => {
    const analysis = {
      anomalies: [
        {
          type: 'planning_failure',
          severity: 'warning',
          detail: 'Plans failing 40% of the time in planning category',
          suggestion: 'Review planner',
        },
      ],
      qualityGate: { totalGated: 5, byCategory: { planning: 5 } },
    };
    const result = await enrichQualityFailures({
      client: makeClient(analysis),
      date: '2026-04-11',
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.category, 'planning');
  });

  it('falls back to the anomaly type as category when no category match', async () => {
    const analysis = {
      anomalies: [
        {
          type: 'slow_cortex',
          severity: 'warning',
          detail: 'cortex slow',
          suggestion: 'fix it',
        },
      ],
      qualityGate: { totalGated: 0, byCategory: {} },
    };
    const result = await enrichQualityFailures({
      client: makeClient(analysis),
      date: '2026-04-11',
    });
    assert.equal(result[0]!.category, 'slow_cortex');
  });

  it('assigns higher weight to warning severity than info', async () => {
    const analysis = {
      anomalies: [
        { type: 'a', severity: 'warning', detail: 'x', suggestion: 'y' },
        { type: 'b', severity: 'info', detail: 'x', suggestion: 'y' },
      ],
      qualityGate: { totalGated: 0, byCategory: {} },
    };
    const result = await enrichQualityFailures({
      client: makeClient(analysis),
      date: '2026-04-11',
    });
    assert.ok(result[0]!.weight > result[1]!.weight);
  });

  it('returns empty array when anomalies is missing or not an array', async () => {
    const a = await enrichQualityFailures({
      client: makeClient({ qualityGate: {} }),
      date: '2026-04-11',
    });
    assert.deepEqual(a, []);

    const b = await enrichQualityFailures({
      client: makeClient({ anomalies: 'not-an-array', qualityGate: {} }),
      date: '2026-04-11',
    });
    assert.deepEqual(b, []);
  });
});
