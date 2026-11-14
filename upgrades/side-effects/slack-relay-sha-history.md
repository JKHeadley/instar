# Side-Effects Review — Slack relay shipped SHA history

**Version / slug:** `slack-relay-sha-history`
**Date:** 2026-11-04
**Author:** Echo
**Second-pass reviewer:** Echo Studio (review reported in bug topic 10000001595 for commit 8346757cf).

## Summary of the change

Tier 2, seven source/test files plus this artifact. The installed Slack reply script from the 2026-11-03 release was omitted from the strict prior-shipped SHA set. This adds its exact hash, tests actual update migration of both script locations, and extends the existing CI history lint from Telegram to Slack. One spec review chain already converged; the local commit gate passed. Decision points are the provenance-based script installer, Slack readiness, and CI lint.

## Decision-point inventory

- `reconcileRelayFile` prior-shipped branch — modify the allowed hash set, so the historical repository script is backed up and replaced.
- `reconcileRelayFile` customized branch — pass-through; unknown bytes still produce `.new` and a degradation.
- `slackReplyRelayReadiness` — pass-through; it still demands exact current bytes before Slack inbound is accepted.
- `lintSlackTemplateShaHistory` — add; CI detects missing shipped hashes before a future release.

## 1. Over-block

No new runtime block. CI may fail on a template commit in first-parent history that was never published. That requires a provenance review before adding its hash; the lint reports commit, subject, and hash rather than installing it automatically.

## 2. Under-block

The lint sees the last 100 first-parent template commits. A shipped change outside that window or shipped from a branch that never reached main would need manual provenance review. Runtime still refuses a customized canonical script, even when its changes were benign, to avoid replacing user edits.

## 3. Level-of-abstraction fit

Exact byte hashes are appropriate overwrite authority for known packaged scripts. The updater already uses the shared installer; the patch supplies missing provenance rather than adding a parallel repair path. The history lint is a release signal, not a runtime authority.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] Yes, with brittle logic.

The new CI lint reports a missing provenance hash to the release gate. Runtime's strict equality check is an invariant over executable packaged bytes, not an inference about conversational intent. Unknown bytes remain protected from overwrite.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. SHA equality is an enumerable provenance invariant.

## 5. Interactions

- **Shadowing:** readiness runs after migration; replacing the known old script makes readiness pass. Customized scripts still fail readiness and remain preserved.
- **Double-fire:** startup, migrate, and update call the same idempotent installer; a second call sees current bytes.
- **Races:** atomic rename plus deterministic backup name preserve the existing installer behavior. No new shared state or concurrent actor is added.
- **Feedback loops:** none. The CI lint reads git history and reports; it does not mutate the hash set.

## 6. External surfaces

Existing Slack agents can receive replies after update because their packaged old script is migrated. The old script is backed up as `.bak.<sha-prefix>` in each local location. Customized scripts are unchanged and get a `.new` candidate. Slack message content, credentials, and account settings are not read by this change. No new operator action or API is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**machine-local BY DESIGN:** installed relay files and their backups belong to each machine's local agent install. Each machine receives the same package and runs its own update migration. No user-facing notices, durable topic state, or URLs are added by this patch. Existing degradation reports remain per machine.

## 8. Rollback cost

Revert the source and ship a patch if provenance is wrong. Already upgraded agents retain the new script and local backup; reverting code alone does not downgrade those files. A repair would use the backup after verifying its contents. During rollback, agents still have the current relay and Slack can answer.

## Conclusion

The incident came from missing release provenance, not a custom Indra script. The exact historical hash is added, the preservation boundary remains intact, and the CI lint now covers Slack. Packaged CLI migration and targeted tests passed. Targeted rerun of the load-affected tests passed. Two full-suite attempts were interrupted after unrelated harness failures under host load; the bounded pre-push gate deferred the broad set to CI. Studio independently reviewed the original diff at 8346757cf and found no blocking issue. The rebase onto main removed a duplicate audit test change already fixed by PR #2736; the Slack production and migration changes are unchanged.

## Second-pass review (if required)

**Reviewer:** Echo Studio, reported in bug topic 10000001595 on 2026-11-04 for commit 8346757cf.
**Independent read of the artifact:** Concur. Studio checked the production SHA allowlist, history lint, migration integration test, and incidental test harness changes; it found no blocking issue. After its review, the rebase only removed the now-duplicate audit buffer change already on main. GitHub approval and CI are separate gates.

## Evidence pointers

- `tests/fixtures/slack-reply-2026-11-03.sh` is the shipped 2026-11-03 script.
- `tests/unit/slack-reply-relay-installer.test.ts` proves upgrade and customized preservation.
- `tests/integration/slack-reply-relay-migration.test.ts` invokes the real migrator and checks idempotence.
- Packaged CLI smoke test updated both historical copies with backups and no `.new`.
- `tests/unit/lint-template-sha-history.test.ts` proves the Slack lint catches removal of the missing hash.
- The audit `git ls-files` ENOBUFS fix landed independently on main as PR #2736; this PR no longer changes that test.
- `tests/unit/grok-budget-concurrency.test.ts` probes the Node executable for the TS transform flag; this host's Node 26 removed the flag, while CI's Node 22 still runs the process race proof.
- Full-suite attempt 1 was interrupted after a formatter 102.5 ms/100 ms timing miss, desktop host and stop-hook timing failures, token ledger event-loop timing, and audit `git ls-files` ENOBUFS. The six affected files passed together (182 tests) at lower concurrency.
- Full-suite attempt 2 was interrupted after DesktopStreamManager expected 1 release but observed 3 and grok-budget-concurrency twice reached 0/12 ready children in 120 s. DesktopStreamManager passed alone (14 tests); the Grok harness failure was traced to Node 26 rejecting `--experimental-transform-types` before child startup.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect was omitted source release metadata. The new history lint structurally detects its recurrence for future first-parent packaged Slack templates.
