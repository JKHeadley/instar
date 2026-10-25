# Side-effects review — two false-success control paths (W26 lanes 1 and 2)

**Slug:** `w26-false-success-repairs`
**Window:** 26, exit-test items 3 and 3b
**Files:** `src/commands/server.ts`, `src/core/SessionManager.ts`, `src/server/routes.ts`,
`src/messaging/TelegramAdapter.ts`, `src/messaging/shared/emergencyStopUserMessage.ts` (new),
`src/templates/scripts/telegram-reply.sh`, `src/core/PostUpdateMigrator.ts`, plus unit /
integration / e2e tests and the pinned fixture `tests/fixtures/relay-history/telegram-reply-pre-suppression.sh`.

## What changed

**Lane 1 — the stop that does not stop.** `killSession(sessionId)` resolves by id; the two
emergency-stop paths handed it a tmux name, so it returned `false` silently while the route answered
`killed: !!sessionName`, the log printed "killed session" unconditionally, and the person was told
"Session terminated." Now `SessionManager.killSessionByTmuxName` owns the name→id resolution and
returns the real outcome; `onSentinelKillSession` and the route's direct fallback both use it; the
route's `killed` field, both log paths, and the shared `emergencyStopUserMessage` text are keyed on
that outcome (three states: no-session / killed / kill-failed). The run-record preservation
(`stopAutonomousTopic`) is untouched and asserted alongside every failure arm.

**Lane 2 — the reply client corrupts decision references.** `telegram-reply.sh` clamped
`--tone-decision-ref` with `tr -cd 'a-zA-Z0-9-'`, stripping the `_` in machine-prefixed refs
(`d-m_03b30f-<uuid>`) so the override landed as an orphan outcome. The clamp is replaced by a
full-match shape check (`^[db]-(?:[A-Za-z0-9_]{1,64}-)?<uuid>$`, ≤128 chars) that passes a valid
ref through byte-for-byte and drops anything else to empty. Migration parity: the v1.3.1199 script
sha `74ee09b4…c218fb52` is added to `PostUpdateMigrator`'s known-shipped set; the parity test reads
a pinned historical fixture instead of deriving one from the current template.

## Phase 1 — principle check (signal vs authority)

Lane 1 removes a *false* signal; it adds no new authority. The kill already had authority (an
operator's emergency stop). What changes is that the reported outcome is now the real outcome. The
resolver is a total, deterministic lookup (running sessions whose `tmuxSession` equals the name) —
nothing heuristic holds blocking power. Failure direction: a miss reports failure, never success.

Lane 2's shape check is a deterministic validator over an explicit format. It rejects rather than
repairs: an unrecognised reference is dropped, so the client never forwards a *partially* sanitised
value the server would mis-join. No new authority; the server-side grading is unchanged.

## Phase 4 — the eight questions

**1. Over-block.** Lane 2: a decision reference not in the router's shape is now dropped where it
was previously forwarded mangled. Nothing legitimate is lost — a mangled ref was already an orphan —
but if the router's correlation-id format ever changes, overrides silently stop joining. Mitigation:
the integration test asserts a *settled* grade through the documented client, so a format drift
fails a test. Lane 1 over-blocks nothing.

**2. Under-block.** Lane 1 reports a failed kill but does not retry it, and does not distinguish
"no running session with that name" from "kill sequence failed" in the JSON (`killed:false` for
both; the log line does distinguish). A wedged pane that survives the kill sequence is the session
watchdog's territory, unchanged. Lane 2 still trusts python3 to be present for the shape check
(already true: the same script uses python3 for JSON-escaping the reason); if python3 is missing the
ref drops to empty — the safe side, and the same behaviour the script already has for the reason.

**3. Level of abstraction.** Lane 1: resolution belongs in `SessionManager`, the only layer that
knows both the state records and the kill sequence; putting it at each call site is what let the
two paths drift. The user text belongs in one shared module, because the previous defect survived
in exactly the one consumer (the human message) that was fixed separately. Lane 2: the client is the
right place — the server ingress was already proven correct via the raw route in W25.

**4. Signal vs authority compliance.** Yes — see Phase 1.

**5. Interactions.** Stop custody / resume-queue pause / `stopAutonomousTopic` run in the same order
as before, regardless of kill outcome. `onSentinelKillSession` returning `false` where it used to
return a discarded value is consumed only by the two stop paths. The migration set addition is
additive: an installed script matching the new sha is now replaced in place; any other installed
content behaves exactly as before. The `.new`-candidate path is untouched. The suppressed-duplicate
honesty branch in the script is unchanged.

**6. External surfaces.** The `POST /internal/telegram-forward` emergency-stop response `killed`
field now carries the real outcome (previously always `true` when a name resolved). The Telegram
text a person receives gains a third state. `telegram-reply.sh` emits `toneAdvisoryDecisionRef`
intact for valid refs, empty otherwise. No new routes, no wire-format change.

**7. Multi-machine posture.** Machine-local by nature: a kill acts on the machine holding the
session; the relay script is installed per machine and migrated per machine. Nothing replicates.
A stop forwarded to the owning machine is judged there — the reported outcome is that machine's.

**8. Rollback cost.** Low. Reverting the source files restores the previous behaviour with no data
migration. Reverting `PostUpdateMigrator` after agents have been migrated leaves them on the fixed
script (harmless — it is a strict improvement). The fixture file is inert.

## Evidence

Must-fail arms shown red-then-green, all three tiers, both lanes (listed in the release fragment).
Full suite on a clean worktree carrying exactly these files: Test Files 3170 passed / 4 skipped;
Tests 49,988 passed; `EXIT=0` — `.instar/w26/deploy-evidence/candidate-v2-full-suite.log`, per-file
shas in `candidate-v2-file-shas.txt`, independently recomputed by Observer 2 (02:45Z).

## Live proofs still owed (post-deploy, by the charter)

Lane 1: a throwaway autonomous run on a demo topic, stopped through the real route; the process
gone within 60 s; route JSON, log, and human text agreeing. Lane 2: one advisory round-trip through
the documented client with a machine-prefixed ref, then a settled grade on the meter with
`orphanOutcomes` unchanged. Both recorded under `.instar/w26/deploy-evidence/`.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action` — **closure: n/a** (negative declaration). The kill is a
  one-shot, operator-driven emergency stop: one inbound stop message produces at most one kill of
  the named session. This change only makes the reported outcome truthful; it adds no retry, no
  loop, and no self-triggered controller. The relay-client change is a client-side input validator
  with no action at all.
