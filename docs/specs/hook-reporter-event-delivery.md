---
title: "Hook reporter event delivery: real event names and the session id on the command path"
slug: "hook-reporter-event-delivery"
author: "echo"
approved: true
approved-by: "echo (agent approval of its own converged spec, per Approval Only Where Required: this changes no constitution text and no CODEOWNERS path; convergence report read 2026-11-22)"
tier: 2
tier-reasoning: "Wakes event consumers (subagent tracking, Compaction Trigger 1) on every agent's default path; review ran past the Tier 1 cap of 3 rounds with only precision findings, so it is held to the Tier 2 cap."
eli16-overview: "docs/specs/hook-reporter-event-delivery.eli16.md"
parent-principle: "Verify the State, Not Its Symbol"
lessons-engaged: [P1-structure-beats-willpower, P2-signal-vs-authority, P20-verify-the-state, migration-parity, no-silent-degradation]
history: "Split on 2026-11-21 from a broader draft (slug command-hook-reporter-event-names) that reached the six-round review cap with remaining findings only in the practice-fold reply handling. That part moves to its own spec. This spec covers only event delivery: the reporter script and the /hooks/events route. Rounds 1-6 of the broader draft reviewed this part too; it drew no new finding after round 3."
review-convergence: "2026-11-22T01:56:54.976Z"
review-iterations: 6
review-completed-at: "2026-11-22T01:56:54.976Z"
review-report: "docs/specs/reports/hook-reporter-event-delivery-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
---

# Hook reporter event delivery: real event names and the session id on the command path

## Problem statement

Measured on Echo, 2026-11-21. The built-in command hook `.instar/hooks/instar/hook-event-reporter.js` (the default
reporter on every agent; the native HTTP reporter of `docs/specs/native-hook-events.md` ships off) reads the event name
from `input.hook_event`. Claude Code sends `hook_event_name`. Every event without a `tool_name` (Stop, SubagentStart,
SubagentStop, TaskCompleted, SessionEnd, PreCompact) is therefore stored as `"Unknown"`: the sampled Echo conversation
shows 344 `PostToolUse`, 50 `Unknown` and zero `Stop`. The reporter also never puts `instar_session_id` (or the tmux
name, `instar_session`) in the payload; it sends the id only as the `instar_sid` query value, which the route passes
to the dispatcher but not into the stored payload. And it forwards none of `agent_id`, `agent_type`,
`agent_transcript_path`, `task_id`, `reason`, `trigger`.

Measured: zero stored `Stop` events in the sampled conversation; Echo's practice-fold log empty for 90 minutes after
the feature was turned on. Inferred from the old field lookup and confirmed by reading each consumer (not measured on
every conversation), on the command path:
- the practice-fold runner (`foldShadowRunnerBoot.ts`, listens for `Stop` with `instar_session_id`) could not be
  triggered;
- `SubagentTracker` (`hookEventDispatch.ts`: `SubagentStart`, `SubagentStop`, `SessionEnd`) could not see a subagent;
- Compaction Trigger 1 (`wireCompactionTrigger1`, `PreCompact` with `instar_session_id` and `instar_session`) could not
  fire; Triggers 2 and 3 covered compaction.

Out of scope, in its own spec: the practice-fold runner reads its handoff reply from the `Stop` hook's
`last_assistant_message`, which neither reporter delivers whole. Until that ships, practice folds stay off on Echo
(`contextBudget.fold.shadow: false`, read live). The runner is dev-gated (off on the fleet), so this change cannot make
it run anywhere it is not already switched on.

## Proposed design

1. **Reporter script**, both copies: `PostUpdateMigrator.getHookEventReporterScript()` (existing agents; built-in hooks
   are overwritten on every update, Migration Parity rule 4) and `getHookEventReporterScript()` in `init.ts` (new
   agents, now exported for the parity test). `event` reads `input.hook_event_name`, then `input.hook_event` (old
   spelling), then the existing `PostToolUse`/`Unknown` fallback. Validate the environment's `INSTAR_SESSION_ID` once against the id pattern; an invalid id is sent in neither the
   `instar_sid` query nor the body (the hook exits, as it already does with no id). Add `instar_session_id` and
   `instar_session` (the tmux name from `INSTAR_SESSION_NAME`). Forward the native reporter's short identifying fields,
   each bounded in the script before sending (an older server stores a payload as received): `agent_id` and `task_id`
   must match `^[A-Za-z0-9._:-]{1,128}$`, `agent_type` and `instar_session` be strings of 1 to 128 characters,
   `agent_transcript_path` an absolute path of at most 1024 characters, `reason` and `trigger` strings of at most 64;
   anything else is not sent. Message text
   (`last_assistant_message`, `task_subject`) is deliberately NOT sent from the command script: an older server stores
   a payload as received, so during a script/server version mismatch raw text could reach storage. Consequence, stated
   plainly: on the command path the session summary's last-message field (`getSessionSummary`) stays empty and the
   HelperWatchdog cannot read failure markers from a subagent's final text; both are fed only when the native reporter
   is on. Subagent start and stop themselves are fed on both paths.
2. **Server route** `POST /hooks/events`: before dispatch, `boundCommandReporterPayload(payload, instarSid)` (new, in
   `NativeHookEvents.ts`, beside the native projection it mirrors). It sets `payload.instar_session_id` to the route's
   own value (a scoped session's id wins, as the route already decides; a payload value is overwritten, and removed when
   the route has none). The route-selected id is validated once (`ID_RE`) and the validated value is used for both the
   stored payload and the dispatcher's session-id bridge; an invalid id reaches neither. It applies the native bounds to the newly forwarded fields (and to `last_assistant_message` and
   `task_subject` if a client posts them directly): ids by `ID_RE`, names ≤ 128 (`instar_session`, `agent_type`), short
   strings ≤ 64, absolute paths ≤ 1024, long text redacted then cut to its last 200 characters; a field failing its bound
   is dropped. Fields it does not name keep their existing handling. This is parity for the newly forwarded fields, not a
   whole-event projection like the native path's.
3. **Codex.** Codex installs the same script for `PostToolUse` and `UserPromptSubmit` only (`installCodexHooks.ts`).
   Codex prompt events (the unnamed, tool-less rows) already stored on Echo carry `session_id`, `cwd` and a rollout
   `transcript_path` and no `tool_name`, so they arrived as `Unknown`. Where Codex supplies `hook_event_name`, its `UserPromptSubmit` events are now stored
   under that name (if a Codex build omits the field, the event stays named as before: no regression). Measured on Echo
   (30 Codex event files, 2026-11-21): 981 of 981 Codex `PostToolUse` events carry a `tool_name`, so they were already
   named `PostToolUse` (their naming and dispatch are unchanged; what is new is that these rows now carry
   `instar_session_id`, so per-session summaries keyed on it count them, as they already do native rows); and since Echo's local patch,
   32 Codex prompt events were stored named `UserPromptSubmit` (evidence of the output: either named input field could
   have produced it; the stored rows do not record which); and its events carry
   `instar_session_id`. No consumer listens for `UserPromptSubmit` (verified: no listener or dispatch case in `src/`),
   and `PostToolUse` handling is unchanged; the receiver's per-instar-session index now includes these events, as it
   already does for native ones.

Not changed: the native reporter, its flag, its projection, `/hooks/native-events`, and every consumer's logic.

## Decision points touched

- Which events a consumer receives — invariant; basis: external-constraint; evidence: the event name is Claude Code's own hook_event_name field, so there are no competing signals to weigh.
- Field bounds on the command path — invariant; basis: external-constraint; evidence: the native path's ratified bounds (docs/specs/native-hook-events.md D1), reused for exactly the fields in Proposed design §2.
- Session id sent by the script — invariant; basis: enumerable-domain; evidence: an id either matches the instar id pattern or it does not; a non-matching id is sent nowhere.

> No blocking guard is added, removed or changed.

## State vs. symbol (P20)

- **Event received.** Symbol: a stored event named `Stop`. State: Claude Code ended a turn in that session.
  What the route guarantees: the event's name is whatever the script sent (from `hook_event_name`, the legacy
  `hook_event`, or the `PostToolUse` inference from `tool_name`), and its session attribution is the
  route-selected id (validated syntactically; the route does not look up a running session). Independent
  corroboration, where a consumer needs it, is the consumer's own: for example Compaction Trigger 1 checks the id
  against a running session with the same tmux name, and a consumer that needs to know a turn really ended reads that
  session's transcript. The session-id bridge is not corroboration (the event itself feeds it). Unmeasurable (no session id from the route): the field is
  removed, and consumers keyed on it skip the event, as they do today.

## Multi-machine posture

No new state. Hook events are delivered by a Claude Code process to the server on the same host over loopback and
stored in that machine's `hook-events/`; this change alters only the names and fields of events already stored there.

machine-local-justification: hardware-bound-resource impossible-because="a hook fired by a Claude Code process is delivered to the server process on the same host over loopback" permanence=permanent

## Frontloaded Decisions

1. Fix the command path rather than only flip the native flag fleet-wide — decided: the native flag is a separate
   maturation track (its dev-agent trial is open on a work card); the default path must not drop events meanwhile.
2. Bound the newly forwarded fields exactly as native — decided.
3. Payload session id always from the route — decided (a scoped session speaks only for itself).
4. No message text from the command script — decided (version-mismatch storage risk).
5. The practice-fold reply handling ships in its own spec; practice folds stay off on Echo until it lands — decided.

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** the integration test runs the real update-path reporter script, and the init copy, as child
  processes against the real `AgentServer` pipeline with real Claude Code hook bodies for all seven events.
- **dev-agent-live:** Echo has run a hand-patched copy of the reporter since 2026-11-21 16:44 PST: `Stop`,
  `SessionEnd`, `UserPromptSubmit` and `PostToolUse` arrive named and with the session id. After release, verify on
  Echo for 3 days.
- **fleet:** ships on in the next release (a defect fix to a built-in hook; no flag).
- **graduation criterion:** a claim about retained rows at a stated snapshot. Each day at 23:00 PST for 3 days, count
  the hook-event rows present for Claude Code sessions (identified from the session records' framework, not from event
  names) that were received that day; report the eligible count and the `Unknown` count. Pass: zero `Unknown` among
  them; the counts of `Stop` and of `SessionEnd` each positive; and `SubagentTracker` records a subagent start and its
  matching stop. The total `Unknown` count across all sessions is reported alongside (Codex bodies without a name stay
  `Unknown` by design). Rows the receiver trimmed before a snapshot are outside the claim.
- **dark-window:** none (ships on).
- **ladder:** not applicable: defect fix with no new feature flag; test agent, then Echo (dev agent), then the fleet in the next release

## Acceptance criteria

1. The real reporter script, fed real bodies for all seven events, stores them under their real names, each with the
   instar session id (integration test; fails on the old code).
2. A `Stop` reaches a `Stop` listener with the session id; a command-path `SubagentStart` then `SubagentStop` opens and
   closes the matching agent in `SubagentTracker`, which receives the expected `agent_transcript_path` (unscoped call).
3. The script sends no message text; a 5,000-character `last_assistant_message` posted directly is stored as at most
   its last 200 characters.
4. A payload's own `instar_session_id` is replaced by the route's.
5. The init copy and the update copy send byte-identical JSON (captured before the route) on every fixture: all seven
   real bodies, the legacy spelling, the unnamed fallback (stays `Unknown`), and malformed fields (not sent). With an
   invalid session id in the environment, nothing is sent (neither query nor body).
8. Codex-shaped bodies for its two registered events are stored under their names with the instar session id, and
   the prompt text is not forwarded.
9. An invalid route session id is used for neither storage nor the session-id bridge.
6. A command-path `PreCompact` resolves to exactly the emitting topic session for Compaction Trigger 1, and to none
   after a respawn under the same tmux name.
7. A credential that spans the 200-character cut is redacted before the cut.

## Review notes

- Round 2 suggested one shared script generator for the init and update copies. Not done here: the two copies are
  pinned by a byte-identical parity test (criterion 5), so a future field fix cannot land in
  one copy only on the fixtures covered (all seven real bodies, the legacy `hook_event` spelling, the unnamed fallback and
  malformed fields). Parity beyond those fixtures is not claimed.

## Risks

- **Consumers wake up on the fleet.** Subagent tracking and Compaction Trigger 1 start receiving events they were built
  for, exactly as on the native path, whose tests already exercise them. The HelperWatchdog's injected alerts stay
  behind their own default-off gate; Trigger 1 is scoped to the emitting session. The practice-fold runner is
  dev-gated and off on Echo until its own spec ships. Rollback is a revert (the built-in hook is overwritten on the next
  update).
- **Older Claude Code** that still sends `hook_event` keeps working through the fallback.
