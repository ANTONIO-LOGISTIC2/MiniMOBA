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

### Server address quick reference

| Scenario | Server address to enter |
|---|---|
| Same machine (browser tabs, dev) | `ws://localhost:8080` |
| Same Wi-Fi / LAN (e.g. phone + PC) | `ws://<host's-LAN-IP>:8080` (e.g. `ws://192.168.8.103:8080`) |
| Internet / different networks / mobile data | `wss://<your-render-app>.onrender.com` |

## Deploying to Render.com (production / Internet PvP)

Render gives the process a public `wss://` address automatically (it
terminates TLS for you and proxies to whatever `PORT` it tells your app to
listen on via the `PORT` env var - this server already reads that).

**Step-by-step:**

1. Push this repo (including the `server/` folder) to GitHub if you haven't
   already - Render deploys from a Git repo.
2. Go to [render.com](https://render.com) → sign in → **New +** → **Web Service**.
3. Connect your GitHub account and select the `MiniMOBA` repository.
4. Configure the service:
   - **Name**: anything, e.g. `minimoba-relay`
   - **Root Directory**: `server`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (fine for a relay this light)
5. Click **Create Web Service**. Render will install dependencies and run
   `npm start` (which runs `node server.js`).
6. Wait for the deploy logs to show:
   ```
   Mini MOBA relay server listening on ws://0.0.0.0:<port>
   ```
   Render sets `PORT` itself - you don't need to configure it manually. The
   server also accepts an optional `HOST` env var (defaults to `0.0.0.0`,
   which is what you want here - leave it unset on Render).
7. Once deployed, Render shows a public URL like:
   ```
   https://minimoba-relay.onrender.com
   ```
   Your WebSocket address is the same host with `wss://` instead of `https://`:
   ```
   wss://minimoba-relay.onrender.com
   ```

Put that `wss://...` address into the game's **Server address** field (both
players need to use the same address) - no client code changes needed.

**Note on Render's free tier:** free web services spin down after a period
of inactivity and take a few seconds to wake up on the next connection. If
`connect()` seems to time out on the very first attempt after idling, just
retry - the instance will be warm after that. This doesn't affect an
already-running match.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port the relay listens on. Render sets this automatically - don't hardcode it. |
| `HOST` | `0.0.0.0` | Network interface to bind to. `0.0.0.0` (the default) is correct for both local dev and Render; you shouldn't need to change it. |

## Other hosting options

Railway.app, Fly.io, or your own VPS also work with the same `npm install` /
`npm start` commands and zero code changes - only the resulting `wss://`
URL differs. Use `pm2` or a systemd service on a VPS so the process survives
reboots/crashes.

## Notes

- One `node server.js` process can host many simultaneous rooms - the room
  code is all that separates matches, so you don't need to run multiple
  copies for multiple concurrent games.
- If a host disconnects, the room is torn down (the match can't continue
  without them, since they're the one running the simulation). If a guest
  disconnects, the room stays open in case they reconnect.
- This server never looks at the *contents* of game messages - it's fully
  game-agnostic and would relay for any two-peer game built the same way.
