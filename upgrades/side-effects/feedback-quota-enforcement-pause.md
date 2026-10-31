# Side-Effects Review — Bounded quota-enforcement pause

**Version / slug:** `feedback-quota-enforcement-pause`
**Date:** 2026-10-28
**Author:** Echo
**Second-pass reviewer:** independent reviewer; concurred after two safety corrections

## Summary of the change

`SessionMigrator` gives the quota-enforcement scheduler pause a five-hour deadline and exposes its reason, start, and expiry. `QuotaManager` forwards this state to `/quota/migration` and clarifies both release notifications. At deadline, the scheduler resumes for script checks while AI jobs wait for a fresh healthy quota reading. The new-agent template and update migrator teach agents where to inspect it. The change touches four runtime source files, quota unit/integration/lifecycle tests, the quota pause overview, and an upgrade fragment. The first executor-generated commit omitted the release and decision-audit artifacts; this repair recomposes it through the normal commit gate.

## Decision-point inventory

- `SessionMigrator.enterEnforcementPause` — modify — preserve the first pause deadline when enforcement repeats.
- `SessionMigrator.expireEnforcementPause` — add — release the migrator's own scheduler pause at the fixed deadline; retry a failed release after one minute.
- `SessionMigrator.releaseEnforcementPauseIfRecovered` — pass-through — the earlier recovery path remains the faster release.
- `QuotaManager.getMigrationStatus` — pass-through — report the pause state without changing its authority.
- `QuotaManager.canSpawnSession` — modify — after deadline, refuse AI jobs until a fresh healthy quota reading exists.

## 1. Over-block

The existing quota enforcement still stops sessions at its existing thresholds. After a deadline release, a genuinely healthy account whose collector remains broken cannot start AI jobs; script jobs can run and the status exposes the wait. This is necessary because `QuotaTracker` otherwise fails open on stale data. A fresh healthy reading clears the guard.

## 2. Under-block

The deadline releases the scheduler even if a stale high reading remains, but `QuotaManager.canSpawnSession` then blocks AI jobs until a new reading is both newer than the deadline release and below the migration thresholds. Script checks can run. If quota collection never recovers, AI work remains gated; this is visible as `awaitingFreshQuota`. If `resumeScheduler` throws, a degradation is reported and the timer retries after one minute. The pause record is in memory: a process restart creates a fresh scheduler and migrator rather than restoring the old record.

## 3. Level-of-abstraction fit

The migrator owns this specific pause and already owns the recovery release. A timer at that layer is a safety bound on its own action. `QuotaManager` owns the spawn gate and therefore applies the post-deadline freshness condition there. It also provides the public read and notification wiring.

## 4. Signal vs authority compliance

Required reference: [signal versus authority](../../docs/signal-vs-authority.md). The five-hour deadline is a deterministic safety bound on a temporary action, not a brittle classifier of user intent. The freshness condition is applied by the existing quota spawn authority, not a new competing gate. The status field is observation only and holds no blocking authority.

## 4b. Judgment-point check

No new static heuristic arbitrates competing live signals. The maximum duration is an invariant on a temporary scheduler hold; recovery readings can still release earlier.

## 5. Interactions

- **Shadowing:** recovery runs before the deadline whenever a successful quota reading arrives; clearing the pause cancels the timer.
- **Double-fire:** the pause flag and timer clear on the first successful release, so recovery and expiry cannot both send a resume event.
- **Races:** repeated enforcement retains the original expiry. `enforcement_unverified_releasing` installs the AI spawn guard before `JobScheduler.resume()` synchronously drains its queue, both at the deadline and during shutdown disposal. A thrown resume keeps the pause and arms a one-minute retry.
- **Feedback loops:** after expiry, scheduler script checks run; AI triggers are held by `QuotaManager.canSpawnSession` until a fresh healthy reading. A later high reading may enforce again.

## 6. External surfaces

`/quota/migration` gains additive `enforcementPause` and `awaitingFreshQuota` fields. Telegram quota notices now state the maximum duration and explain the restricted deadline release. Generated `CLAUDE.md`, its update migration, and the Codex/Gemini shadow gain the same guidance paragraph. No new operator action is required; status can be read from the authenticated API. There is no new external URL or durable database state.

## 6b. Operator-surface quality

The migration checks for the shared quota guidance heading; the feature-delivery parity test tracks that heading as an agent-facing capability rather than exempting the new text as legacy content.

No dashboard or operator form is modified. The existing status API gains additive fields; no operator action is added.

## 7. Multi-machine posture

**Machine-local by design:** scheduler pause and quota collector are local to each agent process. A second machine's healthy scheduler must not inherit this machine's pause. The only notices are emitted by the local migrator that took the pause, preventing a second machine from duplicating its release notice. No durable state follows a topic transfer, and no URLs are generated.

## 8. Rollback cost

Revert the commit and publish a patch release. Existing agents may retain the extra `CLAUDE.md` guidance until a later migration removes it, but the status fields simply become absent again. No data migration or state repair is required; a restart resets the in-memory pause and post-deadline guard. The bounded release behavior disappears on rollback.

## Evidence and proportion

Declared Tier 1: this is a reversible scheduler bug fix with no durable state mutation. The automated risk floor signals Tier 2 because the parity guidance touches `PostUpdateMigrator`; that file adds only an idempotent sentence. The executor authored the initial migrator fix; independent safety review found that `QuotaTracker` fails open on stale data and that scheduler resume drains queued jobs synchronously, including on disposal. The repair adds a pre-resume guard and queued-job and disposal regressions. The executor's new test file was consolidated into the existing quota-enforcement unit file so the final diff introduces no file-deletion operation. Initial focused unit tests and build passed before that revision; fresh integration, lifecycle, full suite, and CI remain pending.

**Second-pass result:** Concur with the review. The reviewer confirmed that the shared pre-resume event installs the AI gate before both deadline and disposal queue drains, and that the lifecycle test now wires the real scheduler gate. After moving the bounded-pause cases into the existing unit test file and correcting the deadline notice, the reviewer found no new blocker in the final diff against the PR base. Focused unit tests passed 29/29; lifecycle execution remains queued behind the host's suite-lane holder.
