# Side-Effects Review — Action-Claim Follow-Through Sentinel (P2)

Spec: `docs/specs/action-claim-followthrough-sentinel.md` (converged + approved).
Change: a thin Stop hook posts each finished conversational turn to a new server
route `POST /action-claim/observe`, which classifies a CONCRETE future-action claim
("I'll restart it", "relaunching now") and opens an idempotent follow-through
commitment. Signal-only, dark by default. (A2 — completed-action verification —
is DESCOPED, tracked: no per-turn evidence primitive exists.)

Files:
- `src/core/action-claim.ts` — `classifyActionClaim` + `classifyDfSourceLocal`-style deterministic classifier (FD2/FD4).
- `src/monitoring/CommitmentTracker.ts` — `record()` idempotent `externalKey` create (FD3, the missing dedupe primitive).
- `src/server/routes.ts` — `POST /action-claim/observe` (flag-gated, server-side classify + idempotent create + per-topic cap + expiry; signal-only).
- `src/core/PostUpdateMigrator.ts` — `getActionClaimFollowthroughHook()` + migrateHooks deploy + migrateSettings Stop-register + migrateClaudeMd awareness.
- `src/templates/hooks/settings-template.json` — Stop entry (new agents).
- `src/scaffold/templates.ts` — generateClaudeMd awareness line.
- Tests: `tests/unit/action-claim.test.ts` (7), `tests/unit/CommitmentTracker-externalKey-dedupe.test.ts` (3), `tests/integration/action-claim-route.test.ts` (6).

## 1. Over-block
Nothing is blocked — the hook ALWAYS `exit(0)`; the route never blocks a send. The
only "over-fire" risk is registering a spurious commitment. Mitigated by FD2 (closed
concrete-verb set; vague filler like "I'll take a look" does NOT trigger; fail toward
NOT-registering on ambiguity) + FD3 (dedupe + auto-expiry + per-topic cap). Verified
by the unit truth-table (both sides) + the integration no-op/cap tests.

## 2. Under-block
Misses: (a) completed-action claims ("I already pushed it") — A2, deliberately
descoped (no per-turn evidence channel; tracked); (b) creatively-worded future
claims outside the closed verb set — accepted under-coverage (precision over recall,
since a false commitment nags). Both are the safe direction.

## 3. Level-of-abstraction fit
Correct. The thin hook mirrors the proven `response-review.js` Stop-hook siting; the
classifier + dedupe run SERVER-SIDE (a plain-JS hook can't import the TS classifier);
the dedupe lives IN `CommitmentTracker.record()` (the one writer of that store); the
follow-through rides the EXISTING PromiseBeacon + revival path rather than a new
mechanism. No new notification surface.

## 4. Signal vs authority compliance (docs/signal-vs-authority.md)
COMPLIANT. The hook is a pure side-effect POST that never emits `decision:block`
(always exit 0). The route opens a commitment (a signal/record) and never gates,
delays, or rewrites a message. The classifier is a brittle deterministic matcher used
ONLY as a signal — never as blocking authority. The whole feature is off by default.

## 5. Interactions
- Builds ON the existing `detectTimePromise`/PromiseBeacon path rather than a second
  classifier; the dedupe `externalKey` is tagged `actionclaim:` so the per-topic cap
  can count its own commitments without colliding with other externalKey users.
- `record()` idempotency is additive: absent `externalKey` → unchanged behavior
  (verified — 87 existing CommitmentTracker tests still pass + a no-key test).
- The Stop hook is registered AFTER the existing Stop hooks (stop-gate-router stays
  first); it can't shadow them (it never blocks).

## 6. External surfaces
- New route `POST /action-claim/observe` (auth'd like all routes). New Stop hook
  registered in `.claude/settings.json` (new + existing agents via migrateSettings).
  New config keys under `messaging.actionClaim.*` (read with safe defaults).
- No change visible to other agents/users when the flag is off (the fleet default).

## 7. Multi-machine posture (Cross-Machine Coherence)
MACHINE-LOCAL BY DESIGN. The hook fires on the machine running the conversational
turn and registers a commitment in THAT machine's CommitmentTracker — exactly where
the turn happened and where the PromiseBeacon that follows it through runs. Commitment
cross-machine replication (if ever wanted) rides the existing `stateSync` family,
out of scope here. No URLs/notices that must survive a machine boundary.

## 8. Rollback cost
Trivial. The feature is off unless `messaging.actionClaim.enabled` is set; setting it
back to false (or absent) fully disables it — the hook no-ops at its first config
read, the route returns `feature-disabled`. The `record()` dedupe is inert without an
`externalKey`. No migration, no data repair.

## Decisions (mine, per the run's full preapproval)
- **No `migrateConfig` entry for the flag.** Absent = off is the correct dark default,
  consistent with how the resume-queue keys are deliberately kept out of ConfigDefaults
  to preserve the fleet flip. The dev agent enables `messaging.actionClaim.enabled`
  explicitly to soak before any fleet default flip (a separate reviewed decision).
- **A2 descoped + tracked** — building it would lean on a per-turn evidence primitive
  that doesn't exist (the P1 lesson); the founding incident was a future-action claim,
  which the v1 feature covers.

## Test coverage (Testing Integrity)
- Unit: classifier truth-table both sides (FD2/FD4) + dedupe idempotency (FD3).
- Integration: `POST /action-claim/observe` over the real HTTP pipeline — flag-off
  no-op, register, dedupe (restated claim → same commitment), non-claim no-op,
  per-topic cap, 400 on bad input.
- E2E (`tests/e2e/action-claim-lifecycle.test.ts`, 2): boots a REAL Express server on
  a real port and hits `POST /action-claim/observe` — the "feature is alive"
  assertion (200, not 404/503) + a concrete claim opens a real commitment
  (`getActive()` for the topic) + a benign message registers nothing.
- Regression: 87 existing CommitmentTracker tests green; tsc clean; settings-template valid JSON.

## Second-pass review
**Concern raised → FIXED → re-verified.** The independent Phase-5 reviewer confirmed
signal-only (hook always exit 0, route never blocks), correct `record()` idempotency
(early-return before id/emit; `getActive()` excludes terminal so a terminal same-key
mints fresh; CAS untouched; 87 existing tests green), per-topic cap counts only
`actionclaim:`-tagged commitments, and full Migration Parity wiring — BUT found a real
FD2 precision bug: the third classifier regex (bare present-participle + trailer) was
NOT first-person scoped, so it false-positived on imperatives/questions/third-person
("Did you restart it?", "Please merge the PR", "He is deploying it", "The script
reverts …"). Left unfixed, enabling the flag would mint spurious follow-through
commitments — the exact false-commitment-nag FD2 exists to prevent.

FIX: the third regex now requires a SENTENCE-INITIAL PARTICIPLE (`(?:^|[.!?]\s+)` +
the `-ing` form only) — keeps the founding "Relaunching now" / "Done. Pushing it now."
and rejects all eight flagged false positives. Re-verified: classifier unit tests
9/9 (added the third-person/imperative/interrogative rows + a sentence-initial-after-
boundary row), route integration 6/6 — 15 green. Verdict after fix: concur.
