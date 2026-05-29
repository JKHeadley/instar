---
title: Cross-Session Coordination Signal (light, advisory)
status: approved
approved: true
approver: justin
approved-at: "2026-05-28T19:00:00Z"
review-convergence: "2026-05-28T19:00:00Z"
review-iterations: 3
review-completed-at: "2026-05-28T19:00:00Z"
review-report: "docs/specs/reports/cross-session-coordination-convergence.md"
created: 2026-05-28
owner: echo
eli16-overview: cross-session-coordination.eli16.md
---

# Cross-Session Coordination Signal (light, advisory)

> Approved direction: Justin, 2026-05-28 topic 15579 — "go with a light fix for now
> and see if it helps … learn to collaborate slowly and smoothly." This is the
> written form of the build Justin chose from the light/medium/heavy menu and saw
> described before approving. Convergence review:
> docs/specs/reports/cross-session-coordination-convergence.md.

## The problem (two observed incidents, 2026-05-28)

A single agent home can have **multiple concurrent Claude Code sessions** acting on
the same `.instar/` state. They are blind to each other. Two real incidents:

1. **Stale `active:true` ghost** — an autonomous-state file said `active:true` after
   the work had completed; a *different* session read it as "still in flight" and
   narrated "working." (Recovered easily. Treated as a SEPARATE staleness/liveness
   bug — out of scope for this signal; see "Out of scope".)
2. **Opposing durable actions (the damaging one)** — one session built the proper fix
   (PR 495); in parallel another session hit a "safety brake": flipped a config flag
   to `false` AND mass-withdrew ~19 active commitments. Both reached a correct local
   diagnosis; neither knew the other was acting. Net: bugs fixed, engine off, test
   bed gone.

Root cause: shared mutable state (`.instar/config.json`, commitments, autonomous
state) with **no cross-session visibility before a high-impact action**.
`CommitmentTracker.mutate()` has single-writer CAS *per commitment* — that prevents
torn writes, not two sessions adopting opposing policies and each acting durably.

## The light fix (this build)

A **CrossSessionCoordinator**: a shared, append-only scratchpad of recent
high-impact "structural actions" + voluntary "I'm about to do X" intents. Any
structural action surfaces *other recent* entries to the actor as an advisory
`coordinationWarning`. **It never blocks** (light = advisory). It never mutates the
target state. It is the "visible signal sessions check before acting" Justin asked for.

### What gets recorded
- **Voluntary intent** (`POST /coordination/intent`) — a session announces what it is
  about to do / is doing ("building PR 495 fix for the redrive flood"). This is the
  primary "I'm about to do X" surface.
- **config-flag flip** — auto-recorded at the `PATCH /config` route for sensitive
  keys (feature on/off toggles). Backstop; no agent reliance.
- **commitment-withdraw** — auto-recorded in the `POST /commitments/:id/withdraw`
  route handler after a successful withdrawal. All agent-initiated withdrawals are
  route-driven (the route is the single agent-facing path), so recording there is
  the single source — no double-count — and it lets the warning ride back on the
  same HTTP response. (Code-internal lifecycle transitions like expiry are not
  withdrawals and are deliberately not recorded.)

### The signal
On every recorded action, the coordinator computes `concurrent`: other non-expired
records within `windowMs` (default 10 min) authored by a *different or unknown* actor.
If non-empty, the acting route attaches a `coordinationWarning` to its HTTP response
("⚠ N recent structural action(s) by another/unknown session in the last Xm: … —
confirm before proceeding"). The session (Claude) reads that warning inline and can
reconsider, re-check, or tell the user. `GET /coordination/recent` exposes the ledger
for explicit pre-action checks and inspection.

### Storage + audit
- Ledger: `<stateDir>/state/cross-session-actions.json` — `{ version, actions: [...] }`,
  capped (200), TTL-pruned on write (`retentionMs`, default 60 min). Atomic temp+rename,
  reload-per-op (cross-process safe, mirrors ConversationStore).
- Audit: append each record to `<stateDir>/logs/cross-session-events.jsonl`.

### Config (default-ON housekeeping; matches the silently-stopped sentinels)
```
monitoring.crossSessionCoordination: {
  enabled: true,        // records + warns. false => passive (GET still 200, no records/warnings)
  windowMs: 600000,     // concurrency window (10 min)
  retentionMs: 3600000, // ledger TTL (60 min)
  sensitiveConfigKeys: ["monitoring", "tunnel", "autonomousSessions", "lifeline", "updates"]
}
```
No Telegram escalation in v1 (deliberate — near-silent; in-response warning + GET +
JSONL is full observability without topic-spam risk). A buzz-on-conflict toggle is a
small future addition if it proves wanted <!-- tracked: topic-15579 -->.

## Wiring
- `CrossSessionCoordinator` constructed inside `AgentServer` (like FrameworkIssueLedger /
  TokenLedger — always alive, so `GET /coordination/recent` returns 200 not 503),
  in its own try/catch so a failure never cascades into the other monitors.
- Added to `RouteContext` as `crossSessionCoordinator`. (NOTE: distinct from the
  multi-MACHINE `coordinator` already on ctx.)
- Actor resolution (`coordinationActor`) is best-effort and SESSION-level only
  (`X-Instar-Session` / `X-Instar-Actor` header, or body `actor`) — never the agent
  id, which all sessions of one agent share and would wrongly suppress the warning.
- `PATCH /config`: record sensitive-key flips, attach `coordinationWarning`.
- `POST /commitments/:id/withdraw`: after success, attach `coordinationWarning`.
- Routes: `POST /coordination/intent`, `GET /coordination/recent`.

## Migration parity
- Config defaults: add `monitoring.crossSessionCoordination` to `ConfigDefaults.ts`
  `SHARED_DEFAULTS` → auto-applied to existing agents via `applyDefaults` in
  `PostUpdateMigrator.migrateConfig`. No bespoke migration needed.
- CLAUDE.md template: add a Cross-Session Coordination awareness section to
  `generateClaudeMd()` + `migrateClaudeMd()` content-sniff guard.

## Tests (all three tiers — NON-NEGOTIABLE)
- **Unit** (`tests/unit/cross-session-coordinator.test.ts`): record/prune/window,
  concurrent detection (different vs same vs unknown actor), cap, atomic persistence,
  reload-per-op, disabled mode.
- **Integration** (`tests/integration/cross-session-coordination-routes.test.ts`):
  POST /coordination/intent → GET /coordination/recent; PATCH /config sensitive key
  returns `coordinationWarning` when a concurrent intent exists; withdraw warning;
  auth required.
- **E2E** (`tests/e2e/cross-session-coordination-lifecycle.test.ts`): boot real
  AgentServer (production path), GET /coordination/recent returns 200 (alive), a
  recorded action surfaces end-to-end, capability discoverable.

## Out of scope (separable, flagged to Justin)
- Incident #1 stale-`active:true` cleanup/liveness guard — a distinct staleness bug,
  not a coordination signal. Candidate next step.
- Hard locks / leader election / session registry — explicitly the *heavy* path
  Justin declined for now.
