# Side-Effects Review — Mentor active task-driving (onboarding agenda)

**Version / slug:** `mentor-active-task-driving`
**Date:** `2026-05-29`
**Author:** Echo (instar developer agent)
**Spec:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (2026-05-29 amendment — in-scope)
**Second-pass reviewer:** required (changes mentor decision behaviour + replaces the getSurface stub)

## Summary of the change

The Framework-Onboarding Mentor's Stage-A `getSurface` was a stub returning an empty surface, so the mentor was blind and could only ever `observe-only` / produce a generic check-in. This adds an optional onboarding agenda (the mentor's own backlog of capability checks + starter dev tasks) and replaces the stub with a real surface (the mentee's recent replies + the agenda + timing), so an idle mentee gets a concrete next task via the already-existing `assign-next` action — the active task-driving pattern that proved high-signal while dogfooding Codey.

Files touched:
- `src/monitoring/MentorStageA.ts` — `ConversationSurface.onboardingAgenda?`; `surfaceText` includes it (leak-legitimacy); `buildStageAContext` adds an agenda block + assign-next steering ONLY when an agenda is present; new pure `buildConversationSurface()` + `parseMenteeReplies()` (+ `MenteeReplyLine` type).
- `src/scheduler/MentorOnboardingRunner.ts` — `MentorConfig.onboardingAgenda?`.
- `src/server/AgentServer.ts` — `getSurface` now builds the real surface; new `readRecentMenteeReplies()` thin glue (read `mentor-replies.jsonl` → `parseMenteeReplies`).
- `tests/unit/MentorStageA.test.ts` — agenda-in-prompt (present/absent), agenda leak-safety, `buildConversationSurface` (formatting/cap/empty), `parseMenteeReplies` (defensive parsing/filter/throw-safety).

Decision-point inventory: one — the Stage-A action choice (`unblock|answer|assign-next|observe-only`). This change adds CONTEXT (agenda + real conversation) to that LLM decision and steers it toward `assign-next` when idle-with-agenda; it does not add a new authority or a new deterministic gate. The two-hats boundary (empty tool grant, surface-only, leak detector) is unchanged.

---

## 1. Over-block

No allow/deny surface. The change makes the mentor produce a *more useful* action (assign a concrete task) rather than a hollow check-in. Nothing legitimate is newly rejected. The leak detector is unchanged and now correctly treats agenda-derived tasks as legitimate (they're in `surfaceText`).

---

## 2. Under-block

- **Agenda rotation without the mentor's own prior prompts.** The surface feeds the mentee's *replies* but not the mentor's own prior prompts (their content isn't logged today; `a2a-sent.jsonl` is metadata-only). So the LLM infers "what's already been assigned" from the mentee's replies — imperfect if replies are terse. Mitigated by: (a) the mentor-outstanding tracker blocks a new send while a prompt is unreplied (no back-to-back dupes), and (b) the feature ships dark, so rotation quality only matters after deliberate opt-in. Logging sent-prompt content is a scoped follow-up (named in the spec).
- **Leaky agenda content.** If an operator puts an internal-looking ref (a source path / PR#) into an agenda item, it's in `surfaceText` so it won't trip the leak detector — but that's the operator's deliberate choice (the agenda is the mentor's plan), not an internal leaking in. Acceptable.

---

## 3. Level-of-abstraction fit

Right layers: the agenda + prompt logic live in the surface module (`MentorStageA`, pure + tested); the config field on `MentorConfig`; the file-read glue on the server. The pure functions are extracted specifically so the logic is unit-testable without file IO.

---

## 4. Signal vs authority compliance

The mentor's Stage A is an LLM acting AS the user — it produces a SIGNAL (a suggested next message), never an authority over the mentee. This change only enriches the signal's context (agenda + conversation). No authority moves; the empty-tool-grant + leak-detector boundary is intact. Compliant with `docs/signal-vs-authority.md`.

---

## 5. Interactions

- **MentorOnboardingTick / Runner.** Unchanged control flow — they still call `getSurface` → `spawnStageA(buildStageAContext(surface))`. The surface is just no longer empty.
- **Two-hats leak detector.** `surfaceText` now includes the agenda, so agenda-derived task references are legitimate (tested). No weakening of the detector for non-surface internals.
- **mentor-outstanding tracker / deliverToMentee.** Unchanged; still gates back-to-back sends.
- **Dark-by-default.** Mentor `enabled:false`/`mode:'off'` by default AND empty agenda by default — two independent gates. No agent gets new behaviour without an operator setting both.

---

## 6. External surfaces

No new HTTP route, so no Tier-2 route / Tier-3 alive test applies (the standard's route-liveness tier targets API features; this is internal mentor behaviour). No `PostUpdateMigrator` config migration needed: `onboardingAgenda` is OPTIONAL — absent → unchanged behaviour, so existing agents need no patch. No CLAUDE.md template change: the mentor is an operator-configured internal job, not an agent-surfaced conversational capability. Observable effect (only after opt-in): an enabled mentor with a populated agenda hands an idle mentee concrete tasks instead of generic check-ins.

---

## 7. Rollback cost

Revert the `onboardingAgenda` field + the `buildStageAContext` agenda block + the `getSurface` builder (back to the empty-surface stub) + the new pure helpers/tests. One feature, code-only, no state/migration/contract. Reverted-to state = today's passive mentor. ~10 minutes.

---

## Second-pass review

**Concern:** Does replacing the empty-surface stub with real file reads risk throwing into the mentor tick? No — `readRecentMenteeReplies` is best-effort (missing/unreadable/garbled file → `[]`), and `parseMenteeReplies` skips malformed lines and never throws (tested). Worst case the surface shows "(no prior conversation)" — the prior stub's behaviour.

**Concern:** Does this change behaviour for existing agents on upgrade? No — double-gated (mentor off by default + empty agenda by default). The prompt is byte-identical to before when no agenda is set (M5).

**Concurrence:** Core logic is pure + unit-tested on both sides of the decision boundary (agenda present vs absent; replies present vs empty; well-formed vs garbage), the server change is thin tested-glue, it ships dark, and rollback is code-only to a strictly-unchanged state. The one real limitation (no sent-prompt history) is named in the spec as a follow-up and is acceptable for a dark feature. Concurred.
