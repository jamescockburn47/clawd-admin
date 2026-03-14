import config from '../config.js';

export async function webSearch({ query, count }) {
  if (!config.braveApiKey) {
    return 'Web search not configured — BRAVE_API_KEY not set.';
  }

  // Default to 5, clamp between 1 and 10
  const raw = count == null ? 5 : Number(count);
  const n = Math.max(1, Math.min(10, Number.isNaN(raw) ? 5 : raw));

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;

  try {
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': config.braveApiKey },
    });

    if (!res.ok) {
      return `Brave search failed (HTTP ${res.status}).`;
    }

    const data = await res.json();
    const results = data?.web?.results || [];

    if (results.length === 0) {
      return `No results found for "${query}".`;
    }

    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
      .join('\n\n');
  } catch (err) {
    return `Web search error: ${err.message}`;
  }
}
