# Side-Effects Review — Topic-profile framework swap: the kill that never killed

**Version / slug:** `topic-profile-kill-by-tmux-name`
**Date:** `2026-08-27`
**Author:** `Echo`
**Second-pass reviewer:** `required (session lifecycle: kill / respawn)`

## Summary of the change

A topic-profile framework/model swap kills the running session and respawns it so
the new pin is read at launch. Both kill ports in the `server.ts` composition root
(`killForResume`, `killFresh`) were wired to `sessionManager.killSession(...)`,
which resolves BY SESSION ID — but `listTopicSessions()` supplies the session's
TMUX NAME. The lookup missed, `killSession` returned `false`, and nothing was
killed. `TopicProfileOrchestrator.executeRespawn` discarded that boolean and
spawned anyway; the spawn path found the old session still alive and injected the
handoff bootstrap into it instead of launching a new one. The framework never
changed, and the orchestrator wrote `respawn-applied` to the audit trail.

Observed live on topic 60487 (2026-08-27): pin resolved `codex-cli`, session stayed
`claude-code`/`claude-opus-5` with its original tmux creation time, audit line
`respawn-applied` at 01:37:49Z, and the user-facing handoff notice honestly named
the framework it landed on ("Claude door") while the audit called it applied.

Files touched:
- `src/commands/server.ts` — both orchestrator kill ports, plus one identical
  name-into-`killSession` defect in the `restart sessions` conversational command.
- `src/core/TopicProfileOrchestrator.ts` — honor the kill boolean (abort + restore
  on failure), new `kill-failed` failure class (breaker-attributable), and a
  requested-vs-applied framework truth check on the success claim.
- `tests/unit/TopicProfileOrchestrator.test.ts` — 4 new tests + a `killResult`
  harness control.
- `tests/unit/topic-profile-server-wiring.test.ts` — 1 new composition-root test.

## Decision-point inventory

- `TopicProfileOrchestrator.executeRespawn` kill step — **modify** — the kill's
  return value now gates whether the respawn proceeds. Previously ignored.
- `TopicProfileOrchestrator.executeRespawn` success claim — **modify** — the
  `respawn-applied` audit line is now conditional on the spawned framework matching
  the resolved pin; a mismatch writes `respawn-profile-mismatch` instead.
- `BREAKER_ATTRIBUTABLE` set — **modify** — adds `kill-failed`, so a persistently
  unkillable session settles at the threshold instead of retrying every idle window.
- `SessionManager.killSession` / `killSessionByTmuxName` — **pass-through** — no
  change to either; the fix is calling the correct one.
- Kill *eligibility* (protected sessions, idle re-confirm, autonomous-run consult,
  stagger cap, switch-now confirm) — **pass-through, untouched**. This change acts
  only after those gates have already said yes.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The one real over-block risk: `killSessionByTmuxName` returns `false` both when the
kill fails AND when no *running* session carries that tmux name — including the
benign case where the session died on its own between `getSessionForTopic()` and the
kill. Under the new code that aborts the respawn, where the old code would have
spawned (correctly, since nothing was alive to inject into).

Assessed as safe, and deliberately chosen: the abort is a deferral, not a refusal.
The respawn is level-triggered on `pin != last-applied`, so the next cycle re-enters
with no session present and takes the existing `respawn-skipped: session-gone` path,
which is the correct handling. Cost is one cycle of latency in a rare race; benefit
is that the far more common failure (session alive, kill refused) can no longer
produce a false "applied".

No message, no user input, and no user-facing action is blocked by this change. The
`restart sessions` command now actually kills the stale sessions it already claimed
to have cleaned up — strictly closer to its advertised behavior.

---

## 2. Under-block

**What failure modes does this still miss?**

- **A kill that returns `true` but does not take.** `killSessionByTmuxName` resolves
  against the state record (status `running`) and `killSession` is defensive about a
  pane that is already gone, so a wedged tmux pane that survives `kill-session` would
  still report success. The requested-vs-applied framework check is the backstop
  here: the subsequent spawn would report the old framework and be recorded as a
  mismatch rather than as applied. It is caught, but one layer later.
- **Model, thinking-mode, and effort mismatches are not truth-checked.** Only
  `framework` is compared. Framework was chosen because it is the axis with an
  unambiguous applied value reported by the spawn; model can legitimately differ
  from the pin (tier resolution, account default) and comparing it would generate
  false mismatches. A model pin that silently fails to apply is still not detected.
- **The mismatch check cannot distinguish "the swap broke" from "the pinned CLI is
  not installed and the spawn legitimately fell back."** Both record a mismatch.
  That is the honest record in both cases (the pin was in fact not applied), but the
  audit line is a prompt to look, not proof of a defect.

---

## 3. Level-of-abstraction fit

Correct layer, and the change is specifically a move *toward* the existing right
primitive rather than a new one.

`killSessionByTmuxName` already exists in `SessionManager` for exactly this purpose;
its own comment names the failure mode ("the stop that does not stop") and states
that it exists so name→id resolution lives in one place. That helper was introduced
for the emergency-stop path after the identical bug; the topic-profile path was
written without it. The fix uses the existing primitive instead of re-implementing
resolution at the call site — three call sites now route through the one resolver.

The kill-boolean check belongs in the orchestrator (it owns the respawn sequence and
is the only layer that can meaningfully abort it), not in `SessionManager` (which
correctly reports outcomes and does not know what the caller intends to do next).

The framework truth check belongs where the requested and applied values are both in
hand, which is the same function. Pushing it lower would require `SessionManager` to
know about pins; pushing it higher would put it after the audit line it is meant to
gate.

---

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] **No** — this change produces a signal consumed by existing machinery; the one
  new control-flow decision is a deterministic read of an existing function's return
  value, not a heuristic.

Two things were added and they sit on opposite sides of this line deliberately:

**The kill-boolean check is control flow, not a detector.** It does not infer, guess,
or pattern-match. It reads the documented return value of the function it just
called. Acting on a function's own reported outcome is the base case of correct
code, not an authority claim. Its authority (abort the respawn) is exactly scoped to
the operation that failed.

**The framework mismatch check is deliberately signal-only.** It is a string equality
between the requested framework and the framework the spawn reports. It does not
block, delay, rewrite, kill, or retry. It changes which line is written to the audit
log. The temptation was to give it teeth — trip the breaker on mismatch — and that
was rejected: a legitimate spawn-time framework fallback would then be punished by a
brittle equality check holding blocking authority. The disclosure to the user was
already truthful and is unchanged; only the internal bookkeeping was lying, and only
the bookkeeping is corrected.

The one place authority WAS added — `kill-failed` in `BREAKER_ATTRIBUTABLE` — is
authority over the *retry loop*, not over the user's work, and it exists to bound
the loop (see 4b). Its consequence (park the pin, revert, notify the operator) is
the pre-existing breaker behavior, not new machinery.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.**

Neither addition weighs competing live signals. The kill check reads one boolean
from one call. The mismatch check compares two enum values that are both known
facts at that moment. Neither is a place where work evidence, liveness, recency, or
urgency could conflict — the decision is an invariant: *a respawn that did not
respawn is not applied*.

The `kill-failed` breaker attribution is a bounded-retry guard on a self-triggered
control loop, which the **Capacity Safety — No Unbounded Self-Action** standard
requires be convergent rather than judgment-based. Its convergence argument:

- **Control-loop edge:** `pin != last-applied` triggers a respawn attempt, gated by
  the existing debounce, idle re-confirm, and stagger cap.
- **Steady-state bound:** each attempt that fails at the kill increments the breaker
  counter. At `spawnFailureBreakerThreshold` (default 3) the breaker trips. The
  action count is therefore bounded by the threshold per pin change and does NOT
  scale with the horizon — an unkillable session cannot produce unbounded kill
  attempts.
- **Settling brake:** the trip parks the pin, reverts to last-known-good, un-parks
  the surviving framework's resume entry, and notifies the operator. The loop
  terminates in a declared, loud state rather than quiescing silently.

Before this change the failed-kill path did not exist at all (the boolean was
discarded and the loop always "succeeded"), so this is the first bound on it.

---

## 5. Interactions

- **Shadowing:** the kill-boolean abort runs *after* every existing eligibility gate
  (protected-session check, idle re-confirm at kill time, autonomous-registry
  consult, stagger cap, switch-now confirm) and before the spawn. It cannot shadow
  those — they have already run and returned yes. It does shadow the spawn step,
  which is the intent. Confirmed by test: `h.kills.length === 1` (the kill was
  attempted, so the gates ran) with `h.spawns.length === 0`.
- **Double-fire:** none introduced. The abort path calls `teardownSlot(key)` and
  returns, exactly as the existing failure branch does, so the slot is released once.
  It does not enqueue a retry itself — the next attempt comes from the existing
  level-triggered cycle, which is single-flighted by the slot lock.
- **Races:** the abort restores state the kill path had already mutated *before* the
  kill: for a fresh respawn it un-parks the resume entry matching `oldFramework` and
  clears the durable suppression marker. Without that restore, a surviving session
  would be left with a parked resume id and an active suppression marker it never
  earned — a strictly worse state than before the attempt. The unpark mirrors the
  existing breaker-revert path (`revertFramework === 'codex-cli' ? codexResume :
  claudeResume`). For a resume-mode kill nothing was parked, so nothing is restored.
  **This restore only works because the second-pass review removed a destructive
  call in the same path** — see the round-2 finding below. As originally written the
  restore was inert: the `killFresh` port DELETED the resume entry (`TopicResumeMap
  .remove`) rather than leaving it parked, so `unpark()` found nothing and restored
  nothing, and a session surviving a failed kill lost its resume id permanently.
- **Feedback loops:** the `kill-failed` breaker attribution closes a loop that was
  previously open (see 4b). It shares the counter with the existing spawn-failure
  classes, so a topic mixing kill failures and launch failures trips sooner. That is
  correct — both mean "this pin will not apply."
- **Adjacent cleanup:** `killSessionByTmuxName` resolves against the state record
  rather than a live tmux probe, so a session the reaper is concurrently terminating
  still resolves and the kill reconciles the record. No new race with the reaper.

---

## 6. External surfaces

- **Other agents / install base:** no interface change. `ProfileSpawnFailureClass`
  gains a member; it is an internal union with no serialized consumer outside the
  orchestrator and its audit log.
- **External systems:** none. No Telegram, GitHub, Cloudflare, or network surface.
- **Persistent state:** two new audit line types in `logs/topic-profile-changes.jsonl`
  — `respawn-kill-failed` and `respawn-profile-mismatch`. Append-only, structured,
  content-free (topic key, method, fresh flag, framework enums). Readers of that log
  filter by `type`, so new types are additive. `state/orchestrator-state.json` gains
  no new fields.
- **User-visible behavior:** the user-facing disclosure is unchanged in wording and
  timing. What changes is that the swap now actually happens. Users who had pinned a
  framework and been told it applied will find their sessions genuinely switching on
  the next idle window after the update — correct, but it is a real behavior change
  for anyone whose pin has been silently inert.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action
  added or changed. The existing operator paths for this feature — the conversational
  pin ("use codex here"), `/topic`, and `POST /topic-profile/:topicId` — are
  untouched and remain phone-completable.

---

## 6b. Operator-surface quality

**No operator surface — not applicable.** No dashboard renderer, markup file,
approval page, or grant/revoke/secret-drop form is staged in this change.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, with a specific reason: a session is a tmux process on
one machine's disk, and `SessionManager` can only kill what is local to it. The
orchestrator's kill and respawn are inherently operations on the machine that holds
the session, so the fix is correctly scoped to that machine. There is no coherent
meaning to "kill this session on another machine" through this path — the existing
`POST /sessions/<name>/remote-close` route is the cross-machine primitive and is
untouched here.

- **User-facing notices:** the disclosure this change gates is emitted by the
  orchestrator on the machine holding the session. Because exactly one machine holds
  a given topic's session at a time (session-pool ownership), one-voice is already
  satisfied by ownership and no additional gating is needed. This change reduces the
  notice count if anything (a failed kill no longer produces a "now driving" line
  that misdescribes an unchanged session).
- **Durable state on topic transfer:** the new audit lines are per-machine log
  entries, not carried state — the same posture as the existing lines in that file.
  The pin itself (`TopicProfileStore`) is the state that must survive a transfer and
  it is untouched by this change; the existing `TopicProfileTransferCarrier` handles
  it. A topic transferred mid-abort simply re-evaluates on the destination.
- **URLs:** none generated.

---

## 8. Rollback cost

- **Hot-fix release:** pure code change. `git revert` and ship as the next patch.
- **Data migration:** none. The two new audit line types are append-only entries in a
  log that is already read defensively by `type`; entries written before a rollback
  are inert afterward, not corrupt.
- **Agent state repair:** none required. The `kill-failed` breaker attribution can
  leave a topic's `breakerCount` elevated or a pin parked at rollback time; both are
  existing, already-handled states with an existing operator path (the cooldown
  re-apply confirm). No agent needs to be reset.
- **User visibility during rollback:** rolling back restores the previous behavior —
  pins silently not applying. That is the bug, not a new regression. No user sees a
  worse state than they had before this change shipped.

---

## Conclusion

The review produced two design changes from the initial plan. First, the framework
mismatch check was demoted from breaker-tripping to signal-only, after question 4
identified it as brittle equality holding blocking authority over a legitimate
spawn-time fallback path. Second, the failed-kill path — which initially recorded the
ambient, non-attributable `tmux` class — was given its own `kill-failed` class inside
`BREAKER_ATTRIBUTABLE`, after question 4b identified that an uncounted failure on a
level-triggered loop is unbounded self-action with no settling brake.

The scope was widened once, deliberately: the `restart sessions` command carried the
identical name-into-`killSession` defect and was fixed in the same change rather than
noted for later, per the no-deferrals rule.

The second-pass review then produced a third, load-bearing change. The `killFresh`
port called `_topicResumeMap.remove()`, which DELETES a resume entry, immediately
after the orchestrator had PARKED the same entry — redundant with the park (a parked
entry is already invisible to `get()` / `getForFramework()` / `getProvenance()`, which
is all the port's stated goal requires) and in direct contradiction of that store's
own §8 rule, "'remove' means PARK, not delete (deletion destroys the cheap
recovery)". It also made this change's own abort restore inert: `unpark()` finds no
entry and returns false, so a session that survived a failed kill would permanently
lose its resume id to an attempt that was supposed to leave it untouched — degrading
a later sentinel restart or profile respawn to a continuation with a transcript-loss
notice. The `remove()` call is deleted; the park alone carries the suppression.

The review also correctly flagged that the unit test covering the un-park was not
load-bearing: the harness's `killFresh` does not model the production port, so the
assertion held against the mock while the wiring deleted the entry underneath it.
That is now pinned at the composition root instead — a wiring test asserts the port
never calls the destructive `remove()`, verified to fail against the pre-fix source.

One finding is flagged for follow-up rather than resolved here: model, thinking-mode,
and effort pins have no equivalent truth check, so a silently-unapplied model pin is
still undetectable. That is a genuinely different problem (those axes have legitimate
resolution-time divergence from the pin, so equality is the wrong test) and is out of
this change's blast radius — it is recorded in section 2 as a known gap, not deferred
work this change was expected to carry.

Post-review addendum (CI): the branch inherited a red `Docs Coverage` check from main
(class-doc floor 54% < 55%, red on main's own latest CI run — not caused by this diff). Per the
Zero-Failure Standard it was fixed here rather than waved through: five classes in this change's
blast radius (`ModelTierEscalation`, `EscalationGovernor`, `EscalationHintStore`,
`ProfileIntentClassifier`, `ReapGuard`) received genuine site-doc coverage — a new
architecture page for the escalation trio, topic-profile feature/API sections that also document
this fix's truthful audit events, and the reap-guard keep-check story. Docs-only; no runtime
surface. Local `docs-coverage --check` passes at exactly the floor (260/842).

Clear to ship pending second-pass concurrence.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Opus), bounded 80/20 protocol — blocking
findings only, max 3 rounds, stop on a round with zero new blocking findings.

**Round 1 — CONCERN (1 blocking finding).**

- **Finding:** the abort's un-park is a no-op in the production wiring. `killFresh`
  (`src/commands/server.ts`) called `_topicResumeMap.remove()` — a hard delete —
  before the kill, so the new abort branch's `unpark()` restored nothing and a
  still-live session lost its resume UUID permanently. Reproduced concretely: topic
  on `claude-code`, pin to `codex-cli` (`fresh === true`), kill returns false (stale
  telegram binding, or a session still in `starting`), abort runs, entry is gone.
  Downstream: a later sentinel/reaper/context-wall restart can no longer `--resume`,
  and the next profile respawn degrades to `continuation` with the transcript-loss
  notice. The reviewer also showed the covering unit test was not load-bearing (the
  harness does not model the port) and that the artifact's §5 *Races* claim was
  therefore unsupported as written.
- **Resolution (applied):** `remove()` deleted from the `killFresh` port — the
  orchestrator's `park()` already satisfies the port's stated goal and is
  recoverable. Wiring test added pinning the destructive call out, verified to fail
  against the pre-fix source. Artifact §5 corrected.

**Round 2 — CONCUR.** No new blocking findings. The reviewer verified the three
questions the resolution turned on:

- **`park()` is sufficient at every read the spawn path uses.** The spawn resolves
  its resume id through a bare `_topicResumeMap.get()`, which returns `null` for a
  parked entry *before* the age and `jsonlExists` checks. A sweep of the map's whole
  read surface found the only park-blind reads (`getEntryRaw`, `getForFramework`)
  have zero production callers, so a parked entry is indistinguishable from an absent
  one at every read that exists — dropping `remove()` cannot reintroduce a
  cross-framework `--resume`. The write side is if anything safer under a park: the
  heartbeat's overwrite condition is strictly narrower against an existing parked
  entry than the always-true `!existingEntry` it saw after a delete.
- **The park-always-precedes invariant is structural, not conventional.** `killFresh`
  has exactly one caller — the orchestrator's `if (fresh)` block — with the two
  `park()` calls and `setSuppression` as the immediately preceding statements and no
  branch between them. The port is an inline literal in `orchDeps`, unreachable
  elsewhere.
- **The artifact matches the shipped diff**, including the corrected §5 claim.

Convergence: 2 rounds against a declared ceiling of 3, under the bounded 80/20
protocol the operator set for this change (blocking findings only; stop on a round
with zero new blocking findings).

The reviewer independently verified and did NOT raise: `killSessionByTmuxName`
behaves as the fix assumes; `getSessionForTopic` / `listTopicSessions` do supply tmux
names; the `kill-failed` breaker attribution is bounded (`parkAndRevert` zeroes the
counter, `recordSpawnSuccess` resets it, the abort's `teardownSlot` prevents `tick()`
re-arming, and the post-trip respawn is a single attempt) so a benign kill-false
cannot realistically drive a trip; and the mismatch path's `recordApplied` /
`clearSuppression` are correct with signal-only being the right call.

---

## Evidence pointers

- Live reproduction: topic 60487, 2026-08-27. `logs/topic-profile-changes.jsonl`
  seq `mtca7z5b.1` (write accepted, `framework: codex-cli`) followed by seq
  `mtca85yg.2` (`respawn-applied`), against `GET /sessions` still reporting
  `claude-code` / `claude-opus-5` for that topic with an unchanged tmux creation
  time and no kill line in `logs/server.log`.
- `tests/unit/TopicProfileOrchestrator.test.ts` — 4 new tests, each verified to fail
  against the unpatched orchestrator (`waitUntil timed out` — the audit event never
  appears) before passing against the fix.
- `tests/unit/topic-profile-server-wiring.test.ts` — composition-root test, verified
  to fail against the unpatched `server.ts` with the expected assertion message.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action` (the self-triggered controller arm — this
  change modifies `TopicProfileOrchestrator`'s respawn control loop and adds the
  first bound on its failed-kill edge).
- **`closure`**: `guard`
- **`guardEvidence`**:
  - `enforcementType`: `ratchet`
  - `citation`: `tests/unit/self-action-convergence.test.ts` (the class ratchet) plus
    `tests/unit/TopicProfileOrchestrator.test.ts` → "a failed kill COUNTS toward the
    breaker — the retry loop is bounded, not forever" (the controller-specific bound).
  - `howCaught`: the respawn loop's control edge is `pin != last-applied`; before this
    change a failed kill was discarded, so the edge never cleared and the loop had no
    steady-state bound — it would re-attempt on every idle window indefinitely.
    Counting the failure as `kill-failed` inside `BREAKER_ATTRIBUTABLE` bounds the
    action count at `spawnFailureBreakerThreshold` per pin change (horizon-
    independent), and the breaker trip is the settling brake: park, revert, un-park,
    notify the operator. The cited test drives a real failed kill through the respawn
    path, asserts the counter incremented, and asserts the trip parks the pin and
    discloses — proving the loop settles loudly rather than spinning.
