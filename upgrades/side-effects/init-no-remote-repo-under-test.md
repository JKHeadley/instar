# Side-Effects Review — init does not create a GitHub repository from a test run

**Version / slug:** `init-no-remote-repo-under-test`
**Date:** `2026-08-16`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required — see Phase 5 note below`

## Summary of the change

`initProject`'s standalone path calls `setupCloudBackup`, which runs `git init` and then `gh repo create instar-<agentName> --private` against whatever account the ambient `gh` CLI is authenticated as. Seven test files call `initProject`. They isolate the filesystem — HOME is redirected to a temp dir that is removed afterwards — but nothing isolated the network, so each run created a real private repository on the operator's GitHub account and the temp-dir cleanup never learned one existed.

This adds an exported predicate `isAutomatedTestRun()` and makes `setupCloudBackup` return immediately when it is true. Files touched: `src/commands/init.ts`, plus `tests/unit/init-cloud-backup-test-guard.test.ts`.

Measured on the affected account: 378 owned repositories, of which 377 are auto-generated — `instar-codex-only-test-*` (126), `instar-default-test-*` (126), `instar-both-test-*` (125), all 0 KB and private, accumulating from 2026-06-14 to 2026-08-15. Three per run of `tests/unit/init-claude-gating.test.ts`.

## Decision-point inventory

- `setupCloudBackup` entry (run / skip) — **add** — a test run skips cloud backup entirely.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Any genuine `instar init` that happens to run with `VITEST` set or `NODE_ENV=test` in its environment would silently lose its cloud backup. In practice `VITEST` is set only by the vitest runner in its own process, and `NODE_ENV=test` is a deliberate marker; neither is plausible in a real user install.

`CI` is deliberately **not** a signal, and this is the case worth calling out because it was the tempting one. A user whose own automation runs `instar init` in GitHub Actions genuinely wants the backup, and treating `CI` as "this is a test" would have taken it away from them. Covered by a test asserting `CI=true` alone does not trip the guard.

The skip is loud, not silent — it prints `Cloud backup skipped — automated test run (no GitHub repository is created).` so a surprised operator can see why.

---

## 2. Under-block

**What failure modes does this still miss?**

- **A test runner that sets neither marker.** A future test invoked by a runner that sets neither `VITEST` nor `NODE_ENV=test` would create repos again. The two markers cover every runner currently in the repo; a third runner would need adding here.
- **Other external side effects on the init path are untouched.** This closes the GitHub-repo one, which is the one with a persistent, account-level, human-visible cost. If another step later reaches an external service, it needs its own guard — the predicate is exported so it can be reused rather than re-derived.
- **The 377 repositories already created are not removed.** Deleting repositories is irreversible and they belong to the operator; the cleanup is theirs to authorize, and this change deliberately does not touch them. Tracked as an operator decision, not deferred work in the code: the code defect is fully closed here.

---

## 3. Level-of-abstraction fit

The guard sits at the top of `setupCloudBackup` rather than in the tests, and that is the whole point. Patching `tests/unit/init-claude-gating.test.ts` — the file that happened to be traced back — would have left the other six callers and every test written afterwards free to do the same thing. This is the *Structure > Willpower* choice: the one place that reaches GitHub refuses to do so under a test, so no test author has to remember.

It could alternatively have been an `InitOptions` flag that tests pass. That was rejected for the same reason: an opt-in that a test author must remember to set is the willpower version of the same fix.

Returning before `git init` rather than only before `gh repo create` is deliberate. No test asserts on backup artifacts, and a half-configured local repo with no remote would be a stranger state to reason about than no repo at all.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

There is no decision about agent behavior, information flow, or a user action here. It is an environment check that suppresses one of `init`'s own side effects during a test. It gates nothing an agent or user is trying to do, produces no verdict anything else consumes, and cannot block a message, action, or session.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Is this process a test run" is not a weighing of live signals — it is a two-value environment read with an enumerable domain (`VITEST`, `NODE_ENV=test`), and there are no competing signals to arbitrate between.

---

## 5. Interactions

- **Shadowing:** the guard runs before every other step in `setupCloudBackup`, so under a test it shadows all of them. That is the intent, and under a real run it is a no-op that changes nothing about the existing ordering.
- **Double-fire:** none. `setupCloudBackup` has a single call site (`initStandaloneAgent`).
- **Races:** none. Pure environment read, no shared state.
- **Feedback loops:** this removes one. Each test run added repositories to the account the next test run authenticated against; nothing consumed or bounded that growth.
- **Existing tests:** `tests/integration/fresh-install.test.ts` asserts a `.git` directory exists after init, but it uses the **non-standalone** path, which never calls `setupCloudBackup` and creates its git repo elsewhere. Verified by running it — unaffected.

---

## 6. External surfaces

- **External systems:** this is the entire point — the GitHub API is no longer called during test runs. That is a removal of an unintended external effect, not a new one.
- **Real users:** no change. A genuine `instar init` behaves byte-identically; the guard is false in every non-test process.
- **Persistent state:** stops creating persistent state (repositories) on the operator's GitHub account. Creates none.
- **Other agents / install base:** none.
- **Timing:** none.
- **Operator surface (Mobile-Complete):** no operator-facing action added or touched.

---

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, markup, approval page, or form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local BY DESIGN.** The check reads the environment of the single process running `instar init`. "Is this process a test run" is a fact about one process on one machine and has no meaning to replicate — a peer machine's answer would say nothing about this one's. There is no cross-machine question this could answer, so replication or a merged read would be noise, not coherence.

- **User-facing notices:** one line on stdout during a test run. No messaging surface, so no one-voice gating.
- **Durable state:** none held; the change only prevents durable state (repositories) being created. Nothing to strand on topic transfer.
- **URLs:** none generated.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit, ship as a patch. Pure code change, one function plus a guard clause.
- **Data migration:** none. Nothing persistent is written or read.
- **Agent state repair:** none. No deployed agent's state depends on this.
- **User visibility during rollback:** none for users. The visible consequence of a revert is that test runs would resume creating junk repositories on whichever account CI is authenticated as.

---

## Conclusion

The review changed one thing: the first draft treated `CI` as a test signal, which would have silently removed cloud backup from any user running `instar init` inside their own CI. That was narrowed to the two markers that actually mean "a test runner is executing this", and the exclusion is now pinned by a test.

The change is clear to ship. The residual is that the 377 repositories already on the operator's account still exist; that cleanup is an irreversible action on their property and belongs to them, not to this change.

---

## Second-pass review (if required)

**Reviewer:** not required.

The Phase 5 trigger list covers block/allow decisions on messaging or dispatch, session lifecycle, context exhaustion, coherence gates, idempotency checks, trust levels, and anything named sentinel/guard/gate/watchdog. This touches none: it suppresses one of `init`'s own external side effects during test runs and has no authority over any agent or user action.

---

## Evidence pointers

- Account census: 378 owned repositories, 377 auto-generated across three `instar-*-test-<random>` families, all 0 KB, dated 2026-06-14 to 2026-08-15.
- Origin traced to `tests/unit/init-claude-gating.test.ts` → `initProject({ standalone: true })` → `setupCloudBackup` → `execFileSync(gh, ['repo','create', 'instar-'+agentName, '--private', '--source', projectDir])`.
- `tests/unit/init-cloud-backup-test-guard.test.ts` — predicate true/false branches, `CI` explicitly excluded, and a standalone init leaving no `.git` (the observable proof the backup step never ran).
- **Shown capable of failing:** with the guard forced to `false`, the behavioural test fails with `expected true to be false` on the `.git` assertion. The probe was run with `gh` deliberately unauthenticated (`GH_CONFIG_DIR` pointed at an empty directory), so the run provably stopped at the auth step and created no repository — the account count was 378 before and after.
