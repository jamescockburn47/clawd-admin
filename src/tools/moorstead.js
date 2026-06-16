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

/**
 * moorstead_bairns_status — bairns world controls + today's play time.
 * No params.
 */
export async function moorsteadBairnsStatus() {
  try {
    const res = await fetch(`${baseUrl()}/admin/bairns-controls`, {
      method: 'GET',
      headers: relayHeaders(),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return `Moorstead relay error ${res.status}: ${errBody || res.statusText}`;
    }
    const data = await res.json();
    const controls = data.controls || {};
    const limitMin = controls.daily_limit_min ?? 0;
    const limitStr = limitMin === 0 ? 'no time limit' : `${limitMin} min/day`;
    const closed = controls.closed;
    const closedStr = closed ? `Closed ${closed.from}–${closed.to}.` : 'No closed window.';
    const openStr = data.closed_now ? 'Closed now.' : 'Open now.';
    const todaySec = data.today_seconds || {};
    const pids = Object.keys(todaySec);
    let todayStr;
    if (pids.length === 0) {
      todayStr = 'No play today.';
    } else {
      const maxMin = Math.round(Math.max(...Object.values(todaySec)) / 60);
      todayStr = `Today: ${pids.length} bairn${pids.length === 1 ? '' : 's'} played (max ${maxMin}m).`;
    }
    return `*Bairns world* — limit: ${limitStr}. ${closedStr} ${openStr} ${todayStr}`;
  } catch (err) {
    return `Moorstead bairns status failed: ${err.message}`;
  }
}

const HH_MM = /^\d{1,2}:\d{2}$/;

/**
 * moorstead_bairns_set — update bairns world controls.
 * input: { limitMinutes?, warnSeconds?, locked?, closeFrom?, closeTo?, clearClosed? }
 */
export async function moorsteadBairnsSet(input) {
  // Validate HH:MM fields before touching the network
  if (input.closeFrom !== undefined && !HH_MM.test(input.closeFrom)) {
    return `Invalid closeFrom "${input.closeFrom}" — expected HH:MM format.`;
  }
  if (input.closeTo !== undefined && !HH_MM.test(input.closeTo)) {
    return `Invalid closeTo "${input.closeTo}" — expected HH:MM format.`;
  }

  const body = {};
  if (input.limitMinutes !== undefined) body.daily_limit_min = input.limitMinutes;
  if (input.warnSeconds !== undefined) body.warn_sec = input.warnSeconds;
  if (input.locked !== undefined) body.locked = input.locked;
  if (input.clearClosed === true) {
    body.closed = null;
  } else if (input.closeFrom !== undefined || input.closeTo !== undefined) {
    body.closed = { from: input.closeFrom, to: input.closeTo };
  }

  try {
    const res = await fetch(`${baseUrl()}/admin/bairns-controls`, {
      method: 'POST',
      headers: relayHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return `Moorstead relay error ${res.status}: ${errBody || res.statusText}`;
    }
    const data = await res.json();
    const controls = data.controls || {};
    const limitMin = controls.daily_limit_min ?? 0;
    const limitStr = limitMin === 0 ? 'no time limit' : `${limitMin} min`;
    const closed = controls.closed;
    const closedStr = closed ? `, closed ${closed.from}–${closed.to}` : ', no closed window';
    const lockedStr = controls.locked ? ', world locked' : '';
    return `Bairns world updated — daily limit ${limitStr}${closedStr}${lockedStr}.`;
  } catch (err) {
    return `Moorstead bairns set failed: ${err.message}`;
  }
}
