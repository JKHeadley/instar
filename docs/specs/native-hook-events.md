---
title: "Native hook events — report Claude Code events without a process per event, and repair what the reporter has been dropping"
slug: "native-hook-events"
author: "echo"
parent-principle: "Responsible Resource Usage"
ships-staged: true
supervision: tier0
eli16-overview: "docs/specs/native-hook-events.eli16.md"
lessons-engaged: [P1-structure-beats-willpower, P2-signal-vs-authority, P4-testing-integrity, P20-verify-the-state, migration-parity, no-silent-degradation, bounded-blast-radius, 80-20-convergence]
status: approved
review-convergence: "2026-10-28T02:59:01.145Z"
review-iterations: 6
review-completed-at: "2026-10-28T02:59:01.145Z"
review-report: "docs/specs/reports/native-hook-events-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 0
contested-then-cleared: 4
approved: true
approved-by: "Justin (Telegram topic 131280, 2026-10-27 17:55 PDT: \"please start\", confirming an autonomous run whose completion condition named this work: a spec for task (6) converged via /spec-converge, then built and merged off-by-default with measurements). Recorded under the written delegation that the operator approves constitution changes only; this spec changes no constitution text."
---

## Problem statement

Every Claude Code session runs instar's hook scripts as separate processes. Measured on 2026-10-27 (this machine, WSL2, Node 22): the 11 `PreToolUse` hooks that match a harmless `Bash` command take a median 579 ms of process time when run one after another, about 45 ms each, almost all of it Node starting up; Claude Code runs them in parallel, so the wait is nearer the slowest (~120 ms) but every one still costs a process, CPU and ~45 MB of transient memory. After the command, `hook-event-reporter.js` starts again, and it also runs on 8 other events.

The task asked for a "per-event dispatcher": one process per event that runs all of that event's hooks. A prototype that ran the 9 Node hooks as worker threads in one process cut process time only about a third (≈0.40 s vs ≈0.58 s) and transient memory from roughly 400 MB to 130 MB, and it broke a security guard: `telegram-origin-guard.js` reads file descriptor 0 directly (inside a worker that is the dispatcher's own stdin, so it blocks) and hashes `process.argv[1]` to check its own integrity (inside a worker that names the dispatcher). A dispatcher would also have to re-implement Claude Code's own result-merging (deny > defer > ask > allow, exit 2, `additionalContext` from every hook) for every event. That design is rejected.

Claude Code (verified on 2.1.310, hooks reference read 2026-10-27) now offers two native ways to spend fewer processes:

1. **`type: "http"` hooks.** The event is POSTed to a URL; no process is spawned. Instar avoided them because they silently did not fire in Claude Code ≤ 2.1.78 (`src/data/http-hook-templates.ts`). A real `claude -p` run on 2.1.310 against a logging server received both a `PostToolUse` and a `Stop` event, with `${VAR}` headers expanded (via `allowedEnvVars`), and a 404 answer did not disturb the session.
2. **An `if` condition per hook** (permission-rule syntax). Considered for the five advice-only `PreToolUse:Bash` hooks and **rejected for this spec**: `if` takes one rule, and Claude Code's de-duplication key includes the `if` text (from the 2.1.310 binary: `command\x00${shell}\x00${command}\x00${args}\x00${if}`), so a hook split into one entry per pattern runs twice for a command matching two rules; `post-action-reflection.js` writes a journal entry for a much broader command set than its early exit; and case-insensitive regexes matched anywhere (including across subcommands, `sudo` and env-prefixed forms) cannot be shown equivalent to permission globs. The idea is queued with these findings (feedback fb-81852c3a-3a3) rather than shipped half-right. <!-- tracked: feedback fb-81852c3a-3a3 -->

### What the measurement also found (the reporter is mostly dead today)

Scope note: the 11 `PreToolUse` hooks above are unchanged by this spec. Its saving is one reporter process per event (about 45 ms of CPU and 45 MB transient each) on 7 events, `PostToolUse` among them, i.e. after every tool call.

`hook-event-reporter.js` forwards a projection of each event to `POST /hooks/events`, but:

- It reads `input.hook_event`; Claude Code sends `hook_event_name`. Every non-tool event is stored as `"Unknown"`: of the last 4,349 stored events on this machine, 4,246 are `PostToolUse` and 103 are `Unknown`; zero `Stop`, `SubagentStart`, `SubagentStop`, `TaskCompleted`, `PreCompact`, `SessionEnd` or worktree events.
- It never sends `tool_input`, so the route's commit detection (`routes.ts`, "Track commits for homeostasis") can never fire; 0 of 4,349 stored events carry it.
- It drops `last_assistant_message` and `agent_type`, so `getSessionSummary`'s `lastAssistantMessage` and `subagentsSpawned` are always empty.
- Events are filed under Claude's session UUID (all 50 stored files are UUIDs), while the dashboard (`routes.ts` ~10966, `WebSocketManager.ts` ~582) asks by tmux session name, so per-session summaries and `taskCompleted` always come back empty.

- It is registered on `WorktreeCreate` and `WorktreeRemove`. In Claude Code a hook on those events **replaces** the default git behaviour (2.1.310 binary: "WorktreeCreate hook failed: hook succeeded but returned no worktree path"; "WorktreeRemove hook … kept worktree at"). The reporter prints no path, so Claude Code's own worktree isolation is very likely failing in instar sessions today. This is a live bug independent of the native switch.

Consequence that shapes this spec: **fixing the event names switches on consumers that have never run.** The one with teeth is the compaction sentinel's "Trigger 1" (`server.ts` ~14374): on any `PreCompact` event it reports **every** topic session to the sentinel, not the one compacting. Enabled as written, one session's compaction would start recovery checks on every conversation.

## Goals

1. `hook-event-reporter.js` is replaced by native HTTP hooks on its 7 reporting events (`PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `TaskCompleted`, `SessionEnd`, `PreCompact`); no process is spawned to report an event.
1a. The reporter's worktree entries are removed by a separate PR (D3).
2. Reported events carry their real names and the fields their consumers read; consumers that start receiving data for the first time are each reviewed and made correct before they do (the compaction trigger is scoped to the emitting session).
3. Stored events hold no raw command text and no tool output; the only free text kept is `last_assistant_message` (≤ 200 characters) and `task_subject`, both passed through credential redaction; stored events are not served by the file viewer.
4. Blocking guards are not changed.
5. Off by default (one flag, plus `monitoring.helperWatchdog.injectAlerts` default off); existing agents receive it through the update path; rollback restores today's settings exactly.

## Non-goals

- A dispatcher process, or running hooks in-process (rejected above).
- `if` filters on any hook (rejected above).
- Converting any hook that can block (exit 2, `deny`, `decision: block`) to HTTP or giving it an `if` filter: a blocking guard must keep failing the way it fails today.
- The separate millisecond/seconds timeout bug in hook templates (queued as feedback fb-a0852d6a-bf0). <!-- tracked: feedback fb-a0852d6a-bf0 -->

## Design

### D1 — HTTP hooks for the event reporter

When `hooks.nativeEventReporter.enabled` is true, the settings writer emits, for each of the 7 reporting events, `{"type":"http","url":"http://127.0.0.1:<port>/hooks/native-events","timeout":1,"headers":{"Authorization":"Bearer ${INSTAR_AUTH_TOKEN}","X-Instar-Session-Id":"${INSTAR_SESSION_ID}","X-Instar-Session":"${INSTAR_SESSION_NAME}","X-Instar-AgentId":"${INSTAR_AGENT_ID}"},"allowedEnvVars":["INSTAR_AUTH_TOKEN","INSTAR_SESSION_ID","INSTAR_SESSION_NAME","INSTAR_AGENT_ID"]}` in place of the `hook-event-reporter.js` command entry. No `onFailure: "block"`: a reporter must never block (today's script always exits 0). The timeout is 1 second (Claude Code reads it in seconds). Today's script stops waiting 50 ms after sending, so a slow server never delays the session; a native hook waits for the answer, so the route answers 204 as soon as the body is parsed and projected, then hands the projected event to a bounded in-memory queue drained by one worker that processes at most 50 events or 10 ms per turn and then yields (`setImmediate`), so other server work always interleaves (at most 1,000 pending events; when full, the newest event is dropped and counted under `hookEvents.queueOverflow`, so a burst cannot grow memory); the per-request parse and the full-text redaction happen before enqueueing and are bounded by the 4 MB cap and the 32 concurrent requests Node admits per route by default (the JSON parse itself happens before the answer and is the main cost for a large body), and the 1 s timeout bounds the worst case during a server event-loop stall; criterion 8 measures a slow-server run. The URL path deliberately does not contain `/hooks/events`, because the existing migrations `migrateHttpHookSessionId` and `migrateHttpHooksToCommandHooks`  match any HTTP hook whose URL contains that string and would rewrite or revert it; `ensureHttpHooksExist` does not match on that substring but treats any HTTP hook without `${INSTAR_SERVER_URL}` as an existing reporter, so it leaves the native entry alone; all three methods are still taught to skip the native URL by name, and a test runs `migrateSettings` twice with the flag on and expects no change.

`POST /hooks/native-events` receives Claude Code's raw event body and **projects it before storing**, because the raw body includes full tool output (megabytes, possibly secrets) that the reporter never stored:

- kept: `event` (from `hook_event_name`), `session_id`, `tool_name`, `cwd`, `file_path` (from `tool_input.file_path`/`path`), `transcript_path`, `agent_type`, `agent_id`, `agent_transcript_path` (read by `SubagentTracker.onStop`), `last_assistant_message` (passed through `src/messaging/secret-patterns.ts` on the **full** text first, then truncated to its **last** 200 characters (failure markers such as a rate-limit notice sit at the end of a message, where `HelperWatchdog` looks for them), so a truncation can never cut a credential below the patterns' reach; `task_subject` gets the same redact-then-truncate), `task_id`/`task_subject` for `TaskCompleted`, `reason` (read by `getExitReason` and the dashboard's `exitReason`), `trigger` (read by `PreCompactionFlush.handle`), and for `Bash` only a derived boolean `is_git_commit` computed at projection time with the route's existing commit test (the raw command is never stored; the route's check, which tests `typeof tool_input === 'string'` and so never matches Claude Code's object, is changed to read the boolean), plus `instar_session_id` and `instar_session` from the headers;
- dropped: `tool_response`, every other `tool_input` field, anything else.

The projection is a **typed, bounded schema**, not just a list of field names: each kept field is accepted only with the type and bound below, and any other value (wrong type, object, oversized) is dropped and counted under `hookEvents.malformedFields`, never stored. If a key field (`event`, `session_id`, `instar_session_id`) fails its bound, the whole event is dropped and counted under `hookEvents.malformedEvents`.

| Field | Type and bound | Text policy |
|---|---|---|
| `event` | one of the 7 reporting event names | categorical |
| `session_id`, `agent_id`, `task_id`, `instar_session_id` | string, ≤ 128 chars, `[A-Za-z0-9._:-]` | identifier |
| `instar_session`, `agent_type`, `tool_name` | string, ≤ 128 chars | identifier |
| `cwd`, `file_path`, `transcript_path`, `agent_transcript_path` | absolute path string, ≤ 1,024 chars | path; already present in today's stored events and transcripts |
| `reason`, `trigger` | string, ≤ 64 chars | categorical in practice; stored as given within the bound |
| `is_git_commit` | boolean | — |
| `last_assistant_message`, `task_subject` | string | redacted on the full text, then the last 200 chars kept |

Then it calls the same `hookEventReceiver.receive()` and the same per-event side effects as `/hooks/events` through one shared function that receives **only the projected event** (never the raw body, so `SubagentTracker`'s state files and `HelperWatchdog`'s matching see the redacted, truncated text) and takes the instar session id as a parameter (from `req.query.instar_sid` on the old route, from the header on the native one), so the session-id bridge (`setClaudeSessionId`, the only feeder of a session's `claudeSessionId`, which resume, the compaction sentinel's transcript check and subagent lookups depend on) keeps working; and answers 204 with an empty body (Claude Code treats an empty 2xx as success). **Admission before parsing.** Placement follows the `/completion-claim/observe` precedent: only the guard and the route's own parser are mounted early, ahead of the global parser; the handler itself stays in the normal routes, after `authMiddleware`, `requestTimeout` and CORS. Express's global body parser runs before `authMiddleware`, so a route-level parser would parse a large body from an unauthenticated client (including over the tunnel). The route is therefore mounted with its own guard **ahead of** the global parser: in this order, all before reading the body: a non-loopback peer or any `Cf-Connecting-Ip`/`X-Forwarded-For` gets 403; an **empty** bearer token (the header is then exactly `Bearer`: verified 2026-10-27 on 2.1.310 that a variable listed in `allowedEnvVars` but unset expands to an empty string, and Claude Code trims the trailing space, never sending the literal `${…}`) or an empty `X-Instar-Session-Id` gets 204 with nothing processed (a hand-started `claude` or an unconfined `omitAuthEnv` session has an empty token and must see no hook errors; confined sessions run with `--setting-sources local`, so project hooks never fire for them at all; this is expected steady-state traffic, counted separately so it is not read as an alarm); a present but wrong token gets 401; a `Content-Length` over 4 MB gets 413; then parses with `express.json({ limit: '4mb' })`. It is counted; the PR records the measured body-size distribution of a real session so the cap is evidence-based. Parsing moves off short-lived processes onto the server's event loop; criterion 8 measures that cost. `/hooks/events` stays as it is for any caller still on the script.

The tmux-name lookup, scoped to one session incarnation. A tmux name is reused across respawns, so lookups never key on it directly. Each stored event carries `instar_session_id` (the per-spawn `INSTAR_SESSION_ID`, unique per incarnation; a `--resume` respawn gets a new one). New tmux-scoped methods `getSessionSummaryForTmux`, `hasTaskCompletedForTmux` and `getExitReasonForTmux` (the existing id-keyed methods stay, because `GET /hooks/events/:sessionId/summary` is keyed by Claude session id) first ask the session manager for that tmux name's **current** `INSTAR_SESSION_ID`, then read only events stamped with it, so a `TaskCompleted` from an earlier incarnation never satisfies a later one. The receiver keeps an index `instar_session_id → Claude session_id(s)` (one Claude session id per incarnation normally; more after an in-process `/clear`), rebuilt at boot by scanning the stored files' events (bounded by the receiver's existing per-session and session-count limits), so it survives a restart. `.instar/hook-events/` and `.instar/subagent-tracking/` are added to the file viewer's never-served list **and to the agent repo's `.gitignore`** by an idempotent migration (precedent: the judgment-provenance `.gitignore` migration in `PostUpdateMigrator`), because git sync commits with `git add -A` and `FileClassifier` only routes merges, it does not stop a commit; after the ignore is in place, any copy already tracked is untracked through `SafeGitExecutor` **only in a repo whose commits instar's own git sync makes (the agent home, decided by the existing agent-home versus project-bound distinction the git-sync job already uses, not a new test)** (`git rm --cached`; on a peer's next pull git removes that peer's working copy of the file, which is local telemetry and harmless); in a project-bound agent whose project folder is the user's own repository, the migration only appends the ignore line and leaves a one-line notice, because `git rm --cached` there would stage a deletion in the user's next commit One agent repo was found tracking a hook-events file since 2026-10-05. Summaries describe the **retained** events of the current incarnation (the same window a fresh rebuild from disk would see), are kept in memory and updated inside `receive()` (instead of re-reading up to 500 events per lookup, which the dashboard does every 5 s), and per-session trimming gains hysteresis (trim to 400 when 500 is reached) so a long session is not rewritten on every event. Session-file eviction (`enforceSessionLimit`, 50 sessions) changes from filename order, which for UUID names is random and can delete a live session's file, to least-recently-received among sessions whose incarnation is **not** live (per the session manager); a live session's file is never evicted, so the limit can exceed 50 by at most the number of live sessions, which the session manager already bounds. An evicted session's in-memory summary and index entries are dropped with it. Files stay keyed by Claude session id (no data migration); events stored before this change carry no `instar_session_id` and are simply not returned by tmux-name lookups, which is no worse than today's always-empty result.

### D2 — Consumers that start receiving data

Each consumer of a newly delivered event or field is reviewed here, and the build changes it where needed **in the same PR as D1**:

| Consumer | Today | With D1 | Change |
|---|---|---|---|
| Compaction sentinel Trigger 1 (`server.ts` ~14374) | never fires | would report every topic session on any `PreCompact` | synchronously inside the `PreCompact` listener, before its existing 10 s `setTimeout` (an event that waited in the queue across a respawn is then dropped, which Triggers 2 and 3 cover) resolve the event's `instar_session_id` against the session manager's current record, require that record's tmux name to equal the `instar_session` header (a delayed event from an earlier incarnation of a reused name matches neither), and report that session only if it is a topic session (today's intersection); otherwise report nothing (Triggers 2 and 3 still cover it) |
| `SubagentTracker` dispatch in the route (`onStart`/`onStop`) | never fires (events arrive as `Unknown`, without `agent_id`) | tracks subagents | none; it is a record |
| Zombie-kill veto (`setSubagentChecker`, its own 60-min cap) | never holds | holds off killing a session with a live subagent | reads the capped helper below |
| Silence-sentinel corroboration (`hasActiveSubagents`) | never suppresses | suppresses a silence alert while a subagent runs | covered by the capped helper above |
| `HelperWatchdog` stall / helper-failed notices (inject into the parent session after 5 min) | never fires | would type warnings into sessions running any long subagent | injection gated behind a new `monitoring.helperWatchdog.injectAlerts` (default **false**): the events are logged and counted, nothing is typed into a session (this also keeps the subagent's last message out of the parent), until its threshold is reviewed separately |
| `PreCompactionFlush` (off by default) | never fires | receives `PreCompact` with the projected payload | none; already per-payload; covered by its own flag |
| Commit detection ("homeostasis") in the route | never fires | counts commits from `Bash` commands | none; signal-only counter |
| Dashboard summary + `taskCompleted` | always empty | populated | none |
| Reflection metrics, jev-circles shadow (`PostToolUse`) | working | unchanged | none |
| Session-id bridge (`setClaudeSessionId`) | working | must keep working | fed from the header (D1) |
| Scope-accretion advisory ledger (`file_path`, `session_id`) | working | unchanged | none |
| Green-PR Layer 2 `cwd` lookup | working | unchanged | none |
| `getExitReason` / dashboard `exitReason` | always empty | populated from `reason` | none |
| `hasActiveSubagents` readers (`SwapWorkGate`, `ActiveWorkSilenceSentinel`, sentinel wiring) | never true | true while a subagent runs | `SubagentTracker.hasActiveSubagents` is today an uncapped set rebuilt at boot from any record without `stoppedAt`, so one missed `SubagentStop` would mute the silence sentinel for that session forever. In the same PR it gains a staleness cap (a subagent older than 60 minutes without a stop no longer counts, matching the kill checker; the in-memory index becomes a map of agent id to start time and incarnation id, with the cap applied at read time by a scan of that session's own entries, which is bounded by its live subagent count (single digits in practice) rather than constant-time; `onStart` gains the start time and `instar_session_id`), the boot rebuild applies the same cap, and a session's `SessionEnd` clears only the subagents recorded under that event's `instar_session_id` (active records carry the incarnation id), so a delayed `SessionEnd` from an earlier incarnation of a resumed Claude session cannot clear a newer incarnation's subagents |

A unit test enumerates both kinds of consumer and fails when one is added without a row in this table's fixture: `hookEventReceiver.on(...)` listeners, counted on a receiver after the real `server.ts` wiring runs in the e2e init harness, and the per-event dispatch block shared by both routes (a static scan of that function's case labels). Readers that pull stored events directly (`getSessionEvents` callers such as the stop-gate and Green-PR `cwd` lookups, `GET /hooks/events/:sessionId`) are covered by the table, not the test.

### D3 — Worktree events (shipped separately)

The reporter's `WorktreeCreate` / `WorktreeRemove` entries broke Claude Code's own worktree creation (reproduced on 2.1.310: with a silent hook, `claude --worktree` fails with "hook succeeded but returned no worktree path"; without it, it works). That fix does not depend on this spec and merges first; this spec's reconcile never emits or restores `WorktreeCreate`/`WorktreeRemove` entries in either direction. It ships as its own small PR (`echo/worktree-hook-fix`: the two events removed from the template and from existing agents by `removeWorktreeReporterHooks()`), and this spec's reporter set is the remaining 7 events.

### D4 — Configuration, migration, rollback

One feature flag, default **false**: `hooks.nativeEventReporter.enabled` (D1+D2), plus the injection gate `monitoring.helperWatchdog.injectAlerts` (D2), also default false. The reconcile runs at server boot (idempotent) as well as in `PostUpdateMigrator.migrateSettings()`, so a flag flip takes effect at the next server restart rather than the next release. It rewrites only instar-owned entries (identified by the `hooks/instar/<name>` command path or the native URL) to match the flags on every update, so turning a flag off and updating, or running the migrator, restores today's command entries exactly; custom hooks are never touched. Settings are read by Claude Code at session start, so a change reaches new sessions only (stated in the CLAUDE.md template line, which also names the flags; mirrored by `migrateClaudeMd`). A Claude Code below 2.1.310, or one whose version cannot be read, keeps the command entries; the version comes from one pure resolver shared by the server and every place `PostUpdateMigrator` is built (`cli.ts`, `migrate.ts`, `UpdateChecker.ts`, `init.ts`, `server.ts`; several have no SessionManager): it takes `config.claudePath` and the retainer settings and returns the version of the binary sessions launch from (the retained copy at `<state>/claude-bin/<version>` when the retainer is on, `claudePath` otherwise), or `unreadable`, never reading `PATH`. A server not listening on 127.0.0.1 (an explicit non-loopback `config.host`) also keeps the command entries, with `notInEffect` reason `not-listening-on-loopback`; the native URL is built from the server's actual loopback listen address. A flag that is on but not in effect (version too old or unreadable) reports a degradation (`NativeHookEvents.notInEffect`, with the reason) once per boot, so it is never silent. Reconciling restores instar-owned entries to their generated form, which also overwrites a user's hand edits to those entries (as `migrateHooks` already does for instar-owned scripts). Codex keeps running the script (`installCodexHooks.ts`), which is why the script, its always-overwrite in `migrateHooks`, and `/hooks/events` all stay. The script's own `hook_event` naming bug is deliberately left as it is (fixing it would switch on the same consumers for Codex, which is a separate review); its events carry no `instar_session`, so Trigger 1 reports nothing for them. Codex hooks (`installCodexHooks.ts`) are out of scope: they are a separate settings format with their own events.

## Decision points touched

- **Event projection (which fields are stored)** — `invariant`. A fixed allowlist; no competing signals.
- **Compaction Trigger 1 scope** — `invariant`. Report the named session or nothing; the conservative answer (nothing) is backed by two other triggers.
- **Native route admission (loopback, no forwarding headers, bearer, size, all before parsing)** — `invariant`.
- **Existing blocking guards** — `invariant` (unchanged): no blocking guard is modified, filtered or converted.

## State vs. symbol (P20)

- **Delivery is best-effort.** The 204 is sent before storage and dispatch, so a 204 does not prove the event was stored; a crash in between loses it, as a crash of today's script after sending does. The health counters distinguish admitted, stored and failed-processing events.
- **Event received.** Symbol: a stored event with a name. State: Claude Code fired that hook. Corroboration: the stored `session_id` and `transcript_path` match a live session's transcript. Bidirectional: an event Claude Code fired but failed to deliver (server down) is missing; delivery failures are not visible to the server, so counts are labelled "received", never "fired".
- **Process savings.** Symbol: fewer hook processes. Measured, not assumed: the PR records, for the same scripted session, the number of hook processes started and their total CPU time with each flag off and on.

## Multi-machine posture

Each machine's sessions report to that machine's own server over loopback; nothing new replicates. The boot reconcile writes `.claude/settings.json` per machine (and the version gate is per machine), so that file must stay machine-local: an agent that git-syncs it would flip between command and native entries across machines. Because a sync could overwrite the file between boot and a session launch, the launcher re-validates the reporter entries against the flag and this machine's port immediately before each claude-code spawn and rewrites them if they differ (idempotent, instar-owned entries only); the reconcile also warns once if it finds the file tracked.

machine-local-justification: hardware-bound-resource impossible-because="a hook fired by a Claude Code process is delivered to the server process on the same host over loopback" permanence=permanent

## Frontloaded Decisions

1. Reporter → native HTTP hooks with server-side projection; raw tool output, command text and long message text never stored; `hook-events/` never served — decided (D1).
2. New route `/hooks/native-events`; `/hooks/events` unchanged for script callers — decided (D1).
3. Compaction Trigger 1 scoped to the emitting session in the same PR — decided (D2).
4. No `if` filters in this spec; the worktree fix ships as its own PR — decided (D3).
5. One feature flag plus the injection gate, both default off; reconciled at boot and on update, both directions; Claude Code < 2.1.310 keeps command entries with a degradation report — decided (D4).
6. No dispatcher, no in-process hooks — decided (Problem statement).
7. Native path `/hooks/native-events` (outside the existing migrations' match), 1 s timeout, 204 before work — decided (D1).
8. Session-id bridge fed from the header through the shared function — decided (D1).
9. Subagent consumers fed; `HelperWatchdog` injection gated off by default — decided (D2).
10. Guard before parsing; 4 MB cap; summaries in memory; trim hysteresis — decided (D1).
11. Counters on the authenticated `/health` under `hookEvents`: `admitted`, `stored`, `failedProcessing`, `emptyCredential` (expected steady-state traffic), `wrongToken`, `forbidden`, `tooLarge`, `queueOverflow`, `malformedFields`, `malformedEvents`; the 4 MB cap is fixed, the body-size measurement is only recorded; the version gate uses the one pure resolver of D4 (the retained binary when the retainer is on, `claudePath` otherwise) — decided (D1, D4).

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** a throwaway agent with the flag on: one scripted `claude -p` session (10 Bash, 1 Read, 1 Edit, one subagent) delivers all 7 events natively, they are stored with real names and only the schema's fields, `hookEvents` counters move as expected, and no `hook-event-reporter.js` process starts (counted with `strace -f -e trace=execve`); recorded in the PR with the latency budget numbers.
- **dev-agent-live:** the flag on for 72 hours on the development agent (Echo), one machine first. Daily: `hookEvents.failedProcessing`, `queueOverflow` and `malformedEvents` stay at zero; dashboard summaries and `taskCompleted` populate; compaction Trigger 1 reports only the compacting session; the silence sentinel still fires on a deliberately silent test session.
- **fleet:** default stays off in the release that ships the code; the fleet default flips to on in a later release once the graduation criterion holds, with the reconcile honouring an explicit `false`.
- **graduation criterion:** 72 hours on the development agent with the latency budget met (≤ 10 ms median, ≤ 50 ms p95 added per event), zero `failedProcessing`/`queueOverflow`, and every newly fed consumer behaving as its D2 row states.
- **dark-window:** at most 14 days from merge to the development-agent flip; if not started by then, it is reconsidered in the evolution queue rather than left dark.

## Acceptance criteria

1. Flag off: generated settings identical to today (after the separate worktree fix) (unit).
2. Reporter flag on: a real Claude Code session's `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionEnd`, `PreCompact` and `TaskCompleted` events are each recorded as natively delivered (live check) and stored with their real names and the projected fields, no `tool_response` is stored, and no `hook-event-reporter.js` process starts (recorded live check + integration test posting real event bodies).
3. Compaction Trigger 1: a `PreCompact` from topic session A reports only A; one from a non-topic session, without the header, or from an earlier incarnation whose `instar_session_id` is no longer current reports nothing (unit).
3a. Session-id bridge: a native event updates the session's `claudeSessionId`, including after a respawn; both routes call the same side-effect function (wiring test).
3b. Subagents: a native `SubagentStart`/`SubagentStop` pair reaches `SubagentTracker` with `agent_transcript_path`; with `injectAlerts` off, a 6-minute subagent produces a log line and no injected message (unit).
3c. Migrations: `migrateSettings` run twice with the flag on changes nothing; the existing http-hook migrations leave the native entry alone (unit).
4. Dashboard summary for a tmux session name returns its events (integration).
4a. Incarnation scope: after a respawn under the same tmux name, an old incarnation's `TaskCompleted` does not make `hasTaskCompleted` true; after a server restart the index is rebuilt and lookups still resolve (unit + integration).
5. Subagent cap: a subagent with no stop for 61 minutes no longer counts as active, including after a server restart; a `SessionEnd` clears only its own incarnation's subagents (an old incarnation's late `SessionEnd` leaves a newer incarnation's subagent active); an in-memory summary equals one rebuilt from disk for the same retained events; a credential spanning the 200-character boundary is redacted (unit).
5c. Git: after the migration `git check-ignore` succeeds for both directories and a previously tracked hook-events file is untracked; session eviction removes the least-recently-received session, never a live one, and drops its summary (unit).
5b. Bounds: a malformed allowed field (an object under `reason`, a 10 KB `tool_name`) is dropped and counted, not stored; 5,000 events posted faster than they can be stored leave at most 1,000 pending and count the overflow (integration).
5a. Exposure and admission: no stored event contains raw command text or a `tool_response`; `GET` of a `hook-events/` path through the file viewer is refused; with a 3 MB body, an empty token or empty session header gets 204, a wrong token 401, and a non-loopback or forwarded-header request 403, and in all three cases nothing is parsed or dispatched (integration).
6a. Launch-time check: a settings file overwritten between boot and spawn (e.g. by a sync) is rewritten to this machine's correct entries before the session starts (unit).
6. Migration: flag on → the 7 entries rewritten; flag off → the command entries restored; custom hooks untouched; Claude Code below 2.1.310 → command entries kept plus one degradation report (unit, both directions).
7. Feature alive (e2e, through the `server.ts` init path): `POST /hooks/native-events` with a real `Stop` body returns 204 and the event is retrievable by name.
8. Latency budget, checked before the flag is ever enabled: with a healthy server the native hook adds at most 10 ms median and 50 ms p95 per event to the session; with the server stalled the delay is bounded by the 1 s timeout, which is accepted (a stalled server already delays today's guard hooks, which wait up to their own timeouts). Measured and recorded in the PR: for one scripted `claude -p` session (fixed prompt that runs 10 Bash commands, 1 Read, 1 Edit), reporter processes started (counted with `strace -f -e trace=execve` on the session's process tree, since ~45 ms processes escape `ps` sampling) and their total CPU time, each flag off vs on; plus the per-tool-call delay with the server artificially stalled 3 s, the server-side parse and projection cost of an accepted event just under the 4 MB cap, and the refusal of a 10 MB one before parsing.

## Risks

- R1: a future Claude Code changes HTTP-hook delivery; the migrator keeps command entries below the verified version, and a drop in received events is visible on the existing hook-events surfaces.
- R2: consumers newly fed real data behave in unreviewed ways; D2's table and its listener-enumeration test are the guard.
