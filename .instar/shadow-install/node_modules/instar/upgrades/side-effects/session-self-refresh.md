# Side-Effects Review — Session Self-Refresh

**Version / slug:** `session-self-refresh`
**Date:** `2026-05-11`
**Author:** Echo (instar developer)
**Second-pass reviewer:** Required (touches session lifecycle: spawn, kill, recovery)

## Summary of the change

Adds an agent-initiated session refresh capability. The agent calls
`POST /sessions/refresh`, which 202-acks immediately and then (after ~500ms
for response flush) kills the current tmux session and respawns it with
`claude --resume <uuid>` so newly installed MCPs/skills attach while the
conversation is preserved.

The lifecycle is owned by a new module `src/core/SessionRefresh.ts` (~180
lines) that the existing Telegram `/restart` handler now also delegates to,
consolidating kill+resume logic in one place. The module enforces a rolling
rate-counter (default: 5 refreshes / 10-minute window / session) to prevent
infinite respawn loops.

**Files touched:**
- `src/core/SessionRefresh.ts` (new — lifecycle owner + rate guard)
- `src/server/routes.ts` (new POST /sessions/refresh + `sessionRefresh` on RouteContext)
- `src/server/AgentServer.ts` (option pass-through to RouteContext)
- `src/commands/server.ts` (module-scope `_sessionRefresh`, constructor wiring, `onRestartSession` delegation)
- `tests/unit/SessionRefresh.test.ts` (new — 11 cases)
- `tests/unit/sessions-refresh-route.test.ts` (new — 6 cases)
- `upgrades/NEXT.md` (release note: bump minor, new endpoint)

**Decision points touched:**
- Rate-guard authority on session respawn (new — see Q4 below).
- Telegram `/restart` kill+resume path (existing — refactored to delegate, no behavior change).

## Decision-point inventory

- **Respawn rate guard** (`SessionRefresh.checkRateLimit`) — **add** — refuses
  refresh calls beyond N/window per session. Structural rate-counter, not
  a judgment call.
- **Telegram `/restart` kill+resume** (`server.ts:642` `onRestartSession`) —
  **modify** — now delegates to `SessionRefresh.refreshSession`. Legacy
  inline path preserved as fallback for early-boot ordering.
- **POST /sessions/refresh validation** (`routes.ts`) — **add** — hard-invariant
  input validation at the API boundary (per signal-vs-authority "When this
  principle does NOT apply" carve-out for boundary structural validators).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **Rate guard at 5/10min.** A legitimate sequence of "install MCP A, refresh,
  install MCP B, refresh, install MCP C, refresh, ..." could legitimately
  hit the cap if it happens 6+ times in 10 minutes. Operationally improbable
  — most refresh use cases are one-off after a tool install. If a user
  genuinely needs more, the cap is constructor-injectable (tests use 2/3
  limits) and could be raised in config.
- **`not_telegram_bound` refusal.** Non-Telegram-bound sessions (Slack,
  iMessage, headless) cannot self-refresh in v1. They are not over-blocked
  per se — they're un-implemented. The refusal is explicit (`code:
  'not_telegram_bound'`), not a silent drop. Tracked as v2 follow-up
  (TODO comment at `SessionRefresh.ts` `refreshSession` body).
- **Input validators**:
  - `SESSION_NAME_RE` rejects names containing spaces, dots, special chars.
    This matches existing `/sessions/spawn` and `/sessions/:id` validation
    — consistent with the rest of the route surface.
  - `followUpPrompt` capped at 500KB (matches `/sessions/spawn` `prompt`
    limit).
  - `reason` capped at 1000 chars — short observability tag, not free-form
    content. Unlikely to over-block.

## 2. Under-block

**What failure modes does this still miss?**

- **Bursty calls from different agent processes on the same machine.** The
  rate guard is keyed by `sessionName`. Two distinct sessions can each
  consume the full budget independently. Acceptable: the failure mode the
  guard exists to prevent (infinite-loop per session) is per-session by
  construction.
- **Cross-process rate-guard bypass.** The counter lives in-memory in the
  `SessionRefresh` instance. If the *server* itself respawns (which the
  /restart-server path can do via update flows), the counter resets. A
  bad actor could theoretically exploit this, but the threat model here is
  "an agent's own buggy loop respawns itself," not adversarial — the
  realistic failure is a logic bug looping every few seconds, which the
  in-memory counter catches.
- **Respawner callback failure.** If `respawnSessionForTopic` throws,
  `refreshSession` propagates the throw — the route handler catches it in
  the `.catch()` block and logs. The agent's tmux session may have been
  killed without a successful respawn. Mitigation: existing
  `respawnSessionForTopic` is robust (used by SessionRecovery,
  Telegram /restart, and idle-respawn paths); failure here is the same
  failure those existing paths could hit. No new failure mode.
- **No "the session is actively busy" check.** A refresh fires regardless
  of whether the agent is mid-tool-call. Acceptable for v1: agent caller
  is responsible for choosing the moment (e.g. right after an MCP install
  finishes). A "session-busy" signal could be added later but isn't
  required for the use case driving this change.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

The lifecycle owner (`SessionRefresh`) is at the **core/** layer — the
same layer as `SessionManager`, `TopicResumeMap`, etc. It composes those
primitives without reinventing them. ✓

The respawn callback (`respawnSessionForTopic`) lives in
`commands/server.ts` and is closure-captured via the `respawner` constructor
dep. This avoids cyclic imports while keeping the lifecycle owner pure of
top-level server orchestration. ✓

The rate guard is a structural rate-counter living *inside* `SessionRefresh`
— not parallel-to a higher-level gate. Per signal-vs-authority's "When this
does NOT apply" carve-out, safety guards on potentially irreversible /
resource-exhaustion actions (infinite respawn → DoS) are allowed as
brittle blockers when the cost of false-pass is large and false-block is
cheap (an agent gets a clear "rate_limited" response and can wait). ✓

The HTTP endpoint (`routes.ts`) is a thin entry point: validate → 202 →
schedule. It does not own any judgment. ✓

The Telegram `/restart` refactor consolidates duplicate kill+resume logic.
The inline path was reasonable, but having two places to update was a code
smell — now both feed one orchestrator. ✓

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] **Yes — but the logic is a hard-invariant safety guard, not a judgment call.**
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

The rate guard *does* hold blocking authority (it can refuse a refresh).
Per signal-vs-authority "When this principle does NOT apply":

> **Safety guards on irreversible actions.** `rm -rf /`, force-pushing to
> main, deleting the database — these can and should be hard-blocked by
> brittle pattern matchers, because the cost of a false pass is catastrophic
> and the cost of a false block is merely "try again with the right arguments."

Infinite-respawn loops fall into this category: a runaway agent calling
`/sessions/refresh` in a tight loop would tmux-kill itself dozens of times
per minute, each kill consuming claude-CLI startup cycles, potentially
exhausting tmux slots, log volume, and CPU. The cost of a false pass
(letting an infinite loop through) is large; the cost of a false block
(agent has to wait 10 minutes or fix its bug) is small and recoverable.

The guard:
- **Is structural, not judgmental.** It counts timestamps in a window. It
  does not interpret what a message means or what the agent's intent is.
- **Logs structured decisions.** `console.warn` with all relevant fields
  (sessionName, window, cap, reason) — so over-blocks are detectable in
  ops per the signal-vs-authority logging requirement.
- **Has no LLM-backed authority that would be a better consumer.** Session
  lifecycle is a deterministic resource-management domain. Inventing an
  LLM gate "should this agent be allowed to respawn right now" would be
  over-engineering and would introduce a far worse failure mode (gate
  latency + LLM cost on the kill path).

The validation in the HTTP route (`sessionName` regex, length caps) is
boundary structural validation, also explicitly allowed by the principle.

**Verdict: compliant.** Brittle blocking authority on a hard-invariant
safety guard — exactly the carve-out the principle specifies.

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing the existing Telegram `/restart` handler:** The refactor
  routes `onRestartSession` through `SessionRefresh.refreshSession` instead
  of inline kill+respawn. Behavior is equivalent (same UUID save → kill →
  respawn → topicMemory pass-through). The legacy inline path is preserved
  as a fallback when `_sessionRefresh` is null (early boot, no Telegram).
  Tested: existing `/restart` Telegram tests would catch a behavior
  divergence; none of the unit tests for restart-window or session-summary
  tracked changes here.

- **Double-fire with idle-respawn / SessionRecovery:** Both code paths can
  kill+respawn the same session. The guard's per-session counter sees
  every refresh attempt, but NOT respawns triggered by
  `SessionRecovery.respawnSession` or the idle-prompt-kill path (those
  bypass `SessionRefresh`). This is intentional: a context-exhaustion
  recovery is a different concern than a self-refresh and shouldn't
  compete for the same rate budget. Risk: if both fire near-simultaneously
  on the same session, you get a double kill. The first kill wins (the
  second's `kill-session -t =name` no-ops on already-dead sessions) and
  the second respawn may attach to a topic that already has a new
  session. Mitigation: the existing `respawnSessionForTopic` registers
  the new session name via `telegram.registerTopicSession`, which
  overwrites — last writer wins. This race exists for `/restart` today
  and was not introduced by this change.

- **TopicResumeMap interactions:** Two writers (`SessionRefresh` and the
  legacy `onRestartSession` fallback) both call `topicResumeMap.save()`.
  They are mutually exclusive — fallback only runs when `_sessionRefresh`
  is null. No race within this PR. Existing writes from
  `respawnSessionForTopic`, beforeSessionKill emitters, etc. continue to
  work — `save()` is idempotent (last-write-wins on `{topicId, uuid,
  sessionName}` tuple).

- **Async kill timing:** The route schedules the kill via `setTimeout(...,
  500ms)`. If the server is shutting down within that 500ms window, the
  refresh won't execute and the response was already sent. Acceptable —
  agent will retry on next attempt; cluster of dropped refreshes during
  graceful shutdown is fine.

- **Feedback loops:** A successful refresh kills the requester and spawns
  a fresh process. The new process has no concept of "I just refreshed,"
  so if its first action after resume is to call `/sessions/refresh`
  again, it counts as a new attempt against the in-memory rate counter
  (because the counter survives in the server process across the kill+
  spawn — only the agent's process dies). The cap protects against this.
  ✓

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **HTTP surface:** New endpoint `POST /sessions/refresh`. No removal,
  no contract change to existing endpoints. New 503 path for "no Telegram
  adapter wired."
- **Other agents on the same machine:** No effect. The endpoint is
  per-agent-server (each agent runs its own server on its own port).
- **Other users of the install base:** Feature is additive and
  backwards-compatible. Agents that never call the endpoint are
  unaffected. Telegram `/restart` behavior is unchanged for users
  (same kill+respawn, just with a slightly different log line).
- **External systems:** None. No new outbound calls to Telegram, Slack,
  GitHub, etc.
- **Persistent state:** No new persistent state. `TopicResumeMap` writes
  are unchanged. The rate-counter is in-memory only by design (loops
  detected in-process; no need to persist across restarts).
- **Timing / runtime conditions:** 500ms async-kill delay is the only
  new timing surface. Bounded, well below user-visible latency.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** Revert the four src/* commits + tests. Pure code
  change, no schema migration, no persistent state.
- **Agent state repair:** None needed. The rate-counter is in-memory; it
  resets on server restart. No agent will be in a "stuck refreshed" state
  that needs cleanup.
- **User visibility during rollback:** Agents that have started calling
  `/sessions/refresh` will see 404 after rollback (route disappears).
  They'd fall back to "tell user to send another message" — the pre-PR
  behavior. No regression for existing users.
- **Telegram /restart rollback risk:** The refactor of `onRestartSession`
  is the only behavior-touching change for existing users. If the
  `SessionRefresh` delegation has a latent bug, `/restart` could fail in
  ways the inline path didn't. Mitigation: legacy fallback path retained;
  if `_sessionRefresh` is null, the old code runs. If a bug emerges, a
  follow-up patch can null out `_sessionRefresh` to force fallback while
  the root cause is fixed. Estimated rollback time: 5 minutes.

## Conclusion

The change is contained, additive, and reuses existing primitives
(`respawnSessionForTopic`, `TopicResumeMap`, `SessionManager.killSession`).
The single decision-point introduced (the rate guard) falls cleanly under
the signal-vs-authority "safety guard on irreversible action" carve-out
and is implemented as a structural rate-counter, not a judgment.

No design changes required from the review. The non-Telegram-bound case is
explicitly scoped out as a v2 follow-up; the refusal is structured and
detectable in logs.

**Status:** Clear to ship pending second-pass review (required because
this touches session lifecycle).

---

## Second-pass review (if required)

**Reviewer:** Phase-5 dedicated reviewer subagent
**Independent read of the artifact: concern → resolved**

The reviewer found two **blocker** issues that the first cut missed (the unit
tests passed only because the respawner was mocked entirely):

1. **UUID discovery silently no-op'd.** `SessionRefresh` called
   `topicResumeMap.findUuidForSession(sessionName)` without the mandatory
   `claudeSessionId` second argument. Per `TopicResumeMap.findUuidForSession`
   (`src/core/TopicResumeMap.ts:109-117`), the mtime fallback was deliberately
   removed, so the method returns `null` unless given an authoritative
   `claudeSessionId`. The pre-save would never persist a UUID, so the respawn
   went through WITHOUT `--resume`, dropping the live conversation —
   defeating the whole feature.

2. **The old tmux session was never killed.** `respawnSessionForTopic`
   (`src/commands/server.ts:564-613`) does NOT kill the target session; it
   only spawns a new one and re-registers the topic mapping. The pre-PR
   inline `/restart` path killed via `execFileSync(tmux kill-session)`
   BEFORE calling respawnSessionForTopic. The first-cut refactor lost that
   kill entirely — both the new endpoint and the delegated `/restart` would
   spawn a parallel session while leaving the old one running.

Both fixes landed in the same change set: SessionRefresh now routes the kill
through `sessionManager.killSession(stateSession.id)`, which (a) actually
kills the tmux session and (b) fires `beforeSessionKill`, whose existing
listener at `src/commands/server.ts:3406-3419` persists the UUID using
`session.claudeSessionId` — the correct source.

Additional changes from the second-pass:

3. **In-flight guard added.** A `Set<string>` of session names currently
   being refreshed prevents the race where a second call fires before the
   first's kill+spawn completes. Returns `{ ok: false, code:
   'refresh_in_progress' }`. The `finally` block ensures the flag is
   cleared even on respawner throw.
4. **Tests rewritten to assert kill ordering.** The new
   `SessionRefresh.test.ts` includes a `callOrder` array that asserts
   `killSession` fires BEFORE `respawner`, plus an explicit assertion that
   `findUuidForSession` is NOT called on the SessionRefresh side (the
   listener-driven path is authoritative).
5. **Rate-guard pruning test strengthened.** The "prunes stale entries"
   test now walks the clock past the boundary and asserts the FULL budget
   is restored (not just one extra call) — so a dead `checkRateLimit`
   that always returned `true` would fail because the post-boundary cap
   wouldn't kick back in.
6. **Legacy fallback removed.** The `_sessionRefresh === null` fallback in
   `onRestartSession` previously did inline tmux kill + respawn, but the
   inline path had the same latent UUID-loss bug as #1 (existed pre-PR).
   Replaced with a warning log + no-op. This isn't a regression — the
   fallback only fires in a very narrow early-boot window, and the
   pre-existing path never actually preserved resume context anyway.
7. **`Session_not_found` failure mode added.** SessionRefresh now looks up
   the state session by tmux name and returns a structured refusal if no
   running session matches. Previously it would have crashed when trying
   to kill a non-existent session.

Reviewer concerns NOT addressed in this PR (logged as follow-ups):

- **Finding 5 (Telegram-during-window race):** Pre-existing issue —
  TelegramAdapter polling can deliver a message to a tmux session that has
  been killed but not yet replaced. Not introduced by this change; the new
  HTTP endpoint widens the surface. Tracked as a v2 follow-up — would
  require a "topic respawning" flag the inject path consults to buffer
  briefly. Filing under deferred work.
- **Finding 6 (counter resets on server restart):** Rate-counter is
  in-memory only. A buggy loop that includes `/server/restart` could reset
  its own cap. Reviewer agreed not a blocker; trivial follow-up (persist to
  `.instar/state/session-refresh-counter.json` with read-time pruning).
- **Finding 10 (structured logging):** Rate-limit refusals log via
  `console.warn` only. For ops dashboards, emitting via DegradationReporter
  or operations log would be cleaner. Polish item; not gating.

**Status:** Blockers resolved; reviewer's verdict updated to **concur**
pending re-test. Full test suite is re-running on the fixed code.

---

## Evidence pointers

- **Reproduction of the problem this fixes:**
  - On qalatra (Echo's primary), `claude mcp add fathom -- npx mcp-remote@latest https://api.fathom.ai/mcp` was run mid-session. `claude mcp list` showed `fathom: ... ✓ Connected`. Within the same running Claude Code session, `ToolSearch` query "fathom" returned "No matching deferred tools found" — confirming the new MCP tools were NOT loaded into the running session.
  - User's only available path today: send another Telegram message to trigger a fresh CONTINUATION spawn via `respawnSessionForTopic`. There was no agent-initiated path.
  - With this PR: agent calls `POST /sessions/refresh` → tmux kill + `claude --resume <uuid>` → new process picks up Fathom tools and continues conversation.
- **Test output:** 21 new tests pass (15 SessionRefresh unit + 6 route integration; corrected from earlier 17 count after the second-pass rework added in-flight guard + ordering assertions). Full suite: 564/564 locally + on CI after the test-anchor fix noted below.

## Post-push CI fix (2026-05-11)

CI shard 2 (Unit Tests, node 20 + 22) caught a real test-fragility regression that the local push gate did not surface: `tests/unit/slack-context-exhaustion-recovery.test.ts:78` uses `source.indexOf('beforeSessionKill')` as its anchor for slicing the listener body. The original commit's `onRestartSession` explainer contained the literal word "beforeSessionKill" earlier in the file than the real listener, so the test sliced the wrong block and the `contextExhaustionKills` assertion failed.

Fix: reworded the comment in `src/commands/server.ts:645–657` from "beforeSessionKill listener" to "kill hook" — comment intent preserved, the literal anchor string now appears only at the real listener registration. Verified the suspect test passes locally after the reword (12/12 in 278ms). The test-anchor fragility itself is filed as a follow-up (test hygiene change, separate PR) — anchoring on `sessionManager.on('beforeSessionKill'` would be more robust.

This is exactly the memory-noted pattern "Refactors break tests that assert on inlined content" — my `npm run test:push` gate happened to pass locally (564/564) but the same test failed on CI shard 2. Root cause confirmed and shipped the fix in the same PR rather than splitting.

## Post-rebase manifest regeneration (2026-05-12)

Recovery session picked the PR back up after the previous session hit context death. Rebase against main (which had landed v0.28.87 → v0.28.88 plus PRs #150/#155) surfaced a conflict in `src/data/builtin-manifest.json`. Resolved by taking main's manifest as the base and re-running `node scripts/generate-builtin-manifest.cjs` to capture the updated `contentHash` values for `route-group:sessions` and adjacent groups whose content shifted due to my new `/sessions/refresh` route registration in `src/server/routes.ts`. Entry count unchanged (188 in, 188 out — no new entries, just hash refresh).

Also bumped `package.json` from `0.28.88` → `0.28.89` to satisfy the pre-push version-increment gate after the rebase pulled main's release-cut bump in. The npm publish workflow derives the actual next version from npm at release time, so this bump is just a placeholder that keeps the local gate happy — the workflow may pick a different next-version (likely also 0.28.89) when it runs. No code/test changes in this commit.
