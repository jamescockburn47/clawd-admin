// Moorstead game relay — admin tool handlers
// Calls the relay's /admin/* HTTP API on behalf of the bot owner.
// All errors are caught and returned as readable strings; nothing throws.

import config from '../config.js';

function relayHeaders() {
  return {
    'Authorization': `Bearer ${config.dashboardToken}`,
    'Content-Type': 'application/json',
  };
}

function baseUrl() {
  return (config.moorsteadRelayUrl || 'http://127.0.0.1:8096').replace(/\/$/, '');
}

/**
 * moorstead_status — who is playing, per room.
 * Returns e.g. "*Moorstead* — moor: Alice, Tom (2). dale: empty."
 */
export async function moorsteadStatus() {
  try {
    const res = await fetch(`${baseUrl()}/admin/presence`, {
      method: 'GET',
      headers: relayHeaders(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return `Moorstead relay error ${res.status}: ${body || res.statusText}`;
    }
    const data = await res.json();
    const rooms = data.rooms || {};
    const entries = Object.entries(rooms);
    if (entries.length === 0) return '*Moorstead* — no active rooms.';
    const parts = entries.map(([room, players]) => {
      if (!players || players.length === 0) return `${room}: empty`;
      const names = players.map(p => p.name || p.pid).join(', ');
      return `${room}: ${names} (${players.length})`;
    });
    return `*Moorstead* — ${parts.join('. ')}.`;
  } catch (err) {
    return `Moorstead status failed: ${err.message}`;
  }
}

/**
 * moorstead_broadcast — send a system message to players.
 * input: { text: string, room?: string }
 */
export async function moorsteadBroadcast(input) {
  const text = (input.text || '').trim();
  if (!text) return 'No message text provided.';
  const body = { text };
  if (input.room) body.room = input.room;
  try {
    const res = await fetch(`${baseUrl()}/admin/broadcast`, {
      method: 'POST',
      headers: relayHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return `Moorstead relay error ${res.status}: ${errBody || res.statusText}`;
    }
    const data = await res.json();
    const target = input.room ? ` to room *${input.room}*` : '';
    return `Broadcast sent${target} — ${data.sent ?? '?'} player(s) notified.`;
  } catch (err) {
    return `Moorstead broadcast failed: ${err.message}`;
  }
}

/**
 * moorstead_kick — disconnect a player by pid.
 * input: { pid: string }
 */
export async function moorsteadKick(input) {
  const pid = (input.pid || '').trim();
  if (!pid) return 'No pid provided.';
  try {
    const res = await fetch(`${baseUrl()}/admin/kick`, {
      method: 'POST',
      headers: relayHeaders(),
      body: JSON.stringify({ pid }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return `Moorstead relay error ${res.status}: ${errBody || res.statusText}`;
    }
    const data = await res.json();
    const rooms = (data.kicked || []).join(', ') || 'none';
    return `Player *${pid}* kicked from room(s): ${rooms}.`;
  } catch (err) {
    return `Moorstead kick failed: ${err.message}`;
  }
}
