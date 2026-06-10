// NomaeROOMS relay — a single-process WebSocket hub.
//
// Protocol (text frames, JSON):
//   client → server:  {t:"host",  code, profile}   register as host of room
//   client → server:  {t:"join",  code, profile}   register as guest
//   client → server:  {t:"leave"}                  leave current room
//   any → server:     {t:"relay", to?:id, ...}     forward to peers in room (or specific id)
//   server → client:  {t:"wel",  id, seed, peers, host}   host → guest welcome
//   server → client:  {t:"join", id, name, color}  someone joined (everyone in room)
//   server → client:  {t:"leave",id}               someone left
//   server → client:  {t:"peer", ...}              relayed payload (with from id added)
//   server → client:  {t:"err",  msg}              error
//
// Room rules:
//   - Room code is 6 chars (any case, normalized to uppercase).
//   - First client to send {t:"host"} for a code becomes the host.
//   - Subsequent {t:"join"} clients become guests.
//   - When host disconnects, the room is closed and all guests are dropped.
//   - Max ~24 clients per room (Render's free tier is single-process, so we keep it sane).
//
// Why this exists: PeerJS P2P kept failing on networks with restricted NAT
// (school/corporate/firewalled). Host and guests both make a single outbound
// wss:// connection to this relay — no inbound ports, no TURN, no NAT punch.
// Cloudflare fronts Render; the URL works from almost any network.

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = process.env.PORT || 10000;
const HEARTBEAT_MS = 30_000;
const MAX_PEERS_PER_ROOM = 24;

const http = createServer((req, res) => {
  // Health check + friendly landing for humans hitting the URL in a browser.
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers: peerCount() }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('nomaerooms relay. connect via WebSocket.\n');
});

const wss = new WebSocketServer({ server: http });

/** code -> { host: peer, guests: Map<id, peer>, seed: number } */
const rooms = new Map();
/** peer -> { id, code, role: 'host'|'guest' } */
const peerMeta = new WeakMap();

function peerCount() {
  let n = 0;
  for (const r of rooms.values()) n += 1 + r.guests.size;
  return n;
}

function send(peer, msg) {
  if (peer.readyState !== 1 /* OPEN */) return;
  try { peer.send(JSON.stringify(msg)); } catch { /* peer vanished */ }
}

function broadcast(room, msg, exceptId = null) {
  if (room.host && room.host !== peerById(exceptId)) send(room.host, msg);
  for (const [id, g] of room.guests) {
    if (id !== exceptId) send(g, msg);
  }
}

function peerById(id) {
  for (const room of rooms.values()) {
    if (room.host?.__nomaeId === id) return room.host;
    const g = room.guests.get(id);
    if (g) return g;
  }
  return null;
}

function leaveRoom(peer) {
  const meta = peerMeta.get(peer);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room) return;

  if (meta.role === 'host') {
    // host gone → room collapses
    for (const [gid, g] of room.guests) {
      send(g, { t: 'err', msg: 'host left' });
      try { g.close(1000, 'host left'); } catch { /* */ }
    }
    rooms.delete(meta.code);
  } else {
    room.guests.delete(meta.id);
    broadcast(room, { t: 'leave', id: meta.id });
  }
  peerMeta.delete(peer);
}

function makePeer(ws) {
  ws.__nomaeId = randomUUID().slice(0, 8);
  let alive = true;

  const hb = setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch { /* */ } clearInterval(hb); return; }
    alive = false;
    try { ws.ping(); } catch { /* */ }
  }, HEARTBEAT_MS);

  ws.on('pong', () => { alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { t: 'err', msg: 'bad json' }); }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'host') {
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (code.length !== 6) return send(ws, { t: 'err', msg: 'bad code' });
      if (rooms.has(code)) return send(ws, { t: 'err', msg: 'room taken' });
      const room = { host: ws, guests: new Map(), seed: Number(msg.seed) || 0, hostProfile: msg.profile || null };
      rooms.set(code, room);
      peerMeta.set(ws, { id: ws.__nomaeId, code, role: 'host' });
      send(ws, { t: 'wel', id: ws.__nomaeId, code });
      console.log(`[host] ${ws.__nomaeId} opened ${code}`);
      return;
    }

    if (msg.t === 'join') {
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (code.length !== 6) return send(ws, { t: 'err', msg: 'bad code' });
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'err', msg: 'no such room' });
      if (room.guests.size >= MAX_PEERS_PER_ROOM) return send(ws, { t: 'err', msg: 'room full' });

      const profile = {
        name: String(msg.profile?.name || 'lost one').slice(0, 16),
        color: msg.profile?.color || '#7da2ff',
      };
      const peers = [...room.guests].map(([id]) => ({ id }));
      room.guests.set(ws.__nomaeId, ws);
      peerMeta.set(ws, { id: ws.__nomaeId, code, role: 'guest' });
      const hostId = peerMeta.get(room.host)?.id;
      send(ws, {
        t: 'wel', id: ws.__nomaeId, code, seed: room.seed,
        host: room.hostProfile, hostId, peers,
      });
      broadcast(room, { t: 'join', id: ws.__nomaeId, ...profile }, ws.__nomaeId);
      console.log(`[join] ${ws.__nomaeId} → ${code} (now ${room.guests.size} guests)`);
      return;
    }

    if (msg.t === 'leave') { leaveRoom(ws); return; }

    if (msg.t === 'relay') {
      const meta = peerMeta.get(ws);
      if (!meta) return;
      const room = rooms.get(meta.code);
      if (!room) return;
      const { to, t: _ignored, ...payload } = msg;
      const out = { t: 'peer', from: meta.id, ...payload };
      if (to) {
        if (to === 'host') send(room.host, out);
        else send(room.guests.get(to), out);
      } else {
        // to the opposite role (so guests broadcast to host, host broadcasts to guests)
        if (meta.role === 'guest') send(room.host, out);
        else for (const g of room.guests.values()) send(g, out);
      }
      return;
    }
  });

  ws.on('close', () => { clearInterval(hb); leaveRoom(ws); });
  ws.on('error', () => { clearInterval(hb); try { ws.terminate(); } catch { /* */ } });
}

wss.on('connection', makePeer);

http.listen(PORT, () => {
  console.log(`[nomaerooms-relay] listening on :${PORT}`);
});
