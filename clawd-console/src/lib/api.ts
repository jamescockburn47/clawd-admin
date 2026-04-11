import type { ParticipationDecisionsResponse, ParticipationGroupsResponse } from './types';

type FetchOpts = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
  }

  return res.json() as Promise<T>;
}

export function fetchPi<T>(path: string, opts?: FetchOpts): Promise<T> {
  return fetchJson<T>(`/api/pi/${path}`, opts);
}

export function fetchEvo<T>(path: string, opts?: FetchOpts): Promise<T> {
  return fetchJson<T>(`/api/evo/${path}`, opts);
}

export function postPi<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(`/api/pi/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function postEvo<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(`/api/evo/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Registered groups with merged participation posture (dashboard token on Pi proxy). */
export function fetchParticipationGroups(): Promise<ParticipationGroupsResponse> {
  return fetchPi<ParticipationGroupsResponse>('participation/groups');
}

/** Recent participation decisions (newest first), optional limit capped server-side. */
export function fetchParticipationDecisions(limit?: number): Promise<ParticipationDecisionsResponse> {
  const q =
    limit !== undefined && Number.isFinite(limit)
      ? `?limit=${encodeURIComponent(String(Math.trunc(limit)))}`
      : '';
  return fetchPi<ParticipationDecisionsResponse>(`participation/decisions${q}`);
}
