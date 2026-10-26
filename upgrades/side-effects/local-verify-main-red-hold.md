# Side-Effects Review — Local Verify main-red hold (no doomed runs while `main` is red)

**Version / slug:** `local-verify-main-red-hold`
**Date:** `2026-10-26`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (small, reversible, live kill switch). 7 source files, ~330 LOC of runtime change, 4 test files. Effort: 0 spec review rounds (Tier-1 lite path; the governing spec is amended with a "built" paragraph), 1 commit attempt expected.

Amendment to `docs/specs/local-verify-merge-authority.md` §2 "Post-merge verify of `main`" (CMT-1033). A PR verify tests the PR's merge with `main`, so while `main` fails a known check every PR that does not fix it fails the same check (2026-10-26: eight 18-minute doomed runs after `main` went red on `tests/unit/no-silent-fallbacks.test.ts`; three sessions wrote the same fix). New `src/localVerify/mainRedHold.ts` (pure): `mainFailureFromRunDetail` (the bounded failing-files detail of a failed `main` run), `repairVerdict` (a PR is a repair candidate when its diff touches a failing file OR its title/body names it — path, basename, or stem), `decideMainRedHold` (active while the health state is unhealthy WITH a red head AND the kept failure detail matches that head and names ≥1 file; splits the queue into candidates and held PRs; lists the running candidate and the episode's remembered candidates as "fixing it"), `holdReasonText`. `LocalVerifyService`: keeps the last failed `main` run's detail (`state/local-verify/main-failure.json`, read at boot, removed on green); `pump()` starts only a `main` verify or a candidate while the hold is active (held entries keep their place); `request()` reads `title,body,files` from the PR view (new `prView` fields, `serviceSeams.ts`), admits a candidate past a full queue, answers `hold` on a held PR, and re-reads the view on `already-queued` so a renamed PR becomes a candidate; `snapshot()` carries `mainRedHold` + per-entry `held`; one `main-red-held` audit line per PR per episode; once RED, ONE deduped signal for the episode (`local-verify:main-red-hold`) naming the failing check, every PR fixing it and the held PRs, re-raised under the same id only when the red head or the sorted fixing list changes and closed via a new `clearSignal` seam on green; the existing `local-verify:main-red` signal's detail carries the repair/held split. `scripts/safe-merge.mjs` `verifyRequestOutcome` appends the hold text. `server.ts` wires the live switch `monitoring.localVerify.mainRedHold` (absent ⇒ on). Agent awareness: `templates.ts` bullet + `PostUpdateMigrator` content-sniffed line. State registry: `local-verify-main-failure`.

**Added in the same PR (operator request, 2026-10-26 10:54):** a `merge-throughput` GitHub label gives a queued PR priority 10 (main 100, ordinary 0), read from the PR view's `labels`; bounded by aging (an ordinary PR that waited 90 min ranks at 10, so no later labelled PR passes it) and by the unchanged 3-hour starved alarm.

**Proportion:** about 12 files, ~450 LOC including tests; one session resumed the unfinished work, two targeted test runs failed on my own wrong expectations before passing.

## Decision-point inventory

- `decideMainRedHold` / `pump()` admission — add — which queued verify may take the slot next while `main` fails a known check. Deterministic over server-held data.
- `repairVerdict` — add — is a PR a repair candidate (touches or names a failing file). Deterministic.
- `request()` queue-full admission — modify — a candidate is admitted past the cap while the hold is active.
- `noteHold` signal — add — one deduped attention signal per red episode (only once RED, never on the first failure), refreshed when the fixing list changes, cleared on green.
- `effectivePriority` / `pump()` sort — modify — the `merge-throughput` label ranks a PR ahead of ordinary PRs; aging bounds it. Deterministic.
- Merge decisions (`isMergeEligible`, the §3 predicate, safe-merge) — pass-through, unchanged.

---

## 1. Over-block

- **Label:** an ordinary PR may wait behind up to the queue cap of labelled PRs that were queued before it reached 90 minutes. Accepted and bounded by the cap (10) and the starved alarm.

- **A repair that neither touches nor names the failing file is held** (e.g. a fix that raises a baseline in a sibling fixture file and whose author wrote nothing about the check). It waits until `main` is green — which, if it is the only repair, never comes on its own. The release is cheap and documented everywhere the hold is shown: name the failing file in the PR title or body (`gh pr edit`), re-POST, and the entry becomes a candidate in place (`already-queued` re-reads the view). The attention item, `GET /local-verify`, the POST answer and `safe-merge` all say this.
- **During `main-suspect` (first failure, re-run pending)** unrelated PRs wait ~20 minutes for the re-run even when the failure turns out to be a flake. Accepted: main health only sees a failure that survived the per-file isolation re-run, so a suspect is usually real, and a 20-minute wait is cheaper than an 18-minute doomed run per PR.
- **A PR with an unreadable file list** (gh failed; a view from an older seam) is held as `files-unknown` unless its text names the check. Restrictive direction, stated in the hold reason.
- **False-positive candidate**: a PR whose body merely mentions the failing file ("every PR fails `no-silent-fallbacks` on main") is treated as a repair and runs. Cost: one doomed run, today's behaviour — never a wrong merge.

---

## 2. Under-block

- **Label:** a PR that speeds up merging but carries no label gets no boost; the label is the deliberate lever, set by whoever opens the PR.

- **The hold needs the failing files.** A failed `main` run that names no file (dirty tree, lane deadline, zero-test lane) keeps today's order: doomed runs continue. The hold is inactive with reason `failing-files-unknown`, visible in `GET /local-verify` (null hold) and the audit.
- **A verify already running when `main` goes red is never cancelled** (it may be doomed; it finishes). Deliberate: cancelling in-flight work is not this change's authority.
- **A restart between the failed `main` record and the state-file write** (sub-millisecond window) loses the files until the next failed `main` verify; the watermark still keeps `main-red`, so merges stay frozen; only the hold is absent.
- **The deduped repair item is raised only once `main` is RED.** A candidate identified during `main-suspect` gets its item at the first pump after red (the first test covers this). A second session that opens its fix during the suspect window is told by the read surface and the POST answer, not by an item.

---

## 3. Level-of-abstraction fit

The hold sits exactly where the slot is spent — `pump()`'s start admission, next to the merge hold, the verifier hold and the update pause — and is a pure function over data the service already holds (health state, the run-detail it already audits, the PR view it already reads). No new loop, no new poller, no new LLM call. The repair rule is a detector (cheap, string/set matching) whose only authority is ORDER and DELAY of verify runs; merge authority stays with the §3 predicate and safe-merge. A smarter alternative (run only the failing files against each PR's merge tree as a probe) would need the verifier child and a verifier-version bump; it is the right next step if the text rule proves too narrow, and is not needed to close this incident.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is a deterministic invariant over structured server state, and its authority is bounded to scheduling (which verify starts next), never to a merge, a message or a session.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The brittle part (the text match) can only ADMIT a PR (make it a candidate); a wrong admission costs one run. The hold itself rests on the verify's own measured failure (the files the `main` run reported), not on a guess. Every held PR is released by a green `main` or by the author naming the check; the kill switch is read live.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point: "would this PR fail the check `main` is failing" is enumerable from the PR's diff and text against the measured failing files; where it is not (files unknown, no file named), the rule holds the restrictive answer and says so, rather than guessing. Spec supervision: tier0.

---

## 5. Interactions

- **Shadowing:** `pump()` already refuses to start while a merge hold, a verifier hold, an update pause or a foreign suite holder is present; the main-red hold runs AFTER those checks and only narrows the candidate set. The existing fair share (`decideStart`) runs unchanged over the narrowed set, so `main` still alternates with PR starts while unhealthy.
- **Double-fire:** the existing `local-verify:main-red` item (raised on the failed re-run) and the new `local-verify:main-red-hold` item are different ids. The hold item has ONE stable id for the "main is red" condition: a re-raise lands on the same attention row (the lifecycle refreshes its body and reposts once to the hub) only when the red head or the SORTED list of fixing PRs changes, so the same PRs in another order (one started, one finished, a label re-sort) never repost or reopen an acknowledged row. After a restart the in-memory signature is empty, so the first pump may re-raise an identical body, which the lifecycle treats as a silent repeat. Green closes it by its stable id whenever an episode existed (including one loaded from the state file at boot), so a restart cannot strand it open; with the attention lifecycle off, the clear is a no-op and the row stays until acknowledged, as every local-verify item does today.
- **Label vs hold:** the hold runs after the sort and filters to repair candidates, so a labelled non-repair PR is held like any other while the hold is active. `main-red-held` audit lines are once per PR per episode.
- **Races:** `request()` is async (gh reads) and `pump()` is sync; the hold decision is recomputed at every pump from current state, so an entry whose text changed between a decision and a start is re-evaluated before it starts. The `already-queued` path now re-reads files/text and pumps.
- **Feedback loops:** green → `clearMainFailure()` → `pump()` releases the held PRs in queue order (bounded by the queue itself); `rerunFailures()` after green re-requests failed records as before — the hold is inactive then. A candidate admitted past the cap is bounded (held ≤ cap ⇒ queue < 2×cap).
- **Watcher:** `GreenPrAutoMerger.requestVerifies` already requests nothing while unhealthy; unchanged.

---

## 6. External surfaces

- `merge-throughput` label: anyone who can label a PR in the repo can raise its verify order. Only trusted heads (this agent's and the operator's logins, same repository) are verified at all, and the label changes order only, never a merge decision. Over-use is bounded by the 90-minute aging and visible as `priority` on each queue entry.

- `PrView` gains optional `title`, `body`, `files` (gh `--json` adds three fields; one call, no extra request). The `files` list is gh's first 100.
- `GET /local-verify`: new `mainRedHold` (null when inactive) and per-entry `held`; the PR body is never served (`text` is stripped from the snapshot). `POST /local-verify`: optional `hold` on a 202. Both additive; existing fields unchanged.
- `safe-merge`'s `refused:verify-pending` line now reads `queued (held: main is red on …; PR #N is already fixing it …)` for a held PR.
- New state file `state/local-verify/main-failure.json` (registered `local-verify-main-failure`; one file, atomic, removed on green). New audit events `main-red-held`, `main-red-hold-idle`, `queue-full-repair-admitted`, `main-failure-write-failed`, `main-failure-remove-failed`.
- Attention: the new repair items are HIGH/MEDIUM-routed by the existing `lvHooks.signal` (MEDIUM — not in the HIGH list), into the Attention hub like every other local-verify item.
- **Operator surface:** no operator action is added; the read surfaces are for the agent and sessions. Not applicable.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no dashboard, approval page or form is touched).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**, the same posture as the verify queue and the main-health watermark it extends: the queue it gates is this machine's (the lease holder runs verifies; a standby answers 409 on these routes and starts nothing), and the failing files belong to this machine's own failed `main` run. On a lease move the new holder enters `main-suspect`; a holder that never measured a failure has no red head, so its hold is inactive until its own `main` verify measures one, while a holder that comes BACK after a round-trip keeps its watermark's red head (`MainHealth.load` keeps `redHead` for `foreignHolder`/epoch-gap) and its own state file, so its hold stays active on that head until a green `main` verify clears it — the restrictive direction, and under suspect the fair share starts `main` first, so green is always reachable. User-facing notices: the per-candidate items go through the same one-voice signal sink as `main-red` (the holder raises them). Durable state: the state file is machine-local and never strands a topic (it belongs to no topic). URLs: none generated.

---

## 8. Rollback cost

- **Live:** `monitoring.localVerify.mainRedHold: false` (read at every pump) restores the old order without a restart.
- **Code:** revert and ship a patch. The `main-failure.json` file is ignored by older code and is removed on the next green `main`; the three new `PrView` fields are optional. No migration, no agent state repair.
- **User visibility:** none during rollback; at worst the old doomed-run behaviour returns.

---

## Conclusion

The review changed one thing: the first draft held during `main-red` only; the evidence (PR 2363 started during `main-suspect` and was doomed just the same) moved the hold to "failed head with known files", and the per-candidate item stays RED-only so a flake never pages. The repair rule was widened from "touches the failing file" to "touches OR names it" after reading the two real repairs (both touched `src/`, both named the check) — the brief's diff rule alone would have held the actual fixes. Clear to ship as Tier 1.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the code first)
**Independent read of the artifact: concur**

Concur with the review. Checked from the code: the way out of a hold is real (`request()` defaults `explicit` to true; the `already-queued` path re-reads files/text, pumps and answers `holdFor`); every resume path (`refreshBaseThenPump`, `retry`, `rerunFailures`, restore) re-decides the hold before a start; the text match's only effects are the `admissible` filter and the past-cap admission — no merge decision can change; `clearMainFailure()` covers every unhealthy→healthy transition (only `onVerify` success produces healthy); indices cannot go -1; the in-flight entry is never in `heldPrs`; the signal detail carries file names and PR numbers only; the state file is written only on `outcome === 'failure'`; the switch is read on every pump/request/snapshot. Two notes, both applied before commit: §7 wrongly said a returning lease holder has no red head (it keeps the watermark's, so the hold stays active on it — corrected above); and a remembered candidate whose re-queued head no longer qualifies appeared in both lists (now held only). Noted, accepted: the per-candidate item waits for the next pump, so during an in-flight doomed run (≤18 min) or an open merge hold it is delayed — timing of a signal, not authority.

---

## Evidence pointers

- Incident: `.instar/logs/local-verify.jsonl` on the agent (2026-10-26 13:36Z `main-health` first-failure, 14:10Z `main-red`; `started` for PRs 2363, 2364, 2350, 2372 against base `ebb9366f5…`; `run-detail` lines all `file-failed:tests/unit/no-silent-fallbacks.test.ts:1`).
- Repairs: PR 2372 files `src/server/routes.ts` + docs, title "main red on no-silent-fallbacks…"; PR 2373 files `src/core/machineLoadReport.ts` + docs, body names `tests/unit/no-silent-fallbacks.test.ts`.
- Tests: `tests/unit/localVerify/mainRedHold.test.ts` (pure rules), `tests/unit/localVerify/mainRedHoldService.test.ts` (hold, order, read surface, items, cap, green release, restart, kill switch, no-file failure), `tests/integration/local-verify-routes.test.ts` (the hold over HTTP), `tests/unit/safe-merge-local-floor.test.ts` (the held line), `tests/unit/PostUpdateMigrator-localVerifyMainRedHold.test.ts` (awareness + migration).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The change adds no self-triggered controller: the hold only narrows which already-requested verify starts next; it fires no restart, swap, respawn, spawn, retry or kill, and its signal is bounded to one per candidate per episode.

---

## Second-pass review (round 2: the single episode item + the merge-throughput label)

**Reviewer:** independent reviewer subagent (fresh context, read the diff and the code)
**Outcome: concern raised, three issues, all fixed before commit.**

1. The item would repost, and reopen an acknowledged row, when the same fixing PRs merely changed order (a PR moved from running to remembered, or a label re-sorted the queue). Fixed: the signature is the red head plus the PR numbers SORTED, and the note lists them sorted. Test: a repair finishing while `main` stays red raises nothing.
2. The clear depended on memory, so after a restart (or with a newer red head) an open item could stay open for 14 days. Fixed: one stable id `local-verify:main-red-hold` for the condition (a newer red head refreshes the same row); green closes it by id whenever an episode existed, including one loaded from disk. Test: a restart with nothing in memory, then green, closes it.
3. A restored labelled PR whose view could not be read fell back to ordinary. Fixed: the queue file keeps the throughput priority, used only when the view is unreadable. Test: restore with an unreadable view keeps it; a readable view without the label lowers it.

Checked sound by the reviewer: the `main` verify is never aged and stays above every PR; while the hold is active held PRs are filtered out before `decideStart`, so a labelled non-repair never starts ahead of a repair or `main`; fair share is unchanged; the aging bound holds with the stable sort; priority is re-read on the already-queued, moved-head and new-entry paths; the clear seam is wired end to end; the migration line is content-sniffed; no authority change.

---

## Release-note wording (pre-push gate)

The pre-push gate refused the first push. The fragment's user-facing paragraph used inline code and a camelCase config key. That paragraph is now plain words ("I can turn the waiting rule off for you"). This is a wording change only, with no runtime effect, and the review above still holds.

---

## Second-pass review (round 3: the five merge-path files on the verified head)

**Reviewer:** independent reviewer subagent (Claude, fresh context), two passes on scripts/safe-merge.mjs, src/localVerify/LocalVerifyService.ts, src/localVerify/localVerifyWiring.ts, src/localVerify/mainRedHold.ts and src/localVerify/serviceSeams.ts
**Outcome: concern raised on the first pass, fixed, concur on the second pass.**

First pass (head b056067): no path to a wrong merge. The hold only narrows which queued entry `pump()` may start; records, pass/fail and the merge line are untouched, and the `safe-merge.mjs` change only adds text to the existing `refused:verify-pending` refusal. One real liveness defect: a plain revert of the breaking change neither touches nor names the failing test file, so it was held, and with no other fix queued `main` could stay red with nothing able to turn it green. Fixed: a PR whose title starts with "Revert" or whose body carries GitHub's `Reverts owner/repo#N` line is a repair candidate (`isRevertText`), and the hold reason and the attention-item note say so. Two comments corrected: an unknown-origin suspect keeps the watermark's red head (the hold can stay active there), and past-cap admission of candidates has no second cap. Accepted, recoverable: a repair PR restored at boot with an unreadable PR view stays held until its verify is requested again (the already-queued path re-reads it).

Second pass (the fix): concur. The revert match was checked against real GitHub revert titles and bodies, and rejects prose "reverts", "reverting" and quoted lines. A false positive costs one verify run and can still merge only on a full pass. No consumer of the `by` union breaks; type check clean. Its one wording suggestion (the attention-item note) was applied. Targeted tests: tests/unit/localVerify/ and tests/integration/local-verify-routes.test.ts, 436 passed.
