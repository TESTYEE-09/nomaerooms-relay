# nomaerooms-relay

Tiny WebSocket relay for [NomaeROOMS](https://github.com/TESTYEE-09/nomaerooms)
multiplayer.

The game used to do P2P over PeerJS, which kept failing on networks with
restricted NAT — the host and guest couldn't punch through and just spun.
This relay is a different architecture: both clients open a single outbound
`wss://` to this server, which relays state between them. No P2P, no TURN,
no NAT traversal. Works from almost any network that allows port-443
egress.

## One-click deploy to Render

**This is the only step the user has to do.** Everything else is
automated.

Click this button, sign in to Render if prompted, and click **Apply**:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://dashboard.render.com/blueprint/new?repo=https%3A%2F%2Fgithub.com%2FTESTYEE-09%2Fnomaerooms-relay)

That's it. Render will:
1. Fork this repo into your Render account (if not already)
2. Read `render.yaml` and create a free `web` service
3. Build (`npm install`) and start (`node server.js`)
4. Give it a public URL: **`https://nomaerooms-relay.onrender.com`**
5. Auto-deploy on every push to `main` from now on

The NomaeROOMS client reads `VITE_RELAY_URL` from the build env, falling
back to `wss://nomaerooms-relay.onrender.com` — so the moment Render gives
the service a URL, the game just works.

## Protocol

JSON over a single WebSocket frame per message.

| Direction  | Frame                                       | Notes                              |
| ---------- | ------------------------------------------- | ---------------------------------- |
| client→srv | `{t:"host",  code, seed, profile}`          | Register as host of `code` (6 chars) |
| client→srv | `{t:"join",  code, profile}`                | Register as guest                  |
| client→srv | `{t:"leave"}`                               | Leave the room                     |
| client→srv | `{t:"relay", to?, m, ...payload}`           | Forward a game message (`m` is the inner game type; omit `to` = broadcast to opposite role) |
| srv→client | `{t:"wel",  id, code, seed?, host?, peers?}`| Host or guest welcome              |
| srv→client | `{t:"join", id, name, color}`               | Someone joined                     |
| srv→client | `{t:"leave",id}`                            | Someone left                       |
| srv→client | `{t:"peer", from, m, ...payload}`           | Relayed game payload (with `from` set to sender's id) |
| srv→client | `{t:"err",  msg}`                           | Error                              |

If the host disconnects, the room is closed and all guests are dropped.
Heartbeat: 30s ping/pong. Max 24 clients per room (Render free tier is
single-process, so we keep it sane).

## Develop locally

```bash
npm install
node server.js          # listens on :10000 (or $PORT)
node smoketest.mjs      # requires the server running — exercises the protocol
```

## License

MIT, same as the game.
