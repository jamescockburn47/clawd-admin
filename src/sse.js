// src/sse.js — SSE (Server-Sent Events) client management and broadcasting
// Single source of truth for SSE — imported by http-server.js, widgets.js, handler.js, message-handler.js

const sseClients = new Set();
let heartbeatTimer = null;

export function addSSEClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
  // Send immediate connected event so client knows link is live
  try { res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`); } catch { /* intentional: SSE client may have already disconnected */ }
  startHeartbeat();
}

export function getSSEClientCount() {
  return sseClients.size;
}

export function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (_) { sseClients.delete(client); }
  }
}

// 30-second heartbeat keeps TCP connections alive and lets clients detect dead links
function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (sseClients.size === 0) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      return;
    }
    for (const client of sseClients) {
      try { client.write(`: heartbeat ${Date.now()}\n\n`); } catch (_) { sseClients.delete(client); }
    }
  }, 30_000);
}
