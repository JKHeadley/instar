# Side-Effects Review — The minimum-build fence

**Version / slug:** `identity-security-piece2c-minimum-build-fence`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Piece 2c of the approved identity and security design (topic 144636): machines too old to follow the identity rules are waited for before enrolment, then refused after it.

- `src/core/identityBuildFence.ts` contains:
  - the per-level floor table (Basic has no fence);
  - `PeerBuildLedger`: each peer's signed build statement, per registration, saved under the key-material path `state/owner-record/`, with four states (confirmed, below, unconfirmed, retired);
  - `fenceInForce`: the record's `minimumBuild` or the last verified fence; a bad value never relaxes it; an owner's lowering to Basic clears it;
  - `fenceStatus` (readiness) and `belowFence`.
- `ownerRecordSync.ts`:
  - pulls carry `build` and `guards`, and replies carry the replier's build and guards, recorded before judging;
  - after enrolment, only confirmed peers get or give owner-record data;
  - one aggregated notice from the lease holder, at most daily;
  - a `fence` section in status.
- `ownerRecordStore.gate()` holds with `fence-unusable` when enrolled with no usable fence.
- `machineRoutes.ts` (`POST /api/pair`) refuses a joiner below the fence after enrolment. The joiner (`commands/machine.ts`) now sends its build.
- `UpdateChecker.rollback()` refuses a rollback below the fence.
- `ownerRecordWiring.ts` adds `ownerRecordGate()` (piece 2b's one gate function, now exported for later pieces) and `ownerRecordFence()`, and wires the ledger, build and notice. `server.ts` passes the notice through `notify('SUMMARY', 'mesh-alert', …)`.
- The route `GET /owner-record` gains `fence`, and the awareness entry gains a line.

## Decision-point inventory

- **Sharing the owner record while enrolled:** confirmed peers only.
- **A join after enrolment:** refused below the fence.
- **A rollback after enrolment:** refused below the fence.
- **The gate:** holds when enrolled with no usable fence.

## 1. Over-block

- **Before enrolment nothing is refused,** and no agent is enrolled until piece 3.
- **After enrolment, missing evidence refuses nothing except the record itself.** A sleeping or restarting peer reads "unconfirmed": it gets no record entries until it pulls again, but liveness, lease and work traffic are untouched.
- **A join at or above the fence pairs normally.**

## 2. Under-block

A hand-installed older build still acts on its own direct inbound. That is the stated residual. Refusing it the lease and routing is piece 2d, and Phone-level enrolment waits for 2d.

## 3. Level-of-abstraction fit

- **The fence lives beside the owner record.**
- **Join and rollback refusals sit at their existing choke points:** the join route, and `UpdateChecker.rollback`, next to the existing Codex downgrade floor.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — the decisions are deterministic comparisons over enumerable inputs (version strings, signed statements, enrolment state); no judgment over meaning.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check

The 24-hour freshness window is four full backoff cycles of a pulling peer (spec §2). The notice is at most daily per unchanged list.

## 5. Interactions

- **Pulls gain two fields,** and older builds ignore unknown fields.
- **The join body gains `instarVersion`;** an older inviter ignores it.
- **Rollback** gains one more refusal, beside the existing Codex floor.

## 6. Rollback

Revert the commit. The ledger file can stay; nothing else reads it.

## 7. Evidence

- **Unit:** `tests/unit/identity-piece2c-build-fence.test.ts` covers:
  - the ledger's states, ordering, restart and per-key observations;
  - the fence in force, including a bad value and lowering;
  - readiness;
  - `belowFence`;
  - sync refusal only after enrolment;
  - the single notice and the status;
  - rollback refusal.
- **Integration:** `tests/integration/identity-piece2c-join-fence.test.ts`, run by Local Verify, covers a join before enrolment, a refused join (no build and an older build), and an accepted join.
- **E2E lifecycle:** the 2b lifecycle file gains one case: the production sync sends its build in every pull, and the route reports `fence`.

## Second-pass review

An independent reviewer subagent read the code against the spec and probed it over three rounds. All 11 defects it found are fixed, each with a regression test:
- **Round 1 (8):**
  - a lost or contested record relaxed or lowered the fence;
  - unsigned reply builds counted as evidence, stamped with mixed clocks;
  - the notice was filtered out by the hub;
  - a new machine was reported as silent "for a day";
  - this machine was left out of readiness;
  - no report of a bad value;
  - explicit installs were not fenced;
  - the joiner hid the server's message.
- **Round 2 (2, plus 1 partial):**
  - an unusable fence refused the owner's correction;
  - a raise was never reported;
  - a pairing-time judgement was still needed for new machines.
- **Round 3 (1):** a development install was compared against the installer's version instead of the agent's.

Round 4 concurred. Review: `.instar/state/identity-build-144636/reviews/p2c-second-pass.md` in the agent home.

E2E-PAIRING: EXEMPT — the join refusal is covered by the integration test over the real /api/pair route; no device pairing flow changes.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action`
- **closure:** `guard` (tests/unit/self-action-convergence.test.ts, entry owner-record-fence-notice)
- **reason:** the only self-triggered action is the aggregated notice: once per distinct list (never repeated for an unchanged one), from the lease holder only, closed when the list empties; registered in the self-action registry.

## Current-main merge repair, 2026-11-22

Tier 2 security maintenance under the existing approved spec; no new authority or policy. The normal merge from main 9b61d628656b5782e39c0ad57d6fb108b8ad3ad7 retains both new server imports. Semantic review found that the earlier merge had removed the unrelated stall-reconfirmation feature. Its source, types, tests, awareness and review artifacts are restored exactly from current main, including the server wiring. No paths are deleted relative to main. The minimum-build fence additions remain intact.

The independent parent reviewer inspected the actual candidate and concurred: the restored feature is byte-identical to main, and server initialization retains both the stall guard and fence wiring. No material merge concern remained, conditional on verification. Focused verification passed: 89 unit tests in five files, eight HTTP integration tests in two files, and TypeScript checking. Full verification remains assigned to the throughput coordinator. Dependency order 3445 then 3450 then 3453 and all queue holds remain unchanged.

The rollback is a normal revert of this merge repair, with the known cost that the prior branch accidentally omitted a main safety feature. There is no new persistence format, cross-machine behavior, external authority, or enrollment behavior in the repair. Existing signal-versus-authority analysis above continues to apply. One independent review pass and one commit attempt planned; no new design review rounds.
