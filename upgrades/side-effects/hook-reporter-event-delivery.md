# Side-Effects Review — Hook reporter event delivery (real event names and the session id)

**Version / slug:** `hook-reporter-event-delivery`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `codex-cli:gpt-6.2-astra (independent, see the section at the end)`

## Summary of the change

The built-in command hook reporter read the event name from `hook_event` (Claude Code sends `hook_event_name`) and never
put the instar session id in the payload, so every Stop, SubagentStart, SubagentStop, TaskCompleted, SessionEnd and
PreCompact event was stored as `Unknown` and their consumers never ran on the default path. Both copies of the script
(update path in `PostUpdateMigrator.ts`, new agents in `init.ts`) now read `hook_event_name` first, validate the session
id once (an invalid id sends nothing), add `instar_session_id` and `instar_session`, and forward six short identifying
fields bounded in the script. No message text is sent. The `/hooks/events` route applies the native path's bounds to
those fields with `boundCommandReporterPayload` (new, `NativeHookEvents.ts`) and uses one validated session id for both
storage and the dispatcher. Spec: `docs/specs/hook-reporter-event-delivery.md`.

## Decision-point inventory

- Which events a consumer receives — invariant (Claude Code's own field).
- Field bounds on the command path — invariant (native bounds reused for the listed fields).
- Session id sent by the script — invariant (matches the id pattern or is sent nowhere).

## 1. Over-block

An agent whose `INSTAR_SESSION_ID` does not match `^[A-Za-z0-9._:-]{1,128}$` now sends no hook events at all (before:
events were sent with that id). Instar mints ids that match (UUIDs and tmux-safe names), so no real agent is expected to
hit this; such an id could not be attributed by the route anyway. Fields failing their bound are dropped from the
payload while the event still arrives: a malformed `agent_id` or `task_id`, an `agent_type` or `instar_session` over
128 characters, a relative or over-1024-character `agent_transcript_path`, a `reason` or `trigger` over 64. The route
now overwrites a caller-supplied `instar_session_id` with its own validated value, or removes it. Consequence for a direct caller that
supplies the id only in the body (no scoped session and no valid `instar_sid` query): the event is still stored, but
without a session id, so consumers that require one (Compaction Trigger 1, the practice-fold trigger) do not act on
it. This is deliberate (the route speaks only for the session it can attribute); the built-in scripts always send the
query value. No other caller of this route is known in the source tree.

## 2. Under-block

Codex bodies without `hook_event_name` and without `tool_name` still arrive as `Unknown` (unchanged). The session
summary's last-message field and the HelperWatchdog's failure markers from a subagent's final text are not fed by the
built-in command scripts (they send no message text); they are fed by the native reporter, or by a direct caller of
`/hooks/events` that posts the text (redacted and cut to its last 200 characters by the route). The practice-fold runner still
cannot read a handoff reply from the hook; that is a separate spec, and practice folds stay off on Echo until it ships.

## 3. Level-of-abstraction fit

Right layer: the defect is in the reporter that every agent runs; the server-side bounds sit beside the native
projection they mirror. The native reporter (docs/specs/native-hook-events.md) is the long-term path and is unchanged.

## 4. Signal vs authority compliance

No authority added. The reporter and route carry events; they decide nothing. They do become new inputs to existing
consumers that act, exactly as the native path already feeds them: the compaction sentinel (can inject recovery input
into the compacting session), the pre-compaction flush where enabled (writes durable facts), and the HelperWatchdog
(alerts behind their own default-off gate). Those consumers' own gates and scopes are unchanged.

## 4b. Judgment-point check

No competing-signals decision point is touched; no static heuristic is added.

## 5. Interactions

Consumers that start receiving events on the command path, as they already do on the native path: `SubagentTracker`
(start/stop/session end), Compaction Trigger 1 (scoped to the emitting session; Triggers 2 and 3 already cover
compaction, and the sentinel dedupes across triggers), the per-instar-session index in `HookEventReceiver` (now
includes command-path rows), the practice-fold runner's Stop trigger (dev-gated; off on Echo; off on the fleet), and the pre-compaction memory flush
(`wirePreCompactionFlush`, `PreCompact`): off by default (`preCompactionFlush.enabled`), but ON on Echo, where it has
been blind on the command path. Where it is on, each delivered `PreCompact` now reaches its flush, which (given an intelligence provider, a
session id and a readable, non-empty transcript) makes one bounded model call over the transcript
(`transcriptCharBudget`) and writes at most `maxFactsPerFlush` durable facts when extraction yields any; every delivered `PreCompact` also
writes an audit entry (including when the flush skips, finds no facts, or the provider errors). Compaction
Trigger 1 feeds the compaction sentinel, which can inject recovery input into the compacting session (scoped to that
session; the sentinel already dedupes across its three triggers). Subagent events start the HelperWatchdog's stall
tracking and logging; its injected alerts stay behind their own default-off gate.
Codex: `PostToolUse` rows already carried `tool_name` (981 of 981 sampled), so their naming is unchanged; what changes
is that the dispatcher receives the validated id and the stored row gains session attribution, so per-session
summaries count these rows;
its `UserPromptSubmit` rows are named only where Codex sends `hook_event_name` (the test supplies the field; on Echo
32 Codex prompt rows were stored named after the local patch, evidence that it does), and no consumer listens for that
name. The existing wiring test pinning that
both routes call the shared dispatch function was updated for the validated id variable.

## 6. External surfaces

Observable effects beyond storage, where the consuming feature is on: recovery input injected into a compacting
session, durable memory facts from the pre-compaction flush, and HelperWatchdog alerts (default off). The scripts post
to `INSTAR_SERVER_URL`, unchanged.


Stored hook-event rows gain names and fields; dashboard session telemetry (`GET /sessions`, summaries) can now show
command-path subagent and task data. Where the pre-compaction flush is on, durable memory facts are written at
compaction (bounded, audited). No messages to users, no new routes, no new config. New for direct callers of
`/hooks/events`: `last_assistant_message` and `task_subject` are now redacted and cut to their last 200 characters
before storage and dispatch (before this change a direct caller's text was stored as received); the built-in scripts
send none. Unchanged: a scoped caller's `transcript_path`, `agent_transcript_path` and `cwd` are removed before
dispatch, so consumers receive no paths from scoped requests.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design (unchanged): a hook fired by a Claude Code process is delivered over loopback to the server on
the same host and stored in that machine's `hook-events/`. No user-facing notices, no durable state that moves with a
topic, no generated URLs. Status surfaces: none new or changed.

## 8. Rollback cost

Pure code change. Revert and ship a patch; built-in hooks are overwritten on the next update, so agents return to the
old script automatically. Stored rows written meanwhile stay valid (extra fields are ignored by older readers). Effects
of consumers that ran meanwhile are not undone by a revert: durable facts written by an enabled pre-compaction flush stay
in memory (they are ordinary, audited, removable memory entries), and recovery input already injected stays in those
sessions' history, as do any HelperWatchdog alerts injected where that gate is on.

## Conclusion

Ship. The change restores events that existing consumers were designed for, sends no message text, and is covered by
an integration test that runs both real script copies against the real server (fails on the old code), plus unit tests:
`tests/integration/command-hook-reporter.test.ts` (10 tests), `tests/unit/command-hook-reporter-fields.test.ts` (5),
and the updated wiring assertion in `tests/unit/native-hook-events-consumers.test.ts`. Limits: the init copy is
compared with the update copy at the wire (byte-identical) rather than also sent through the server, and the
consumers' own effects (recovery injection, flush writes) are covered by their existing native-path tests, not
re-exercised end to end here.

## Second-pass review (independent, codex-cli:gpt-6.2-astra, 2026-11-22)

Concur with the review.

"Both reporters restore event names and attach the instar session ID without forwarding message text. The route uses
its validated session ID for storage and dispatch, and bounds the new fields before either. The artifact accounts for
the restored consumer effects, their existing gates, and the changes for direct callers."

Earlier runs of the same reviewer raised concerns, each corrected in this artifact before the concurring run: the
pre-compaction flush consumer and its durable writes and audit entries; recovery injection and watchdog effects that a
revert cannot undo; direct-caller text redaction being new; scoped callers losing paths; body-only session ids being
dropped; and a spurious "deleted test suite" that came from comparing against a newer main (the branch was then
fast-forwarded and the diff taken against the merge base).
