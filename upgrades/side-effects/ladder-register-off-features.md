# Side-Effects Review — register the switched-off features on the maturation ladder

**Version / slug:** `ladder-register-off-features`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see the end of this file)`

## Summary of the change

The 2026-11-05 feature maturation review counted 13 switched-off features on no ladder. This change registers them in `src/data/feature-ladders.json` (202 entries, up from 191), adds a `finished` disposition so three features with no rollout left register without an invented bar, makes a feature at its last rung show its numbers, gives the heartbeat's fleet error rate a 3-day window, and adds the tracking the ladder marked as needed for `prGate.classClosure`, `mobilePairing.permissionActions` and `memoryPrivacy`. The governor also gains a would-deny row, because its promotion bar had nothing a ladder could read.

**Proportion:** Tier 1. 20 files, about 650 lines, most of them registry JSON, tests and these review documents. No spec review round (a revert undoes everything, and the feature ladder spec is amended in place). One second-pass round, which found three real defects, all fixed before commit.

## Decision-point inventory

- `MaturationLadder` state and rung derivation — modify — a `finished` entry reads `fleet` / `at-final`. Advisory only: the ladder decides nothing.
- `MaturationLadderService.features()` — modify — a feature at its last rung now lists the crossed rung's metrics. The verdict inputs are unchanged.
- `SelfActionGovernor.recordAdmit` — pass-through — adds a record after the counter. It reads no verdict and changes none.
- `authMiddleware` scoped-token branch — pass-through — adds a `finish` listener after the allow decision. The allow decision is unchanged.
- `MemoryInboundTracker.refuse` — pass-through — records before choosing the reply. The reply is unchanged.
- `pre-push-gate.js` — pass-through — reports after every error has already exited.

---

## 1. Over-block

No block/allow surface — over-block not applicable. Every addition runs after, or beside, a decision that is already made. `featureEvidence.record` never throws, and the pre-push step and `postEvidence` swallow every failure.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Measurement gaps that remain, stated so nobody reads them as covered:

- The governor's would-deny rate blends all classes, and `age-kill-backoff` dominates it. Enforcement flips per class, so the first class to move needs its own entry. The tracking plan says so.
- `benchmarkDivergence`, `sessions.dynamicMcp` and `monitoring.collaborationRedrive` are registered with `tracking.state: needed`. Each plan names the exact rows they must write. They read no-data until that lands.
- `responseReview`'s count includes canary rows, because the reader cannot express "not canary". The tracking plan warns to read the log near the threshold.
- The class-closure row depends on the pushing session having `INSTAR_AUTH_TOKEN`. A push without it loses one sample, which reads as fewer samples rather than a false pass.
- A scoped session ended because its audience changed, before it could answer, records `session ended with no reply`. That is honest but it is not always a sandbox fault; the review reads the rows before moving anything.

---

## 3. Level-of-abstraction fit

Right layer. The ladder registry is the single place thresholds live. `finished` is a disposition beside `composed` and `retire`, not a special case in a consumer. The reply signal sits in the auth middleware because that is the one place a scoped token is recognised and the route is known; putting it in each of six reply routes would drift. The last-rung metrics fix is in the service because the registry already held the fleet metrics: the brief read this as a registry gap, but the entry had them and the service dropped them.

---

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). Everything added is a signal. The ladder stays advisory, the review's model decides, and no new row can block, delay or rewrite anything. The would-deny row is written whether or not the class would have been denied, and observe mode still allows.

---

## 5. Interactions

- The governor row is capped at one per second per class and verdict, so a storm cannot evict other features' evidence from the shared log. Under a sustained storm above 1 a second the ratio is sampled rather than exact; `suppressedSinceLast` is on each row.
- `harmed` still reads the post-move window. The displayed number now matches it, because it comes from the same reading while the watch runs.
- Lowering the heartbeat's fleet window to 3 days changes its projection hash. Fleet rungs feed no D7 contract at the last rung, so no soak history is lost.
- `counts.withThresholds` now includes features at their last rung, because they now list metrics. It is a display count and gates nothing.
- `memoryPrivacy` rows are written only when `memoryPrivacy.enabled` is on, because a scoped session and `refuse` exist only then.

---

## 6. External surfaces

`GET /maturation/ladder` lists 11 more entries, and `metrics` is no longer empty at a last rung. The board shows them through its existing states. A class-closure row goes to the local agent only; nothing leaves the machine. Evidence rows carry an action kind, a channel and an audience kind, never a target, a place key or message text (asserted in tests). No new route, config key or migration.

---

## 7. Multi-machine posture

Machine-local by design, as with every row in `logs/feature-evidence.jsonl`: each machine records what it did, and the board's `scope=pool` read merges them. The registry ships in the package, so every machine gets the same entries on update. `replied` lives with the session token in `state/memory-privacy.json`, on the machine that issued it, which is where that session runs and ends.

---

## 8. Rollback cost

A revert. No data migration, no config, no agent state repair. Extra evidence rows are inert, and a stale `replied` field is ignored by older code.

---

## Second-pass review

**First pass: concern raised (independent subagent).** Three defects, each verified and fixed:

1. `responseReview`, `intelligence.jevJobCompletionAudit` and `monitoring.collaborationRedrive` read their switch directly, but the entries let the dev gate apply, so an absent key read as live on a development agent. Fixed with `on: true`, with a test that an absent key reads dark.
2. Every in-scope diff without a class block wrote `error`, though the written bar counts fixes only, so one feature PR touching a skill would have held the ladder for 14 days. The pre-push gate now says whether the branch is a fix, and a non-fix writes no row. The test for "fix" is the branch name or a conventional commit subject: cheap and brittle, which is acceptable for a signal.
3. The governor runs on every machine but has no enabled key, so fleet agents read `dark`, `not-started`. Added `flag.runsEverywhere`, with a test.

Minor, also handled: the pre-push block now needs `INSTAR_AUTH_TOKEN` before doing anything, and `counts.withThresholds` is noted above. The reviewer found no way for a new line to block or change a decision, no leak in any row, and no change to ladder state or D7 contracts for other features.

**Second pass after the fixes: concur (same reviewer).** All three hold. One non-blocking note: a fix whose branch name and commit subjects do not say "fix" writes no row, so it is undercounted rather than miscounted.
