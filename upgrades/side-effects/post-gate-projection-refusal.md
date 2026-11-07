# Side-Effects Review — post-gate check no longer reads a rollback projection as a definition change

**Version / slug:** `post-gate-projection-refusal`
**Date:** `2026-11-06`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

`triggerJob` re-reads the job set after a gate has waited and refuses the fire when the definition or approval moved (added in #2789). It compared the live definition with `job`, which by then may be the session-rollback projection `{...job, execute: {type: 'agentmd'}}`. Those can never match, so every gated, projected job was refused on every fire. The check now compares the live definition with a snapshot taken before projection. The single refusal branch is split so each cause is named: failed portable check (the only path that writes a portable integrity record), job removed, job disabled, definition changed. `definition-changed` is a new `SkipReason`, it counts toward the job-silence alert, and the console gives it plain words. Files: `src/scheduler/JobScheduler.ts`, `src/core/types.ts`, `dashboard/console/schedule-model.js`, tests. Tier 1. About 35 changed source lines; 2 test files.

## Decision-point inventory

- `triggerJob` post-gate check — modify — compares against the pre-projection definition; refusal split by cause.
- `recordImportedPortableIntegrityFailure` call at that check — modify — only runs when the portable check failed.
- `observeContinuitySkip` — modify — `definition-changed` now counts toward the silence alert (signal only).

---

## 1. Over-block

The change removes an over-block. Remaining refusals: a job whose manifest, or whose body as seen by the live set, really changed during its gate. That fire is lost and the next scheduled fire uses the new definition, which is the existing behaviour. `refreshAgentMdBodyIfChanged` runs before the snapshot, so a body refresh on this fire is not a change. The comparison leaves out `topicId` on both sides, because the scheduler writes that onto the live job at runtime and a reload drops it. This also removes a smaller false refusal the old code had: a job with a runtime topic was refused when an unrelated job's edit reloaded the set during its gate.

## 2. Under-block

No new under-block. All three protections hold and are tested: a real edit (projected and unprojected), disable or removal, and a portable failure. The snapshot is taken after the admission refresh and before the gate, so the protected window is the same one as before. The check still cannot see a change made after it runs, which is unchanged. A manifest edit that changes only `topicId` during a gate is no longer refused. That one fire keeps the previous topic, for its notices and for the soft `[TOPIC AWARENESS]` context in its session prompt; the next fire uses the new topic. Its tools, body and script are unaffected. Imported jobs are not exposed to this, because a `topicId` edit changes the manifest and fails the portable hash. An agentmd body edited mid-gate is unseen, as before, because the trigger-boundary refresh owns body adoption. The `this.paused` term was dropped from the condition because the block directly above returns on `paused` with no await between, so it was unreachable.

## 3. Level-of-abstraction fit

Right layer: the check belongs in `triggerJob` where the gate wait happens. Fixing `projectAsAgentmd` or the comparison's normalisation would be wrong, because the projection is correct and the compared object was the mistake. Comparing before projection avoids teaching the check what a projection looks like.

## 4. Signal vs authority compliance

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

None of the boxes fits exactly. This is an existing deterministic safety check, an exact equality on a definition before an unattended run, and the change narrows it to what it was meant to block. It adds no new authority. Equality on a definition is not a heuristic: there is no meaning for it to misread. The fix removes the case where it held authority over something it could not judge.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Did the definition change" is an invariant check with an enumerable answer.

## 5. Interactions

- **Shadowing:** the portable check now runs first, and runs even when the job is gone from the live set. An imported job that lost approval or had its manifest edited is withheld by the loader, so `live` is undefined; running the portable check first keeps that recorded as an integrity failure, as it was before. Tested.
- **Double-fire:** none. The later hold check in the same function re-projects after the comparison and is unaffected.
- **Races:** the snapshot is a string, so nothing that mutates the job object during the gate can change it. Concurrent `refreshJobs` from another fire replaces the array, and the comparison sees the newest, which is the intent.
- **Feedback loops:** `definition-changed` feeds the silence alert, which needs 3 refusals in a row. A one-off edit does not reach it.
- **Load on resume:** the blocked jobs resume as ordinary sessions, under the same quota, memory and capacity gates as before 2026-11-05. No catch-up burst is added by this change; they resume on their normal schedules.

## 6. External surfaces

Fleet-wide and intended: where script runners are dark, which is the fleet default, every gated instar script job was being projected and refused. Those jobs start running again as sessions. The skip ledger and `/jobs` skip data can show `definition-changed`; the console words it plainly and unknown reasons already fall back safely. `gateReason: post-gate-definition-changed` keeps its name but no longer covers removal, disable or integrity, which report `job-missing`, `disabled` and `portable-integrity`, the same names the pre-gate checks use. `job-portable-status.json` stops receiving false writes; the writer already returned early for non-imported jobs, so no false rows exist to clean up (checked on Echo: the file does not exist). No operator-facing actions.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Touches `dashboard/console/schedule-model.js` by one label in an existing word map.

1. **Leads with the primary action?** Yes, unchanged; no layout or action changes.
2. **Zero raw internals as primary content?** Yes. This replaces the slug fallback ("definition changed") with plain words.
3. **Destructive actions de-emphasized?** n/a: no action is added; this is a label.
4. **Plain language + phone width?** Yes: "skipped (its settings changed while it was starting)", in the same text run as the existing labels.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** Each machine's scheduler admits its own fires from its own job files, and the skip ledger is per-machine observability. No new state, notices or URLs.

## 8. Rollback cost

A revert restores the previous behaviour with no data migration. Old code reading a ledger row with `definition-changed` treats it as an opaque string. Hot-fix release only.

## Conclusion

Safe to ship. It removes a refusal that stopped every gated, projected job, and keeps every real protection, each with a test on both sides of the boundary. A related check was made and needs no change: `INSTAR_AUTH_TOKEN` in gates is correct (see Evidence).

## Second-pass review (if required)

Independent reviewer, first pass: **Concern raised.** The string snapshot included the runtime-only `topicId`, written in place by `ensureJobTopic` and the lazy on-alert path. A topic assigned during a gate would have been refused, a regression from this change, and an unrelated reload during a gate refused a job holding a runtime topic, which the old code also did. I confirmed this in the code before acting. Fix: `gatedDefinition()` leaves `topicId` out of both sides; two tests added; this artifact's false sentence corrected. Everything else the reviewer checked was clean: real changes still refuse, dropping `this.paused` is safe, portable-first keeps withheld imports recorded, and the silence-alert addition is sound.

Second pass on the fix: **Concern raised**, wording only. The claim that a topic-only edit decides only where a notice goes was unsupported, because `topicId` also feeds prompt context. The reviewer found the fix itself sound: both repros now run, 14 of 14 tests pass. Claim corrected here and in the code comment.

Third pass: **Concur with the review.**

## Evidence pointers

- Tests: `tests/unit/job-cost-runner/JobScheduler-post-gate-definition.test.ts`: 14 pass with the fix; on the old scheduler all 12 of the original tests fail.
- Live refusals in `.instar/logs/activity-2026-11-05/06.jsonl`: triage 80, process 48, execute 45, llm-decision-grading 29, action-list 4.
- `llm-decision-grading` is not in `disabledSlugs`: it is projected by a supervision hold, `independent-history-mismatch`, recorded 2026-11-04T01:00:56Z in `.instar/ledger/job-supervision.db`.
- Gate token, 2026-11-03 to 11-06: of 599 gate skips on insight-harvest and evolution-proposal-evaluate, 222 tracebacks all came within 151 s of a scheduler start, 372 had no error, and 5 were 10 s timeouts within 489 s of a start. Exit is python's 1, not curl's 22. Run live with the real token, both gates reach the server and get an empty list, so exit 1 means nothing to do. The 69 exit-22 rows are feedback-factory gates, all within 3 minutes of a start. Same process, same token, working later, so the token is not the cause.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is a TypeScript logic defect. The scheduler's firing behaviour is not made more self-triggering: it restores fires that were wrongly refused, under unchanged cron and retry limits.
