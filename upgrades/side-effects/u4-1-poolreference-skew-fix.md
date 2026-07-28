# Side-Effects Review — wire the pool-relative skew reference (poolReference) into the U4.1 pin fold

**Spec:** docs/specs/u4-1-pin-persistence.md (converged 2026-07-02 + approved) §2C skew gate, composed with docs/specs/multi-machine-replicated-store-foundation.md §3.4 (pool-relative reference) / §10.2-family maxDriftMs clamp / §15 risk-5/risk-6 (maxDriftMs sourcing — BLOCKER-5).
**Defect:** fb-1d51e996-0a3 (live-reproduced 2026-07-02). PR #1332 shipped `TopicPinFoldView` whose skew gate calls `HybridLogicalClock.receive(hlc, {poolReference})`, but NOTHING supplied the `poolReference` dep. `receive()` deliberately references `max(last.physical, poolReference ?? 0)` and NEVER `now()` (§3.4 — a slow receiver must not quarantine an ahead-but-honest peer), so with the dep unwired a QUIET fold clock's reference froze at its construction seed (server boot). Pins are rare operator events → the pin stream is almost always quiet → ANY honest record authored more than maxDriftMs (default 5min) after boot was falsely quarantined as "skew-ahead", STICKILY (dismissal ≠ re-admission, by design). Pin replication was effectively dead between long-running servers; F6 fired even author-side (the Mini quarantined its OWN fresh PUT after a Laptop bounce).
**Files:** src/core/TopicPinFoldView.ts, src/commands/server.ts (the single production construction site — grep-verified; routes.ts/AgentServer.ts references are type-only).

## What changed

1. **`poolReferenceFromCapacities()` (new export, TopicPinFoldView.ts):** the production sourcing helper — `max(nowMs, freshest clock-OK peer heartbeat self-stamp)`. A peer whose `clockSkewStatus !== 'ok'` (the registry's skew FSM already distrusts it) NEVER raises the floor; malformed/absent stamps are ignored; no peers → now alone (single-machine degenerate case: the pool is self).
2. **`TopicPinFoldView.refresh()`:** computes ONE reference per refresh — `max(now(), poolReference dep ?? 0)` — and passes it on EVERY `receive()`. The fold now floors the reference at its own `now()` regardless of wiring, so a future construction site that forgets the dep can never re-freeze the gate (Structure > Willpower: the component is correct by construction). A THROWING/non-finite dep degrades to the now() floor — never back to the frozen reference, never a fold fault (the fold's "never throws" contract holds).
3. **`server.ts` wiring:** the fold-view construction supplies `poolReference: () => poolReferenceFromCapacities(Date.now(), machinePoolRegistry?.getCapacities() ?? [])` (late-bound closure — the registry is assigned later in boot and read at fold time; registry fault → `Date.now()`).
4. **`status().skewReference` (additive):** the LIVE gate floor is exposed on `GET /pool/pin-quarantine`'s fold block, so a frozen reference is diagnosable from the read surface instead of only in a quarantine log line after the damage.

## Why now() as a FLOOR is spec-faithful (§3.4)

§3.4 forbids the BARE local `now()` AS the reference — its concern is FALSE REJECTION when the receiver's own NTP lags. `now()` inside the max can only RAISE the reference (never lower it), so it can never cause a false rejection; the pool-relative arm (peer heartbeat stamps) is what protects the slow-local-clock case, exactly as §3.4 prescribes ("its own last durable HLC, plus — when available — the observed pool physical time carried in the capacity heartbeat"). The spec's named heartbeat-median primitive does not exist yet (§15 risk-6 tracks derived skew measurement); the freshest clock-OK self-stamp is the available observed-pool signal, and the registry's categorical skew FSM (its real §3.4 purpose) keeps a suspect clock from widening the acceptance window.

## Blast radius

- **The sticky quarantine is NOT weakened.** The quarantine store's `(key, hlc)` exclusion still runs BEFORE the gate on every fold; ack ≠ re-admission; only supersession by a newer honest record (`pruneSuperseded`) or the explicit `POST /pool/pin-quarantine/readmit` clears an entry. Existing FALSE-POSITIVE entries in the field clear exactly that way — no auto-reclassification of quarantined entries is added (stickiness protects against real poison, and a bulk auto-clear could re-admit a genuinely poisoned record).
- **The real protection is intact:** a record more than maxDriftMs ahead of the MOVING pool reference is still rejected + stickily quarantined + escalated (P17-deduped). Proven by the moving-reference rejection test.
- **Gate posture unchanged:** the fold view remains read-only over journal bytes and actuates nothing; ws13 flags/dev-gates untouched; no new config key (the reference sourcing is derived state, not tunable — maxDriftMs remains the existing clamped knob).
- **`skewReference` is additive observability** on an existing Bearer-gated read; no consumer asserts the exact status shape (grep-verified).

## Risk + mitigation

- **Risk:** a fast-clocked PEER's heartbeat self-stamp raises the floor and admits a near-poison record. **Mitigation:** stamps from peers the registry's skew FSM distrusts (`divergence-detected-once` / `suspect-clock-removed`) never participate; a tolerated stamp is within the registry's clockSkewToleranceMs of router receive time, so the widening is bounded by an already-accepted tolerance. Proven by the suspect-clock helper test.
- **Risk:** the dep faults mid-fold and kills pin resolution. **Mitigation:** try/catch at BOTH layers (wiring closure and refresh()) degrading to the moving now() floor; proven by the faulty-dep test.
- **Risk:** the fix silently un-quarantines existing sticky entries. **Mitigation:** none needed — the sticky set is consulted before the gate; the fix changes only NEW verdicts. Existing false-positive entries clear via supersession on the next accepted PUT/tombstone for that key, or explicit readmit.

## Migration parity

None required — pure code fix. No config defaults added or changed (no `migrateConfig`), no CLAUDE.md template change (no new operator-facing capability — `skewReference` is a diagnostic field on an existing documented surface), no hook/skill/template change. Verified against the Migration Parity Standard checklist: no agent-installed file is touched.

## Rollback

Revert the commit. The dep is optional and the fold's now() floor is internal — reverting restores the (broken) frozen-reference behavior with no state migration in either direction; quarantine files remain valid either way.

## Tests

- `tests/unit/u41-pin-persistence.test.ts` — new describe `pool-relative skew reference — quiet streams accept honest records (fb-1d51e996-0a3)`: (1) honest record 46min after the fold-clock seed on a QUIET stream → ACCEPTED (the live Laptop-quarantines-Mini evidence; FAILS without the fix — verified by stash-revert run: 9/9 new fail, 25/25 pre-existing pass); (2) author-side own-PUT acceptance after a quiet period (the Mini-quarantines-its-own-PUT arm); (3) genuinely future-skewed record vs the MOVING reference → still REJECTED + stickily quarantined + escalated; (4) the wired dep raises the floor when the LOCAL clock lags (§3.4 pool-relative); (5) faulty dep degrades to the now() floor; (6) `status().skewReference` moves with time; (7) `poolReferenceFromCapacities` matrix (degenerate/raise/suspect-clock/malformed); (8) wiring-integrity source-grep: the server.ts construction supplies the dep from the registry helper.
- `tests/integration/u41-pin-persistence-routes.test.ts` — the quarantine read's fold block exposes a finite `skewReference` within 60s of the live wall clock (not frozen at a seed).
- Full u41 family green with the fix: 52/52 across unit + integration (routes, answer-complete) + e2e (alive/lease-handover). tsc clean; `npm run lint` clean.

## Agent awareness

No CLAUDE.md template change — this repairs the documented U4.1 pin-persistence behavior (pins replicate between machines as already described); it adds no new capability or trigger an agent must know about. <!-- tracked: fb-1d51e996-0a3 -->
