import config from '../config.js';
import logger from '../logger.js';

const DEMO_EMAIL = config.sovrenDemoEmail;
const DEMO_PASSWORD = config.sovrenDemoPassword;
const DEFAULT_WEB_URL = config.sovrenWebUrl;
const DEFAULT_API_URL = config.sovrenApiUrl;

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }
  return response.json();
}

async function loginToSovren() {
  const payload = await requestJson(`${DEFAULT_API_URL}/api/v1/auth/login`, {
    method: 'POST',
    body: JSON.stringify({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    }),
  });
  if (!payload?.access_token) {
    throw new Error('SOVREN login did not return an access token');
  }
  return payload.access_token;
}

function formatResult(label, payload) {
  const text = JSON.stringify(payload, null, 2);
  return `SOVREN ${label}:\n${text.length > 8000 ? text.slice(0, 8000) + '\n[...truncated]' : text}`;
}

export async function sovrenSiteAccess({ resource, hours = 24, limit = 20 }) {
  try {
    if (!resource) return 'resource is required.';

    if (resource === 'homepage') {
      const response = await fetch(DEFAULT_WEB_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Clint/1.0)' },
      });
      const text = await response.text();
      return `SOVREN homepage (${response.status}):\n${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000)}`;
    }

    if (resource === 'health') {
      const payload = await requestJson(`${DEFAULT_API_URL}/api/v1/health`);
      return formatResult('health', payload);
    }

    const token = await loginToSovren();
    const authHeaders = { Authorization: `Bearer ${token}` };

    if (resource === 'login_test') {
      const me = await requestJson(`${DEFAULT_API_URL}/api/v1/auth/me`, {
        headers: authHeaders,
      });
      return formatResult('login', me);
    }
    if (resource === 'documents') {
      const payload = await requestJson(`${DEFAULT_API_URL}/api/v1/documents`, {
        headers: authHeaders,
      });
      return formatResult('documents', payload);
    }
    if (resource === 'valuations') {
      const payload = await requestJson(`${DEFAULT_API_URL}/api/v1/valuations`, {
        headers: authHeaders,
      });
      return formatResult('valuations', payload);
    }
    if (resource === 'ai_status') {
      const payload = await requestJson(`${DEFAULT_API_URL}/api/v1/admin/ai-status`, {
        headers: authHeaders,
      });
      return formatResult('AI status', payload);
    }
    if (resource === 'llm_analytics') {
      const payload = await requestJson(`${DEFAULT_API_URL}/api/v1/admin/llm-analytics?hours=${encodeURIComponent(String(hours))}&limit=${encodeURIComponent(String(limit))}`, {
        headers: authHeaders,
      });
      return formatResult('LLM analytics', payload);
    }

    return 'Unknown SOVREN resource.';
  } catch (err) {
    logger.warn({ err: err.message, resource }, 'sovren site access failed');
    return `SOVREN access error: ${err.message}`;
  }
}
