# nomaerooms-relay

Tiny WebSocket relay for [NomaeROOMS](../nomaerooms) multiplayer.

The game used to be P2P over PeerJS, which kept failing on networks with
restricted NAT (school/corporate/firewalled) — the host and guest couldn't
punch through and just spun. This relay is a different architecture: both
clients open a single outbound `wss://` connection to this server, which
relays state between them. No P2P, no TURN, no NAT traversal. Works from
almost any network that allows port-443 egress.

## Deploy

The `render.yaml` is a [Render Blueprint](https://render.com/docs/blueprint-spec).
Either:

- Connect this repo to Render and it'll auto-deploy via the blueprint, OR
- Click the deploy button:

  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/TESTYEE-09/nomaerooms-relay)

The service will be available at `wss://nomaerooms-relay.onrender.com/`.
The NomaeROOMS client reads the URL from `VITE_RELAY_URL` (set in
`nomaerooms/.env.production` or via the Vite config) — point it at your
Render URL and ship.

## Protocol

JSON over a single WebSocket frame per message.

| Direction  | Frame                              | Notes                              |
| ---------- | ---------------------------------- | ---------------------------------- |
| client→srv | `{t:"host", code, seed, profile}`  | Register as host of `code` (6 chars) |
| client→srv | `{t:"join", code, profile}`        | Register as guest                  |
| client→srv | `{t:"leave"}`                      | Leave the room                     |
| client→srv | `{t:"relay", to?, ...payload}`     | Forward to peers (omit `to` = broadcast to opposite role) |
| srv→client | `{t:"wel", id, code, seed?, host?, peers?}` | Host or guest welcome |
| srv→client | `{t:"join", id, name, color}`      | Someone joined                     |
| srv→client | `{t:"leave", id}`                  | Someone left                       |
| srv→client | `{t:"peer", from, ...}`            | Relayed payload                    |
| srv→client | `{t:"err", msg}`                   | Error                              |

If the host disconnects, the room is closed and all guests are dropped.

## License

MIT, same as the game.
