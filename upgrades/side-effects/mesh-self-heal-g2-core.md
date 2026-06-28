# Side-Effects Review — Mesh Self-Heal G2 (core decision logic)

**Change:** The PURE decision core of G2 (nobody-polling detector + single-claimant recovery) from `MESH-SELF-HEAL-SPEC.md` §3.2 — `src/core/nobodyPollingRecovery.ts` + 18 unit tests. Three pure functions (`electPollClaimant`, `decideNobodyPollingClaim`, `decidePostCasSelfReverify`) + a soak ledger. This is increment 1 of G2: the decision logic only. It is NOT YET WIRED to any tick, route, or actuation — it has ZERO runtime effect until a later increment consumes it. (Wiring + the `/mesh-selfheal/g2` observe route + the enforce-mode actuation via the existing poll-follows-lease lever + CAS are the next increment — see MESH-SELF-HEAL-G2-BUILD.md.)

**Decision point?** The MODULE encodes a decision (who claims poll-ownership), but nothing CALLS it yet, so in this increment there is no live decision-point. Signal-vs-authority still assessed (Q4).

## 1. Over-block (legitimate inputs wrongly rejected?)
N/A as shipped — unwired, no inputs flow through it. By design the decision FAILS toward NOT-claiming on every ambiguity (`dual`→veto, `indeterminate`→fail-closed, unconfirmed silence→await, global-outage→hold, no-fit→escalate). The only `claim` outcome requires confirmed real silence + this machine being the deterministically-elected single claimant. A wrongful claim is the harm (a 2nd poller / 409 war), so the gate is biased hard against claiming.

## 2. Under-block (failure modes still missed?)
As pure logic, none in-scope. The KNOWN not-yet-built pieces (tracked, not orphan-deferred): the actuation (CAS acquire + poll-lever start/stop) and the post-claim live-verify of `lifeline-poll-active.json`. Until those land, this module cannot cause OR prevent anything — it is inert decision logic with full test coverage.

## 3. Level-of-abstraction fit
Correct layer. It REDUCES over the existing B5 detector (`pollerCount.ts` `evaluatePollerCount`) rather than re-folding poll-counts (spec finding Int2-A — reuse, don't reinvent). It is a pure decision module mirroring `leaseGatedSpawn.ts` (G3) — no I/O, fully unit-testable, consumed by a thin wiring layer later.

## 4. Signal vs authority compliance
COMPLIANT. Pure functions (no I/O, no blocking authority). The election is deterministic + machine-agnostic (every machine computing it over the same inputs elects the SAME claimant — the structural defense against split-brain double-claim). The actual authority (acquiring the fenced epoch-CAS) lives in the existing lease coordinator, which the future wiring will call; this module only DECIDES, it does not ENACT. `decidePostCasSelfReverify` encodes "CAS-win is necessary but not sufficient" (Adv2-F1) so the eventual enactment re-checks live local freshness before serving.

## 5. Interactions
None in this increment (unwired). The design's intended interactions (documented for the wiring increment): consumes B5's verdict; the claim drives the existing poll-follows-lease lever; self-exclusion advertises into the existing heartbeat. No shadowing — it adds a decision layer ON TOP of B5, not parallel to it.

## 6. External surfaces
None yet. No route, no config flag, no audit write in this increment — the module is pure. The exported `sharedG2NobodyPollingLedger` singleton mirrors `sharedG3SoakLedger`; it is written/read only once the wiring + `/mesh-selfheal/g2` route land.

## 7. Multi-machine posture (Cross-Machine Coherence)
This IS multi-machine coherence logic. Posture: the decision is computed LOCALLY on each machine from the replicated/advertised pool capacities + B5 verdict, and is deterministic so all machines agree on the single claimant without a coordination round-trip (the election is the coherence mechanism). The watermarks it will eventually read (`pollSucceededMonoMs` etc.) are machine-local, never replicated (spec §3.1 Sca-F1) — but that plumbing is the wiring increment, not this one.

## 8. Rollback cost
Trivial — revert the commit. The module is unreferenced by any runtime path, so removing it cannot affect a running agent. No config, no migration, no state.

## Second-pass review
Not triggered for this increment: the module is unwired pure logic with no live decision-point, block/allow authority, or session-lifecycle touch. The Phase-5 second-pass IS required for the WIRING increment (it will consume the lease/poll-ownership authority — "lease"/"sentinel"/session-lifecycle territory) and is flagged in MESH-SELF-HEAL-G2-BUILD.md.
