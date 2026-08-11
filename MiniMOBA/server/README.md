# Mini MOBA - PvP Relay Server

This is a tiny WebSocket relay. It has **no game logic** - it only pairs two
players by a 5-letter room code and forwards whatever JSON messages they send
to each other. All the actual game simulation runs in the **host's** browser.

## Run it locally (for testing on one machine/network)

```bash
cd server
npm install
npm start
```

You should see:
```
Mini MOBA relay server listening on ws://0.0.0.0:8080
```

In the game's PvP connect screen, set the server address to:
```
ws://localhost:8080
```
(or `ws://<your-LAN-IP>:8080` if the other device is on the same Wi-Fi).

## Hosting it for real (different devices, different networks)

You need somewhere that keeps a Node.js process running and gives you a
public address. A few options that work with zero config changes beyond the
URL:

- **Render.com** / **Railway.app** - point them at this `server/` folder,
  build command `npm install`, start command `npm start`. Free tiers exist.
- **Fly.io** - similar, deploy via their CLI.
- **A VPS you already have** - `npm install && npm start` (use `pm2` or a
  systemd service so it survives reboots/crashes).

Whichever you pick, once it's live you'll get a URL like
`your-app-name.onrender.com`. Because it's WebSockets, use:
```
wss://your-app-name.onrender.com
```
(`wss://` not `ws://` - required once the server is behind HTTPS, which all
of the above give you automatically).

Put that address into the game's PvP connect screen (both players need the
same address) and you're set - no code changes needed on the client.

## Notes

- One `node server.js` process can host many simultaneous rooms - the room
  code is all that separates matches, so you don't need to run multiple
  copies for multiple concurrent games.
- If a host disconnects, the room is torn down (the match can't continue
  without them, since they're the one running the simulation). If a guest
  disconnects, the room stays open in case they reconnect.
- This server never looks at the *contents* of game messages - it's fully
  game-agnostic and would relay for any two-peer game built the same way.
