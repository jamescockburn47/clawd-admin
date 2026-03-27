// src/sse.js — SSE (Server-Sent Events) client management and broadcasting
// Single source of truth for SSE — imported by http-server.js, widgets.js, handler.js, message-handler.js

const sseClients = new Set();

export function addSSEClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
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
