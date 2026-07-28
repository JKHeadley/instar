---
title: "Pool Dashboard Streaming — click + stream any machine's session from one dashboard"
slug: "pool-dashboard-stream"
author: "echo"
eli16-overview: "POOL-DASHBOARD-STREAM-SPEC.eli16.md"
status: "converged-approved"
review-convergence: "2026-06-06 (3 independent lenses: security / ops-scalability / UX-truthfulness)"
approved: true
approved-by: "justin"
approved-evidence: "Topic 13481, 2026-06-06 ~17:0x PDT: asked to improve the dashboard ('everything should be accessible from one single dashboard … this is not scalable'); after I sent the converged plan and surfaced the one product decision (remote-input default), he replied 'Go' — confirming the design incl. remote-input OFF by default."
layer: "core-instar-primitive"
parent-principle: "Structure beats Willpower — one dashboard streams every machine's session by machinery, not by the operator remembering which machine owns which session"
project: "multimachine-coherence"
project-items: "dashboard-stream P1 peer-stream-proxy, P2 wsmanager-wiring + ticket-auth, P3 dashboard-error-state-ui"
supervision: "tier0 — deterministic frame relay over an authenticated upstream; auth (one-time ticket) and input gating (allowRemoteInput default-off) are structural, not LLM decisions."
---

# Pool Dashboard Streaming — click + stream ANY machine's session from one dashboard

**Status:** converged round 2 (3 independent lenses: security / ops-scalability / UX-truthfulness)
**Author:** echo, 2026-06-06
**Origin:** Justin (topic 13481, 2026-06-06 ~13:36 PDT): "everything should be
accessible from one single dashboard — right now if I access the dashboard for
the laptop, it does show sessions for the Mac mini but I can't click and stream
those sessions. This is not scalable."

## 1. Problem

`GET /sessions?scope=pool` folds every machine's sessions into one machine-tagged
list and the dashboard renders them — but terminal streaming (`WebSocketManager`:
subscribe / output / history / input / key over one WS) only reaches LOCAL tmux
sessions. A Mini tile on the laptop dashboard is a dead tile (read-only,
un-clickable). The user must know which machine owns a session and open that
machine's dashboard — the per-machine fragmentation the pool exists to remove.

## 2. Shape

When a dashboard client subscribes to a session this machine does not host, the
WebSocketManager relays the subscription to the owning machine over an
authenticated upstream WebSocket and relays frames both ways. The machine hop is
invisible to the click, surfaced only where honesty requires (§2.4).

```
[browser] --WS (PIN-gated, unchanged)--> [laptop WSManager]
                                            | local session? -> existing path
                                            | remote session?
                                            +--upstream WS (ticket-auth)--> [mini /ws/pool-stream]
```

### 2.1 Session->machine resolution + name validation
- The pool fold tags each session with `machineId`; the dashboard passes it in
  the subscribe frame (`{ type:'subscribe', session, machineId? }`).
- `machineId` absent or == self -> existing local path, byte-for-byte.
- RE-RESOLVE, NEVER TRUST THE HINT (sec#3, ops#9): on EVERY frame carrying a
  session name (subscribe AND input/key), resolve against the LOCAL running set
  first: local -> serve locally (covers a session that moved here); not local +
  reachable peer -> relay; not local + no/unreachable machine -> machine-unreachable.
- SESSION-NAME VALIDATION (sec#3, CRIT for input): before any name reaches tmux
  (local OR proxied) it must (a) match `^[A-Za-z0-9_.:@-]+$` and (b) exist in
  `listRunningSessions()`. Failing -> `{type:'error',session,code:'invalid-session'}`,
  never passed to send-keys/capture-pane. Closes tmux target injection via a
  crafted proxied session (e.g. `s; touch /tmp/pwned #`).

### 2.2 Upstream proxy lifecycle (the scalability core)
- ONE multiplexed upstream WS per peer (`PeerStreamProxy`), lazily opened on the
  first remote subscription, shared by all clients and all sessions on that peer;
  reference-counted, closed after a 60s idle grace.
- TAP POINT (ops#1, CRIT): remote subscriptions are intercepted at the SUBSCRIBE
  handler and tracked in a SEPARATE remote-subscription map — they never enter
  the local polling/diff loop. Capture+diff for a session happens ONLY on its
  owning machine; this machine just fans relayed frames to its local subscribers.
  (Without this the relay double-polls every remote session — O(sessions x
  clients x peers); with it the fleet cost is O(subscriptions).)
- STATE MACHINE (ops#2/3/4): `PeerStreamProxy` owns an atomic state+refcount
  (`idle-scheduled -> active -> closing -> closed`). A subscribe during the idle
  grace CAS-reactivates to `active`; the idle timer only closes when refcount==0
  at fire time. A reconnect keeps pending subscriptions in a queue merged into
  the resubscribe batch (a subscribe arriving mid-reconnect is never lost). On
  each subscribe the peer URL is re-resolved from the registry; a changed URL
  closes the old proxy and opens a new one (no stale-URL duplicate proxies).
- Frames relay 1:1 with the session name unchanged; output/history/session_ended
  fan out to every local client subscribed to that (peer, session).
- Upstream drop -> every affected client gets
  `{type:'error',code:'peer-stream-lost',session}` + ONE bounded reconnect with
  resubscribe; a 10s reconnect timeout or a second failure surfaces
  `machine-unreachable` (no reconnect storms — P19).
- Backpressure: per-client bounded output (drop-oldest, max 1 in-flight frame
  per (client,session), keyed on a per-client UUID — ops#8, NOT `_socket.remotePort`).
  NOTE (ops#6): the LOCAL path today does NOT drop-oldest (it relies on the OS
  socket buffer); this proxy ADDS the bounded queue rather than claiming parity.

### 2.3 Auth — the security boundary
- Browser side unchanged: dashboard PIN/session gating exactly as today. The PIN
  never crosses machines; no Bearer token ever appears in a URL.
- UPSTREAM AUTH = SHORT-LIVED TICKET (sec#1, CRIT; resolves R1-Q3): the peer
  requests an ephemeral one-time stream ticket via an existing machine-auth-signed
  HTTP POST (`/pool-stream/ticket`), valid ~30-60s, single-use. The WS upgrade
  carries the ticket in a header; the serving side validates+consumes it and
  attaches a SERVER-GENERATED session id to the WS. This gives bounded lifetime,
  revocability, and avoids authenticating a long-lived WS once at upgrade then
  trusting every later frame (the signed-headers-at-upgrade replay window). The
  ticket nonce store is persisted so a captured ticket can't be replayed across a
  restart (sec#4).
- INPUT FORWARDING DEFAULT-OFF (sec#2, HIGH; resolves R1-Q2): remote keystroke
  forwarding is a lateral-movement / credential-exfil vector (a compromised peer
  could type `cat ~/.ssh/...` into a clean machine's session). It is OFF by
  default; an operator opts in per machine via
  `dashboard.poolStream.allowRemoteInput: true`. Read-only streaming is the safe
  default; this is the one place the spec overrides "both machines are the same
  operator's" convenience for safety.
- The serving side treats proxied subscriptions exactly like local dashboard
  clients (rate limits, per-session existence checks); machine trust never
  bypasses a per-session guard.

### 2.4 Failure honesty (UX — every state visually distinct; no lying terminal)
New error `code`s the dashboard MUST render distinctly (UX review):
- `machine-unreachable` — peer offline at subscribe: tile shows
  "unreachable — <nickname>", terminal prints a red notice, never a black box.
- `peer-stream-lost` — mid-stream drop: terminal prints "[reconnecting...]" +
  RECONNECTING badge; on timeout/2nd-fail -> "[stream lost]" + UNREACHABLE badge;
  input disabled until recovery.
- `input-not-allowed` — peer has remote input off: input box rendered read-only
  with a tooltip ("this machine doesn't allow remote control"); a typed attempt
  shows a toast, never a silent swallow.
- `session-transferred` (carries `newMachineId`) — session moved mid-view:
  "[moved to <nickname>] — reload to follow", not a bare `session_ended`.
- A live remote tile shows a STREAMING indicator + the machine badge so the user
  can tell live-now from stale, and that latency applies (a remote hop).

### 2.5 Restart resilience (ops#5)
- Browser: on local-WS close (laptop restarts ~hourly on release), the client
  clears the terminal, reconnects with backoff, requests the session list, and
  resubscribes — a release wave must not strand tiles. CLIENT responsibility,
  REQUIRED by this spec.
- Serving peer restart mid-relay: upstream frames stop -> `peer-stream-lost` ->
  bounded reconnect -> recovers or honest UNREACHABLE.

### 2.6 Activation
- Active only when the session pool is live (registry + peer URLs exist);
  single-machine installs no-op at zero cost. Read streaming is intrinsic to
  "the dashboard shows pool sessions" (a dead tile is a bug, not a gated
  feature); INPUT across machines is the only gated part (§2.3, default-off).
  (Resolves R1-Q1.)

## 3. Non-goals
- No cross-machine session CONTROL beyond local dashboard parity (kill/restart
  stay on the owning machine for v1 — natural v2, same ticket-auth pattern).
- No recording/replay; no multi-hop relay (peers must be directly reachable via
  registered URLs, as for every pool feature).
- No change to lifeline/standby streaming.

## 4. Test plan (three tiers)
- Tier 1: PeerStreamProxy state machine (multiplex/refcount/idle-close races,
  reconnect-queue merge, peer-URL change), hint-staleness re-resolution,
  session-name validation (injection rejected), input-default-off gate, ticket
  one-time-use + expiry + cross-restart replay rejection, bounded-queue drop-oldest.
- Tier 2: two WSManager instances back-to-back in-process (upstream transport
  injected) — subscribe->output->input round trip, fan-out to 2 clients,
  unsubscribe refcounting, peer-drop -> error frame -> reconnect.
- Tier 3: feature-alive — dashboard WS against the full server with a fake peer:
  remote subscribe yields output OR honest machine-unreachable; single-machine
  boot unaffected; ticket endpoint requires machine-auth.

## 5. Convergence log
- R1-Q1 (flag vs intrinsic): RESOLVED — read streaming intrinsic when pool live;
  remote INPUT gated default-off.
- R1-Q2 (input default): RESOLVED — DEFAULT-OFF (security: lateral movement).
- R1-Q3 (WS upgrade auth): RESOLVED — short-lived one-time ticket over the
  machine-authed HTTP channel + server-issued session id; persisted nonce store.
- Security findings folded: sec#1 ticket, sec#2 default-off, sec#3 name
  validation, sec#4 persisted nonce, sec#5 redact machineId in routine logs.
- Ops findings folded: ops#1 tap-at-subscribe, ops#2-4 proxy state machine,
  ops#5 browser reconnect, ops#6 honest backpressure, ops#7 O(subscriptions),
  ops#8 UUID client key.
- UX findings folded: all error-code states + live/latency/input-disabled/
  transferred presentations (§2.4).
