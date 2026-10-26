# Side-Effects Review — merge line accepts own PRs by author; a no-message respawn resumes in-flight work

**Version / slug:** `merge-line-author-eligibility-and-handoff-resume`
**Date:** `2026-10-25`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1 (small, reversible): ~12 files, ~450 added lines of which ~330 are tests;
spec review 3 rounds (the Tier-1 cap), cross-model codex-cli each round.

**D1.** `classifyCandidate` (`src/monitoring/greenPrLogic.ts`) refused every PR whose
branch did not start with `echo/`, so 9 of Echo's 10 open PRs were never merged even
after local verify passed them (silently: `handoff-not-eligible:not-agent-namespace`).
A new pure `agentOwnership()` admits a PR when its branch is in the namespace OR it
was opened by `expectedGhLogin` on a same-repo head; a fork (`isCrossRepository`) is
refused before either arm. The list projection gains `author,isCrossRepository`
(`greenPrAutomergeWiring.ts`, mapped in `mapPr`). The same helper now drives the
watcher's gather, hand-off reason, verify requests, red-PR watchdog,
namespace-mismatch signal, and the wiring's `holdEligible` (so `POST /hold`, which
also runs `--disable-auto`, covers every PR the watcher can merge). A listed PR still
refused is recorded in `state.notAgentOwned`, audited once per (pr, head) as
`skipped:not-agent-owned`, and exposed as `notAgentOwnedCount` / `notAgentOwned` on
`GET /green-pr-automerge`. The CLAUDE.md Green-PR section gains one line (migrated via
the existing marker-sniff in `PostUpdateMigrator`, marker `notAgentOwnedCount`).

**D2.** `spawnSessionForTopic` (`src/commands/server.ts`) told a respawned session with
no new user message to "wait silently". The no-message branch now uses
`buildHandoffContinuationInstruction()` (`src/core/handoffContinuation.ts`): answer an
unanswered latest user message; resume work the context shows as in flight after
reconciling a later stop and checking external state (never repeat an action that
already happened); bounded retry of a hung step; wait silently only when nothing is in
flight; never narrate the switch. The topic's open commitments are listed as untrusted
data, tagged `[resumable]` or `[waiting on the user]`, capped at 5 × 300 chars with
in-band notice; an unreadable tracker renders "COULD NOT BE READ", never "none". The
reader is late-bound to the real `CommitmentTracker.getActiveByTopicId`.
`--resume` mechanics are unchanged (same-framework switches already reattach the
transcript; the injected instruction was what stopped the session).

## Decision-point inventory

- `classifyCandidate` ownership filter — modify — widened from branch prefix to
  prefix-or-same-repo-author; fork refused first. A filter over the trusted
  `--author @me` list; every merge gate after it is unchanged.
- `holdEligible` — modify — same ownership read.
- No-message respawn instruction — modify — removes an unconditional "do nothing";
  the session (the mind) decides within the instruction's floor.

---

## 1. Over-block

D1: a fork PR from the agent's login stays refused (deliberate) and is now visible.
A PR on a legacy projection without the new fields falls back to the namespace rule
(only an old caller; the live projection requests both). D2: no block surface.

## 2. Under-block

D1: a same-repo branch authored by the agent that someone else pushed to is admitted
— the same exposure as an `echo/` branch today; holds, mergeability, the verify
record / green rollup, CODEOWNERS routing, the independent second-pass requirement
and safe-merge's act-time checks all still run. D2: the session can misjudge
"in flight"; bounded by the reconcile rules and by idempotent downstream paths
(safe-merge refuses a merged PR; the relay drops exact duplicates; commitment
delivery is a status transition).

## 3. Level-of-abstraction fit

D1 fixes the proxy at the one helper all ownership reads share (and closes the
sibling in `holdEligible`). D2 changes the instruction at the single builder of the
no-message bootstrap; resume mechanics live elsewhere and are untouched.

## 4. Signal vs authority compliance

Compliant. D1 widens a filter and adds a visibility signal (audit line + count, no
attention item); it gains no blocking authority, and merge authority stays with
the existing gates and safe-merge. D2 removes a brittle instruction that had
de-facto authority to halt work and hands the decision to the session's judgment.

## 4b. Judgment-point check

The ownership filter is an invariant over GitHub facts (author login, cross-repo
flag), not a competing-signals point. The continuation is a judgment point: arbiter
= the new session; floor = only work already stated or an open resumable
commitment, later stop wins, check-before-act, silent wait as the conservative
default.

## 5. Interactions

- Local verify: the agent's other-prefix PRs now get verify runs requested (intended;
  ~45 min each, one at a time, bounded by the existing queue cap + dedupe).
- Red-PR watchdog now also watches the agent's other-prefix PRs (intended; same
  dedup).
- Namespace-mismatch attention now fires only when no listed PR is owned (e.g. all
  forks); its text names both rules.
- Triage respawns (`StallTriageNurse`, `TriageOrchestrator` `auto_restart`) and the
  topic-profile switch reach the new instruction; dashboard `silentStart` does not.
- No double-fire: the instruction is built once per spawn.

## 6. External surfaces

`GET /green-pr-automerge` gains two non-optional fields (additive). One more audit
event kind. The list call requests two more gh fields (both in the pinned
`GH_PR_JSON_FIELDS`, test-enforced). A respawned session may now act (e.g. merge a
PR it promised) where it used to wait; it is told not to narrate the switch.

## 7. Multi-machine posture (Cross-Machine Coherence)

D1: machine-local BY DESIGN, unchanged — the watcher runs only on the serving-lease
holder and keeps its state there; `notAgentOwned` is rebuilt from GitHub every tick,
so a lease move loses nothing and there is one voice. D2: the instruction is built
on the spawning machine from its commitment store (commitments already replicate via
the existing sync path); no new durable state, notices or URLs.

## 8. Rollback cost

Revert the commit and ship a patch. No migration; `notAgentOwned` is an optional
additive state field; the CLAUDE.md line is harmless if left behind.

## Conclusion

Review produced: fork check before both arms, `holdEligible` widened, commitments
split into resumable / waiting-on-user, unreadable commitments not shown as none,
reconcile-before-resume rules, bounded hung-step retry. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Independent read of the artifact: concur**

Concur with the review. The fork check precedes both rules, the author rule needs an
explicit same-repo flag and a matching non-empty login over the `--author @me` list,
every former call site (and `holdEligible`) uses the same `expectedGhLogin`, and all
later gates still run; `notAgentOwned` is rebuilt per tick and audited once per head.
D2 distinguishes "could not be read" from "none", is late-bound to the real tracker,
fences untrusted text with inner fences neutralised, and its check-before-acting rules
keep triage and switch respawns from repeating work. The `n/a` class-closure
declaration is honest: no self-triggered controller is added.

---

## Evidence pointers

- `tests/unit/merge-line-author-eligibility.test.ts` (12), `tests/unit/handoff-continuation.test.ts` (8),
  `tests/unit/topic-profile-server-wiring.test.ts` (updated),
  `tests/unit/PostUpdateMigrator-mergeRunnerAutoArm.test.ts` (+1),
  `tests/integration/green-pr-automerge-routes.test.ts` (+1),
  `tests/e2e/merge-line-author-eligibility-lifecycle.test.ts` (production wiring, 200).
- Spec + convergence report: `docs/specs/merge-line-author-eligibility-and-handoff-resume.md`.

---

## Class-Closure Declaration (display-only mirror)

- `defectClass: unbounded-self-action`, `closure: n/a` — reason: no self-triggered
  controller is added or modified. D1 widens a candidacy filter on the existing
  watcher (its tick cadence, breaker and single-flight are unchanged); D2 changes
  the text injected into a respawn that existing callers already trigger, adding no
  new respawn/spawn/notify/retry emit.
- The D2 prompt defect (an unconditional "wait silently" that dropped in-flight work)
  matches no registered class in `docs/defect-classes.json`; its guard here is the
  unit contract test `tests/unit/handoff-continuation.test.ts` (the instruction can
  no longer say "wait silently" unconditionally) plus the wiring test.
