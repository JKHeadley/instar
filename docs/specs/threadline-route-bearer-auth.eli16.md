# Threadline routes need the agent's token — Plain-English Overview

> The one-line version: the agent's own Threadline controls (send a message as me, discover agents, bind a hub topic, change bridge settings, read my conversations) now require the agent's API token like every other control; only the handful of routes that OTHER agents must reach without my token stay open, listed one by one.

## The problem in one breath

Every route that starts with `/threadline/` was waved past the token check, on the theory that those routes bring their own authentication. Some do. But many are the agent's own control surface, and the one that sends messages did not check anything. On 2026-10-27 that was confirmed from the outside: an unauthenticated request over the Studio's public tunnel reached the send route's "which fields are missing" check instead of being turned away. Anyone who knew the tunnel address could make the agent send Threadline messages under its own name, discover its peers, rebind its hub topics, change its Telegram-bridge settings, and read its conversation list.

## What already exists

- **The API token check** — one piece of middleware in front of every route. It lets a short list of things through without a token (health, ping, the dashboard unlock, and a few routes with their own authentication) and demands the agent's token for everything else.
- **Threadline's own peer authentication** — when another agent talks to me, it proves who it is with a key handshake and signed messages. Those routes genuinely cannot carry my token, because the other agent does not have it.
- **The Threadline helper process** — the small program Claude Code or Codex starts so I have the `threadline_*` tools. It already sends my token on almost every call; it gets the token from the session's environment, or from the config file.
- **A lint over the shipped job templates** — it checks that templates authenticate their calls, and it treated everything under `/threadline/` as public, mirroring the hole.

## What this adds

The token check no longer treats `/threadline/` as a public prefix. It now holds an explicit list of exactly six routes, each by method and full path, that stay open because another agent (not me) has to reach them and they authenticate themselves: the health card other agents read to find me, the two steps of the key handshake, the signed-message receive route, the signed thread-backfill route, and the loopback-only "request a secret" route. A seventh shape, fetching a blob by id, stays open too (it also demands the peer signature). Everything else under `/threadline/` now needs my token.

- The helper process now also sends the token on its one remaining token-less read (the relay status read).
- The helper process has a third place to find the token: the encrypted vault. On installs where the token was moved out of the plain config file into the vault, a hand-started Codex had no token at all and was only working because of the hole. It now reads the vault the same way the `secret-get` script does.
- The template lint now lists the same six routes as public, instead of the whole prefix, and has a test proving it flags an unauthenticated call to the send route.

## The new pieces

- **An exact-route allowlist in the middleware** — a small table of `(method, path)` pairs, exported so the lint and the tests read the same list. It matches whole paths only: `/threadline/healthz` or `/threadline/health/anything` is not public. It is not allowed to grow by prefix.
- **A token resolver for the helper process** — tries the environment, then a plain-text config token, then the vault; never uses the `{ secret: true }` placeholder as a token; yields nothing (and an honest 401 later) when the vault cannot be read. It never repairs or rotates anything.

## The safeguards

**Prevents an outsider from acting as the agent over the tunnel.** The send, discover, hub-bind, bridge-config and conversation-read routes refuse any request without the agent's token, before the handler runs. Tests replay the exact reported request shape (tunnel headers, no token, empty body) and assert a 401, and replay it with the token and assert it reaches the handler.

**Prevents breaking agent-to-agent traffic.** The six peer routes are proven open without a token by tests, by exact path and method. Other local agents' discovery probes and the mesh forwarder's health probe hit `/threadline/health`, which stays open.

**Prevents breaking my own tools.** Every legitimate caller was audited: the stdio helper, the mesh forwarder (already sends the token plus its boot secret), the dashboard and console (send the token after PIN unlock), pool-scope reads between my machines (send the token), and the existing e2e tests (send the token). The two gaps found, the helper's status read and the vault-only install, are closed in this change.

## What ships when

One PR, one release. No migration: nothing installed on agents changes shape, and the helper process is launched from the installed instar package, so it picks the change up with the update.

## What you actually need to decide

Nothing beyond merging: do you agree that only those six peer routes (plus blob fetch) should stay token-free, with everything else under `/threadline/` requiring the agent token?
