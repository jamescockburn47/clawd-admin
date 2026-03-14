import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Set env to avoid config.js exit
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const CONFIG_MODULE = '../src/config.js';
let config;
let webSearch;

async function loadModules() {
  config = (await import(CONFIG_MODULE)).default;
  ({ webSearch } = await import('../src/tools/search.js'));
}

describe('webSearch', () => {
  let originalFetch;

  beforeEach(async () => {
    if (!webSearch) await loadModules();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete config.braveApiKey;
  });

  it('returns error message when API key not configured', async () => {
    // config.braveApiKey is undefined by default
    delete config.braveApiKey;
    const result = await webSearch({ query: 'test' });
    assert.equal(result, 'Web search not configured — BRAVE_API_KEY not set.');
  });

  it('returns error message when API key is empty string', async () => {
    config.braveApiKey = '';
    const result = await webSearch({ query: 'test' });
    assert.equal(result, 'Web search not configured — BRAVE_API_KEY not set.');
  });

  it('returns formatted results from mocked Brave API response', async () => {
    config.braveApiKey = 'test-brave-key';

    globalThis.fetch = async (url, opts) => {
      assert.ok(url.includes('api.search.brave.com'));
      assert.equal(opts.headers['X-Subscription-Token'], 'test-brave-key');
      return {
        ok: true,
        json: async () => ({
          web: {
            results: [
              { title: 'First Result', url: 'https://example.com/1', description: 'First description' },
              { title: 'Second Result', url: 'https://example.com/2', description: 'Second description' },
            ],
          },
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

  it('defaults to count=5 when not specified', async () => {
    config.braveApiKey = 'test-brave-key';
    let capturedUrl;

    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      };
    };

    await webSearch({ query: 'test' });
    assert.ok(capturedUrl.includes('count=5'), `Expected count=5 in URL, got: ${capturedUrl}`);
  });

  it('clamps count to minimum of 1', async () => {
    config.braveApiKey = 'test-brave-key';
    let capturedUrl;

    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      };
    };

    await webSearch({ query: 'test', count: 0 });
    assert.ok(capturedUrl.includes('count=1'), `Expected count=1 in URL, got: ${capturedUrl}`);
  });

  it('clamps count to maximum of 10', async () => {
    config.braveApiKey = 'test-brave-key';
    let capturedUrl;

    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      };
    };

    await webSearch({ query: 'test', count: 50 });
    assert.ok(capturedUrl.includes('count=10'), `Expected count=10 in URL, got: ${capturedUrl}`);
  });

  it('handles API errors gracefully (non-ok response)', async () => {
    config.braveApiKey = 'test-brave-key';

    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
    });

    const result = await webSearch({ query: 'test' });
    assert.equal(result, 'Brave search failed (HTTP 429).');
  });

  it('handles network errors gracefully', async () => {
    config.braveApiKey = 'test-brave-key';

    globalThis.fetch = async () => {
      throw new Error('Network timeout');
    };

    const result = await webSearch({ query: 'test' });
    assert.equal(result, 'Web search error: Network timeout');
  });

  it('returns no-results message for empty results', async () => {
    config.braveApiKey = 'test-brave-key';

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });

    const result = await webSearch({ query: 'obscure nonsense' });
    assert.equal(result, 'No results found for "obscure nonsense".');
  });

  it('encodes query parameter in URL', async () => {
    config.braveApiKey = 'test-brave-key';
    let capturedUrl;

    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      };
    };

    await webSearch({ query: 'hello world & more' });
    assert.ok(capturedUrl.includes('q=hello%20world%20%26%20more'), `Expected encoded query in URL, got: ${capturedUrl}`);
  });
});
