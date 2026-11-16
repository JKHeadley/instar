# Side-Effects Review — Chief of Staff owner-pause record

**Version / slug:** `cos-owner-pause-record`
**Date:** `2026-11-16`
**Author:** `echo (session echo-echo-topic-management-137342)`
**Second-pass reviewer:** `independent reviewer subagent (see Second-pass review)`

## Summary of the change

The owner can pause and resume a project the Chief of Staff tracks, and only the owner. The agent asks (`POST /chief-of-staff/projects/:key/pause-ask` with the owner's own cited Telegram message, checked against the logs); the owner gets one Telegram button showing their whole message; only the owner's tap on that exact message writes an immutable `owner-pause` / `owner-resume` lifecycle record. A paused project is not checked (no judge spend), restarted, redirected or revived; the execution protocol refuses an action for it inside the conversation lock; the note lists it as "Paused by you"; the dashboard Needs-you list skips it. The store now keeps lifecycle events it doesn't know (counted by name in the status) instead of rejecting them. Spec: `docs/specs/cos-owner-pause-record.md` (converged, 6 rounds; approved by echo-chief-of-staff as maintainer). Tier 2. About 12 files. Effort: 6 spec rounds (one real redesign in round 1), one implementation pass.

Files: `src/core/ChiefOfStaffStore.ts`, `src/core/ChiefOfStaffLoop.ts`, `src/core/ChiefOfStaffActionProtocol.ts`, `src/core/cosOwnerPauseSource.ts` (new), `src/messaging/TelegramAdapter.ts`, `src/server/AgentServer.ts`, `src/server/routes.ts`, `src/server/CapabilityIndex.ts`, `src/commands/server.ts`, `dashboard/console/needs-model.js`, `src/data/awareness/chief-of-staff-owner-pause.md` (new), tests (unit, integration, e2e).

## Decision-point inventory

- Ask source floor (may the agent ask at all): exact logged-record fields; refuses with a named reason. Gates only whether the owner is asked.
- The pause itself: the owner's Telegram callback (`from.id === getVerifiedOwner()`, unchanged) on the exact chat/message of a server-written ask.
- Fold: newest owner tap wins by record HLC; one ask (askId) decides once.
- Loop skip / execution fence / no-respawn: read the owner's recorded pause.

## 1. Over-block

- An owner request made outside Telegram (Slack, the app with no `human` verdict, voice) cannot be turned into an ask: refused with a named reason. Tracked: fb-0ac4fffb-148 (device-signed app control).
- An owner who edits the cited message before tapping is refused and asked again (recorded words must still verify).
- A pause ask for a closed project is refused (resume of a closed, paused project is allowed).
- Open asks are lost if Telegram polling moves to another machine before the tap; the tap answers "no longer applies" and the agent asks again.

## 2. Under-block

- An action that passed the in-lock check before the pause reached the ownership machine's fold may start (replication latency, seconds). Every later check, restart and respawn is fenced; the owner is told work under way may finish.
- Older machines (pre-this-build) reject the new record, freeze their Chief of Staff stream from that peer until they update, and keep acting without the pause. Warned in the ask ("Not enforced on X until it updates"); the tolerant validator stops this recurring for later additions.
- A hostile process with shell access on a paired machine can write the journal or the asks file directly (true of every Chief of Staff record).
- Pre-existing, not widened here: while the lifeline's secret check on the internal Telegram callback route is not active (or bypassed), a session holding the bearer token could post a forged owner tap there; the chat and message ids it would need are in the machine-local `cos-pause-asks` state. The same path already reaches Unpark / Confirm-done.
- At tap time a cited message that now reads `not-found` or `identity-unverified` counts as "could not look", not "changed", so the tap still records: the tap itself proves the owner's current intent (spec §3.2).
- Runs the owner started themselves are not affected (stated in the ask).

## 3. Level-of-abstraction fit

The authority sits where the Chief of Staff's existing owner taps already sit (the Telegram adapter's owner check feeding `ownerTap`); the record rides the existing immutable lifecycle event family; the attribution resolver is reused for the source floor rather than re-implemented. The execution fence is in the action protocol's existing lock, next to its other execution checks.

## 4. Signal vs authority compliance

Required reference: docs/signal-vs-authority.md. The only blocking checks are exact-fact comparisons against logged records (hard-invariant validation: who sent a logged message, whether a person wrote it, whether text matches) and the owner's own tap. No brittle heuristic holds authority; no LLM is involved. The ask floor is a display-honesty gate (a "you wrote" must be the owner's words), not an approval.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point is added. Round 1 considered a model judge for "does this message mean pause this project now"; it was removed because a fresh owner tap answers that question exactly.

## 5. Interactions

- `planDue`/`derivedNeeds`/note: a paused project is skipped; its parked/waiting items disappear from the note and the dashboard Needs-you list (the owner already decided). Unpark and confirm-done taps still work.
- Action protocol: new `owner-paused` reject reason, written as a rejected outcome (not pre-auth). An unreadable union inside the lock now refuses as `lagging-fold`.
- Liveness Reconciler / silence backstop: new `cos-owner-paused` stand-down for `cosNoRespawn` runs; `isOwnerPaused` throws on an unreadable union so the reconciler's existing `cos-dep-threw` stand-down applies.
- `foldBindingState` is used by projects overview (PR 3231 reads `BindingState.pausedBy` already) — now populated.
- Store validator: unknown lifecycle events are accepted (were rejected); every fold matches event names explicitly, so they have no effect; counted in `GET /chief-of-staff` `unknownLifecycleEvents`.

## 6. External surfaces

- New route `POST /chief-of-staff/projects/:key/pause-ask` (bearer). New fields in `GET /chief-of-staff` (`projects[].pausedBy`, `unknownLifecycleEvents`) and `GET /chief-of-staff/projects/:key` (`pausedBy`).
- New Telegram ask message with one button (`cos:p:<nonce>` / `cos:r:<nonce>`), in the Chief of Staff topic or the owner's private chat (the existing one-reader rule), and new one-line tap answers.
- Telegram adapter: `onChiefOfStaffTap` now also receives the tapped message's chat and id; `clearInlineButtons` added.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The ask shows the owner's whole message, the project name, what pausing does and does not do, and one button. Answers are plain ("Paused. I won't start, restart or nudge it from here on; anything already under way may still finish."). Refusals tell the owner what happened and that nothing changed.

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated: pause events ride the `chief-of-staff-record` store (order-independent fold). The asks file is machine-local by design (machine-local-justification: physical-credential-locality — bound to the machine whose Telegram bot receives the owner's callback for that message). Mixed-version window acknowledged above; the version warning reads each peer's advertised build. No user-facing notice beyond the ask (sent once, from the lease holder that receives callbacks).

## 8. Rollback cost

`chiefOfStaff.ownerPause.asks: false` stops new pause asks (resume asks, taps, fold and fences keep working), with no release. A plain revert is not a rollback path: older builds reject the pause events and would stall their Chief of Staff stream, and every paused project would silently restart against the owner's decision. A defect in the fold or fences is fixed forward.

## Conclusion

Ships live wherever the Chief of Staff runs (development-agent gated today). The owner's tap is the only authority; everything the agent can do is ask with the owner's own words.

## Second-pass review (if required)

Required (gate on an identity check; session lifecycle respawn stand-down). See the reviewer's response appended below.

## Evidence pointers

- Spec + convergence report: `docs/specs/cos-owner-pause-record.md`, `docs/specs/reports/cos-owner-pause-record-convergence.md`.
- Tests: `tests/unit/cos-owner-pause.test.ts` (19), `tests/integration/chief-of-staff-owner-pause.test.ts`, `tests/e2e/chief-of-staff-alive.test.ts` (extended).
- The motivating record: Justin's message `[source: telegram 102965/142745 2026-11-13]` resolves `found`, authorship `human`, sender the owner.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. No new self-triggered controller: the change only adds stand-down conditions (skip, refuse, do-not-respawn) to existing loops; it adds no new fire path.

## Second-pass reviewer response

**Verdict:** Concur with the review

Checked independently: `tsc --noEmit` clean; `tests/unit/cos-owner-pause.test.ts` 19/19 pass.

No non-owner path to a record found. The dashboard PIN route (`routes.ts` `/tap`) only accepts `unpark|confirm-done`, and a pause tap with no chat/message ref returns `ignored`. The bearer `pause-ask` route only sends an ask. The adapter's `from.id === getVerifiedOwner()` check runs before `ownerTap`. The validator refuses `by !== 'owner-tap'` for pause events. The bot token cannot forge `from.id`. Fail-closed is correct: an unreadable union in `actionGate` gives Infinity and a `lagging-fold` refusal, and a throw inside the lock is refused. `isOwnerPaused` throws, so the reconciler stands down. Re-check-then-write is race-safe: the store is re-read after the only await, nothing awaits before emit, and the fold dedupes by askId. Unpark/confirm-done taps and their answers are unchanged. Unknown lifecycle events reach no fold: the only consumers are `foldBindingState`, `unknownLifecycleEvents` and `ownerPauseEventForAsk`, all of which match by name, and a malformed known pause event is still rejected.

Findings (none blocking):
1. Low. `ChiefOfStaffLoop.ts:900`: a replayed pause tap after a later resume answers the owner "Paused." while the fold says resumed. The unit test asserts this. Fix: answer from the current fold, or `ignored`.
2. Low, pre-existing boundary. While the lifeline ingress guard is unarmed or bypassed, a session with the bearer token can POST `/internal/telegram-callback` with the owner's `from.id`. The chat and message ids it needs are in the machine-local `cos-pause-asks` state. Section 2 should name this alongside "shell access".
3. Low. `RECHECK_UNAVAILABLE` (`:387`) treats `not-found` and `identity-unverified` as "could not look". A cited row that has since disappeared still records. That is acceptable because the tap proves current intent, but it should be stated in the spec.
4. Low. `server.ts:18753`: the heartbeat `cosSuppress` catch returns null, so an unreadable union does not suppress a nudge to a paused run. This matches the documented pre-existing behaviour.
5. Nit. `server.ts:30681`: the DM goes to `getOwnerUserId()`, but the tap is checked against `getVerifiedOwner()`. If the two differ, the button lands with someone who cannot tap it, which is a safe failure.
