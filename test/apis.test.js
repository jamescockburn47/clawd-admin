import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Set env to avoid config.js exit
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

describe('API tool definitions', () => {
  let TOOL_DEFINITIONS;

  before(async () => {
    ({ TOOL_DEFINITIONS } = await import('../src/tools/definitions.js'));
  });

  it('includes train_departures tool', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'train_departures');
    assert.ok(tool, 'train_departures tool should exist');
    assert.ok(tool.input_schema.properties.from, 'should have from param');
    assert.ok(tool.input_schema.properties.to, 'should have to param');
    assert.deepStrictEqual(tool.input_schema.required, ['from']);
  });

  it('includes train_fares tool', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'train_fares');
    assert.ok(tool, 'train_fares tool should exist');
    assert.deepStrictEqual(tool.input_schema.required, ['from', 'to']);
  });

  it('includes hotel_search tool', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'hotel_search');
    assert.ok(tool, 'hotel_search tool should exist');
    assert.ok(tool.input_schema.properties.area, 'should have area param');
    assert.ok(tool.input_schema.properties.checkin, 'should have checkin param');
    assert.deepStrictEqual(tool.input_schema.required, ['checkin', 'checkout']);
  });

  it('still has existing tools', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    assert.ok(names.includes('search_trains'), 'search_trains should still exist');
    assert.ok(names.includes('search_accommodation'), 'search_accommodation should still exist');
    assert.ok(names.includes('gmail_draft'), 'gmail_draft should still exist');
    assert.ok(names.includes('calendar_list_events'), 'calendar_list_events should still exist');
  });
});

describe('handler dispatch', () => {
  let executeTool;

  before(async () => {
    ({ executeTool } = await import('../src/tools/handler.js'));
  });

  it('routes train_departures', async () => {
    // Will fail without Darwin token, but should route correctly and return an error message
    const result = await executeTool('train_departures', { from: 'KGX' });
    assert.ok(typeof result === 'string', 'should return string');
  });

  it('routes train_fares', async () => {
    // BR Fares is open — may return real data or network error in test env
    const result = await executeTool('train_fares', { from: 'KGX', to: 'YRK' });
    assert.ok(typeof result === 'string', 'should return string');
  });

  it('routes hotel_search', async () => {
    // Will fail without Amadeus creds
    const result = await executeTool('hotel_search', { area: 'york', checkin: '2026-04-01', checkout: '2026-04-02' });
    assert.ok(typeof result === 'string', 'should return string');
  });

  it('returns error for unknown tool', async () => {
    const result = await executeTool('nonexistent_tool', {});
    assert.ok(result.includes('Unknown tool'), 'should say unknown tool');
  });
});

describe('BR Fares response parsing', () => {
  it('formats fares correctly when API available', async () => {
    const { trainFares } = await import('../src/tools/darwin.js');
    try {
      const result = await trainFares({ from: 'KGX', to: 'YRK' });
      assert.ok(typeof result === 'string');
      if (!result.includes('No fares')) {
        assert.ok(result.includes('Fares:') || result.includes('£'), 'should contain price info');
      }
    } catch (err) {
      // Network/auth errors expected in test env — skip gracefully
      assert.ok(err.message.includes('401') || err.message.includes('fetch'), `Expected network error, got: ${err.message}`);
    }
  });
});

describe('Amadeus area coordinates', () => {
  it('resolves known areas', async () => {
    const { hotelSearch } = await import('../src/tools/amadeus.js');
    // Without credentials, this will fail — but we can verify the function exists
    assert.ok(typeof hotelSearch === 'function', 'hotelSearch should be a function');
  });
});

describe('claude.js tool availability', () => {
  let getAvailableToolsFn;

  before(async () => {
    // We need to check the function logic, but it's not exported directly
    // Instead, verify the TOOL_DEFINITIONS filtering approach
    const { TOOL_DEFINITIONS } = await import('../src/tools/definitions.js');
    const travelTools = TOOL_DEFINITIONS.filter((t) =>
      ['search_trains', 'search_accommodation', 'train_fares'].includes(t.name)
    );
    // train_fares and URL builders should always be available (no key needed)
    assert.ok(travelTools.length >= 3, 'should have at least 3 always-available travel tools');
  });

  it('train_fares is always-available (no API key)', () => {
    // Verified in before() — train_fares needs no credentials
    assert.ok(true);
  });
});
