---
change_type: fix
---

## What Changed

Two control paths reported success where the effect never happened. Both are repaired at the
consumer, with must-fail tests that go red if the false report returns.

**1. An emergency stop now stops, and says so truthfully.** The stop path — both the lifeline route
(`POST /internal/telegram-forward` with an emergency-stop message) and the conversational path in
`TelegramAdapter` — handed a *tmux name* to `SessionManager.killSession`, which resolves its argument
by *session id*. The lookup missed, the kill returned `false` silently, and every consumer reported
"killed": the route answered `killed: !!sessionName` (derived from a name having resolved, not from a
kill having happened), the log printed `killed session` unconditionally, and the person was told
"Session terminated."

Now `SessionManager.killSessionByTmuxName` is the one place the name→id resolution lives, so the two
stop paths cannot drift apart, and it returns the real outcome. The route's `killed` field IS that
outcome. The log prints `KILL FAILED … the session was NOT killed` when the kill does not land. The
text a person reads comes from one shared module, `emergencyStopUserMessage`, keyed on the outcome in
all three states: no session to stop, stopped, and *tried to stop and could not* (which says the
session is still running and that the stop request was still recorded). The run record
(`active:false`, `stopped_at`) is preserved in every state — that half already worked and is asserted
alongside each failure arm.

**2. A tone-gate override sent through the documented reply client keeps its decision reference
byte-for-byte.** `telegram-reply.sh --tone-decision-ref` clamped the reference with
`tr -cd 'a-zA-Z0-9-'`. The allowed set had no underscore, so a real reference such as
`d-m_03b30f-<uuid>` lost its `_`, the server could not join the override to its decision, and the
outcome landed as an orphan — a grade that tunes nothing. The client now accepts a reference only in
the router's correlation-id shape (`d-<uuid>` or `d-<machine-id>-<uuid>`, likewise `b-`), validated by
a full-match pattern, so production machine ids survive intact while shell- and JSON-hostile input is
still rejected (an invalid reference is dropped to empty, never partially passed through).

Migration parity: the previously shipped relay script's sha
(`74ee09b4d4d537ddfe032f3192cab08b4f2f956fdb1e1b3ccd94b26dc218fb52`, the v1.3.1199 version) is
registered in `PostUpdateMigrator`'s known-shipped set, so deployed agents receive the fixed client in
place rather than a `.new` candidate beside the broken installed copy. The migration test no longer
reconstructs the historical script from the current template (a derivation that broke on any
unrelated template change and would have registered a version that never shipped); it reads a pinned
fixture, `tests/fixtures/relay-history/telegram-reply-pre-suppression.sh`, whose sha is exactly the
genuine historical version, and asserts the registered set covers every really-deployed version.

## Evidence

Lane 1 must-fail arms, each shown red for the right reason before the fix, across all three tiers:
(a) a tmux name passed straight through to `killSession` fails; (b) a session name that resolves but
whose kill returns `false` must answer `killed: false` — the arm that would have caught the original
defect; (c) when the kill fails, the message the person receives must not claim termination. Both
sides of the boundary are covered: a kill that succeeds reports success and sends "Session
terminated."; a kill that fails reports failure in the JSON, the log, and the human text, with the run
record still preserved. Unit: `session-manager-kill-by-tmux-name`, `emergency-stop-user-message`.
Integration: `telegram-forward-sentinel-intercept`. E2E: `autonomous-emergency-stop-preserves-state-lifecycle`.

Lane 2 must-fail arm: a reference containing an underscore altered on its way through the client fails
(red under the old character class, with the stripped underscore as the reason). The other side: hostile
input (shell metacharacters, quotes, JSON breakouts, over-length) does not survive. Unit:
`telegram-reply-bounded-outcome`. Integration: `telegram-reply-advisory-migration` (the documented client
path through to a recorded, *settled* outcome — not an orphan). E2E: `tone-gate-advisory-migration-alive`.
Migration parity: `telegram-reply-suppressed-duplicate-migration`, `telegram-reply-suppressed-duplicate-alive`,
`PostUpdateMigrator-neutralRelayPath` assert both really-deployed shas are registered.

Full suite on a clean worktree off v1.3.1199 carrying exactly these files, nothing else running:
Test Files 3170 passed, 4 skipped; Tests 49,988 passed, 29 skipped, 3 todo; runner `EXIT=0`
(`.instar/w26/deploy-evidence/candidate-v2-full-suite.log`; per-file shas in `candidate-v2-file-shas.txt`).

A first candidate failed 9 tests in the migration-parity files — not because the fix was wrong, but
because the test derived the historical script from the current template. It was NOT made green by
pasting the new derived hash over the constant: that hash was a version no agent in the field ever ran,
and registering it would have been this release's own defect committed by a test. The fixture pin above
is the repair.

## Known Limits

The stop repair reports a failed kill; it does not retry it. The person is told the session is still
running and pointed at sending stop again or closing it from the dashboard. Whether a kill can fail for
reasons other than a name miss (a wedged pane that survives the kill sequence) is the watchdog's
territory, unchanged here.

The decision-reference shape is now strict by design: a reference that is not `d-…`/`b-…` plus an
optional machine id plus a UUID is dropped, not passed through. If the router ever changes its
correlation-id format, the client must change with it or overrides go unrecorded again — the
integration test asserts the joined, settled outcome, so that drift fails a test rather than
silently orphaning.

Existing agents receive the relay fix only if their installed script matches a registered shipped
version; a hand-edited copy is left alone with a `.new` candidate beside it, as before.

## What to Tell Your User

When you tell me to stop a session in an emergency, I now actually stop it — and if for some reason I
could not, I say so instead of telling you it was terminated. Before, there was a wiring mistake where
the stop request looked up the session by the wrong kind of name, quietly found nothing, and then every
report — the reply you saw, the log, the status — said "killed" anyway. Your stop request was always
recorded, so a stopped run never came back on its own, but the session itself kept running while you
were told it had ended. Now you get one of three honest answers: there was nothing to stop, it was
stopped, or I tried and it is still running, so please send stop again or close it from the dashboard.

Separately, when one of my outgoing messages gets held back by the tone check and I decide to override
it with a reason, that decision is now properly recorded against the check that raised it. A small
character-handling mistake had been mangling the reference that ties the two together, so my overrides
were being logged as unmatched noise instead of graded feedback. That feedback is what tunes the check
over time, so this quietly makes the check smarter from here on. If your agent was set up before this
release, it picks up the corrected version automatically on update.

## Summary of New Capabilities

- Emergency stops resolve the session correctly, kill it, and report the real outcome in the API
  response, the server log, and the message a person reads — including an explicit "stop failed, still
  running" state; the stop record is preserved in every case.
- A shared kill-by-tmux-name helper and a shared stop-message module, so the two stop paths cannot
  drift apart again.
- Tone-gate overrides sent through the documented reply client preserve the decision reference
  byte-for-byte and settle as graded outcomes instead of orphans; hostile input is still rejected.
- Deployed agents receive the corrected relay client in place via a registered shipped-version sha;
  the parity test reads a pinned historical fixture instead of deriving one.
