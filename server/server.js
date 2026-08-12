/**
 * server.js
 * ------------------------------------------------------
 * A deliberately dumb WebSocket relay for Mini MOBA's PvP mode.
 *
 * It does NOT run any game logic - it just:
 *   1. Lets a client create a "room" (returns a short room code).
 *   2. Lets a second client join that room with the code.
 *   3. Forwards every message one peer sends straight to the other.
 *
 * All the actual simulation (positions, HP, damage, creeps, towers)
 * happens client-side - the host player's browser runs the real game
 * and broadcasts state; the guest's browser just renders it and sends
 * its input back. This server only ever sees opaque JSON blobs.
 *
 * Run it with:
 *   npm install
 *   node server.js
 * (defaults to port 8080; override with the PORT env var)
 * ------------------------------------------------------
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const wss = new WebSocket.Server({ port: PORT, host: HOST });

// roomCode -> { host: ws|null, guest: ws|null }
const rooms = new Map();

/**
 * Generates a short, easy-to-read-aloud room code (avoids visually
 * ambiguous characters like 0/O and 1/I).
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function send(ws, type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null; // 'host' | 'guest'

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return; // ignore malformed messages
    }

    switch (msg.type) {
      case 'host': {
        const code = generateRoomCode();
        rooms.set(code, { host: ws, guest: null });
        ws.roomCode = code;
        ws.role = 'host';
        send(ws, 'room-created', { roomCode: code });
        break;
      }

      case 'join': {
        const code = (msg.data && msg.data.roomCode || '').toUpperCase();
        const room = rooms.get(code);

        if (!room) {
          send(ws, 'join-failed', { reason: 'Room not found.' });
          return;
        }
        if (room.guest) {
          send(ws, 'join-failed', { reason: 'Room is already full.' });
          return;
        }

        room.guest = ws;
        ws.roomCode = code;
        ws.role = 'guest';

        send(ws, 'joined', { roomCode: code });
        send(room.host, 'peer-joined', {});
        break;
      }

      // Every other message type is just relayed to whichever peer
      // is on the other end of this client's room (state snapshots
      // from the host, input from the guest, etc.)
      default: {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const peer = ws.role === 'host' ? room.guest : room.host;
        send(peer, msg.type, msg.data);
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const peer = ws.role === 'host' ? room.guest : room.host;
    send(peer, 'peer-left', {});

    if (ws.role === 'host') {
      // Host leaving ends the match for good - drop the room.
      rooms.delete(ws.roomCode);
    } else {
      room.guest = null;
    }
  });
});

console.log(`Mini MOBA relay server listening on ws://${HOST}:${PORT}`);
console.log('(Render/production: this process is reached externally via wss://<your-app>.onrender.com — Render terminates TLS and proxies to this port for you.)');
