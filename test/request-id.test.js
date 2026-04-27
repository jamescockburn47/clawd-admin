import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { createRequestId } = await import('../src/request-id.js');

describe('createRequestId', () => {
  it('creates compact IDs with a sanitized source prefix', () => {
    const id = createRequestId({
      source: 'whatsapp dm',
      now: () => 1777313025000,
      randomUUID: () => '12345678-abcd-4000-9000-abcdefabcdef',
    });

    assert.equal(id, 'whatsapp_dm_mohiaay0_12345678');
  });
});
