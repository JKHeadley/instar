# Side-Effects Review — Cross-agent apprenticeship role coverage

**Version / slug:** `apprenticeship-cross-agent-role-coverage`
**Date:** `2026-07-16`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

The role-coverage route now performs a bounded read of cycle evidence held by other running agents registered on the same host, deduplicates remote rows against the local store, and calculates the existing role and keystone signals over the union. `ApprenticeshipPeerCycleReader` owns peer discovery and HTTP reads; `ApprenticeshipCycleStore.roleCoverage` remains the single calculation layer. The response names completeness, capped omissions, truncation, UUID conflicts, and per-peer failures. No lifecycle decision changes.

## Decision-point inventory

No block/allow decision point is added or modified. The route remains observe-only. Peer inclusion uses structural registry facts (running, non-self, non-lifeline) and bounded transport validation.

## 1. Over-block

No block/allow surface — over-block not applicable. A peer failure does not block the local read.

## 2. Under-block

No block/allow surface — under-block not applicable. The read can still be incomplete when a peer is unreachable, lacks an agent token, returns malformed rows, or holds more than 500 matching cycles; every such case is named through `aggregation.complete:false` and `peerSources` rather than hidden.

## 3. Level-of-abstraction fit

The peer reader is the transport/collection layer and the cycle store remains the only role-coverage calculation layer. This avoids parallel keystone math in the route and avoids turning derived visibility into replicated authoritative state.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

`starved`, `dormant`, and completeness are observations. Nothing acts on them automatically.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Registry filtering and record-shape checks are enumerable transport invariants; they do not decide what work an agent may do.

## 5. Interactions

- **Shadowing:** the merged route calls the existing store calculation after peer collection; it does not shadow the local store.
- **Double-fire:** exact cycle UUID mirrors count once. A duplicate UUID with different coverage fields makes completeness false and is named in `conflictingCycleIds`; the first/local copy remains the deterministic calculation input.
- **Races:** concurrent cycle writes may land just after a peer responds, as with any read snapshot. The next read sees them. No write lock is taken.
- **Feedback loops:** none; the result remains observe-only and is not written back into a cycle store.

## 6. External surfaces

The existing JSON response gains additive `aggregation` metadata and its counts can increase when another registered agent holds matching evidence. Reads add bounded localhost HTTP traffic: at most 32 concurrent peer requests, five seconds each, 500 rows each. Eligible peers beyond 32 are counted as omitted and force `complete:false`. No persistent state or external service changes. No operator-facing action is added.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read within the host's cross-agent registry.** Agent cycle stores remain deliberately per-agent; the merged role-coverage read proxies up to 32 running agents registered on that host and explicitly counts any omitted remainder. A single agent replicated across multiple machines is a separate machine-pool topology and is not silently claimed here: `scope: registered-agents` names the boundary. The endpoint emits no notices, generates no URLs, and moves no durable state, so topic transfer does not strand new state.

## 8. Rollback cost

Pure read-path code and additive response metadata. Revert and ship a patch; no data migration or agent-state repair is required. Rollback temporarily restores the known local-only false-starvation view.

## Conclusion

The design fixes the real same-host cross-agent blind spot at read time, preserves local storage ownership, and makes partial or contradictory truth explicit. Independent review caught two honesty gaps—silent peer-cap omission and divergent duplicate UUIDs—and both now force `complete:false`. The bounded peer collector and single calculation layer are clear to ship.

## Second-pass review (if required)

**Reviewer:** independent item-15 reviewer

**Independent read of the artifact: concur.** Initial concerns about silent peer-cap omissions and divergent duplicate UUIDs were resolved by explicit omission/conflict fields, completeness downgrade, and regression tests.

## Evidence pointers

- `tests/unit/apprenticeship-peer-cycle-reader.test.ts`
- `tests/unit/apprenticeship-cycle-store.test.ts`
- `tests/integration/apprenticeship-routes.test.ts`
- `tests/e2e/apprenticeship-lifecycle.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.
