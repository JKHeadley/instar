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

## Independent CI prerequisite review — 2026-09-08

**Concur with the review.** Reviewer: `review_canary_repair`. The isolated-process E2E test imports `dist/core/AgentRegistry.js` and other compiled modules in a real Node child; its E2E Vitest configuration generates registry assets but does not compile those modules. Each GitHub Actions job checks out its own filesystem, so successful unit/build jobs cannot supply the E2E job's missing `dist/`. Adding `npm run build` immediately after `npm ci` and before `npm run test:e2e` supplies the actual prerequisite from that job's checked-out source.

Independent read-only verification parsed both workflow versions as YAML and confirmed this inserted build step is the only semantic workflow change. Existing failure propagation and the working-tree integrity check remain intact; no source or test assertion changes are included. Inspected build outputs (`dist/`, generated source manifest and registry assets) are gitignored, so the tree check does not need an exception. The build also enables previously dist-gated E2E cases in this job, which may add execution time; their assertions must continue to run normally. Direct local `test:e2e` still requires a prior build for compiled-process tests. This workflow change does not claim to alter that local command's contract.

No new judgment/authorization gate, deployed agent behavior, migration, credential, or multi-machine state is introduced. The cost is an additional build in each E2E job; rollback is reverting the workflow step, which would restore the missing-prerequisite failure. YAML structural comparison and `git diff --check` passed; this reviewer ran no build or test suite for this addendum. This acceptance is inspection of the prerequisite repair, not proof that the next CI run passed. Release remains held until the new commit's required checks and operator review satisfy the existing gates.

### CI prerequisite reproduction and follow-up

Both GitHub E2E jobs on `7c9fde6cb` failed only the isolated registry subprocess
because their fresh checkout lacked `dist/core/AgentRegistry.js`. Unit, build and
integration CI passed. A separate detached checkout reproduced the missing-module
failure with no dist, then `npm run build` followed by the unchanged registry,
unknown-command/help and dev-preflight E2E checks passed 4/4. The checkout remained
clean after build/test. Logs: `/tmp/echo-2010-ci-prereq-before.log`,
`/tmp/echo-2010-ci-prereq-build.log`, `/tmp/echo-2010-ci-prereq-after.log`.

The workflow now builds its own E2E checkout before tests. A build on another job
cannot supply those files. Current preflight resolves npm first; the historical
pnpm-only obstacle no longer applies. The two stale test comments were corrected;
no test assertion, runtime source or failure policy changed. The existing full
local three-stage pass above covers the unchanged runtime and test behavior;
new-head CI still must pass. Operator review must bind the final commit, not the
previous head. No merge or deployment is claimed.

Independent prerequisite-chain addendum (`review_canary_repair`): concur after correcting one stale unit-shard statement. CI unit shards use `vitest.push.config.ts`, whose global setup compiles dist; the E2E job now builds its separate checkout explicitly. The revised Slack and standards-lifecycle comments accurately distinguish current prerequisites from the historical pnpm-only failure. Inspected `resolveLintCommand()` prefers usable npm and selects `npm run lint`; CLI help/error and Slack process-survival checks invoke Node directly. No additional pnpm installation is required. The detached-checkout reproduction is accurately reported as local evidence, with new-head CI and operator review still required. No runtime logic or test assertions changed; this addendum is based on source/workflow inspection and a clean whitespace check, not an additional test run.

Additional prerequisite checks passed 8/8: npm-first resolver boundaries and real compiled Slack error-containment subprocesses (`/tmp/echo-2010-ci-prereq-extra.log`). Review corrected the comment about unit shards: their global setup already builds dist; the missing build was specifically the standalone E2E job.

### Independent E2E history prerequisite review

**Concur with the proposed prerequisite repair.** Reviewer: `review_canary_repair`. After the build prerequisite was repaired, the compiled preflight E2E reached `npm run lint`. That chain includes `lint-deferral-carrier-resolvable.mjs --staged --enforce`, whose unstaged CI path requires a merge base against `origin/main` or `main`; inability to find either is explicitly an exit-1 unknown-scope result. The failing CI log contains those missing-reference errors. The implementing agent additionally reproduced the direct lint's missing-ref failure and observed lint failure with discoverability passing in a shallow-clone CLI run. An additional host-ledger failure in that direct CLI probe was not evidence about the E2E test, which supplies its own isolated ledger.

Adding `fetch-depth: 0` to the E2E checkout supplies the history prerequisite already declared by the lint and unit jobs. Independent YAML comparison verified this is the only semantic workflow change; whitespace verification passed. It preserves the actual diff-scoped ratchet, existing build/test steps and all failure policies. The cost is fetching full history for the E2E job; it introduces no deployed runtime or migration change. This review certifies the prerequisite chain by inspection and the stated failure reproduction, not a successful post-fix CLI or CI run. A faithful after-probe requires both complete history from a non-shallow origin and the test's isolated host ledger. Post-fix validation and required operator review must still pass before release.

## E2E history prerequisite — 2026-09-08

CI on `758c59a15` passed all eight unit jobs, build, type checking and integration
(4,174 passed, 19 skipped). E2E passed 3,219 tests with one failure in the compiled
preflight check; the earlier isolated registry subprocess passed after the build
prerequisite was supplied. Log: `/tmp/echo-2010-newhead-e2e.log`.

The E2E checkout was still shallow. Compiled preflight runs the real lint chain,
whose deferral-carrier ratchet requires `origin/main` and a merge base to inspect
the PR diff when nothing is staged. A depth-one clone reproduced its exit 1 with
`no-merge-base`, matching CI's missing `origin/main`/`main` errors. The existing
type-check and unit jobs already fetch full history. E2E now uses the same
`fetch-depth: 0` prerequisite; no runtime code, assertion, scope rule or failure
policy is changed.

This is job-local CI checkout configuration. It introduces no deployed state,
agent migration, messaging authority or peer coupling. Its cost is fetching
additional history; reverting the setting restores the insufficient-history
failure. The check remains able to refuse uninspectable changes. A source clone
that is itself shallow cannot supply the full history; the reproduction therefore
fetches it from the actual GitHub repository. Direct CLI trials that accidentally
used the host's fixture-contaminated ledger are diagnostic only; the decisive
comparison uses the unchanged E2E test and its existing isolated ledger.

Independent final evidence review (`review_canary_repair`): **concur**. Read `/tmp/echo-2010-exact-shallow-preflight.log` (unchanged preflight E2E: 1 failed, missing `origin/main`/`main`) and `/tmp/echo-2010-exact-full-preflight.log` (same test: 1 passed). Independently inspected both clones: each is at `758c59a1520233bd0a869660297c64905d0defdf`, their test-file SHA256 values match, and their compiled CLI SHA256 values match. The failing clone reports shallow=true and cannot resolve `origin/main`; the passing clone reports shallow=false, resolves merge base `a36079dc285265a4b3186a51aec3948cebbddb5d`, and has a clean working tree. The shallow fixture intentionally contains an already-created untracked `dist` symlink pointing to the full clone's identical compiled artifacts; that fixture setup is not a test-created mutation and does not establish a clean-checkout assertion for the shallow fixture. These probes support the history-prerequisite fix with the actual E2E test and its isolated ledger, superseding the earlier diagnostic CLI trials. This is local failure/pass evidence, not a claim that new-head GitHub checks or operator review have completed.

The unchanged `tests/e2e/dev-preflight-cli.test.ts`, run with `CI=true` and its
existing isolated ledger, failed 1/1 in a depth-one clone with the same missing
`origin/main`/`main` errors, then passed 1/1 in the complete-history checkout
(`git rev-parse --is-shallow-repository` = false). Logs:
`/tmp/echo-2010-exact-shallow-preflight.log` and
`/tmp/echo-2010-exact-full-preflight.log`. Both used identical compiled source.
The shallow fixture intentionally had a pre-existing untracked dist symlink;
that is fixture setup, not a claim of clean-tree proof. The full-history checkout
used its real built dist and remained clean after the test. The correction adds
only checkout configuration and this review record; the earlier full local suite
passed the unchanged runtime/assertions. New-head CI remains required.
