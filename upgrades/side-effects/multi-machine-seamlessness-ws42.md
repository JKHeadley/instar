# Side-Effects Review — WS4.2 per-machine empty-state strip (dashboard sessions view)

**Spec:** docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md (converged 2026-06-12, 3 iterations; approved)
**Change:** dashboard/index.html (+ tests). The sessions view renders an explicit state
row for every pool machine that has no session tiles: "online — no active sessions"
when its heartbeat is live, "not reachable — last seen <t>" when not. Data: the
existing `GET /pool` machines array, fetched on the existing 15s pool poll cadence.
Closes audit finding F7 (2026-06-12 live incident: idle Mini rendered as nothing and
read as a regression).

## 1. Over-block
No issue identified — the change blocks nothing. It is a read-only presentation
addition; no input is rejected anywhere.

## 2. Under-block
No issue identified — there is no blocking surface. Honesty boundary worth naming:
`online:false` cannot distinguish "deliberately shut down" from "network-unreachable",
so the row says "not reachable — last seen <t>" (data-honest) rather than claiming to
know which. The spec's three-state wording maps onto the two states the data supports;
this is recorded as the deliberate build decision the converged spec's round-3
adversarial pass classified as adequately constrained.

## 3. Level-of-abstraction fit
Right layer. The dashboard already consumes `/pool` (Machines tab) and
`/sessions?scope=pool` (tiles); the strip is pure client-side composition of data both
endpoints already serve. No new route, no server change. A server-side "empty
machines" field would duplicate client-known state at a worse layer.

## 4. Signal vs authority compliance
Compliant by vacuity: the change introduces NO decision point — it gates no flow,
filters no message, constrains no behavior. (Phase-1 principle check recorded the
same conclusion in the build transcript.)

## 5. Interactions
- The strip renders AFTER session tiles and clears its own rows per render — no
  interference with tile add/remove reconciliation (verified by test: no duplicate
  accumulation).
- The zero-sessions early-return branch now also renders the strip; the existing
  #emptyState banner still shows alongside it (intended: "no sessions" + per-machine
  states are complementary, not contradictory).
- A machine WITH tiles gets no row (its tiles' machine badge already names it) —
  prevents double-labeling.
- The extra `GET /pool` per 15s poll tick matches the Machines tab's existing call
  pattern and is auth'd identically (apiFetch). Failure is swallowed best-effort: the
  strip simply stays absent until the next tick — degraded view, never an error loop.

## 6. External surfaces
None beyond the operator's own PIN-gated dashboard. No new data is exposed: nickname,
online, lastSeen are already rendered on the Machines tab. Machine-provided strings
are escaped before DOM injection (tested). Single-machine agents: `poolMachinesView`
is populated only when the pool is enabled with 2+ machines — strict no-op, tested.

## 7. Rollback cost
Trivial: revert the dashboard/index.html hunk (static asset; no data, no migration,
no state). Ships with the next release; rollback is a one-commit revert and re-release.

## Second-pass review
Not required — no block/allow decisions, no session lifecycle, no
gate/sentinel/watchdog surface. (Phase-5 trigger list consulted; none match.)
