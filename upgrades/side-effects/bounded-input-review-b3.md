# Side-Effects Review — bounded-input derivation review, batch 3

**Version / slug:** `bounded-input-review-b3`
**Date:** `2026-11-18`
**Author:** `Echo (M5)`
**Second-pass reviewer:** `independent reviewer subagent (concur, round 3)`

## Summary of the change

This is batch 3 of 4 for `STD-SUBCOUNTDOWN-bounded-input-derivation-review`. It covers 10 baseline entries: seven in `server/routes.ts` and three in `monitoring/`. On this branch the baseline goes from 43 to 33. Batches 1 and 2 are in flight and remove disjoint entries. Tier 1. Per-site readings are in `docs/audits/bounded-input-review/batch-3.md`.

Behaviour changes:
- **SessionWatchdog stuck-command judge.**
  - Commands up to 2000 characters reach the judge whole. Before, it saw only the first 200.
  - Longer commands are not judged.
  - The judge now returns a three-way verdict (stuck / legitimate / undecided). Only a real "legitimate" excludes the PID from later polls. An "undecided" PID (no judge, judge error, command too long) is deferred: the search skips it, so its siblings are still examined, until it passes the hard ceiling, when it is picked again and interrupted.
  - Before, any not-stuck answer excluded the PID permanently, so the documented ceiling fallback could never fire. That affected the no-judge and judge-error paths too, which are repaired by the same change.
  - The stdin-consumer guard now refuses ANY ceiling-only "stuck", not just the no-judge case. An undecided stdin consumer is still excluded, because re-checking it could never lead to action.
- **Commitment dispute (`/shared-state/resolve`, resolution `dispute`).**
  - A reason over 400 characters (the ledger's summary limit) is refused with 400 `X-Invalid-Field: disputeReason`, instead of being silently cut to 200.
  - An accepted reason is stored whole in `summary`; the subject is a label, ending in "…" when cut.
- **Resolved/cancelled ledger subject:** a cut ends in "…".
- **Manual job-trigger reason:** 500 characters kept, and a cut is disclosed (it reaches the Jev audit prompt as a label).
- **Collaboration re-drive nudge:** a cut quoted ask is disclosed in-band.

The other sites are exempt with written reasons: identifiers, a dedup key (deliberate coarse dedup, now stated), audit and display text, an already-disclosed list cap, and a log-only command string.

## Decision-point inventory

- SessionWatchdog stuck-process judge (can lead to Ctrl+C): modify input, add a refusal, and repair the undecided path (defer until the ceiling instead of a permanent exclusion), so the hard ceiling decides when the judge cannot.
- SessionWatchdog stdin-consumer guard: widened from "no judge" to "any ceiling-only verdict".
- Shared-ledger dispute (rendered into every session's context): add a refusal for a reason that cannot be stored whole.
- Collaboration re-drive (peer agent reading the nudge): modify input; the cut is disclosed.

No other decision point is touched.

---

## 1. Over-block

- **Dispute route:** a session sending a reason over 400 characters now gets a 400 and must shorten it. Deliberate: a cut dispute reason reads as the whole reason in every session's context. No shipped skill, template or hook calls this route.
- **Watchdog:** an undecided command that runs past the hard ceiling (default 30 minutes) is now interrupted, where before the permanent exclusion meant it never was. That is the behaviour the code's own docstring already promised ("the hard ceiling still deterministically recovers a genuinely hung command"). Stdin consumers are never interrupted on a ceiling-only verdict.

## 2. Under-block

A command over 2000 characters that really is stuck is interrupted only at the hard ceiling (`hardCeilingSec`, default 1800 s), not by the judge. If the ceiling is disabled (0), it is never interrupted. That is the file's documented safe direction for a destructive action.

## 3. Level-of-abstraction fit

The refusal sits inside `isCommandStuck`, beside the existing no-judge fail-closed branch. It uses the same fallback, so there is still one policy for "the judge cannot decide well".

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). The judge's authority shrinks for inputs it cannot see whole. Nothing gains authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The length check is a precondition for asking the judge, not a judgment about the command.

## 5. Interactions

- **Watchdog prompt size:** grows from a 200-character command to at most 2000, beside the existing 1,500-character output sample.
- **Watchdog deferral:** an undecided PID goes into `undecidedPids` and the stuck-child search skips it until it passes the hard ceiling. It neither earns a permanent exclusion nor blocks the search from reaching a stuck sibling; before the deferral it was picked first on every poll and hid its siblings (second pass, round 2). It is cleared when the process exits, or when a later verdict is reached. No model call is spent on it before the ceiling, including on the judge-error path. With the ceiling disabled (0) it is never re-picked, which is equivalent to the old exclusion.
- **Watchdog telemetry:** the refusal writes a console line. The provenance field `commandWasTruncated` is now always false, since a command that would need cutting is never judged.
- **Shared ledger:** `SUBJECT_MAX` and `SUMMARY_MAX` are now exported so the route derives its bounds from the ledger instead of repeating 200. `renderForInjection` renders `summary`, so the whole dispute reason reaches sessions.
- **Watchdog provenance:** the decision-provenance enrolment (`buildBoundedContext`) still records command and output identity only; covered by the existing "enrolls command/output evidence without storing their bodies" test.
- **Re-drive nudge:** the quoted ask grows by the marker only when cut. The nudge goes over Threadline as ordinary text.
- **Exempt sites:** comment-only, except the resolved/cancelled subject, which now marks its cut with "…".

## 6. External surfaces

- The `/shared-state/resolve` dispute contract changes: a reason over 400 characters is refused, and an accepted one is stored in `summary`.
- The re-drive nudge text seen by peer agents changes when a long ask is cut.
- There are no new routes or config keys.

## 6b. Operator-surface quality

No operator surface is touched.

## 7. Multi-machine posture

Machine-local by design: in-process decisions on the machine that runs the session or the re-drive.

## 8. Rollback cost

Revert the PR. Nothing is stored or migrated.

## Conclusion

Ten baseline entries cleared: two refusals (watchdog, dispute), two conversions (re-drive nudge, job-trigger reason), the rest exempt with reasons.

Real defects found and fixed:
- The stuck-command judge could interrupt a legitimate command after seeing only its first 200 characters.
- The watchdog's hard-ceiling fallback was unreachable for every undecided verdict.
- Dispute reasons were cut twice before being injected into every session's context.

The second pass rejected the first version. It showed that the "falls back to the hard ceiling" claim was false (the permanent exclusion), and that three exemption reasons were wrong (the dispute and subject reach session context; the trigger reason reaches the Jev audit prompt). All were fixed.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude Opus 5.5, fresh context, read-only), three rounds
**Independent read of the artifact: concur**

Round 1 raised CONCERN: (1) the watchdog refusal's "falls back to the hard ceiling" was false, because the caller excluded the PID for good on any not-stuck answer, so the ceiling never fired; the same latent defect hit the no-judge and judge-error paths; (2) `disputeReason` and `subject` DO reach a model (the shared ledger is rendered into every session's context), and the dispute reason was cut twice; (3) the job-trigger reason reaches the Jev audit prompt; (4) the run-end, dedup-key and path-list rationales were inaccurate. Fixed: a three-way verdict, a dispute refusal over the ledger's summary limit with the whole reason in `summary`, a marked subject cut, the trigger reason converted, the rationales rewritten. Round 2 raised CONCERN: a re-polled undecided command was picked first every poll and hid a stuck sibling. Fixed with `undecidedPids` (deferred until the ceiling), plus a poll-level sibling test that fails without it. Round 3: CONCUR; its three wording leftovers are fixed in this commit.

---

## Evidence pointers

- `tests/unit/SessionWatchdog-failclosed.test.ts`: a 200+ character `cd … && npm test` reaches the judge whole; a command over the bound never calls the judge and does not interrupt below the ceiling.
- `tests/unit/SessionWatchdog-pipeline.test.ts` (poll level, through `checkSession`): an over-bound command is deferred at 4 minutes and IS interrupted at 31; an undecided command does not hide a stuck sibling (fails without the deferral); a judge error below the ceiling defers rather than excludes; a stdin consumer reached "stuck" only by the ceiling is not interrupted.
- `tests/unit/sharedStateRoutesV2.test.ts`: a 600-character dispute reason is refused with 400; a 300-character one is stored whole in `summary` with a marked subject.
- `tests/unit/CollaborationRedriveEngine.test.ts`: a long ask is disclosed; a short one is quoted whole.
- All ten SessionWatchdog test files pass. `lint-bounded-judgment-input` is clean at 33 on this branch.

---

## Class-Closure Declaration (display-only mirror)

The defects fixed are instances of silently cut judgment input. The standing guard is `scripts/lint-bounded-judgment-input.mjs` (a shrink-only baseline with a ceiling); this batch shrinks its population.
