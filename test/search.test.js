import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Set env to avoid config.js exit
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let config;
let webSearch;

async function loadModules() {
  config = (await import('../src/config.js')).default;
  ({ webSearch } = await import('../src/tools/search.js'));
}

describe('webSearch (SearXNG)', () => {
  let originalFetch;

  beforeEach(async () => {
    if (!webSearch) await loadModules();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns formatted results from mocked SearXNG response', async () => {
    globalThis.fetch = async (url) => {
      assert.ok(url.includes('/search?q='));
      assert.ok(url.includes('format=json'));
      return {
        ok: true,
        json: async () => ({
          results: [
            { title: 'First Result', url: 'https://example.com/1', content: 'First description' },
            { title: 'Second Result', url: 'https://example.com/2', content: 'Second description' },
          ],
        }),
      };
    };

    const result = await webSearch({ query: 'test query', count: 2 });
    assert.ok(result.includes('1. First Result'));
    assert.ok(result.includes('https://example.com/1'));
    assert.ok(result.includes('First description'));
    assert.ok(result.includes('2. Second Result'));
    assert.ok(result.includes('https://example.com/2'));
    assert.ok(result.includes('Second description'));
  });

  it('defaults to count=5 when not specified (slices results)', async () => {
    const mockResults = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example.com/${i + 1}`,
      content: `Desc ${i + 1}`,
    }));

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    const result = await webSearch({ query: 'test' });
    assert.ok(result.includes('5. Result 5'));
    assert.ok(!result.includes('6. Result 6'), 'should only return 5 results by default');
  });

  it('clamps count to minimum of 1', async () => {
    const mockResults = [
      { title: 'Only', url: 'https://example.com/1', content: 'One result' },
      { title: 'Extra', url: 'https://example.com/2', content: 'Not shown' },
    ];

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    const result = await webSearch({ query: 'test', count: 0 });
    assert.ok(result.includes('1. Only'));
    assert.ok(!result.includes('2. Extra'), 'should only return 1 result when count=0 clamped to 1');
  });

  it('clamps count to maximum of 10', async () => {
    const mockResults = Array.from({ length: 15 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example.com/${i + 1}`,
      content: `Desc ${i + 1}`,
    }));

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    const result = await webSearch({ query: 'test', count: 50 });
    assert.ok(result.includes('10. Result 10'));
    assert.ok(!result.includes('11. Result 11'), 'should max out at 10 results');
  });

  it('handles API errors gracefully (non-ok response)', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
    });

    const result = await webSearch({ query: 'test' });
    assert.equal(result, 'Web search failed (HTTP 503).');
  });

  it('handles network errors gracefully', async () => {
    globalThis.fetch = async () => {
      throw new Error('Network timeout');
    };

    const result = await webSearch({ query: 'test' });
    assert.equal(result, 'Web search error: Network timeout');
  });

  it('handles fetch timeout (AbortError)', async () => {
    globalThis.fetch = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };

    const result = await webSearch({ query: 'test' });
    assert.equal(result, 'Web search timed out (10s).');
  });

  it('returns no-results message for empty results', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const result = await webSearch({ query: 'obscure nonsense' });
    assert.equal(result, 'No results found for "obscure nonsense".');
  });

  it('encodes query parameter in URL', async () => {
    let capturedUrl;

    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ results: [] }),
      };
    };

    await webSearch({ query: 'hello world & more' });
    assert.ok(capturedUrl.includes('q=hello%20world%20%26%20more'), `Expected encoded query in URL, got: ${capturedUrl}`);
  });
});
