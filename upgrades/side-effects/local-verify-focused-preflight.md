# Side-Effects Review — Focused Local Verify PR preflight

**Version / slug:** `local-verify-focused-preflight`  
**Date:** `2026-10-31`  
**Author:** Echo  
**Second-pass reviewer:** GPT-6 Astra reviewed the branch against its scheduling base on 2026-10-31. It found two P2 replay-lifecycle gaps, both corrected and covered by focused tests.

## Summary of the change

An optional targeted Vitest check runs after the existing build/lint and before Local Verify claims a full-suite slot. It can return an early red for an automatically rediscoverable PR only after two complete reports agree on an assertion failure in the same selected file and both trusted unhandled-error reports say zero. It creates a durable full-suite replay and never creates a green merge authority. Ships off. Spec: `docs/specs/local-verify-fast-focused-preflight.md`.

## Decision-point inventory

- `src/localVerify/orchestrator.ts`, `preflight.ts`, `runFocusedPreflight.ts`: **add** exact-base selection, breadth/time caps, repeated-red proof and process cleanup before a lane starts.
- `src/localVerify/record.ts`: **validate** bounded optional evidence; an enforced early red has no full-suite lanes and cannot be a success.
- `src/localVerify/LocalVerifyService.ts`, `preflightReplay.ts`: **persist** one same-head/target replay marker before publishing an early red, then admit a full-suite bypass at ordinary priority with lifetime/attempt bounds.
- `src/localVerify/localVerifyWiring.ts`: **read** live `off|observe|enforce` mode; absent or invalid is off, and a blocked replay degrades enforcement to observe.
- `src/scaffold/templates.ts`, `PostUpdateMigrator`: **teach** new and installed agents the capability and its limited authority.

## 1. Over-block

The focused attempt can add at most 90 seconds to a PR's active work and may produce a false early red in enforce mode. Enforce is available only for automatically rediscoverable merge candidates; its red creates a bounded full-suite replay before any green status. The replay does not jump queue priority and runs without preflight, preventing a self-sustaining early-red loop. A missing or full replay store, or an exhausted retry budget, turns enforcement into observe and leaves the record non-green. A bounded sweep reclaims closed terminal keys; completed replay proofs survive journal compaction and verifier upgrades.

## 2. Under-block

An uncertain focused result, absent reporter, timeout, malformed report, broad selection, collection error, or cleanup uncertainty cannot be an early red. A contained uncertainty proceeds to the full suite; an unconfirmed child process or dirty worktree returns infrastructure error before lanes, to avoid overlapping test side effects. The full-suite merge gate is unchanged.

## 3. Level-of-abstraction fit

The decision lives in the installed verifier that has the exact base and synthetic merge worktree. It reuses the host targeted-lane limiter and existing lane report semantics. The coordinator owns replay admission and journal state, rather than relying on a session to remember to retry.

## 4. Signal vs authority compliance

**Reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md). Observe is signal only. Enforce has bounded red/liveness authority but no green authority. Only the existing complete lane record can satisfy the merge gate; optional preflight metadata cannot replace a lane report. Same-user test code can tamper with its diagnostic report, so inconsistency falls toward full verification.

## 4b. Judgment-point check

No LLM judgment chooses a red verdict. Exact SHA, selected file identity, parsed assertions, trusted reporter count and caps are deterministic. Audit records an observed or replay-cleared false red for rollout review.

## 5. Interactions

`main` verifies bypass preflight. Peer verifiers carry per-attempt mode and evidence; the lease holder imports only a strictly matching full verify record. A replay is local to the coordinator and uses ordinary priority. Head or target movement cancels the old marker; base refresh retains the same-head obligation. Existing fail-fast, lane shards, main-red hold and merge line still govern the later full run.

## 6. External surfaces

`GET /local-verify` adds mode and replay status; the exact-head record adds optional evidence. No new external service call or GitHub status is made by preflight itself. An enforced early red cannot post a success status.

## 6b. Operator-surface quality

The status separates off, observe, enforce and blocked replay states. An agent can explain that a focused red is provisional until the full replay resolves it, and can name the exact selected file and head/base.

## 7. Multi-machine posture

The preflight runs on the verifier host's isolated worktree and targeted lane. Replay markers follow the existing coordinator-local queue approved in `local-verify-capacity`; a lease move re-discovers an eligible candidate and runs a new exact-head check. Peer mode may differ in timing but never in green authority.

## 8. Rollback cost

Set `monitoring.localVerify.preflightMode` to `off`. The next child spawn reads off; a running child retains the mode stamped on it. A persisted early-red replay remains due and bypasses preflight even after rollback. Rollout is dark, isolated-agent rehearsal, Echo observe, then a bounded Echo enforce trial before fleet opt-in.

## Conclusion

The optional cost is a bounded targeted check on green PRs; the optional liveness cost is an early red followed by a full replay. Full-suite green authority is unchanged.

The final Astra pass found two restart/retention edge cases before rollout: restored queue entries could outrun a replay marker's backoff or breaker, and a full set of replay proofs could make journal compaction retain unlimited ordinary rows through `slice(-0)`. The service now delegates restored replay entries to the durable admission loop and explicitly gives ordinary rows zero slots when proofs fill the cap. Both cases have unit regression coverage.

Installed guidance states that a skipped preflight is not a passed check. This applies to new agents through the template and existing agents through migration; both describe the same full-suite green boundary.

A further Astra pass found that the child could legitimately spend the extra 90-second preflight allowance after the server's restart hold had expired. The service now latches that allowance at child spawn and includes it in the restart ceiling even if the live mode changes while an update waits. A unit boundary test covers the time calculation.

The final review also found that the post-run git cleanliness check could consume an ordinary git timeout outside the 90-second preflight cap. It now uses the remaining preflight budget, and the recorded elapsed time includes that check. A timed-out check produces an infrastructure error before any full lane starts. Malformed enforced-red records with a null `lanes` field now fail validation without throwing during peer import.

Independent second pass raised four concerns: elapsed telemetry could include the later full suite, the final cleanliness check could incorrectly subtract the teardown reserve twice after a contained timeout, a signaled process with complete reports could establish early red, and a preflight cleanup error retry could run preflight again. All four are corrected and covered by boundary tests. Elapsed evidence freezes before lanes; the final status check spends only the actual remaining 90-second budget; red proof requires ordinary numeric failing exits; and the bounded error retry persists a preflight bypass so it reaches a fresh full verification tree.

The second pass on those fixes found that peer-origin cleanup errors could lose that bypass on the coordinator. The coordinator now persists the bypass when importing such an error and keeps its retry local because the peer request schema has no bypass field. A peer-origin regression checks the durable marker, local scheduling, and child input.

**Independent reviewer verdict:** Concur with the review. After the peer retry correction, the reviewer found no remaining concrete P1 or P2 issue in the inspected changes and tests.

## Second-pass review

**Reviewer:** GPT-6 Astra

The independent review covered the changed Local Verify harness, exact-base preflight selection, trusted reporter evidence, process cleanup, peer import, and durable replay admission. Astra identified replay recovery and cleanup boundaries; those were corrected before the final review pass, which reported no remaining concrete P1 or P2 issue. The rebase onto current main preserved this feature's code delta. The exact rebased head `a1e2d3761` passed 53,670 unit, 4,983 integration, and 3,619 E2E tests on M5, plus a separate green pre-push unit run. This attestation covers the flagged Local Verify paths listed in the trace and is committed after their last edit. The feature remains off by default until its staged rehearsal and measurement gates are met.

## Evidence pointers

- `tests/unit/localVerify/preflight.test.ts`, `runFocusedPreflight.test.ts`, `preflightReplay.test.ts`, `orchestrator.test.ts`, `LocalVerifyService.test.ts`
- `tests/integration/local-verify-routes.test.ts`, `tests/integration/localVerify/realExecPreflight.test.ts`
- `tests/e2e/local-verify-lifecycle.test.ts`
