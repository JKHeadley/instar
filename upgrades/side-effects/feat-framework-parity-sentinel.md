# Side-Effects Review — FrameworkParitySentinel v0.1 (building block)

**Version / slug:** `feat-framework-parity-sentinel`
**Date:** 2026-05-19
**Author:** Echo (autonomous mode, hybrid C)

## Summary of the change

Lands the FrameworkParitySentinel as a **building block** — the class that walks the Layer-3 parity rules registry, calls each rule's `verify()` per instance, surfaces drift via events, and (per rule's `remediationPolicy`) optionally calls `remediate()`. Ships with unit tests and structured spec docs.

**Deliberately scoped narrow:** HTTP routes (`GET /api/framework-parity/status`, `POST /api/framework-parity/scan`) and server.ts boot integration are deferred to a follow-up PR. This matches the precedent set by Skill/Hook/Memory parity rules in PRs #252/#253/#254 — each shipped as a building block via the parity registry, with boot integration as a separate step. Shipping the sentinel class now unblocks the registry consumer side; the follow-up wires it into the server lifecycle.

**Files changed (specs):**
- specs/instar-foundations/framework-parity-sentinel.md (new, converged + approved per pre-auth)
- specs/instar-foundations/framework-parity-sentinel.eli16.md (new)
- docs/specs/reports/framework-parity-sentinel-convergence.md (new)

**Files changed (source):**
- src/monitoring/FrameworkParitySentinel.ts (new — class + lifecycle + scan + state I/O + EventEmitter)

**Files changed (tests):**
- tests/unit/monitoring/FrameworkParitySentinel.test.ts (new — 12 tests)

**Files changed (release notes):**
- upgrades/NEXT.md (new)
- package.json (version bump)

## Decision-point inventory

- **Building-block scope**: ships the class + unit tests; HTTP routes + boot wiring as a follow-up. Matches PR #252/#253/#254 precedent.
- **Scan cadence default**: 30 min (1_800_000 ms). Configurable.
- **Initial scan delay**: 60s (allows server to settle before first pass).
- **Concurrent-scan short-circuit**: second concurrent `scan()` call returns an empty report; prevents pileup on slow rules.
- **Remediation gating**: per-rule `remediationPolicy` is the authority. Sentinel-level `remediationEnabled` config can DOWNGRADE mirror-trust to flag-only but never UPGRADE flag-only to mirror-trust.
- **State schema**: `cursors[primitive::instance]` with `lastScanAt`, `lastResult`, `lastDetail`, `unresolvedCount`. Atomic writes via tempfile+rename.
- **Degradation threshold**: 3 consecutive scans with unresolved drift trips a `DegradationReporter.report()`.
- **Canonical-side mismatches are signal-only**: when `verify()` returns `framework: 'canonical'` (e.g. missing AGENT.md), the sentinel emits `parity:gap-found` but does NOT call `remediate()` — only the rule can mutate canonical, and Memory's rule throws by design.
- **Event vocabulary**: `parity:gap-found`, `parity:remediated`, `parity:remediation-refused`, `parity:orphan-found`, `parity:scan-complete`.
- **Orphan removal is opt-in**: `listOrphans()` always runs; `removeOrphans()` requires explicit operator action (no auto-fire in v0.1).

## Over-block / under-block analysis

**Over-block risk:** the sentinel never blocks operations — it scans + emits + (optionally) re-renders. Worst case is a noisy event stream, filterable at the EventEmitter consumer.

**Under-block risk:** if a rule's `verify()` throws, the sentinel marks that rule failed (via DegradationReporter) and continues with other rules. The failed rule's instances stay at their prior cursor state — drift may persist longer than 30 min until the rule's verify recovers. Mitigated by Degradation reporting (3-consecutive-failure trip) so operators are notified.

**Under-block risk (concurrent scan):** the short-circuit returns an empty report. If a user POSTs `/scan` while an interval scan is in flight (when routes ship), they get back empty + the interval scan continues. Acceptable for v0.1 — adding queue/wait complicates state.

## Level-of-abstraction fit

- Sentinel is the orchestrator. It owns scan timing, state, event emission. Routes/wiring are NOT in v0.1.
- Rules own canonical definitions, rendering, verification, remediation.
- Boundary is clean — sentinel never reads canonical formats directly, never knows what a "skill" or "hook" is. Just the registry interface.

## Signal-vs-authority compliance

- Sentinel emits signals (`parity:gap-found`). Rules' `remediationPolicy` and sentinel's `remediationEnabled` are the layered authority.
- Sentinel never overrides a rule's `flag-only` policy (cannot upgrade).
- Sentinel respects `user-edit-conflict` by short-circuiting remediation and emitting `parity:remediation-refused`.

## Interaction surface

- Adds one new class under `src/monitoring/`. No HTTP routes, no server.ts wiring, no config additions in v0.1.
- Optional state file at `.instar/state/framework-parity-sentinel.json` — only written when `scan()` is called. Cold-start safe.
- No changes to existing rules, registries, or per-primitive infrastructure.
- No migrations needed (cold-start is a no-op until the follow-up wires it in).

## Rollback cost

- Pure-add. Revert removes the sentinel + tests + spec + state file. No data migrations.
- Worst-case bug: spurious remediation on healthy artifacts when the follow-up wires it. Mitigated by user-edit-conflict short-circuit + per-rule policy + future `remediationEnabled` kill-switch.
- Operator emergency (post-follow-up): set `frameworkParity.remediationEnabled: false` in `.instar/config.json` and restart — sentinel becomes signal-only.

## Test coverage

- Unit: 12 tests covering rule walking, event emission for all 5 events, remediation policy routing (mirror-trust + flag-only + user-edit-conflict + config override), concurrent-scan short-circuit, state persistence round-trip, start/stop lifecycle idempotency.
- Integration + E2E: deferred to the follow-up PR that wires HTTP routes — matches PR #252/#253/#254 precedent (the parity rules in those PRs also shipped unit-tests-only as building blocks).

## Documentation

- Concept spec + ELI16 at `specs/instar-foundations/`.
- Convergence report at `docs/specs/reports/`.
- NEXT.md with "What to Tell Your User" entries.

## Deferred (tracked, not silent)

- **HTTP routes** (`GET /api/framework-parity/status`, `POST /api/framework-parity/scan`) — follow-up PR.
- **server.ts boot integration** (construction + start + RouteContext wiring) — follow-up PR.
- **Integration + E2E tests** — land with the HTTP wiring.
- **chokidar source-change watcher** — v0.2.
- **POST /api/framework-parity/remediate per-instance route** — v0.2 (pending trust integration).
- **Trust-level integration** for mirror-trust gating (v0.2 — hardcodes allow for v0.1).
- **Backfill migration** of existing-agent installed base (separate one-shot tool).
- **Conversational-action layer** (Step 6 of the rollout).
