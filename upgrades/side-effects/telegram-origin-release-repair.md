# Side-effects review — Telegram origin release repair

Date: 2026-09-08. Author: Echo. Second-pass review: concurred (see independent verdict below).

## Summary and grounding

PR #2010 is based on the approved `docs/specs/telegram-message-origin.md`. The completion worktree at `d44c015be` is merging current origin/main `a36079dc2`, package version 1.3.1229, remote https://github.com/JKHeadley/instar.git. This is continued work in the isolated approved feature branch; the agent-home checkout is untouched. The merge preserves main's observedAt/ceiling test-authority correction in AgentServer. The triage-origin test now owns its executable fixture instead of requiring a host-installed Claude binary, with a missing-binary refusal control.

The newer self-action ratchet exposed two real automatic canary restart bursts: repeated reconstruction emitted 240 diagnostic cycles where the 60-second floor permitted at most five. Both production controllers now wait 60 seconds before their first automatic cycle. A closed instance cancels this timer. Subsequent cycles keep the existing completion-relative configured interval (minimum 60 seconds). The model reflects that actual startup delay without inventing durable state. Diagnostic health stays pending/unavailable during startup. No previous passing result is reused.

## Decision points and signal vs authority

This modifies scheduling of fixed-cost diagnostics, not authority to send messages, model attribution, hook proof, ownership or config validity. Source observation continues immediately. Under `docs/signal-vs-authority.md`, the change is an enumerable resource-use invariant, not a judgment about message meaning. No new static heuristic at a competing-signals decision point is added.

## Over-block

Fresh installations and repaired systems wait one minute before automatic canary results are available. Continuous restarts can postpone diagnostic results indefinitely; health remains honestly pending/unavailable. Fresh config/vault source observation and message authorization are separate and remain active. The documented delay is preferred to generating expensive probes on every crash-loop iteration.

## Under-block

The bound covers automatic schedules on a logical controller that is closed on reconstruction. Explicit one-shot run() calls remain explicit diagnostics, outside the automatic-loop model. Simultaneously live independent owners each have their own bounded schedule; this does not claim a global singleton or a persisted lifetime attempt budget. Existing adapter cancellation, timeouts, cleanup latches and single-flight ownership are unchanged.

## Abstraction and interactions

The floor is placed in the two actual start() methods; the registry model mirrors it and production-class tests exercise it. A first-cycle timer and a subsequent-cycle timer share the existing slot and close() cancellation path. Completion-relative recurrence still prevents slow probes overlapping their own next automatic cycle. Pending health is read-only and does not grant send authority. The real-worker and production Boot/HTTP tests verify behavior and freshness separately.

## External and operator surfaces

The only externally observable difference is pending/unavailable diagnostic health during the first minute. The shared awareness paragraph explains this and is consumed by fresh scaffolding and the existing migration refresh path. No new operator action, credential, account operation, network endpoint, URL or dashboard control is introduced. No operator surface layout — not applicable.

## Multi-machine posture

Machine-local by design: the probes check each machine's own native runtime and source contracts. Each machine must stabilize for one minute before its automatic startup probe. No durable cadence state can strand on transfer; no new user-facing notices or URLs are emitted. This does not certify physical cross-machine message-origin coverage.

## Rollback

Revert these scheduling changes in a later patch. There is no schema/config migration or persistent cadence record to remove. Reverting restores immediate startup probes and their known restart-burst behavior. Existing source/evidence permissions are unaffected.

## Evidence

- Original full-run failures: `/tmp/echo-2010-test-all.log`, two reconstruction-before-every-tick failures (240 > 5).
- Focused production-class / worker / convergence tests: 212 passed, `/tmp/echo-2010-canary-fix-focused.log`.
- Live Boot + authenticated HTTP proof with the real 60-second startup delay: 4 passed, `/tmp/echo-2010-canary-fix-runtime.log`.
- Earlier triage fixture repair: 14 passed, `/tmp/echo-2010-fixture-test.log`.
- Final repair build and TypeScript check passed; release certification fingerprint check passed. Awareness migration tests: 4 passed, `/tmp/echo-2010-awareness-migration.log`, including existing CLAUDE/AGENTS/GEMINI wording, operator-prose preservation, and idempotency. The original full aggregate finished with 5 failures (two restart ratchets now repaired, two tests affected by edits during the old run and now passing in focused runs, and the expired-countdown preflight). A clean final test:all run is still required after the countdown blocker is resolved; no full-suite pass is claimed for this tree.
- Justin explicitly approved the prepared 36-date extension in Telegram topic 69507 on 2026-09-08 at 08:04 PDT (reply: “Yes”). Applied exactly the 36 replacements from 2026-09-07 to 2026-09-14 in docs/STANDARDS-REGISTRY.md; all obligations, tracked IDs and enforcement checks remain intact. This postpones unfinished safeguard work by operator decision; it does not certify those guards as implemented.

## Class-closure declaration

Defect class: `unbounded-self-action`. Closure: `guard`. Guard evidence: ratchet `tests/unit/self-action-convergence.test.ts`, plus the real controllers in `tests/unit/telegram-origin-canary-scheduling.test.ts`. Each new instance waits a full floor before any automatic action, closes/cancels that timer on reconstruction, and completion delays the next action by at least the same floor. Therefore rapid reconstruction can only postpone automatic work; a 240-tick repeated-restart adversary emits zero cycles, while a stable instance emits after 60 seconds. Boundary and stable-positive tests keep this from passing vacuously. This declaration does not assert convergence of explicit manually invoked one-shot diagnostics.

## Second-pass review

Independent reviewer concurred with the scheduling repair and awareness migration; verdict and scope follow.

### Independent Phase 5 verdict — 2026-09-08

**Concur with the review** for the automatic canary scheduling repair. Reviewer: `review_canary_repair`, independently read this artifact, `docs/signal-vs-authority.md`, both production controllers, the registry model, production Boot wiring and the changed Boot/HTTP/worker scheduling tests. No blocking concern identified.

For a sequentially closed/reconstructed logical controller, let the previous automatic cycle start at A and reconstruction start at B. Closing cancels the old timer, and B cannot precede A; the replacement's first cycle is no earlier than B + 60 seconds, hence at least A + 60 seconds. Without reconstruction, recurrence begins at least 60 seconds after completion. The model's fresh `nextCycleAt = now + 60000` therefore matches the claimed automatic-cycle floor without fabricated durable state. This bounds cycles, not the two worker attempts inside one owned cycle. Explicit `run()` calls and concurrently live independent instances remain outside the bound, as the artifact states.

The one-minute diagnostic delay and indefinite diagnostic postponement during rapid restarts are real, explicitly documented costs. They do not add a message-authorization condition: Boot's authorization still uses the fresh source snapshot, enabled setting, destination policy and lease; the canaries feed only the health projection. Startup delay does not reuse a previous passing result. Existing cancellation and single-flight ownership are retained.

Independent probes: `node node_modules/vitest/vitest.mjs run tests/unit/telegram-origin-canary-scheduling.test.ts tests/unit/self-action-convergence.test.ts` passed **200/200 tests** across two files; `git diff --check` passed. The initial `pnpm` invocation was unavailable on this shell, so the local Vitest entry point was used. No native/provider network work or full suite was run by this reviewer. Root retains responsibility for final live Boot/HTTP, build, full-suite and awareness-migration verification. This concurrence does not approve, apply or waive the separate repository deadline-extension proposal.

Awareness parity addendum: also reviewed `refreshOriginCanaryStartupAwareness()` and its calls from `migrateClaudeMd()` and `migrateFrameworkShadowCapabilities()`. Concur: the helper replaces only the exact shipped startup sentence on an `Origin detector health:` line, preserves surrounding operator additions, and is idempotent. Both canonical and already-populated AGENTS/GEMINI shadows reach the existing write path when that sentence changes; missing paragraphs receive the shared updated renderer. This is awareness-only, with no changes to config or authorization. Focused migration test execution remains to be recorded separately by the implementing agent.

## Operator deadline decision

The date-only extension above is the operator-authorized change to the countdown authority, separate from the independently reviewed scheduling fix. All 36 existing tracked obligations retain their text and identity. The newly extended deadline will again block the release path if those obligations remain unfinished then. No lint bypass, alternate clock, CI override, or standards-enforcement claim was introduced.

## Content-bound audit refresh

The first post-approval aggregate correctly failed the live-family audit assertion
because changing the approved dates changed three audited content hashes. That
aggregate was stopped (exit 130) before integration/E2E stages. The independent
reviewer accepted a date-only delta review against the prior immutable evidence.
The supported record command refreshed Building, Shipping and The Substrate;
all six floors and all three unaffected records were verified unchanged. Evidence:
`docs/audits/telegram-origin-deadline-family-review-2026-09-08.json` and its linked
review report. No test expectation, coverage requirement or gate was weakened.

## Final validation — 2026-09-08

`npm run test:all` completed with exit code 0 on the repaired source and approved,
reviewed deadline records. All three stages have zero failures:

- Aggregate: 3,343 passed files, 51,762 passed tests; 4 skipped files, 29 skipped
  tests, 3 TODOs. Duration 2,993.07 seconds.
- Integration: 518 passed files, 4,181 passed tests; 2 skipped files, 12 skipped
  tests. Duration 590.58 seconds.
- E2E: 368 passed files, 3,229 passed tests; 1 skipped file, 7 skipped tests,
  3 TODOs. Duration 1,151.16 seconds.

These stage counts overlap; they are not a unique-test total. Final build and lint
passed. Focused audit refresh: 38 passed; compiled CLI preflight: 1 passed. No
source/test/registry inputs changed while this final aggregate was running.
Historical failed and stopped attempts remain recorded above; this final result
supersedes their pending validation status, not their historical evidence.

Full log: `/tmp/echo-2010-final2-test-all.log`. SHA256: `bcabe2b462be4ac53cfa0ed47470704bffde16021c04da12f8f4acd530378d74`.
