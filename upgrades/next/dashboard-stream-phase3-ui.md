# Pool dashboard streaming — phase 3: the click-to-stream UI

## What Changed

The single-dashboard streaming feature is now usable on screen. Remote session tiles (sessions running on another machine, surfaced via `/sessions?scope=pool`) are now clickable — selecting one streams its terminal from the owning machine through the relay, with a "streaming from <machine>" note. Input is sent with the session's machineId so the server relays it (the owning machine enforces its own remote-input gate). Every failure state is shown honestly in the terminal — machine-unreachable, peer-stream-lost (reconnecting), input-not-allowed, session-transferred, invalid/not-found — never a frozen screen or a silently swallowed keystroke. The dashboard WebSocket now resubscribes the active session after a reconnect so a server restart doesn't strand the terminal.

## What to Tell Your User

It's live: open your dashboard, click any session — including ones on your other machines — and watch it stream. Typing into a remote machine is off by default (turn it on per machine in settings).

- audience: user
- maturity: stable

## Summary of New Capabilities

- Remote session tiles are clickable → stream the session from its owning machine.
- Input/keys carry machineId for remote sessions (server relays; owner gates).
- Honest on-screen states for every stream failure (no frozen/silent UI).
- WS reconnect resubscribes the active session (survives server restarts).

## Evidence

- `dashboard/index.html` inline JS — extracted + `node --check` clean.
- The engine beneath is covered by the phase 1/2a/2b suites (PeerStreamProxy 13,
  StreamTicketStore 11, WSManager routing 34, two serving + round-trip e2e).
- Live-verified on the laptop+Mini pair (click a Mini session from the laptop
  dashboard → streams).
