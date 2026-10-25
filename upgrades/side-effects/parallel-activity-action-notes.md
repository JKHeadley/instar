# Side-Effects Review — Parallel-session awareness: action-derived activity notes + verifiable overlap sentinel (CMT-810)

**Version / slug:** `parallel-activity-action-notes`
**Date:** `2026-10-14`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent (required: the change touches a sentinel + guard-posture)`

## Summary of the change

Two confirmed defects behind the 2026-10-14 incident where two sessions of the same agent gave the operator opposite advice about the same Mac Studio restart. (1) `GET /parallel-work/activities` was a pure read over conversational topic-intent refs, so a session's ACTIONS never entered it — topic 102965's row read a 14:13 goal while it asked for a restart approval at 14:34 and for two hours after. (2) `ParallelWorkSentinel` was `on-unverified` / `not-instrumented` in `GET /guards` forever.

Files: `src/core/action-claim.ts` (new `classifyApprovalRequest`, `excerptAround`), `src/core/TopicActionNoteStore.ts` (new durable per-topic note store), `src/core/ParallelActivityIndex.ts` (reads notes: focus/tags/updatedAt/`lastAction`, unions note-only topics), `src/monitoring/ParallelWorkSentinel.ts` (tick counters, `guardStatus()`, `stats()`), `src/monitoring/guardManifest.ts` (`expectRuntime: true`, `expectedTickMs` 15 min), `src/server/AgentServer.ts` (constructs the store, threads it into the index, registers the guard getter, early first tick), `src/server/routes.ts` (note written from the two observe paths; `GET /parallel-work/sentinel`), `src/core/types.ts`, `src/config/ConfigDefaults.ts`, `src/core/PostUpdateMigrator.ts` (config + CLAUDE.md migrations), `src/scaffold/templates.ts`, `src/server/CapabilityIndex.ts` (endpoint + awareness entry), tests in all three tiers, spec amendment + ELI16 addendum.

## Decision-point inventory

- `classifyApprovalRequest` (`src/core/action-claim.ts`) — add — a DETECTOR: classifies a finished turn as an operator-approval request. Output: a note in a read-only index. No block/allow.
- `recordParallelActivityNote` (`src/server/routes.ts`) — add — writes a note on classification; runs before and independent of every commitment-lane decision; never alters a response other than adding an `activityNote` field.
- `ParallelActivityIndex.deriveFocus` — modify — a note newer than the latest goal/decision ref becomes focus. Read-side ranking only.
- `ParallelWorkSentinel.tick` — modify (pass-through) — the overlap decision is unchanged; counters are recorded around it.
- Guard-posture grading of `monitoring.parallelWorkSentinel.enabled` — modify — now graded from a real runtime getter (on-stale → on-confirmed) instead of `not-instrumented`. Observability only.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The closest analogue is a FALSE NOTE: a turn classified as an approval request that was not one. A false note puts a wrong focus line in a read-only index for up to 24h; it opens no commitment and sends nothing — but in THIS incident's shape it would invert a topic's position (a hold-off session shown as "asked to approve: restart"), so precision matters. **The second-pass review found exactly that:** the first draft's bare `safe/clear/ok to <verb>` lead fired on "It is not safe to restart the Studio yet; I would hold off" (topic 61449's actual advice) and on "You are clear to restart whenever you like"; the bare `approve/confirm the <noun>` lead fired on "I can confirm the restart finished cleanly" and "Only the operator can approve a restart". Fixed before commit: every lead is now either first-person interrogative ("may I", "should I", "mind if I", "is it safe to"), an explicit ask of the addressee ("do you want me to", "please approve the", "I need your approval for"), or a bare permissive phrase that counts ONLY when the sentence is a question ("Ok to restart the Studio?", "Approve the rollback?"); a negation within the sentence ("not/never ok|safe to <verb>") is rejected; past tense and quoted text are rejected. All six review strings are in the negative test list. Round 2 of the review named two more shapes — "You do not need me to restart anything" and "Please confirm the restart completed" (a verification ask, not an approval ask) — both fixed before commit (negated-ask guard; `confirm` rejected when the sentence carries completion words) and added to the negatives. Remaining false-positive shape: a rhetorical question ("Should I really restart it? No.") — accepted; it reads as a pending restart for the same session, which is the safe direction for a sibling to see.

---

## 2. Under-block

Misses: a request phrased without a verb in the set ("may I proceed with the plan?"), a request inside a code block or quoted text (intentionally skipped), an approval request made by a NON-Claude framework whose Stop hook does not post to the observe route (the hook is Claude-only today), and an approval request made on an agent where `actionClaim.enabled` is off (the Stop hook exits before posting — fleet posture, stated in the PR). Also: the index is machine-local, so a sibling session on ANOTHER machine reads this via `?scope=pool`; the pool composer (`buildPoolActivityView`) rebuilds local rows field-by-field, so `lastAction` was added to its `LocalActivityRow` projection explicitly (ISO `at`) and is tested to cross — review concern #2 corrected. Remote (replica-derived) rows still carry no focus/tags/lastAction, as before: another machine's topics show as running-or-not with their last lifecycle event, never their action note.

---

## 3. Level-of-abstraction fit

Right layer. The detector reuses the EXISTING action-claim observer (already running on every finished turn on this agent) rather than a new hook; the store is a sibling of the topic-intent files it sits beside; the index remains the single cross-topic read. Alternative considered and rejected: writing the note INTO `TopicIntentStore` as a goal/decision ref — rejected because refs carry a confidence/decay model and feed the session briefing's intent arcs; an action note is a timestamped fact and would pollute that. A second alternative — a separate "awareness" hook — rejected as a duplicate detector (convergence rule in the parent spec).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Both classifiers are brittle regex DETECTORS whose only output is a note in a read-only index consumed by (a) any session that reads `GET /parallel-work/activities` and (b) the overlap councilor, which itself only emits an in-process nudge event. Nothing here gates, blocks, filters, or rewrites a message, a send, or a session.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The one ranking rule added (a note newer than the latest goal/decision ref wins focus) is a pure recency ordering over timestamps, not a judgment among conflicting live signals: the index reports BOTH (focus + `lastAction` + the refs' tags) and a reader sees all of it. The classifier is a detector, not a decision.

---

## 5. Interactions

- **Shadowing:** `recordParallelActivityNote` runs BEFORE the action-claim `enabled` check and the commitment lanes; it cannot shadow them (it only returns a value folded into the response) and they cannot shadow it (confirmed by the integration test where `feature-disabled` still carries a written note).
- **Double-fire:** the same turn can reach BOTH `/action-claim/observe` (the action-claim Stop hook) and the completion-claim observer (`registerUnifiedFutureClaims`). The store dedupes an identical (kind, verb, excerpt) note within 10 min, so one turn yields one note (tested).
- **Races:** per-topic file write is tmp+rename (atomic on POSIX). Two concurrent writers for the same topic could interleave read-modify-write and drop one note; the consequence is a missed note, never a corrupt file (the next read validates entries).
- **Feedback loops:** the councilor now sees action-derived tags, so two topics acting on the same object ("mac-studio") can be nudged as overlapping — this is the intended signal. Containment is unchanged (pair cooldown + hysteresis + `requireRunning`). On a dev agent the nudge is an in-process event with no listener wired, so the operator sees nothing new.
- **ParallelWorkSentinel.tick now re-throws after recording** — same contract as before (callers already wrap it in try/catch); the recorded `lastError` is new observability.

---

## 6. External surfaces

- Other agents / users / external systems: none. No Telegram/Slack/GitHub traffic.
- Persistent state: NEW `{stateDir}/topic-action-notes/<topicId>.json` (≤20 notes × ≤200 chars each; bounded; tmp+rename writes; `.tmp` files are ignored by `listTopicIds`). Not registered anywhere else; delete the directory to reset. Minted NEGATIVE (Slack) conversation ids are admitted (the observe route already accepts them), so a note-only Slack conversation appears in the index with `refCount: 0` — intent enumeration admits only positive ids; this is additive visibility, not a conflict.
- Response shape: `POST /action-claim/observe` responses gain an `activityNote` field (null | `{kind, verb, deduped}`); `GET /parallel-work/activities` rows gain `lastAction`; new `GET /parallel-work/sentinel`. Additive only — existing fields unchanged (existing route tests pass unmodified).
- Timing: the early first tick (30s after boot, unref'd) reads the index once; cost is a directory read.
- **Operator surface (Mobile-Complete):** no operator-facing actions are added. The off switch is a config key; the read surfaces are Bearer-auth routes consumed by the agent. "No operator-facing actions" — valid.

---

## 6b. Operator-surface quality

No operator surface — not applicable (no dashboard/approval/form files touched).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**, matching the topic-intent files the index already reads: a topic's session runs on exactly one machine (the owner), its Stop hook posts to that machine's server, and the note lands beside that machine's intent state. The pool-wide question is answered by the EXISTING proxied-on-read `GET /parallel-work/activities?scope=pool`, which composes local rows (now carrying `focus` derived from the note and `lastAction`) with replica-derived remote rows. On topic transfer the note file stays on the old machine (same as intent refs today) — the receiving machine's row for that topic starts fresh from its own observations; nothing strands because the note is advisory awareness, not durable state anything depends on. No user-facing notices are emitted (no one-voice gating needed). No URLs generated.

---

## 8. Rollback cost

Pure code change plus one additive config key and one bounded state directory. Revert and ship a patch; set `parallelWork.actionNotes.enabled: false` (read live) for an instant per-agent kill; the `topic-action-notes/` directory can be deleted with no other state referencing it. The manifest flip (`expectRuntime: true`) reverts with the code. No user-visible regression during rollback (the operator sees nothing from this feature).

---

## Conclusion

The review confirmed the shape: detectors write a note; the index and councilor read it; nothing gains authority. Two design changes came out of writing it: (1) the note is written BEFORE the action-claim `enabled` check so awareness never depends on the commitment lane; (2) an approval REQUEST outranks a CLAIM within the same turn when choosing the note kind, because "asked the operator to approve a restart" is the fact a sibling session needs. Honest limits stated: notes are written only where the Stop hook posts (Claude sessions, `actionClaim.enabled` on), and the posture row reads `on-stale` honestly if an operator sets a cadence above 75 min. Clear to ship.

---

## Second-pass review (required — sentinel + guard-posture)

**Reviewer:** independent reviewer subagent, 2026-10-14 16:54 PDT — read the artifact, the full diff, `TopicActionNoteStore.ts`, `docs/signal-vs-authority.md` and the spec amendment independently.
**Independent read of the artifact: concern (round 1) → resolved (round 2)**

Round 1 — verified and agreed: no blocking authority added (`recordParallelActivityNote` only folds a value into the JSON body; every early-return in `/action-claim/observe` keeps its original status/reason); the store never throws; both `tick()` callers are try/catch-wrapped; the early first tick is cleared in `stop()`; the GuardRegistry registration callsite exists so `expectRuntime: true` is honest; per-topic files are bounded; the observe/`registerUnifiedFutureClaims` double-fire is covered by the dedupe. Concerns raised:
- **#1 (material):** the bare `ok/safe/clear to <verb>` lead and bare `approve/confirm the <noun>` lead fired on statements — "It is not safe to restart the Studio yet; I would hold off" (the 61449 position), "You are clear to restart whenever you like", "I can confirm the restart finished cleanly", "Only the operator can approve a restart". **Resolution:** leads restricted to interrogative / explicit-request shapes, bare permissive phrases require a question mark, negation guard added, all strings added to the negative tests (§1 rewritten).
- **#2 (artifact honesty):** the pool composer rebuilds local rows field-by-field, so `lastAction` was being dropped, not "passed through". **Resolution:** `lastAction` added to `LocalActivityRow` and projected with an ISO `at`; unit test asserts it crosses (§2/§7 corrected).
- **#3 (minor):** note-only negative (Slack) ids appear with `refCount: 0`. **Resolution:** stated in §6.

Round 2 (re-verification against the refreshed worktree, 2026-10-14 17:00 PDT) — **Concur with the review.** The reviewer re-ran all four round-1 strings plus "Got your approval for the restart at 14:41" through the shipped classifier (all `false`) and the incident positives (still fire); confirmed `lastAction` is projected on `LocalActivityRow` with an ISO `at`; confirmed no blocking authority was gained and the earlier verifications still hold. Two advisory residual shapes were named ("You do not need me to restart anything"; "Please confirm the restart completed") — applied before commit, see §1.

---

## Evidence pointers

- Unit: `tests/unit/action-claim-approval-request.test.ts`, `tests/unit/topic-action-note-store.test.ts`, `tests/unit/parallel-activity-index-action-notes.test.ts` (replays the 14:13 → 14:34 → 16:19 timeline), `tests/unit/parallel-work-sentinel-instrumentation.test.ts`, `tests/unit/PostUpdateMigrator-parallelActionNotes.test.ts`.
- Integration: `tests/integration/parallel-work-action-notes-route.test.ts` (observe → activities round-trip; kill switch; dedupe; scrub; `/parallel-work/sentinel`; `/guards` on-stale → on-confirmed).
- E2E: `tests/e2e/parallel-work-action-notes-lifecycle.test.ts` (real `AgentServer` boot: store wired, 200 not 503, GuardRegistry registration, on-confirmed after a tick, source callsite pin).
- Spec amendment: `docs/specs/parallel-activity-coherence.md` → "Amendment 2026-10-14"; ELI16 addendum in the companion.
- Ratchets: `tests/unit/no-silent-fallbacks.test.ts` counted the five new fail-safe catches (store record/notes/listTopicIds, index safeLatestNote, route recordParallelActivityNote); each carries an in-brace `@silent-fallback-ok` naming why the degraded outcome (a missed note) is the honest one. `lint-bounded-judgment-input` is satisfied with an inline `bounded-input-reviewed` note on the 16KB clamp (regex classifiers, never a prompt).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.

**Self-action class — explicit NEGATIVE declaration** (mirrors the trace): `defectClass: unbounded-self-action`, `closure: n/a`, `reason:` No self-triggered action is added. The commit-gate detector matched regex pattern LITERALS in the approval-request verb table (`'restart(?:ing|s)?'`, `'kill(?:ing|s)?'` in `src/core/action-claim.ts`), not calls. The only new timer is a one-shot early tick of the EXISTING read-only `ParallelWorkSentinel` 30 s after boot (cleared on `stop()`); its overlap-nudge emit and containment (pair cooldown + hysteresis) are unchanged, and the new `TopicActionNoteStore` is written per observed turn, never on its own cadence.
