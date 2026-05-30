# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — session recovery no longer "restarts" a session that's actually working

**If you message your agent while it's mid-thought, your message no longer gets
buried under a false "Session restarting…" loop.** When the agent's working
memory is compacted, a watchdog re-orients the session and then waits for it to
write new output. A long extended-think on a big conversation writes nothing to
its transcript until the thought lands — so a perfectly-alive, hard-working
session looked "stuck," and the watchdog re-injected another recovery prompt on
top of your real message, again and again. Your message got buried and you saw
"Session respawned / starting up" instead of an answer (the dashboard worked
because it talks to the session directly). Caught firing 3× in ~52s against a
live session on Echo.

Now the watchdog checks whether the session is actively working — the
`esc to interrupt` / `tokens · esc` mid-turn footer, or a live tool process —
before it re-injects. If the session is working, it waits instead of re-poking;
if the turn lands and the session emits on its own, that counts as recovered with
zero injects. An idle or wedged session recovers exactly as before.

## What to Tell Your User

This is automatic, no configuration. If you ever messaged an agent and got
"Session restarting…" with your message vanishing (forcing you to the dashboard),
that's one of the triggers fixed: a busy session now answers when its current
turn finishes instead of trampling your message with recovery prompts.

## Summary of New Capabilities

- `SessionManager.isSessionActivelyWorking(session)` + `paneShowsActiveWork(pane)`
  — canonical "is this session mid-turn?" signal (shared `CLAUDE_WORKING_INDICATORS`).
- `CompactionSentinel` now defers re-injection while a session is actively working
  (new `isActivelyWorking` dep + `maxWorkingDefers` config, default 10; emits
  `compaction:deferred`). `verifyInjection` likewise skips its recovery Enter on a
  working pane (ends the noisy `Injection stuck — Auto-recovering` spam). Escape
  hatch: `maxWorkingDefers: 0` restores the old behavior.

## Evidence

- Unit: `tests/unit/CompactionSentinel.test.ts` (+6 busy-defer cases),
  `tests/unit/claudeActivityIndicators.test.ts` (new),
  `tests/unit/session-active-work.test.ts` (new) — 125 pass across the related set.
- Integration: `tests/integration/compaction-busy-defer-wiring.test.ts` (4) —
  REAL `CompactionSentinel` × REAL `SessionManager.isSessionActivelyWorking`.
- E2E: `tests/e2e/compaction-busy-defer-lifecycle.test.ts` (4) — real-disk
  lifecycle (recovers with zero injects while working) + WIRED-into-server.ts guard.
- Spec: `docs/specs/compaction-busy-session-defer.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/compaction-busy-session-defer.md`.
