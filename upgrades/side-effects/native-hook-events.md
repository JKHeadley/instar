# Side-Effects Review — Native hook events

**Version / slug:** `native-hook-events`
**Date:** `2026-10-31`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Implements docs/specs/native-hook-events.md (converged 6/6 with codex-cli gpt-6-astra, approved). Behind `hooks.nativeEventReporter.enabled` (default false), the `hook-event-reporter.js` command entry on the 7 reporting events becomes a Claude Code `type: "http"` hook posting to a new loopback-only route `POST /hooks/native-events`. New: `src/core/nativeHookEventsGate.ts` (one decision: flag + Claude Code >= 2.1.310 read from the configured binary, never PATH + server listens on loopback, including the mesh `bindHost` override), `src/monitoring/NativeHookEvents.ts` (admission before parsing, typed bounded projection, bounded drain queue, counters), `src/server/hookEventDispatch.ts` (the one per-event side-effect function both hook routes share), `src/monitoring/hookEventConsumers.ts` (scoped compaction Trigger 1, gated helper-alert delivery). Modified: `http-hook-templates.ts` (native hook shape + both-direction reconcile), `PostUpdateMigrator.ts` (reconcile in migrateSettings, telemetry .gitignore migration, CLAUDE.md section, existing http-hook migrations skip the native entry), `server.ts` (boot reconcile + launch check, scoped Trigger 1, injectAlerts gate, capped subagent checker), `SessionManager.ts` (launch-time re-validation), `HookEventReceiver.ts` (in-memory incarnation-scoped summaries, tmux lookups, live-safe eviction, trim hysteresis), `SubagentTracker.ts` (60-min staleness cap, incarnation-scoped SessionEnd), `routes.ts` (native route, shared dispatch, `/health.hookEvents`, tmux telemetry), `AgentServer.ts` (guard + 4 MB parser ahead of the global parser), `fileRoutes.ts` (never-served), `MachineIdentity.ts` + `WriteDomainRegistry.ts`, `types.ts`, `templates.ts`, `cli.ts`, `UpdateChecker.ts`. Tier 2 (fleet settings migration). Size: ~1,750 src lines, ~1,400 test lines across 25 files; spec rounds: 6 (prior session); this session: one build pass plus one second-pass review.

## Decision-point inventory

- Native route admission (loopback / forwarding headers / bearer / 4 MB) — add — invariant, before any body parse.
- Event projection (stored fields) — add — fixed allowlist with type bounds.
- Compaction sentinel Trigger 1 target — modify — was "every topic session on any PreCompact", now "the emitting session, or nothing".
- Zombie-kill subagent veto + `hasActiveSubagents` — modify — staleness cap at 60 min (the kill checker already had it; the silence-sentinel reader did not).
- HelperWatchdog alert injection — modify — gated behind `monitoring.helperWatchdog.injectAlerts` (default false); alerts still logged.
- Reporter settings reconcile — add — rewrites instar-owned reporter entries only.
- Existing blocking PreToolUse guards — pass-through — unchanged (verified live: telegram-origin-guard blocked a Telegram curl with the feature on).

---

## 1. Over-block

The route refuses non-loopback peers and requests with `Cf-Connecting-Ip`/`X-Forwarded-For` (403); a local reverse proxy forwarding to the agent would be refused, which is intended (the route is for same-host Claude Code only). An empty token or empty session id answers 204 with nothing processed: a hand-started `claude` in an agent folder loses telemetry it never had (today's script also sends no instar session id there). A body over 4 MB is refused with 413 (Claude Code ignores it; the session is unaffected). Events whose `session_id`/`instar_session_id` fail the identifier bound are dropped and counted (`malformedEvents`).

## 2. Under-block

Delivery is best-effort: the 204 precedes storage, so a crash between answer and drain loses the event (same as today's script after sending). Events from a Claude Code below 2.1.310 still go through the old reporter with its known defects (wrong event name) — the flag is not in effect there and says so with a degradation. Compaction Trigger 1 reports nothing for a non-topic session or an event that waited in the queue across a respawn; Triggers 2 and 3 still cover those.

## 3. Level-of-abstraction fit

Uses Claude Code's own HTTP hook mechanism instead of re-implementing hook merging in a dispatcher (the rejected design). Storage and side effects go through the existing HookEventReceiver and one shared dispatch function, so the old route and the new route cannot drift. The version/loopback decision is one function shared by the boot reconcile, the launch check and every migrator construction.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface over agent behaviour.

The reporter never blocks (no `onFailure: "block"`, empty 2xx answers). The admission guard is an access-control invariant on a new telemetry route, not a judgement. The consumer changes REMOVE authority: Trigger 1 now acts on fewer sessions, injection into sessions is off by default, and the subagent veto can no longer hold forever.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The 60-minute subagent staleness cap already existed in the kill checker; it is now applied consistently to the read the silence sentinel uses. The other decisions are invariants declared in the spec's "Decision points touched".

## 5. Interactions

- **Shadowing:** `migrateHttpHookSessionId` and `migrateHttpHooksToCommandHooks` match `/hooks/events` by substring; the native path is `/hooks/native-events` and both functions now skip `isNativeReporterHook` explicitly (unit-tested: a second migrateSettings run changes nothing). `ensureHttpHooksExist` treats a native entry as an existing reporter, so it never adds a second one. `removeWorktreeReporterHooks` (#2423) runs before the reconcile; the reconcile never touches WorktreeCreate/WorktreeRemove.
- **Double-fire:** the reconcile collapses a duplicated reporter on one event to one entry. Both routes share `dispatchHookEvent`, so the side effects run once per event whichever route it arrived on.
- **Races:** the drain worker runs in the server's event loop (≤50 events or 10 ms per turn, then `setImmediate`); the queue is capped at 1,000 (newest dropped, counted). The launch check rewrites settings immediately before a claude-code spawn; it is idempotent and only touches instar-owned entries, so a concurrent sync write converges on the next launch.
- **Feedback loops:** none — the route only stores and feeds signals.

## 6. External surfaces

- Settings file `.claude/settings.json` changes only when the flag is on. With the flag off the reconcile touches ONLY native reporter entries (turning them back into the command entry); command reporter entries are never normalised, re-ordered or removed in that direction, whatever their shape or matcher (unit: non-canonical command + two matchers left byte-identical). De-duplication is per matcher: a reporter under a different matcher is never removed.
- `GET /sessions` and the WebSocket session list look telemetry up by the session's current incarnation. With the flag on they are populated (was always empty); with the flag off they stay empty, because the script reporter sends no incarnation id.
- Flag-independent receiver changes: session-file eviction is least-recently-received and never removes a live session (was filename order), and trimming has hysteresis (reaching 500 events trims to 400). A `SessionEnd` with reason `clear` (an in-process `/clear`) is not treated as an exit.
- `/health` (authenticated only) gains `hookEvents`; the unauthenticated response does not (integration-tested).
- The agent repo's `.gitignore` gains two lines on every agent (flag-independent). In a standalone agent home, already-tracked telemetry files are untracked (`git rm --cached`, this machine's working copy kept); git sync then commits that removal, so a peer machine still on an older version loses its working copy of those files on its next pull. They are rebuildable per-session telemetry, so this is accepted (the spec states it). On an agent whose home is itself a clone of the instar repo (Echo), the two lines land in that checkout's `.gitignore`, which is harmless.
- HelperWatchdog alerts that were (in theory) injected are now only logged by default. In practice they never fired: the reporter delivered no SubagentStart/Stop with an `agent_id` (spec measurement), so no live behaviour is lost.
- Operator surface: no operator-facing actions; the flag is a config key the agent sets conversationally.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN: a Claude Code process reports to the server on the same host over loopback; nothing replicates. The settings file is reconciled per machine (port + version gate), and the launcher re-validates it before each spawn because a git sync could carry another machine's entries; the boot reconcile warns once if the file is tracked. No user-facing notices; durable state is per-session telemetry (git-ignored, rebuildable), so nothing strands on topic transfer; the native URL is loopback-only and is never shared.

## 8. Rollback cost

Flip `hooks.nativeEventReporter.enabled` to false and restart the server: the boot reconcile restores today's command entries exactly (unit + e2e tested), and new sessions use them. No data migration: stored events are per-session telemetry. Code revert alone is NOT a full rollback for a machine that had the flag on: the reverted code has no reconcile, its `ensureHttpHooksExist` treats the native entry as an existing reporter and leaves it, and the route would answer 404, which Claude Code ignores, so telemetry would stop silently. The rollback order is therefore flag off + restart, then revert. The flag ships off, so no agent is in that state at release.

---

## Conclusion

The preserved build matched the converged spec closely; this session rebased it onto current main (one conflict with #2423, both migrations kept), added the e2e "feature is alive" tier, closed one gap (the gate ignored `multiMachine.meshTransport.bindHost`, which can make the server listen off loopback), and measured the per-event cost and the live behaviour. Clear to ship off-by-default; the maturation plan (72 h on the development agent) gates any fleet default.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (read-only)
**Round 1: concern** — (1) with the flag off, the boot/launch/update reconcile still normalised command reporter entries (JSON-identity compare) and de-duplicated reporters across matchers, so a non-canonical or multi-matcher fleet agent would be rewritten and could silently lose reporting; (2) a `/clear` inside a running session reported `exitReason: "clear"`; (3) artifact under-stated the flag-independent `.gitignore` effects on peers; nits: chunked bodies recorded as 0 bytes, case-sensitive `Bearer` accepting `Bearerxyz`, flag-off telemetry claim, unlisted eviction/trim changes.
**Resolution:** (1) `reconcileReporterHooks` now owns only native entries when not native, and de-duplicates per matcher (three new unit tests); (2) `SessionEnd` reason `clear` is not an exit (unit test); (3) §6 rewritten; nits fixed in `NativeHookEvents.ts` (+ unit test) and §6. Also found while re-running integration: a refused large upload got ECONNRESET because the guard answered mid-upload; refused requests now drain (read and discard, never parse) before answering: the 204/401/403 refusals up to 4 MB, a declared-oversized 413 up to 16 MB, larger ones are answered at once. This is a small deviation from the spec's "refused before reading the body": the body is still never parsed or dispatched, and discarding at most 16 MB is cheaper than the global parser, which already parses up to 12 MB for any route before auth.

**Round 2: concur.** Its note (the 413 answered mid-upload could still reset the connection) was confirmed by the integration test still hitting ECONNRESET; the 403 and moderate-413 paths now drain too (above), and only a body declared over 16 MB is answered mid-upload, which Claude Code ignores for a non-blocking http hook.

---

## Evidence pointers

- Per-event cost (60 runs each, real AgentServer from this branch, Node 24.14.1): command reporter 88.7 ms wall median (p95 95.1), 30 ms CPU, 55.7 MB peak RSS, 1 process; native 1.0 ms round trip median (p95 4.5), ≤ 1.6 ms server CPU, 0 processes. A 4.19 MB event: 204 in 12.7 ms, 9.9 ms CPU; a 10 MB body: 413 before parsing.
- Live `claude -p` (Claude Code 2.1.310, haiku, 10 Bash + Read + Edit + subagent + blocked Telegram curl): flag off 17 reporter processes / 530 ms CPU, events stored as 13 PostToolUse + 4 "Unknown"; flag on 0 reporter processes, 17 events stored with real names, dashboard summary populated, session-id bridge set, no command text or tool output stored; telegram-origin-guard blocked the curl in both. Server stalled 3 s: every native hook waited 1.0 s (998–1004 ms) and gave up; the session finished normally.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect fix — not applicable for that part.

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `n/a`
- **`reason`:** one-shot event handling, not a self-triggered loop: the drain worker only processes events Claude Code posted (queue capped at 1,000, newest dropped, 50 events or 10 ms per turn), and the settings reconcile is an idempotent write at boot, before a spawn and on update; nothing retries, respawns, kills, notifies or re-drives on its own.

## Follow-up commit (Local Verify, round 1)

Local Verify (peer machine, unit lane) failed two ratchets, both bookkeeping: `feature-delivery-completeness` needed the Claude-only `## Native Hook Events` CLAUDE.md section tracked (added to the legacy/Claude-specific list, with the Ultracode precedent: deliberately not mirrored to Codex/Gemini, whose hooks are unchanged), and `no-silent-fallbacks` counted this change's logged, safe-direction catches plus one pre-existing prune catch in `SessionManager.resolveLaunchBinary` that the inserted launch check moved out of its old exemption window. Each now carries a `@silent-fallback-ok` reason; the scanner is back at the 494 baseline. No behaviour change.
