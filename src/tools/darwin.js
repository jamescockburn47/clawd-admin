import config from '../config.js';

// --- Darwin: Live departures ---

let railClient = null;

async function getRail() {
  if (railClient) return railClient;
  const Rail = (await import('national-rail-darwin-promises')).default;
  railClient = new Rail(config.darwinToken);
  return railClient;
}

export async function trainDepartures({ from, to }) {
  const rail = await getRail();
  const opts = {};
  if (to) opts.destination = to;

  const board = await rail.getDepartureBoardWithDetails(from, opts);
  const services = board.trainServices || [];

  if (services.length === 0) {
    return `No departures found from ${from}${to ? ` to ${to}` : ''}.`;
  }

  const lines = services.slice(0, 10).map((s) => {
    const std = s.std || '??:??';
    const etd = s.etd || '';
    const platform = s.platform || '-';
    const dest = s.destination?.[0]?.locationName || '?';
    const operator = s.operator || '';
    const status = etd === 'On time' ? 'On time' :
                   etd === 'Cancelled' ? 'CANCELLED' :
                   etd === 'Delayed' ? 'Delayed' :
                   etd; // e.g. "15:42" for expected time
    return `${std} → ${dest} | Plat ${platform} | ${status} | ${operator}`;
  });

  const header = `*Live departures from ${board.locationName || from}*${to ? ` to ${to}` : ''}\n`;
  return header + lines.join('\n');
}

// --- BR Fares: Ticket prices ---

const fareCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours for walk-up fares

export async function trainFares({ from, to }) {
  const cacheKey = `${from}_${to}`;
  const cached = fareCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.result;
  }

  const url = `https://gw.brfares.com/legacy_querysimple?orig=${encodeURIComponent(from)}&dest=${encodeURIComponent(to)}`;
  const res = await fetch(url, {
    headers: { 'Accept-Encoding': 'gzip, deflate' },
  });

  if (!res.ok) {
    throw new Error(`BR Fares API returned ${res.status}`);
  }

  const data = await res.json();
  const fares = data.fares || [];

  if (fares.length === 0) {
    return `No fares found for ${from} → ${to}.`;
  }

  // Group by category: 0=walk-up, 1=advance, 2=other
  const groups = { advance: [], offpeak: [], anytime: [], other: [] };

  for (const f of fares) {
    const name = (f.ticket?.name || '').toLowerCase();
    const price = f.adult?.fare ? `£${(f.adult.fare / 100).toFixed(2)}` : '?';
    const cls = f.ticket?.class === '1' ? '1st' : 'Std';
    const type = f.ticket?.type === 'S' ? 'Single' : f.ticket?.type === 'R' ? 'Return' : f.ticket?.type || '';
    const entry = `${f.ticket?.name || 'Unknown'} (${cls} ${type}) — ${price}`;

    if (f.category === 1 || name.includes('advance')) {
      groups.advance.push({ entry, pence: f.adult?.fare || 999999 });
    } else if (name.includes('off-peak') || name.includes('off peak') || name.includes('super off')) {
      groups.offpeak.push({ entry, pence: f.adult?.fare || 999999 });
    } else if (name.includes('anytime')) {
      groups.anytime.push({ entry, pence: f.adult?.fare || 999999 });
    } else {
      groups.other.push({ entry, pence: f.adult?.fare || 999999 });
    }
  }

  // Sort each group by price
  for (const g of Object.values(groups)) {
    g.sort((a, b) => a.pence - b.pence);
  }

  let result = `*Fares: ${from} → ${to}*\n`;

  if (groups.advance.length) {
    result += `\n*Advance (cheapest, limited availability):*\n`;
    result += groups.advance.slice(0, 5).map((f) => `• ${f.entry}`).join('\n');
  }
  if (groups.offpeak.length) {
    result += `\n\n*Off-Peak:*\n`;
    result += groups.offpeak.slice(0, 5).map((f) => `• ${f.entry}`).join('\n');
  }
  if (groups.anytime.length) {
    result += `\n\n*Anytime (flexible):*\n`;
    result += groups.anytime.slice(0, 3).map((f) => `• ${f.entry}`).join('\n');
  }

  result += `\n\n_Prices are standard published fares. Advance fares vary by train — book early for best prices._`;

  fareCache.set(cacheKey, { result, ts: Date.now() });
  return result;
}
