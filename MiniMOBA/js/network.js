/**
 * network.js
 * ------------------------------------------------------
 * Thin wrapper around a WebSocket connection to the relay server
 * (see server/server.js). Handles:
 *   - Connecting to a server address the player types in.
 *   - Hosting a match (asks the server for a room code) or joining
 *     one (gives the server a room code someone else generated).
 *   - A simple pub/sub API (`on`/`send`) so the rest of the game
 *     doesn't need to know anything about WebSockets directly.
 *
 * This class is deliberately dumb about game content - it just
 * ships whatever plain-object payload it's given, tagged with a
 * string type, and hands incoming messages to whoever registered
 * for that type.
 * ------------------------------------------------------
 */
class NetworkClient {
  constructor() {
    this.socket = null;
    this.role = null; // 'host' | 'guest'
    this.roomCode = null;
    this.isConnected = false;

    // type -> array of callback(data)
    this._listeners = {};
  }

  /**
   * Registers a callback for a message type. Multiple listeners per
   * type are supported (last-registered isn't overwritten).
   * @param {string} type
   * @param {(data: Object) => void} callback
   */
  on(type, callback) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(callback);
  }

  /**
   * Removes one previously-registered callback for a message type.
   * Needed for rematches: a Game/PvpGuestView registers 'state',
   * 'input', 'game-over', etc. listeners bound to itself, and since
   * `on()` is additive, a fresh instance re-registering the same
   * types without first calling this would leave the old (dead)
   * instance's callbacks still firing alongside the new one.
   * @param {string} type
   * @param {(data: Object) => void} callback
   */
  off(type, callback) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(cb => cb !== callback);
  }

  _emit(type, data) {
    const callbacks = this._listeners[type];
    if (!callbacks) return;
    for (const cb of callbacks) cb(data);
  }

  /**
   * Opens the raw WebSocket connection. Resolves once it's open,
   * rejects on error or if it doesn't open within the timeout.
   * @param {string} serverUrl - e.g. "ws://localhost:8080" or "wss://your-server.onrender.com"
   */
  connect(serverUrl) {
    return new Promise((resolve, reject) => {
      let settled = false;

      try {
        this.socket = new WebSocket(serverUrl);
      } catch (err) {
        reject(new Error('Invalid server address.'));
        return;
      }

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.socket.close();
          reject(new Error('Connection timed out. Check the server address.'));
        }
      }, 8000);

      this.socket.addEventListener('open', () => {
        this.isConnected = true;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      this.socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Could not reach the server.'));
        }
      });

      this.socket.addEventListener('close', () => {
        this.isConnected = false;
        this._emit('disconnected', {});
      });

      this.socket.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          return;
        }
        this._emit(msg.type, msg.data || {});
      });
    });
  }

  /**
   * Asks the server to create a new room. Resolves with the room
   * code once the server confirms it.
   * @returns {Promise<string>}
   */
  hostMatch() {
    return new Promise((resolve) => {
      this.on('room-created', ({ roomCode }) => {
        this.role = 'host';
        this.roomCode = roomCode;
        resolve(roomCode);
      });
      this._send('host', {});
    });
  }

  /**
   * Attempts to join an existing room by code.
   * @param {string} roomCode
   * @returns {Promise<void>}
   */
  joinMatch(roomCode) {
    return new Promise((resolve, reject) => {
      this.on('joined', () => {
        this.role = 'guest';
        this.roomCode = roomCode;
        resolve();
      });
      this.on('join-failed', ({ reason }) => {
        reject(new Error(reason || 'Could not join that room.'));
      });
      this._send('join', { roomCode });
    });
  }

  /**
   * Sends a message to whichever peer is on the other end of the room.
   * @param {string} type
   * @param {Object} data
   */
  send(type, data) {
    this._send(type, data);
  }

  _send(type, data) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type, data }));
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
    }
  }
}
