import config from '../config.js';
import logger from '../logger.js';

const MAX_FETCH_CHARS = 4000;

export async function webFetch({ url }) {
  if (!url) return 'URL is required.';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Clawdbot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain,application/json',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!res.ok) return `Failed to fetch URL (HTTP ${res.status}).`;

    const contentType = res.headers.get('content-type') || '';

    // JSON — return formatted
    if (contentType.includes('application/json')) {
      const json = await res.json();
      const text = JSON.stringify(json, null, 2);
      return text.length > MAX_FETCH_CHARS ? text.slice(0, MAX_FETCH_CHARS) + '\n[...truncated]' : text;
    }

    // HTML — strip tags to plain text
    let text = await res.text();
    if (contentType.includes('text/html')) {
      // Remove script/style blocks
      text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
      // Strip all tags
      text = text.replace(/<[^>]+>/g, ' ');
      // Collapse whitespace
      text = text.replace(/\s+/g, ' ').trim();
    }

    if (text.length > MAX_FETCH_CHARS) {
      text = text.slice(0, MAX_FETCH_CHARS) + '\n[...truncated]';
    }

    logger.info({ url, chars: text.length }, 'web_fetch complete');
    return text || 'Page returned empty content.';
  } catch (err) {
    if (err.name === 'AbortError') return 'URL fetch timed out (15s).';
    return `Web fetch error: ${err.message}`;
  }
}

export async function webSearch({ query, count }) {
  // SearXNG on EVO (self-hosted, no API key, no limits)
  const searxngUrl = config.evoLlmUrl
    ? config.evoLlmUrl.replace(/:\d+$/, ':8888')
    : 'http://10.0.0.2:8888';

  // Default to 5, clamp between 1 and 10
  const raw = count == null ? 5 : Number(count);
  const n = Math.max(1, Math.min(10, Number.isNaN(raw) ? 5 : raw));

  const url = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      return `Web search failed (HTTP ${res.status}).`;
    }

    const data = await res.json();
    const results = (data?.results || []).slice(0, n);

    if (results.length === 0) {
      return `No results found for "${query}".`;
    }

    logger.info({ query, count: results.length }, 'web search via SearXNG');

    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content || ''}`)
      .join('\n\n');
  } catch (err) {
    if (err.name === 'AbortError') return 'Web search timed out (10s).';
    return `Web search error: ${err.message}`;
  }
}
