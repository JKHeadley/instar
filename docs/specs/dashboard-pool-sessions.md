---
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
review-convergence: "rev-1 — operator-stated requirement implemented at the minimal coherent scope. Grounded first (Explore pass over GET /sessions, the dashboard WebSocket session feed, MeshRpc, MachinePoolRegistry, the placement-proxy auth pattern): sessions were strictly local (state.listSessions), the dashboard only ever saw the WebSocket's local broadcast, and no cross-machine session aggregation existed. Design: self-tag local sessions with machine identity; aggregate peers via their existing plain GET /sessions behind the established Bearer cross-machine auth pattern; dashboard polls the aggregate and renders machine badges, keeping the WebSocket as the live local feed. Both sides of every boundary test-pinned across all three tiers."
approved: true
approved-by: "operator (Justin) via Telegram topic 13481 — 2026-06-05 ~04:48Z (\"Then another requirement: all sessions should show on the dashboard and should state which machine the session is on\") under the standing multi-machine pre-approval"
approved-at: "2026-06-05T04:48:27Z"
---

# Dashboard Pool-Wide Sessions — every session, every machine

**Status:** Approved 2026-06-05. Implemented.
**Author:** Echo
**Companion:** dashboard-pool-sessions.eli16.md
**Trigger:** Operator requirement (topic 13481): "all sessions should show on
the dashboard and should state which machine the session is on." Before this,
each machine's dashboard showed only ITS OWN sessions, unlabeled — on a
two-machine pool the operator had no single surface answering "what is running
where."

---

## What was missing

- `GET /sessions` read only the local `StateManager` — no machine identity on
  any session, no way to see a peer's sessions.
- The dashboard sessions list is fed by a WebSocket broadcast of LOCAL
  sessions; nothing cross-machine existed.
- MeshRpc has no session-aggregation command; `/pool` carries capacity
  (counts), not session lists.

## The design

1. **Self-tagging.** `GET /sessions` adds `machineId` + `machineNickname`
   (from `ctx.meshSelfId` + the pool registry) to every session when the pool
   is wired. Single-machine installs see no new fields.

2. **Aggregation: `GET /sessions?scope=pool`.** A new `resolvePeerUrls` route
   hook (wired in `server.ts` from the machine identity registry — every other
   active, non-revoked machine with a known URL) lets the route fetch each
   peer's PLAIN `GET /sessions` (never `scope=pool` — no recursion) with the
   established cross-machine Bearer pattern and a 5s timeout. Remote sessions
   are tagged with the peer's identity + `remote: true`. Response envelope:
   `{ sessions: [local..., remote...], pool: { enabled, selfMachineId,
   selfMachineNickname, peersQueried, peersOk, failed } }`. A dead/slow peer
   contributes a `failed` entry — never a 500; local sessions always answer.
   The plain route (no `scope`) keeps its back-compatible array shape.

3. **Dashboard.** The sessions list polls `/sessions?scope=pool` every 15s
   (started on both auth paths). Remote sessions live in a separate
   `remoteSessions` array (the WebSocket replaces the local array each
   broadcast — merging would be wiped). Every row renders a `machine-badge`
   with the nickname; local rows inherit the self nickname from the poll.
   Remote rows are namespaced (`remote:<machineId>:<tmux>`) so tmux names
   can't collide across machines, are non-clickable (their terminal streams
   on THEIR machine — tooltip says so), show no close button, and never take
   the active-terminal highlight.

## Deliberate non-goals

- No cross-machine terminal streaming (a remote row is informational; the
  tooltip points at the owning machine's dashboard).
- No remote session kill from a peer's dashboard (the close button is local-only).
- No MeshRpc command — plain HTTPS reuse of the existing route + auth was
  strictly simpler and matches the placement-proxy precedent.

## Tests (all three tiers)

- **Unit** (`dashboard-sessionMachineBadge.test.ts`, 8): poll wiring on both
  auth paths, separate remote array, XSS-escaped badge, self-nickname
  inheritance, per-machine row namespacing, remote interaction guards, active
  highlight never remote. Plus `PostUpdateMigrator-poolSessionsVisibility.test.ts`
  (3): append / idempotent / fresh-inject-carries-it.
- **Integration** (`sessions-pool-scope.test.ts`, 5): self-tagging on/off the
  pool; merge against a REAL second HTTP server with peer tagging; dead peer
  → `pool.failed`, never 500; single-machine `scope=pool` answers
  `enabled:false`; plain route stays an array.
- **E2E** (`sessions-pool-scope-lifecycle.test.ts`, 3): real `AgentServer` —
  plain array alive, `scope=pool` alive (200, not 503) single-machine, auth
  required on both.

## Agent awareness + migration parity

- Template (`generateClaudeMd`) pool section gains the "Every session, every
  machine" bullet; the PostUpdateMigrator inject carries it, and an idempotent
  append migration (marker: `scope=pool`) updates agents that already have the
  pool section.
